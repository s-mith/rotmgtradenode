// Request transitions against an in-memory database and in-memory presence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import * as q from "../queue";
import { sweepStaleRequests, BIG_PENDING_TIMEOUT_MS, CLAIMED_TIMEOUT_MS, PENDING_TIMEOUT_MS } from "../timeouts";
import { userForIgn } from "../users";
import { ensureVaultBot, vaultBotGuids, vaultCount } from "../vault";

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
    expect(() => q.fulfillDeposit(db, "botguid-cccccccc", id3, [{ itemId: "ubatk", qty: 17 }])).toThrow(/at most 16/);
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
  it("gives a 16-slot deposit twice as long to find its bot before it ages out", () => {
    const small = insertDeposit("Small", "USSouth3", 1, 8);
    const big = insertDeposit("Big", "USSouth3", 1, 16);
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS + 1000);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 1, claimedTimedOut: 0 });
    expect(status("deposit_requests", small).status).toBe("cancelled");
    expect(status("deposit_requests", big).status).toBe("pending");
    vi.advanceTimersByTime(BIG_PENDING_TIMEOUT_MS - PENDING_TIMEOUT_MS);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 1, claimedTimedOut: 0 });
    expect(status("deposit_requests", big).status).toBe("cancelled");
  });
  it("rejects a fulfil from the wrong bot, beyond what a bot can hold, or with bad units", () => {
    const id = insertDeposit("Someone");
    botOnline();
    q.claimDeposit(db, BOT, 8);
    expect(() => q.fulfillDeposit(db, "other", id, [{ itemId: "ubatk", qty: 1 }])).toThrow(/different bot/);
    expect(() => q.fulfillDeposit(db, BOT, id, [{ itemId: "ubatk", qty: 9 }, { itemId: "patk", qty: 8 }])).toThrow(/at most 16/);
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

describe("personal storage through the fleet", () => {
  const VAULT_BOT = "botguid-vault000";
  function vaultUser(ign = "Hoarder") {
    const userId = userForIgn(db, ign, ign.toLowerCase());
    expect(ensureVaultBot(db, userId, true, [VAULT_BOT], Date.now())).toBe(VAULT_BOT);
    return userId;
  }
  function insertVaultDeposit(userId: number, ign = "Hoarder", itemCount = 8): number {
    const now = Date.now();
    return Number(db.prepare(
      `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, vault_user_id, created_at, updated_at)
       VALUES (?, ?, 'USSouth3', ?, ?, 'pending', ?, 1, ?, ?, ?)`,
    ).run(ign, ign.toLowerCase(), itemCount, itemCount, `g-v-${now}`, userId, now, now).lastInsertRowid);
  }

  it("only the account's vault bot claims its vault deposit, capped at the slots left", () => {
    const userId = vaultUser();
    const id = insertVaultDeposit(userId);
    // A pool bot on the same server sees nothing to take.
    botOnline();
    expect(q.claimDeposit(db, BOT, 8)).toBeNull();
    // The vault bot takes it, and never a pool deposit.
    insertDeposit("Someone");
    botOnline(VAULT_BOT, { freeSlots: 8 });
    db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES ('held-1', ?, 'ubatk', 0, 1, ?, 'claim', 1), ('held-2', ?, 'ubatk', 0, 1, ?, 'claim', 1)").run(userId, VAULT_BOT, userId, VAULT_BOT);
    const a = q.claimDeposit(db, VAULT_BOT, 8);
    expect(a).toMatchObject({ kind: "deposit", requestId: id, itemCount: 6, vault: userId });
    expect(q.listPending(db).vaultBots).toEqual([VAULT_BOT]);
  });
  it("a vault deposit records the received instances off the ledger and ends when the slots run out", () => {
    const userId = vaultUser();
    db.prepare("UPDATE vault_halves SET slots = 3 WHERE user_id = ? AND seasonal = 1").run(userId);
    const id = insertVaultDeposit(userId);
    botOnline(VAULT_BOT, { freeSlots: 8 });
    expect(q.claimDeposit(db, VAULT_BOT, 8)).toMatchObject({ itemCount: 3 });
    const r = q.fulfillDeposit(db, VAULT_BOT, id, [{ itemId: "ubatk", qty: 2 }], [{ itemId: "ubatk", enchants: 0 }, { itemId: "ubatk", enchants: 1 }],
      [{ instanceId: "new-1", itemId: "ubatk", enchants: 0 }, { instanceId: "new-2", itemId: "ubatk", enchants: 1 }]);
    // Two of three: the one trade is done, and there is still room for another.
    expect(r).toMatchObject({ count: 2, terminal: true, vaultFull: false });
    expect(vaultCount(db, userId)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT instance_id, source, bot_guid FROM vault_items ORDER BY instance_id").all()).toEqual([
      { instance_id: "new-1", source: "deposit", bot_guid: VAULT_BOT },
      { instance_id: "new-2", source: "deposit", bot_guid: VAULT_BOT },
    ]);
    // A second deposit fills the last slot: the trade is done and the vault is now full.
    const id2 = insertVaultDeposit(userId);
    presence.setStatus(VAULT_BOT, "idle");
    expect(q.claimDeposit(db, VAULT_BOT, 6)).toMatchObject({ itemCount: 1 });
    const r2 = q.fulfillDeposit(db, VAULT_BOT, id2, [{ itemId: "patk", qty: 1 }], null, [{ instanceId: "new-3", itemId: "patk", enchants: 0 }]);
    expect(r2).toMatchObject({ count: 1, terminal: true, vaultFull: true });
    expect(db.prepare("SELECT end_reason FROM deposit_requests WHERE id = ?").get(id2)).toEqual({ end_reason: "vault-full" });
    // Nothing left to give: the vault bot claims nothing more.
    presence.setStatus(VAULT_BOT, "idle");
    insertVaultDeposit(userId);
    expect(q.claimDeposit(db, VAULT_BOT, 5)).toBeNull();
  });
  it("a vault withdraw hands the items back off the ledger and frees the bot when the vault empties", () => {
    const userId = vaultUser();
    db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES ('mine-1', ?, 'ubatk', 0, 1, ?, 'claim', 1)").run(userId, VAULT_BOT);
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, vault_user_id, created_at, updated_at)
       VALUES ('Hoarder', 'hoarder', 'USSouth3', '[{"itemId":"ubatk","qty":1}]', 'pending', 'g-w', ?, '["mine-1"]', 1, ?, ?, ?)`,
    ).run(VAULT_BOT, userId, now, now).lastInsertRowid);
    botOnline(VAULT_BOT);
    const a = q.claimWithdraw(db, VAULT_BOT, [{ itemId: "ubatk", qty: 1 }], ["mine-1"]);
    expect(a).toMatchObject({ kind: "withdraw", requestId: id, instanceIds: ["mine-1"], vault: userId });
    q.fulfillWithdraw(db, VAULT_BOT, id, [{ itemId: "ubatk", qty: 1 }], ["mine-1"]);
    expect(vaultCount(db, userId)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    expect(vaultBotGuids(db).size).toBe(0);
    expect(status("withdraw_requests", id).status).toBe("fulfilled");
  });
});
