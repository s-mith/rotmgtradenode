// Realm hunting: a request for a dungeon in a region, served by a fleet bot
// (docs/REALMHUNTS.md). The requester posts (dungeon, region); the site
// picks a quiet server in that region and orders a hunter through the hook
// the fleet registers (setRealmHuntHook; relay/fleet/realmHunt.ts). The
// hunter logs in there, stays in the Nexus, opens the in-game party named
// after the hunt (party size = the dungeon's player limit), and reports
// back through hunterUpdate, membersSeen, callStarted and callDone below:
// every "j" heard in party chat becomes a call row with what the hunter
// counted after teleporting to the caller. Nothing here is secret: the
// server and the party name are what hunters need to find the bot.
import type Database from "better-sqlite3";
import { RAID_DUNGEONS, type RaidDungeon } from "./raidDungeons";
import { WITHDRAW_SERVERS } from "./servers";
import { isWithdrawsDisabled } from "./serverControls";
import { emitRealmhunts } from "./liveBus";
import { serverUsage } from "./serverUsage";
import { regionOf } from "./raidRules";
import {
  bareName, CALL_IDLE_MS, ENDED_KEEP_MS, ENDED_LISTED_MS, FINDER_POINTS_PER_HUNTER, HUNT_MAX_MS, HUNTER_POINTS_ENTERED, partyName, REGIONS,
  type CallOutcome, type EndedBy, type HuntCallView, type HunterState, type HuntOrder, type HuntStatus, type HuntView, type RealmHuntHook,
} from "./realmhuntRules";
export * from "./realmhuntRules";

type HuntRow = {
  id: number; dungeon_id: string; region: string; requester_user_id: number; requester_ign: string; requester_ign_lower: string;
  status: HuntStatus; server: string; party_name: string; party_id: number;
  hunter_state: HunterState; hunter_note: string; hunter_bot: string | null; hunter_since: number | null; members_json: string;
  created_at: number; updated_at: number; ended_at: number | null; ended_by: EndedBy | null;
};
type CallRow = { id: number; hunt_id: number; caller_ign: string; caller_ign_lower: string; at: number; entered: number | null; party_entered: number | null; outcome: CallOutcome | null; note: string; done_at: number | null; finder_points: number; entered_json: string };

export type Viewer = { userId: number; ign: string } | null;
export type HuntResult = { ok: true; hunt: HuntView } | { ok: false; status: number; error: string };

export function dungeonFor(id: string): RaidDungeon | null {
  return RAID_DUNGEONS.find((d) => d.id === id) ?? null;
}

// One open hunt per dungeon and region: its hunters gather in one party
// (migration 15 keeps a unique partial index on it).
//
// The fleet's hook: null when no fleet runs in this process (hunts then sit
// with "no hunter" until one is attached; docs/REALMHUNTS.md §4).
let hook: RealmHuntHook | null = null;
export function setRealmHuntHook(h: RealmHuntHook | null): void {
  hook = h;
}
export function realmHuntHook(): RealmHuntHook | null {
  return hook;
}

function event(db: Database.Database, huntId: number, ev: string, ignLower: string, detail: string, at: number): void {
  db.prepare("INSERT INTO realmhunt_events (hunt_id, event, ign_lower, detail, at) VALUES (?, ?, ?, ?, ?)").run(huntId, ev, ignLower, detail, at);
}
export interface HuntEvent { id: number; huntId: number; event: string; ignLower: string; detail: string; at: number }
export function listHuntEvents(db: Database.Database, huntId: number, limit = 300): HuntEvent[] {
  return (db.prepare("SELECT id, hunt_id, event, ign_lower, detail, at FROM realmhunt_events WHERE hunt_id = ? ORDER BY id LIMIT ?").all(huntId, limit) as { id: number; hunt_id: number; event: string; ign_lower: string; detail: string; at: number }[])
    .map((r) => ({ id: r.id, huntId: r.hunt_id, event: r.event, ignLower: r.ign_lower, detail: r.detail, at: r.at }));
}

function parseMembers(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Views

function callView(c: CallRow): HuntCallView {
  return { id: c.id, caller: c.caller_ign, at: c.at, entered: c.entered, partyEntered: c.party_entered, outcome: c.outcome, note: c.note, doneAt: c.done_at, finderPoints: c.finder_points };
}
function huntView(r: HuntRow, calls: CallRow[], viewer: Viewer): HuntView {
  return {
    id: r.id, dungeonId: r.dungeon_id, region: r.region, requester: r.requester_ign, status: r.status, endedBy: r.ended_by,
    server: r.server, partyName: r.party_name, partyId: r.party_id, members: parseMembers(r.members_json),
    hunter: { state: r.hunter_state, note: r.hunter_note, bot: r.hunter_bot, since: r.hunter_since },
    calls: calls.map(callView), createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at,
    limit: dungeonFor(r.dungeon_id)?.limit ?? 50, requesting: viewer !== null && viewer.userId === r.requester_user_id,
  };
}
function callsFor(db: Database.Database, huntIds: number[]): Map<number, CallRow[]> {
  const out = new Map<number, CallRow[]>();
  if (!huntIds.length) return out;
  const rows = db.prepare(`SELECT * FROM realmhunt_calls WHERE hunt_id IN (${huntIds.map(() => "?").join(",")}) ORDER BY id`).all(...huntIds) as CallRow[];
  for (const c of rows) {
    const list = out.get(c.hunt_id) ?? [];
    list.push(c);
    out.set(c.hunt_id, list);
  }
  return out;
}

/** Open hunts first (newest first), then those ended within the hour. */
export function listHunts(db: Database.Database, viewer: Viewer, now = Date.now()): HuntView[] {
  const rows = db.prepare("SELECT * FROM realmhunts WHERE status <> 'ended' OR ended_at > ? ORDER BY (status = 'ended'), created_at DESC").all(now - ENDED_LISTED_MS) as HuntRow[];
  const calls = callsFor(db, rows.map((r) => r.id));
  return rows.map((r) => huntView(r, calls.get(r.id) ?? [], viewer));
}
export function getHunt(db: Database.Database, id: number, viewer: Viewer): HuntView | null {
  const r = db.prepare("SELECT * FROM realmhunts WHERE id = ?").get(id) as HuntRow | undefined;
  if (!r) return null;
  return huntView(r, callsFor(db, [id]).get(id) ?? [], viewer);
}

// ---------------------------------------------------------------------------
// Posting and ending

/**
 * The server a hunt in `region` goes to: the same qualifiers as a withdraw
 * (the operator's per-server switch, then Realm's load reading), quietest
 * first; with no fresh reading, the region's first listed server.
 */
export function pickServer(db: Database.Database, region: string, now = Date.now()): string | null {
  const candidates = WITHDRAW_SERVERS.filter((s) => regionOf(s) === region && !isWithdrawsDisabled(db, s));
  if (!candidates.length) return null;
  const usage = (s: string) => serverUsage.reading(s, now)?.usage ?? 0.5;
  const quiet = candidates.filter((s) => !serverUsage.busy(s, now)).sort((a, b) => usage(a) - usage(b) || candidates.indexOf(a) - candidates.indexOf(b));
  return quiet[0] ?? null;
}

function orderFor(r: HuntRow, dungeon: RaidDungeon): HuntOrder {
  return {
    huntId: r.id, server: r.server, dungeonId: r.dungeon_id, dungeon: dungeon.dungeon, portalType: dungeon.portalType, region: r.region,
    partyName: r.party_name, maxPartySize: dungeon.limit, until: r.created_at + HUNT_MAX_MS,
  };
}
function orderHunter(db: Database.Database, r: HuntRow, now: number): void {
  const dungeon = dungeonFor(r.dungeon_id);
  if (!dungeon) return;
  if (!hook) {
    db.prepare("UPDATE realmhunts SET hunter_state = 'none', hunter_note = ?, updated_at = ? WHERE id = ?").run("no fleet is attached; the hunt has no bot", now, r.id);
    return;
  }
  hook.order(orderFor(r, dungeon));
  db.prepare("UPDATE realmhunts SET hunter_state = 'ordered', hunter_note = '', hunter_since = ?, updated_at = ? WHERE id = ? AND hunter_state IN ('none', 'left', 'failed')").run(now, now, r.id);
}

export interface CreateInput {
  dungeonId: unknown;
  region: unknown;
}

export function createHunt(db: Database.Database, me: { userId: number; ign: string; ignLower: string }, input: CreateInput, now = Date.now()): HuntResult {
  const dungeon = typeof input.dungeonId === "string" ? dungeonFor(input.dungeonId) : null;
  if (!dungeon) return { ok: false, status: 400, error: "Pick a dungeon." };
  const region = typeof input.region === "string" ? input.region : "";
  if (!REGIONS.includes(region)) return { ok: false, status: 400, error: "Pick a region." };
  const server = pickServer(db, region, now);
  if (!server) return { ok: false, status: 409, error: `No ${region} server is open for a hunt right now (they are all switched off or full).` };

  const result = db.transaction((): HuntResult => {
    const mine = db.prepare("SELECT id FROM realmhunts WHERE requester_user_id = ? AND status <> 'ended' LIMIT 1").get(me.userId) as { id: number } | undefined;
    if (mine) return { ok: false, status: 409, error: "You already have an open hunt. It closes on its own once its party goes quiet for 20 minutes." };
    // One party per dungeon and region at a time (a unique partial index backs this up against a race); other dungeons in the region are fine.
    const same = db.prepare("SELECT id, requester_ign FROM realmhunts WHERE dungeon_id = ? AND region = ? AND status <> 'ended' LIMIT 1").get(dungeon.id, region) as { id: number; requester_ign: string } | undefined;
    if (same) return { ok: false, status: 409, error: `${same.requester_ign} already has a ${dungeon.dungeon} hunt open in ${region}. Join its party instead.` };
    const name = partyName(dungeon.dungeon, region);
    const id = Number(
      db.prepare(
        `INSERT INTO realmhunts (dungeon_id, region, requester_user_id, requester_ign, requester_ign_lower, status, server, party_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(dungeon.id, region, me.userId, me.ign, me.ignLower, server, name, now, now).lastInsertRowid,
    );
    event(db, id, "hunt.created", me.ignLower, `${dungeon.dungeon} in ${region} → ${server}; party "${name}" (${dungeon.limit})`, now);
    const row = db.prepare("SELECT * FROM realmhunts WHERE id = ?").get(id) as HuntRow;
    orderHunter(db, row, now);
    return { ok: true, hunt: getHunt(db, id, me)! };
  }).immediate();
  if (result.ok) emitRealmhunts();
  return result;
}

/** An operator's close (the dev console). A hunt otherwise closes on its own: the hunter's idle clock, the ceiling, a failed hunter. Nobody else, the requester included, can close one. */
export function endHunt(db: Database.Database, me: "operator", id: number, now = Date.now()): HuntResult {
  const result = db.transaction((): HuntResult => {
    const r = db.prepare("SELECT * FROM realmhunts WHERE id = ?").get(id) as HuntRow | undefined;
    if (!r) return { ok: false, status: 404, error: "That hunt is gone." };
    if (r.status === "ended") return { ok: true, hunt: getHunt(db, id, null)! };
    void me;
    close(db, r, "operator", now);
    return { ok: true, hunt: getHunt(db, id, null)! };
  }).immediate();
  if (result.ok) emitRealmhunts();
  return result;
}

function close(db: Database.Database, r: HuntRow, by: EndedBy, now: number): void {
  db.prepare("UPDATE realmhunts SET status = 'ended', ended_at = ?, ended_by = ?, updated_at = ? WHERE id = ?").run(now, by, now, r.id);
  event(db, r.id, "hunt.ended", "", by, now);
  hook?.release(r.id);
}

export function deleteHunt(db: Database.Database, id: number): boolean {
  const r = db.prepare("SELECT * FROM realmhunts WHERE id = ?").get(id) as HuntRow | undefined;
  if (!r) return false;
  hook?.release(id);
  db.prepare("DELETE FROM realmhunt_calls WHERE hunt_id = ?").run(id);
  db.prepare("DELETE FROM realmhunts WHERE id = ?").run(id);
  event(db, id, "hunt.deleted", "", "operator", Date.now());
  emitRealmhunts();
  return true;
}

/** Time-driven closes: any hunt ends at the HUNT_MAX_MS ceiling; a hunt with no bot ends idle after CALL_IDLE_MS (a hunter applies that clock itself); ended hunts older than a day are deleted. */
export function sweepHunts(db: Database.Database, now = Date.now()): { timedOut: number; deleted: number } {
  let timedOut = 0;
  const stale = db.prepare("SELECT * FROM realmhunts WHERE status <> 'ended' AND (created_at <= ? OR (created_at <= ? AND hunter_state = 'none'))").all(now - HUNT_MAX_MS, now - CALL_IDLE_MS) as HuntRow[];
  for (const r of stale) {
    close(db, r, r.created_at <= now - HUNT_MAX_MS ? "timeout" : "idle", now);
    timedOut++;
  }
  const old = db.prepare("SELECT id FROM realmhunts WHERE status = 'ended' AND ended_at <= ?").all(now - ENDED_KEEP_MS) as { id: number }[];
  for (const { id } of old) {
    db.prepare("DELETE FROM realmhunt_calls WHERE hunt_id = ?").run(id);
    db.prepare("DELETE FROM realmhunts WHERE id = ?").run(id);
  }
  if (timedOut || old.length) emitRealmhunts();
  return { timedOut, deleted: old.length };
}

/**
 * After a restart the fleet has no orders: every open hunt is ordered again
 * (called once when the hook is attached). A hunt whose hunter had already
 * failed is not: it ended when the hunter failed.
 */
export function reorderOpenHunts(db: Database.Database, now = Date.now()): number {
  if (!hook) return 0;
  const listed = new Set(hook.list().map((h) => h.huntId));
  const open = db.prepare("SELECT * FROM realmhunts WHERE status <> 'ended'").all() as HuntRow[];
  let n = 0;
  for (const r of open) {
    if (listed.has(r.id)) continue;
    db.prepare("UPDATE realmhunts SET hunter_state = 'none', hunter_note = '', hunter_bot = NULL, updated_at = ? WHERE id = ?").run(now, r.id);
    orderHunter(db, r, now);
    n++;
  }
  if (n) emitRealmhunts();
  return n;
}

// ---------------------------------------------------------------------------
// What the hunter reports (relay/fleet/realmHunt.ts → here, in process).

export function hunterUpdate(db: Database.Database, u: { huntId: number; state: HunterState; note: string; bot: string | null; server: string; partyId: number }, now = Date.now()): void {
  const r = db.prepare("SELECT * FROM realmhunts WHERE id = ?").get(u.huntId) as HuntRow | undefined;
  if (!r) return;
  const since = r.hunter_state === u.state ? r.hunter_since : now;
  db.prepare("UPDATE realmhunts SET hunter_state = ?, hunter_note = ?, hunter_bot = ?, hunter_since = ?, server = ?, party_id = ?, updated_at = ? WHERE id = ?")
    .run(u.state, u.note, u.bot, since, u.server || r.server, u.partyId, now, u.huntId);
  if (r.hunter_state !== u.state || r.party_id !== u.partyId) event(db, u.huntId, `hunter.${u.state}`, "", [u.bot ?? "", u.partyId ? `party ${u.partyId}` : "", u.note].filter(Boolean).join(" · "), now);
  // A hunter that gave up ends the hunt (the requester sees why and can post again); one that waited out the idle clock ends it too.
  if (r.status !== "ended") {
    if (u.state === "failed") close(db, { ...r, hunter_state: u.state }, "hunter", now);
    else if (u.state === "done") close(db, { ...r, hunter_state: u.state }, "idle", now);
  }
  emitRealmhunts();
}

export function membersSeen(db: Database.Database, u: { huntId: number; members: string[] }, now = Date.now()): void {
  const r = db.prepare("SELECT members_json FROM realmhunts WHERE id = ?").get(u.huntId) as { members_json: string } | undefined;
  if (!r) return;
  // Everyone who was ever in the party stays listed.
  const known = parseMembers(r.members_json);
  const lower = new Set(known.map((m) => m.toLowerCase()));
  const merged = [...known, ...u.members.map(bareName).filter((m) => m && !lower.has(m.toLowerCase()))];
  const json = JSON.stringify(merged);
  if (json === r.members_json) return;
  db.prepare("UPDATE realmhunts SET members_json = ?, updated_at = ? WHERE id = ?").run(json, now, u.huntId);
  emitRealmhunts();
}

export function callStarted(db: Database.Database, u: { huntId: number; caller: string; at: number }): number {
  const r = db.prepare("SELECT id FROM realmhunts WHERE id = ?").get(u.huntId) as { id: number } | undefined;
  if (!r) return 0;
  const caller = bareName(u.caller);
  const id = Number(db.prepare("INSERT INTO realmhunt_calls (hunt_id, caller_ign, caller_ign_lower, at) VALUES (?, ?, ?, ?)").run(u.huntId, caller, caller.toLowerCase(), u.at).lastInsertRowid);
  event(db, u.huntId, "call.heard", caller.toLowerCase(), "", u.at);
  emitRealmhunts();
  return id;
}

/** A site account for an in-game name, or null: hunt points go only to names the site knows. */
function accountFor(db: Database.Database, name: string): { userId: number; ign: string; ignLower: string } | null {
  name = bareName(name);
  const ignLower = name.toLowerCase();
  const row = db.prepare("SELECT user_id, ign FROM user_igns WHERE ign_lower = ?").get(ignLower) as { user_id: number; ign: string } | undefined;
  return row ? { userId: row.user_id, ign: row.ign || name, ignLower } : null;
}

export function callDone(db: Database.Database, u: { huntId: number; callId: number; outcome: CallOutcome; names: string[] | null; partyMembers: string[]; note: string; at: number }): void {
  const call = db.prepare("SELECT * FROM realmhunt_calls WHERE id = ? AND hunt_id = ?").get(u.callId, u.huntId) as CallRow | undefined;
  if (!call) return;
  const hunt = db.prepare("SELECT dungeon_id FROM realmhunts WHERE id = ?").get(u.huntId) as { dungeon_id: string } | undefined;
  const dungeon = hunt ? dungeonFor(hunt.dungeon_id)?.dungeon ?? hunt.dungeon_id : "";
  const party = new Set(u.partyMembers.map((m) => bareName(m).toLowerCase()));
  const seen = u.names === null ? null : [...new Map(u.names.map(bareName).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
  const entered = seen === null ? null : seen.length;
  const partyIn = seen === null ? [] : seen.filter((n) => party.has(n.toLowerCase()));
  // The points: party members seen in the hunted dungeon (the caller excluded) earn theirs, the caller a share per member.
  const hunters = u.outcome === "counted" ? partyIn.filter((n) => n.toLowerCase() !== call.caller_ign_lower) : [];
  const finderPoints = Math.round(hunters.length * FINDER_POINTS_PER_HUNTER * 100) / 100;
  db.transaction(() => {
    db.prepare("UPDATE realmhunt_calls SET outcome = ?, entered = ?, party_entered = ?, note = ?, done_at = ?, finder_points = ?, entered_json = ? WHERE id = ?")
      .run(u.outcome, entered, seen === null ? null : partyIn.length, u.note, u.at, finderPoints, JSON.stringify(seen ?? []), u.callId);
    event(db, u.huntId, `call.${u.outcome}`, call.caller_ign_lower, [entered === null ? "" : `${entered} entered (${partyIn.length} from the party)`, u.note].filter(Boolean).join(" · "), u.at);
    if (hunters.length > 0) {
      const pay = db.prepare("INSERT OR IGNORE INTO realmhunt_rewards (hunt_id, call_id, user_id, ign_lower, ign, role, detail, points, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const paid: string[] = [];
      const finder = accountFor(db, call.caller_ign);
      if (finder) {
        pay.run(u.huntId, u.callId, finder.userId, finder.ignLower, finder.ign, "finder", `${dungeon}: ${hunters.length} hunter${hunters.length === 1 ? "" : "s"} joined`, finderPoints, u.at);
        paid.push(`${finder.ign} +${finderPoints}`);
      }
      for (const n of hunters) {
        const acc = accountFor(db, n);
        if (!acc) continue;
        pay.run(u.huntId, u.callId, acc.userId, acc.ignLower, acc.ign, "hunter", `${dungeon}: joined ${call.caller_ign}'s find`, HUNTER_POINTS_ENTERED, u.at);
        paid.push(`${acc.ign} +${HUNTER_POINTS_ENTERED}`);
      }
      event(db, u.huntId, "call.rewards", call.caller_ign_lower, paid.length ? paid.join(", ") : `nobody with a site account (${[call.caller_ign, ...hunters].join(", ")})`, u.at);
    }
  }).immediate();
  emitRealmhunts();
}

/** Points earned from hunts, as finder and as hunter (realmhunt_rewards). */
export function huntPointsFor(db: Database.Database, ignLower: string): number {
  const p = (db.prepare("SELECT COALESCE(SUM(points), 0) AS p FROM realmhunt_rewards WHERE ign_lower = ?").get(ignLower) as { p: number }).p;
  return Math.round(p * 100) / 100;
}
