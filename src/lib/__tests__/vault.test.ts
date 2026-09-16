// Personal storage against an in-memory database: claims, donates, the slot
// allocation between the two halves, and the dedicated bots' assignment and
// release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { userForIgn } from "../users";
import type { PyrelayPool } from "../devauth";
import {
  allocateVaultSlots, bumpAllVaultCaps, claimInstances, defaultVaultSlots, donateInstances, ensureVaultBot, ownedInstanceIds, releaseVaultBotIfEmpty,
  vaultBotCandidates, vaultBotGuids, vaultCapSummary, vaultCount, vaultHalf, vaultHalves, vaultView,
} from "../vault";
import { projectInstances } from "../pool";

let db: Database.Database;
let actor: { userId: number; ign: string; ignLower: string };
beforeEach(() => {
  db = openDatabase(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
  const userId = userForIgn(db, "Comrade", "comrade");
  actor = { userId, ign: "Comrade", ignLower: "comrade" };
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

const pick = (n: number, botGuid = "bot-A", seasonal = true) => ({ instanceId: `inst-${n}`, itemId: "ubatk", enchants: n % 2, botGuid, seasonal });

/** A fleet of three bots: A holds two items, B is empty and offline, C is empty but online. */
function pool(): PyrelayPool {
  return {
    ok: true,
    bots: { "bot-A": { ubatk: 2 } },
    capacities: {},
    instances: {
      "bot-A": {
        "4": { instanceId: "inst-1", itemId: "ubatk", enchantments: [], capturedAt: 1 },
        "5": { instanceId: "inst-2", itemId: "ubatk", enchantments: [7], capturedAt: 1 },
      },
    },
    botMeta: {
      "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true },
      "bot-B": { ign: "BotB", server: "", online: false, seasonal: true },
      "bot-C": { ign: "BotC", server: "USWest", online: true, seasonal: true },
      "bot-N": { ign: "BotN", server: "", online: false, seasonal: false },
    },
  };
}

describe("personal storage", () => {
  it("claims into the vault, charges the ledger like a withdraw, and takes a bot", () => {
    const r = claimInstances(db, actor, [pick(1), pick(2)], vaultBotCandidates(db, pool(), true, actor.userId));
    expect(r).toMatchObject({ ok: true, claimed: 2, seasonal: true, used: 2, slots: 8, botGuid: "bot-B" });
    expect(vaultCount(db, actor.userId)).toBe(2);
    expect(vaultCount(db, actor.userId, true)).toBe(2);
    expect(vaultCount(db, actor.userId, false)).toBe(0);
    expect(vaultBotGuids(db)).toEqual(new Set(["bot-B"]));
    const tx = db.prepare("SELECT kind, ign, item_id, qty, enchants FROM transactions ORDER BY id").all();
    expect(tx).toEqual([
      { kind: "withdraw", ign: "Comrade", item_id: "ubatk", qty: 1, enchants: 1 },
      { kind: "withdraw", ign: "Comrade", item_id: "ubatk", qty: 1, enchants: 0 },
    ]);
    // The public pool no longer shows them.
    expect(projectInstances(pool(), ownedInstanceIds(db))).toEqual([]);
    expect(projectInstances(pool()).length).toBe(2);
  });
  it("refuses a half with no slots, mixed halves, double claims, reserved items, and overflow", () => {
    // A new account's slots all sit in the seasonal half.
    expect(claimInstances(db, actor, [pick(1, "bot-N", false)], [])).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("no vault slots") });
    expect(claimInstances(db, actor, [pick(1), pick(2, "bot-N", false)], [])).toMatchObject({ ok: false, status: 400 });
    claimInstances(db, actor, [pick(1)], []);
    expect(claimInstances(db, actor, [pick(1)], [])).toMatchObject({ ok: false, status: 409 });
    db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at)
       VALUES ('Other', 'other', 'USEast', '[]', 'pending', 'g', 'bot-A', '["inst-9"]', 1, 1, 1)`,
    ).run();
    expect(claimInstances(db, actor, [pick(9)], [])).toMatchObject({ ok: false, status: 409 });
    const many = Array.from({ length: 8 }, (_, i) => pick(100 + i));
    expect(claimInstances(db, actor, many, [])).toMatchObject({ ok: false, status: 409 });
    expect(vaultCount(db, actor.userId)).toBe(1);
  });
  it("donates back to the pool with a deposit row each, and releases the bot when empty", () => {
    claimInstances(db, actor, [pick(1), pick(2)], ["bot-B"]);
    const r = donateInstances(db, actor, ["inst-1"]);
    expect(r).toMatchObject({ ok: true, donated: 1, used: 1, released: false });
    expect(vaultBotGuids(db)).toEqual(new Set(["bot-B"]));
    expect(donateInstances(db, actor, ["inst-1"])).toMatchObject({ ok: false, status: 404 });
    const r2 = donateInstances(db, actor, ["inst-2"]);
    expect(r2).toMatchObject({ ok: true, seasonal: true, used: 0, released: true });
    expect(vaultHalf(db, actor.userId, true).botGuid).toBeNull();
    const kinds = (db.prepare("SELECT kind FROM transactions ORDER BY id").all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["withdraw", "withdraw", "deposit", "deposit"]);
  });
  it("keeps the bot while a vault request is open, and gives slots away only when they are free", () => {
    claimInstances(db, actor, [pick(1)], ["bot-B"]);
    db.prepare(
      `INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, vault_user_id, created_at, updated_at)
       VALUES ('Comrade', 'comrade', 'USEast', '[]', 'pending', 'g2', 'bot-B', '["inst-1"]', 1, ?, 1, 1)`,
    ).run(actor.userId);
    // Reserved by its own withdraw: can't be donated.
    expect(donateInstances(db, actor, ["inst-1"])).toMatchObject({ ok: false, status: 409 });
    // The seasonal half holds an item: its slots can't go to the other half.
    expect(allocateVaultSlots(db, actor, true, 0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("holds 1 item") });
    expect(allocateVaultSlots(db, actor, false, 8)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("8 of them are in your seasonal vault") });
    db.prepare("DELETE FROM vault_items").run();
    // Empty but with the withdraw still open: the bot stays, and so do the slots.
    expect(releaseVaultBotIfEmpty(db, actor.userId)).toBe(false);
    expect(allocateVaultSlots(db, actor, true, 0)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("open request") });
    db.prepare("UPDATE withdraw_requests SET status = 'fulfilled'").run();
    expect(releaseVaultBotIfEmpty(db, actor.userId)).toBe(true);
    expect(allocateVaultSlots(db, actor, true, 0)).toEqual({ ok: true, seasonal: true, slots: 0, unallocated: 8 });
    expect(allocateVaultSlots(db, actor, false, 8)).toEqual({ ok: true, seasonal: false, slots: 8, unallocated: 0 });
    expect(vaultHalves(db, actor.userId)).toMatchObject({ total: 8, unallocated: 0, seasonal: { slots: 0, botGuid: null }, nonseasonal: { slots: 8, botGuid: null } });
    // Now the non-seasonal pool is claimable and the seasonal one is not.
    expect(claimInstances(db, actor, [pick(5, "bot-N", false)], ["bot-N"])).toMatchObject({ ok: true, seasonal: false, botGuid: "bot-N" });
    expect(claimInstances(db, actor, [pick(6)], [])).toMatchObject({ ok: false, status: 409 });
    expect(vaultBotGuids(db)).toEqual(new Set(["bot-N"]));
  });
  it("allocates in blocks of 8 within the account's total, and frees an emptied half's bot", () => {
    expect(allocateVaultSlots(db, actor, false, 4)).toMatchObject({ ok: false, status: 400 });
    expect(allocateVaultSlots(db, actor, false, 8)).toMatchObject({ ok: false, status: 409 });
    expect(allocateVaultSlots(db, actor, true, 8)).toEqual({ ok: true, seasonal: true, slots: 8, unallocated: 0 });
    db.prepare("UPDATE users SET vault_slots = 24 WHERE id = ?").run(actor.userId);
    expect(vaultHalves(db, actor.userId).unallocated).toBe(16);
    expect(allocateVaultSlots(db, actor, false, 16)).toEqual({ ok: true, seasonal: false, slots: 16, unallocated: 0 });
    expect(allocateVaultSlots(db, actor, true, 16)).toMatchObject({ ok: false, status: 409 });
    // A half with a bot but nothing on it hands the bot back when shrunk to nothing.
    expect(ensureVaultBot(db, actor.userId, false, ["bot-N"], 1)).toBe("bot-N");
    expect(allocateVaultSlots(db, actor, false, 0)).toEqual({ ok: true, seasonal: false, slots: 0, unallocated: 16 });
    expect(vaultHalf(db, actor.userId, false).botGuid).toBeNull();
    // Setting a half to what it already holds is not a change.
    expect(db.prepare("SELECT detail FROM vault_events WHERE event = 'allocated' ORDER BY id").all()).toEqual([
      { detail: JSON.stringify({ seasonal: false, slots: 16 }) },
      { detail: JSON.stringify({ seasonal: false, slots: 0 }) },
    ]);
  });
  it("hands out distinct bots to distinct users and copes with a taken candidate", () => {
    const other = userForIgn(db, "Rival", "rival");
    expect(ensureVaultBot(db, actor.userId, true, ["bot-B", "bot-X"], 1)).toBe("bot-B");
    expect(ensureVaultBot(db, other, true, ["bot-B", "bot-X"], 1)).toBe("bot-X");
    expect(ensureVaultBot(db, other, true, ["bot-B"], 1)).toBe("bot-X"); // already has one
    // Candidates skip online, non-empty, other-pool and taken bots.
    expect(vaultBotCandidates(db, pool(), true, 99)).toEqual([]);
    expect(vaultBotCandidates(db, pool(), false, 99)).toEqual(["bot-N"]);
    // The other half of the same account is its own vault with its own bot.
    expect(ensureVaultBot(db, actor.userId, false, ["bot-B", "bot-N"], 1)).toBe("bot-N");
    expect(vaultBotCandidates(db, pool(), false, 99)).toEqual([]);
  });
  it("shows the owner where each item is, and flags transit and loss", () => {
    claimInstances(db, actor, [pick(1), pick(2)], ["bot-B"]);
    db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES ('inst-gone', ?, 'patk', 0, 1, 'bot-Z', 'deposit', 1)").run(actor.userId);
    const v = vaultView(db, actor.userId, pool());
    expect(v).toMatchObject({
      total: 8, block: 8, unallocated: 0,
      seasonal: { seasonal: true, slots: 8, used: 3, wishes: 0, bot: { guid: "bot-B", ign: "BotB", online: false } },
      nonseasonal: { seasonal: false, slots: 0, used: 0, wishes: 0, bot: null },
    });
    const byId = Object.fromEntries(v.items.map((i) => [i.instanceId, i]));
    expect(byId["inst-1"]).toMatchObject({ botIgn: "BotA", server: "USEast", online: true, inTransit: true, lost: false, rarity: "common" });
    expect(byId["inst-2"]).toMatchObject({ rarity: "uncommon", enchantments: [expect.objectContaining({ id: 7 })] });
    expect(byId["inst-gone"]).toMatchObject({ lost: true, inTransit: false, itemName: expect.any(String) });
  });
});

describe("fleet-wide cap", () => {
  it("raises every account and the default, leaving the new block unallocated", () => {
    const other = userForIgn(db, "Rival", "rival");
    const r = bumpAllVaultCaps(db, 8);
    expect(r).toMatchObject({ delta: 8, accounts: 2, defaultBefore: 8, defaultAfter: 16, shrunk: 0, overAllocated: [] });
    expect(vaultHalves(db, actor.userId)).toMatchObject({ total: 16, unallocated: 8, seasonal: { slots: 8 }, nonseasonal: { slots: 0 } });
    expect(vaultHalves(db, other)).toMatchObject({ total: 16, unallocated: 8 });
    // Accounts created from now on start at the new default.
    expect(defaultVaultSlots(db)).toBe(16);
    expect(vaultHalves(db, userForIgn(db, "Newbie", "newbie"))).toMatchObject({ total: 16, seasonal: { slots: 16 } });
    expect(vaultCapSummary(db)).toEqual({ default: 16, block: 8, accounts: 3, byCap: [{ cap: 16, accounts: 3 }] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM vault_events WHERE event = 'cap-changed'").get()).toEqual({ n: 2 });
    expect(() => bumpAllVaultCaps(db, 4)).toThrow();
  });
  it("lowers from unallocated first, then from a half with a free block, and reports the rest", () => {
    bumpAllVaultCaps(db, 8); // 16, 8 unallocated
    const spare = userForIgn(db, "Spare", "spare"); // 16, all in seasonal, empty
    allocateVaultSlots(db, { userId: spare, ign: "Spare", ignLower: "spare" }, true, 16);
    const full = userForIgn(db, "Full", "full"); // 16: 8 seasonal with an item, 8 non-seasonal with wishes
    const fullActor = { userId: full, ign: "Full", ignLower: "full" };
    expect(allocateVaultSlots(db, fullActor, true, 8).ok).toBe(true);
    expect(allocateVaultSlots(db, fullActor, false, 8).ok).toBe(true);
    claimInstances(db, fullActor, [pick(1)], []);
    db.prepare("INSERT INTO wishlist_rules (user_id, seasonal, item_id, slots_min, slots_exact, match_json, enabled, hits, last_hit_at, created_at, updated_at) VALUES (?, 0, 'ubatk', 0, NULL, '{}', 1, 0, NULL, 1, 1)").run(full);
    ensureVaultBot(db, spare, true, ["bot-B"], 1);

    const r = bumpAllVaultCaps(db, -8);
    expect(r).toMatchObject({ delta: -8, accounts: 3, defaultBefore: 16, defaultAfter: 8, shrunk: 1 });
    // The first account had 8 unallocated: nothing to shrink.
    expect(vaultHalves(db, actor.userId)).toMatchObject({ total: 8, unallocated: 0, seasonal: { slots: 8 } });
    // Spare's seasonal half had a whole free block: it gave one back and kept its bot (still 8 slots).
    expect(vaultHalves(db, spare)).toMatchObject({ total: 8, unallocated: 0, seasonal: { slots: 8, botGuid: "bot-B" } });
    // Full's halves each hold something in every block: it stays over its cap.
    expect(r.overAllocated).toEqual([{ userId: full, igns: ["Full"], total: 8, allocated: 16 }]);
    expect(vaultHalves(db, full)).toMatchObject({ total: 8, unallocated: 0, seasonal: { slots: 8 }, nonseasonal: { slots: 8 } });
    expect(allocateVaultSlots(db, fullActor, true, 16)).toMatchObject({ ok: false, status: 409 });
    // A half shrunk to nothing hands its bot back.
    allocateVaultSlots(db, { userId: spare, ign: "Spare", ignLower: "spare" }, true, 8);
    bumpAllVaultCaps(db, -8);
    expect(vaultHalves(db, spare)).toMatchObject({ total: 0, seasonal: { slots: 0, botGuid: null } });
    expect(defaultVaultSlots(db)).toBe(0);
  });
});
