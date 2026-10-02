// The item pipeline's review fixes: by-type withdraws vs picks, fulfils that
// land after a cancel, remainders, end reasons, and limits tied to the fleet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import * as q from "../queue";
import { picksOverCommitted, reservedInstanceIds } from "../reservations";
import { cancelOpenRequests, maxOpenWithdraws, recentlyEndedGroupsFor } from "../cancelCode";
import { withdrawGroupStatus } from "../withdrawStatus";
import { sweepStaleRequests, CLAIMED_TIMEOUT_MS, PENDING_TIMEOUT_MS } from "../timeouts";
import { isTellTo, playerReason } from "../../relay/fleet/dispatcher";

let db: Database.Database;
const BOT = "botguid-aaaaaaaa";

function insertWithdraw(ign: string, items: (q.ItemQty & { enchants?: number })[], opts: { target?: string; instanceIds?: string[]; group?: string } = {}): number {
  const now = Date.now();
  return Number(db.prepare(
    `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at)
     VALUES (?, ?, 'USSouth3', ?, 'pending', ?, ?, ?, 1, ?, ?)`,
  ).run(ign, ign.toLowerCase(), JSON.stringify(items), opts.group ?? `g-${ign}-${now}-${Math.random()}`, opts.target ?? BOT, opts.instanceIds ? JSON.stringify(opts.instanceIds) : null, now, now).lastInsertRowid);
}
function botOnline(guid = BOT) {
  presence.report({ botGuid: guid, alias: "A", ign: "BotIgn", server: "USSouth3", freeSlots: 8, status: "idle", seasonal: true });
}
const row = (id: number) => db.prepare("SELECT status, claimed_by, end_reason, items_json, created_at FROM withdraw_requests WHERE id = ?").get(id) as { status: string; claimed_by: string | null; end_reason: string | null; items_json: string; created_at: number };
const ledger = (id: number) => db.prepare("SELECT item_id, qty, enchants FROM transactions WHERE request_id = ? ORDER BY id").all(id);

beforeEach(() => {
  db = openDatabase(":memory:");
  presence.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
  delete process.env.MAX_OPEN_WITHDRAWS;
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  delete process.env.MAX_OPEN_WITHDRAWS;
});

describe("by-type withdraws and picks share a bot's copies", () => {
  it("a by-type claim leaves picked copies out of its count and names them for the offer", () => {
    const pick = insertWithdraw("Picker", [{ itemId: "patk", qty: 1 }], { instanceIds: ["i1"] });
    db.prepare("UPDATE withdraw_requests SET status = 'claimed', claimed_by = 'other' WHERE id = ?").run(pick);
    const bulk = insertWithdraw("Bulk", [{ itemId: "patk", qty: 1 }]);
    botOnline();
    // Two copies, one picked: the by-type row may take the other, never i1.
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 2 }], ["i1", "i2"])).toMatchObject({ requestId: bulk, instanceIds: null, keepInstanceIds: ["i1"] });
  });

  it("a by-type row can't claim when every copy is picked", () => {
    insertWithdraw("Picker", [{ itemId: "patk", qty: 1 }], { instanceIds: ["i1"], target: "elsewhere" });
    db.prepare("UPDATE withdraw_requests SET target_bot_guid = ? WHERE id = 1").run(BOT);
    db.prepare("UPDATE withdraw_requests SET status = 'claimed', claimed_by = 'other' WHERE id = 1").run();
    insertWithdraw("Bulk", [{ itemId: "patk", qty: 1 }]);
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i1"])).toBeNull();
  });

  it("a pick is refused when by-type rows have promised every copy", () => {
    insertWithdraw("Bulk", [{ itemId: "patk", qty: 2 }]);
    const stock = new Map([[BOT, new Map([["patk", 2]])]]);
    expect(picksOverCommitted(db, [{ bot_guid: BOT, item_id: "patk", stored: null }], stock)).toBe("patk");
    stock.get(BOT)!.set("patk", 3);
    expect(picksOverCommitted(db, [{ bot_guid: BOT, item_id: "patk", stored: null }], stock)).toBeNull();
    // A pick on another character is out of reach of by-type rows.
    stock.get(BOT)!.set("patk", 2);
    expect(picksOverCommitted(db, [{ bot_guid: BOT, item_id: "patk", stored: { charId: 5 } }], stock)).toBeNull();
  });
});

describe("a cancel that lands mid-trade", () => {
  it("still records a withdraw the bot finished, and keeps its items reserved meanwhile", () => {
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { instanceIds: ["i1"] });
    botOnline();
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i1"])?.requestId).toBe(id);
    cancelOpenRequests(db, "someone");
    expect(row(id)).toMatchObject({ status: "cancelled", claimed_by: BOT, end_reason: "cancelled by player" });
    expect(reservedInstanceIds(db).has("i1")).toBe(true);
    q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 1 }], ["i1"]);
    expect(row(id).status).toBe("fulfilled");
    expect(ledger(id)).toEqual([{ item_id: "patk", qty: 1, enchants: 0 }]);
  });

  it("releases the reservation once the trade can no longer be running", () => {
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { instanceIds: ["i1"] });
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i1"]);
    cancelOpenRequests(db, "someone");
    vi.advanceTimersByTime(CLAIMED_TIMEOUT_MS + 1);
    expect(reservedInstanceIds(db).has("i1")).toBe(false);
    expect(row(id).status).toBe("cancelled");
  });

  it("credits a deposit that completed after the player cancelled it", () => {
    const now = Date.now();
    const id = Number(db.prepare(
      `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, created_at, updated_at)
       VALUES ('Someone', 'someone', 'USSouth3', 8, 8, 'pending', 'gd', 1, ?, ?)`,
    ).run(now, now).lastInsertRowid);
    botOnline();
    expect(q.claimDeposit(db, BOT, 8)?.requestId).toBe(id);
    cancelOpenRequests(db, "someone");
    q.fulfillDeposit(db, BOT, id, [{ itemId: "patk", qty: 2 }]);
    expect((db.prepare("SELECT status FROM deposit_requests WHERE id = ?").get(id) as { status: string }).status).toBe("fulfilled");
    expect(ledger(id)).toEqual([{ item_id: "patk", qty: 2, enchants: 0 }]);
  });

  it("a row the fleet itself gave up on stays refused", () => {
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { instanceIds: ["i1"] });
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i1"]);
    q.giveUp(db, BOT, id, "withdraw", "no trade window 20s after the request");
    expect(() => q.fulfillWithdraw(db, BOT, id, [{ itemId: "patk", qty: 1 }], ["i1"])).toThrow("Request cancelled");
  });
});

describe("remainders and the ledger", () => {
  it("carries a partial delivery across entries of one item at different enchant levels", () => {
    expect(q.splitDelivered([{ itemId: "ubatk", qty: 1, enchants: 0 }, { itemId: "ubatk", qty: 1, enchants: 2 }], new Map([["ubatk", 1]]))).toEqual({
      delivered: [{ itemId: "ubatk", qty: 1, enchants: 0 }],
      remaining: [{ itemId: "ubatk", qty: 1, enchants: 2 }],
    });
  });

  it("writes each entry's own enchant count and restarts the remainder's pending clock", () => {
    const id = insertWithdraw("Someone", [{ itemId: "ubatk", qty: 1, enchants: 0 }, { itemId: "ubatk", qty: 1, enchants: 2 }, { itemId: "patk", qty: 1 }]);
    botOnline();
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 1000);
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "ubatk", qty: 2 }, { itemId: "patk", qty: 1 }], []);
    q.fulfillWithdraw(db, BOT, id, [{ itemId: "ubatk", qty: 1 }, { itemId: "patk", qty: 1 }]);
    expect(JSON.parse(row(id).items_json)).toEqual([{ itemId: "ubatk", qty: 1, enchants: 2 }]);
    expect(row(id).created_at).toBe(Date.now());
    vi.advanceTimersByTime(2000);
    sweepStaleRequests(db);
    expect(row(id).status).toBe("pending");
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "ubatk", qty: 1 }], []);
    q.fulfillWithdraw(db, BOT, id, [{ itemId: "ubatk", qty: 1 }]);
    expect(ledger(id)).toEqual([
      { item_id: "ubatk", qty: 1, enchants: 0 },
      { item_id: "patk", qty: 1, enchants: 0 },
      { item_id: "ubatk", qty: 1, enchants: 2 },
    ]);
  });

  it("takes a full trade's worth of lines in one fulfil", () => {
    const ids = ["patk", "pdef", "pspd", "pvit", "pwis", "pdex", "plife", "pmana", "gpatk", "gpdef", "gpspd", "gpvit", "gpwis", "gpdex", "gplife", "gpmana", "ubatk"];
    const items = ids.map((itemId) => ({ itemId, qty: 1 }));
    const id = insertWithdraw("Someone", items);
    botOnline();
    q.claimWithdraw(db, BOT, items, []);
    expect(q.fulfillWithdraw(db, BOT, id, items).partial).toBe(false);
  });
});

describe("why a request ended", () => {
  it("keeps the bot's reason, shows it in the group status and in the player's list", () => {
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { group: "grp-1" });
    botOnline();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], []);
    const why = playerReason("no trade window 20s after the request");
    q.giveUp(db, BOT, id, "withdraw", why);
    expect(row(id).end_reason).toBe(why);
    expect(why).toMatch(/seasonal or non-seasonal/);
    return withdrawGroupStatus(db, "grp-1").then((s) => {
      expect(s).toMatchObject({ groupStatus: "cancelled", endReason: why, trades: [{ requestId: id, status: "cancelled", endReason: why }] });
      expect(recentlyEndedGroupsFor(db, "someone").map((g) => g.groupId)).toEqual(["grp-1"]);
    });
  });

  it("leaves out the player's own cancels and old endings", () => {
    insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { group: "mine" });
    cancelOpenRequests(db, "someone");
    expect(recentlyEndedGroupsFor(db, "someone")).toEqual([]);
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }], { group: "old" });
    q.cancelRequest(db, null, id, "withdraw", "no account on this node can take it");
    expect(recentlyEndedGroupsFor(db, "someone").map((g) => g.groupId)).toEqual(["old"]);
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(recentlyEndedGroupsFor(db, "someone")).toEqual([]);
  });

  it("the stale sweep says why too", () => {
    const id = insertWithdraw("Someone", [{ itemId: "patk", qty: 1 }]);
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS + 1);
    sweepStaleRequests(db);
    expect(row(id)).toMatchObject({ status: "cancelled", end_reason: "pending too long" });
  });
});

describe("limits tied to the fleet", () => {
  it("open withdraws follow the bots the proxies allow online, with an operator override", () => {
    expect(maxOpenWithdraws()).toBe(1);
    presence.setOnlineCap(6);
    expect(maxOpenWithdraws()).toBe(6);
    process.env.MAX_OPEN_WITHDRAWS = "2";
    expect(maxOpenWithdraws()).toBe(2);
    process.env.MAX_OPEN_WITHDRAWS = "0";
    expect(maxOpenWithdraws()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("login codes", () => {
  it("count only from a tell addressed to the bot", () => {
    expect(isTellTo("RottingMeat", "RottingMeat")).toBe(true);
    expect(isTellTo("rottingmeat", "RottingMeat")).toBe(true);
    expect(isTellTo("", "RottingMeat")).toBe(false);
    expect(isTellTo("SomeoneElse", "RottingMeat")).toBe(false);
    expect(isTellTo("RottingMeat", "")).toBe(false);
  });
});

describe("room across the seasonal split", () => {
  it("counts other-side characters of pool accounts on the side asked for", async () => {
    const { acrossRoomFor } = await import("../capacity");
    const across = { a: { seasonal: true, slots: 16, used: 8 }, b: { seasonal: false, slots: 8, used: 0 }, c: { seasonal: true, slots: 8, used: 1 } };
    expect(acrossRoomFor(across, "seasonal")).toEqual({ bots: 2, slots: 24, used: 9 });
    expect(acrossRoomFor(across, "seasonal", (g) => g === "c")).toEqual({ bots: 1, slots: 16, used: 8 });
    expect(acrossRoomFor(undefined, "nonseasonal")).toEqual({ bots: 0, slots: 0, used: 0 });
  });
});
