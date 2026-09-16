// Realm hunts against an in-memory database: posting picks a server and
// names the party, the hunter's reports land on the hunt, calls are
// recorded, and the sweep and restart paths (docs/REALMHUNTS.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../liveBus", () => ({ emitRealmhunts: vi.fn() }));

import { openDatabase } from "../db";
import { userForIgn } from "../users";
import { emitRealmhunts } from "../liveBus";
import { serverUsage } from "../serverUsage";
import { setServerControl } from "../serverControls";
import { computePlayers } from "../leaderboard";
import {
  CALL_IDLE_MS, callDone, callStarted, createHunt, deleteHunt, endHunt, ENDED_KEEP_MS, getHunt, HUNT_MAX_MS, hunterUpdate, huntPointsFor, isJoinCall, listHuntEvents, listHunts, membersSeen, partyName, pickServer,
  reorderOpenHunts, setRealmHuntHook, sweepHunts, type HuntOrder, type RealmHuntHook,
} from "../realmhunts";

const T0 = 1_800_000_000_000;
let db: Database.Database;
type Me = { userId: number; ign: string; ignLower: string };
function user(ign: string): Me {
  return { userId: userForIgn(db, ign, ign.toLowerCase()), ign, ignLower: ign.toLowerCase() };
}
let me: Me;
let other: Me;
let hook: RealmHuntHook;
let listed: HuntOrder[] = [];

beforeEach(() => {
  db = openDatabase(":memory:");
  me = user("Stockings");
  other = user("Lilith");
  listed = [];
  hook = { order: vi.fn(), release: vi.fn(), list: () => listed.map((o) => ({ huntId: o.huntId, server: o.server, state: "hunting" as const, note: "", bot: "b", since: T0, partyId: 0, members: [], calls: 0, until: o.until })) };
  setRealmHuntHook(hook);
  vi.mocked(emitRealmhunts).mockClear();
});
afterEach(() => {
  setRealmHuntHook(null);
  serverUsage.reset();
  db.close();
});

function post(who = me, input: { dungeonId?: string; region?: string } = {}, now = T0) {
  const r = createHunt(db, who, { dungeonId: "moonlight-village-key", region: "US", ...input }, now);
  if (!r.ok) throw new Error(r.error);
  return r.hunt;
}

describe("join calls", () => {
  it("are j or join, alone or followed by words, in any case", () => {
    for (const t of ["j", "J", " j ", "join", "JOIN", "j lb", "join me at the top", "j\tnow"]) expect(isJoinCall(t), t).toBe(true);
    for (const t of ["jk", "joined", "joke", "jjj", "hey j", "adjoin", "", "  ", "ok join"]) expect(isJoinCall(t), t).toBe(false);
  });
});

describe("posting", () => {
  it("validates the dungeon and the region, names the party after both, sizes it to the dungeon, picks a server in the region and orders a hunter", () => {
    expect(createHunt(db, me, { dungeonId: "nope", region: "US" })).toMatchObject({ ok: false, status: 400 });
    expect(createHunt(db, me, { dungeonId: "moonlight-village-key", region: "Mars" })).toMatchObject({ ok: false, status: 400 });
    const h = post();
    expect(h).toMatchObject({ dungeonId: "moonlight-village-key", region: "US", requester: "Stockings", status: "open", partyName: "realmhunt Moonlight Village US", limit: 50, requesting: true, members: [], calls: [] });
    expect(h.server.startsWith("US")).toBe(true);
    expect(h.hunter).toMatchObject({ state: "ordered", bot: null });
    expect(hook.order).toHaveBeenCalledWith(expect.objectContaining({ huntId: h.id, server: h.server, dungeon: "Moonlight Village", partyName: "realmhunt Moonlight Village US", maxPartySize: 50, region: "US", until: T0 + HUNT_MAX_MS }));
    expect(partyName("Lost Halls", "EU")).toBe("realmhunt Lost Halls EU");
    expect(emitRealmhunts).toHaveBeenCalled();
    expect(listHuntEvents(db, h.id).map((e) => e.event)).toEqual(["hunt.created"]);
  });
  it("refuses a second open hunt per requester, and a second open hunt for the same dungeon in the same region; another dungeon there is fine", () => {
    const h = post();
    expect(createHunt(db, me, { dungeonId: "lost-halls-key", region: "EU" })).toMatchObject({ ok: false, status: 409 });
    expect(createHunt(db, other, { dungeonId: "moonlight-village-key", region: "US" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("Stockings already has a Moonlight Village hunt open in US") });
    const third = user("Zephyr");
    expect(createHunt(db, third, { dungeonId: "lost-halls-key", region: "US" }, T0 + 500).ok).toBe(true);
    // The index behind the rule: a row slipped past the check still cannot exist.
    expect(() => db.prepare("INSERT INTO realmhunts (dungeon_id, region, requester_user_id, requester_ign, requester_ign_lower, status, server, party_name, created_at, updated_at) VALUES ('moonlight-village-key', 'US', ?, 'X', 'x', 'open', 'USWest3', 'p', 1, 1)").run(other.userId)).toThrow(/UNIQUE/);
    const eu = createHunt(db, other, { dungeonId: "moonlight-village-key", region: "EU" }, T0 + 1000);
    expect(eu.ok && eu.hunt.server.startsWith("EU")).toBe(true);
    // Newest first.
    expect(listHunts(db, null, T0 + 2000).map((x) => [x.id, x.requesting])).toEqual([[eu.ok ? eu.hunt.id : 0, false], [h.id + 1, false], [h.id, false]]);
    expect(listHunts(db, other, T0 + 2000).map((x) => x.requesting)).toEqual([true, false, false]);
  });
  it("picks the quietest server the readings allow, skipping busy and switched-off ones, and refuses a region with none open", () => {
    // Under the default load limit (SERVER_USAGE_MAX 0) any reported load is busy: USWest4 is out, USWest3 and USSouth3 tie at 0 and the list order breaks it.
    serverUsage.set([{ name: "USWest4", usage: 0.3 }, { name: "USWest3", usage: 0 }, { name: "USSouth3", usage: 0 }, { name: "EUWest", usage: 0.9 }], T0);
    expect(pickServer(db, "US", T0)).toBe("USWest3");
    setServerControl(db, "USWest3", false, true);
    expect(pickServer(db, "US", T0)).toBe("USSouth3");
    expect(pickServer(db, "Asia", T0)).toBeNull();
    serverUsage.reset();
    // No fresh reading: the region's first listed server.
    expect(pickServer(db, "EU", T0)).toBe("EUWest2");
  });
  it("without a fleet hook the hunt is posted with no bot", () => {
    setRealmHuntHook(null);
    const h = post();
    expect(h.hunter).toMatchObject({ state: "none", note: expect.stringContaining("no fleet") });
  });
});

describe("the hunter's reports", () => {
  it("land on the hunt: state, party, members, calls; a failed hunter ends the hunt", () => {
    const h = post();
    hunterUpdate(db, { huntId: h.id, state: "logging_in", note: "bot7 on USWest3", bot: "bot7", server: "USWest3", partyId: 0 }, T0 + 1000);
    hunterUpdate(db, { huntId: h.id, state: "hunting", note: "in", bot: "bot7", server: "USWest3", partyId: 9871 }, T0 + 60_000);
    membersSeen(db, { huntId: h.id, members: ["Stockings", "Aki"] }, T0 + 61_000);
    let v = getHunt(db, h.id, me)!;
    expect(v).toMatchObject({ server: "USWest3", partyId: 9871, members: ["Stockings", "Aki"], hunter: { state: "hunting", note: "in", bot: "bot7", since: T0 + 60_000 } });
    const callId = callStarted(db, { huntId: h.id, caller: "Aki,c84c", at: T0 + 90_000 });
    expect(callId).toBeGreaterThan(0);
    expect(getHunt(db, h.id, null)!.calls).toEqual([{ id: callId, caller: "Aki", at: T0 + 90_000, entered: null, partyEntered: null, outcome: null, note: "", doneAt: null, finderPoints: 0 }]);
    // Aki (a site user, the caller) found it; Lilith (site user) and Bob (no account) are party members who came; Dee is a stranger.
    user("Aki");
    // Names come off the wire with style tags ("Lilith,fe14"): paid to the bare account.
    callDone(db, { huntId: h.id, callId, outcome: "counted", names: ["Aki,a19d", "Lilith,fe14", "Bob", "Dee"], partyMembers: ["Bot", "Aki", "Lilith,fe14", "Bob"], note: "", at: T0 + 130_000 });
    v = getHunt(db, h.id, null)!;
    expect(v.calls[0]).toMatchObject({ outcome: "counted", entered: 4, partyEntered: 3, doneAt: T0 + 130_000, finderPoints: 0.2 });
    expect(huntPointsFor(db, "aki")).toBe(0.2);
    expect(huntPointsFor(db, "lilith")).toBe(0.1);
    expect(huntPointsFor(db, "bob")).toBe(0);
    expect(computePlayers(db).find((p) => p.ignLower === "aki")).toMatchObject({ points: 0.2, raidPoints: 0.2 });
    expect(computePlayers(db).find((p) => p.ignLower === "lilith")).toMatchObject({ points: 0.1 });
    // A call for a hunt that is gone is ignored; a done for an unknown call changes nothing; a call into another dungeon pays nothing.
    expect(callStarted(db, { huntId: 999, caller: "X", at: T0 })).toBe(0);
    callDone(db, { huntId: h.id, callId: 12345, outcome: "failed", names: null, partyMembers: [], note: "", at: T0 });
    expect(getHunt(db, h.id, null)!.calls).toHaveLength(1);
    const other = callStarted(db, { huntId: h.id, caller: "Aki", at: T0 + 140_000 });
    callDone(db, { huntId: h.id, callId: other, outcome: "other_dungeon", names: ["Aki", "Lilith"], partyMembers: ["Bot", "Aki", "Lilith"], note: "", at: T0 + 150_000 });
    expect(getHunt(db, h.id, null)!.calls[1]).toMatchObject({ outcome: "other_dungeon", entered: 2, partyEntered: 2, finderPoints: 0 });
    expect(huntPointsFor(db, "aki")).toBe(0.2);
    hunterUpdate(db, { huntId: h.id, state: "failed", note: "no free account to send", bot: "bot7", server: "USWest3", partyId: 9871 }, T0 + 200_000);
    v = getHunt(db, h.id, null)!;
    expect(v).toMatchObject({ status: "ended", endedBy: "hunter", hunter: { state: "failed" } });
    expect(hook.release).toHaveBeenCalledWith(h.id);
    expect(listHuntEvents(db, h.id).map((e) => e.event)).toEqual(["hunt.created", "hunter.logging_in", "hunter.hunting", "call.heard", "call.counted", "call.rewards", "call.heard", "call.other_dungeon", "hunter.failed", "hunt.ended"]);
  });
});

describe("ending, sweeping, restarting", () => {
  it("only an operator ends a hunt by hand, which releases the hunter; it stays listed for an hour", () => {
    const h = post();
    expect(endHunt(db, "operator", h.id, T0 + 1000)).toMatchObject({ ok: true, hunt: { status: "ended", endedBy: "operator" } });
    expect(hook.release).toHaveBeenCalledWith(h.id);
    expect(endHunt(db, "operator", h.id, T0 + 2000)).toMatchObject({ ok: true });
    expect(listHunts(db, null, T0 + 30 * 60_000)).toHaveLength(1);
    expect(listHunts(db, null, T0 + 2 * 60 * 60_000)).toHaveLength(0);
    expect(endHunt(db, "operator", 999)).toMatchObject({ ok: false, status: 404 });
    // The requester can post again once theirs has ended.
    expect(createHunt(db, me, { dungeonId: "moonlight-village-key", region: "US" }, T0 + 3000).ok).toBe(true);
  });
  it("the hunter's 'done' (its 20-minute clock ran out) ends the hunt as idle; a hunt with no bot is ended idle by the sweep on the same clock; one with a bot is left to it", () => {
    const h = post();
    membersSeen(db, { huntId: h.id, members: ["Bot", "Aki"] }, T0 + 1000);
    membersSeen(db, { huntId: h.id, members: ["Bot"] }, T0 + 2000);
    expect(getHunt(db, h.id, null)!.members).toEqual(["Bot", "Aki"]); // everyone ever in it stays listed
    hunterUpdate(db, { huntId: h.id, state: "hunting", note: "", bot: "bot7", server: h.server, partyId: 5 }, T0 + 2500);
    expect(sweepHunts(db, T0 + CALL_IDLE_MS + 1)).toEqual({ timedOut: 0, deleted: 0 }); // the hunter keeps that clock
    hunterUpdate(db, { huntId: h.id, state: "done", note: "no call for 20 minutes", bot: "bot7", server: h.server, partyId: 5 }, T0 + 3000);
    expect(getHunt(db, h.id, null)).toMatchObject({ status: "ended", endedBy: "idle", hunter: { state: "done" } });
    expect(hook.release).toHaveBeenCalledWith(h.id);
    setRealmHuntHook(null);
    const botless = post(other, { region: "EU" }, T0 + 4000);
    expect(getHunt(db, botless.id, null)!.hunter.state).toBe("none");
    expect(sweepHunts(db, T0 + 4000 + CALL_IDLE_MS - 1)).toEqual({ timedOut: 0, deleted: 0 });
    expect(sweepHunts(db, T0 + 4000 + CALL_IDLE_MS)).toEqual({ timedOut: 1, deleted: 0 });
    expect(getHunt(db, botless.id, null)).toMatchObject({ status: "ended", endedBy: "idle" });
  });
  it("the sweep ends any hunt at the ceiling, then deletes it a day after it ended; delete removes one outright", () => {
    const h = post();
    hunterUpdate(db, { huntId: h.id, state: "hunting", note: "", bot: "bot7", server: h.server, partyId: 5 }, T0 + 1000);
    expect(sweepHunts(db, T0 + HUNT_MAX_MS - 1)).toEqual({ timedOut: 0, deleted: 0 });
    expect(sweepHunts(db, T0 + HUNT_MAX_MS)).toEqual({ timedOut: 1, deleted: 0 });
    expect(getHunt(db, h.id, null)).toMatchObject({ status: "ended", endedBy: "timeout" });
    expect(hook.release).toHaveBeenCalledWith(h.id);
    expect(sweepHunts(db, T0 + HUNT_MAX_MS + ENDED_KEEP_MS)).toEqual({ timedOut: 0, deleted: 1 });
    expect(getHunt(db, h.id, null)).toBeNull();
    const h2 = post(other, { region: "EU" }, T0 + HUNT_MAX_MS + ENDED_KEEP_MS);
    expect(deleteHunt(db, h2.id)).toBe(true);
    expect(getHunt(db, h2.id, null)).toBeNull();
    expect(deleteHunt(db, h2.id)).toBe(false);
  });
  it("after a restart every open hunt the fleet does not list is ordered again", () => {
    const a = post();
    const b = post(other, { region: "EU" });
    hunterUpdate(db, { huntId: a.id, state: "hunting", note: "", bot: "bot7", server: a.server, partyId: 1 }, T0 + 1000);
    vi.mocked(hook.order).mockClear();
    listed = [{ huntId: b.id, server: b.server, dungeonId: "x", dungeon: "x", portalType: null, region: "EU", partyName: "", maxPartySize: 1, until: T0 + HUNT_MAX_MS }];
    expect(reorderOpenHunts(db, T0 + 5000)).toBe(1);
    expect(hook.order).toHaveBeenCalledTimes(1);
    expect(hook.order).toHaveBeenCalledWith(expect.objectContaining({ huntId: a.id }));
    expect(getHunt(db, a.id, null)!.hunter).toMatchObject({ state: "ordered", bot: null });
  });
});
