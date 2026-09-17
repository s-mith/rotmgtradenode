// Swap rows on the withdraw queue (design doc §6.2): queued like a
// per-instance withdraw, claimed only by the holder, closed by reportSwap
// with no ledger row, and heard by the coordinator.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import { reservedInstanceIds } from "../vault";
import * as q from "../queue";

let db: Database.Database;
const BOT = "botguid-swapper-aaaaaaaa";
beforeEach(() => {
  db = openDatabase(":memory:");
  presence.report({ botGuid: BOT, alias: "S", ign: "SwapBot", server: "USSouth3", freeSlots: 8, status: "idle", seasonal: true });
});
afterEach(() => db.close());

describe("swap jobs", () => {
  it("is routed to the holder, claimed by it, and closed without a ledger row", () => {
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-1"], swap: { rendezvousId: 42, role: "give", gets: [{ itemId: "pdef", qty: 1 }] } });
    const pending = q.listPending(db);
    expect(pending.withdraws).toHaveLength(1);
    expect(pending.withdraws[0]).toMatchObject({ id, targetBotGuid: BOT, instanceIds: ["inst-1"], swap: { rendezvousId: 42, role: "give", gets: [{ itemId: "pdef", qty: 1 }] } });
    expect(reservedInstanceIds(db).has("inst-1")).toBe(true);
    // Another bot holding the same catalog item can't take it: the instance is pinned.
    expect(q.claimWithdraw(db, "other-bot", [{ itemId: "patk", qty: 1 }], [])).toBeNull();
    const a = q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["inst-1"]);
    expect(a).toMatchObject({ kind: "withdraw", requestId: id, ign: "TheirBot", swap: { role: "give" } });
    const heard: unknown[] = [];
    const off = q.onSwapResult((rid, swap, result) => heard.push({ rid, swap, result }));
    q.reportSwap(db, BOT, id, { ok: true, gave: [{ itemId: "patk", qty: 1 }], gaveInstanceIds: ["inst-1"], got: [{ itemId: "pdef", qty: 1 }], partnerIgn: "TheirBot" });
    off();
    expect(heard).toEqual([{ rid: id, swap: { rendezvousId: 42, role: "give", gets: [{ itemId: "pdef", qty: 1 }], vaultUserId: null }, result: expect.objectContaining({ ok: true }) }]);
    expect(db.prepare("SELECT status FROM withdraw_requests WHERE id = ?").get(id)).toEqual({ status: "fulfilled" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    expect(q.swapJobsFor(db, 42)).toEqual([{ id, status: "fulfilled" }]);
    expect(() => q.reportSwap(db, BOT, id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "x", error: "late" })).toThrow(/Already closed/);
  });
  it("a failed swap closes the row as failed; cancel works while open", () => {
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-2"], swap: { rendezvousId: 43, role: "take", gets: [] } });
    q.reportSwap(db, BOT, id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "TheirBot", error: "partner absent", partnerAbsent: true });
    expect(q.swapJobsFor(db, 43)).toEqual([{ id, status: "failed" }]);
    const id2 = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-3"], swap: { rendezvousId: 44, role: "take", gets: [] } });
    expect(q.cancelSwapJob(db, id2, "hub aborted")).toBe(true);
    expect(q.cancelSwapJob(db, id2, "again")).toBe(false);
    expect(q.listPending(db).withdraws).toHaveLength(0);
  });
});
