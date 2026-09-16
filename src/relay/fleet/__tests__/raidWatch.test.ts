// The raid watcher (docs/RAIDS.md §5): which portal is which bazaar, what the
// observer makes of the bot's packets, and the service's bookkeeping of
// shared watchers — with the trip itself replaced by a stub.
import { describe, expect, it, vi } from "vitest";
import { Stat } from "../../protocol/stats";
import type { AnyPacket } from "../../protocol/packets";
import { bazaarSides, BazaarObserver, interesting, portalInfo, RaidWatchService, RangeTracker, type RaidSite, type TripContext } from "../raidWatch";
import type { FleetDeps } from "../bringUp";
import type { BotPool } from "../botPool";

const T0 = 1_800_000_000_000;
const LH = 0xb024;
const strStat = (statType: number, v: string) => ({ statType, statValue: 0, strStatValue: v, secondaryValue: -1 });
const numStat = (statType: number, v: number) => ({ statType, statValue: v, strStatValue: "", secondaryValue: -1 });
const player = (objectId: number, x: number, name: string, accountId: string) => ({ objectType: 0x030e, status: { objectId, pos: { x, y: 5 }, stats: [strStat(Stat.NAME, name), strStat(Stat.ACCOUNTID, accountId), numStat(Stat.NUMSTARS, 40)] } });
const update = (newObjs: unknown[], drops: number[] = []): AnyPacket => ({ type: "UPDATE", pos: { x: 5, y: 5 }, levelType: 0, tiles: [], drops, unknownByte: -1, newObjs } as unknown as AnyPacket);
const tick = (statuses: unknown[]): AnyPacket => ({ type: "NEWTICK", tickId: 1, tickTime: 200, serverRealTimeMS: 200, serverLastTimeRTTMS: 0, statuses } as unknown as AnyPacket);

describe("bazaarSides", () => {
  it("orders two portals along x, falls back to the player for one, and mirrors on request", () => {
    const a = { pos: { x: 2, y: 5 } };
    const b = { pos: { x: 4, y: 5 } };
    expect(bazaarSides([b, a], { x: 5, y: 5 }, false).map((p) => p.side)).toEqual(["right", "left"]);
    expect(bazaarSides([b, a], { x: 5, y: 5 }, true).map((p) => p.side)).toEqual(["left", "right"]);
    expect(bazaarSides([a], { x: 5, y: 5 }, false)[0].side).toBe("left");
    expect(bazaarSides([{ pos: { x: 9, y: 5 } }], { x: 5, y: 5 }, false)[0].side).toBe("right");
    expect(bazaarSides([a], null, false)[0].side).toBe("left");
  });
});

describe("portal table", () => {
  it("knows portals the relay's old object table does not, and never the permanent ones", () => {
    expect(portalInfo(0x9cfd)).toEqual({ id: "Ice Citadel Portal", dungeon: "Ice Citadel", dungeonPortal: true });
    expect(interesting(0x9cfd, new Set([0x9cfd]))).toBe(true);
    expect(interesting(0x9cfd, new Set([LH]))).toBe(false);
    expect(interesting(0x9cfd, new Set([0]))).toBe(true);
    expect(interesting(0x0750, new Set([0]))).toBe(false); // the bazaar portal itself
    expect(interesting(0x0712, new Set([0]))).toBe(false); // the Nexus portal
    expect(interesting(0x0753, new Set([0]))).toBe(false); // the Pet Yard portal, which every bazaar has
    expect(interesting(0x030e, new Set([0]))).toBe(false); // a wizard
    // The default observer (no injected class checks) reports an Ice Citadel portal, named.
    const o = new BazaarObserver({ selfId: () => 7, now: () => T0 });
    const out = o.apply(update([{ objectType: 0x9cfd, status: { objectId: 500, pos: { x: 8, y: 5 }, stats: [strStat(Stat.OWNERACCOUNTID, "1001")] } }]));
    expect(out.pops).toMatchObject([{ portalObjectId: 500, portalType: 0x9cfd, dungeon: "Ice Citadel", ownerAccountId: "1001", openerSource: null }]);
  });
});

const notice = (effect: number, player: string, objectId: number, pictureType: number): AnyPacket => ({
  type: "NOTIFICATION", effect, extra: effect === 8 ? 10 : 26, message: `{"k":"s.${effect === 8 ? "dungeon_" : ""}opened_by","t":{"player":"${player}",}}`, objectId, uiExtra: 0, queuePos: 0, color: 0, pictureType, emoteId: 0, unknown1: 0, unknown2: 0,
} as unknown as AnyPacket);

describe("BazaarObserver with the server's opened-by notices (the live wire, 2026-09-13)", () => {
  it("names the opener from the toast that follows the portal, adds their account from the bubble's object id, and pairs a notice that came first", () => {
    let now = T0;
    const o = new BazaarObserver({ selfId: () => 7, isPlayer: (t) => t === 0x030e, isPortal: (t) => t === LH || t === 0x9cfd, now: () => now });
    o.apply(update([player(30, 8.5, "Stockings", "1001"), player(31, 12, "Lilith", "1002")]));
    // The portal, with no owner stat (as live), then the toast (pictureType = the portal type), then the bubble (objectId = the opener).
    const first = o.apply(update([{ objectType: LH, status: { objectId: 900, pos: { x: 8, y: 5 }, stats: [] } }])).pops;
    expect(first.map((p) => [p.opener, p.openerSource])).toEqual([[null, null]]);
    const toast = o.apply(notice(8, "Stockings", 0, LH)).pops;
    expect(toast.map((p) => [p.portalObjectId, p.opener, p.openerSource])).toEqual([[900, { name: "Stockings", accountId: "1001" }, "notification"]]);
    expect(o.apply(notice(6, "Stockings", 30, 0)).pops).toEqual([]); // nothing new to say
    // A notice for a player not (yet) in the roster still names them; the account follows when they stream in.
    now = T0 + 20_000;
    o.apply(notice(8, "Zephyr", 0, 0x9cfd));
    const late = o.apply(update([{ objectType: 0x9cfd, status: { objectId: 901, pos: { x: 6, y: 5 }, stats: [] } }])).pops;
    expect(late.map((p) => [p.portalObjectId, p.opener, p.openerSource])).toEqual([[901, { name: "Zephyr", accountId: "" }, "notification"]]);
    expect(o.apply(update([player(32, 6, "Zephyr", "1003")])).pops.map((p) => [p.portalObjectId, p.opener])).toEqual([[901, { name: "Zephyr", accountId: "1003" }]]);
    expect(o.apply(tick([])).pops).toEqual([]);
  });
});

describe("BazaarObserver", () => {
  const obs = () => {
    let now = T0;
    const o = new BazaarObserver({ selfId: () => 7, isPlayer: (t) => (t === 0x030e ? true : t === LH ? false : null), isPortal: (t) => t === LH, now: () => now });
    return { o, at: (t: number) => { now = t; } };
  };
  it("keeps the roster (present, named, not us), reports a pop with its owner, who stood beside it, the modifiers, and who went in when it closes", () => {
    const { o, at } = obs();
    o.apply(update([player(7, 5, "Bot", "1000"), player(30, 8.5, "Stockings", "1001"), player(31, 12, "Lilith", "1002"), { objectType: 0xabc, status: { objectId: 9, pos: { x: 6, y: 5 }, stats: [numStat(Stat.NUMSTARS, 3)] } }]));
    expect(o.roster()).toEqual([{ name: "Stockings", accountId: "1001" }, { name: "Lilith", accountId: "1002" }, { name: "", accountId: "" }].filter((r) => r.name));
    const v1 = o.rosterVersion;
    at(T0 + 1000);
    const out = o.apply(update([{ objectType: LH, status: { objectId: 900, pos: { x: 8, y: 5 }, stats: [strStat(Stat.OWNERACCOUNTID, "1001"), strStat(Stat.MODIFIERS, "S|;TOKENDROPC"), numStat(Stat.OPENEDATTIMESTAMP, 1700000000)] } }]));
    expect(out.closed).toEqual([]);
    expect(out.pops).toEqual([{
      portalObjectId: 900, portalType: LH, dungeon: "Lost Halls", ownerAccountId: "1001", opener: { name: "Stockings", accountId: "1001" }, openerSource: "owner",
      beside: [{ name: "Stockings", accountId: "1001", d: 0.5 }], modifiers: "S|;TOKENDROPC", openedAt: 1700000000,
      roster: [{ name: "Stockings", accountId: "1001" }, { name: "Lilith", accountId: "1002" }], at: T0 + 1000,
    }]);
    // A stars-carrying object with no class known counts as a player once named; a re-streamed portal is not a second pop.
    expect(o.apply(update([{ objectType: LH, status: { objectId: 900, pos: { x: 8, y: 5 }, stats: [] } }])).pops).toEqual([]);
    // Modifiers that arrive on a later tick are reported again, once per change.
    expect(o.apply(tick([{ objectId: 900, pos: { x: 8, y: 5 }, stats: [strStat(Stat.MODIFIERS, "S|;TOKENDROPC")] }])).pops).toEqual([]);
    expect(o.apply(tick([{ objectId: 900, pos: { x: 8, y: 5 }, stats: [strStat(Stat.MODIFIERS, "DUSTSTORM;|S")] }])).pops.map((p) => p.modifiers)).toEqual(["DUSTSTORM;|S"]);
    expect(o.apply(tick([{ objectId: 900, pos: { x: 8, y: 5 }, stats: [strStat(Stat.MODIFIERS, "DUSTSTORM;|S")] }])).pops).toEqual([]);
    expect(o.rosterVersion).toBe(v1);
    // Lilith leaves, then the portal closes: she is the one who went in.
    at(T0 + 20_000);
    expect(o.apply(update([], [31])).closed).toEqual([]);
    expect(o.roster()).toEqual([{ name: "Stockings", accountId: "1001" }]);
    at(T0 + 30_000);
    expect(o.apply(update([], [900])).closed).toEqual([{ portalObjectId: 900, goneNames: ["Lilith"], closedAt: T0 + 30_000 }]);
    expect(o.pops.size).toBe(0);
  });
  it("names the owner later when the account id or the player arrives after the portal, and resets per world", () => {
    const { o } = obs();
    o.apply(update([player(30, 8.5, "Stockings", "1001")]));
    // No owner on the object: reported without one (the site falls back to who stood beside it).
    const first = o.apply(update([{ objectType: LH, status: { objectId: 900, pos: { x: 8, y: 5 }, stats: [] } }])).pops;
    expect(first).toHaveLength(1);
    expect(first[0].opener).toBeNull();
    expect(first[0].beside).toEqual([{ name: "Stockings", accountId: "1001", d: 0.5 }]);
    // The owner stat comes on a tick, for an account not yet in the roster: reported again, still nameless.
    expect(o.apply(tick([{ objectId: 900, pos: { x: 8, y: 5 }, stats: [strStat(Stat.OWNERACCOUNTID, "1003")] }])).pops.map((p) => p.opener)).toEqual([null]);
    // Then that player streams in: they are named on the spot, once.
    expect(o.apply(update([player(32, 6, "Zephyr", "1003")])).pops.map((p) => [p.opener, p.openerSource])).toEqual([[{ name: "Zephyr", accountId: "1003" }, "owner"]]);
    expect(o.apply(tick([])).pops).toEqual([]);
    o.apply({ type: "MAPINFO", name: "Cloth Bazaar" } as unknown as AnyPacket);
    expect(o.roster()).toEqual([]);
    expect(o.pops.size).toBe(0);
  });
});

describe("RangeTracker", () => {
  it("greets a leader in sight once, warns when they stray or vanish, welcomes them back with hysteresis, and paces its whispers", () => {
    const t = new RangeTracker({ side: "left", botName: () => "kf keys" });
    const me = { x: 100, y: 100 };
    // First sight: a greeting that says how close to stay.
    const hello = t.update("Stockings", { x: 105, y: 100 }, me, T0);
    expect(hello).toMatchObject({ inRange: true, distance: 5 });
    expect(hello!.message).toMatch(/^I'm watching the left bazaar from the entrance\. I can see you \(5 tiles\): pop within 20 tiles of me and it counts\.$/);
    // Still in sight: nothing to say. Past 20 tiles: out, but not before the message gap has passed.
    expect(t.update("Stockings", { x: 115, y: 100 }, me, T0 + 1000)).toBeNull();
    expect(t.update("Stockings", { x: 122, y: 100 }, me, T0 + 2000)).toBeNull();
    expect(t.current("Stockings")).toBe(true);
    const out = t.due("Stockings", { x: 122, y: 100 }, me, T0 + 9000);
    expect(out).toMatchObject({ inRange: false, distance: 22 });
    expect(out!.message).toBe("You're 22 tiles from me, out of my sight. Come within 20 tiles or your pop won't count.");
    // 19 tiles is inside the line but not inside the hysteresis band: still out. 17 tiles is back.
    expect(t.update("Stockings", { x: 119, y: 100 }, me, T0 + 20_000)).toBeNull();
    const back = t.update("Stockings", { x: 117, y: 100 }, me, T0 + 21_000);
    expect(back).toMatchObject({ inRange: true, distance: 17, message: "Back in my sight (17 tiles): your pop counts again." });
    // Gone from view entirely.
    const gone = t.update("Stockings", null, me, T0 + 40_000);
    expect(gone).toMatchObject({ inRange: false, distance: null, message: "I can't see you any more. Come within 20 tiles of me at the bazaar entrance or your pop won't count." });
    // Another leader is tracked on its own; one not yet in view is told where to come.
    expect(t.update("Lilith", { x: 101, y: 100 }, me, T0 + 40_000)!.inRange).toBe(true);
    expect(t.current("Lilith")).toBe(true);
    expect(t.update("Zephyr", null, me, T0 + 40_000)).toMatchObject({ inRange: false, distance: null, message: "I'm watching the left bazaar from the entrance and can't see you yet. Come within 20 tiles of me before you pop, or it won't count." });
  });
});

describe("RaidWatchService", () => {
  function make() {
    let now = T0;
    const site: RaidSite = { watcherUpdate: vi.fn(), rosterSeen: vi.fn(), popSeen: vi.fn(), portalClosed: vi.fn(), leaderRange: vi.fn() };
    const contexts: TripContext[] = [];
    const resolvers: (() => void)[] = [];
    const svc = new RaidWatchService({
      deps: {} as FleetDeps, pool: {} as BotPool, holds: new Set(), log: () => {}, now: () => now,
      trip: (ctx) => {
        contexts.push(ctx);
        ctx.setBot("bot1");
        ctx.report("in_bazaar", 'in "Cloth Bazaar"');
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
    });
    svc.attachSite(site);
    return { svc, site, contexts, resolvers, tick: () => (svc as unknown as { tick(): void }).tick(), at: (t: number) => { now = t; } };
  }

  it("shares one watcher per bazaar, routes reports to the raids that want that portal, and stops it when nobody is left", async () => {
    const { svc, site, contexts, resolvers, tick, at } = make();
    svc.order({ raidId: 1, server: "USSouth3", side: "left", portalType: LH, leaderIgn: "Stockings", until: T0 + 300_000 });
    svc.order({ raidId: 2, server: "USSouth3", side: "left", portalType: 0x727e, leaderIgn: "Lilith", until: T0 + 200_000 });
    svc.order({ raidId: 3, server: "USSouth3", side: "right", portalType: LH, leaderIgn: "Zephyr", until: T0 + 300_000 });
    await Promise.resolve();
    expect(contexts).toHaveLength(2);
    expect(svc.list().map((w) => [w.key, w.state, w.bot, w.subscriptions.map((s) => s.raidId)])).toEqual([
      ["USSouth3|left", "in_bazaar", "bot1", [1, 2]],
      ["USSouth3|right", "in_bazaar", "bot1", [3]],
    ]);
    // Raid 1 heard the state as the trip reported it; raid 2, joining a watcher already in place, was told on subscribing.
    expect(site.watcherUpdate).toHaveBeenCalledWith({ raidIds: [1], state: "in_bazaar", note: 'in "Cloth Bazaar"', bot: "bot1" });
    expect(site.watcherUpdate).toHaveBeenCalledWith({ raidIds: [2], state: "in_bazaar", note: 'in "Cloth Bazaar"', bot: "bot1" });
    const left = contexts[0];
    expect(left.wants()).toEqual(new Set([LH, 0x727e]));
    left.roster(["Stockings", "Lilith"]);
    expect(site.rosterSeen).toHaveBeenLastCalledWith({ raidIds: [1, 2], names: ["Stockings", "Lilith"] });
    const pop = { portalObjectId: 900, portalType: LH, dungeon: "", ownerAccountId: "1001", opener: { name: "Stockings", accountId: "1001" }, openerSource: "owner" as const, beside: [], modifiers: "", openedAt: null, roster: [], at: T0 + 1000 };
    left.pop(pop);
    expect(site.popSeen).toHaveBeenLastCalledWith({ raidIds: [1], pop });
    expect(svc.list()[0].pops).toBe(1);
    left.closed({ portalObjectId: 900, goneNames: ["Lilith"], closedAt: T0 + 2000 });
    expect(site.portalClosed).toHaveBeenLastCalledWith({ raidIds: [1, 2], portalObjectId: 900, goneNames: ["Lilith"], closedAt: T0 + 2000 });
    expect(left.leaders()).toEqual([{ raidId: 1, leaderIgn: "Stockings" }, { raidId: 2, leaderIgn: "Lilith" }]);
    left.range(1, false, 23.4);
    expect(site.leaderRange).toHaveBeenLastCalledWith({ raidId: 1, inRange: false, distance: 23.4 });
    // Raid 2 lapses, raid 1 is released: the left watcher is told to stop; the right one stays.
    at(T0 + 200_000);
    tick();
    expect(left.stopped()).toBe(false);
    svc.release(1);
    expect(left.stopped()).toBe(true);
    expect(contexts[1].stopped()).toBe(false);
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(site.watcherUpdate).toHaveBeenLastCalledWith({ raidIds: [], state: "left", note: "no raid left to watch", bot: "bot1" });
    expect(svc.list().map((w) => w.key)).toEqual(["USSouth3|right"]);
    // A new order for that bazaar starts a fresh trip.
    svc.order({ raidId: 4, server: "USSouth3", side: "left", portalType: LH, leaderIgn: "Moss", until: T0 + 900_000 });
    await Promise.resolve();
    expect(contexts).toHaveLength(3);
  });

  it("a manual watch wants every dungeon portal, reports to no raid, and a failed trip is retried once while a raid still has time", async () => {
    const { svc, site, contexts, resolvers } = make();
    expect(svc.manual("EUWest", "right", 5)).toBe("EUWest|right");
    await Promise.resolve();
    expect(contexts[0].wants()).toEqual(new Set([0]));
    contexts[0].roster(["Someone"]);
    expect(site.rosterSeen).not.toHaveBeenCalled();
    expect(svc.list()[0].subscriptions[0].raidId).toBe(-1);
    resolvers[0]();

    let calls = 0;
    const failing = new RaidWatchService({
      deps: {} as FleetDeps, pool: {} as BotPool, holds: new Set(), log: () => {}, now: () => T0, timeouts: { retryDelayMs: 1 },
      trip: async () => {
        calls++;
        throw new Error("no free account to send");
      },
    });
    const site2: RaidSite = { watcherUpdate: vi.fn(), rosterSeen: vi.fn(), popSeen: vi.fn(), portalClosed: vi.fn(), leaderRange: vi.fn() };
    failing.attachSite(site2);
    failing.order({ raidId: 9, server: "USEast", side: "left", portalType: LH, leaderIgn: "X", until: T0 + 300_000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
    expect(site2.watcherUpdate).toHaveBeenLastCalledWith({ raidIds: [9], state: "failed", note: "no free account to send", bot: null });
    expect(failing.list()[0]).toMatchObject({ state: "failed", subscriptions: [{ raidId: 9 }] });
  });
});
