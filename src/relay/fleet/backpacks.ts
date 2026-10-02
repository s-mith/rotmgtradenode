// Backpacks for the fleet (docs/relay/BACKPACKS.md).
//
// A backpack is the daily-login calendar's reward: claimed in the game from
// the Daily Quest Room, it lands in the gift chest of the claiming
// character's side; used from a chest onto a character, it gives that
// character 16 trade slots. Nothing here uses one by itself (the automatic
// plan-and-chore of 2026-09-07 was removed on 2026-09-22): the owner works
// from the Accounts tab, one account at a time.
//
//  - The per-account JOBS (startClaim, startConsume) are the two halves of
//    that trip, each its own login: claimBackpackDays (the quest room, one
//    claim per reached day) and applyBackpackFromChest (the Vault, USEITEM out
//    of the gift, vault or spoils chest, confirmed).
//
//  - The DAILY LOGIN brings an account that still has a backpack day ahead
//    into the Nexus once per UTC day and straight out, since the calendar only
//    advances on days the account logged in. Bots the dispatcher wakes count on
//    their own; accounts with nothing ahead are left alone.
//
//  - The CALENDAR is the same for every account; only the counters are per
//    account. Its layout is read once per cycle (the monthly reset) by
//    whichever account reads first (BackpackStore.noteCalendar) and handed to
//    the others with counters at zero (syncCycle); a new account reads once
//    on add for its own counters. From there each day's first login moves
//    the counters along locally (noteLogin), a backpack day shows as reached
//    the day the counter gets to it, and the claim re-reads the real
//    calendar in the quest room anyway.
//
// One per-account state file (BackpackStore). Every step is bounded by a
// timeout so a stuck account ends cleanly. A job or a daily login waits for
// its account to be free and borrows it from the dispatcher the way a
// storage trip does (borrow.ts), holding it away from the dispatcher meanwhile.
import { onlineCapFor } from "./constants";
import fs from "node:fs";
import path from "node:path";
import type { GameClient } from "../client/gameClient";
import type { AnyPacket } from "../protocol/packets";
import type { WorldPos } from "../protocol/data";
import { captureChatter, dist, enterVault, inWorld, NEXUS_MAP, nextPacket, sleep, VAULT_MAP, VAULT_PORTAL_TYPE, waitFor, walkTo, type VaultView } from "./vaultTrip";
import {
  BACKPACK_ITEM_TYPE, backpackDays, clientTokenFor, fetchCalendar, getAccessToken, getCharListDetail, getSeasonInfo,
  type Calendar, type CharListDetail, type ClaimType, type SeasonInfo,
} from "../realm/api";
import type { Proxy } from "../net/proxy";
import type { BotAccount } from "./botPool";
import { borrowAccount, BUSY_RETRY_MS } from "./borrow";
import { bringUp, BringUpRefused, refusalPasses, takeDown } from "./bringUp";
import type { SweepDeps } from "./sweeps";

export { VAULT_PORTAL_TYPE, GIFT_CHEST_TYPE, NEXUS_MAP, VAULT_MAP, walkTo } from "./vaultTrip";
/** Map names as MAPINFO reports them (proxy log, 2026-09-06). */
export const QUEST_ROOM_MAP = "Daily Quest Room";


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
  /** char/list BackpackSlots: 0, 8 or 16 (the upgraded backpack). */
  backpackSlots?: number | null;
  maxNumChars: number | null;
  /** Calendar position on the two tracks: from the cycle's one read, then moved along locally by each day's login (noteLogin). */
  nonconCurDay: number | null;
  conCurDay: number | null;
  backpackDays: BackpackDayState[];
  /** "YYYY-MM" (Realm's clock) of the calendar cycle `backpackDays` and the counters describe; a new cycle means one new read. */
  calendarMonth?: string | null;
  /** Backpacks in the Gift Chest at the last vault visit; null until visited. */
  banked: number | null;
  lastAuditAt: number | null;
  lastVaultAt: number | null;
  /** "YYYY-MM:track:day" of every claim the chore confirmed. */
  claimed: string[];
  /** Epoch seconds of the last login this service made or saw. */
  lastLoginAt: number | null;
  /** "YYYY-MM-DD" (UTC) of the days this service logged the account in this month; reset on month change. */
  loginDays: string[];
  lastError: string | null;
  /** Epoch seconds of the last structural failure (the daily login leaves the account alone for 24 h). */
  lastErrorAt: number | null;
  /** Epoch seconds of the last audit attempt (failures back off a day). */
  lastAuditTriedAt: number | null;
  manual: boolean;
  /** The last per-account job the console started (claim a backpack day, use a backpack on a character) and how it went. */
  lastJob?: { kind: "claim" | "consume"; charId: number | null; at: number; ok: boolean; summary: string } | null;
}

function emptyState(acc: BotAccount): AccountBackpackState {
  return {
    alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, charId: null, seasonal: null, dead: null, hasBackpack: null, maxNumChars: null,
    nonconCurDay: null, conCurDay: null, backpackDays: [], banked: null, lastAuditAt: null, lastVaultAt: null, claimed: [], lastLoginAt: null, loginDays: [], lastError: null,
    lastErrorAt: null, lastAuditTriedAt: null, manual: false,
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
/** Whether the daily login may pick this account right now: not marked manual, alive, no structural failure in the last day. */
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
  if (st.loginDays.includes(day)) return;
  const yesterday = dayKey(nowMs / 1000 - 86_400);
  const consecutive = st.loginDays.includes(yesterday);
  st.loginDays.push(day);
  // The calendar is read once a cycle; each day's first login moves its counters along by itself (owner, 2026-09-23).
  if (st.calendarMonth && st.calendarMonth === monthKey(nowMs / 1000) && st.nonconCurDay !== null) {
    st.nonconCurDay += 1;
    st.conCurDay = consecutive && st.conCurDay !== null ? st.conCurDay + 1 : 1;
  }
}
/** Whether the calendar wants reading: never read, or read for an earlier cycle than the one Realm's clock is in now. */
export function calendarDue(st: AccountBackpackState, nowMs: number): boolean {
  return st.lastAuditAt === null || !st.calendarMonth || st.calendarMonth !== monthKey(nowMs / 1000);
}
/** The backpack days reached on their track (the cycle's read said so, or the counter has moved up to them since) and not yet claimed. */
export function reachedBackpackDays(st: AccountBackpackState): BackpackDayState[] {
  const cur: Record<ClaimType, number | null> = { nonconsecutive: st.nonconCurDay, consecutive: st.conCurDay };
  return st.backpackDays.filter((d) => {
    if (d.quantity <= 0) return false;
    const c = cur[d.track];
    // The counter rule needs a read that recorded the days already claimed (calendarMonth is set by such a read).
    const reached = d.claimable || (!!st.calendarMonth && c !== null && d.day <= c);
    return reached && !st.claimed.includes(`${st.calendarMonth ?? ""}:${d.track}:${d.day}`);
  });
}
/**
 * The calendar is one and the same for every account; only the counters
 * are per account. At a new cycle an account whose state is last cycle's
 * takes the node's layout for this cycle and starts its counters from zero
 * (one for each track if it already logged in today), no read of its own.
 * True when it did.
 */
export function syncCycle(st: AccountBackpackState, layout: { month: string; days: BackpackDayState[] } | null, nowMs: number): boolean {
  const month = monthKey(nowMs / 1000);
  if (!layout || layout.month !== month || st.calendarMonth === month) return false;
  const today = dayKey(nowMs / 1000);
  const loggedToday = st.loginDays.includes(today);
  st.backpackDays = layout.days.map((d) => ({ ...d, claimable: false }));
  st.nonconCurDay = loggedToday ? 1 : 0;
  st.conCurDay = loggedToday ? 1 : 0;
  st.calendarMonth = month;
  st.lastAuditAt = nowMs;
  return true;
}
/** Whether this account still needs a login today (UTC) to advance the calendar. */
export function needsLoginToday(st: AccountBackpackState, nowMs: number): boolean {
  return !st.loginDays.includes(dayKey(nowMs / 1000));
}
/**
 * The nearest backpack day still ahead on either track: reached days are
 * claimable (or claimed, and then below the track's counter), so a day above
 * the counter is one more login per day away. null when nothing is ahead, or
 * the calendar was never read.
 */
export function pendingBackpackDay(st: AccountBackpackState): { track: ClaimType; day: number; current: number; quantity: number } | null {
  const cur: Record<ClaimType, number | null> = { nonconsecutive: st.nonconCurDay, consecutive: st.conCurDay };
  let best: { track: ClaimType; day: number; current: number; quantity: number } | null = null;
  for (const d of st.backpackDays) {
    const c = cur[d.track];
    if (c === null || d.quantity <= 0 || d.day <= c) continue;
    if (!best || d.day - c < best.day - best.current) best = { track: d.track, day: d.day, current: c, quantity: d.quantity };
  }
  return best;
}

/** Fold a char/list body into the state. The single character (MaxNumChars is 1 on these accounts) is the bot's. */
export function applyCharList(st: AccountBackpackState, cl: CharListDetail, now: number, preferredCharId: number | null = null): void {
  const c = (preferredCharId !== null && cl.chars.find((x) => x.id === preferredCharId)) || cl.chars[0] || null;
  st.charId = c?.id ?? null;
  st.seasonal = c ? c.seasonal : null;
  st.dead = c ? c.dead : null;
  st.hasBackpack = c ? c.hasBackpack : null;
  st.backpackSlots = c ? c.backpackSlots : null;
  st.maxNumChars = cl.maxNumChars;
  st.lastAuditAt = now;
}
export function applyCalendar(st: AccountBackpackState, cal: Calendar, now: number): void {
  st.nonconCurDay = cal.nonconsecutiveDay;
  st.conCurDay = cal.consecutiveDay;
  st.backpackDays = backpackDays(cal).map((d) => ({ track: d.track, day: d.day.day, quantity: d.day.quantity, claimable: d.claimable }));
  st.calendarMonth = monthKey(cal.serverTime);
  // A reached day the calendar offers no key for was claimed already: remembered, so the local count never shows it again.
  const cur: Record<ClaimType, number> = { nonconsecutive: cal.nonconsecutiveDay, consecutive: cal.consecutiveDay };
  for (const d of st.backpackDays) {
    const key = `${st.calendarMonth}:${d.track}:${d.day}`;
    if (!d.claimable && d.day <= cur[d.track] && !st.claimed.includes(key)) st.claimed.push(key);
  }
  st.lastAuditAt = now;
}
export const monthKey = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 7);

export const BACKPACK_SLOTS = 16;
/** A bot's trade slots as the audit knows them: 8, 16 with a backpack, 24 with the upgraded one. */
export function capacityOf(st: { hasBackpack: boolean | null; backpackSlots?: number | null }): number {
  if (!st.hasBackpack) return 8;
  return (st.backpackSlots ?? 8) > 8 ? 24 : 16;
}

export class BackpackStore {
  private readonly accounts = new Map<string, AccountBackpackState>();
  private season: (SeasonInfo & { fetchedAt: number }) | null = null;
  private serverTime: number | null = null;
  /** This cycle's calendar layout, the same for every account: which days pay backpacks. From the first read of the cycle. */
  private calendar: { month: string; days: BackpackDayState[]; readAt: number } | null = null;
  /** Season id every account was already marked non-seasonal for (the automatic rollover ran). */
  private rolledSeasonId: string | null = null;
  observed: Observed = emptyObserved();

  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: Record<string, AccountBackpackState>; season?: Clocks["season"]; serverTime?: number | null; calendar?: unknown; rolledSeasonId?: string | null; observed?: Observed };
        for (const [g, st] of Object.entries(raw.accounts ?? {})) this.accounts.set(g, st);
        this.season = raw.season ?? null;
        this.serverTime = raw.serverTime ?? null;
        this.calendar = raw.calendar && typeof raw.calendar === "object" ? (raw.calendar as { month: string; days: BackpackDayState[]; readAt: number }) : null;
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
  /** Drop the rows of accounts no longer on the roster (`keep`: bot guids). Returns how many went. */
  pruneTo(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const g of [...this.accounts.keys()]) {
      if (keep.has(g)) continue;
      this.accounts.delete(g);
      n++;
    }
    if (n) this.requestSave();
    return n;
  }
  clocks(): Clocks {
    return deriveClocks(this.serverTime, this.season);
  }
  noteServerTime(t: number): void {
    this.serverTime = t;
  }
  /** One account's calendar read is the cycle's layout for everyone. */
  noteCalendar(cal: Calendar, now: number): void {
    this.calendar = { month: monthKey(cal.serverTime), days: backpackDays(cal).map((d) => ({ track: d.track, day: d.day.day, quantity: d.day.quantity, claimable: false })), readAt: now };
    this.serverTime = cal.serverTime;
  }
  /** The layout read for this cycle, if any (syncCycle hands it to accounts whose state is last cycle's). */
  calendarLayout(): { month: string; days: BackpackDayState[] } | null {
    return this.calendar ? { month: this.calendar.month, days: this.calendar.days } : null;
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
      fs.writeFileSync(tmp, JSON.stringify({ accounts: Object.fromEntries(this.accounts), season: this.season, serverTime: this.serverTime, calendar: this.calendar, rolledSeasonId: this.rolledSeasonId, observed: this.observed }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.log(`backpacks: failed to write ${this.file}: ${String(e)}`);
    }
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

/** A per-account job from the Accounts tab: `waiting` says why it has not started yet (the account is busy), null once it runs. */
export interface BackpackJob {
  kind: "claim" | "consume";
  charId: number | null;
  since: number;
  waiting: string | null;
}

export interface BackpackServiceOptions {
  /** A Vault view a job read as a character of `seasonal`'s side (storage keeps that side's containers current from it). */
  onVaultView?: (acc: BotAccount, view: VaultView, seasonal: boolean | null) => void;
  /** A backpack was applied to `charId` (storage marks the character's slots). */
  onBackpackApplied?: (acc: BotAccount, charId: number) => void;
  sd: SweepDeps;
  store: BackpackStore;
  /** Guids the dispatcher must leave alone while a job drives them. */
  holds: Set<string>;
  /** Ask the dispatcher to let go of an idle online bot (it disconnects it); false when the bot is busy. */
  release?: (acc: BotAccount) => boolean;
  now?: () => number;
}

export class BackpackService {
  /** Write the state file now (shutdown). */
  flush(): void {
    this.o.store.save();
  }
  /** What this service is doing with an account right now, by account guid — the label the Inventories tab shows. */
  private readonly activity = new Map<string, string>();
  private choreCancel = false;
  private readonly now: () => number;

  constructor(private readonly o: BackpackServiceOptions) {
    this.now = o.now ?? Date.now;
  }
  private log(line: string): void {
    this.o.sd.deps.log(line);
  }
  /** Settled calibration: an HTTP read advances the login-day counter (the old notes' §9.1). */
  verifyCountsAsLogin(): boolean {
    return this.o.store.observed.verifyCountsAsLogin === true;
  }
  /** Give the tracker every capacity the audit knows (char/list BackpackSlots), e.g. after an audit state file was copied in. */
  seedCapacities(): number {
    const caps: Record<string, number> = {};
    for (const acc of this.o.sd.pool.every()) {
      const st = this.o.store.for(acc);
      if (st.hasBackpack !== null) caps[acc.botGuid] = capacityOf(st);
    }
    // One bulk write: per-bot notifications over the whole roster OOM'd prod (2026-09-07).
    const n = this.o.sd.tracker.noteCapacities(caps);
    if (n) this.log(`backpacks: seeded ${n} bot capacit${n === 1 ? "y" : "ies"} from the audit state`);
    return n;
  }
  clocks(): Clocks {
    return this.o.store.clocks();
  }
  /** A bot the dispatcher (or anything else) brought into the world today: counts as that day's login. */
  noteLogin(acc: BotAccount): void {
    noteLogin(this.o.store.for(acc), this.now());
  }
  private readonly calendarInFlight = new Set<string>();
  /**
   * Every successful bring-up: char/list was just read, so the row learns
   * backpack/seasonal for free, the day counts as a login (and moves the
   * counters), and when the calendar is due (never read, or a new cycle) it is
   * fetched with the session's own token.
   */
  onLogin(acc: BotAccount, client: GameClient): void {
    const { store, sd } = this.o;
    const st = store.for(acc);
    const nowMs = this.now();
    if (client.charHasBackpack !== null) st.hasBackpack = client.charHasBackpack;
    if (client.charSeasonal !== null) st.seasonal = client.charSeasonal;
    st.charId = client.charId >= 0 ? client.charId : st.charId;
    syncCycle(st, store.calendarLayout(), nowMs);
    noteLogin(st, nowMs);
    if (st.hasBackpack !== null) sd.tracker.noteCapacity(acc.botGuid, capacityOf(st));
    if (calendarDue(st, nowMs) && client.token && !this.calendarInFlight.has(acc.guid)) {
      this.calendarInFlight.add(acc.guid);
      void fetchCalendar(client.token, client.proxy)
        .then((cal) => {
          if (!cal.ok) return;
          applyCalendar(st, cal.value, this.now());
          store.noteCalendar(cal.value, this.now());
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

  // Per-account jobs (the Accounts tab's buttons) --------------------------------------
  // The chore trip in two halves, each its own login: claiming the reached
  // backpack day(s) as the played character, and using a backpack from a
  // chest on one named character. Each is taken at once and runs when the
  // account is free (queueJob); the outcome lands in the account's lastJob
  // and the roster shows the job, waiting or running, meanwhile.

  private readonly jobs = new Map<string, BackpackJob>();
  /** The job on `guid` right now, waiting for the account or running, if any. */
  jobOf(guid: string): BackpackJob | null {
    return this.jobs.get(guid) ?? null;
  }
  /** What the roster shows about an account's backpacks: reached days, the next one ahead, today's login, the last job. */
  viewFor(acc: BotAccount, nowMs = this.now()): { claimable: number; claimableDays: { track: ClaimType; day: number; quantity: number }[]; pending: ReturnType<typeof pendingBackpackDay>; calendarAt: number | null; loginToday: boolean; job: BackpackJob | null; lastJob: AccountBackpackState["lastJob"] } {
    const st = this.o.store.for(acc);
    syncCycle(st, this.o.store.calendarLayout(), nowMs);
    const days = reachedBackpackDays(st).map((d) => ({ track: d.track, day: d.day, quantity: d.quantity }));
    return { claimable: days.reduce((n, d) => n + d.quantity, 0), claimableDays: days, pending: pendingBackpackDay(st), calendarAt: st.lastAuditAt, loginToday: !needsLoginToday(st, nowMs), job: this.jobOf(acc.guid), lastJob: st.lastJob ?? null };
  }
  /**
   * Claim the account's reached backpack day(s): one login, the Daily Quest
   * Room, log out. The reward lands in the gift chest of the side of the
   * character that claims, so the caller names the character (`charId`,
   * from the roster's character list); without one the played character
   * claims.
   */
  startClaim(acc: BotAccount, charId?: number): { ok: true } | { ok: false; error: string } {
    const why = this.refusal(acc);
    if (why) return { ok: false, error: why };
    const st = this.o.store.for(acc);
    if (!reachedBackpackDays(st).length) return { ok: false, error: "no backpack day is reached on this account's calendar" };
    this.queueJob(acc, { kind: "claim", charId: charId ?? null }, `claiming a backpack day${charId !== undefined ? ` as character #${charId}` : ""}`, () => this.claimJob(acc, charId));
    return { ok: true };
  }
  /** Use a backpack from a chest on character `charId`: one login as it, the Vault, USEITEM, log out. */
  startConsume(acc: BotAccount, charId: number): { ok: true } | { ok: false; error: string } {
    const why = this.refusal(acc);
    if (why) return { ok: false, error: why };
    this.queueJob(acc, { kind: "consume", charId }, `using a backpack on character #${charId}`, () => this.consumeJob(acc, charId));
    return { ok: true };
  }
  /** Why a job cannot even be queued: one is on the account already, or the account can never log in. A busy account is waited for instead. */
  private refusal(acc: BotAccount): string | null {
    if (this.jobs.has(acc.guid)) return "a backpack job is already on this account";
    if (acc.suspended) return "the account is suspended";
    return null;
  }
  /**
   * A job from the Accounts tab: taken at once, one per account, and run
   * when the account is free (whenFree), however long it stays busy; the
   * console can take it back while it waits (cancelWaiting).
   */
  private queueJob(acc: BotAccount, job: { kind: "claim" | "consume"; charId: number | null }, label: string, run: () => Promise<"again" | void>): void {
    const entry: BackpackJob = { ...job, since: this.now(), waiting: null };
    this.jobs.set(acc.guid, entry);
    void this.whenFree(acc, label, run, { waiting: (why) => { entry.waiting = why; }, wanted: () => this.jobs.get(acc.guid) === entry })
      .then(() => {
        if (this.jobs.get(acc.guid) === entry) return;
        this.log(`backpacks: ${acc.alias}: ${job.kind} job taken back before it ran`);
      })
      .catch((e) => this.log(`backpacks: ${acc.alias}: ${job.kind} job raised: ${String(e)}`))
      .finally(() => {
        if (this.jobs.get(acc.guid) !== entry) return;
        this.jobs.delete(acc.guid);
        this.setActivity(acc.guid, null);
      });
  }
  /** Take back the account's job while it waits for the account; one already running goes on. */
  cancelWaiting(acc: BotAccount): { ok: true } | { ok: false; error: string } {
    const job = this.jobs.get(acc.guid);
    if (!job) return { ok: false, error: "no backpack job on this account" };
    if (job.waiting === null) return { ok: false, error: "the job is running now; it cannot be taken back" };
    this.jobs.delete(acc.guid);
    this.setActivity(acc.guid, null);
    return { ok: true };
  }
  /**
   * Run `run` on the account once it is free, as a queued character job
   * waits for it (storage.ts): borrowed from the dispatcher like a storage
   * trip (an idle bot at the desk is let go, a login under way finishes, a
   * login cooldown or a pause is waited out) and, while something else has
   * it (a trade, another trip) or `run` says "again" (its login was held, or
   * every proxy host carries a bot), looked at again every BUSY_RETRY_MS for
   * as long as that lasts. `wanted`, asked before each try, drops a job no
   * longer needed.
   */
  private async whenFree(acc: BotAccount, label: string, run: () => Promise<"again" | void>, o: { waiting?: (why: string | null) => void; wanted?: () => boolean } = {}): Promise<void> {
    const { sd, holds } = this.o;
    for (;;) {
      if (o.wanted && !o.wanted()) return;
      let why: string | null = acc.assignedRequestId !== null || acc.inUse ? "the account is busy" : holds.has(acc.guid) ? "another job has the account" : null;
      if (!why) {
        const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${label}: ${l}`), now: this.now });
        if (lent.ok) {
          // Taken back while the account was being borrowed: not run after all.
          if (o.wanted && !o.wanted()) {
            lent.giveBack();
            return;
          }
          o.waiting?.(null);
          let again: "again" | void;
          try {
            again = await run();
          } finally {
            lent.giveBack();
          }
          if (again !== "again") return;
          why = "its login was held back (logins paused or locked, or every proxy host carrying a bot)";
        } else why = lent.why;
      }
      if (o.wanted && !o.wanted()) return;
      o.waiting?.(why);
      this.setActivity(acc.guid, `${label}: queued, waiting for the account (${why})`);
      await sleep(BUSY_RETRY_MS);
    }
  }
  private async claimJob(acc: BotAccount, charId?: number): Promise<"again" | void> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    const T = TIMEOUTS;
    this.setActivity(acc.guid, `claiming a backpack day${charId !== undefined ? ` as character #${charId}` : ""}: logging in`);
    const steps: string[] = [];
    let ok = false;
    let client: GameClient | null = null;
    try {
      try {
        client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3", charId !== undefined ? { charId } : {});
      } catch (e) {
        // Logins held or every proxy host in use: the job waits on, not a failure.
        if (!refusalPasses(e)) throw e;
        return "again";
      }
      if (charId !== undefined && client.charId !== charId) throw new Error(`the game loaded character #${client.charId} instead of #${charId}`);
      await waitFor(client, () => inWorld(client!, NEXUS_MAP), T.inWorldMs, "the Nexus");
      await sleep(T.settleMs);
      steps.push(`in the Nexus as ${client.playerData.name} (${client.charSeasonal ? "seasonal" : "non-seasonal"} character #${client.charId})`);
      const cal = await fetchCalendar(client.token, client.proxy);
      if (!cal.ok) throw new Error(`calendar ${cal.error.kind}`);
      applyCalendar(st, cal.value, this.now());
      store.noteCalendar(cal.value, this.now());
      const claim = st.backpackDays.filter((d) => d.claimable);
      if (!claim.length) throw new Error("no backpack day is reached on the calendar");
      const r = await claimBackpackDays(client, st, T, (l) => this.log(`backpacks: ${acc.alias}: ${l}`), (l) => this.setActivity(acc.guid, `claiming a backpack day: ${l}`), this.now);
      steps.push(...r.steps);
      if (!r.claimed.length) throw new Error("no claim went through");
      // The reward lands in the gift chest of the side the character is on.
      steps.push(`${r.claimed.reduce((n, d) => n + d.quantity, 0)} backpack(s) now in the ${client.charSeasonal ? "seasonal" : "non-seasonal"} gift chest`);
      noteLogin(st, this.now());
      ok = true;
    } catch (e) {
      steps.push(`FAILED: ${e instanceof BringUpRefused ? `bring-up ${e.verdict}: ` : ""}${(e as Error).message}`);
    } finally {
      if (client) takeDown(sd.deps, acc, "backpack day claimed");
      this.setActivity(acc.guid, null);
    }
    st.lastJob = { kind: "claim", charId: charId ?? null, at: this.now(), ok, summary: steps.join(" | ") };
    st.lastError = ok ? null : st.lastJob.summary;
    this.log(`backpacks: ${acc.alias}: claim job: ${st.lastJob.summary}`);
    store.requestSave();
  }
  private async consumeJob(acc: BotAccount, charId: number): Promise<"again" | void> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    const T = TIMEOUTS;
    this.setActivity(acc.guid, `using a backpack on character #${charId}: logging in`);
    const steps: string[] = [];
    let ok = false;
    let client: GameClient | null = null;
    try {
      try {
        client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3", { charId });
      } catch (e) {
        // Logins held or every proxy host in use: the job waits on, not a failure.
        if (!refusalPasses(e)) throw e;
        return "again";
      }
      if (client.charId !== charId) throw new Error(`the game loaded character #${client.charId} instead of #${charId}`);
      await waitFor(client, () => inWorld(client!, NEXUS_MAP), T.inWorldMs, "the Nexus");
      await sleep(T.settleMs);
      const side = client.charSeasonal;
      steps.push(`in the Nexus as ${client.playerData.name} (${side ? "seasonal" : "non-seasonal"} character #${charId}${client.hasBackpack ? ", has a backpack" : ""})`);
      this.setActivity(acc.guid, `using a backpack on character #${charId}: walking to the Vault`);
      const view = await enterVault(client, T, (l) => this.log(`backpacks: ${acc.alias}: ${l}`));
      const r = await applyBackpackFromChest(client, view, T, (l) => this.log(`backpacks: ${acc.alias}: ${l}`), (l) => this.setActivity(acc.guid, `using a backpack on character #${charId}: ${l}`));
      steps.push(...r.steps);
      // What this side's containers hold now, the used backpack gone, for storage's view of them.
      try {
        this.o.onVaultView?.(acc, r.view, side);
      } catch (e) {
        this.log(`backpacks: ${acc.alias}: storage did not take the vault view: ${String(e)}`);
      }
      if (!r.applied) throw new Error(r.error ?? "the backpack was not applied");
      if (charId === (st.charId ?? acc.info.charId ?? null) || charId === client.charId && side === st.seasonal) {
        // The played character: the row and the tracker's slot count follow.
        if (charId === (st.charId ?? -1)) {
          st.hasBackpack = true;
          st.backpackSlots = Math.max(8, st.backpackSlots ?? 0);
          sd.tracker.noteCapacity(acc.botGuid, capacityOf(st));
        }
      }
      if (side === st.seasonal && st.banked !== null) st.banked = Math.max(0, r.view.gift.slots.filter((t) => t === BACKPACK_ITEM_TYPE).length);
      try {
        this.o.onBackpackApplied?.(acc, charId);
      } catch (e) {
        this.log(`backpacks: ${acc.alias}: storage did not note the backpack: ${String(e)}`);
      }
      ok = true;
    } catch (e) {
      steps.push(`FAILED: ${e instanceof BringUpRefused ? `bring-up ${e.verdict}: ` : ""}${(e as Error).message}`);
    } finally {
      if (client) takeDown(sd.deps, acc, "backpack used");
      this.setActivity(acc.guid, null);
    }
    st.lastJob = { kind: "consume", charId, at: this.now(), ok, summary: steps.join(" | ") };
    st.lastError = ok ? null : st.lastJob.summary;
    this.log(`backpacks: ${acc.alias}: consume job (character #${charId}): ${st.lastJob.summary}`);
    store.requestSave();
  }

  // The daily login -------------------------------------------------------------------
  // The calendar only advances on days the account logs in. An account with a
  // backpack day still ahead gets one login a day (a look at the Nexus and
  // straight out) on days nothing else brought it into the world; an account
  // with nothing ahead is left alone.

  private dailyTimer: ReturnType<typeof setInterval> | null = null;
  private dailyBusy = false;
  /** Accounts that need today's login to move a backpack day closer: not yet in the world today, a backpack day ahead, no backpack job on them (its login counts). A busy one is waited for (dailyLoginOne). */
  dailyLoginPicks(nowMs = this.now()): BotAccount[] {
    const out: BotAccount[] = [];
    for (const acc of this.o.sd.pool.every()) {
      if (acc.suspended) continue;
      const st = this.o.store.for(acc);
      syncCycle(st, this.o.store.calendarLayout(), nowMs);
      if (!needsLoginToday(st, nowMs) || !eligibleForTrip(st, nowMs) || !pendingBackpackDay(st)) continue;
      if (this.jobs.has(acc.guid)) continue;
      out.push(acc);
    }
    return out;
  }
  /** Start the daily pass: a check every `everyMs`, the first one soon after start. */
  startDailyLogins(everyMs = DAILY_LOGIN_EVERY_MS, firstMs = DAILY_LOGIN_FIRST_MS): void {
    if (this.dailyTimer) return;
    const tick = () => void this.dailyLoginPass();
    setTimeout(tick, firstMs).unref?.();
    this.dailyTimer = setInterval(tick, everyMs);
    this.dailyTimer.unref?.();
  }
  stopDailyLogins(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = null;
  }
  /**
   * How many daily logins run at once: one per exit IP the proxy list has
   * switched on (onlineCapFor: DIRECT_ONLINE_BOTS without a list), or the
   * BACKPACK_LOGIN_CONCURRENCY override. Each login claims its own exit, so
   * more workers than hosts would only wait.
   */
  private loginConcurrency(): number {
    if (LOGIN_CONCURRENCY_OVERRIDE !== null) return LOGIN_CONCURRENCY_OVERRIDE;
    return Math.max(1, onlineCapFor(this.o.sd.deps.proxies.exclusiveCapacity()));
  }
  /** One pass over dailyLoginPicks, one per exit IP at a time. */
  async dailyLoginPass(): Promise<{ picked: number; ok: number; failed: number; skipped: number }> {
    const out = { picked: 0, ok: 0, failed: 0, skipped: 0 };
    if (this.dailyBusy) return out;
    this.dailyBusy = true;
    try {
      const picks = this.dailyLoginPicks();
      out.picked = picks.length;
      if (!picks.length) return out;
      this.log(`backpacks: daily login for ${picks.length} account(s) with a backpack day ahead`);
      const run = freshRun();
      await this.each(run, () => false, picks, this.loginConcurrency(), LOGIN_STAGGER_MS, (acc) => this.dailyLoginOne(acc));
      out.ok = run.ok;
      out.failed = run.failed;
      out.skipped = run.skipped;
      this.log(`backpacks: daily login done — ${run.ok} ok, ${run.failed} failed, ${run.skipped} skipped`);
      return out;
    } finally {
      this.dailyBusy = false;
      this.o.store.requestSave();
    }
  }
  /**
   * One account's daily login, once the account is free (whenFree): a busy,
   * online, paused or locked account is waited for rather than skipped. One
   * brought into the world meanwhile by something else (a trade, a trip, a
   * backpack job) needs no login of its own.
   */
  private async dailyLoginOne(acc: BotAccount): Promise<"ok" | "failed" | "skipped"> {
    const st = this.o.store.for(acc);
    let verdict: "ok" | "failed" | "skipped" = "skipped";
    await this.whenFree(acc, "daily login for the backpack calendar", async () => {
      verdict = await this.dailyLogin(acc);
    }, { wanted: () => needsLoginToday(st, this.now()) && !this.jobs.has(acc.guid) });
    return verdict;
  }
  private async dailyLogin(acc: BotAccount): Promise<"ok" | "failed" | "skipped"> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    this.setActivity(acc.guid, "daily login for the backpack calendar");
    let client: GameClient | null = null;
    try {
      client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3");
      await waitFor(client, () => inWorld(client!, NEXUS_MAP), TIMEOUTS.inWorldMs, "the Nexus");
      syncCycle(st, store.calendarLayout(), this.now());
      noteLogin(st, this.now());
      if (calendarDue(st, this.now())) {
        const cal = await fetchCalendar(client.token, client.proxy);
        if (cal.ok) {
          applyCalendar(st, cal.value, this.now());
          store.noteCalendar(cal.value, this.now());
        }
      }
      const next = pendingBackpackDay(st);
      this.log(`backpacks: ${acc.alias}: daily login done${next ? `; ${next.track} day ${next.day} pays ${next.quantity} backpack(s), the counter is at ${next.current}` : "; nothing ahead now"}${reachedBackpackDays(st).length ? " — a backpack day is reached: claim it from the Accounts tab" : ""}`);
      st.lastError = null;
      return "ok";
    } catch (e) {
      const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
      st.lastError = `daily login: ${verdict === "failed" ? (e as Error).message : verdict}`;
      if (verdict === "failed") st.lastErrorAt = Math.floor(this.now() / 1000);
      return verdict === "failed" ? "failed" : "skipped";
    } finally {
      if (client) takeDown(sd.deps, acc, "daily login done");
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /**
   * Reads with a token somebody else already has (the storage read's): the
   * character list every time; the calendar once per cycle (calendarDue),
   * which for a new account is its first read. The daily logins move the
   * counters along from there.
   */
  async refreshFromToken(acc: BotAccount, token: string, proxy: Proxy | null): Promise<void> {
    const { store, sd } = this.o;
    const st = store.for(acc);
    const now = this.now();
    try {
      const cl = await getCharListDetail(token, proxy);
      if (cl.ok) {
        applyCharList(st, cl.value, now, acc.info.charId ?? null);
        if (st.hasBackpack !== null) sd.tracker.noteCapacity(acc.botGuid, capacityOf(st));
      }
      syncCycle(st, store.calendarLayout(), now);
      if (!calendarDue(st, now)) return;
      const cal = await fetchCalendar(token, proxy);
      if (cal.ok) {
        // Calibration (the old notes' §9.1): does an HTTP-only visit advance the login-day counter?
        const before = { nonconCurDay: st.nonconCurDay, lastAuditAt: st.lastAuditAt, lastLoginAt: st.lastLoginAt };
        const obs = observeVerifyLogin(store.observed, before, cal.value.nonconsecutiveDay, now);
        if (obs.verifyCountsAsLogin !== store.observed.verifyCountsAsLogin) this.log(`backpacks: calibration — an HTTP read ${obs.verifyCountsAsLogin ? "DOES" : "does NOT"} count as a login day (${obs.verifyLoginYes} yes / ${obs.verifyLoginNo} no)`);
        store.observed = obs;
        applyCalendar(st, cal.value, now);
        store.noteCalendar(cal.value, now);
        if (store.observed.verifyCountsAsLogin === true) noteLogin(st, now);
      } else this.log(`backpacks: ${acc.alias}: calendar not read with the snapshot's token: ${cal.error.kind}`);
      if (!store.seasonFresh(now)) {
        const s = await getSeasonInfo(token, proxy);
        if (s.ok) store.noteSeason(s.value, now);
      }
    } finally {
      store.requestSave();
    }
  }
  private setActivity(guid: string, label: string | null): void {
    if (label === null) this.activity.delete(guid);
    else this.activity.set(guid, label);
  }

  // Runs ---------------------------------------------------------------------------

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

}

const LOGIN_CONCURRENCY_OVERRIDE = process.env.BACKPACK_LOGIN_CONCURRENCY ? Math.max(1, Number(process.env.BACKPACK_LOGIN_CONCURRENCY) || 1) : null;
const LOGIN_STAGGER_MS = Number(process.env.BACKPACK_LOGIN_STAGGER_MS ?? 3000);
/** How often the daily-login pass looks for accounts that still need today's login, and how soon after start. */
const DAILY_LOGIN_EVERY_MS = Number(process.env.BACKPACK_DAILY_LOGIN_EVERY_S ?? 1800) * 1000;
const DAILY_LOGIN_FIRST_MS = Number(process.env.BACKPACK_DAILY_LOGIN_FIRST_S ?? 120) * 1000;

// --- the two halves of a backpack trip --------------------------------------------------

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
/** One claim pass: the Daily Quest Room, every reached backpack day claimed, the calendar re-read. The client stays in the quest room. */
export interface ClaimOutcome {
  claimed: BackpackDayState[];
  steps: string[];
  /** The quest room has its own Vault Portal in view (the proxy went straight through it). */
  vaultPortalHere: boolean;
}
export async function claimBackpackDays(client: GameClient, state: AccountBackpackState, T: typeof TIMEOUTS, log: (l: string) => void, step: (l: string) => void, now: () => number): Promise<ClaimOutcome> {
  const out: ClaimOutcome = { claimed: [], steps: [], vaultPortalHere: false };
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
        if (!state.claimed.includes(key)) state.claimed.push(key);
        out.claimed.push({ track: d.track, day: d.day.day, quantity: d.day.quantity, claimable: false });
        out.steps.push(`claimed ${d.track} day ${d.day.day} (${d.day.quantity}x backpack)`);
      } else {
        out.steps.push(`claim of ${d.track} day ${d.day.day} attempt ${attempt} ${v ? "refused" : "got no verdict"}${heard.length ? ` [${heard.join("; ")}]` : ""}`);
        if (!v && attempt < T.claimAttempts) await sleep(3000);
      }
    }
  }
  const again = await fetchCalendar(client.token, client.proxy);
  if (again.ok) applyCalendar(state, again.value, now());
  out.vaultPortalHere = [...client.world.entities.values()].some((e) => e.type === VAULT_PORTAL_TYPE);
  log(`claim pass: ${out.claimed.length} of ${days.length} day(s) claimed`);
  return out;
}

/** Where a backpack sits in a Vault view: the gift chest first (where the calendar puts them), then the vault chests, then the spoils chest. */
export function findBackpack(view: VaultView): { kind: "gift" | "vault" | "spoils"; objectId: number; slot: number } | null {
  for (const kind of ["gift", "vault", "spoils"] as const) {
    const slot = view[kind].slots.indexOf(BACKPACK_ITEM_TYPE);
    if (slot !== -1 && view[kind].objectId >= 0) return { kind, objectId: view[kind].objectId, slot };
  }
  return null;
}
/** Backpacks in every chest of a Vault view. */
export function backpacksIn(view: VaultView): number {
  return (["gift", "vault", "spoils"] as const).reduce((n, k) => n + view[k].slots.filter((t) => t === BACKPACK_ITEM_TYPE).length, 0);
}
const CHEST_LABEL = { gift: "Gift Chest", vault: "vault chest", spoils: "spoils chest" } as const;

/** One apply: USEITEM a backpack out of a chest of `view` onto the character, confirmed. `view` comes back with the used slot emptied. */
export interface ApplyOutcome {
  applied: boolean;
  /** Whether the chest slot was spent (false when the server said the character already had one). */
  consumed: boolean;
  error: string | null;
  steps: string[];
  view: VaultView;
  /** Backpacks in the chests before the apply. */
  banked: number;
}
export async function applyBackpackFromChest(client: GameClient, view: VaultView, T: typeof TIMEOUTS, log: (l: string) => void, step: (l: string) => void): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { applied: false, consumed: false, error: null, steps: [], view, banked: backpacksIn(view) };
  const where = findBackpack(view);
  if (!where) {
    out.error = "no backpack in this side's chests";
    out.steps.push(out.error);
    return out;
  }
  step(`using a backpack from the ${CHEST_LABEL[where.kind]}`);
  const chest = client.world.entities.get(where.objectId);
  if (!chest) {
    out.error = `the ${CHEST_LABEL[where.kind]} VAULTINFO named is not in view`;
    out.steps.push(out.error);
    return out;
  }
  await walkTo(client, chest.pos, T.chestReach, T.walkMs, `the ${CHEST_LABEL[where.kind]}`);
  await sleep(1000);
  let confirmed = "";
  let consumed = true;
  let lastFail = "";
  for (let attempt = 1; attempt <= T.useItemAttempts && !confirmed; attempt++) {
    const me = client.pos ?? chest.pos;
    const chatter = captureChatter(client);
    client.send("USEITEM", {
      time: client.getTime(), slotObject: { objectId: where.objectId, slotId: where.slot, objectType: BACKPACK_ITEM_TYPE },
      pos: { ...me }, useType: 0, unknownInt: 0,
    });
    log(`USEITEM backpack from ${CHEST_LABEL[where.kind]} #${where.objectId} slot ${where.slot} (attempt ${attempt}), ${dist(me, chest.pos).toFixed(2)} tiles from it at (${chest.pos.x.toFixed(1)},${chest.pos.y.toFixed(1)})`);
    // Success shows as INVRESULT ok=true, stat 79 (not on every account), or
    // the chest's first-page slot no longer holding a backpack; "already used"
    // means the character had one (an earlier attempt landed); INVRESULT
    // ok=false kind=1 is a refusal. char/list lags until the character saves,
    // so it is only the last resort.
    const chestSlot = () => (where.slot < 8 ? client.world.entities.get(where.objectId)?.inv?.[where.slot] : undefined);
    const before = chestSlot();
    const deadline = Date.now() + T.useItemMs;
    let refused = false;
    while (Date.now() < deadline && !confirmed && !refused) {
      if (client.playerData.hasBackpack) confirmed = "HASBACKPACK stat";
      // INVRESULT ok=true kind=1 answered the USEITEM that applied a backpack live (2026-09-07); stat 79 and char/list both lagged.
      else if (chatter.seen.some((x) => x.startsWith("INVRESULT ok=true kind=1"))) confirmed = "server accepted the USEITEM (INVRESULT ok)";
      else if (before === BACKPACK_ITEM_TYPE && chestSlot() !== BACKPACK_ITEM_TYPE) confirmed = "the chest slot emptied";
      else if (chatter.seen.some((x) => x.includes("s.backpack_already_used"))) {
        confirmed = "server: backpack already used (the character had one)";
        consumed = false;
      } else if (chatter.seen.some((x) => x.startsWith("INVRESULT ok=false kind=1"))) refused = true;
      else await sleep(150);
    }
    const heard = chatter.stop();
    if (heard.length) log(`during USEITEM attempt ${attempt}: ${heard.join("; ")}`);
    if (confirmed) break;
    if (refused) {
      lastFail = `the server refused the USEITEM${heard.length ? ` [${heard.join("; ")}]` : ""}`;
      out.steps.push(`USEITEM attempt ${attempt}: ${lastFail}`);
      await sleep(1500);
      continue;
    }
    const cl = await getCharListDetail(client.token, client.proxy);
    const me2 = cl.ok ? cl.value.chars.find((c) => c.id === client.charId) ?? cl.value.chars[0] : undefined;
    if (me2?.hasBackpack) confirmed = `char/list BackpackSlots=${me2.backpackSlots}`;
    else {
      lastFail = `no HASBACKPACK, chest slot unchanged, char/list BackpackSlots ${cl.ok ? me2?.backpackSlots ?? "?" : cl.error.kind}${heard.length ? ` [${heard.join("; ")}]` : ""}`;
      out.steps.push(`USEITEM attempt ${attempt}: ${lastFail}`);
    }
  }
  if (!confirmed) {
    out.error = `the backpack was not applied (${lastFail})`;
    out.steps.push(out.error);
    return out;
  }
  client.knownBackpack = true;
  out.applied = true;
  out.consumed = consumed;
  if (consumed) {
    const slots = [...view[where.kind].slots];
    slots[where.slot] = -1;
    out.view = { ...view, [where.kind]: { ...view[where.kind], slots } };
  }
  out.steps.push(`backpack applied from the ${CHEST_LABEL[where.kind]}: 16 slots, confirmed by ${confirmed}`);
  return out;
}
