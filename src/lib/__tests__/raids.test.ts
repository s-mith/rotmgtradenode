// Raids against an in-memory database: who may see what at each stage, the
// leader's controls, the limits, the time-driven sweep, and what the
// watcher's reports do to a raid (docs/RAIDS.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../liveBus", () => ({ emitRaids: vi.fn() }));

import { openDatabase } from "../db";
import { userForIgn } from "../users";
import { emitRaids } from "../liveBus";
import { serverUsage } from "../serverUsage";
import { setServerControl } from "../serverControls";
import { computePlayers } from "../leaderboard";
import {
  advanceRaid, AFK_SECONDS, banRaider, callWatcher, createRaid, EARLY_WATCH_MS, ENDED_KEEP_MS, ENDED_LISTED_MS, endRaid, extendPop, getRaid, HEADCOUNT_MAX_MS, joinRaid, leaveRaid, listRaidEvents, listRaids, listRaidsAdmin,
  clearStrikes, leaderRange, listStrikes, nextPop, POP_CLOSE_GRACE_MS, POP_EXTEND_S, POP_WINDOW_S, popSeen, portalClosed, postingHold, raidHistoryFor, rosterSeen, RUNNING_MAX_MS, setRaidWatchHook, STRIKE_DECAY_MS, sweepRaids, unbanRaider, watcherUpdate, type PopReport, type RaidWatchHook,
} from "../raids";

const T0 = 1_800_000_000_000;
const LH_PORTAL = 0xb024;
let db: Database.Database;
type Me = { userId: number; ign: string; ignLower: string };
function user(ign: string): Me {
  return { userId: userForIgn(db, ign, ign.toLowerCase()), ign, ignLower: ign.toLowerCase() };
}
let leader: Me;
let raider: Me;
let hook: RaidWatchHook;
const input = { dungeonId: "lost-halls-key", server: "USSouth3", location: "Left bazaar", party: "stockhalls", description: "Full clear", keys: 2 };

function post(me = leader, extra: Partial<typeof input> = {}, now = T0) {
  const r = createRaid(db, me, { ...input, ...extra }, now);
  if (!r.ok) throw new Error(r.error);
  return r.raid;
}
function pop(over: Partial<PopReport> = {}): PopReport {
  return {
    portalObjectId: 900, portalType: LH_PORTAL, dungeon: "Lost Halls", ownerAccountId: "1001", opener: { name: "Stockings", accountId: "1001" }, openerSource: "owner",
    beside: [{ name: "Stockings", accountId: "1001", d: 0.3 }], modifiers: "S|;TOKENDROPC", openedAt: 1700000000,
    roster: [{ name: "Stockings", accountId: "1001" }, { name: "Lilith", accountId: "1002" }, { name: "Stranger", accountId: "1009" }], at: T0 + 150_000, ...over,
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  leader = user("Stockings");
  raider = user("Lilith");
  hook = { order: vi.fn(), release: vi.fn(), list: () => [], manual: () => "k" };
  setRaidWatchHook(hook);
  vi.mocked(emitRaids).mockClear();
});
afterEach(() => {
  setRaidWatchHook(null);
  serverUsage.reset();
  db.close();
});

describe("posting", () => {
  it("validates every field and refuses a second open raid per leader", () => {
    expect(createRaid(db, leader, { ...input, dungeonId: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(createRaid(db, leader, { ...input, server: "Mars" })).toMatchObject({ ok: false, status: 400 });
    expect(createRaid(db, leader, { ...input, location: "Spawn" })).toMatchObject({ ok: false, status: 400 });
    expect(createRaid(db, leader, { ...input, party: "bad;name" })).toMatchObject({ ok: false, status: 400 });
    expect(createRaid(db, leader, { ...input, description: "x".repeat(201) })).toMatchObject({ ok: false, status: 400 });
    expect(createRaid(db, leader, { ...input, keys: 21 })).toMatchObject({ ok: false, status: 400 });
    const first = post();
    expect(first).toMatchObject({ status: "headcount", leader: "Stockings", raiders: ["Stockings"], joined: true, leading: true, limit: 50, verifiable: true, popsDone: 0, keysLeft: 2, pops: [], verdict: null, watcher: { state: "none" } });
    expect(createRaid(db, leader, input)).toMatchObject({ ok: false, status: 409 });
    expect(emitRaids).toHaveBeenCalledTimes(1);
    expect(listRaidEvents(db, first.id).map((e) => e.event)).toEqual(["raid.created"]);
  });
  it("marks a key whose portal is unknown as unverifiable", () => {
    expect(post(leader, { dungeonId: "plagued-nest-key" })).toMatchObject({ verifiable: false, watcher: { state: "none", note: expect.stringContaining("cannot be verified") } });
  });
  it("blocks a banned account on any of its names", () => {
    banRaider(db, "Stockings", "stockings", "crasher");
    expect(createRaid(db, leader, input)).toMatchObject({ ok: false, status: 403 });
    expect(joinRaid(db, leader, post(raider).id)).toMatchObject({ ok: false, status: 403 });
    unbanRaider(db, "stockings");
    expect(createRaid(db, leader, input).ok).toBe(true);
  });
});

describe("what each viewer sees", () => {
  it("hides the server, bazaar and party until the stage allows it", () => {
    const id = post().id;
    // A stranger, logged out: region only.
    expect(listRaids(db, null, T0)[0]).toMatchObject({ region: "US", server: null, location: null, party: null, hasParty: true, joined: false, leading: false });
    // Joined during headcount: still nothing but the region.
    expect(joinRaid(db, raider, id).ok).toBe(true);
    expect(getRaid(db, id, raider)).toMatchObject({ server: null, location: null, party: null, joined: true, raiders: ["Stockings", "Lilith"] });
    // The leader always sees their own secrets.
    expect(getRaid(db, id, leader)).toMatchObject({ server: "USSouth3", location: "Left bazaar", party: "stockhalls" });
    // AFK check: server and bazaar to raiders, party not yet.
    expect(advanceRaid(db, leader, id, T0)).toMatchObject({ ok: true, raid: { status: "afk", afkEndsAt: T0 + AFK_SECONDS * 1000 } });
    expect(getRaid(db, id, raider)).toMatchObject({ server: "USSouth3", location: "Left bazaar", party: null });
    const outsider = user("Zephyr");
    expect(getRaid(db, id, outsider)).toMatchObject({ server: null, location: null, party: null });
    // Joining during the AFK check reveals the location at once.
    expect(joinRaid(db, outsider, id).ok).toBe(true);
    expect(getRaid(db, id, outsider)).toMatchObject({ server: "USSouth3", location: "Left bazaar", party: null });
    // The AFK check complete (closed early here): the party goes out to raiders.
    expect(advanceRaid(db, leader, id, T0 + 10)).toMatchObject({ ok: true, raid: { status: "popping", afkEndsAt: null, popWindowEndsAt: T0 + 10 + POP_WINDOW_S * 1000 } });
    expect(getRaid(db, id, raider)).toMatchObject({ party: "stockhalls" });
    expect(getRaid(db, id, null)).toMatchObject({ server: null, party: null });
    // Left: back to nothing.
    expect(leaveRaid(db, raider, id).ok).toBe(true);
    expect(getRaid(db, id, raider)).toMatchObject({ server: null, party: null, joined: false });
  });
  it("reports no party when the leader set none", () => {
    const id = post(leader, { party: "" }).id;
    expect(getRaid(db, id, leader)).toMatchObject({ party: null, hasParty: false });
  });
  it("gives the operator everything", () => {
    post();
    expect(listRaidsAdmin(db)[0]).toMatchObject({ server: "USSouth3", location: "Left bazaar", party: "stockhalls", leaderIgnLower: "stockings", present: [] });
  });
});

describe("joining and leaving", () => {
  it("fills to the dungeon's limit and is idempotent", () => {
    const id = post(leader, { dungeonId: "shaitans-key" }).id; // limit 25
    for (let i = 0; i < 24; i++) expect(joinRaid(db, user(`R${String.fromCharCode(65 + i)}`), id).ok).toBe(true);
    expect(joinRaid(db, user("Late"), id)).toMatchObject({ ok: false, status: 409 });
    expect(joinRaid(db, leader, id)).toMatchObject({ ok: true, raid: { raiders: expect.arrayContaining(["Stockings"]) } });
    expect(getRaid(db, id, null)!.raiders).toHaveLength(25);
  });
  it("ends the raid when the leader leaves; refuses joins afterwards; releases the watcher", () => {
    const id = post().id;
    joinRaid(db, raider, id);
    expect(leaveRaid(db, leader, id)).toMatchObject({ ok: true, raid: { status: "ended", endedBy: "leader_left" } });
    expect(joinRaid(db, user("Zephyr"), id)).toMatchObject({ ok: false, status: 409 });
    expect(hook.release).toHaveBeenCalledWith(id);
    // The raider who was in it still sees the ended raid's party.
    expect(getRaid(db, id, raider)).toMatchObject({ status: "ended", party: "stockhalls" });
  });
});

describe("leader controls", () => {
  it("only the leader advances or ends", () => {
    const id = post().id;
    joinRaid(db, raider, id);
    expect(advanceRaid(db, raider, id)).toMatchObject({ ok: false, status: 403 });
    expect(endRaid(db, raider, id)).toMatchObject({ ok: false, status: 403 });
    expect(nextPop(db, raider, id)).toMatchObject({ ok: false, status: 403 });
    expect(extendPop(db, raider, id)).toMatchObject({ ok: false, status: 403 });
    expect(callWatcher(db, raider, id)).toMatchObject({ ok: false, status: 403 });
    expect(endRaid(db, leader, id)).toMatchObject({ ok: true, raid: { status: "ended", endedBy: "leader" } });
    expect(advanceRaid(db, leader, id)).toMatchObject({ ok: false, status: 409 });
    expect(endRaid(db, "operator", post(raider).id)).toMatchObject({ ok: true, raid: { endedBy: "operator" } });
  });
  it("orders the watcher at the AFK check with the raid's bazaar, portal and window, and can be called early during headcount", () => {
    const id = post(leader, {}, T0).id;
    expect(callWatcher(db, leader, id, T0)).toMatchObject({ ok: true, raid: { watcher: { state: "ordered" } } });
    expect(hook.order).toHaveBeenLastCalledWith({ raidId: id, server: "USSouth3", side: "left", portalType: LH_PORTAL, leaderIgn: "Stockings", until: T0 + EARLY_WATCH_MS });
    expect(advanceRaid(db, leader, id, T0 + 5)).toMatchObject({ ok: true, raid: { status: "afk" } });
    expect(hook.order).toHaveBeenLastCalledWith({ raidId: id, server: "USSouth3", side: "left", portalType: LH_PORTAL, leaderIgn: "Stockings", until: T0 + 5 + (AFK_SECONDS + POP_WINDOW_S) * 1000 + POP_CLOSE_GRACE_MS });
    expect(callWatcher(db, leader, id)).toMatchObject({ ok: false, status: 409 });
    // A right-bazaar raid asks for the other side.
    const b = post(raider, { location: "Right bazaar" }, T0).id;
    advanceRaid(db, raider, b, T0);
    expect(hook.order).toHaveBeenLastCalledWith(expect.objectContaining({ raidId: b, side: "right" }));
  });
  it("without a fleet hook the raid goes on unverified", () => {
    setRaidWatchHook(null);
    const id = post().id;
    expect(callWatcher(db, leader, id)).toMatchObject({ ok: false, status: 503 });
    expect(advanceRaid(db, leader, id, T0)).toMatchObject({ ok: true, raid: { watcher: { state: "none", note: "no watcher available" } } });
    sweepRaids(db, T0 + AFK_SECONDS * 1000);
    expect(getRaid(db, id, null)).toMatchObject({ status: "popping" });
    sweepRaids(db, T0 + (AFK_SECONDS + POP_WINDOW_S) * 1000);
    expect(getRaid(db, id, null)).toMatchObject({ status: "running", verdict: "unverified", pops: [{ n: 1, verdict: "unverified" }] });
  });
  it("walks headcount → afk → popping → (pop) → running → ended, and refuses advance while the window is open", () => {
    const id = post().id;
    expect(advanceRaid(db, leader, id).ok).toBe(true);
    expect(advanceRaid(db, leader, id)).toMatchObject({ ok: true, raid: { status: "popping" } });
    expect(advanceRaid(db, leader, id)).toMatchObject({ ok: false, status: 409 });
    expect(popSeen(db, { raidIds: [id], pop: pop() })).toEqual({ confirmed: [id], other: [] });
    expect(getRaid(db, id, null)).toMatchObject({ status: "running" });
    expect(advanceRaid(db, leader, id)).toMatchObject({ ok: true, raid: { status: "ended", endedBy: "leader" } });
  });
  it("extends the pop window once", () => {
    const id = post().id;
    advanceRaid(db, leader, id, T0);
    advanceRaid(db, leader, id, T0 + 1000);
    expect(extendPop(db, leader, id, T0 + 2000)).toMatchObject({ ok: true, raid: { popWindowEndsAt: T0 + 1000 + (POP_WINDOW_S + POP_EXTEND_S) * 1000, extended: 1 } });
    expect(extendPop(db, leader, id, T0 + 3000)).toMatchObject({ ok: false, status: 409 });
    expect(hook.order).toHaveBeenLastCalledWith(expect.objectContaining({ until: T0 + 1000 + (POP_WINDOW_S + POP_EXTEND_S) * 1000 + POP_CLOSE_GRACE_MS }));
  });
});

describe("the sweep", () => {
  it("opens the pop window when the AFK check runs out, times out stale stages, and deletes old ended raids", () => {
    const a = post(leader, {}, T0).id;
    advanceRaid(db, leader, a, T0);
    const b = post(raider, {}, T0).id; // headcount left alone
    expect(sweepRaids(db, T0 + AFK_SECONDS * 1000 - 1)).toEqual({ afkClosed: 0, popResolved: 0, timedOut: 0, deleted: 0 });
    expect(sweepRaids(db, T0 + AFK_SECONDS * 1000)).toEqual({ afkClosed: 1, popResolved: 0, timedOut: 0, deleted: 0 });
    expect(getRaid(db, a, leader)).toMatchObject({ status: "popping", afkEndsAt: null, popWindowEndsAt: T0 + (AFK_SECONDS + POP_WINDOW_S) * 1000, pops: [{ n: 1, verdict: "pending" }] });
    expect(sweepRaids(db, T0 + HEADCOUNT_MAX_MS)).toEqual({ afkClosed: 0, popResolved: 1, timedOut: 1, deleted: 0 });
    expect(getRaid(db, b, null)).toMatchObject({ status: "ended", endedBy: "timeout" });
    // No watcher ever stood there: the window closing leaves the raid running, unverified.
    expect(getRaid(db, a, leader)).toMatchObject({ status: "running", verdict: "unverified" });
    const runningSince = T0 + HEADCOUNT_MAX_MS;
    expect(sweepRaids(db, runningSince + RUNNING_MAX_MS - 1)).toEqual({ afkClosed: 0, popResolved: 0, timedOut: 0, deleted: 0 });
    expect(sweepRaids(db, runningSince + RUNNING_MAX_MS)).toEqual({ afkClosed: 0, popResolved: 0, timedOut: 1, deleted: 0 });
    // Ended raids drop off the list after an hour and are deleted after a day; the audit stays.
    const endedAt = T0 + HEADCOUNT_MAX_MS;
    expect(listRaids(db, null, endedAt + ENDED_LISTED_MS - 1).map((r) => r.id)).toContain(b);
    expect(listRaids(db, null, endedAt + ENDED_LISTED_MS + 1).map((r) => r.id)).not.toContain(b);
    expect(sweepRaids(db, endedAt + ENDED_KEEP_MS)).toMatchObject({ deleted: 1 });
    expect(getRaid(db, b, null)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM raid_members WHERE raid_id = ?").get(b)).toEqual({ n: 0 });
    expect(listRaidEvents(db, b).map((e) => e.event)).toEqual(["raid.created", "raid.ended"]);
  });
  it("ends a raid whose watcher stood in the bazaar for the whole window and saw no pop", () => {
    const id = post(leader, {}, T0).id;
    advanceRaid(db, leader, id, T0);
    watcherUpdate(db, { raidIds: [id], state: "in_bazaar", note: 'in "Cloth Bazaar"', bot: "bot1" }, T0 + 30_000);
    sweepRaids(db, T0 + AFK_SECONDS * 1000);
    sweepRaids(db, T0 + (AFK_SECONDS + POP_WINDOW_S) * 1000);
    expect(getRaid(db, id, leader)).toMatchObject({ status: "ended", endedBy: "no_pop", verdict: "none", pops: [{ n: 1, verdict: "none" }] });
    expect(raidHistoryFor(db, "stockings")).toMatchObject({ led: 1, popped: 0, noPop: 1 });
    expect(hook.release).toHaveBeenCalledWith(id);
  });
});

describe("what the watcher reports", () => {
  it("shows the watcher's progress to everyone and marks raiders it sees in the bazaar", () => {
    const id = post(leader, {}, T0).id;
    joinRaid(db, raider, id);
    advanceRaid(db, leader, id, T0);
    watcherUpdate(db, { raidIds: [id], state: "queued", note: "position 12 of 40", bot: "bot1" }, T0 + 5000);
    expect(getRaid(db, id, null)).toMatchObject({ watcher: { state: "queued", note: "position 12 of 40", since: T0 + 5000 }, bazaarCount: null });
    watcherUpdate(db, { raidIds: [id], state: "in_bazaar", note: 'in "Cloth Bazaar"', bot: "bot1" }, T0 + 40_000);
    rosterSeen(db, { raidIds: [id], names: ["Stranger", "LILITH"] }, T0 + 41_000);
    expect(getRaid(db, id, leader)).toMatchObject({ bazaarCount: 2, presentCount: 1, present: ["Lilith"], presentMe: false });
    expect(getRaid(db, id, raider)).toMatchObject({ presentCount: 1, present: null, presentMe: true });
    expect(getRaid(db, id, null)).toMatchObject({ presentCount: 1, present: null, presentMe: false });
    // The watcher says whether it can see the leader; the card shows it, the audit keeps each change, and a watcher that leaves clears it.
    expect(getRaid(db, id, leader)).toMatchObject({ leaderInRange: null, leaderDistance: null });
    leaderRange(db, { raidId: id, inRange: true, distance: 12.3 }, T0 + 41_500);
    expect(getRaid(db, id, leader)).toMatchObject({ leaderInRange: true, leaderDistance: 12.3 });
    leaderRange(db, { raidId: id, inRange: false, distance: null }, T0 + 41_600);
    expect(getRaid(db, id, leader)).toMatchObject({ leaderInRange: false, leaderDistance: null });
    expect(listRaidEvents(db, id).filter((e) => e.event.startsWith("leader.")).map((e) => `${e.event}: ${e.detail}`)).toEqual(["leader.in_range: 12.3 tiles from the watcher", "leader.out_of_range: not in the watcher's view"]);
    watcherUpdate(db, { raidIds: [id], state: "left", note: "", bot: "bot1" }, T0 + 41_700);
    expect(getRaid(db, id, leader)).toMatchObject({ leaderInRange: null, leaderDistance: null });
    watcherUpdate(db, { raidIds: [id], state: "in_bazaar", note: "", bot: "bot1" }, T0 + 41_800);
    // A later roster without Lilith keeps her on the present list (she was seen), and updates the count.
    rosterSeen(db, { raidIds: [id], names: ["Stranger", "Stockings"] }, T0 + 42_000);
    expect(getRaid(db, id, leader)).toMatchObject({ bazaarCount: 2, present: ["Lilith", "Stockings"] });
    expect(listRaidEvents(db, id).filter((e) => e.event === "raid.present").map((e) => e.ign)).toEqual(["lilith", "stockings"]);
  });
  it("confirms the leader's own pop with everything the wire carried and ignores other dungeons", () => {
    const id = post(leader, {}, T0).id;
    joinRaid(db, raider, id);
    advanceRaid(db, leader, id, T0);
    watcherUpdate(db, { raidIds: [id], state: "in_bazaar", note: "", bot: "bot1" }, T0 + 30_000);
    sweepRaids(db, T0 + AFK_SECONDS * 1000);
    // Another dungeon's portal: not ours.
    expect(popSeen(db, { raidIds: [id], pop: pop({ portalType: 0x727e, dungeon: "The Shatters" }) })).toEqual({ confirmed: [], other: [] });
    // The leader's: confirmed, with the modifiers, the opener and who was there.
    expect(popSeen(db, { raidIds: [id], pop: pop() }, T0 + 150_000)).toEqual({ confirmed: [id], other: [] });
    const v = getRaid(db, id, leader)!;
    // The leader was in the roster too: they count as present like any member.
    expect(v).toMatchObject({ status: "running", popsDone: 1, keysLeft: 1, verdict: "confirmed", bazaarCount: 3, presentCount: 2 });
    expect([...v.present!].sort()).toEqual(["Lilith", "Stockings"]);
    expect(v.pops).toEqual([{ n: 1, verdict: "confirmed", opener: "Stockings", byLeader: true, poppedAt: T0 + 150_000, closedAt: null, entered: null, leaderPoints: null, modifiers: "S|;TOKENDROPC", windowEndsAt: null }]);
    expect(listRaidEvents(db, id).map((e) => e.event)).toEqual(["raid.created", "raid.joined", "afk.start", "watcher.ordered", "watcher.in_bazaar", "afk.closed", "pop.window", "raid.present", "raid.present", "pop.confirmed", "pop.by_leader"]);
    // The leader's record, as every card shows it.
    expect(getRaid(db, id, null)!.leaderRecord).toEqual({ led: 1, popped: 1, poppedByOthers: 0, strikes: 0 });
    // The portal closes: raiders who vanished meanwhile went in; the watcher is released.
    portalClosed(db, { raidIds: [id], portalObjectId: 900, goneNames: ["Lilith", "Stranger"], closedAt: T0 + 180_000 }, T0 + 180_000);
    expect(getRaid(db, id, null)!.pops[0]).toMatchObject({ closedAt: T0 + 180_000, entered: 1, leaderPoints: 0.1 });
    expect(hook.release).toHaveBeenCalledWith(id);
    // The points: the leader earns 0.1 for the one raider who went in, that raider earns 0.1; the stranger was never a member.
    expect(db.prepare("SELECT ign, role, points, detail FROM raid_rewards ORDER BY id").all()).toEqual([
      { ign: "Stockings", role: "leader", points: 0.1, detail: "Lost Halls: 1 raider went in" },
      { ign: "Lilith", role: "raider", points: 0.1, detail: "Lost Halls: went in" },
    ]);
    expect(listRaidEvents(db, id).map((e) => e.event)).toContain("pop.rewards");
    // A second pop is not counted against the confirmed attempt.
    expect(popSeen(db, { raidIds: [id], pop: pop({ portalObjectId: 902 }) })).toEqual({ confirmed: [], other: [] });
    // The same portal reported again with the modifiers that arrived a tick later fills them in, once.
    expect(getRaid(db, id, null)!.pops[0].modifiers).toBe("S|;TOKENDROPC");
    const b = post(user("Bex"), {}, T0).id;
    advanceRaid(db, user("Bex"), b, T0);
    advanceRaid(db, user("Bex"), b, T0 + 1);
    expect(popSeen(db, { raidIds: [b], pop: pop({ portalObjectId: 950, modifiers: "", openedAt: null, opener: null, openerSource: null, ownerAccountId: "", beside: [{ name: "Bex", accountId: "1050", d: 0.1 }] }) })).toEqual({ confirmed: [b], other: [] });
    expect(getRaid(db, b, null)!.pops[0]).toMatchObject({ verdict: "confirmed", opener: "Bex", modifiers: null });
    expect(popSeen(db, { raidIds: [b], pop: pop({ portalObjectId: 950, modifiers: "DUSTSTORM;|S", opener: null, openerSource: null, ownerAccountId: "", beside: [] }) })).toEqual({ confirmed: [b], other: [] });
    expect(getRaid(db, b, null)!).toMatchObject({ status: "running", popsDone: 1, pops: [{ n: 1, modifiers: "DUSTSTORM;|S" }] });
    expect(listRaidEvents(db, b).filter((e) => e.event.startsWith("pop.")).map((e) => e.event)).toEqual(["pop.window", "pop.confirmed", "pop.by_leader", "pop.modifiers"]);
    expect(raidHistoryFor(db, "stockings")).toMatchObject({ led: 1, popped: 1, poppedByOthers: 0, noPop: 0, cancelled: 0, strikes: 0, joined: 0, present: 1, points: 0.1 });
    expect(raidHistoryFor(db, "lilith")).toMatchObject({ led: 0, popped: 0, joined: 1, present: 1, points: 0.1 });
  });
  it("names the opener from the server's notice, and takes the leader standing on the spot when there is none", () => {
    const id = post(leader, {}, T0).id;
    advanceRaid(db, leader, id, T0);
    advanceRaid(db, leader, id, T0 + 1);
    // The notice says Stockings; the nearest player is a stranger: the notice wins, and no "by proximity" note.
    expect(popSeen(db, { raidIds: [id], pop: pop({ ownerAccountId: "", opener: { name: "Stockings", accountId: "" }, openerSource: "notification", beside: [{ name: "Stranger", accountId: "1009", d: 0.0 }] }) }, T0 + 30_000)).toEqual({ confirmed: [id], other: [] });
    expect(getRaid(db, id, leader)).toMatchObject({ status: "running", pops: [{ verdict: "confirmed", opener: "Stockings" }] });
    expect(db.prepare("SELECT note FROM raid_pops WHERE raid_id = ?").get(id)).toEqual({ note: "" });
    // A stranger's pop of the raid's dungeon counts too: the raiders got their portal, and the record says who popped.
    const s2 = post(user("Cato"), {}, T0).id;
    advanceRaid(db, user("Cato"), s2, T0);
    advanceRaid(db, user("Cato"), s2, T0 + 1);
    expect(popSeen(db, { raidIds: [s2], pop: pop({ portalObjectId: 960, ownerAccountId: "", opener: { name: "Stranger", accountId: "" }, openerSource: "notification", beside: [{ name: "Cato", accountId: "1060", d: 0.0 }] }) }, T0 + 30_000)).toEqual({ confirmed: [s2], other: [] });
    expect(getRaid(db, s2, null)).toMatchObject({ status: "running", popsDone: 1, pops: [{ verdict: "confirmed", opener: "Stranger", byLeader: false }], leaderRecord: { led: 1, popped: 0, poppedByOthers: 1, strikes: 0 } });
    expect(listRaidEvents(db, s2).find((e) => e.event === "pop.confirmed")?.detail).toContain("opened by Stranger (not the leader)");
    expect(raidHistoryFor(db, "cato")).toMatchObject({ led: 1, popped: 0, poppedByOthers: 1 });
  });
  it("takes the leader standing on the spot as the opener when the portal names no owner, and cuts an AFK check short for the leader's early pop", () => {
    const id = post(leader, {}, T0).id;
    advanceRaid(db, leader, id, T0);
    // A stranger stands even closer to the portal than the leader: the leader on the spot still counts.
    expect(popSeen(db, { raidIds: [id], pop: pop({ ownerAccountId: "", opener: null, openerSource: null, beside: [{ name: "Stranger", accountId: "1009", d: 0.0 }, { name: "Stockings", accountId: "1001", d: 0.4 }] }) }, T0 + 30_000)).toEqual({ confirmed: [id], other: [] });
    expect(getRaid(db, id, leader)).toMatchObject({ status: "running", popsDone: 1, verdict: "confirmed" });
    expect(db.prepare("SELECT note FROM raid_pops WHERE raid_id = ?").get(id)).toEqual({ note: "opener by proximity" });
    // A stranger's pop during the AFK check counts the same way: the check is cut short and the pop is on record.
    const b = post(raider, {}, T0).id;
    advanceRaid(db, raider, b, T0);
    expect(popSeen(db, { raidIds: [b], pop: pop({ portalObjectId: 903 }) })).toEqual({ confirmed: [b], other: [] });
    expect(getRaid(db, b, raider)).toMatchObject({ status: "running", popsDone: 1, pops: [{ verdict: "confirmed", opener: "Stockings", byLeader: false }] });
  });
  it("a second key: the leader calls the next pop, a watcher is ordered again, and the pop is counted", () => {
    const id = post(leader, { keys: 2 }, T0).id;
    advanceRaid(db, leader, id, T0);
    advanceRaid(db, leader, id, T0 + 1000);
    popSeen(db, { raidIds: [id], pop: pop() }, T0 + 2000);
    expect(nextPop(db, leader, id, T0 + 600_000)).toMatchObject({ ok: true, raid: { status: "popping", popsDone: 1, keysLeft: 1, popWindowEndsAt: T0 + 600_000 + POP_WINDOW_S * 1000, pops: [{ n: 1, verdict: "confirmed" }, { n: 2, verdict: "pending" }] } });
    expect(hook.order).toHaveBeenLastCalledWith(expect.objectContaining({ raidId: id, until: T0 + 600_000 + POP_WINDOW_S * 1000 + POP_CLOSE_GRACE_MS }));
    expect(popSeen(db, { raidIds: [id], pop: pop({ portalObjectId: 910, at: T0 + 650_000 }) }, T0 + 650_000)).toEqual({ confirmed: [id], other: [] });
    expect(getRaid(db, id, leader)).toMatchObject({ status: "running", popsDone: 2, keysLeft: 0, pops: [{ n: 1 }, { n: 2, verdict: "confirmed", poppedAt: T0 + 650_000 }] });
    expect(nextPop(db, leader, id)).toMatchObject({ ok: false, status: 409 });
    // A later attempt with no pop does not end the raid: the first run happened.
    const c = post(raider, { keys: 3 }, T0).id;
    advanceRaid(db, raider, c, T0);
    advanceRaid(db, raider, c, T0 + 1000);
    popSeen(db, { raidIds: [c], pop: pop({ portalObjectId: 920, opener: { name: "Lilith", accountId: "1002" }, beside: [] }) }, T0 + 2000);
    nextPop(db, raider, c, T0 + 700_000);
    watcherUpdate(db, { raidIds: [c], state: "in_bazaar", note: "", bot: "bot2" }, T0 + 701_000);
    sweepRaids(db, T0 + 700_000 + POP_WINDOW_S * 1000);
    expect(getRaid(db, c, raider)).toMatchObject({ status: "running", popsDone: 1, verdict: "none", pops: [{ n: 1, verdict: "confirmed" }, { n: 2, verdict: "none" }] });
  });
  it("pays the leader 0.1 per raider who went in, uncapped, each of them 0.1, nothing for the leader's own entry or an unconfirmed pop, and the score counts it", () => {
    const names = ["Ann", "Ben", "Cid", "Dee", "Eve", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kim"];
    const id = post(leader, { keys: 2 }, T0).id;
    for (const n of names) joinRaid(db, user(n), id);
    advanceRaid(db, leader, id, T0);
    advanceRaid(db, leader, id, T0 + 1000);
    const roster = [{ name: "Stockings", accountId: "1001" }, ...names.map((n, i) => ({ name: n, accountId: String(2000 + i) }))];
    expect(popSeen(db, { raidIds: [id], pop: pop({ roster }) }, T0 + 2000)).toEqual({ confirmed: [id], other: [] });
    // Eleven raiders and the leader go in; Kim stays; a stranger leaving counts for nothing.
    const gone = ["Stockings", ...names.slice(0, 10), "Stranger"];
    portalClosed(db, { raidIds: [id], portalObjectId: 900, goneNames: gone, closedAt: T0 + 30_000 }, T0 + 30_000);
    const v = getRaid(db, id, null)!;
    expect(v.pops[0]).toMatchObject({ entered: 11, leaderPoints: 1 });
    const rewards = db.prepare("SELECT ign, role, points FROM raid_rewards WHERE raid_id = ? ORDER BY id").all(id) as { ign: string; role: string; points: number }[];
    expect(rewards[0]).toEqual({ ign: "Stockings", role: "leader", points: 1 });
    expect(rewards.slice(1).map((r) => [r.ign, r.role, r.points])).toEqual(names.slice(0, 10).map((n) => [n, "raider", 0.1]));
    expect(rewards.find((r) => r.ign === "Kim")).toBeUndefined();
    // The same close reported twice pays once.
    portalClosed(db, { raidIds: [id], portalObjectId: 900, goneNames: gone, closedAt: T0 + 31_000 }, T0 + 31_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM raid_rewards").get()).toEqual({ n: 11 });
    // A second key whose window runs out unpopped pays nothing more.
    nextPop(db, leader, id, T0 + 600_000);
    watcherUpdate(db, { raidIds: [id], state: "in_bazaar", note: "", bot: "bot1" }, T0 + 601_000);
    sweepRaids(db, T0 + 600_000 + POP_WINDOW_S * 1000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM raid_rewards").get()).toEqual({ n: 11 });
    // The leaderboard's score carries the raid points, and keeps them after the raid row is gone.
    const score = (ign: string) => computePlayers(db).find((p) => p.ign === ign);
    expect(score("Stockings")).toMatchObject({ points: 1, raidPoints: 1, deposited: 0 });
    expect(score("Ann")).toMatchObject({ points: 0.1, raidPoints: 0.1 });
    expect(score("Kim")).toBeUndefined();
    endRaid(db, leader, id, T0 + 700_000);
    sweepRaids(db, T0 + 700_000 + ENDED_KEEP_MS + 1);
    expect(getRaid(db, id, null)).toBeNull();
    expect(score("Stockings")).toMatchObject({ points: 1, raidPoints: 1 });
    expect(raidHistoryFor(db, "stockings")).toMatchObject({ points: 1 });
  });
});

describe("strikes and the empty-server rule", () => {
  it("a verified no-pop and a cancel after the AFK check are strikes with growing cooldowns; three block posting until cleared; a headcount cancel is free", () => {
    // Strike 1: a watcher stood in the bazaar for the whole window and nothing opened.
    const a = post(leader, {}, T0).id;
    advanceRaid(db, leader, a, T0);
    watcherUpdate(db, { raidIds: [a], state: "in_bazaar", note: "", bot: "bot1" }, T0 + 1000);
    sweepRaids(db, T0 + AFK_SECONDS * 1000);
    sweepRaids(db, T0 + (AFK_SECONDS + POP_WINDOW_S) * 1000);
    expect(getRaid(db, a, leader)).toMatchObject({ status: "ended", endedBy: "no_pop", leaderRecord: { led: 1, popped: 0, strikes: 1 } });
    const t1 = T0 + (AFK_SECONDS + POP_WINDOW_S) * 1000;
    expect(postingHold(db, leader.userId, t1)).toEqual({ strikes: 1, until: t1 + 60 * 60_000 });
    expect(createRaid(db, leader, input, t1 + 1000)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("cooldown for 1 h") });
    // An hour later posting reopens; cancelling during headcount costs nothing.
    const t2 = t1 + 60 * 60_000;
    const b = post(leader, {}, t2).id;
    expect(endRaid(db, leader, b, t2 + 1000)).toMatchObject({ ok: true, raid: { status: "ended", endedBy: "leader" } });
    expect(postingHold(db, leader.userId, t2 + 2000)).toEqual({ strikes: 1, until: null });
    // Strike 2: cancelling after the AFK check has sent raiders moving. A day off posting.
    const c = post(leader, {}, t2 + 3000).id;
    advanceRaid(db, leader, c, t2 + 3000);
    expect(endRaid(db, leader, c, t2 + 4000)).toMatchObject({ ok: true, raid: { status: "ended", endedBy: "leader", leaderRecord: { strikes: 2 } } });
    expect(postingHold(db, leader.userId, t2 + 5000)).toEqual({ strikes: 2, until: t2 + 4000 + 24 * 60 * 60_000 });
    expect(createRaid(db, leader, input, t2 + 5000)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("cooldown for 24 h") });
    // Strike 3 (the leader leaving during the pop window): blocked until an operator clears them.
    const t3 = t2 + 4000 + 24 * 60 * 60_000;
    const d = post(leader, {}, t3).id;
    advanceRaid(db, leader, d, t3);
    advanceRaid(db, leader, d, t3 + 1000);
    expect(leaveRaid(db, leader, d, t3 + 2000)).toMatchObject({ ok: true, raid: { endedBy: "leader_left" } });
    expect(postingHold(db, leader.userId, t3 + 3000)).toEqual({ strikes: 3, until: Infinity });
    expect(createRaid(db, leader, input, t3 + 3000)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("blocked") });
    expect(raidHistoryFor(db, "stockings", t3 + 3000)).toMatchObject({ led: 4, popped: 0, noPop: 1, cancelled: 2, strikes: 3 });
    expect(listStrikes(db, t3 + 3000).map((s) => [s.kind, s.raidId, s.active])).toEqual([["cancelled", d, true], ["cancelled", c, true], ["no_pop", a, true]]);
    // An operator clears them; and untouched, they would have decayed after 30 days anyway.
    expect(clearStrikes(db, "stockings", "operator", t3 + 4000)).toBe(3);
    expect(postingHold(db, leader.userId, t3 + 5000)).toEqual({ strikes: 0, until: null });
    expect(createRaid(db, leader, input, t3 + 5000).ok).toBe(true);
    const e = post(raider, {}, T0).id;
    advanceRaid(db, raider, e, T0);
    expect(endRaid(db, raider, e, T0 + 1000)).toMatchObject({ ok: true });
    expect(postingHold(db, raider.userId, T0 + 2000)).toMatchObject({ strikes: 1 });
    expect(postingHold(db, raider.userId, T0 + 1000 + STRIKE_DECAY_MS + 1)).toEqual({ strikes: 0, until: null });
    expect(listRaidEvents(db, c).map((x) => x.event)).toContain("strike.cancelled");
  });
  it("refuses to post or start the AFK check on a server a withdraw may not use: the operator's switch, or Realm's load reading", () => {
    // The operator's per-server withdraw switch closes the server to raids too; deposits-only does not.
    setServerControl(db, "USSouth3", true, false);
    expect(createRaid(db, leader, input, T0).ok).toBe(true);
    endRaid(db, leader, listRaids(db, leader)[0].id, T0);
    setServerControl(db, "USSouth3", false, true);
    expect(createRaid(db, leader, input, T0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("USSouth3 is switched off right now") });
    setServerControl(db, "USSouth3", false, false);
    // Realm's load: 75% and 100% are out, like a withdraw.
    serverUsage.set([{ name: "USSouth3", usage: 0.75 }, { name: "USEast", usage: 0 }], T0);
    expect(createRaid(db, leader, input, T0)).toMatchObject({ ok: false, status: 409, error: "USSouth3 is 75% full right now; raids run on empty servers only, like withdraws. Pick a quiet one." });
    serverUsage.set([{ name: "USSouth3", usage: 1 }, { name: "USEast", usage: 0 }], T0);
    expect(createRaid(db, leader, input, T0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("100% full") });
    serverUsage.set([{ name: "USSouth3", usage: 0.75 }, { name: "USEast", usage: 0 }], T0);
    const id = post(leader, { server: "USEast" }, T0).id;
    // The server fills up before the AFK check: the leader is told to cancel (free) and repost.
    serverUsage.set([{ name: "USEast", usage: 1 }], T0 + 1000);
    expect(advanceRaid(db, leader, id, T0 + 1000)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("Cancelling now is free") });
    // A stale reading stands down, like the trade gate.
    expect(advanceRaid(db, leader, id, T0 + 1000 + 10 * 60_000)).toMatchObject({ ok: true, raid: { status: "afk" } });
  });
});
