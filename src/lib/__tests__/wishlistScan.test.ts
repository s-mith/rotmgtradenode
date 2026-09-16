// The scan driver: one debounced scan per burst of pool changes, and no
// relay fetch while nothing is enabled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { PyrelayPool } from "../devauth";

let db: Database.Database;
let poolNow: PyrelayPool;
let poolCalls = 0;

vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), getDb: () => db }));
vi.mock("../devauth", async (orig) => ({
  ...(await orig<typeof import("../devauth")>()),
  pyrelay: { pool: async () => { poolCalls++; return { ok: true as const, status: 200, data: poolNow }; } },
}));

const { openDatabase } = await import("../db");
const { userForIgn } = await import("../users");
const { grantFeature } = await import("../features");
const { createRule, listRules } = await import("../wishlist");
const { vaultCount } = await import("../vault");
const { notifyPoolChanged } = await import("../liveBus");
const { installWishlistScanner, runWishlistScan, stopWishlistScanner } = await import("../wishlistScan");

const T0 = 1_800_000_000_000;
function pool(ids: string[], at = T0 + 5): PyrelayPool {
  const slots: PyrelayPool["instances"][string] = {};
  ids.forEach((id, i) => { slots[String(i + 4)] = { instanceId: id, itemId: "ubatk", enchantments: [], capturedAt: at }; });
  return { ok: true, bots: { "bot-A": { ubatk: ids.length } }, capacities: {}, instances: { "bot-A": slots }, botMeta: { "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true }, "bot-B": { ign: "BotB", server: "", online: false, seasonal: true } } };
}

let userId: number;
beforeEach(() => {
  db = openDatabase(":memory:");
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  poolCalls = 0;
  poolNow = pool([]);
  userId = userForIgn(db, "Comrade", "comrade");
  grantFeature(db, "wishlist", "Comrade", "comrade");
});
afterEach(() => {
  stopWishlistScanner();
  db.close();
  vi.useRealTimers();
});

describe("wishlist scan driver", () => {
  it("does not touch the relay while no rule is enabled", async () => {
    expect(await runWishlistScan()).toBeNull();
    expect(poolCalls).toBe(0);
  });
  it("claims on a scan, whatever the item's age, and spends the wish", async () => {
    createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    poolNow = pool(["one"], T0 - 1); // in the pool before the rule
    expect((await runWishlistScan())?.hits.map((h) => h.instanceId)).toEqual(["one"]);
    expect(vaultCount(db, userId)).toBe(1);
    expect(listRules(db, userId)).toEqual([]); // the wish is spent
    expect(await runWishlistScan()).toBeNull(); // nothing enabled: no relay fetch
    expect(poolCalls).toBe(1);
  });
  it("debounces a burst of pool-changed signals into one scan, then rescans after the claim", async () => {
    installWishlistScanner();
    createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    poolNow = pool(["fresh"]);
    notifyPoolChanged();
    notifyPoolChanged();
    notifyPoolChanged();
    expect(poolCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(poolCalls).toBe(1);
    expect(vaultCount(db, userId)).toBe(1);
    // The claim itself raised the signal, but the wish it spent was the
    // only one, so the follow-up scan never reaches the relay.
    await vi.advanceTimersByTimeAsync(1_600);
    expect(poolCalls).toBe(1);
    expect(vaultCount(db, userId)).toBe(1);
  });
  it("runs on the interval as a backstop", async () => {
    installWishlistScanner();
    createRule(db, userId, { seasonal: true, itemId: "ubatk" });
    poolNow = pool(["late"]);
    await vi.advanceTimersByTimeAsync(30_100);
    expect(poolCalls).toBe(1);
    expect(vaultCount(db, userId)).toBe(1);
  });
});
