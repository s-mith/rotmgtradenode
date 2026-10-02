// Swap rows on the withdraw queue (design doc §6.2): queued like a
// per-instance withdraw, claimed only by the holder, closed by reportSwap
// with no ledger row, and heard by the coordinator.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import { reservedInstanceIds } from "../reservations";
import * as q from "../queue";
import { PENDING_TIMEOUT_MS, sweepStaleRequests } from "../timeouts";

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
    expect(heard).toEqual([{ rid: id, swap: { rendezvousId: 42, role: "give", gets: [{ itemId: "pdef", qty: 1 }] }, result: expect.objectContaining({ ok: true }) }]);
    expect(db.prepare("SELECT status FROM withdraw_requests WHERE id = ?").get(id)).toEqual({ status: "fulfilled" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0 });
    expect(q.swapJobsFor(db, 42)).toMatchObject([{ id, status: "fulfilled", targetBotGuid: BOT, instanceIds: ["inst-1"], spec: { rendezvousId: 42, role: "give" } }]);
    expect(() => q.reportSwap(db, BOT, id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "x", error: "late" })).toThrow(/Already closed/);
  });
  it("a failed swap closes the row as failed; cancel works while open", () => {
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-2"], swap: { rendezvousId: 43, role: "take", gets: [] } });
    q.reportSwap(db, BOT, id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "TheirBot", error: "partner absent", partnerAbsent: true });
    expect(q.swapJobsFor(db, 43)).toMatchObject([{ id, status: "failed" }]);
    const id2 = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-3"], swap: { rendezvousId: 44, role: "take", gets: [] } });
    expect(q.cancelSwapJob(db, id2, "hub aborted")).toBe(true);
    expect(q.cancelSwapJob(db, id2, "again")).toBe(false);
    expect(q.listPending(db).withdraws).toHaveLength(0);
  });
});

describe("swap rows and time", () => {
  it("outlives the generic sweeps and is failed by the queue only well past its meeting deadline, with a failure the listeners hear", () => {
    const deadline = Date.now() + 60_000;
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-4"], swap: { rendezvousId: 45, role: "give", gets: [{ itemId: "pdef", qty: 1 }], deadlineAt: deadline } });
    const old = Date.now() - 2 * PENDING_TIMEOUT_MS;
    db.prepare("UPDATE withdraw_requests SET created_at = ?, updated_at = ? WHERE id = ?").run(old, old, id);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 0, claimedTimedOut: 0 });
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["inst-4"])).toMatchObject({ requestId: id });
    db.prepare("UPDATE withdraw_requests SET updated_at = ? WHERE id = ?").run(old, id);
    expect(sweepStaleRequests(db)).toEqual({ pendingTimedOut: 0, claimedTimedOut: 0 });
    expect(q.swapJobsFor(db, 45)).toMatchObject([{ id, status: "claimed", spec: { deadlineAt: deadline } }]);
    const heard: unknown[] = [];
    const off = q.onSwapResult((rid, _swap, result) => heard.push({ rid, result }));
    expect(q.expireSwapJobs(db, deadline + q.SWAP_EXPIRE_GRACE_MS - 1)).toBe(0);
    expect(q.expireSwapJobs(db, deadline + q.SWAP_EXPIRE_GRACE_MS)).toBe(1);
    off();
    expect(heard).toMatchObject([{ rid: id, result: { ok: false, error: expect.stringContaining("deadline passed") } }]);
    expect(q.swapJobsFor(db, 45)).toMatchObject([{ id, status: "failed" }]);
    // A row without a deadline (an older node's) is left alone by the expiry.
    const plain = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "OtherBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-6"], swap: { rendezvousId: 47, role: "give", gets: [] } });
    expect(q.expireSwapJobs(db, Date.now() + 365 * 24 * 3600_000)).toBe(0);
    expect(q.swapJobsFor(db, 47)).toMatchObject([{ id: plain, status: "pending" }]);
  });

  it("tells a waiting bot the meeting's deadline as it stands now", () => {
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-1"], swap: { rendezvousId: 43, role: "give", gets: [{ itemId: "pdef", qty: 1 }], deadlineAt: 1000 } });
    expect(q.swapRowState(db, id)).toEqual({ open: true, deadlineAt: 1000 });
    db.prepare("UPDATE withdraw_requests SET swap_json = json_set(swap_json, '$.deadlineAt', 5000) WHERE id = ?").run(id);
    expect(q.swapRowState(db, id)).toEqual({ open: true, deadlineAt: 5000 });
    q.cancelSwapJob(db, id, "test");
    expect(q.swapRowState(db, id)).toMatchObject({ open: false });
    expect(q.swapRowState(db, 999_999)).toEqual({ open: false, deadlineAt: null });
  });

  it("at startup a claimed swap row of the previous run goes back to pending", () => {
    const id = q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "TheirBot", seasonal: true, give: [{ itemId: "patk", qty: 1 }], giveInstanceIds: ["inst-5"], swap: { rendezvousId: 46, role: "give", gets: [], deadlineAt: Date.now() + 60_000 } });
    expect(q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["inst-5"])).toMatchObject({ requestId: id });
    expect(q.orphanClaimedSwapJobs(db)).toBe(1);
    expect(q.swapJobsFor(db, 46)).toMatchObject([{ id, status: "pending", claimedBy: null }]);
    expect(q.orphanClaimedSwapJobs(db)).toBe(0);
    expect(q.eventsFor(db, "withdraw", id).map((e) => e.event)).toEqual(["swap-queued", "claimed", "swap-orphaned"]);
  });
});
