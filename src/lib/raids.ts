// Dungeon raids: a group finder after the Discord raid bots (headcount → AFK
// check → pop → run), whose pops are proved by a fleet bot standing in the
// announced bazaar (docs/RAIDS.md). The leader posts a key, raiders join,
// and the secrets come out stage by stage, the way the bots hand them out:
//
//   region            public from the start (everyone sees "US · location hidden")
//   server + bazaar   a raider once they have joined and the AFK check is open
//   party name        a raider once the AFK check is complete (the Pop stage)
//   the leader        sees all of it, always — they typed it
//
// The stripping happens HERE, in raidView(): the API never sends a browser a
// field the rules say it may not have, so the client's reveal logic is only
// presentation. Everything is keyed by account (users.id); the IGN a member
// joined as is kept for display.
//
// The watcher: at the AFK check the site orders a watcher for the raid's
// server and bazaar through the hook the fleet registers (setRaidWatchHook;
// relay/fleet/raidWatch.ts). The fleet reports back through watcherUpdate,
// rosterSeen, popSeen and portalClosed below, and the verdict of each pop
// attempt (a raid_pops row) is decided here: confirmed when the leader's own
// portal was seen, none when a watcher stood there for the whole window and
// saw nothing, unverified when no watcher could look.
import type Database from "better-sqlite3";
import { RAID_DUNGEONS, type RaidDungeon } from "./raidDungeons";
import { WITHDRAW_SERVERS } from "./servers";
import { isWithdrawsDisabled } from "./serverControls";
import { emitRaids } from "./liveBus";
import { serverUsage } from "./serverUsage";
import {
  AFK_SECONDS, LEADER_POINTS_PER_RAIDER, LOCATIONS, locationRevealed, MAX_DESCRIPTION, MAX_KEYS, MAX_PARTY, MAX_POP_EXTENSIONS, partyRevealed, POP_EXTEND_S, POP_WINDOW_S, RAIDER_POINTS_ENTERED, regionOf, sideOf, STRIKE_COOLDOWN_MS, STRIKE_DECAY_MS, STRIKES_TO_BLOCK, validParty,
  type EndedBy, type LeaderRecord, type PopReport, type PopVerdict, type PopView, type PostingHold, type RaidStatus, type RaidView, type RaidWatchHook, type StrikeKind, type WatcherState,
} from "./raidRules";

export * from "./raidRules";

// Lifecycle limits. A headcount nobody advances, or a run nobody ends, is
// closed by the sweep so the list doesn't fill with ghosts; ended raids stay
// listed for a while (so the leader sees "ended", and the party name stays
// with raiders who need it) and are deleted after a day. The audit
// (raid_events) outlives the row.
export const HEADCOUNT_MAX_MS = 30 * 60_000;
export const RUNNING_MAX_MS = 90 * 60_000;
export const ENDED_LISTED_MS = 60 * 60_000;
export const ENDED_KEEP_MS = 24 * 60 * 60_000;
/** A watcher the leader calls during headcount is held this long at most. */
export const EARLY_WATCH_MS = 10 * 60_000;
/** Past a pop window's end the watcher is kept this long to see the portal close and count who went in. */
export const POP_CLOSE_GRACE_MS = 60_000;

type RaidRow = {
  id: number;
  dungeon_id: string;
  leader_user_id: number;
  leader_ign: string;
  leader_ign_lower: string;
  server: string;
  location: string;
  party: string;
  description: string;
  keys: number;
  status: RaidStatus;
  afk_ends_at: number | null;
  pop_window_ends_at: number | null;
  pops_done: number;
  watcher_state: WatcherState;
  watcher_note: string;
  watcher_bot: string | null;
  watcher_since: number | null;
  bazaar_count: number | null;
  present_json: string;
  extended: number;
  leader_in_range: number | null;
  leader_distance: number | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  ended_by: EndedBy | null;
};
type MemberRow = { raid_id: number; user_id: number; ign: string; joined_at: number };
type PopRow = {
  id: number;
  raid_id: number;
  n: number;
  started_at: number;
  window_ends_at: number;
  verdict: PopVerdict;
  popped_at: number | null;
  opener_ign: string | null;
  opener_account: string | null;
  portal_type: number | null;
  portal_object_id: number | null;
  dungeon: string;
  modifiers: string | null;
  opened_at_stamp: number | null;
  beside_json: string | null;
  roster_json: string | null;
  present_json: string | null;
  entered_count: number | null;
  closed_at: number | null;
  note: string;
  leader_points: number | null;
};
type Present = Record<string, { ign: string; at: number }>;

export type Viewer = { userId: number; ign: string } | null;
export type RaidResult = { ok: true; raid: RaidView } | { ok: false; status: number; error: string };

export function dungeonFor(id: string): RaidDungeon | null {
  return RAID_DUNGEONS.find((d) => d.id === id) ?? null;
}
const portalTypeOf = (r: RaidRow): number | null => dungeonFor(r.dungeon_id)?.portalType ?? null;
const parsePresent = (s: string | null): Present => {
  try {
    const v = JSON.parse(s || "{}") as unknown;
    return v && typeof v === "object" ? (v as Present) : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// The fleet's side: the hook the site orders watchers through.

let hook: RaidWatchHook | null = null;
export function setRaidWatchHook(h: RaidWatchHook | null): void {
  hook = h;
}
export function raidWatchHook(): RaidWatchHook | null {
  return hook;
}

// ---------------------------------------------------------------------------
// Views

function popView(p: PopRow, leaderIgnLower: string): PopView {
  return {
    n: p.n, verdict: p.verdict, opener: p.opener_ign || null, byLeader: !!p.opener_ign && p.opener_ign.toLowerCase() === leaderIgnLower,
    poppedAt: p.popped_at, closedAt: p.closed_at, entered: p.entered_count, leaderPoints: p.leader_points, modifiers: p.modifiers || null, windowEndsAt: p.verdict === "pending" ? p.window_ends_at : null,
  };
}

function raidView(r: RaidRow, members: MemberRow[], pops: PopRow[], viewer: Viewer, leaderRecord: LeaderRecord): RaidView {
  const leading = viewer !== null && r.leader_user_id === viewer.userId;
  const joined = leading || (viewer !== null && members.some((m) => m.user_id === viewer.userId));
  const showLoc = locationRevealed(r.status, joined, leading);
  const showParty = partyRevealed(r.status, joined, leading) && r.party !== "";
  const present = parsePresent(r.present_json);
  const presentNames = Object.values(present).sort((a, b) => a.at - b.at).map((p) => p.ign);
  const latest = pops.length ? pops[pops.length - 1] : null;
  return {
    id: r.id,
    dungeonId: r.dungeon_id,
    leader: r.leader_ign,
    region: regionOf(r.server),
    server: showLoc ? r.server : null,
    location: showLoc ? r.location : null,
    party: showParty ? r.party : null,
    hasParty: r.party !== "",
    description: r.description,
    keys: r.keys,
    status: r.status,
    afkEndsAt: r.status === "afk" ? r.afk_ends_at : null,
    popWindowEndsAt: r.status === "popping" ? r.pop_window_ends_at : null,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by,
    limit: dungeonFor(r.dungeon_id)?.limit ?? 50,
    // Leader first, then in joining order.
    raiders: members.slice().sort((a, b) => (a.user_id === r.leader_user_id ? -1 : b.user_id === r.leader_user_id ? 1 : a.joined_at - b.joined_at)).map((m) => m.ign),
    joined,
    leading,
    popsDone: r.pops_done,
    keysLeft: Math.max(0, r.keys - r.pops_done),
    pops: pops.map((p) => popView(p, r.leader_ign_lower)),
    verdict: latest ? latest.verdict : null,
    verifiable: portalTypeOf(r) !== null,
    watcher: { state: r.watcher_state, note: r.watcher_note, since: r.watcher_since },
    bazaarCount: r.bazaar_count,
    presentCount: presentNames.length,
    present: leading ? presentNames : null,
    presentMe: viewer !== null && joined && Object.prototype.hasOwnProperty.call(present, viewer.ign.toLowerCase()),
    extended: r.extended,
    leaderInRange: r.leader_in_range === null ? null : r.leader_in_range !== 0,
    leaderDistance: r.leader_distance,
    leaderRecord,
  };
}

// ---------------------------------------------------------------------------
// Strikes and the leader's record

type StrikeRow = { id: number; user_id: number; ign_lower: string; ign: string; kind: StrikeKind; raid_id: number; at: number; cleared_at: number | null; cleared_by: string | null };

function activeStrikes(db: Database.Database, userId: number, now: number): StrikeRow[] {
  return db.prepare("SELECT * FROM raid_strikes WHERE user_id = ? AND cleared_at IS NULL AND at > ? ORDER BY at").all(userId, now - STRIKE_DECAY_MS) as StrikeRow[];
}
/** Whether the leader may post now, from their active strikes. */
export function postingHold(db: Database.Database, userId: number, now = Date.now()): PostingHold {
  const strikes = activeStrikes(db, userId, now);
  if (strikes.length === 0) return { strikes: 0, until: null };
  if (strikes.length >= STRIKES_TO_BLOCK) return { strikes: strikes.length, until: Infinity };
  const until = strikes[strikes.length - 1].at + (STRIKE_COOLDOWN_MS[strikes.length] ?? STRIKE_COOLDOWN_MS[STRIKE_COOLDOWN_MS.length - 1]);
  return { strikes: strikes.length, until: until > now ? until : null };
}
function holdMessage(h: PostingHold, now: number): string {
  if (h.until === Infinity) return `Posting is blocked: ${h.strikes} strikes (raids that ended with no pop, or cancelled after the AFK check). An operator can clear them.`;
  const mins = Math.ceil(((h.until ?? now) - now) / 60_000);
  return `Posting is on cooldown for ${mins >= 60 ? `${Math.ceil(mins / 60)} h` : `${mins} min`} after ${h.strikes} strike${h.strikes === 1 ? "" : "s"} (a raid that ended with no pop, or was cancelled after the AFK check).`;
}
function strike(db: Database.Database, r: RaidRow, kind: StrikeKind, now: number): void {
  db.prepare("INSERT INTO raid_strikes (user_id, ign_lower, ign, kind, raid_id, at) VALUES (?, ?, ?, ?, ?, ?)").run(r.leader_user_id, r.leader_ign_lower, r.leader_ign, kind, r.id, now);
  const n = activeStrikes(db, r.leader_user_id, now).length;
  event(db, r.id, `strike.${kind}`, r.leader_ign_lower, `${n} active strike${n === 1 ? "" : "s"}${n >= STRIKES_TO_BLOCK ? "; posting blocked until an operator clears them" : STRIKE_COOLDOWN_MS[n] ? `; posting on cooldown ${STRIKE_COOLDOWN_MS[n] / 60_000} min` : ""}`, now);
}

/** What a card says about a leader: raids led, pops they made themselves, pops others made for their raids, active strikes. */
export function leaderRecordFor(db: Database.Database, userId: number, ignLower: string, now = Date.now()): LeaderRecord {
  const count = (ev: string) => (db.prepare("SELECT COUNT(DISTINCT raid_id) AS n FROM raid_events WHERE ign_lower = ? AND event = ?").get(ignLower, ev) as { n: number }).n;
  return { led: count("raid.created"), popped: count("pop.by_leader"), poppedByOthers: count("pop.by_other"), strikes: activeStrikes(db, userId, now).length };
}

export interface StrikeView {
  id: number;
  ign: string;
  ignLower: string;
  kind: StrikeKind;
  raidId: number;
  at: number;
  /** Still counted: not cleared and younger than the decay. */
  active: boolean;
  clearedAt: number | null;
}
/** Every strike of the last 30 days plus any older one not yet cleared, newest first (the operator's view). */
export function listStrikes(db: Database.Database, now = Date.now()): StrikeView[] {
  return (db.prepare("SELECT * FROM raid_strikes WHERE at > ? OR cleared_at IS NULL ORDER BY at DESC LIMIT 500").all(now - STRIKE_DECAY_MS) as StrikeRow[]).map((r) => ({
    id: r.id, ign: r.ign, ignLower: r.ign_lower, kind: r.kind, raidId: r.raid_id, at: r.at, active: r.cleared_at === null && r.at > now - STRIKE_DECAY_MS, clearedAt: r.cleared_at,
  }));
}
/** An operator wipes a player's active strikes; returns how many. */
export function clearStrikes(db: Database.Database, ignLower: string, by: string, now = Date.now()): number {
  const n = db.prepare("UPDATE raid_strikes SET cleared_at = ?, cleared_by = ? WHERE ign_lower = ? AND cleared_at IS NULL").run(now, by, ignLower).changes;
  if (n) emitRaids();
  return n;
}

function membersOf(db: Database.Database, raidIds: number[]): Map<number, MemberRow[]> {
  const out = new Map<number, MemberRow[]>();
  if (raidIds.length === 0) return out;
  const rows = db.prepare(`SELECT * FROM raid_members WHERE raid_id IN (${raidIds.map(() => "?").join(",")}) ORDER BY joined_at, rowid`).all(...raidIds) as MemberRow[];
  for (const m of rows) {
    const list = out.get(m.raid_id);
    if (list) list.push(m);
    else out.set(m.raid_id, [m]);
  }
  return out;
}
function popsOf(db: Database.Database, raidIds: number[]): Map<number, PopRow[]> {
  const out = new Map<number, PopRow[]>();
  if (raidIds.length === 0) return out;
  const rows = db.prepare(`SELECT * FROM raid_pops WHERE raid_id IN (${raidIds.map(() => "?").join(",")}) ORDER BY raid_id, n`).all(...raidIds) as PopRow[];
  for (const p of rows) {
    const list = out.get(p.raid_id);
    if (list) list.push(p);
    else out.set(p.raid_id, [p]);
  }
  return out;
}
const rowOf = (db: Database.Database, id: number): RaidRow | undefined => db.prepare("SELECT * FROM raids WHERE id = ?").get(id) as RaidRow | undefined;
const pendingPop = (db: Database.Database, raidId: number): PopRow | undefined =>
  db.prepare("SELECT * FROM raid_pops WHERE raid_id = ? AND verdict = 'pending' ORDER BY n DESC LIMIT 1").get(raidId) as PopRow | undefined;

/**
 * Every raid worth listing, newest first, as `viewer` may see it. Ended
 * raids drop off the list an hour after ending (they are deleted after a
 * day, see sweepRaids).
 */
export function listRaids(db: Database.Database, viewer: Viewer, now = Date.now()): RaidView[] {
  const rows = db
    .prepare("SELECT * FROM raids WHERE status <> 'ended' OR ended_at > ? ORDER BY created_at DESC, id DESC")
    .all(now - ENDED_LISTED_MS) as RaidRow[];
  const ids = rows.map((r) => r.id);
  const members = membersOf(db, ids);
  const pops = popsOf(db, ids);
  const records = new Map<number, LeaderRecord>();
  const recordOf = (r: RaidRow) => {
    let rec = records.get(r.leader_user_id);
    if (!rec) records.set(r.leader_user_id, (rec = leaderRecordFor(db, r.leader_user_id, r.leader_ign_lower, now)));
    return rec;
  };
  return rows.map((r) => raidView(r, members.get(r.id) ?? [], pops.get(r.id) ?? [], viewer, recordOf(r)));
}

export function getRaid(db: Database.Database, id: number, viewer: Viewer, now = Date.now()): RaidView | null {
  const r = rowOf(db, id);
  if (!r) return null;
  return raidView(r, membersOf(db, [id]).get(id) ?? [], popsOf(db, [id]).get(id) ?? [], viewer, leaderRecordFor(db, r.leader_user_id, r.leader_ign_lower, now));
}

// ---------------------------------------------------------------------------
// The audit

export interface RaidEvent {
  id: number;
  raidId: number;
  event: string;
  ign: string;
  detail: string;
  at: number;
}
function event(db: Database.Database, raidId: number, ev: string, ignLower: string, detail: string, at: number): void {
  db.prepare("INSERT INTO raid_events (raid_id, event, ign_lower, detail, at) VALUES (?, ?, ?, ?, ?)").run(raidId, ev, ignLower, detail, at);
}
export function listRaidEvents(db: Database.Database, raidId: number, limit = 300): RaidEvent[] {
  return (db.prepare("SELECT id, raid_id, event, ign_lower, detail, at FROM raid_events WHERE raid_id = ? ORDER BY id LIMIT ?").all(raidId, limit) as { id: number; raid_id: number; event: string; ign_lower: string; detail: string; at: number }[])
    .map((e) => ({ id: e.id, raidId: e.raid_id, event: e.event, ign: e.ign_lower, detail: e.detail, at: e.at }));
}

export interface RaidHistory {
  /** Raids this player posted. */
  led: number;
  /** Raids of theirs whose pop they made themselves, as a watcher saw it. */
  popped: number;
  /** Raids of theirs whose pop someone else made. */
  poppedByOthers: number;
  /** Raids of theirs that ended because no pop was seen. */
  noPop: number;
  /** Raids of theirs they cancelled after the AFK check had started. */
  cancelled: number;
  /** Active strikes (last 30 days, not cleared). */
  strikes: number;
  /** Points earned from raids, as leader and as raider (raid_rewards). */
  points: number;
  /** Raids they joined (not as leader). */
  joined: number;
  /** Raids where the watcher saw them in the bazaar. */
  present: number;
}
export function raidHistoryFor(db: Database.Database, ignLower: string, now = Date.now()): RaidHistory {
  const rows = db.prepare("SELECT event, COUNT(DISTINCT raid_id) AS n FROM raid_events WHERE ign_lower = ? GROUP BY event").all(ignLower) as { event: string; n: number }[];
  const n = (ev: string) => rows.find((r) => r.event === ev)?.n ?? 0;
  const strikes = (db.prepare("SELECT COUNT(*) AS n FROM raid_strikes WHERE ign_lower = ? AND cleared_at IS NULL AND at > ?").get(ignLower, now - STRIKE_DECAY_MS) as { n: number }).n;
  const points = (db.prepare("SELECT COALESCE(SUM(points), 0) AS p FROM raid_rewards WHERE ign_lower = ?").get(ignLower) as { p: number }).p;
  return { led: n("raid.created"), popped: n("pop.by_leader"), poppedByOthers: n("pop.by_other"), noPop: n("pop.none"), cancelled: n("strike.cancelled"), strikes, joined: n("raid.joined"), present: n("raid.present"), points: Math.round(points * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Bans

export interface RaidBan {
  ign: string;
  ignLower: string;
  reason: string;
  createdAt: number;
}
type BanRow = { ign_lower: string; ign: string; reason: string; created_at: number };
const toBan = (r: BanRow): RaidBan => ({ ign: r.ign, ignLower: r.ign_lower, reason: r.reason, createdAt: r.created_at });

export function listRaidBans(db: Database.Database): RaidBan[] {
  return (db.prepare("SELECT * FROM raid_bans ORDER BY created_at DESC").all() as BanRow[]).map(toBan);
}
export function banRaider(db: Database.Database, ign: string, ignLower: string, reason: string, now = Date.now()): RaidBan {
  db.prepare(
    `INSERT INTO raid_bans (ign_lower, ign, reason, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ign_lower) DO UPDATE SET ign = excluded.ign, reason = excluded.reason`,
  ).run(ignLower, ign, reason, now);
  return toBan(db.prepare("SELECT * FROM raid_bans WHERE ign_lower = ?").get(ignLower) as BanRow);
}
export function unbanRaider(db: Database.Database, ignLower: string): boolean {
  return db.prepare("DELETE FROM raid_bans WHERE ign_lower = ?").run(ignLower).changes > 0;
}
/** Banned when any name linked to the account is on the list: an alt is the same player. */
export function raidBanned(db: Database.Database, userId: number): boolean {
  const row = db.prepare("SELECT 1 AS x FROM raid_bans b JOIN user_igns u ON u.ign_lower = b.ign_lower WHERE u.user_id = ? LIMIT 1").get(userId);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// The watcher order, from the site's side

/**
 * Subscribe the raid to a watcher for its bazaar until `until` (or renew).
 * Without a hook, or for a key whose portal is unknown, the raid is marked so
 * and goes on unverified.
 */
function orderWatch(db: Database.Database, raidId: number, until: number, now: number): void {
  const r = rowOf(db, raidId);
  if (!r || r.status === "ended") return;
  const portalType = portalTypeOf(r);
  const setState = (state: WatcherState, note: string) => {
    if (r.watcher_state === state && r.watcher_note === note) return;
    db.prepare("UPDATE raids SET watcher_state = ?, watcher_note = ?, watcher_since = ?, watcher_bot = CASE WHEN ? = 'none' THEN NULL ELSE watcher_bot END, updated_at = ? WHERE id = ?").run(state, note, now, state, now, raidId);
    event(db, raidId, `watcher.${state}`, "", note, now);
  };
  if (portalType === null) return setState("none", "this key's portal is not known; the pop cannot be verified");
  if (!hook) return setState("none", "no watcher available");
  hook.order({ raidId, server: r.server, side: sideOf(r.location), portalType, leaderIgn: r.leader_ign, until });
  if (r.watcher_state === "none" || r.watcher_state === "left" || r.watcher_state === "failed") setState("ordered", "");
}
function releaseWatch(raidId: number): void {
  hook?.release(raidId);
}

// ---------------------------------------------------------------------------
// Writes. Each one validates, changes the row(s) in a transaction, and tells
// every open browser to refetch.

export interface CreateInput {
  dungeonId: unknown;
  server: unknown;
  location: unknown;
  party?: unknown;
  description?: unknown;
  keys?: unknown;
}

/** Raids run on empty servers only (Realm's own load reading, as the trades use it); "" when the server is fine or no fresh reading exists. */
/**
 * Why a raid may not use `server` right now, or "". The same qualifiers as a withdraw (lib/serverControls.ts
 * withdrawBlock): the operator's per-server withdraw switch first, then Realm's load reading — a server over
 * SERVER_USAGE_MAX (75% or 100% full) is refused; a stale reading stands down.
 */
function serverBlock(db: Database.Database, server: string, now: number): string {
  if (isWithdrawsDisabled(db, server)) return `${server} is switched off right now (raids follow the same server rules as withdraws). Pick another server.`;
  const r = serverUsage.reading(server, now);
  if (!r || !serverUsage.busy(server, now)) return "";
  return `${server} is ${Math.round(r.usage * 100)}% full right now; raids run on empty servers only, like withdraws. Pick a quiet one.`;
}

export function createRaid(db: Database.Database, me: { userId: number; ign: string; ignLower: string }, input: CreateInput, now = Date.now()): RaidResult {
  const dungeon = typeof input.dungeonId === "string" ? dungeonFor(input.dungeonId) : null;
  if (!dungeon) return { ok: false, status: 400, error: "Pick a dungeon key." };
  const server = typeof input.server === "string" ? input.server : "";
  if (!WITHDRAW_SERVERS.includes(server)) return { ok: false, status: 400, error: "Pick a server." };
  const location = typeof input.location === "string" ? input.location : "";
  if (!(LOCATIONS as readonly string[]).includes(location)) return { ok: false, status: 400, error: "Pick a pop location." };
  const party = typeof input.party === "string" ? input.party.trim() : "";
  if (!validParty(party)) return { ok: false, status: 400, error: `Party name: up to ${MAX_PARTY} letters, digits, spaces, dots, dashes or underscores.` };
  const description = typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : "";
  if (description.length > MAX_DESCRIPTION) return { ok: false, status: 400, error: `Description: at most ${MAX_DESCRIPTION} characters.` };
  const keys = input.keys === undefined ? 1 : Number(input.keys);
  if (!Number.isInteger(keys) || keys < 0 || keys > MAX_KEYS) return { ok: false, status: 400, error: `Keys: 0 to ${MAX_KEYS}.` };
  if (raidBanned(db, me.userId)) return { ok: false, status: 403, error: "Your account is blocked from raids." };
  const hold = postingHold(db, me.userId, now);
  if (hold.until !== null) return { ok: false, status: 403, error: holdMessage(hold, now) };
  const blocked = serverBlock(db, server, now);
  if (blocked) return { ok: false, status: 409, error: blocked };

  const result = db.transaction((): RaidResult => {
    const open = db.prepare("SELECT id FROM raids WHERE leader_user_id = ? AND status <> 'ended' LIMIT 1").get(me.userId) as { id: number } | undefined;
    if (open) return { ok: false, status: 409, error: "You already lead an open raid. End it before posting another." };
    const id = Number(
      db
        .prepare(
          `INSERT INTO raids (dungeon_id, leader_user_id, leader_ign, leader_ign_lower, server, location, party, description, keys, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'headcount', ?, ?)`,
        )
        .run(dungeon.id, me.userId, me.ign, me.ignLower, server, location, party, description, keys, now, now).lastInsertRowid,
    );
    db.prepare("INSERT INTO raid_members (raid_id, user_id, ign, joined_at) VALUES (?, ?, ?, ?)").run(id, me.userId, me.ign, now);
    event(db, id, "raid.created", me.ignLower, `${dungeon.dungeon} on ${server}, ${location}, ${keys} key(s)`, now);
    if (dungeon.portalType === null) db.prepare("UPDATE raids SET watcher_note = ? WHERE id = ?").run("this key's portal is not known; the pop cannot be verified", id);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

export function joinRaid(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  if (raidBanned(db, me.userId)) return { ok: false, status: 403, error: "Your account is blocked from raids." };
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.status === "ended") return { ok: false, status: 409, error: "That raid has ended." };
    const already = db.prepare("SELECT 1 AS x FROM raid_members WHERE raid_id = ? AND user_id = ?").get(id, me.userId);
    if (already) return { ok: true, raid: getRaid(db, id, me)! };
    const n = (db.prepare("SELECT COUNT(*) AS n FROM raid_members WHERE raid_id = ?").get(id) as { n: number }).n;
    const limit = dungeonFor(r.dungeon_id)?.limit ?? 50;
    if (n >= limit) return { ok: false, status: 409, error: `That raid is full (${limit} players).` };
    db.prepare("INSERT INTO raid_members (raid_id, user_id, ign, joined_at) VALUES (?, ?, ?, ?)").run(id, me.userId, me.ign, now);
    db.prepare("UPDATE raids SET updated_at = ? WHERE id = ?").run(now, id);
    event(db, id, "raid.joined", me.ign.toLowerCase(), r.status, now);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

/** Leave a raid. The leader leaving ends it: there is no handover. */
export function leaveRaid(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.leader_user_id === me.userId) {
      if (r.status !== "ended") {
        if (r.status === "afk" || r.status === "popping") strike(db, r, "cancelled", now);
        endRow(db, r, "leader_left", now);
      }
      return { ok: true, raid: getRaid(db, id, me)! };
    }
    db.prepare("DELETE FROM raid_members WHERE raid_id = ? AND user_id = ?").run(id, me.userId);
    db.prepare("UPDATE raids SET updated_at = ? WHERE id = ?").run(now, id);
    event(db, id, "raid.left", me.ign.toLowerCase(), r.status, now);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

function endRow(db: Database.Database, r: RaidRow, by: EndedBy, now: number): void {
  // A pop attempt still open is closed with what the watcher could say about it.
  const pending = pendingPop(db, r.id);
  if (pending) {
    const verdict: PopVerdict = pending.note.startsWith("other:") ? "other" : r.watcher_state === "in_bazaar" ? "none" : "unverified";
    db.prepare("UPDATE raid_pops SET verdict = ? WHERE id = ?").run(verdict, pending.id);
  }
  db.prepare("UPDATE raids SET status = 'ended', afk_ends_at = NULL, pop_window_ends_at = NULL, ended_at = ?, ended_by = ?, updated_at = ? WHERE id = ?").run(now, by, now, r.id);
  event(db, r.id, "raid.ended", r.leader_ign_lower, by, now);
  releaseWatch(r.id);
}

/** Open a pop window: the AFK check is complete (or the leader asks for the next key's pop). */
function beginPop(db: Database.Database, r: RaidRow, why: string, now: number): void {
  const n = r.pops_done + 1;
  const ends = now + POP_WINDOW_S * 1000;
  db.prepare("UPDATE raids SET status = 'popping', afk_ends_at = NULL, pop_window_ends_at = ?, extended = 0, updated_at = ? WHERE id = ?").run(ends, now, r.id);
  db.prepare("INSERT INTO raid_pops (raid_id, n, started_at, window_ends_at, verdict, dungeon) VALUES (?, ?, ?, ?, 'pending', ?)").run(r.id, n, now, ends, dungeonFor(r.dungeon_id)?.dungeon ?? "");
  event(db, r.id, "pop.window", r.leader_ign_lower, `pop ${n}: ${why}`, now);
  orderWatch(db, r.id, ends + POP_CLOSE_GRACE_MS, now);
}

/** The pop window closed with no confirmed pop: what that means for the raid. */
function resolvePopWindow(db: Database.Database, r: RaidRow, now: number): PopVerdict {
  const pending = pendingPop(db, r.id);
  const verdict: PopVerdict = pending?.note.startsWith("other:") ? "other" : r.watcher_state === "in_bazaar" ? "none" : "unverified";
  if (pending) db.prepare("UPDATE raid_pops SET verdict = ? WHERE id = ?").run(verdict, pending.id);
  if (verdict === "none" && r.pops_done === 0) {
    // The leader announced, a watcher stood there for the whole window, nothing opened: a strike.
    event(db, r.id, "pop.none", r.leader_ign_lower, `pop ${pending?.n ?? 1}`, now);
    strike(db, r, "no_pop", now);
    endRow(db, r, "no_pop", now);
    return verdict;
  }
  db.prepare("UPDATE raids SET status = 'running', pop_window_ends_at = NULL, updated_at = ? WHERE id = ?").run(now, r.id);
  event(db, r.id, `pop.${verdict}`, r.leader_ign_lower, `pop ${pending?.n ?? r.pops_done + 1}: ${pending?.note || "window over"}`, now);
  releaseWatch(r.id);
  return verdict;
}

/**
 * The leader moves the raid on: headcount → AFK check (a fixed two minutes),
 * AFK check → Pop (closing the check early), running → ended.
 */
export function advanceRaid(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.leader_user_id !== me.userId) return { ok: false, status: 403, error: "Only the leader can do that." };
    switch (r.status) {
      case "headcount": {
        const blocked = serverBlock(db, r.server, now);
        if (blocked) return { ok: false, status: 409, error: `${blocked} Cancelling now is free; repost on it.` };
        const ends = now + AFK_SECONDS * 1000;
        db.prepare("UPDATE raids SET status = 'afk', afk_ends_at = ?, updated_at = ? WHERE id = ?").run(ends, now, id);
        event(db, id, "afk.start", r.leader_ign_lower, `${AFK_SECONDS}s`, now);
        orderWatch(db, id, ends + POP_WINDOW_S * 1000 + POP_CLOSE_GRACE_MS, now);
        break;
      }
      case "afk":
        event(db, id, "afk.closed", r.leader_ign_lower, "by the leader", now);
        beginPop(db, r, "the leader closed the AFK check", now);
        break;
      case "popping":
        return { ok: false, status: 409, error: "The pop window is open: pop your key, extend it, or cancel the raid." };
      case "running":
        endRow(db, r, "leader", now);
        break;
      default:
        return { ok: false, status: 409, error: "That raid has ended." };
    }
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

/** The leader has another key: back to the bazaar, and a new pop window with a watcher. */
export function nextPop(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.leader_user_id !== me.userId) return { ok: false, status: 403, error: "Only the leader can do that." };
    if (r.status !== "running") return { ok: false, status: 409, error: "The next pop can be called once the run is under way." };
    if (r.pops_done >= r.keys) return { ok: false, status: 409, error: `You said you had ${r.keys} key(s), and ${r.pops_done} pop(s) are on record.` };
    beginPop(db, r, `the leader called pop ${r.pops_done + 1} of ${r.keys}`, now);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

/** One more window on the current pop attempt. */
export function extendPop(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.leader_user_id !== me.userId) return { ok: false, status: 403, error: "Only the leader can do that." };
    if (r.status !== "popping" || r.pop_window_ends_at === null) return { ok: false, status: 409, error: "There is no pop window open." };
    if (r.extended >= MAX_POP_EXTENSIONS) return { ok: false, status: 409, error: "The window was already extended once." };
    const ends = Math.max(r.pop_window_ends_at, now) + POP_EXTEND_S * 1000;
    db.prepare("UPDATE raids SET pop_window_ends_at = ?, extended = extended + 1, updated_at = ? WHERE id = ?").run(ends, now, id);
    db.prepare("UPDATE raid_pops SET window_ends_at = ? WHERE raid_id = ? AND verdict = 'pending'").run(ends, id);
    event(db, id, "pop.extended", r.leader_ign_lower, `${POP_EXTEND_S}s`, now);
    orderWatch(db, id, ends + POP_CLOSE_GRACE_MS, now);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

/** During headcount: get the watcher in place early (a server with a login queue). */
export function callWatcher(db: Database.Database, me: { userId: number; ign: string }, id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (r.leader_user_id !== me.userId) return { ok: false, status: 403, error: "Only the leader can do that." };
    if (r.status !== "headcount") return { ok: false, status: 409, error: "The watcher is ordered by itself once the AFK check starts." };
    if (portalTypeOf(r) === null) return { ok: false, status: 409, error: "This key's portal is not known; no watcher can confirm it." };
    if (!hook) return { ok: false, status: 503, error: "No watcher is available right now." };
    if (r.watcher_state !== "none" && r.watcher_state !== "left" && r.watcher_state !== "failed") return { ok: true, raid: getRaid(db, id, me)! };
    event(db, id, "watcher.called", r.leader_ign_lower, "", now);
    orderWatch(db, id, now + EARLY_WATCH_MS, now);
    return { ok: true, raid: getRaid(db, id, me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

/** The leader (or an operator) ends a raid at any stage. */
export function endRaid(db: Database.Database, me: { userId: number; ign: string } | "operator", id: number, now = Date.now()): RaidResult {
  const result = db.transaction((): RaidResult => {
    const r = rowOf(db, id);
    if (!r) return { ok: false, status: 404, error: "That raid is gone." };
    if (me !== "operator" && r.leader_user_id !== me.userId) return { ok: false, status: 403, error: "Only the leader can do that." };
    if (r.status !== "ended") {
      // Cancelling once the AFK check has sent raiders moving is a strike; during headcount it is free, and "End run" is not a cancel.
      if (me !== "operator" && (r.status === "afk" || r.status === "popping")) strike(db, r, "cancelled", now);
      endRow(db, r, me === "operator" ? "operator" : "leader", now);
    }
    return { ok: true, raid: getRaid(db, id, me === "operator" ? null : me)! };
  }).immediate();
  if (result.ok) emitRaids();
  return result;
}

export function deleteRaid(db: Database.Database, id: number): boolean {
  const n = db.prepare("DELETE FROM raids WHERE id = ?").run(id).changes;
  if (n > 0) {
    releaseWatch(id);
    emitRaids();
  }
  return n > 0;
}

/**
 * Time-driven transitions: an AFK check that has run its course opens the
 * pop window; a pop window that closes is resolved; a headcount or run left
 * alone for too long is closed; long-ended raids are deleted. Runs from the
 * scheduler and inline before a listing.
 */
export function sweepRaids(db: Database.Database, now = Date.now()): { afkClosed: number; popResolved: number; timedOut: number; deleted: number } {
  const out = db.transaction(() => {
    let afkClosed = 0;
    for (const r of db.prepare("SELECT * FROM raids WHERE status = 'afk' AND afk_ends_at <= ?").all(now) as RaidRow[]) {
      event(db, r.id, "afk.closed", r.leader_ign_lower, "timer", now);
      beginPop(db, r, "the AFK check ran out", now);
      afkClosed++;
    }
    let popResolved = 0;
    for (const r of db.prepare("SELECT * FROM raids WHERE status = 'popping' AND pop_window_ends_at <= ?").all(now) as RaidRow[]) {
      resolvePopWindow(db, r, now);
      popResolved++;
    }
    let timedOut = 0;
    for (const r of db.prepare("SELECT * FROM raids WHERE (status = 'headcount' AND created_at <= ?) OR (status = 'running' AND updated_at <= ?)").all(now - HEADCOUNT_MAX_MS, now - RUNNING_MAX_MS) as RaidRow[]) {
      endRow(db, r, "timeout", now);
      timedOut++;
    }
    const deleted = db.prepare("DELETE FROM raids WHERE status = 'ended' AND ended_at <= ?").run(now - ENDED_KEEP_MS).changes;
    return { afkClosed, popResolved, timedOut, deleted };
  }).immediate();
  if (out.afkClosed || out.popResolved || out.timedOut || out.deleted) emitRaids();
  return out;
}

// ---------------------------------------------------------------------------
// What the watcher reports (relay/fleet/raidWatch.ts → here, in process).

/** The watcher's progress for the raids it serves. */
export function watcherUpdate(db: Database.Database, u: { raidIds: number[]; state: WatcherState; note: string; bot: string | null }, now = Date.now()): void {
  let changed = false;
  db.transaction(() => {
    for (const id of u.raidIds) {
      const r = rowOf(db, id);
      if (!r || r.status === "ended") continue;
      if (r.watcher_state === u.state && r.watcher_note === u.note && r.watcher_bot === u.bot) continue;
      const stateChanged = r.watcher_state !== u.state;
      db.prepare("UPDATE raids SET watcher_state = ?, watcher_note = ?, watcher_bot = ?, watcher_since = ?, bazaar_count = CASE WHEN ? = 'in_bazaar' THEN bazaar_count ELSE NULL END, leader_in_range = CASE WHEN ? = 'in_bazaar' THEN leader_in_range ELSE NULL END, leader_distance = CASE WHEN ? = 'in_bazaar' THEN leader_distance ELSE NULL END, updated_at = ? WHERE id = ?")
        .run(u.state, u.note, u.bot, stateChanged ? now : r.watcher_since, u.state, u.state, u.state, now, id);
      if (stateChanged) event(db, id, `watcher.${u.state}`, "", u.note, now);
      changed = true;
    }
  }).immediate();
  if (changed) emitRaids();
}

/** Whether the watcher can see the raid's leader (a pop counts only within its view), and how far off they are. */
export function leaderRange(db: Database.Database, u: { raidId: number; inRange: boolean; distance: number | null }, now = Date.now()): void {
  const r = rowOf(db, u.raidId);
  if (!r || r.status === "ended") return;
  const was = r.leader_in_range === null ? null : r.leader_in_range !== 0;
  db.prepare("UPDATE raids SET leader_in_range = ?, leader_distance = ?, updated_at = ? WHERE id = ?").run(u.inRange ? 1 : 0, u.distance, now, u.raidId);
  if (was !== u.inRange) {
    event(db, u.raidId, u.inRange ? "leader.in_range" : "leader.out_of_range", r.leader_ign_lower, u.distance === null ? "not in the watcher's view" : `${u.distance.toFixed(1)} tiles from the watcher`, now);
    emitRaids();
  }
}

/** Who the watcher sees in the bazaar right now: raid members among them are marked present. */
export function rosterSeen(db: Database.Database, u: { raidIds: number[]; names: string[] }, now = Date.now()): void {
  let changed = false;
  const lower = new Map(u.names.map((n) => [n.toLowerCase(), n]));
  db.transaction(() => {
    for (const id of u.raidIds) {
      const r = rowOf(db, id);
      if (!r || r.status === "ended") continue;
      const present = parsePresent(r.present_json);
      let added = 0;
      for (const m of membersOf(db, [id]).get(id) ?? []) {
        const k = m.ign.toLowerCase();
        if (present[k] || !lower.has(k)) continue;
        present[k] = { ign: m.ign, at: now };
        event(db, id, "raid.present", k, r.status, now);
        added++;
      }
      if (!added && r.bazaar_count === u.names.length) continue;
      db.prepare("UPDATE raids SET bazaar_count = ?, present_json = ?, updated_at = ? WHERE id = ?").run(u.names.length, JSON.stringify(present), now, id);
      changed = true;
    }
  }).immediate();
  if (changed) emitRaids();
}

/**
 * A dungeon portal appeared in the watcher's bazaar. For each raid served
 * there whose key opens that portal, the pop confirms the attempt (and cuts
 * an AFK check short) — whoever popped it: the raiders are there for the
 * dungeon, and the record says who opened it.
 */
export function popSeen(db: Database.Database, u: { raidIds: number[]; pop: PopReport }, now = Date.now()): { confirmed: number[]; other: number[] } {
  const confirmed: number[] = [];
  const other: number[] = [];
  db.transaction(() => {
    for (const id of u.raidIds) {
      const r = rowOf(db, id);
      if (!r) continue;
      if (portalTypeOf(r) !== u.pop.portalType) continue;
      // The same portal reported again (its modifiers or owner arrived a tick after the object): fill in what was missing.
      const known = db.prepare("SELECT * FROM raid_pops WHERE raid_id = ? AND portal_object_id = ? ORDER BY n DESC LIMIT 1").get(id, u.pop.portalObjectId) as PopRow | undefined;
      if (known) {
        if ((!known.modifiers && u.pop.modifiers) || (known.opened_at_stamp === null && u.pop.openedAt !== null)) {
          db.prepare("UPDATE raid_pops SET modifiers = COALESCE(NULLIF(modifiers, ''), ?), opened_at_stamp = COALESCE(opened_at_stamp, ?) WHERE id = ?").run(u.pop.modifiers || null, u.pop.openedAt, known.id);
          db.prepare("UPDATE raids SET updated_at = ? WHERE id = ?").run(now, id);
          if (u.pop.modifiers && !known.modifiers) event(db, id, "pop.modifiers", r.leader_ign_lower, `pop ${known.n}: ${u.pop.modifiers}`, now);
          confirmed.push(id);
        }
        continue;
      }
      if (r.status !== "afk" && r.status !== "popping") continue;
      // Who opened it: the server's notice or the portal's owner account when there is one; else whoever stands on
      // the spot — a key portal spawns at the opener's feet — the leader first when they are there.
      const named = u.pop.opener?.name ?? null;
      const leaderBeside = named ? null : u.pop.beside.find((b) => b.name.toLowerCase() === r.leader_ign_lower)?.name ?? null;
      const opener = named ?? leaderBeside ?? u.pop.beside[0]?.name ?? null;
      const isLeader = !!opener && opener.toLowerCase() === r.leader_ign_lower;
      let row = r;
      if (row.status === "afk") {
        event(db, id, "afk.closed", r.leader_ign_lower, `${isLeader ? "the leader" : opener ?? "someone"} popped during the AFK check`, now);
        beginPop(db, row, `${isLeader ? "the leader" : opener ?? "someone"} popped during the AFK check`, now);
        row = rowOf(db, id)!;
      }
      const pending = pendingPop(db, id);
      if (!pending) continue;
      const members = membersOf(db, [id]).get(id) ?? [];
      const rosterLower = new Set(u.pop.roster.map((p) => p.name.toLowerCase()));
      const presentAtPop = members.filter((m) => rosterLower.has(m.ign.toLowerCase())).map((m) => m.ign);
      db.prepare(
        `UPDATE raid_pops SET verdict = 'confirmed', popped_at = ?, opener_ign = ?, opener_account = ?, portal_type = ?, portal_object_id = ?, dungeon = ?, modifiers = ?, opened_at_stamp = ?,
           beside_json = ?, roster_json = ?, present_json = ?, note = ? WHERE id = ?`,
      ).run(
        u.pop.at, opener, u.pop.opener?.accountId ?? u.pop.ownerAccountId ?? "", u.pop.portalType, u.pop.portalObjectId, u.pop.dungeon || pending.dungeon, u.pop.modifiers, u.pop.openedAt,
        JSON.stringify(u.pop.beside), JSON.stringify(u.pop.roster), JSON.stringify(presentAtPop), named ? "" : opener ? "opener by proximity" : "opener unknown", pending.id,
      );
      // Everyone in the bazaar at the pop counts as present, whether or not the roster reports caught them.
      const present = parsePresent(row.present_json);
      for (const m of members) {
        const k = m.ign.toLowerCase();
        if (present[k] || !rosterLower.has(k)) continue;
        present[k] = { ign: m.ign, at: now };
        event(db, id, "raid.present", k, "at the pop", now);
      }
      db.prepare("UPDATE raids SET status = 'running', pop_window_ends_at = NULL, pops_done = pops_done + 1, present_json = ?, bazaar_count = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(present), u.pop.roster.length, now, id);
      event(db, id, "pop.confirmed", r.leader_ign_lower, `pop ${pending.n}: ${u.pop.dungeon} portal #${u.pop.portalObjectId} opened by ${opener ?? "an unknown player"}${isLeader ? "" : " (not the leader)"}${u.pop.modifiers ? ` mods ${u.pop.modifiers}` : ""}${named ? "" : opener ? " (opener by proximity)" : ""}`, now);
      event(db, id, isLeader ? "pop.by_leader" : "pop.by_other", r.leader_ign_lower, `pop ${pending.n}: ${opener ?? "an unknown player"}`, now);
      confirmed.push(id);
    }
  }).immediate();
  if (confirmed.length || other.length) emitRaids();
  return { confirmed, other };
}

/** The portal closed: raid members who vanished from the bazaar while it stood went in. */
export function portalClosed(db: Database.Database, u: { raidIds: number[]; portalObjectId: number; goneNames: string[]; closedAt: number }, now = Date.now()): void {
  let changed = false;
  const gone = new Set(u.goneNames.map((n) => n.toLowerCase()));
  db.transaction(() => {
    for (const id of u.raidIds) {
      const p = db.prepare("SELECT * FROM raid_pops WHERE raid_id = ? AND portal_object_id = ? AND verdict = 'confirmed' AND closed_at IS NULL").get(id, u.portalObjectId) as PopRow | undefined;
      if (!p) continue;
      const members = membersOf(db, [id]).get(id) ?? [];
      const r = rowOf(db, id);
      const entered = members.filter((m) => gone.has(m.ign.toLowerCase())).length;
      // The points (docs/RAIDS.md §7c): raiders who went in earn theirs, and the leader earns a share for each of
      // them. The leader is not a raider of their own raid, so their going in pays nobody.
      const raiders = r ? members.filter((m) => m.user_id !== r.leader_user_id && gone.has(m.ign.toLowerCase())) : [];
      const leaderPoints = Math.round(raiders.length * LEADER_POINTS_PER_RAIDER * 100) / 100;
      db.prepare("UPDATE raid_pops SET closed_at = ?, entered_count = ?, leader_points = ? WHERE id = ?").run(u.closedAt, entered, leaderPoints, p.id);
      db.prepare("UPDATE raids SET updated_at = ? WHERE id = ?").run(now, id);
      event(db, id, "pop.closed", "", `pop ${p.n}: ${entered} raider(s) went in of ${members.length}`, now);
      if (r && raiders.length > 0) {
        const pay = db.prepare("INSERT OR IGNORE INTO raid_rewards (raid_id, pop_id, user_id, ign_lower, ign, role, detail, points, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        pay.run(id, p.id, r.leader_user_id, r.leader_ign_lower, r.leader_ign, "leader", `${p.dungeon}: ${raiders.length} raider${raiders.length === 1 ? "" : "s"} went in`, leaderPoints, now);
        for (const m of raiders) pay.run(id, p.id, m.user_id, m.ign.toLowerCase(), m.ign, "raider", `${p.dungeon}: went in`, RAIDER_POINTS_ENTERED, now);
        event(db, id, "pop.rewards", r.leader_ign_lower, `pop ${p.n}: leader +${leaderPoints} for ${raiders.length} raider${raiders.length === 1 ? "" : "s"}; ${raiders.map((m) => m.ign).join(", ")} +${RAIDER_POINTS_ENTERED} each`, now);
      }
      if (r && r.status === "running") releaseWatch(id);
      changed = true;
    }
  }).immediate();
  if (changed) emitRaids();
}

// ---------------------------------------------------------------------------
// Operator view: every raid with nothing hidden.

export interface RaidAdminView extends Omit<RaidView, "joined" | "leading" | "server" | "location" | "party" | "present"> {
  server: string;
  location: string;
  party: string;
  leaderIgnLower: string;
  present: string[];
  watcherBot: string | null;
}

export function listRaidsAdmin(db: Database.Database): RaidAdminView[] {
  const rows = db.prepare("SELECT * FROM raids ORDER BY created_at DESC, id DESC").all() as RaidRow[];
  const ids = rows.map((r) => r.id);
  const members = membersOf(db, ids);
  const pops = popsOf(db, ids);
  const now = Date.now();
  return rows.map((r) => {
    const v = raidView(r, members.get(r.id) ?? [], pops.get(r.id) ?? [], { userId: r.leader_user_id, ign: r.leader_ign }, leaderRecordFor(db, r.leader_user_id, r.leader_ign_lower, now));
    // `joined`/`leading` mean nothing to an operator; drop them.
    const { joined: _j, leading: _l, present, ...rest } = v;
    return { ...rest, server: r.server, location: r.location, party: r.party, leaderIgnLower: r.leader_ign_lower, present: present ?? [], watcherBot: r.watcher_bot };
  });
}
