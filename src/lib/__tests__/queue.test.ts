// Request transitions against an in-memory database and in-memory presence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import * as q from "../queue";
import { sweepStaleRequests, CLAIMED_TIMEOUT_MS, PENDING_TIMEOUT_MS } from "../timeouts";
import { registerAdvancedSettings } from "../advanced";
import { DEFAULT_ADVANCED } from "../../node/settings";

let db: Database.Database;
const BOT = "botguid-aaaaaaaa";

function insertDeposit(ign: string, server = "USSouth3", seasonal = 1, itemCount = 8, items: q.ItemQty[] | null = null): number {
  const now = Date.now();
  return Number(db.prepare(
    `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(ign, ign.toLowerCase(), server, itemCount, itemCount, `g-${ign}-${now}`, seasonal, items ? JSON.stringify(items) : null, now, now).lastInsertRowid);
}
function insertWithdraw(ign: string, items: q.ItemQty[], opts: { target?: string; instanceIds?: string[]; server?: string; seasonal?: number } = {}): number {
  const now = Date.now();
  return Number(db.prepare(
    `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  ).run(ign, ign.toLowerCase(), opts.server ?? "USSouth3", JSON.stringify(items), `g-${ign}-${now}`, opts.target ?? null, opts.instanceIds ? JSON.stringify(opts.instanceIds) : null, opts.seasonal ?? 1, now, now).lastInsertRowid);
}
function botOnline(guid = BOT, over: Partial<Parameters<typeof presence.report>[0]> = {}) {
  presence.report({ botGuid: guid, alias: "A", ign: "BotIgn", server: "USSouth3", freeSlots: 8, status: "idle", seasonal: true, ...over });
}
function status(table: string, id: number) {
  return (db.prepare(`SELECT status, claimed_by FROM ${table} WHERE id = ?`).get(id) as { status: string; claimed_by: string | null });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  presence.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("deposit lifecycle", () => {
  it("claims a pending row only with room for its trade, at that size, and records events", () => {
    const id = insertDeposit("Someone");
    botOnline();
    // An 8-slot trade needs 8 free slots: six won't do.
    expect(q.claimDeposit(db, BOT, 6)).toBeNull();
    expect(status("deposit_requests", id).status).toBe("pending");
    const a = q.claimDeposit(db, BOT, 8);
    expect(a).toMatchObject({ kind: "deposit", requestId: id, ign: "Someone", itemCount: 8, botIgn: "BotIgn" });
    expect(status("deposit_requests", id)).toEqual({ status: "claimed", claimed_by: BOT });
    expect(presence.get(BOT)?.status).toBe("busy");
    expect(q.claimDeposit(db, BOT, 8)).toBeNull(); // busy now
    expect(q.eventsFor(db, "deposit", id).map((e) => e.event)).toEqual(["claimed"]);
  });
  it("a bot with room to spare takes the biggest request it fits, at the request's size", () => {
    const small = insertDeposit("Small", "USSouth3", 1, 8);
    vi.advanceTimersByTime(10);
    const big = insertDeposit("Big", "USSouth3", 1, 16);
    botOnline(BOT, { freeSlots: 16 });
    // An empty backpack bot is the only kind that can serve the 16, so it
    // goes there first even though the 8 is older.
    expect(q.claimDeposit(db, BOT, 16)).toMatchObject({ requestId: big, itemCount: 16 });
    botOnline("botguid-bbbbbbbb", { freeSlots: 16 });
    expect(q.claimDeposit(db, "botguid-bbbbbbbb", 16)).toMatchObject({ requestId: small, itemCount: 8 });
    // A preferred row that is too big for the bot is passed over for the best fit.
    const other = insertDeposit("Other", "USSouth3", 1, 16);
    const fits = insertDeposit("Fits", "USSouth3", 1, 8);
    botOnline("botguid-cccccccc", { freeSlots: 8 });
    expect(q.claimDeposit(db, "botguid-cccccccc", 8, other)).toMatchObject({ requestId: fits, itemCount: 8 });
  });
  it("takes the preferred row when asked and it is still open, else the oldest", () => {
    const first = insertDeposit("Older");
    vi.advanceTimersByTime(10);
    const hinted = insertDeposit("Newer", "USSouth3", 1, 8, [{ itemId: "pdef", qty: 6 }]);
    botOnline();
    expect(q.claimDeposit(db, BOT, 8, hinted)?.requestId).toBe(hinted);
    expect(status("deposit_requests", first).status).toBe("pending");
    presence.setStatus(BOT, "idle", Date.now());
    expect(q.claimDeposit(db, BOT, 8, 999_999)?.requestId).toBe(first); // gone: fall back
  });
  it("lists what a depositor said they are bringing", () => {
    insertDeposit("Plain");
    insertDeposit("Hinted", "USSouth3", 1, 8, [{ itemId: "pdef", qty: 6 }, { itemId: "gpdef", qty: 2 }]);
    const deps = q.listPending(db).deposits;
    expect(deps.find((d) => !d.items)).toBeDefined();
    expect(deps.find((d) => d.items)?.items).toEqual([{ itemId: "pdef", qty: 6 }, { itemId: "gpdef", qty: 2 }]);
  });
  it("refuses a bot that is offline, busy, or on another server", () => {
    insertDeposit("Someone");
    expect(q.claimDeposit(db, BOT)).toBeNull();
    botOnline(BOT, { status: "busy" });
    expect(q.claimDeposit(db, BOT)).toBeNull();
    botOnline(BOT, { server: "EUWest" });
    expect(q.claimDeposit(db, BOT)).toBeNull();
    botOnline(BOT, { seasonal: false });
    expect(q.claimDeposit(db, BOT)).toBeNull();
  });
  it("one trade ends the deposit whatever it received, and credits every item that crossed", () => {
    const id = insertDeposit("Someone");
    botOnline();
    q.claimDeposit(db, BOT, 8);
    // One item into an 8-slot trade: done, no second bot.
    const r = q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 1 }], [{ itemId: "ubatk", enchants: 2 }]);
    expect(r).toMatchObject({ count: 1, remaining: 0, terminal: true, vaultFull: false });
    expect(status("deposit_requests", id).status).toBe("fulfilled");
    expect(db.prepare("SELECT remaining_count, current_cap FROM deposit_requests WHERE id = ?").get(id)).toEqual({ remaining_count: 0, current_cap: null });
    const tx = db.prepare("SELECT item_id, qty, enchants FROM transactions WHERE request_id = ?").all(id);
    expect(tx).toEqual([{ item_id: "ubatk", qty: 1, enchants: 2 }]);
    expect(presence.get(BOT)?.freeSlots).toBe(7);
    expect(q.eventsFor(db, "deposit", id).map((e) => e.event)).toEqual(["claimed", "fulfilled"]);

    // A full trade is just as done; and a backpack bot serving an 8-slot
    // trade may receive more than asked — the window is its whole
    // inventory — so everything that crossed is credited.
    const id2 = insertDeposit("Other");
    botOnline("botguid-bbbbbbbb", { freeSlots: 16 });
    expect(q.claimDeposit(db, "botguid-bbbbbbbb", 16)).toMatchObject({ requestId: id2, itemCount: 8 });
    const r2 = q.fulfillDeposit(db, "botguid-bbbbbbbb", id2, [{ itemId: "ubatk", qty: 6 }, { itemId: "patk", qty: 4 }]);
    expect(r2).toMatchObject({ count: 10, terminal: true });
    expect(status("deposit_requests", id2)).toEqual({ status: "fulfilled", claimed_by: "botguid-bbbbbbbb" });
    // More than any bot can hold is a broken report, not a trade.
    const id3 = insertDeposit("Third");
    botOnline("botguid-cccccccc", { freeSlots: 16 });
    q.claimDeposit(db, "botguid-cccccccc", 16);
    expect(() => q.fulfillDeposit(db, "botguid-cccccccc", id3, [{ itemId: "ubatk", qty: 25 }])).toThrow(/at most 24/);
  });
  it("flags the pool as full after the trade only when the whole fleet is out of room", () => {
    const id = insertDeposit("Someone", "USSouth3", 1, 1);
    botOnline(BOT, { freeSlots: 1 });
    q.claimDeposit(db, BOT, 1);
    // Presence alone would call the vault full here: this bot is about to be
    // out of slots and nobody else is online. The fleet knows better.
    presence.setPoolRoom({ seasonal: 40, nonseasonal: 0 });
    const r = q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 1 }]);
    expect(r).toMatchObject({ count: 1, terminal: true, vaultFull: false });
    expect(db.prepare("SELECT status, end_reason FROM deposit_requests WHERE id = ?").get(id)).toEqual({ status: "fulfilled", end_reason: null });

    const id2 = insertDeposit("Other", "USSouth3", 1, 1);
    botOnline("botguid-bbbbbbbb", { freeSlots: 1 });
    q.claimDeposit(db, "botguid-bbbbbbbb", 1);
    // The report predates the trade: the one slot it counts is the one this
    // trade just used.
    presence.setPoolRoom({ seasonal: 1, nonseasonal: 50 });
    const r2 = q.fulfillDeposit(db, "botguid-bbbbbbbb", id2, [{ itemId: "ubatk", qty: 1 }]);
    expect(r2).toMatchObject({ terminal: true, vaultFull: true });
    expect(db.prepare("SELECT status, end_reason FROM deposit_requests WHERE id = ?").get(id2)).toEqual({ status: "fulfilled", end_reason: "vault-full" });
  });
  it("falls back to the bots online when the fleet has not reported room", () => {
    const id = insertDeposit("Someone", "USSouth3", 1, 1);
    botOnline(BOT, { freeSlots: 1 });
    q.claimDeposit(db, BOT, 1);
    const r = q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 1 }]);
    expect(r).toMatchObject({ terminal: true, vaultFull: true });
  });
  it("never ages a pending deposit out, while a pending withdraw and a claimed deposit still do", () => {
    const small = insertDeposit("Small", "USSouth3", 1, 8);
    const big = insertDeposit("Big", "USSouth3", 1, 16);
    const wd = insertWithdraw("Taker", [{ itemId: "patk", qty: 1 }]);
    vi.advanceTimersByTime(4 * PENDING_TIMEOUT_MS);
    // Only the withdraw had a clock: a deposit waits for its bot, or for the fleet to say no account can take it.
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 1, claimedTimedOut: 0 });
    expect(status("withdraw_requests", wd).status).toBe("cancelled");
    expect(status("deposit_requests", small).status).toBe("pending");
    expect(status("deposit_requests", big).status).toBe("pending");
    botOnline();
    q.claimDeposit(db, BOT, 16);
    vi.advanceTimersByTime(CLAIMED_TIMEOUT_MS + 1);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 0, claimedTimedOut: 1 });
    expect(status("deposit_requests", big).status).toBe("cancelled");
    expect(q.eventsFor(db, "deposit", big).at(-1)).toMatchObject({ event: "expired", detail: { why: "claimed but never fulfilled" } });
  });
  it("rejects a fulfil from the wrong bot, beyond what a bot can hold, or with bad units", () => {
    const id = insertDeposit("Someone");
    botOnline();
    q.claimDeposit(db, BOT, 8);
    expect(() => q.fulfillDeposit(db, "other", id, [{ itemId: "ubatk", qty: 1 }])).toThrow(/different bot/);
    expect(() => q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 13 }, { itemId: "patk", qty: 12 }])).toThrow(/at most 24/);
    expect(() => q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 2 }], [{ itemId: "ubatk", enchants: 0 }])).toThrow(/reconcile/);
    expect(() => q.fulfillDeposit(db, BOT, 999, [{ itemId: "ubatk", qty: 1 }])).toThrow(/not found/);
  });
});

describe("withdraw lifecycle", () => {
  it("claims by inventory coverage, pins per-instance rows, fulfils with a ledger row", () => {
    const agg = insertWithdraw("Player", [{ itemId: "patk", qty: 2 }]);
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], [])).toBeNull();
    const a = q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 3 }], []);
    expect(a).toMatchObject({ kind: "withdraw", requestId: agg, instanceIds: null });
    expect(q.fulfillWithdraw(db, BOT, agg, [{ itemId: "patk", qty: 2 }])).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='withdraw'").get()).toEqual({ n: 1 });

    const pinned = insertWithdraw("Player", [{ itemId: "ubatk", qty: 1 }], { target: BOT, instanceIds: ["inst-1"] });
    presence.setStatus(BOT, "idle");
    expect(q.claimWithdraw(db, "botguid-bbbbbbbb", [{ itemId: "ubatk", qty: 1 }], ["inst-1"])).toBeNull();
    expect(q.claimWithdraw(db, BOT, [], ["inst-2"])).toBeNull();
    expect(q.claimWithdraw(db, BOT, [], ["inst-1"])).toMatchObject({ requestId: pinned, instanceIds: ["inst-1"] });
    expect(() => q.fulfillWithdraw(db, BOT, pinned, [{ itemId: "ubatk", qty: 1 }], [])).toThrow(/requires instanceIds/);
    expect(q.fulfillWithdraw(db, BOT, pinned, [{ itemId: "ubatk", qty: 1 }], ["inst-1"])).toMatchObject({ count: 1 });
  });
  it("serves one trade per player at a time", () => {
    const first = insertWithdraw("Player", [{ itemId: "patk", qty: 1 }]);
    vi.setSystemTime(Date.now() + 10);
    const second = insertWithdraw("Player", [{ itemId: "pdef", qty: 1 }]);
    botOnline();
    botOnline("botguid-bbbbbbbb");
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }, { itemId: "pdef", qty: 1 }], [])?.requestId).toBe(first);
    expect(q.listPending(db).withdraws).toEqual([]);
    expect(q.claimWithdraw(db, "botguid-bbbbbbbb", [{ itemId: "pdef", qty: 1 }], [])).toBeNull();
    q.fulfillWithdraw(db, BOT, first, [{ itemId: "patk", qty: 1 }]);
    expect(q.listPending(db).withdraws.map((w) => w.id)).toEqual([second]);
  });
});

describe("partial withdraw fulfils (chunked trades that broke off)", () => {
  it("credits what crossed and re-opens the row with the remainder", () => {
    const id = insertWithdraw("Player", [{ itemId: "patk", qty: 5 }, { itemId: "pdef", qty: 1 }]);
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 5 }, { itemId: "pdef", qty: 1 }], [])?.requestId).toBe(id);
    const r = q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 2 }]);
    expect(r).toMatchObject({ partial: true, remaining: [{ itemId: "patk", qty: 3 }, { itemId: "pdef", qty: 1 }] });
    expect(status("withdraw_requests", id)).toEqual({ status: "pending", claimed_by: null });
    expect(db.prepare("SELECT item_id, qty FROM transactions WHERE kind='withdraw' ORDER BY id").all()).toEqual([{ item_id: "patk", qty: 2 }]);
    expect(q.listPending(db).withdraws.map((w) => [w.id, w.items])).toEqual([[id, [{ itemId: "patk", qty: 3 }, { itemId: "pdef", qty: 1 }]]]);
    // The remainder is an ordinary pending row: claim it again and finish.
    presence.setStatus(BOT, "idle");
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 3 }, { itemId: "pdef", qty: 1 }], [])?.requestId).toBe(id);
    expect(q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 3 }, { itemId: "pdef", qty: 1 }])).toMatchObject({ partial: false, remaining: [] });
    expect(status("withdraw_requests", id).status).toBe("fulfilled");
    expect(db.prepare("SELECT SUM(qty) AS n FROM transactions WHERE kind='withdraw' AND item_id='patk'").get()).toEqual({ n: 5 });
    expect(q.eventsFor(db, "withdraw", id).map((e) => e.event)).toContain("partial");
  });
  it("re-opens a per-instance row with the instances not yet delivered", () => {
    const id = insertWithdraw("Player", [{ itemId: "ubatk", qty: 3 }], { target: BOT, instanceIds: ["i1", "i2", "i3"] });
    botOnline();
    expect(q.claimWithdraw(db, BOT, [], ["i1", "i2", "i3"])?.requestId).toBe(id);
    expect(q.fulfillWithdraw(db, BOT, id, [{ itemId: "ubatk", qty: 2 }], ["i1", "i2"])).toMatchObject({ partial: true, remaining: [{ itemId: "ubatk", qty: 1 }] });
    expect(q.listPending(db).withdraws[0]).toMatchObject({ id, instanceIds: ["i3"], targetBotGuid: BOT });
    presence.setStatus(BOT, "idle");
    expect(q.claimWithdraw(db, BOT, [], ["i3"])?.requestId).toBe(id);
    expect(q.fulfillWithdraw(db, BOT, id, [{ itemId: "ubatk", qty: 1 }], ["i3"])).toMatchObject({ partial: false });
  });
  it("still rejects reports that do not fit the request", () => {
    const id = insertWithdraw("Player", [{ itemId: "patk", qty: 2 }]);
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 2 }], []);
    expect(() => q.fulfillWithdraw(db, BOT, id, [{ itemId: "pdef", qty: 1 }])).toThrow(/shape/);
    expect(() => q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 3 }])).toThrow(/mismatch/);
    expect(status("withdraw_requests", id).status).toBe("claimed");
  });
});

describe("releases and expiry", () => {
  it("unclaim hands a row back; give-up cancels it; both are idempotent", () => {
    const id = insertDeposit("Someone");
    botOnline();
    q.claimDeposit(db, BOT, 8);
    expect(q.unclaim(db, BOT, id, "deposit")).toBe(true);
    expect(q.unclaim(db, BOT, id, "deposit")).toBe(false);
    expect(status("deposit_requests", id)).toEqual({ status: "pending", claimed_by: null });
    q.claimDeposit(db, BOT, 8);
    expect(q.giveUp(db, BOT, id, "deposit")).toBe(true);
    expect(status("deposit_requests", id).status).toBe("cancelled");
    expect(q.eventsFor(db, "deposit", id).map((e) => e.event)).toEqual(["claimed", "unclaimed", "claimed", "cancelled"]);
  });
  it("the fleet cancels a row it cannot serve, saying why: a pending one or its own claim, never another bot's or a swap row", () => {
    const dep = insertDeposit("Someone");
    expect(q.cancelRequest(db, null, dep, "deposit", "USSouth3 had a login queue")).toBe(true);
    expect(db.prepare("SELECT status, end_reason FROM deposit_requests WHERE id = ?").get(dep)).toEqual({ status: "cancelled", end_reason: "USSouth3 had a login queue" });
    expect(q.eventsFor(db, "deposit", dep).at(-1)).toMatchObject({ event: "cancelled", detail: { why: "USSouth3 had a login queue" } });
    expect(q.cancelRequest(db, null, dep, "deposit", "again")).toBe(false);
    // A row another bot is trading on is left to it; the bot's own claim goes.
    const wd = insertWithdraw("Player", [{ itemId: "patk", qty: 1 }]);
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], []);
    expect(q.cancelRequest(db, "botguid-other", wd, "withdraw", "no")).toBe(false);
    expect(q.cancelRequest(db, null, wd, "withdraw", "no")).toBe(false);
    expect(status("withdraw_requests", wd).status).toBe("claimed");
    expect(q.cancelRequest(db, BOT, wd, "withdraw", "USSouth3 had a login queue")).toBe(true);
    expect(status("withdraw_requests", wd)).toEqual({ status: "cancelled", claimed_by: null });
    expect(presence.get(BOT)?.status).toBe("idle");
    // A meeting's row lives by the hub's deadline.
    const swap = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-9"], swap: { rendezvousId: 46, role: "give", gets: [] } });
    expect(q.cancelRequest(db, null, swap, "withdraw", "no")).toBe(false);
    expect(status("withdraw_requests", swap).status).toBe("pending");
  });
  it("the sweep expires a claim the bot never finished and records why", () => {
    const id = insertWithdraw("Player", [{ itemId: "patk", qty: 1 }]);
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], []);
    vi.setSystemTime(Date.now() + CLAIMED_TIMEOUT_MS + 1);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 0, claimedTimedOut: 1 });
    expect(status("withdraw_requests", id).status).toBe("cancelled");
    expect(q.eventsFor(db, "withdraw", id).at(-1)).toMatchObject({ event: "expired", detail: { why: "claimed but never fulfilled" } });
  });
});

describe("communism through the fleet", () => {
  const COMMUNISM_BOT = "botguid-communism0";
  function insertCommunismDeposit(ign = "Comrade", itemCount = 8): number {
    const now = Date.now();
    return Number(db.prepare(
      `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, communism, created_at, updated_at)
       VALUES (?, ?, 'USSouth3', ?, ?, 'pending', ?, 1, 1, ?, ?)`,
    ).run(ign, ign.toLowerCase(), itemCount, itemCount, `g-c-${now}`, now, now).lastInsertRowid);
  }

  it("only a communism account claims a communism deposit, with whatever room it has, and never a pool deposit", () => {
    const id = insertCommunismDeposit();
    // A pool bot on the same server sees nothing to take.
    botOnline();
    expect(q.claimDeposit(db, BOT, 8)).toBeNull();
    // Communism account takes it, capped at its own free slots, and never the pool deposit.
    insertDeposit("Someone");
    botOnline(COMMUNISM_BOT, { freeSlots: 6, communism: true });
    const a = q.claimDeposit(db, COMMUNISM_BOT, 6);
    expect(a).toMatchObject({ kind: "deposit", requestId: id, itemCount: 6, communism: true });
    presence.setStatus(COMMUNISM_BOT, "idle");
    expect(q.claimDeposit(db, COMMUNISM_BOT, 6)).toBeNull();
    expect(q.listPending(db).deposits.map((d) => d.communism)).toEqual([false]);
  });
  it("a communism deposit lands on the ledger like a pool one and reports communism's own room", () => {
    const id = insertCommunismDeposit();
    botOnline(COMMUNISM_BOT, { freeSlots: 3, communism: true });
    expect(q.claimDeposit(db, COMMUNISM_BOT, 3)).toMatchObject({ itemCount: 3 });
    const r = q.fulfillDeposit(db, COMMUNISM_BOT, id, [{ itemId: "ubatk", qty: 2 }], [{ itemId: "ubatk", enchants: 0 }, { itemId: "ubatk", enchants: 1 }]);
    // Two of three: the one trade is done; communism account has a slot left.
    expect(r).toMatchObject({ count: 2, terminal: true, vaultFull: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind = 'deposit'").get()).toEqual({ n: 2 });
    // The last slot goes: the trade is done and communism is full.
    const id2 = insertCommunismDeposit();
    presence.setStatus(COMMUNISM_BOT, "idle");
    expect(q.claimDeposit(db, COMMUNISM_BOT, 1)).toMatchObject({ itemCount: 1 });
    const r2 = q.fulfillDeposit(db, COMMUNISM_BOT, id2, [{ itemId: "patk", qty: 1 }]);
    expect(r2).toMatchObject({ count: 1, terminal: true, vaultFull: true });
    expect(db.prepare("SELECT end_reason FROM deposit_requests WHERE id = ?").get(id2)).toEqual({ end_reason: "vault-full" });
  });
  it("a communism pick is pinned to communism account holding it and a pool pick never comes off one", () => {
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, communism, created_at, updated_at)
       VALUES ('Comrade', 'comrade', 'USSouth3', '[{"itemId":"ubatk","qty":1}]', 'pending', 'g-w', ?, '["free-1"]', 1, 1, ?, ?)`,
    ).run(COMMUNISM_BOT, now, now).lastInsertRowid);
    botOnline(COMMUNISM_BOT, { communism: true });
    const a = q.claimWithdraw(db, COMMUNISM_BOT, [{ itemId: "ubatk", qty: 1 }], ["free-1"]);
    expect(a).toMatchObject({ kind: "withdraw", requestId: id, instanceIds: ["free-1"], communism: true });
    q.fulfillWithdraw(db, COMMUNISM_BOT, id, [{ itemId: "ubatk", qty: 1 }], ["free-1"]);
    expect(status("withdraw_requests", id).status).toBe("fulfilled");
    // A pool withdraw by type is not communism account's to fill.
    const poolId = insertWithdraw("Other", [{ itemId: "ubatk", qty: 1 }]);
    presence.setStatus(COMMUNISM_BOT, "idle");
    expect(q.claimWithdraw(db, COMMUNISM_BOT, [{ itemId: "ubatk", qty: 1 }], [])).toBeNull();
    expect(status("withdraw_requests", poolId).status).toBe("pending");
  });
});

describe("advanced management (docs/relay/ADVANCED.md)", () => {
  const COMMUNISM_BOT = "botguid-communism0";
  const SECOND = "botguid-bbbbbbbb";
  const advanced = (o: { pool?: boolean; communism?: boolean }) => registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, pool: !!o.pool, communism: !!o.communism }));
  const emptyBot = (guid = BOT, over: Partial<Parameters<typeof presence.report>[0]> = {}) => botOnline(guid, { emptyOnly: true, capacity: 8, ...over });
  const depositRow = (id: number) => db.prepare("SELECT status, item_count, current_cap, continues, group_id, items_json, communism FROM deposit_requests WHERE id = ?").get(id) as { status: string; item_count: number; current_cap: number | null; continues: number; group_id: string; items_json: string | null; communism: number };
  function insertCommunismDeposit(ign = "Comrade", itemCount = 8): number {
    const now = Date.now();
    return Number(db.prepare(
      `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, communism, created_at, updated_at)
       VALUES (?, ?, 'USSouth3', ?, ?, 'pending', ?, 1, 1, ?, ?)`,
    ).run(ign, ign.toLowerCase(), itemCount, itemCount, `g-c-${ign}-${now}`, now, now).lastInsertRowid);
  }
  afterEach(() => registerAdvancedSettings(null));

  it("an empty character is the only intake: a bot holding anything claims no deposit", () => {
    const id = insertDeposit("Someone", "USSouth3", 1, 4);
    emptyBot(BOT, { capacity: 16 });
    // 12 of 16 free: something is on the character.
    expect(q.claimDeposit(db, BOT, 12)).toBeNull();
    expect(q.claimDeposit(db, BOT, 16)).toMatchObject({ requestId: id, itemCount: 4 });
    expect(depositRow(id)).toMatchObject({ status: "claimed", current_cap: 4, continues: 1 });
    // Without its trade slots the smallest character is assumed.
    insertDeposit("Other", "USSouth3", 1, 4);
    botOnline(SECOND, { emptyOnly: true });
    expect(q.claimDeposit(db, SECOND, 7)).toBeNull();
    expect(q.claimDeposit(db, SECOND, 8)).toMatchObject({ itemCount: 4 });
  });

  it("takes a deposit it fits whole first, the biggest then the oldest, else the oldest bigger one up to its room", () => {
    const huge = insertDeposit("Huge", "USSouth3", 1, 20);
    vi.advanceTimersByTime(10);
    const big = insertDeposit("Big", "USSouth3", 1, 16);
    vi.advanceTimersByTime(10);
    const small = insertDeposit("Small", "USSouth3", 1, 4);
    vi.advanceTimersByTime(10);
    const eight = insertDeposit("Eight", "USSouth3", 1, 8);
    emptyBot(BOT);
    expect(q.claimDeposit(db, BOT, 8)).toMatchObject({ requestId: eight, itemCount: 8 });
    emptyBot(SECOND);
    expect(q.claimDeposit(db, SECOND, 8)).toMatchObject({ requestId: small, itemCount: 4 });
    // Nothing fits an 8-slot character whole any more: the oldest bigger one, capped at its room.
    emptyBot("botguid-cccccccc");
    expect(q.claimDeposit(db, "botguid-cccccccc", 8)).toMatchObject({ requestId: huge, itemCount: 8 });
    // A preferred row is taken whatever its size.
    emptyBot("botguid-dddddddd", { capacity: 24 });
    expect(q.claimDeposit(db, "botguid-dddddddd", 24, big)).toMatchObject({ requestId: big, itemCount: 16 });
  });

  it("a deposit bigger than the character continues on the next empty one, in the same group", () => {
    const heard: number[] = [];
    const off = q.onPendingChange(() => heard.push(1));
    const id = insertDeposit("Someone", "USSouth3", 1, 20, [{ itemId: "patk", qty: 12 }, { itemId: "pdef", qty: 8 }]);
    // The fleet's room report: other empty characters wait for the rest.
    presence.setPoolRoom({ seasonal: 40, nonseasonal: 0 });
    emptyBot(BOT);
    expect(q.claimDeposit(db, BOT, 8)).toMatchObject({ requestId: id, itemCount: 8 });
    const r = q.fulfillDeposit(db, BOT, id, [{ itemId: "patk", qty: 8 }]);
    expect(r).toMatchObject({ count: 8, remaining: 12, terminal: false });
    const next = r.continuedAs!;
    expect(depositRow(id).status).toBe("fulfilled");
    // The rest, still saying what is left to bring.
    expect(depositRow(next)).toMatchObject({ status: "pending", item_count: 12, continues: 0, group_id: depositRow(id).group_id, items_json: '[{"itemId":"patk","qty":4},{"itemId":"pdef","qty":8}]', communism: 0 });
    expect(q.eventsFor(db, "deposit", next).map((e) => e.event)).toEqual(["continued"]);
    expect(heard.length).toBe(1);
    // It is the player's next trade, and the next empty bot takes it (a 16-slot one: all of it).
    expect(q.listPending(db).deposits.map((d) => [d.id, d.itemCount])).toEqual([[next, 12]]);
    emptyBot(SECOND, { capacity: 16 });
    expect(q.claimDeposit(db, SECOND, 16)).toMatchObject({ requestId: next, itemCount: 12 });
    expect(q.fulfillDeposit(db, SECOND, next, [{ itemId: "pdef", qty: 12 }])).toMatchObject({ remaining: 0, terminal: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deposit_requests").get()).toEqual({ n: 2 });
    off();
  });

  it("ends the deposit as before when the player under-fills the trade, cancelled it, or the pool is out of room", () => {
    presence.setPoolRoom({ seasonal: 40, nonseasonal: 0 });
    const under = insertDeposit("Under", "USSouth3", 1, 20);
    emptyBot(BOT);
    q.claimDeposit(db, BOT, 8);
    expect(q.fulfillDeposit(db, BOT, under, [{ itemId: "patk", qty: 5 }])).toMatchObject({ remaining: 0, terminal: true });
    const cancelled = insertDeposit("Cancelled", "USSouth3", 1, 20);
    presence.setStatus(BOT, "idle");
    q.claimDeposit(db, BOT, 8);
    db.prepare("UPDATE deposit_requests SET status = 'cancelled' WHERE id = ?").run(cancelled);
    expect(q.fulfillDeposit(db, BOT, cancelled, [{ itemId: "patk", qty: 8 }])).toMatchObject({ terminal: true });
    const full = insertDeposit("Full", "USSouth3", 1, 20);
    presence.setStatus(BOT, "idle");
    q.claimDeposit(db, BOT, 8);
    presence.setPoolRoom({ seasonal: 8, nonseasonal: 0 });
    expect(q.fulfillDeposit(db, BOT, full, [{ itemId: "patk", qty: 8 }])).toMatchObject({ terminal: true, vaultFull: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deposit_requests WHERE status = 'pending'").get()).toEqual({ n: 0 });
  });

  it("a claim without emptyOnly never continues, whatever it was claimed for", () => {
    const id = insertCommunismDeposit("Comrade", 12);
    botOnline(COMMUNISM_BOT, { freeSlots: 6, communism: true });
    expect(q.claimDeposit(db, COMMUNISM_BOT, 6)).toMatchObject({ requestId: id, itemCount: 6 });
    expect(depositRow(id).continues).toBe(0);
    expect(q.fulfillDeposit(db, COMMUNISM_BOT, id, [{ itemId: "patk", qty: 6 }])).toMatchObject({ remaining: 0, terminal: true });
  });

  it("communism: a bot with only a few free slots takes no deposit; an empty one takes it up to its room and the rest continues", () => {
    const id = insertCommunismDeposit("Comrade", 12);
    botOnline(COMMUNISM_BOT, { freeSlots: 3, communism: true, emptyOnly: true, capacity: 8 });
    expect(q.claimDeposit(db, COMMUNISM_BOT, 3)).toBeNull();
    // A pool bot never takes it, empty or not.
    emptyBot(BOT);
    expect(q.claimDeposit(db, BOT, 8)).toBeNull();
    botOnline("botguid-communism1", { communism: true, emptyOnly: true, capacity: 8 });
    presence.setPoolRoom({ seasonal: 0, nonseasonal: 0, communism: { seasonal: 16, nonseasonal: 0 } });
    expect(q.claimDeposit(db, "botguid-communism1", 8)).toMatchObject({ requestId: id, itemCount: 8, communism: true });
    const r = q.fulfillDeposit(db, "botguid-communism1", id, [{ itemId: "patk", qty: 8 }]);
    expect(depositRow(r.continuedAs!)).toMatchObject({ status: "pending", item_count: 4, communism: 1 });
  });

  it("a communism row is never claimed by a pool bot, even one by type", () => {
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, seasonal, communism, created_at, updated_at)
       VALUES ('Comrade', 'comrade', 'USSouth3', '[{"itemId":"patk","qty":1}]', 'pending', 'g-w', NULL, 1, 1, ?, ?)`,
    ).run(now, now).lastInsertRowid);
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 3 }], [])).toBeNull();
    botOnline(COMMUNISM_BOT, { communism: true });
    expect(q.claimWithdraw(db, COMMUNISM_BOT, [{ itemId: "patk", qty: 3 }], [])).toMatchObject({ requestId: id, communism: true });
  });

  it("lists each player's next withdraw after the one served now as upcoming, only for a pool whose switch is on", () => {
    const first = insertWithdraw("Many", [{ itemId: "patk", qty: 8 }], { target: BOT });
    vi.advanceTimersByTime(10);
    const second = insertWithdraw("Many", [{ itemId: "patk", qty: 8 }], { target: SECOND });
    vi.advanceTimersByTime(10);
    insertWithdraw("Many", [{ itemId: "patk", qty: 2 }], { target: SECOND });
    vi.advanceTimersByTime(10);
    const single = insertWithdraw("Single", [{ itemId: "pdef", qty: 1 }], { target: BOT });
    const view = () => q.listPending(db).withdraws.map((w) => [w.id, !!w.upcoming, w.headClaimed ?? null]);
    // Off: exactly the rows a bot could claim now.
    expect(view()).toEqual([[first, false, null], [single, false, null]]);
    advanced({ communism: true });
    expect(view()).toEqual([[first, false, null], [single, false, null]]);
    advanced({ pool: true });
    expect(view()).toEqual([[first, false, null], [single, false, null], [second, true, false]]);
    // The head is being traded: the next row is still upcoming, and says so.
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 8 }], [])).toMatchObject({ requestId: first });
    expect(view()).toEqual([[single, false, null], [second, true, true]]);
  });

  it("a promoted row's wait counts from when the row before it ended, under advanced management only", () => {
    const first = insertWithdraw("Slow", [{ itemId: "patk", qty: 8 }], { target: BOT });
    const second = insertWithdraw("Slow", [{ itemId: "patk", qty: 8 }], { target: BOT });
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 60_000);
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 16 }], []);
    q.fulfillWithdraw(db, BOT, first, [{ itemId: "patk", qty: 8 }]);
    // Made 11 minutes ago, head for one.
    vi.advanceTimersByTime(2 * 60_000);
    advanced({ pool: true });
    expect(sweepStaleRequests(db).pendingTimedOut).toBe(0);
    expect(status("withdraw_requests", second).status).toBe("pending");
    // Nothing of the player's moves for the whole timeout: it goes.
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS);
    expect(sweepStaleRequests(db).pendingTimedOut).toBe(1);
    // Off: the clock runs from the request, as before.
    const a = insertWithdraw("Again", [{ itemId: "patk", qty: 8 }], { target: BOT });
    const b = insertWithdraw("Again", [{ itemId: "patk", qty: 8 }], { target: BOT });
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 60_000);
    presence.setStatus(BOT, "idle");
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 16 }], []);
    q.fulfillWithdraw(db, BOT, a, [{ itemId: "patk", qty: 8 }]);
    vi.advanceTimersByTime(2 * 60_000);
    registerAdvancedSettings(null);
    expect(sweepStaleRequests(db).pendingTimedOut).toBe(1);
    expect(status("withdraw_requests", b).status).toBe("cancelled");
  });

  it("picks on the account's other characters don't hold back a by-type row when the fleet says what the played character holds", () => {
    // One withdraw served by one account: by type off the character (after a vault fetch), then 2 picked off character 8.
    const r1 = insertWithdraw("Many", [{ itemId: "patk", qty: 8 }], { target: BOT });
    insertWithdraw("Many", [{ itemId: "patk", qty: 2 }], { target: BOT, instanceIds: ["c8-1", "c8-2"] });
    botOnline();
    const onCharacter = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const held = Object.fromEntries(onCharacter.map((id) => [id, "patk"]));
    // Without the map every pick pinned to the bot counts against its copies, as before.
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 8 }], onCharacter)).toBeNull();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 8 }], onCharacter, held)).toMatchObject({ requestId: r1 });
    // A pick that is on the played character still does.
    q.unclaim(db, BOT, r1, "withdraw");
    insertWithdraw("Picker", [{ itemId: "patk", qty: 1 }], { target: BOT, instanceIds: ["p0"] });
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 8 }], onCharacter, held)?.requestId).not.toBe(r1);
  });

  it("an account no longer set aside for communism still hands over the communism picks pinned to it", () => {
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, communism, created_at, updated_at)
       VALUES ('Comrade', 'comrade', 'USSouth3', '[{"itemId":"ubatk","qty":1}]', 'pending', 'g-w', ?, '["free-1"]', 1, 1, ?, ?)`,
    ).run(BOT, now, now).lastInsertRowid);
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "ubatk", qty: 1 }], ["free-1"])).toMatchObject({ requestId: id, communism: true });
  });

  it("a deposit continuing on the next bot goes before a withdraw the player queued meanwhile", () => {
    advanced({ pool: true });
    presence.setPoolRoom({ seasonal: 40, nonseasonal: 0 });
    const dep = insertDeposit("Someone", "USSouth3", 1, 16);
    emptyBot(BOT);
    q.claimDeposit(db, BOT, 8);
    const wd = insertWithdraw("Someone", [{ itemId: "pdef", qty: 1 }], { target: SECOND });
    const next = q.fulfillDeposit(db, BOT, dep, [{ itemId: "patk", qty: 8 }]).continuedAs!;
    // The rest of the deposit is still in their inventory: the withdraw waits, listed as the one coming up.
    expect(q.listPending(db).withdraws.map((w) => [w.id, !!w.upcoming, w.headClaimed])).toEqual([[wd, true, false]]);
    botOnline(SECOND);
    expect(q.claimWithdraw(db, SECOND, [{ itemId: "pdef", qty: 1 }], [])).toBeNull();
    emptyBot("botguid-cccccccc");
    expect(q.claimDeposit(db, "botguid-cccccccc", 8)).toMatchObject({ requestId: next });
    expect(q.fulfillDeposit(db, "botguid-cccccccc", next, [{ itemId: "patk", qty: 8 }])).toMatchObject({ terminal: true });
    expect(q.claimWithdraw(db, SECOND, [{ itemId: "pdef", qty: 1 }], [])).toMatchObject({ requestId: wd });
  });

  it("tells the fleet when a pending row appears: a remainder re-opened, a row handed back, a swap side queued", () => {
    let heard = 0;
    const off = q.onPendingChange(() => heard++);
    const id = insertWithdraw("Part", [{ itemId: "patk", qty: 4 }], { target: BOT });
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 4 }], []);
    q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 1 }]);
    expect(heard).toBe(1);
    presence.setStatus(BOT, "idle");
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 4 }], []);
    q.unclaim(db, BOT, id, "withdraw");
    expect(heard).toBe(2);
    q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "Partner", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["i1"], swap: { rendezvousId: 1, role: "give", gets: [] } });
    expect(heard).toBe(3);
    // A listener that throws does not break the queue.
    const off2 = q.onPendingChange(() => {
      throw new Error("boom");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => q.unclaim(db, BOT, id, "withdraw")).not.toThrow();
    spy.mockRestore();
    off2();
    off();
  });
});
