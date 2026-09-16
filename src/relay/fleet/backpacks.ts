// Backpacks for the fleet (docs/relay/BACKPACKS.md).
//
// Two routines share one per-account state file:
//
//  - The AUDIT is HTTP only, no game login: char/list (does this character
//    carry a backpack, is it seasonal, is it dead), the daily-login calendar
//    (which backpack days are reached and unclaimed), and the season clock.
//    It is what the operator looks at to decide when to run the chore.
//
//  - The LOGIN PASS brings each account into the Nexus once per UTC day and
//    logs straight back out. The calendar only advances on days the account
//    logged in (owner, 2026-09-07), so the backpack day (day 2 this month)
//    needs logins on that many distinct days before the month resets. Bots
//    the dispatcher wakes for trades count on their own; this covers the rest.
//
//  - The CHORE logs a bot in and drives it, for real, through the steps the
//    proxy proved on the wire: claim the calendar's backpack days from the
//    Daily Quest Room, walk to the Vault Portal, read the Gift Chest from
//    VAULTINFO, and (when the policy says so) use a Backpack straight out of
//    the chest onto the character. `dry` mode does the read-only part of the
//    trip and logs what `live` would do.
//
// Both are sweep-shaped (see sweeps.ts): a small concurrency, one account at
// a time per worker, every step bounded by a timeout so a stuck account ends
// cleanly. Accounts under the chore are held away from the dispatcher.
import fs from "node:fs";
import path from "node:path";
import { findPath, smoothPath } from "../../accountgen/walker/pathfinding";
import type { GameClient } from "../client/gameClient";
import type { AnyPacket, Packet } from "../protocol/packets";
import type { WorldPos } from "../protocol/data";
import {
  BACKPACK_ITEM_TYPE, backpackDays, clientTokenFor, fetchCalendar, getAccessToken, getCharListDetail, getSeasonInfo,
  type Calendar, type CharListDetail, type ClaimType, type SeasonInfo,
} from "../realm/api";
import { parseProxyList, type Proxy } from "../net/proxy";
import type { BotAccount } from "./botPool";
import { bringUp, BringUpRefused, retireSuspended, takeDown } from "./bringUp";
import { deleteChar } from "../realm/api";
import { snapshotInventory, sweepAccount, type SweepDeps } from "./sweeps";

/** Realm object types (object.xml). */
export const VAULT_PORTAL_TYPE = 0x0720;
export const GIFT_CHEST_TYPE = 0x0744;
/** Map names as MAPINFO reports them (proxy log, 2026-09-06). */
export const NEXUS_MAP = "Nexus";
export const VAULT_MAP = "Vault";
export const QUEST_ROOM_MAP = "Daily Quest Room";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dist = (a: WorldPos, b: WorldPos): number => Math.hypot(a.x - b.x, a.y - b.y);

// --- clocks -------------------------------------------------------------------------

/** Start of the next UTC month after `epochSeconds` — when the login calendar rolls over (assumed 00:00 UTC on the 1st; see BACKPACKS.md §0). */
export function monthResetAt(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

export interface Clocks {
  /** Realm's clock at the last calendar fetch, epoch seconds. */
  serverTime: number | null;
  monthResetsAt: number | null;
  season: (SeasonInfo & { fetchedAt: number }) | null;
  /** Whether the season ends before the calendar's next reset: the case where claims for seasonal-bound accounts may be worth deferring (BACKPACKS.md §8). */
  seasonEndsBeforeMonth: boolean | null;
}

export function deriveClocks(serverTime: number | null, season: (SeasonInfo & { fetchedAt: number }) | null): Clocks {
  const monthResetsAt = serverTime === null ? null : monthResetAt(serverTime);
  return {
    serverTime,
    monthResetsAt,
    season,
    seasonEndsBeforeMonth: monthResetsAt !== null && season ? season.end < monthResetsAt : null,
  };
}

// --- per-account state ----------------------------------------------------------------

export interface BackpackDayState {
  track: ClaimType;
  day: number;
  quantity: number;
  claimable: boolean;
}
export interface AccountBackpackState {
  alias: string;
  guid: string;
  botGuid: string;
  charId: number | null;
  seasonal: boolean | null;
  dead: boolean | null;
  hasBackpack: boolean | null;
  maxNumChars: number | null;
  /** Calendar position on the two tracks. */
  nonconCurDay: number | null;
  conCurDay: number | null;
  backpackDays: BackpackDayState[];
  /** Backpacks in the Gift Chest at the last vault visit; null until visited. */
  banked: number | null;
  /** Item count on the character at the last vault visit (trade slots only). */
  held: number | null;
  lastAuditAt: number | null;
  lastVaultAt: number | null;
  /** "YYYY-MM:track:day" of every claim the chore confirmed. */
  claimed: string[];
  /** Epoch seconds of the last login this service made or saw. */
  lastLoginAt: number | null;
  /** "YYYY-MM-DD" (UTC) of the days this service logged the account in this month; reset on month change. */
  loginDays: string[];
  lastError: string | null;
  /** Epoch seconds of the last structural failure (scheduler cooldown of 24 h). */
  lastErrorAt: number | null;
  lastChoreAt: number | null;
  /** Epoch seconds of the last audit attempt (failures back off a day). */
  lastAuditTriedAt: number | null;
  lastRecycleAt: number | null;
  /** Structural chore failures this month ("YYYY-MM"); three put the account on the operator's list. */
  choreAttemptsMonth: string | null;
  choreAttempts: number;
  manual: boolean;
}

function emptyState(acc: BotAccount): AccountBackpackState {
  return {
    alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, charId: null, seasonal: null, dead: null, hasBackpack: null, maxNumChars: null,
    nonconCurDay: null, conCurDay: null, backpackDays: [], banked: null, held: null, lastAuditAt: null, lastVaultAt: null, claimed: [], lastLoginAt: null, loginDays: [], lastError: null,
    lastErrorAt: null, lastChoreAt: null, lastAuditTriedAt: null, lastRecycleAt: null, choreAttemptsMonth: null, choreAttempts: 0, manual: false,
  };
}

/** Calibrations the fleet measures on itself (docs §9). */
export interface Observed {
  /** Evidence that an HTTP-only audit (verify + char/list + calendar) advances the login-day counter. */
  verifyLoginYes: number;
  verifyLoginNo: number;
  /** Settled verdict; null until ten consistent observations. */
  verifyCountsAsLogin: boolean | null;
}
export const emptyObserved = (): Observed => ({ verifyLoginYes: 0, verifyLoginNo: 0, verifyCountsAsLogin: null });
/**
 * One observation for the verify-counts-as-login question: an account
 * audited on an earlier UTC day, not logged in by the fleet since, audited
 * again today — did the counter move? Returns the updated verdict. Pure.
 */
export function observeVerifyLogin(obs: Observed, prev: { nonconCurDay: number | null; lastAuditAt: number | null; lastLoginAt: number | null }, nowNonconCurDay: number, nowMs: number): Observed {
  const out = { ...obs };
  if (prev.nonconCurDay === null || prev.lastAuditAt === null) return out;
  const prevDay = dayKey(prev.lastAuditAt / 1000);
  if (prevDay === dayKey(nowMs / 1000)) return out;
  if (prev.lastLoginAt !== null && prev.lastLoginAt * 1000 >= prev.lastAuditAt) return out;
  // A month boundary in between resets the counter: not evidence.
  if (prevDay.slice(0, 7) !== dayKey(nowMs / 1000).slice(0, 7)) return out;
  if (nowNonconCurDay > prev.nonconCurDay) out.verifyLoginYes++;
  else out.verifyLoginNo++;
  if (out.verifyLoginYes >= 10 && out.verifyLoginNo === 0) out.verifyCountsAsLogin = true;
  else if (out.verifyLoginNo >= 10) out.verifyCountsAsLogin = false;
  return out;
}
/** Transient failures retry in a later batch without penalty; anything else counts against the account. */
export function isTransientError(error: string): boolean {
  return /inactive|network|timed out|kick|bring-up|no free proxy|login-locked|not in view|online or busy|logins paused|no verdict|did not lead/i.test(error);
}
/** Fold a chore trip's outcome into the account's retry accounting. */
export function noteChoreOutcome(st: AccountBackpackState, ok: boolean, error: string | null, nowMs: number): void {
  const month = monthKey(nowMs / 1000);
  if (st.choreAttemptsMonth !== month) {
    st.choreAttemptsMonth = month;
    st.choreAttempts = 0;
    st.manual = false;
  }
  st.lastChoreAt = Math.floor(nowMs / 1000);
  if (ok) {
    st.lastError = null;
    st.lastErrorAt = null;
    return;
  }
  st.lastError = error;
  if (error && !isTransientError(error)) {
    st.lastErrorAt = Math.floor(nowMs / 1000);
    st.choreAttempts++;
    if (st.choreAttempts >= 3) st.manual = true;
  }
}
/** Days of the month still usable (today counts); null without a month clock. */
export function daysToReset(clocks: Clocks, nowMs: number): number | null {
  if (clocks.monthResetsAt === null) return null;
  return Math.max(0, Math.ceil((clocks.monthResetsAt - nowMs / 1000) / 86_400));
}
/**
 * The login lane's targets (docs §5.3): accounts that would be picks if their
 * backpack day were reached, and can still reach it before the reset.
 * Tightest slack first, then biggest holders. Pure.
 */
export function loginTargets(
  rows: { st: AccountBackpackState; held: number; poolDeficit: number; vaultBot: boolean }[],
  clocks: Clocks,
  nowMs: number,
  batch: number,
): AccountBackpackState[] {
  const today = dayKey(nowMs / 1000);
  const left = daysToReset(clocks, nowMs);
  const out: { st: AccountBackpackState; slack: number; held: number }[] = [];
  for (const r of rows) {
    const st = r.st;
    if (st.hasBackpack !== false || st.dead || st.manual) continue;
    if (!(r.vaultBot || r.poolDeficit > 0)) continue;
    if (st.loginDays.includes(today)) continue;
    if (st.nonconCurDay === null) continue;
    const cur = st.nonconCurDay;
    const day = st.backpackDays.find((d) => d.track === "nonconsecutive" && !d.claimable && d.quantity > 0 && d.day > cur);
    if (!day) continue;
    const needed = day.day - cur;
    if (left !== null && needed > left) continue;
    out.push({ st, slack: left === null ? needed : left - needed, held: r.held });
  }
  out.sort((a, b) => a.slack - b.slack || b.held - a.held);
  return out.slice(0, batch).map((x) => x.st);
}
/** Whether the scheduler may pick this account for a trip right now. */
export function eligibleForTrip(st: AccountBackpackState, nowMs: number, allowDead = false): boolean {
  if (st.manual) return false;
  if (st.dead && !allowDead) return false;
  if (st.lastErrorAt !== null && nowMs / 1000 - st.lastErrorAt < 86_400) return false;
  return true;
}
export const dayKey = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
/** Record a login on the account's calendar-day list (UTC days; a new month starts the list over). */
export function noteLogin(st: AccountBackpackState, nowMs: number): void {
  const day = dayKey(nowMs / 1000);
  st.lastLoginAt = Math.floor(nowMs / 1000);
  if (st.loginDays.length && !st.loginDays[0].startsWith(day.slice(0, 7))) st.loginDays = [];
  if (!st.loginDays.includes(day)) st.loginDays.push(day);
}
/** Whether this account still needs a login today (UTC) to advance the calendar. */
export function needsLoginToday(st: AccountBackpackState, nowMs: number): boolean {
  return !st.loginDays.includes(dayKey(nowMs / 1000));
}

/** Fold a char/list body into the state. The single character (MaxNumChars is 1 on these accounts) is the bot's. */
export function applyCharList(st: AccountBackpackState, cl: CharListDetail, now: number): void {
  const c = cl.chars[0] ?? null;
  st.charId = c?.id ?? null;
  st.seasonal = c ? c.seasonal : null;
  st.dead = c ? c.dead : null;
  st.hasBackpack = c ? c.hasBackpack : null;
  st.maxNumChars = cl.maxNumChars;
  st.lastAuditAt = now;
}
export function applyCalendar(st: AccountBackpackState, cal: Calendar, now: number): void {
  st.nonconCurDay = cal.nonconsecutiveDay;
  st.conCurDay = cal.consecutiveDay;
  st.backpackDays = backpackDays(cal).map((d) => ({ track: d.track, day: d.day.day, quantity: d.day.quantity, claimable: d.claimable }));
  st.lastAuditAt = now;
}
export const monthKey = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 7);

// --- policy ---------------------------------------------------------------------------

export interface ChorePolicy {
  /** Use a banked Backpack on the character when it has none. */
  equip: boolean;
}
export interface Decision {
  /** Reached, unclaimed backpack days to claim now. */
  claim: BackpackDayState[];
  /** Whether to apply a backpack from the chest (needs the vault visit's count). */
  equip: boolean;
  reasons: string[];
}
/** What the chore should do for one account. Pure. `banked` is the Gift Chest count if known. */
export function decide(st: AccountBackpackState, policy: ChorePolicy, banked: number | null = st.banked): Decision {
  const reasons: string[] = [];
  const claim = st.backpackDays.filter((d) => d.claimable);
  if (claim.length) reasons.push(`claim ${claim.map((d) => `${d.track} day ${d.day} (${d.quantity}x)`).join(", ")}`);
  let equip = false;
  if (!policy.equip) reasons.push("equip off: bank only");
  else if (st.hasBackpack) reasons.push("character already has a backpack");
  else if (banked === null) reasons.push("equip once the chest count is known");
  else if (banked + claim.reduce((n, d) => n + d.quantity, 0) <= 0) reasons.push("nothing banked to equip");
  else {
    equip = true;
    reasons.push("equip a banked backpack");
  }
  return { claim, equip, reasons };
}

/**
 * The owner's disposability rule (BACKPACKS.md §5): an empty character with
 * no backpack is disposable; a non-seasonal one is disposable while a
 * Backpack sits in the Gift Chest. Never decides anything by itself.
 */
export function isDisposable(st: AccountBackpackState, heldItems: number): boolean {
  if (heldItems > 0) return false;
  if (st.hasBackpack === false) return true;
  return st.seasonal === false && (st.banked ?? 0) > 0;
}

// --- demand-driven claim planning -------------------------------------------------------
//
// Backpacks are claimed as needed, per pool (owner, 2026-09-07): a claim is
// made on the account's current character and lands in that seasonality's
// Gift Chest, so claiming ahead of need pins the backpack to a side. The
// plan asks for just enough backpack bots per pool that the pool's whole
// stock fits on them, plus a buffer, and picks the accounts that hold the
// most (consolidation gathers stock onto the biggest holders anyway).

export interface PlanRow {
  botGuid: string;
  alias: string;
  seasonal: boolean;
  /** Items the bot holds (trade slots). */
  held: number;
  /** 16 once a backpack is on the character, else 8. */
  capacity: number;
  /** A backpack day is reached and unclaimed this month. */
  claimable: boolean;
  /** Spares in this side's Gift Chest (equip needs no claim). */
  banked: number;
  /** Somebody's personal-storage bot: the vault lane, not the pool's stock. */
  vaultBot: boolean;
  /** Not manual, not dead, not cooling down, not online for trading. */
  eligible: boolean;
}
export interface PoolPlan {
  pool: "seasonal" | "nonseasonal" | "vaults";
  bots: number;
  stock: number;
  /** Items of headroom planned for, and how they were derived. */
  bufferItems: number;
  bufferMode: "growth" | "fraction";
  gainPerDay: number | null;
  horizonDays: number;
  backpackBots: number;
  /** Bots the stock needs at 16 slots each, with the buffer. */
  needBots: number;
  deficit: number;
  /** Accounts without a backpack whose day is claimable, biggest holders first. */
  candidates: number;
  picks: { botGuid: string; alias: string; held: number }[];
}
export const BACKPACK_SLOTS = 16;

export interface PlanOptions {
  /** Fallback headroom as a fraction of the stock (0.2 = 20%) when no growth measurement exists. */
  buffer?: number;
  /** Measured net items gained per day per pool (rolling average); null/undefined = unknown. */
  gainPerDay?: { seasonal: number | null; nonseasonal: number | null };
  /** Days of growth to plan for (until the next chance to claim, i.e. the month reset). */
  horizonDays?: number;
}
/**
 * How many accounts to claim (and equip) on, per pool. Pure. Headroom is the
 * pool's measured growth over the horizon when known (owner: "a rolling
 * average of how many items we gain per day"), else `buffer` x stock.
 */
export function planClaims(rows: PlanRow[], opts: PlanOptions = {}): { seasonal: PoolPlan; nonseasonal: PoolPlan; vaults: PoolPlan } {
  const buffer = Math.max(0, opts.buffer ?? 0.2);
  const horizonDays = Math.max(1, opts.horizonDays ?? 7);
  const one = (pool: "seasonal" | "nonseasonal"): PoolPlan => {
    const mine = rows.filter((r) => !r.vaultBot && r.seasonal === (pool === "seasonal"));
    const stock = mine.reduce((n, r) => n + r.held, 0);
    const backpackBots = mine.filter((r) => r.capacity >= BACKPACK_SLOTS).length;
    const gain = opts.gainPerDay?.[pool] ?? null;
    const bufferMode: PoolPlan["bufferMode"] = gain === null ? "fraction" : "growth";
    const bufferItems = Math.ceil(gain === null ? stock * buffer : Math.max(0, gain) * horizonDays);
    const needBots = stock + bufferItems > 0 ? Math.ceil((stock + bufferItems) / BACKPACK_SLOTS) : 0;
    const deficit = Math.max(0, needBots - backpackBots);
    // Spares already banked come first (no claim spent), then the biggest holders.
    const candidates = mine.filter((r) => r.capacity < BACKPACK_SLOTS && r.eligible && (r.claimable || r.banked > 0)).sort((a, b) => Number(b.banked > 0) - Number(a.banked > 0) || b.held - a.held || (a.alias < b.alias ? -1 : 1));
    return {
      pool, bots: mine.length, stock, bufferItems, bufferMode, gainPerDay: gain, horizonDays, backpackBots, needBots, deficit, candidates: candidates.length,
      picks: candidates.slice(0, deficit).map((r) => ({ botGuid: r.botGuid, alias: r.alias, held: r.held })),
    };
  };
  // Vault lane (docs §3): a vault bot's slots are a user's storage size; every one without a backpack is a pick.
  const vaults = rows.filter((r) => r.vaultBot);
  const vaultCands = vaults.filter((r) => r.capacity < BACKPACK_SLOTS && r.eligible && (r.claimable || r.banked > 0)).sort((a, b) => b.held - a.held || (a.alias < b.alias ? -1 : 1));
  const vaultPlan: PoolPlan = {
    pool: "vaults", bots: vaults.length, stock: vaults.reduce((n, r) => n + r.held, 0), bufferItems: 0, bufferMode: "fraction", gainPerDay: null, horizonDays: 0,
    backpackBots: vaults.filter((r) => r.capacity >= BACKPACK_SLOTS).length, needBots: vaults.length, deficit: vaultCands.length, candidates: vaultCands.length,
    picks: vaultCands.map((r) => ({ botGuid: r.botGuid, alias: r.alias, held: r.held })),
  };
  return { seasonal: one("seasonal"), nonseasonal: one("nonseasonal"), vaults: vaultPlan };
}

/**
 * The account to fit with a backpack for a waiting 16-slot deposit in
 * `seasonal`'s pool: empty (so it becomes a 16-free bot the moment the
 * backpack is on), not somebody's vault, free for a trip, and with a spare
 * banked in the Gift Chest (equip only — the quickest) or a claimable day
 * (claim, then equip). Pure; null when nothing qualifies.
 */
export function orderCandidate(rows: PlanRow[], seasonal: boolean): PlanRow | null {
  let best: PlanRow | null = null;
  for (const r of rows) {
    if (r.vaultBot || r.seasonal !== seasonal || !r.eligible || r.capacity >= BACKPACK_SLOTS || r.held > 0) continue;
    if (!(r.banked > 0 || r.claimable)) continue;
    if (!best || (r.banked > 0 && best.banked <= 0) || (r.banked > 0 === best.banked > 0 && r.alias < best.alias)) best = r;
  }
  return best;
}

// --- store -----------------------------------------------------------------------------

export interface StockSample {
  /** "YYYY-MM-DD" (UTC). */
  day: string;
  seasonal: number;
  nonseasonal: number;
}
/** Days of samples kept for the rolling average. */
export const STOCK_SAMPLE_DAYS = 30;
export const GAIN_WINDOW_DAYS = 7;

/** Net items gained per day over the last `windowDays` of samples (first to last sample in the window); null with fewer than two days. Pure. */
export function gainPerDay(samples: StockSample[], pool: "seasonal" | "nonseasonal", today: string, windowDays = GAIN_WINDOW_DAYS): number | null {
  const dayNum = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  const cutoff = dayNum(today) - windowDays;
  const win = samples.filter((s) => dayNum(s.day) >= cutoff).sort((a, b) => (a.day < b.day ? -1 : 1));
  if (win.length < 2) return null;
  const first = win[0];
  const last = win[win.length - 1];
  const days = dayNum(last.day) - dayNum(first.day);
  if (days <= 0) return null;
  return (last[pool] - first[pool]) / days;
}

export class BackpackStore {
  private readonly accounts = new Map<string, AccountBackpackState>();
  private season: (SeasonInfo & { fetchedAt: number }) | null = null;
  private serverTime: number | null = null;
  private samples: StockSample[] = [];
  /** Season id every account was already marked non-seasonal for (the automatic rollover ran). */
  private rolledSeasonId: string | null = null;
  observed: Observed = emptyObserved();

  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: Record<string, AccountBackpackState>; season?: Clocks["season"]; serverTime?: number | null; samples?: StockSample[]; rolledSeasonId?: string | null; observed?: Observed };
        for (const [g, st] of Object.entries(raw.accounts ?? {})) this.accounts.set(g, st);
        this.season = raw.season ?? null;
        this.serverTime = raw.serverTime ?? null;
        this.samples = Array.isArray(raw.samples) ? raw.samples : [];
        this.rolledSeasonId = typeof raw.rolledSeasonId === "string" ? raw.rolledSeasonId : null;
        if (raw.observed && typeof raw.observed === "object") this.observed = { ...emptyObserved(), ...(raw.observed as Partial<Observed>) };
      }
    } catch (e) {
      console.log(`backpacks: failed to load ${file}: ${String(e)}`);
    }
  }
  static at(dataDir: string): BackpackStore {
    return new BackpackStore(path.join(dataDir, "backpack_state.json"));
  }
  for(acc: BotAccount): AccountBackpackState {
    let st = this.accounts.get(acc.botGuid);
    if (!st) this.accounts.set(acc.botGuid, (st = emptyState(acc)));
    st.alias = acc.alias;
    return st;
  }
  all(): AccountBackpackState[] {
    return [...this.accounts.values()];
  }
  clocks(): Clocks {
    return deriveClocks(this.serverTime, this.season);
  }
  noteServerTime(t: number): void {
    this.serverTime = t;
  }
  noteSeason(s: SeasonInfo, now: number): void {
    this.season = { ...s, fetchedAt: now };
  }
  currentSeason(): (SeasonInfo & { fetchedAt: number }) | null {
    return this.season;
  }
  rolledFor(): string | null {
    return this.rolledSeasonId;
  }
  noteRolled(seasonId: string): void {
    this.rolledSeasonId = seasonId;
  }
  seasonFresh(now: number, maxAgeMs = 3_600_000): boolean {
    return !!this.season && now - this.season.fetchedAt < maxAgeMs;
  }
  /** Record today's stock per pool (one sample per UTC day, the latest wins); keeps STOCK_SAMPLE_DAYS days. */
  noteStock(day: string, seasonal: number, nonseasonal: number): void {
    this.samples = this.samples.filter((s) => s.day !== day);
    this.samples.push({ day, seasonal, nonseasonal });
    this.samples.sort((a, b) => (a.day < b.day ? -1 : 1));
    if (this.samples.length > STOCK_SAMPLE_DAYS) this.samples = this.samples.slice(-STOCK_SAMPLE_DAYS);
  }
  stockSamples(): StockSample[] {
    return [...this.samples];
  }
  gainPerDay(pool: "seasonal" | "nonseasonal", today: string): number | null {
    return gainPerDay(this.samples, pool, today);
  }
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Save soon (10 s), coalescing the per-account writes of a run; `save()` flushes now. */
  requestSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 10_000);
    this.saveTimer.unref?.();
  }
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ accounts: Object.fromEntries(this.accounts), season: this.season, serverTime: this.serverTime, samples: this.samples, rolledSeasonId: this.rolledSeasonId, observed: this.observed }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.log(`backpacks: failed to write ${this.file}: ${String(e)}`);
    }
  }
  summary(nowMs = Date.now()): { accounts: number; audited: number; withBackpack: number; seasonal: number; dead: number; claimableDays: number; claimableBackpacks: number; banked: number; vaultVisited: number; loggedToday: number } {
    const out = { accounts: 0, audited: 0, withBackpack: 0, seasonal: 0, dead: 0, claimableDays: 0, claimableBackpacks: 0, banked: 0, vaultVisited: 0, loggedToday: 0 };
    for (const st of this.accounts.values()) {
      out.accounts++;
      if (!needsLoginToday(st, nowMs)) out.loggedToday++;
      if (st.lastAuditAt !== null) out.audited++;
      if (st.hasBackpack) out.withBackpack++;
      if (st.seasonal) out.seasonal++;
      if (st.dead) out.dead++;
      for (const d of st.backpackDays) {
        if (!d.claimable) continue;
        out.claimableDays++;
        out.claimableBackpacks += d.quantity;
      }
      if (st.banked !== null) {
        out.vaultVisited++;
        out.banked += st.banked;
      }
    }
    return out;
  }
}

// --- audit (HTTP only) --------------------------------------------------------------

export interface RunState {
  running: boolean;
  mode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  current: string[];
  stoppedReason: string | null;
  lastErrors: { alias: string; error: string }[];
  /** Accounts Realm reported suspended during this run (retired from the pool). */
  suspended: number;
  /** Chore runs: backpacks claimed and characters equipped. */
  claimed: number;
  equipped: number;
}
const freshRun = (): RunState => ({ running: false, mode: null, startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, skipped: 0, current: [], stoppedReason: null, lastErrors: [], suspended: 0, claimed: 0, equipped: 0 });

const AUDIT_CONCURRENCY = Number(process.env.BACKPACK_AUDIT_CONCURRENCY ?? 4);
const AUDIT_STAGGER_MS = Number(process.env.BACKPACK_AUDIT_STAGGER_MS ?? 1500);

export interface BackpackServiceOptions {
  sd: SweepDeps;
  store: BackpackStore;
  /** Guids the dispatcher must leave alone while the chore drives them. */
  holds: Set<string>;
  now?: () => number;
  /**
   * Exit for the audit's HTTP calls, in place of the login pool. The login
   * pool keys exclusivity by host (one exit IP per bot), which a rotating
   * gateway like Webshare's backbone (one host, thousands of usernames)
   * collapses to a single slot; the audit only needs many distinct exits,
   * not exclusive ones.
   */
  auditProxy?: () => Proxy | null;
  /** Bots that are somebody's personal storage (from the dispatcher). */
  vaultBots?: () => Set<string>;
}

/** Round-robin over a Webshare-style list (`host:port:user:pass` per line); null when the file is missing or empty. */
export function auditProxiesFromFile(file: string | undefined, log: (l: string) => void): (() => Proxy | null) | undefined {
  if (!file) return undefined;
  let list: Proxy[] = [];
  try {
    list = parseProxyList(fs.readFileSync(file, "utf8"));
  } catch (e) {
    log(`backpacks: audit proxies file ${file} unreadable (${String(e)}) — the audit will use the login pool`);
    return undefined;
  }
  if (!list.length) return undefined;
  log(`backpacks: ${list.length} audit proxies from ${file}`);
  let i = 0;
  return () => list[i++ % list.length];
}

export class BackpackService {
  readonly audit: RunState = freshRun();
  readonly chore: RunState = freshRun();
  /** Write the state file now (shutdown). */
  flush(): void {
    this.o.store.save();
  }
  /** What this service is doing with an account right now, by account guid — the label the Inventories tab shows. */
  private readonly activity = new Map<string, string>();
  private auditCancel = false;
  private choreCancel = false;
  private readonly now: () => number;

  constructor(private readonly o: BackpackServiceOptions) {
    this.now = o.now ?? Date.now;
  }
  private log(line: string): void {
    this.o.sd.deps.log(line);
  }
  status(): { clocks: Clocks; summary: ReturnType<BackpackStore["summary"]>; audit: RunState; chore: RunState; observed: Observed } {
    const snap = (r: RunState): RunState => ({ ...r, current: [...r.current], lastErrors: [...r.lastErrors] });
    return { clocks: this.o.store.clocks(), summary: this.o.store.summary(this.now()), audit: snap(this.audit), chore: snap(this.chore), observed: { ...this.o.store.observed } };
  }
  /** Settled calibration: an HTTP audit advances the login-day counter (docs §5.3, §9.1). */
  verifyCountsAsLogin(): boolean {
    return this.o.store.observed.verifyCountsAsLogin === true;
  }
  /** Give the tracker every capacity the audit knows (char/list BackpackSlots), e.g. after an audit state file was copied in. */
  seedCapacities(): number {
    const caps: Record<string, number> = {};
    for (const acc of this.o.sd.pool.every()) {
      const st = this.o.store.for(acc);
      if (st.hasBackpack !== null) caps[acc.botGuid] = st.hasBackpack ? 16 : 8;
    }
    // One bulk write: per-bot notifications over the whole roster OOM'd prod (2026-09-07).
    const n = this.o.sd.tracker.noteCapacities(caps);
    if (n) this.log(`backpacks: seeded ${n} bot capacit${n === 1 ? "y" : "ies"} from the audit state`);
    return n;
  }
  /** The demand-driven claim plan from the audit's rows, the tracker's holdings and each bot's capacity. */
  clocks(): Clocks {
    return this.o.store.clocks();
  }
  /** One plan row per usable account, with the account and its state attached for the lanes. */
  private planRows(nowMs: number): { row: PlanRow; acc: BotAccount; st: AccountBackpackState; busy: boolean }[] {
    const { store, sd } = this.o;
    const vaultBots = this.o.vaultBots?.() ?? new Set<string>();
    const out: { row: PlanRow; acc: BotAccount; st: AccountBackpackState; busy: boolean }[] = [];
    for (const acc of sd.pool.every()) {
      if (acc.suspended) continue;
      const st = store.for(acc);
      const cap = st.hasBackpack === true ? BACKPACK_SLOTS : sd.tracker.capacityFor(acc.botGuid);
      const busy = !!(acc.client && acc.client.active) || acc.assignedRequestId !== null || acc.inUse;
      out.push({
        acc, st, busy,
        row: {
          botGuid: acc.botGuid, alias: acc.alias, seasonal: st.seasonal ?? acc.seasonalOrDefault,
          held: sd.tracker.heldCount(acc.botGuid), capacity: cap, claimable: st.backpackDays.some((d) => d.claimable),
          banked: st.banked ?? 0, vaultBot: vaultBots.has(acc.botGuid), eligible: !busy && eligibleForTrip(st, nowMs),
        },
      });
    }
    return out;
  }
  // --- orders: a waiting 16-slot deposit with no bot to send ----------------------
  // The dispatcher places one per pool half and renews it every pass while
  // the deposit waits; an order nobody renews lapses. The scheduler serves
  // open orders ahead of every other lane, one trip each.
  private readonly orders = new Map<"seasonal" | "nonseasonal", { since: number; renewedAt: number; trips: number }>();
  /** Place or renew the order for `seasonal`'s pool. True when it is new. */
  orderBackpackBot(seasonal: boolean, nowMs = this.now()): boolean {
    const key = seasonal ? "seasonal" : "nonseasonal";
    const cur = this.orders.get(key);
    if (cur) {
      cur.renewedAt = nowMs;
      return false;
    }
    this.orders.set(key, { since: nowMs, renewedAt: nowMs, trips: 0 });
    return true;
  }
  /** Pool halves with an order still being renewed. */
  openOrders(nowMs = this.now()): ("seasonal" | "nonseasonal")[] {
    for (const [k, o] of [...this.orders]) if (nowMs - o.renewedAt > ORDER_TTL_MS || o.trips >= ORDER_MAX_TRIPS) this.orders.delete(k);
    return [...this.orders.keys()];
  }
  /** Whether an empty account could be fitted with a backpack for `seasonal`'s pool right now. */
  canMakeBackpackBot(seasonal: boolean, nowMs = this.now()): boolean {
    return orderCandidate(this.planRows(nowMs).map((r) => r.row), seasonal) !== null;
  }
  /** One account per open order, to trip now with equip on. Counts the trip against the order. */
  orderPicks(nowMs: number, batch: number): string[] {
    const rows = this.planRows(nowMs).map((r) => r.row);
    const byBot = new Map(this.o.sd.pool.every().map((a) => [a.botGuid, a.guid]));
    const out: string[] = [];
    for (const half of this.openOrders(nowMs)) {
      const pick = orderCandidate(rows, half === "seasonal");
      const guid = pick ? byBot.get(pick.botGuid) : undefined;
      if (!guid) continue;
      this.orders.get(half)!.trips++;
      out.push(guid);
      if (out.length >= batch) break;
    }
    return out;
  }

  /** Guids the chore lane should trip now: vault picks first, then the pools' picks, up to `batch`. */
  chorePicks(settings: { buffer: number }, nowMs: number, batch: number): string[] {
    const p = this.planFrom(this.planRows(nowMs), settings.buffer, nowMs);
    const byBot = new Map(this.o.sd.pool.every().map((a) => [a.botGuid, a.guid]));
    return [...p.vaults.picks, ...p.nonseasonal.picks, ...p.seasonal.picks].map((x) => byBot.get(x.botGuid)).filter((g): g is string => !!g).slice(0, batch);
  }
  /** Guids for the targeted login lane (docs §5.3). */
  auditPicks(settings: { auditStaleDays: number }, nowMs: number, batch: number): string[] {
    const cutoff = nowMs / 1000 - settings.auditStaleDays * 86_400;
    const out: string[] = [];
    for (const acc of this.o.sd.pool.every()) {
      if (acc.suspended) continue;
      const st = this.o.store.for(acc);
      const stale = st.lastAuditAt === null || (st.lastAuditAt / 1000 < cutoff && (st.lastLoginAt ?? 0) < cutoff);
      const triedRecently = st.lastAuditTriedAt !== null && nowMs / 1000 - st.lastAuditTriedAt < 86_400 && (st.lastAuditAt === null || st.lastAuditAt / 1000 < st.lastAuditTriedAt);
      if (stale && !triedRecently) out.push(acc.guid);
      if (out.length >= batch) break;
    }
    return out;
  }
  /** Accounts with a claimable backpack day that nothing else picked (a manual fallback). */
  backstopPicks(batch: number): string[] {
    const out: string[] = [];
    for (const acc of this.o.sd.pool.every()) {
      if (acc.suspended) continue;
      const st = this.o.store.for(acc);
      if (st.manual || !st.backpackDays.some((d) => d.claimable)) continue;
      if (acc.client?.active || acc.assignedRequestId !== null) continue;
      out.push(acc.guid);
      if (out.length >= batch) break;
    }
    return out;
  }
  private planFrom(rowsWithState: { row: PlanRow }[], buffer: number, nowMs: number): ReturnType<typeof planClaims> {
    const { store } = this.o;
    const rows = rowsWithState.map((r) => r.row);
    const today = dayKey(nowMs / 1000);
    const stock = { seasonal: 0, nonseasonal: 0 };
    for (const r of rows) if (!r.vaultBot) stock[r.seasonal ? "seasonal" : "nonseasonal"] += r.held;
    store.noteStock(today, stock.seasonal, stock.nonseasonal);
    const clocks = store.clocks();
    // Growth until new claims become possible again: the reset, then the next backpack day (assume 2).
    const horizonDays = clocks.monthResetsAt ? Math.min(35, Math.max(1, Math.ceil((clocks.monthResetsAt - nowMs / 1000) / 86_400) + 2)) : GAIN_WINDOW_DAYS;
    const gains = { seasonal: store.gainPerDay("seasonal", today), nonseasonal: store.gainPerDay("nonseasonal", today) };
    return planClaims(rows, { buffer, gainPerDay: gains, horizonDays });
  }
  plan(buffer?: number): ReturnType<typeof planClaims> & { buffer: number; rows: number; samples: StockSample[] } {
    const { store } = this.o;
    const b = buffer ?? 0.2;
    const nowMs = this.now();
    const rows = this.planRows(nowMs);
    return { ...this.planFrom(rows, b, nowMs), buffer: b, rows: rows.length, samples: store.stockSamples() };
  }
  /** A bot the dispatcher (or anything else) brought into the world today: counts as that day's login. */
  noteLogin(acc: BotAccount): void {
    noteLogin(this.o.store.for(acc), this.now());
  }
  private readonly calendarInFlight = new Set<string>();
  /**
   * Every successful bring-up (docs §5.5): char/list was just read, so the
   * row learns backpack/seasonal for free, the day counts as a login, and
   * once a day the 3 KB calendar is fetched with the session's own token.
   */
  onLogin(acc: BotAccount, client: GameClient): void {
    const { store, sd } = this.o;
    const st = store.for(acc);
    const nowMs = this.now();
    if (client.charHasBackpack !== null) st.hasBackpack = client.charHasBackpack;
    if (client.charSeasonal !== null) st.seasonal = client.charSeasonal;
    st.charId = client.charId >= 0 ? client.charId : st.charId;
    noteLogin(st, nowMs);
    if (st.hasBackpack !== null) sd.tracker.noteCapacity(acc.botGuid, st.hasBackpack ? 16 : 8);
    const fresh = st.lastAuditAt !== null && nowMs - st.lastAuditAt < 20 * 3_600_000;
    if (!fresh && client.token && !this.calendarInFlight.has(acc.guid)) {
      this.calendarInFlight.add(acc.guid);
      void fetchCalendar(client.token, client.proxy)
        .then((cal) => {
          if (!cal.ok) return;
          applyCalendar(st, cal.value, this.now());
          store.noteServerTime(cal.value.serverTime);
        })
        .catch(() => {})
        .finally(() => {
          this.calendarInFlight.delete(acc.guid);
          store.requestSave();
        });
    } else store.requestSave();
  }
  accounts(): AccountBackpackState[] {
    return this.o.store.all();
  }
  activityOf(guid: string): string | null {
    return this.activity.get(guid) ?? null;
  }
  private setActivity(guid: string, label: string | null): void {
    if (label === null) this.activity.delete(guid);
    else this.activity.set(guid, label);
  }

  // Runs ---------------------------------------------------------------------------

  startAudit(opts: { limit?: number; guids?: string[]; unauditedOnly?: boolean } = {}): RunState {
    if (this.audit.running) throw new Error("a backpack audit is already running");
    this.auditCancel = false;
    Object.assign(this.audit, freshRun(), { running: true, mode: "audit", startedAt: this.now() / 1000 });
    void this.runAudit(opts);
    return { ...this.audit };
  }
  cancelAudit(): boolean {
    if (!this.audit.running) return false;
    this.auditCancel = true;
    return true;
  }
  startChore(opts: { mode: "dry" | "live"; limit?: number; guids?: string[]; equip?: boolean; plan?: boolean; buffer?: number }): RunState {
    if (this.chore.running) throw new Error("a backpack chore is already running");
    if (opts.plan) {
      // Claim as needed: only the accounts the plan picks, and equip them.
      const p = this.plan(opts.buffer);
      const picked = [...p.seasonal.picks, ...p.nonseasonal.picks].map((x) => x.botGuid);
      opts = { ...opts, equip: true, guids: picked };
      this.log(`backpacks: plan (headroom ${p.nonseasonal.bufferMode === "growth" ? `${p.nonseasonal.gainPerDay?.toFixed(1)}/day x ${p.nonseasonal.horizonDays}d` : `${p.buffer * 100}% of stock`}) — seasonal stock ${p.seasonal.stock} on ${p.seasonal.bots} bots, ${p.seasonal.backpackBots} with backpacks, need ${p.seasonal.needBots}, claiming on ${p.seasonal.picks.length}; non-seasonal stock ${p.nonseasonal.stock} on ${p.nonseasonal.bots} bots, ${p.nonseasonal.backpackBots} with backpacks, need ${p.nonseasonal.needBots}, claiming on ${p.nonseasonal.picks.length}`);
      if (!picked.length) throw new Error("the plan picks no account: every pool's stock already fits on its backpack bots");
    }
    this.choreCancel = false;
    Object.assign(this.chore, freshRun(), { running: true, mode: opts.mode, startedAt: this.now() / 1000 });
    void this.runChore(opts);
    return { ...this.chore };
  }
  cancelChore(): boolean {
    if (!this.chore.running) return false;
    this.choreCancel = true;
    return true;
  }
  /** Log every account that has not been in the world today into the Nexus once (and straight out), so the calendar counts the day. */
  private pick(opts: { limit?: number; guids?: string[] }): BotAccount[] {
    let accounts = this.o.sd.pool.every().filter((a) => !a.suspended);
    if (opts.guids?.length) {
      const want = new Set(opts.guids);
      accounts = accounts.filter((a) => want.has(a.guid) || want.has(a.botGuid) || want.has(a.alias));
    }
    if (opts.limit && opts.limit > 0) accounts = accounts.slice(0, opts.limit);
    return accounts;
  }

  /** A worker pool over `accounts`, bounded by `concurrency`, staggered, cancellable. */
  private async each(run: RunState, cancelled: () => boolean, accounts: BotAccount[], concurrency: number, stagger: number, one: (acc: BotAccount) => Promise<"ok" | "failed" | "skipped">): Promise<void> {
    run.total = accounts.length;
    let active = 0;
    const waiters: (() => void)[] = [];
    const tasks: Promise<void>[] = [];
    for (const acc of accounts) {
      if (cancelled()) {
        run.stoppedReason = "cancelled by operator";
        break;
      }
      while (active >= Math.max(1, concurrency)) await new Promise<void>((r) => waiters.push(r));
      active++;
      run.current.push(acc.alias);
      tasks.push(
        one(acc)
          .then((v) => {
            run[v]++;
          })
          .catch((e) => {
            run.failed++;
            this.noteError(run, acc, String(e));
          })
          .finally(() => {
            run.done++;
            active--;
            run.current = run.current.filter((x) => x !== acc.alias);
            waiters.shift()?.();
          }),
      );
      await sleep(stagger);
    }
    await Promise.all(tasks);
  }
  private noteError(run: RunState, acc: BotAccount, error: string): void {
    run.lastErrors.push({ alias: acc.alias, error });
    if (run.lastErrors.length > 20) run.lastErrors.shift();
    this.o.store.for(acc).lastError = error;
  }

  // Audit ---------------------------------------------------------------------------

  private async runAudit(opts: { limit?: number; guids?: string[]; unauditedOnly?: boolean }): Promise<void> {
    const { store } = this.o;
    try {
      let accounts = this.pick({ guids: opts.guids });
      if (opts.unauditedOnly) accounts = accounts.filter((a) => store.for(a).lastAuditAt === null);
      if (opts.limit && opts.limit > 0) accounts = accounts.slice(0, opts.limit);
      this.log(`backpacks: auditing ${accounts.length} account(s) over HTTP, <= ${AUDIT_CONCURRENCY} at once`);
      await this.each(this.audit, () => this.auditCancel, accounts, AUDIT_CONCURRENCY, AUDIT_STAGGER_MS, (acc) => this.auditOne(acc));
    } finally {
      try {
        this.plan();
      } catch { /* sampling only */ }
      store.save();
      this.audit.running = false;
      this.audit.finishedAt = this.now() / 1000;
      this.audit.current = [];
      const s = store.summary();
      this.log(`backpacks: audit done — ${this.audit.ok} ok, ${this.audit.failed} failed, ${this.audit.skipped} skipped (${this.audit.suspended} suspended, retired); ${s.withBackpack} character(s) with a backpack, ${s.claimableBackpacks} backpack(s) claimable on ${s.claimableDays} day(s)${this.audit.stoppedReason ? ` (${this.audit.stoppedReason})` : ""}`);
    }
  }

  /** A token for read-only calls: the live session's when the bot is online, else a fresh login through a pool proxy. */
  private async tokenFor(acc: BotAccount): Promise<{ token: string; proxy: Proxy | null; release: () => void } | { skip: string }> {
    const { deps } = this.o.sd;
    const c = acc.client;
    if (c && c.active && c.isReady && c.token) return { token: c.token, proxy: c.proxy, release: () => {} };
    if (deps.gate.pausedRemainingMs() > 0) return { skip: "logins paused" };
    if (deps.gate.lockoutRemainingMs(acc.guid) > 0) return { skip: "login-locked" };
    if (!acc.info.guid || (!acc.info.password && !acc.info.secret)) return { skip: "no credentials" };
    let proxy: Proxy | null = null;
    let release = () => {};
    if (this.o.auditProxy) proxy = this.o.auditProxy();
    else if (deps.proxies.configured) {
      const key = `audit:${acc.guid}`;
      proxy = deps.proxies.claim(key);
      if (!proxy) return { skip: "no free proxy" };
      release = () => deps.proxies.release(key);
    }
    const auth = await getAccessToken({ guid: acc.info.guid, password: acc.info.password, secret: acc.info.secret }, clientTokenFor(acc.info.guid, acc.info.password ?? acc.info.secret ?? ""), proxy);
    if (!auth.ok) {
      release();
      const e = auth.error;
      if (e.kind === "attempt-limit") deps.gate.noteAttemptLimit(acc.guid, e.lockoutSeconds);
      else if (e.kind === "account-in-use") deps.gate.noteCooldown(acc.guid, e.seconds, "account in use (audit)");
      else if (e.kind === "suspended") deps.pool.markSuspended(acc.guid);
      throw new Error(`auth ${e.kind}${"detail" in e ? `: ${e.detail}` : "body" in e ? ` :: ${String(e.body).slice(0, 160).replace(/\s+/g, " ")}` : ""} via ${proxy?.host ?? "direct"}`);
    }
    deps.gate.noteLoginSuccess();
    return { token: auth.value, proxy, release };
  }

  private async auditOne(acc: BotAccount): Promise<"ok" | "failed" | "skipped"> {
    const { store } = this.o;
    const st = store.for(acc);
    st.lastAuditTriedAt = Math.floor(this.now() / 1000);
    const t = await this.tokenFor(acc);
    if ("skip" in t) {
      st.lastError = t.skip;
      return "skipped";
    }
    try {
      const now = this.now();
      const cl = await getCharListDetail(t.token, t.proxy);
      if (!cl.ok && cl.error.kind === "suspended") {
        // Realm: "This account has been suspended for breaching Terms of Service". Retire it like a failed bring-up does.
        retireSuspended(this.o.sd.deps, acc);
        st.lastError = "suspended";
        this.audit.suspended++;
        return "skipped";
      }
      if (!cl.ok) throw new Error(`char/list ${cl.error.kind}${"body" in cl.error ? ` :: ${String(cl.error.body).slice(0, 160).replace(/\s+/g, " ")}` : "detail" in cl.error ? ` :: ${cl.error.detail}` : ""} via ${t.proxy?.host ?? "direct"}`);
      applyCharList(st, cl.value, now);
      // char/list's BackpackSlots is the one capacity source that needs no game login.
      if (st.hasBackpack !== null) this.o.sd.tracker.noteCapacity(acc.botGuid, st.hasBackpack ? 16 : 8);
      const cal = await fetchCalendar(t.token, t.proxy);
      if (!cal.ok) throw new Error(`calendar ${cal.error.kind}${"body" in cal.error ? ` :: ${String(cal.error.body).slice(0, 160).replace(/\s+/g, " ")}` : ""}`);
      // Calibration (docs §9.1): did an HTTP-only visit advance the login-day counter?
      const before = { nonconCurDay: st.nonconCurDay, lastAuditAt: st.lastAuditAt, lastLoginAt: st.lastLoginAt };
      const obs = observeVerifyLogin(store.observed, before, cal.value.nonconsecutiveDay, now);
      if (obs.verifyCountsAsLogin !== store.observed.verifyCountsAsLogin) this.log(`backpacks: calibration — an HTTP audit ${obs.verifyCountsAsLogin ? "DOES" : "does NOT"} count as a login day (${obs.verifyLoginYes} yes / ${obs.verifyLoginNo} no); the login lane ${obs.verifyCountsAsLogin ? "switches to HTTP" : "stays in game"}`);
      store.observed = obs;
      applyCalendar(st, cal.value, now);
      if (store.observed.verifyCountsAsLogin === true) noteLogin(st, now);
      store.noteServerTime(cal.value.serverTime);
      if (!store.seasonFresh(now)) {
        const s = await getSeasonInfo(t.token, t.proxy);
        if (s.ok) store.noteSeason(s.value, now);
        else this.log(`backpacks: season/seasonInfo failed (${s.error.kind}) — keeping the cached clock`);
      }
      st.lastError = null;
      return "ok";
    } finally {
      t.release();
    }
  }

  // Chore ---------------------------------------------------------------------------

  private async runChore(opts: { mode: "dry" | "live"; limit?: number; guids?: string[]; equip?: boolean }): Promise<void> {
    const { store } = this.o;
    const policy: ChorePolicy = { equip: opts.equip ?? false };
    try {
      const accounts = this.pick(opts);
      this.log(`backpacks: ${opts.mode} chore over ${accounts.length} account(s), <= ${CHORE_CONCURRENCY} at once, equip=${policy.equip}`);
      await this.each(this.chore, () => this.choreCancel, accounts, CHORE_CONCURRENCY, CHORE_STAGGER_MS, (acc) => this.choreOne(acc, opts.mode, policy));
    } finally {
      store.save();
      this.chore.running = false;
      this.chore.finishedAt = this.now() / 1000;
      this.chore.current = [];
      this.log(`backpacks: ${opts.mode} chore done — ${this.chore.ok} ok, ${this.chore.failed} failed, ${this.chore.skipped} skipped${this.chore.stoppedReason ? ` (${this.chore.stoppedReason})` : ""}`);
    }
  }

  private async choreOne(acc: BotAccount, mode: "dry" | "live", policy: ChorePolicy): Promise<"ok" | "failed" | "skipped"> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const c = acc.client;
    if ((c && c.active) || acc.assignedRequestId !== null || acc.inUse) {
      st.lastError = "online or busy";
      return "skipped";
    }
    if (sd.deps.gate.lockoutRemainingMs(acc.guid) > 0 || sd.deps.gate.pausedRemainingMs() > 0) {
      st.lastError = "login-locked";
      return "skipped";
    }
    holds.add(acc.guid);
    this.setActivity(acc.guid, `backpack chore (${mode}): logging in`);
    let client: GameClient;
    try {
      client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3");
    } catch (e) {
      holds.delete(acc.guid);
      this.setActivity(acc.guid, null);
      const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
      st.lastError = `bring-up ${verdict}`;
      return verdict === "failed" ? "failed" : "skipped";
    }
    try {
      const r = await runChoreTrip(client, {
        mode, policy, state: st, log: (l) => this.log(`backpacks: ${acc.alias}: ${l}`), now: this.now,
        onStep: (label) => this.setActivity(acc.guid, `backpack chore (${mode}): ${label}`),
      });
      if (client.charSeasonal !== null) sd.pool.setSeasonal(acc, client.charSeasonal);
      const snap = snapshotInventory(client);
      // char/list (the audit) and a confirmed equip outrank a silent stat 79.
      const hasBp = client.hasBackpack || r.equipped || st.hasBackpack === true;
      sd.tracker.updateFromSlots(acc.botGuid, snap.slots, hasBp ? 16 : 8);
      if (client.playerData.name) sd.tracker.recordIgn(acc.botGuid, client.playerData.name);
      st.hasBackpack = hasBp;
      st.held = Object.keys(snap.slots).length;
      noteLogin(st, this.now());
      noteChoreOutcome(st, r.ok, r.error, this.now());
      this.chore.claimed += r.claimed.reduce((n, d) => n + d.quantity, 0);
      if (r.equipped) this.chore.equipped++;
      this.log(`backpacks: ${acc.alias}: ${r.summary}`);
      return r.ok ? "ok" : "failed";
    } finally {
      takeDown(sd.deps, acc, "backpack chore done");
      holds.delete(acc.guid);
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }
}

/** An order the dispatcher stops renewing (the deposit was served or aged out) lapses after this. */
const ORDER_TTL_MS = 5 * 60_000;
/** Trips spent on one order before giving up on it: a bot that fails to equip twice is the lane's problem, not the player's wait. */
const ORDER_MAX_TRIPS = 3;
const CHORE_CONCURRENCY = Number(process.env.BACKPACK_CHORE_CONCURRENCY ?? 2);
const RECYCLE_CONCURRENCY = Number(process.env.BACKPACK_RECYCLE_CONCURRENCY ?? 2);
const LOGIN_CONCURRENCY = Number(process.env.BACKPACK_LOGIN_CONCURRENCY ?? 10);
const LOGIN_STAGGER_MS = Number(process.env.BACKPACK_LOGIN_STAGGER_MS ?? 500);
const CHORE_STAGGER_MS = Number(process.env.BACKPACK_CHORE_STAGGER_MS ?? 3000);

// --- the trip itself ------------------------------------------------------------------

export interface TripOptions {
  mode: "dry" | "live";
  policy: ChorePolicy;
  state: AccountBackpackState;
  log: (line: string) => void;
  now: () => number;
  timeouts?: Partial<typeof TIMEOUTS>;
  /** Called as the trip moves from phase to phase, with a short label for the operator console. */
  onStep?: (label: string) => void;
}
export const TIMEOUTS = {
  inWorldMs: 30_000,
  settleMs: 2_000,
  mapChangeMs: 20_000,
  claimVerdictMs: 8_000,
  /** The proxy's claims that worked went out 5-35 s after CREATESUCCESS in the quest room; one sent right away got no verdict. */
  questRoomSettleMs: 4_000,
  claimAttempts: 2,
  findObjectMs: 8_000,
  walkMs: 30_000,
  /** USEPORTAL is retried (re-walking) when no MAPINFO follows within this. */
  portalWaitMs: 6_000,
  portalAttempts: 4,
  vaultInfoMs: 10_000,
  useItemMs: 8_000,
  /** How close to the Gift Chest before USEITEM (the server refuses from too far; the proxy used 1.0). */
  chestReach: 0.6,
  useItemAttempts: 2,
};
export interface TripResult {
  ok: boolean;
  error: string | null;
  summary: string;
  claimed: BackpackDayState[];
  banked: number | null;
  equipped: boolean;
}

/** Poll `pred` until true or the deadline; throws with `what` on timeout. */
async function waitFor(client: GameClient, pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!client.active) throw new Error(`client went inactive while waiting for ${what}`);
    if (pred()) return;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}
const inWorld = (client: GameClient, map: string): boolean => client.connected && client.objectId !== -1 && !!client.playerData.name && client.mapName === map;

/** The first `pred` packet within `ms`; arm BEFORE the action that provokes it. */
function nextPacket<K extends AnyPacket["type"]>(client: GameClient, type: K, ms: number, pred: (p: Extract<AnyPacket, { type: K }>) => boolean = () => true): Promise<Extract<AnyPacket, { type: K }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off("packet", on);
      resolve(null);
    }, ms);
    const on = (p: AnyPacket) => {
      if (p.type !== type) return;
      const q = p as Extract<AnyPacket, { type: K }>;
      if (!pred(q)) return;
      clearTimeout(timer);
      client.off("packet", on);
      resolve(q);
    };
    client.on("packet", on);
  });
}

/** Wait for an entity of `type` to be in view; the nearest one. */
async function findEntity(client: GameClient, type: number, ms: number, what: string): Promise<{ objectId: number; pos: WorldPos }> {
  let found: { objectId: number; pos: WorldPos } | null = null;
  await waitFor(client, () => {
    const me = client.pos;
    let best: { objectId: number; pos: WorldPos; d: number } | null = null;
    for (const [oid, ent] of client.world.entities) {
      if (ent.type !== type) continue;
      const d = me ? dist(me, ent.pos) : 0;
      if (!best || d < best.d) best = { objectId: oid, pos: ent.pos, d };
    }
    if (best) found = { objectId: best.objectId, pos: best.pos };
    return !!best;
  }, ms, what);
  return found!;
}

/** Walk for real (the client's own frame loop moves along the path) until within `goalDist`. */
export async function walkTo(client: GameClient, goal: WorldPos, goalDist: number, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  let lastPlan = 0;
  while (Date.now() < deadline) {
    if (!client.active || !client.connected) throw new Error(`client went inactive while walking to ${what}`);
    const pos = client.pos;
    if (pos && dist(pos, goal) <= goalDist) {
      client.setPath([]);
      return;
    }
    const now = Date.now();
    if (pos && (now - lastPlan >= 1000 || client.pathLength === 0)) {
      lastPlan = now;
      const path = findPath(client.world, pos, goal, goalDist);
      client.setPath(path ? smoothPath(client.world, pos, path) : [{ ...goal }]);
    }
    await sleep(100);
  }
  client.setPath([]);
  throw new Error(`timed out after ${ms / 1000}s walking to ${what}`);
}

/** Gather one VAULTINFO sequence (lists concatenate until `last`). */
async function readVault(client: GameClient, ms: number): Promise<{ giftObjectId: number; gift: number[] } | null> {
  const deadline = Date.now() + ms;
  let giftObjectId = -1;
  let gift: number[] = [];
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const p = await nextPacket(client, "VAULTINFO", left);
    if (!p) return null;
    const v = p as Packet<"VAULTINFO">;
    if (v.giftObjectId >= 0) giftObjectId = v.giftObjectId;
    gift = gift.concat(v.giftContents);
    if (v.last) return { giftObjectId, gift };
  }
}

/** Collect the server's chatter (notifications, claim responses, failures) between arm() and stop(), for the trip log. */
function captureChatter(client: GameClient): { seen: string[]; stop: () => string[] } {
  const seen: string[] = [];
  const on = (p: AnyPacket) => {
    if (p.type === "NOTIFICATION") seen.push(`NOTIFICATION ${p.message}`);
    else if (p.type === "CLAIMDAILYLOGINRESPONSE") seen.push(`CLAIMDAILYLOGINRESPONSE ${p.message}`);
    else if (p.type === "CLAIMREWARDRESULT") seen.push(`CLAIMREWARDRESULT success=${p.success}`);
    else if (p.type === "FAILURE") seen.push(`FAILURE ${p.errorId} ${p.errorDescription}`);
    else if (p.type === "TEXT" && p.name === "") seen.push(`TEXT ${p.text}`);
    // 0 answers an INVSWAP, 1 a USEITEM; unknownBool false is a refusal (proxy giftchest plugin).
    else if (p.type === "INVRESULT") seen.push(`INVRESULT ok=${p.unknownBool} kind=${p.unknownByte}`);
  };
  client.on("packet", on);
  return { seen, stop: () => { client.off("packet", on); return seen; } };
}

/**
 * Walk to a Vault Portal in view and go through it, retrying the USEPORTAL
 * (re-walking first) until the Vault's MAPINFO arrives. Resolves with the
 * Gift Chest read from the VAULTINFO sequence.
 */
async function enterVault(client: GameClient, T: typeof TIMEOUTS, log: (l: string) => void): Promise<{ giftObjectId: number; gift: number[] }> {
  let last = "";
  for (let attempt = 1; attempt <= T.portalAttempts; attempt++) {
    const portal = await findEntity(client, VAULT_PORTAL_TYPE, T.findObjectMs, "the Vault Portal in view");
    await walkTo(client, portal.pos, 0.8, T.walkMs, "the Vault Portal");
    await sleep(700); // let the server's copy of us arrive too (the first USEPORTAL right after the walk was ignored, live 2026-09-07)
    const me = client.pos ?? portal.pos;
    const vaultInfo = readVault(client, T.portalWaitMs + T.vaultInfoMs);
    const arrived = nextPacket(client, "MAPINFO", T.portalWaitMs, (p) => p.name === VAULT_MAP);
    client.send("USEPORTAL", { objectId: portal.objectId });
    last = `USEPORTAL #${portal.objectId} attempt ${attempt} from (${me.x.toFixed(1)},${me.y.toFixed(1)}), portal at (${portal.pos.x.toFixed(1)},${portal.pos.y.toFixed(1)}), ${dist(me, portal.pos).toFixed(2)} tiles, map ${client.mapName}`;
    log(last);
    if (await arrived) {
      await waitFor(client, () => inWorld(client, VAULT_MAP), T.inWorldMs, "the Vault");
      const vault = await vaultInfo;
      if (!vault) throw new Error("no VAULTINFO after entering the vault");
      return vault;
    }
  }
  throw new Error(`USEPORTAL did not lead to the Vault after ${T.portalAttempts} attempts (${last})`);
}

/**
 * One account's trip, on an already-connected client headed for the Nexus.
 * Never throws for game-side failures: the result says how far it got.
 */
export async function runChoreTrip(client: GameClient, o: TripOptions): Promise<TripResult> {
  const T = { ...TIMEOUTS, ...o.timeouts };
  const res: TripResult = { ok: false, error: null, summary: "", claimed: [], banked: null, equipped: false };
  const steps: string[] = [];
  const live = o.mode === "live";
  const step = (label: string) => o.onStep?.(label);
  try {
    step("waiting for the Nexus");
    await waitFor(client, () => inWorld(client, NEXUS_MAP), T.inWorldMs, "the Nexus");
    await sleep(T.settleMs);
    steps.push(`in the Nexus as ${client.playerData.name}${client.hasBackpack ? " (has backpack)" : ""}`);

    // 1. Calendar and claims.
    step("reading the calendar");
    const cal = await fetchCalendar(client.token, client.proxy);
    if (!cal.ok) throw new Error(`calendar ${cal.error.kind}`);
    applyCalendar(o.state, cal.value, o.now());
    const decision = decide(o.state, o.policy);
    steps.push(decision.reasons.join("; "));
    if (decision.claim.length) {
      if (!live) steps.push(`dry: would claim ${decision.claim.length} day(s)`);
      else {
        step("going to the Daily Quest Room");
        const arrived = nextPacket(client, "MAPINFO", T.mapChangeMs, (p) => p.name === QUEST_ROOM_MAP);
        const roomChatter = captureChatter(client);
        client.send("GOTOQUESTROOM", {});
        const gotRoom = await arrived;
        const roomHeard = roomChatter.stop();
        if (!gotRoom) throw new Error(`GOTOQUESTROOM did not lead to the Daily Quest Room${roomHeard.length ? ` [${roomHeard.join("; ")}]` : ""}`);
        await waitFor(client, () => inWorld(client, QUEST_ROOM_MAP), T.inWorldMs, "the Daily Quest Room");
        await sleep(T.questRoomSettleMs);
        // Fetched from inside the room, as the proxy did for every claim that worked.
        const inRoom = await fetchCalendar(client.token, client.proxy);
        if (!inRoom.ok) throw new Error(`calendar (quest room) ${inRoom.error.kind}`);
        const days = backpackDays(inRoom.value).filter((d) => d.claimable);
        step(`claiming ${days.length} backpack day(s)`);
        for (const d of days) {
          let done = false;
          for (let attempt = 1; attempt <= T.claimAttempts && !done; attempt++) {
            const chatter = captureChatter(client);
            const verdict = nextPacket(client, "CLAIMREWARDRESULT", T.claimVerdictMs, (p) => p.claimKey === d.day.key);
            client.send("CLAIMDAILYLOGINREWARD", { claimKey: d.day.key!, claimType: d.track });
            const v = await verdict;
            const heard = chatter.stop();
            if (v?.success) {
              done = true;
              const key = `${monthKey(inRoom.value.serverTime)}:${d.track}:${d.day.day}`;
              if (!o.state.claimed.includes(key)) o.state.claimed.push(key);
              res.claimed.push({ track: d.track, day: d.day.day, quantity: d.day.quantity, claimable: false });
              steps.push(`claimed ${d.track} day ${d.day.day} (${d.day.quantity}x backpack)`);
            } else {
              steps.push(`claim of ${d.track} day ${d.day.day} attempt ${attempt} ${v ? "refused" : "got no verdict"}${heard.length ? ` [${heard.join("; ")}]` : ""}`);
              if (!v && attempt < T.claimAttempts) await sleep(3000);
            }
          }
        }
        const again = await fetchCalendar(client.token, client.proxy);
        if (again.ok) applyCalendar(o.state, again.value, o.now());
        // The quest room has its own Vault Portal (the proxy went straight through it); else back to the Nexus.
        const here = [...client.world.entities.values()].some((e) => e.type === VAULT_PORTAL_TYPE);
        if (!here) {
          const back = nextPacket(client, "MAPINFO", T.mapChangeMs, (p) => p.name === NEXUS_MAP);
          client.nexus();
          if (!(await back)) throw new Error("did not get back to the Nexus after the quest room");
          await waitFor(client, () => inWorld(client, NEXUS_MAP), T.inWorldMs, "the Nexus (back from the quest room)");
          await sleep(T.settleMs);
        } else steps.push("using the quest room's own Vault Portal");
      }
    }

    // 2. The vault.
    step("walking to the Vault Portal");
    const vault = await enterVault(client, T, o.log);
    step("reading the Gift Chest");
    const banked = vault.gift.filter((t) => t === BACKPACK_ITEM_TYPE).length;
    o.state.banked = banked;
    o.state.lastVaultAt = o.now();
    res.banked = banked;
    steps.push(`gift chest #${vault.giftObjectId}: ${banked} backpack(s) banked, ${vault.gift.filter((t) => t > 0).length} item(s) total`);

    // 3. Equip.
    const after = decide(o.state, o.policy, banked);
    if (after.equip && banked > 0) {
      if (!live) steps.push("dry: would use a backpack from the chest");
      else {
        step("using a backpack from the Gift Chest");
        const chest = client.world.entities.get(vault.giftObjectId);
        if (!chest) throw new Error("the Gift Chest VAULTINFO named is not in view");
        await walkTo(client, chest.pos, T.chestReach, T.walkMs, "the Gift Chest");
        await sleep(1000);
        const slot = vault.gift.indexOf(BACKPACK_ITEM_TYPE);
        let confirmed = "";
        let consumed = true;
        let lastFail = "";
        for (let attempt = 1; attempt <= T.useItemAttempts && !confirmed; attempt++) {
          const me = client.pos ?? chest.pos;
          const chatter = captureChatter(client);
          client.send("USEITEM", {
            time: client.getTime(), slotObject: { objectId: vault.giftObjectId, slotId: slot, objectType: BACKPACK_ITEM_TYPE },
            pos: { ...me }, useType: 0, unknownInt: 0,
          });
          o.log(`USEITEM backpack from chest #${vault.giftObjectId} slot ${slot} (attempt ${attempt}), ${dist(me, chest.pos).toFixed(2)} tiles from the chest at (${chest.pos.x.toFixed(1)},${chest.pos.y.toFixed(1)})`);
          // Success shows as INVRESULT ok=true, stat 79 (not on every account),
          // or the chest's first-page slot no longer holding a backpack; "already used" means
          // the character had one (an earlier attempt landed); INVRESULT
          // ok=false kind=1 is a refusal. char/list lags until the character
          // saves, so it is only the last resort.
          const chestSlot = () => (slot < 8 ? client.world.entities.get(vault.giftObjectId)?.inv?.[slot] : undefined);
          const before = chestSlot();
          const deadline = Date.now() + T.useItemMs;
          let refused = false;
          while (Date.now() < deadline && !confirmed && !refused) {
            if (client.playerData.hasBackpack) confirmed = "HASBACKPACK stat";
            // INVRESULT ok=true kind=1 answered the USEITEM that applied a backpack live (2026-09-07); stat 79 and char/list both lagged.
            else if (chatter.seen.some((x) => x.startsWith("INVRESULT ok=true kind=1"))) confirmed = "server accepted the USEITEM (INVRESULT ok)";
            else if (before === BACKPACK_ITEM_TYPE && chestSlot() !== BACKPACK_ITEM_TYPE) confirmed = "the chest slot emptied";
            else if (chatter.seen.some((x) => x.includes("s.backpack_already_used"))) {
              confirmed = "server: backpack already used (an earlier attempt landed)";
              consumed = false;
            } else if (chatter.seen.some((x) => x.startsWith("INVRESULT ok=false kind=1"))) refused = true;
            else await sleep(150);
          }
          const heard = chatter.stop();
          if (heard.length) o.log(`during USEITEM attempt ${attempt}: ${heard.join("; ")}`);
          if (confirmed) break;
          if (refused) {
            lastFail = `the server refused the USEITEM${heard.length ? ` [${heard.join("; ")}]` : ""}`;
            steps.push(`USEITEM attempt ${attempt}: ${lastFail}`);
            await sleep(1500);
            continue;
          }
          const cl = await getCharListDetail(client.token, client.proxy);
          if (cl.ok && (cl.value.chars[0]?.hasBackpack ?? false)) confirmed = "char/list BackpackSlots=8";
          else {
            lastFail = `no HASBACKPACK, chest slot unchanged, char/list BackpackSlots ${cl.ok ? cl.value.chars[0]?.backpackSlots ?? "?" : cl.error.kind}${heard.length ? ` [${heard.join("; ")}]` : ""}`;
            steps.push(`USEITEM attempt ${attempt}: ${lastFail}`);
          }
        }
        if (!confirmed) throw new Error(`the backpack was not applied (${lastFail})`);
        o.state.hasBackpack = true;
        client.knownBackpack = true;
        o.state.banked = consumed ? banked - 1 : banked;
        res.banked = o.state.banked;
        res.equipped = true;
        steps.push(`backpack applied: 16 slots, confirmed by ${confirmed}`);
      }
    }
    res.ok = true;
    step("done, logging out");
  } catch (e) {
    res.error = (e as Error).message;
    steps.push(`FAILED: ${res.error}`);
    step("failed, logging out");
  }
  res.summary = `${o.mode}: ${steps.join(" | ")}`;
  return res;
}
