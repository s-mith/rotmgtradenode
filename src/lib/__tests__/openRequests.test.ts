// Open-request listing and per-group cancel against an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { cancelOpenRequests, openGroupsFor } from "../cancelCode";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

function deposit(ign: string, group: string, vault: number | null = null, at = Date.now()) {
  return Number(db.prepare(
    `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, vault_user_id, created_at, updated_at)
     VALUES (?, ?, 'USEast', 16, 16, 'pending', ?, 1, ?, ?, ?)`,
  ).run(ign, ign.toLowerCase(), group, vault, at, at).lastInsertRowid);
}
function withdraw(ign: string, group: string, items: string, at = Date.now(), status = "pending") {
  return Number(db.prepare(
    `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, seasonal, created_at, updated_at)
     VALUES (?, ?, 'USWest', ?, ?, ?, 0, ?, ?)`,
  ).run(ign, ign.toLowerCase(), items, status, group, at, at).lastInsertRowid);
}

describe("open requests", () => {
  it("lists a character's open groups oldest first, rolling up fragments", () => {
    deposit("Me", "g-dep", 7, 100);
    withdraw("Me", "g-wd", '[{"itemId":"ubatk","qty":1}]', 200);
    withdraw("Me", "g-wd", '[{"itemId":"ubatk","qty":1},{"itemId":"patk","qty":2}]', 200);
    withdraw("Me", "g-done", '[{"itemId":"patk","qty":1}]', 50, "fulfilled");
    withdraw("Other", "g-other", '[{"itemId":"patk","qty":1}]', 10);
    const groups = openGroupsFor(db, "me");
    expect(groups.map((g) => [g.groupId, g.kind, g.vault, g.itemCount])).toEqual([
      ["g-dep", "deposit", true, 16],
      ["g-wd", "withdraw", false, 4],
    ]);
    expect(groups[1].items).toEqual([{ itemId: "ubatk", qty: 2 }, { itemId: "patk", qty: 2 }]);
    expect(groups[1].server).toBe("USWest");
  });
  it("cancels one group on request, and only the character's own rows", () => {
    const d = deposit("Me", "g-dep");
    const w1 = withdraw("Me", "g-wd", "[]");
    const w2 = withdraw("Me", "g-wd", "[]");
    const other = withdraw("Other", "g-wd", "[]");
    expect(cancelOpenRequests(db, "me", "g-wd")).toEqual({ depositsCancelled: 0, withdrawsCancelled: 2, tradesInProgress: 0 });
    const st = (t: string, id: number) => (db.prepare(`SELECT status FROM ${t} WHERE id = ?`).get(id) as { status: string }).status;
    expect([st("withdraw_requests", w1), st("withdraw_requests", w2)]).toEqual(["cancelled", "cancelled"]);
    expect(st("withdraw_requests", other)).toBe("pending");
    expect(st("deposit_requests", d)).toBe("pending");
    expect(openGroupsFor(db, "me").map((g) => g.groupId)).toEqual(["g-dep"]);
    // No group: everything of theirs.
    expect(cancelOpenRequests(db, "me")).toMatchObject({ depositsCancelled: 1, withdrawsCancelled: 0 });
    expect(openGroupsFor(db, "me")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM request_events WHERE event = 'cancelled'").get()).toEqual({ n: 3 });
  });
});
