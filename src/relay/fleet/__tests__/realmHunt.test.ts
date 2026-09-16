// The realm hunter (docs/REALMHUNTS.md §3): what it makes of the bot's
// packets (the party, party chat, the count) and the service's bookkeeping
// with the trip itself replaced by a stub.
import { describe, expect, it, vi } from "vitest";
import { Stat } from "../../protocol/stats";
import type { AnyPacket } from "../../protocol/packets";
import { BazaarObserver } from "../raidWatch";
import { CHAT_MAX, chatLines, countEntered, MAX_RETRIES, NO_PARTY, partyLine, PartyState, RealmHuntService, seenNames, serverIndexOf, type TripContext } from "../realmHunt";
import type { HuntSite } from "../../../lib/realmhuntRules";
import type { FleetDeps } from "../bringUp";
import type { BotPool } from "../botPool";

const T0 = 1_800_000_000_000;
const strStat = (statType: number, v: string) => ({ statType, statValue: 0, strStatValue: v, secondaryValue: -1 });
const numStat = (statType: number, v: number) => ({ statType, statValue: v, strStatValue: "", secondaryValue: -1 });
const obj = (objectType: number, objectId: number, x: number, y: number, stats: unknown[] = []) => ({ objectType, status: { objectId, pos: { x, y }, stats } });
const player = (objectId: number, x: number, name: string) => obj(0x030e, objectId, x, 5, [strStat(Stat.NAME, name), strStat(Stat.ACCOUNTID, String(1000 + objectId)), numStat(Stat.NUMSTARS, 40)]);
const update = (newObjs: unknown[], drops: number[] = []): AnyPacket => ({ type: "UPDATE", pos: { x: 5, y: 5 }, levelType: 0, tiles: [], drops, unknownByte: -1, newObjs } as unknown as AnyPacket);
const mapInfo = (name: string, realmName = name): AnyPacket => ({ type: "MAPINFO", name, realmName } as unknown as AnyPacket);
const text = (name: string, recipient: string, t: string): AnyPacket => ({ type: "TEXT", name, objectId: 1, numStars: 5, bubbleTime: 10, recipient, text: t, cleanText: t, isSupporter: false, starBg: 0 } as unknown as AnyPacket);

describe("the count", () => {
  it("is everyone the roster saw since the dungeon's map arrived, present or gone, the bot excluded, split by party membership", () => {
    const obs = new BazaarObserver({ selfId: () => 7, isPortal: () => false, now: () => T0 });
    obs.apply(update([player(7, 1, "Bot"), player(30, 2, "Aki"), player(31, 3, "Stranger")]));
    obs.apply(mapInfo("Moonlight Village"));
    obs.apply(update([player(7, 1, "Bot"), player(50, 2, "Aki"), player(51, 3, "Bob")]));
    obs.apply(update([player(52, 4, "Cy")], [51])); // Bob ran ahead out of view: still counted
    obs.apply(update([player(51, 3, "Bob")])); // and back: once
    expect(seenNames(obs, 7)).toEqual(["Aki", "Bob", "Cy"]);
    expect(countEntered(seenNames(obs, 7), ["Bot", "Aki", "cy"])).toEqual({ entered: 3, partyEntered: 2 });
    expect(countEntered(["Aki,fe14", "aki", "Bob,a19d,a064"], ["Aki", "Bob,c84c"])).toEqual({ entered: 2, partyEntered: 2 });
    expect(countEntered([], ["Aki"])).toEqual({ entered: 0, partyEntered: 0 });
  });
  it("the server index is the server's place in account/servers", () => {
    const list = [{ name: "EUEast" }, { name: "USSouth" }, { name: "USWest3" }];
    expect(serverIndexOf(list, "USWest3")).toBe(2);
    expect(serverIndexOf(list, "Mars")).toBe(0);
  });
});

describe("chat lines", () => {
  it("splits a long message at word boundaries so every line fits the game's limit with its /p prefix", () => {
    const greeting = "welcome Stockings. Hunt any realm for a Pirate Cave. Once inside it, say j here: I teleport to you and count who joins in 30s.";
    const lines = chatLines(greeting);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(`/p ${l}`.length).toBeLessThanOrEqual(CHAT_MAX);
    expect(lines.join(" ")).toBe(greeting);
    expect(chatLines("j")).toEqual(["j"]);
    expect(chatLines("   ")).toEqual([]);
  });
});

describe("the party and its chat", () => {
  it("follows member info (0xffffffff = none), additions and leavers, and names the member id a teleport takes; a party chat line from someone else is a line, the bot's own and other channels are not", () => {
    const p = new PartyState();
    expect(p.inParty).toBe(false);
    p.apply({ type: "PARTYMEMBERINFO", partyId: NO_PARTY, unknownShort: 0, maxSize: 0, players: [], description: "" });
    expect([p.partyId, p.inParty, p.version]).toEqual([0, false, 1]);
    p.apply({ type: "PARTYMEMBERINFO", partyId: 9871, unknownShort: 1, maxSize: 50, players: [{ playerId: 1, name: "Bot", classId: 0, skinId: 0 }], description: "realmhunt Moonlight Village US" });
    p.apply({ type: "PARTYMEMBERADDED", playerId: 0x1f5, name: "Aki", classId: 0, skinId: 0 });
    expect([p.partyId, p.inParty, p.memberNames(), p.playerIdOf("aki"), p.playerIdOf("Bob")]).toEqual([9871, true, ["Bot", "Aki"], 0x1f5, null]);
    const v = p.version;
    p.apply({ type: "PARTYACTIONRESULT", playerId: 0x1f5, result: 6 });
    expect([p.memberNames(), p.version]).toEqual([["Bot"], v + 1]);
    p.apply({ type: "PARTYACTIONRESULT", playerId: 99, result: 6 });
    expect(p.version).toBe(v + 1);
    expect(partyLine(text("Aki", "*Party*", "j"), "Bot")).toEqual({ name: "Aki", text: "j" });
    // Name-style tags ride on the wire name ("Chambara,fe14", live): the bare name is what the party list and the site know.
    expect(partyLine(text("Chambara,fe14", "*Party*", "j lb"), "Bot")).toEqual({ name: "Chambara", text: "j lb" });
    expect(partyLine(text("Bot,a19d", "*Party*", "x"), "Bot")).toBeNull();
    expect(p.playerIdOf("Aki,a19d,a064")).toBeNull(); // Aki left above
    p.apply({ type: "PARTYMEMBERADDED", playerId: 0x1f6, name: "Excalibur,a19d,a064", classId: 0, skinId: 0 });
    expect([p.playerIdOf("excalibur"), p.playerIdOf("Excalibur,fe14"), p.memberNames()]).toEqual([0x1f6, 0x1f6, ["Bot", "Excalibur"]]);
    expect(partyLine(text("Bot", "*Party*", "in Moonlight Village"), "Bot")).toBeNull();
    expect(partyLine(text("Aki", "*Guild*", "j"), "Bot")).toBeNull();
    expect(partyLine(text("Aki", "", "j"), "Bot")).toBeNull();
    expect(partyLine(text("", "*Party*", "Party invitation to Aki was sent"), "Bot")).toBeNull();
  });
});

describe("RealmHuntService", () => {
  function make(trip?: (ctx: TripContext) => Promise<void>) {
    let now = T0;
    const site: HuntSite = { hunterUpdate: vi.fn(), membersSeen: vi.fn(), callStarted: vi.fn(() => 41), callDone: vi.fn() };
    const contexts: TripContext[] = [];
    const resolvers: (() => void)[] = [];
    const svc = new RealmHuntService({
      deps: {} as FleetDeps, pool: {} as BotPool, holds: new Set(), log: () => {}, now: () => now, timeouts: { retryDelayMs: 0 },
      trip: trip ?? ((ctx) => {
        contexts.push(ctx);
        ctx.setBot("bot1");
        ctx.setParty(9871);
        ctx.report("hunting", "party open");
        return new Promise<void>((resolve) => resolvers.push(resolve));
      }),
    });
    svc.attachSite(site);
    return { svc, site, contexts, resolvers, tick: () => (svc as unknown as { tick(): void }).tick(), at: (t: number) => { now = t; } };
  }
  const order = (huntId: number, until = T0 + 300_000) => ({ huntId, server: "USWest3", dungeonId: "moonlight-village-key", dungeon: "Moonlight Village", portalType: 0x4fdf, region: "US", partyName: "realmhunt Moonlight Village US", maxPartySize: 50, until });

  it("runs one hunter per hunt, relays what the trip reports, and stops it on release or when the order lapses", async () => {
    const { svc, site, contexts, resolvers, tick, at } = make();
    svc.order(order(1));
    svc.order(order(2, T0 + 100_000));
    svc.order(order(1)); // a renewal: no second trip
    await Promise.resolve();
    expect(contexts).toHaveLength(2);
    expect(svc.list().map((h) => [h.huntId, h.state, h.bot, h.partyId])).toEqual([[1, "hunting", "bot1", 9871], [2, "hunting", "bot1", 9871]]);
    expect(site.hunterUpdate).toHaveBeenCalledWith({ huntId: 1, state: "hunting", note: "party open", bot: "bot1", server: "USWest3", partyId: 9871 });
    const ctx = contexts[0];
    ctx.members(["Bot", "Aki"]);
    expect(site.membersSeen).toHaveBeenLastCalledWith({ huntId: 1, members: ["Bot", "Aki"] });
    expect(ctx.callStarted("Aki")).toBe(41);
    expect(site.callStarted).toHaveBeenLastCalledWith({ huntId: 1, caller: "Aki", at: T0 });
    ctx.callDone(41, "counted", ["Aki", "Bob", "Cy"], "");
    expect(site.callDone).toHaveBeenLastCalledWith({ huntId: 1, callId: 41, outcome: "counted", names: ["Aki", "Bob", "Cy"], partyMembers: ["Bot", "Aki"], note: "", at: T0 });
    expect(svc.list()[0].calls).toBe(1);
    // Hunt 2 lapses; hunt 1 is released.
    at(T0 + 100_000);
    tick();
    expect(contexts[1].stopped()).toBe(true);
    expect(ctx.stopped()).toBe(false);
    svc.release(1);
    expect(ctx.stopped()).toBe(true);
    resolvers[0]();
    resolvers[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(site.hunterUpdate).toHaveBeenCalledWith(expect.objectContaining({ huntId: 1, state: "left", note: "the hunt ended" }));
    expect(svc.list()).toEqual([]);
    // A new order for the hunt starts a fresh trip.
    svc.order(order(1));
    await Promise.resolve();
    expect(contexts).toHaveLength(3);
  });

  it("retries a failed trip while the order has time (a hunter may die), gives up after MAX_RETRIES in a row, and a trip that settled resets the count", async () => {
    let attempts = 0;
    const { svc, site } = make(async (ctx) => {
      attempts++;
      ctx.setBot("bot1");
      throw new Error(attempts === 1 ? "no free account to send" : "lost its connection");
    });
    svc.order(order(1));
    for (let i = 0; i < 50 && attempts < MAX_RETRIES + 1; i++) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
    expect(attempts).toBe(MAX_RETRIES + 1);
    expect(site.hunterUpdate).toHaveBeenCalledWith(expect.objectContaining({ huntId: 1, state: "ordered", note: "retrying after: no free account to send" }));
    expect(site.hunterUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ huntId: 1, state: "failed", note: "lost its connection" }));
    expect(svc.list().map((h) => h.state)).toEqual(["failed"]);
    // A trip that reached "hunting" (settled) then died: the failure count starts over, so it keeps coming back.
    let runs = 0;
    const dying = make(async (ctx) => {
      runs++;
      ctx.settled();
      if (runs <= MAX_RETRIES + 2) throw new Error("died");
      return new Promise<void>(() => {});
    });
    dying.svc.order(order(2));
    for (let i = 0; i < 80 && runs < MAX_RETRIES + 3; i++) await new Promise((r) => setTimeout(r, 1));
    expect(runs).toBe(MAX_RETRIES + 3);
    expect(dying.svc.list().map((h) => h.state)).not.toEqual(["failed"]);
    // An order with under a minute left is not retried.
    let once = 0;
    const short = make(async () => {
      once++;
      throw new Error("x");
    });
    short.svc.order(order(3, T0 + 30_000));
    await new Promise((r) => setTimeout(r, 5));
    expect(once).toBe(1);
    expect(short.site.hunterUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ huntId: 3, state: "failed" }));
  });
});
