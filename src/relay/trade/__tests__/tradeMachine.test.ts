import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartnerCoordinator, TradeSession, CONSOLIDATION_ACCEPT_DELAY_MS, PRESENCE_SETTLE_MS, REQUEST_TIMEOUT_MS, type Assignment } from "../tradeMachine";
import type { GameClient } from "../../client/gameClient";
import type { AnyPacket, Packets, PacketName } from "../../protocol/packets";
import type { TradeItem } from "../../protocol/data";
import { Stat } from "../../protocol/stats";

const UBATK = 2979; // ring of unbound attack, curated id "ubatk"
const PATK = 2591; // attack potion, "patk"
const PDEF = 2592; // defense potion, "pdef"
const AGENT_SKIN = 8827; // "skin:8827": only taken on an operator's skin deposit
const JUNK = 999999; // not in any catalog

class FakeClient extends EventEmitter {
  sent: { type: string; body: unknown }[] = [];
  constructor(public guid: string, public alias = guid) {
    super();
  }
  send<K extends PacketName>(type: K, body: Packets[K]): boolean {
    this.sent.push({ type, body });
    return true;
  }
  feed(p: AnyPacket): void {
    this.emit("packet", p);
  }
  last(type: string) {
    return [...this.sent].reverse().find((s) => s.type === type);
  }
}

function item(id: number, enchantment = "", tradeable = true): TradeItem {
  return { item: id, slotType: 0, tradeable, included: false, enchantment };
}
const EMPTY = item(-1, "", false);

function playerUpdate(objectId: number, ign: string): AnyPacket {
  return {
    type: "UPDATE", pos: { x: 0, y: 0 }, levelType: 0, tiles: [], drops: [], unknownByte: -1,
    newObjs: [{ objectType: 782, status: { objectId, pos: { x: 1, y: 1 }, stats: [{ statType: Stat.NAME, statValue: 0, strStatValue: ign, secondaryValue: 0 }] } }],
  };
}
const drop = (objectId: number): AnyPacket => ({ type: "UPDATE", pos: { x: 0, y: 0 }, levelType: 0, tiles: [], newObjs: [], drops: [objectId], unknownByte: -1 });
const mapInfo: AnyPacket = {
  type: "MAPINFO", width: 0, height: 0, name: "Nexus", displayName: "", realmName: "", seed: 0, background: 0, difficulty: 0,
  allowPlayerTeleport: true, showDisplays: true, newBool: false, maxPlayers: 0, gameOpenedTime: 0, buildVersion: "", viewRadius: 0,
  newInt: 0, dungeonModifiers: [], unknownShort1: 0, unknownBool: false, unknownShort2: 0, maxRealmScore: 0, curRealmScore: 0,
};
const ping: AnyPacket = { type: "PING", serial: 1 };

// 13-byte enchant record with one enchant set.
const ONE_ENCHANT = Buffer.from([0, 2, 4, 5, 0, 0xfd, 0xff, 0xfd, 0xff, 0xfd, 0xff, 5, 0]).toString("base64url");

function setup(assignment: Assignment | null, opts: { resolve?: Record<string, { slot: number; itemId: string }> } = {}) {
  const coordinator = new PartnerCoordinator();
  const client = new FakeClient("bot@example.com", "Bot");
  const outcomes: number[] = [];
  const session = new TradeSession(client as unknown as GameClient, {
    coordinator,
    resolveInstance: (id) => opts.resolve?.[id],
    onOutcome: () => outcomes.push(Date.now()),
  });
  session.setAssignment(assignment);
  return { coordinator, client, session, outcomes };
}

/** Land the bot on a map with the partner in view and the request sent. */
function landWithPartner(client: FakeClient, partner = "Partner") {
  client.feed(mapInfo);
  client.feed(playerUpdate(7, partner));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("deposit", () => {
  it("requests on map load, accepts pool items, reports what was received", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [], itemCount: 8 });
    landWithPartner(client);
    expect(client.last("REQUESTTRADE")?.body).toEqual({ name: "Partner" });
    expect(session.phase).toBe("REQUESTED");

    client.feed({ type: "TRADESTART", clientItems: [EMPTY, EMPTY], partnerName: "Partner,1a2b", partnerItems: [item(UBATK, ONE_ENCHANT), item(PATK), EMPTY] });
    expect(session.phase).toBe("IN_TRADE");
    expect(client.last("CHANGETRADE")).toBeUndefined();

    client.feed({ type: "TRADEACCEPTED", clientOffer: [false, false], partnerOffer: [true, true, false] });
    expect(session.phase).toBe("ACCEPTED");
    expect(client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [false, false], partnerOffer: [true, true, false] });

    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.phase).toBe("DONE");
    const out = session.takeOutcome();
    expect(out).toEqual({
      ok: true, kind: "deposit",
      received: [{ itemId: "ubatk", qty: 1 }, { itemId: "patk", qty: 1 }],
      receivedUnits: [{ itemId: "ubatk", enchants: 1 }, { itemId: "patk", enchants: 0 }],
    });
    expect(session.phase).toBe("IDLE");
  });

  it("takes a skin only when the deposit was queued for skins", () => {
    const plain = setup({ kind: "deposit", partnerIgn: "Partner", items: [], itemCount: 8 });
    landWithPartner(plain.client);
    plain.client.feed({ type: "TRADESTART", clientItems: [EMPTY], partnerName: "Partner", partnerItems: [item(AGENT_SKIN), item(PATK)] });
    plain.client.feed({ type: "TRADEACCEPTED", clientOffer: [false], partnerOffer: [true, true] });
    expect(plain.client.last("ACCEPTTRADE")).toBeUndefined();
    expect(plain.session.phase).toBe("IN_TRADE");

    const skins = setup({ kind: "deposit", partnerIgn: "Partner", items: [], itemCount: 8, acceptSkins: true });
    landWithPartner(skins.client);
    skins.client.feed({ type: "TRADESTART", clientItems: [EMPTY], partnerName: "Partner", partnerItems: [item(AGENT_SKIN), item(PATK)] });
    skins.client.feed({ type: "TRADEACCEPTED", clientOffer: [false], partnerOffer: [true, true] });
    expect(skins.client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [false], partnerOffer: [true, true] });
    skins.client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(skins.session.takeOutcome()).toMatchObject({ ok: true, kind: "deposit", received: [{ itemId: "skin:8827", qty: 1 }, { itemId: "patk", qty: 1 }] });
  });

  it("holds instead of accepting an item the pool doesn't take", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [EMPTY], partnerName: "Partner", partnerItems: [item(JUNK)] });
    client.feed({ type: "TRADEACCEPTED", clientOffer: [false], partnerOffer: [true] });
    expect(client.last("ACCEPTTRADE")).toBeUndefined();
    expect(session.phase).toBe("IN_TRADE");
  });

  it("cancels when the window opens with the wrong partner", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [EMPTY], partnerName: "Stranger", partnerItems: [] });
    expect(client.last("CANCELTRADE")).toBeDefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "wrong partner" });
  });
});

describe("withdraw", () => {
  it("offers the least-enchanted matching slot and mirrors the accept", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "ubatk", qty: 1 }] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [item(UBATK, ONE_ENCHANT), item(UBATK), item(PATK)], partnerName: "Partner", partnerItems: [EMPTY] });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [false, true, false] });

    client.feed({ type: "TRADEACCEPTED", clientOffer: [false, true, false], partnerOffer: [false] });
    expect(client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [false, true, false], partnerOffer: [false] });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toEqual({ ok: true, kind: "withdraw", delivered: [{ itemId: "ubatk", qty: 1 }], deliveredInstanceIds: [] });
  });

  it("offers exactly the picked instances", () => {
    const { client } = setup(
      { kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "ubatk", qty: 1 }], instanceIds: ["inst-1"] },
      { resolve: { "inst-1": { slot: 5, itemId: "ubatk" } } },
    );
    landWithPartner(client);
    const items = [EMPTY, EMPTY, EMPTY, EMPTY, item(UBATK), item(UBATK, ONE_ENCHANT)];
    client.feed({ type: "TRADESTART", clientItems: items, partnerName: "Partner", partnerItems: [] });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [false, false, false, false, false, true] });
  });

  it("cancels if the picked instance is no longer tracked", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "ubatk", qty: 1 }], instanceIds: ["gone"] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [item(UBATK)], partnerName: "Partner", partnerItems: [] });
    expect(client.last("CANCELTRADE")).toBeDefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "items not present" });
  });

  it("cancels when the partner sneaks items into a one-way trade", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "ubatk", qty: 1 }] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [item(UBATK)], partnerName: "Partner", partnerItems: [item(PATK)] });
    client.feed({ type: "TRADECHANGED", offer: [true] });
    expect(client.last("CANCELTRADE")).toBeDefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "partner added items" });
  });
});

describe("consolidation", () => {
  it("taker accepts first once the giver's offer matches, then the giver mirrors", () => {
    const taker = setup({ kind: "consolidate_take", partnerIgn: "Giver", items: [{ itemId: "patk", qty: 2 }] });
    landWithPartner(taker.client, "Giver");
    taker.client.feed({ type: "TRADESTART", clientItems: [EMPTY, EMPTY], partnerName: "Giver", partnerItems: [item(PATK), item(PATK), item(PDEF)] });
    expect(taker.client.last("CHANGETRADE")).toBeUndefined();
    taker.client.feed({ type: "TRADECHANGED", offer: [true, false, false] });
    expect(taker.client.last("ACCEPTTRADE")).toBeUndefined(); // one short
    taker.client.feed({ type: "TRADECHANGED", offer: [true, true, false] });
    vi.advanceTimersByTime(CONSOLIDATION_ACCEPT_DELAY_MS);
    taker.client.feed(ping);
    expect(taker.client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [false, false], partnerOffer: [true, true, false] });
    taker.client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(taker.session.takeOutcome()).toEqual({ ok: true, kind: "consolidate_take", consolidated: [{ itemId: "patk", qty: 2 }] });

    const giver = setup({ kind: "consolidate_give", partnerIgn: "Taker", items: [{ itemId: "patk", qty: 2 }] });
    landWithPartner(giver.client, "Taker");
    giver.client.feed({ type: "TRADESTART", clientItems: [item(PATK), item(PDEF), item(PATK)], partnerName: "Taker", partnerItems: [EMPTY] });
    expect(giver.client.last("CHANGETRADE")?.body).toEqual({ offer: [true, false, true] });
    giver.client.feed({ type: "TRADEACCEPTED", clientOffer: [true, false, true], partnerOffer: [false] });
    expect(giver.client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [true, false, true], partnerOffer: [false] });
  });

  it("swap: the taker puts up its side and accepts once the giver's matches", () => {
    const { client, session } = setup({ kind: "consolidate_take", partnerIgn: "Giver", items: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
    landWithPartner(client, "Giver");
    client.feed({ type: "TRADESTART", clientItems: [item(PDEF), EMPTY], partnerName: "Giver", partnerItems: [item(PATK), EMPTY] });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [true, false] });
    client.feed({ type: "TRADECHANGED", offer: [true, false] });
    vi.advanceTimersByTime(CONSOLIDATION_ACCEPT_DELAY_MS);
    client.feed(ping);
    expect(client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [true, false], partnerOffer: [true, false] });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toEqual({ ok: true, kind: "consolidate_take", consolidated: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
  });

  it("swap: the giver mirrors only when the partner's side is exactly the agreed swap", () => {
    const { client, session } = setup({ kind: "consolidate_give", partnerIgn: "Taker", items: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
    landWithPartner(client, "Taker");
    client.feed({ type: "TRADESTART", clientItems: [item(PATK)], partnerName: "Taker", partnerItems: [item(PDEF), item(UBATK)] });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [true] });
    client.feed({ type: "TRADECHANGED", offer: [true, false] });
    expect(client.last("CANCELTRADE")).toBeUndefined();
    client.feed({ type: "TRADEACCEPTED", clientOffer: [true], partnerOffer: [true, false] });
    expect(client.last("ACCEPTTRADE")?.body).toEqual({ clientOffer: [true], partnerOffer: [true, false] });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toEqual({ ok: true, kind: "consolidate_give", consolidated: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
  });

  it("swap: the giver cancels on anything outside the swap, or a short side at accept", () => {
    const outside = setup({ kind: "consolidate_give", partnerIgn: "Taker", items: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
    landWithPartner(outside.client, "Taker");
    outside.client.feed({ type: "TRADESTART", clientItems: [item(PATK)], partnerName: "Taker", partnerItems: [item(PDEF), item(UBATK)] });
    outside.client.feed({ type: "TRADECHANGED", offer: [true, true] });
    expect(outside.client.last("CANCELTRADE")).toBeDefined();
    expect(outside.session.takeOutcome()).toEqual({ ok: false, error: "partner added items" });

    const short = setup({ kind: "consolidate_give", partnerIgn: "Taker", items: [{ itemId: "patk", qty: 1 }], swapItems: [{ itemId: "pdef", qty: 1 }] });
    landWithPartner(short.client, "Taker");
    short.client.feed({ type: "TRADESTART", clientItems: [item(PATK)], partnerName: "Taker", partnerItems: [item(PDEF), item(UBATK)] });
    short.client.feed({ type: "TRADEACCEPTED", clientOffer: [true], partnerOffer: [false, false] });
    expect(short.client.last("CANCELTRADE")).toBeDefined();
    expect(short.session.takeOutcome()).toEqual({ ok: false, error: "swap offer mismatch" });
  });
});

describe("presence and timeouts", () => {
  it("does not invite a partner who is not in view once the map has settled", () => {
    const { client, session } = setup(null);
    client.feed(mapInfo);
    vi.setSystemTime(Date.now() + PRESENCE_SETTLE_MS + 1);
    session.setAssignment({ kind: "deposit", partnerIgn: "Partner", items: [] });
    expect(session.sendTradeRequest()).toBe(false);
    expect(client.last("REQUESTTRADE")).toBeUndefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "partner not in nexus", partnerAbsent: true });
  });

  it("still invites while the map is streaming in (absence isn't known yet)", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [] });
    client.feed(mapInfo);
    expect(session.phase).toBe("REQUESTED");
    expect(client.last("REQUESTTRADE")?.body).toEqual({ name: "Partner" });
  });

  it("gives up when the partner walks away mid-trade", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: [EMPTY], partnerName: "Partner", partnerItems: [] });
    client.feed(drop(7));
    expect(client.last("CANCELTRADE")).toBeDefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "partner left", partnerAbsent: true });
  });

  it("times out a request the partner never answers", () => {
    const { client, session } = setup({ kind: "deposit", partnerIgn: "Partner", items: [] });
    landWithPartner(client);
    vi.setSystemTime(Date.now() + REQUEST_TIMEOUT_MS + 1);
    client.feed(ping);
    expect(session.takeOutcome()).toMatchObject({ ok: false, partnerAbsent: true });
  });
});

describe("partner coordinator", () => {
  it("lets one bot at a time engage a player, with a cooldown between them", () => {
    const c = new PartnerCoordinator();
    const trading = () => true;
    expect(c.acquire("Partner,abcd", "a", trading)).toBe(true);
    expect(c.acquire("partner", "b", trading)).toBe(false);
    expect(c.acquire("Partner", "a", trading)).toBe(true); // re-entrant
    c.release("Partner", "a");
    expect(c.acquire("Partner", "b", trading)).toBe(false); // cooldown
    vi.setSystemTime(Date.now() + 5_000);
    expect(c.acquire("Partner", "b", trading)).toBe(true);
  });

  it("reclaims a lock whose holder is idle", () => {
    const c = new PartnerCoordinator();
    expect(c.acquire("Partner", "a", () => true)).toBe(true);
    expect(c.acquire("Partner", "b", (g) => g !== "a")).toBe(true);
  });
});

describe("withdraw in windows sized to the partner's room", () => {
  /** A partner window: 4 equipment slots, then inventory with `free` empties among `size` slots. */
  const window = (size: number, free: number): TradeItem[] => [
    EMPTY, EMPTY, EMPTY, EMPTY,
    ...Array.from({ length: size }, (_, i) => (i < size - free ? item(PDEF, "", false) : EMPTY)),
  ];
  const ours = (n: number): TradeItem[] => [EMPTY, EMPTY, EMPTY, EMPTY, ...Array.from({ length: 8 }, (_, i) => (i < n ? item(PATK) : EMPTY))];

  it("offers only what fits, re-requests after the cooldown, and reports the total once everything crossed", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "patk", qty: 5 }] });
    landWithPartner(client);
    // Window 1: the partner has 2 free slots -> 2 of the 5.
    client.feed({ type: "TRADESTART", clientItems: ours(5), partnerName: "Partner", partnerItems: window(8, 2) });
    const offer1 = (client.last("CHANGETRADE")?.body as { offer: boolean[] }).offer;
    expect(offer1.filter(Boolean).length).toBe(2);
    client.feed({ type: "TRADEACCEPTED", clientOffer: offer1, partnerOffer: window(8, 2).map(() => false) });
    expect(client.last("ACCEPTTRADE")).toBeDefined();
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toBeNull();
    expect(session.isTrading()).toBe(true);
    expect(session.chunksDone).toBe(1);
    // Not before the partner's client has closed the window.
    const requestsBefore = client.sent.filter((s) => s.type === "REQUESTTRADE").length;
    expect(session.sendTradeRequest()).toBe(false);
    vi.advanceTimersByTime(PRESENCE_SETTLE_MS);
    client.feed(ping);
    expect(client.sent.filter((s) => s.type === "REQUESTTRADE").length).toBe(requestsBefore + 1);
    // Window 2: 3 free slots now -> the last 3.
    client.feed({ type: "TRADESTART", clientItems: ours(3), partnerName: "Partner", partnerItems: window(8, 3) });
    const offer2 = (client.last("CHANGETRADE")?.body as { offer: boolean[] }).offer;
    expect(offer2.filter(Boolean).length).toBe(3);
    client.feed({ type: "TRADEACCEPTED", clientOffer: offer2, partnerOffer: window(8, 3).map(() => false) });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toEqual({ ok: true, kind: "withdraw", delivered: [{ itemId: "patk", qty: 5 }], deliveredInstanceIds: [] });
    expect(session.chunksDone).toBe(2);
  });

  it("a backpack partner's 16-slot window counts its backpack room", () => {
    const { client } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "patk", qty: 5 }] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: ours(5), partnerName: "Partner", partnerItems: window(16, 9) });
    expect((client.last("CHANGETRADE")?.body as { offer: boolean[] }).offer.filter(Boolean).length).toBe(5);
  });

  it("cancels a window the partner has no room for", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "patk", qty: 1 }] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: ours(1), partnerName: "Partner", partnerItems: window(8, 0) });
    expect(client.last("CANCELTRADE")).toBeDefined();
    expect(session.takeOutcome()).toEqual({ ok: false, error: "partner inventory full" });
  });

  it("a failure after a finished window reports what already crossed", () => {
    const { client, session } = setup({ kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "patk", qty: 3 }] });
    landWithPartner(client);
    client.feed({ type: "TRADESTART", clientItems: ours(3), partnerName: "Partner", partnerItems: window(8, 2) });
    const offer = (client.last("CHANGETRADE")?.body as { offer: boolean[] }).offer;
    client.feed({ type: "TRADEACCEPTED", clientOffer: offer, partnerOffer: window(8, 2).map(() => false) });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    vi.advanceTimersByTime(PRESENCE_SETTLE_MS);
    client.feed(ping);
    expect(session.phase).toBe("REQUESTED");
    client.feed(drop(7));
    expect(session.takeOutcome()).toEqual({ ok: false, error: "partner left", partnerAbsent: true, delivered: [{ itemId: "patk", qty: 2 }], deliveredInstanceIds: [] });
  });

  it("hands picked instances over in order, as many per window as fit", () => {
    const { client, session } = setup(
      { kind: "withdraw", partnerIgn: "Partner", items: [{ itemId: "ubatk", qty: 3 }], instanceIds: ["i1", "i2", "i3"] },
      { resolve: { i1: { slot: 4, itemId: "ubatk" }, i2: { slot: 5, itemId: "ubatk" }, i3: { slot: 6, itemId: "ubatk" } } },
    );
    landWithPartner(client);
    const mine = [EMPTY, EMPTY, EMPTY, EMPTY, item(UBATK), item(UBATK), item(UBATK), EMPTY];
    client.feed({ type: "TRADESTART", clientItems: mine, partnerName: "Partner", partnerItems: window(8, 2) });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [false, false, false, false, true, true, false, false] });
    client.feed({ type: "TRADEACCEPTED", clientOffer: [false, false, false, false, true, true, false, false], partnerOffer: window(8, 2).map(() => false) });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toBeNull();
    vi.advanceTimersByTime(PRESENCE_SETTLE_MS);
    client.feed(ping);
    client.feed({ type: "TRADESTART", clientItems: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, item(UBATK), EMPTY], partnerName: "Partner", partnerItems: window(8, 1) });
    expect(client.last("CHANGETRADE")?.body).toEqual({ offer: [false, false, false, false, false, false, true, false] });
    client.feed({ type: "TRADEACCEPTED", clientOffer: [false, false, false, false, false, false, true, false], partnerOffer: window(8, 1).map(() => false) });
    client.feed({ type: "TRADEDONE", code: 0, description: "" });
    expect(session.takeOutcome()).toEqual({ ok: true, kind: "withdraw", delivered: [{ itemId: "ubatk", qty: 3 }], deliveredInstanceIds: ["i1", "i2", "i3"] });
  });
});
