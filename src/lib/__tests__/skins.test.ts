// Skins: real items the fleet trades, kept off the ledger, handed out
// through missions. Covers identity, stock from the pool snapshot, what the
// public route exposes, the ledger exclusion, and a redemption's life cycle.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";
import { presence } from "../fleetPresence";
import * as q from "../queue";
import { registerEmbeddedPool, type PyrelayPool } from "../devauth";
import { isSkinItem, itemDisplayName, notASkin, skinItemId, skinRealmId } from "../skins";
import { createRedemption, missionProgress, skinInventory, skinStock } from "../skinRedeem";
import { createDepositRequest } from "../depositRequest";
import { GET as recent } from "../../server/api/recent/route";
import { GET as publicSkins } from "../../server/api/skins/route";

let db: Database.Database;
const SKIN = "8827"; // Agent Skin
const ITEM = skinItemId(SKIN);
const BOT = "botguid-aaaaaaaa";
const BOT2 = "botguid-bbbbbbbb";

const inst = (instanceId: string, itemId: string) => ({ instanceId, itemId, enchantments: [], capturedAt: 1 });
function fakePool(): PyrelayPool {
  return {
    ok: true,
    bots: { [BOT]: { [ITEM]: 2, pdef: 1 }, [BOT2]: { [ITEM]: 1 } },
    capacities: { [BOT]: 8, [BOT2]: 8 },
    instances: {
      [BOT]: { 4: inst("inst-a1", ITEM), 5: inst("inst-a2", ITEM), 6: inst("inst-p", "pdef") },
      [BOT2]: { 4: inst("inst-b1", ITEM) },
    },
    botMeta: {
      [BOT]: { ign: "BotAlpha", server: "USEast", online: true, seasonal: false },
      [BOT2]: { ign: "BotBeta", server: "EUWest", online: false, seasonal: true },
    },
  };
}
function tx(ign: string, itemId: string, qty = 1, kind: "deposit" | "withdraw" = "deposit") {
  db.prepare(`INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES (?, ?, ?, ?, ?, 0, 'USEast', NULL, ?)`)
    .run(kind, ign, ign.toLowerCase(), itemId, qty, Date.now());
}
/** 3,000 seasonal stat points: one Seasonal Potion Drive earned. */
const earn = (ign: string) => tx(ign, "gpdef", 1500);
const player = (ign: string, over: Partial<Parameters<typeof createRedemption>[2]> = {}) => ({ ign, ignLower: ign.toLowerCase(), server: "USEast", skinId: SKIN, ...over });

beforeEach(() => {
  db = openDatabase(":memory:");
  presence.reset();
  (globalThis as { __pool_db__?: Database.Database }).__pool_db__ = db;
  registerEmbeddedPool(fakePool);
});
afterEach(() => {
  delete (globalThis as { __pool_db__?: Database.Database }).__pool_db__;
  registerEmbeddedPool(undefined);
  db.close();
});

describe("skins", () => {
  it("are named skin:<realm id> and resolve to their catalog entry", () => {
    expect(ITEM).toBe("skin:8827");
    expect(skinRealmId(ITEM)).toBe(SKIN);
    expect(skinRealmId("skin:1")).toBeNull();
    expect(isSkinItem("pdef")).toBe(false);
    expect(itemDisplayName(ITEM)).toBe("Agent Skin");
    expect(itemDisplayName("pdef")).toBe("Potion of Defense");
    expect(itemDisplayName("mystery")).toBe("mystery");
    expect(notASkin()).toContain("NOT LIKE 'skin:%'");
  });

  it("stock is what non-seasonal bots hold, unreserved; a seasonal holder is a stray", async () => {
    expect(skinStock(db, fakePool())).toEqual([{ realmId: SKIN, name: "Agent Skin", image: `/skins/${SKIN}.png`, count: 2 }]);
    const body = await (await publicSkins()).json();
    expect(body.skins[0].count).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/inst-|BotAlpha|botguid|ign/);
    const inv = skinInventory(db, fakePool()).find((s) => s.realmId === SKIN)!;
    expect(inv).toMatchObject({ count: 2, holders: ["BotAlpha"], strays: 1, strayHolders: ["BotBeta"] });
  });

  it("never reach the activity feed", async () => {
    tx("Someone", "pdef", 3);
    tx("Someone", ITEM, 1);
    tx("Other", ITEM, 5);
    const feed = await (await recent()).json();
    expect(feed.events.map((e: { ign: string; itemName: string }) => `${e.ign}:${e.itemName}`)).toEqual(["Someone:Potion of Defense"]);
  });

  it("come in only on an operator's skin deposit, and never write a ledger row", async () => {
    const now = Date.now();
    presence.report({ botGuid: BOT, alias: "A", ign: "BotAlpha", server: "USEast", freeSlots: 8, status: "idle", seasonal: false });
    // A player's deposit: the bot is told not to take skins, and the site refuses them too.
    const plain = Number(db.prepare(`INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, created_at, updated_at) VALUES ('Donor', 'donor', 'USEast', 8, 8, 'pending', 'g1', 0, ?, ?)`).run(now, now).lastInsertRowid);
    expect(q.claimDeposit(db, BOT, 8)).toMatchObject({ requestId: plain, skins: false });
    expect(() => q.fulfillDeposit(db, BOT, plain, [{ itemId: ITEM, qty: 1 }])).toThrow(/operator's skin deposit/);
    q.fulfillDeposit(db, BOT, plain, [{ itemId: "pdef", qty: 1 }]);
    presence.setStatus(BOT, "idle", Date.now());

    // The operator's: queued from the console with skins allowed. The
    // fixture's bots have 5 and 7 slots free, so a 4-slot trade.
    const created = await createDepositRequest(db, { ign: "Operator", ignLower: "operator", server: "USEast", slots: 4, seasonal: 0, skinsAllowed: true });
    if (!created.ok) throw new Error(created.error);
    expect(db.prepare("SELECT skins_allowed FROM deposit_requests WHERE id = ?").get(created.requestId)).toEqual({ skins_allowed: 1 });
    expect(q.claimDeposit(db, BOT, 8)).toMatchObject({ requestId: created.requestId, skins: true });
    q.fulfillDeposit(db, BOT, created.requestId, [{ itemId: ITEM, qty: 1 }, { itemId: "pdef", qty: 1 }], [{ itemId: ITEM, enchants: 0 }, { itemId: "pdef", enchants: 0 }]);
    expect(db.prepare("SELECT ign, item_id FROM transactions ORDER BY id").all()).toEqual([{ ign: "Donor", item_id: "pdef" }, { ign: "Operator", item_id: "pdef" }]);
    expect(() => q.fulfillDeposit(db, BOT, created.requestId, [{ itemId: "skin:1", qty: 1 }])).toThrow(/Unknown item/);
    // The public routes never set the flag.
    const player = await createDepositRequest(db, { ign: "Someone", ignLower: "someone", server: "USEast", slots: 4, seasonal: 0 });
    if (!player.ok) throw new Error(player.error);
    expect(db.prepare("SELECT skins_allowed FROM deposit_requests WHERE id = ?").get(player.requestId)).toEqual({ skins_allowed: 0 });
  });

  it("net progress below zero is reported as-is and earns nothing", () => {
    tx("Someone", "pdef", 10);
    tx("Someone", "pdef", 25, "withdraw");
    expect(missionProgress(db, "someone")).toMatchObject({ stats: { seasonalPotionsNet: -15 }, earned: 0, available: 0 });
    expect(createRedemption(db, fakePool(), player("Someone"))).toMatchObject({ ok: false, status: 403 });
  });

  it("a redemption spends an earned mission, reserves the skin, and is delivered by a withdraw", () => {
    expect(createRedemption(db, fakePool(), player("Someone"))).toMatchObject({ ok: false, status: 403 });
    earn("Someone");
    expect(missionProgress(db, "someone")).toMatchObject({ earned: 1, used: 0, available: 1, open: null });

    const first = createRedemption(db, fakePool(), player("Someone"));
    expect(first).toMatchObject({ ok: true, botIgn: "BotAlpha", name: "Agent Skin" });
    if (!first.ok) throw new Error(first.error);
    const row = db.prepare("SELECT ign, server, status, target_bot_guid, instance_ids_json, items_json, seasonal FROM withdraw_requests WHERE id = ?").get(first.requestId) as Record<string, unknown>;
    expect(row).toMatchObject({ ign: "Someone", server: "USEast", status: "pending", target_bot_guid: BOT, instance_ids_json: JSON.stringify(["inst-a1"]), seasonal: 0 });
    expect(JSON.parse(row.items_json as string)).toEqual([{ itemId: ITEM, qty: 1, enchants: 0 }]);
    expect(missionProgress(db, "someone")).toMatchObject({ used: 1, available: 0, open: { requestId: first.requestId, groupId: first.groupId, name: "Agent Skin", status: "pending" } });
    expect(createRedemption(db, fakePool(), player("Someone"))).toMatchObject({ ok: false, status: 409, hasOpen: true });
    // The reserved copy is out of the offer; the other one is still there.
    expect(skinStock(db, fakePool())[0].count).toBe(1);

    // The bot never showed: cancelled means nothing was spent.
    db.prepare("UPDATE withdraw_requests SET status = 'cancelled' WHERE id = ?").run(first.requestId);
    expect(missionProgress(db, "someone")).toMatchObject({ used: 0, available: 1, open: null });
    expect(skinStock(db, fakePool())[0].count).toBe(2);

    const second = createRedemption(db, fakePool(), player("Someone"));
    if (!second.ok) throw new Error(second.error);
    db.prepare("UPDATE withdraw_requests SET status = 'claimed', claimed_by = ? WHERE id = ?").run(BOT, second.requestId);
    presence.report({ botGuid: BOT, alias: "A", ign: "BotAlpha", server: "USEast", freeSlots: 5, status: "busy", seasonal: false });
    expect(q.fulfillWithdraw(db, BOT, second.requestId, [{ itemId: ITEM, qty: 1 }], ["inst-a1"])).toMatchObject({ ign: "Someone", count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind = 'withdraw'").get()).toEqual({ n: 0 });
    expect(missionProgress(db, "someone")).toMatchObject({ used: 1, available: 0, open: null });
    expect(createRedemption(db, fakePool(), player("Someone"))).toMatchObject({ ok: false, status: 403 });
  });

  it("never hands out a stray from a seasonal bot", () => {
    earn("Third");
    expect(createRedemption(db, fakePool(), player("Third", { skinId: "30822" }))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("out of stock") });
    const pool = fakePool();
    delete pool.instances[BOT]; // only the seasonal stray is left
    expect(createRedemption(db, pool, player("Third"))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("seasonal bots") });
    expect(createRedemption(db, pool, player("Third", { skinId: "nope" }))).toMatchObject({ ok: false, status: 400 });
    // Delivery is always to a non-seasonal character, on the server asked for.
    const ok = createRedemption(db, fakePool(), player("Third", { server: "EUWest" }));
    expect(ok).toMatchObject({ ok: true, botIgn: "BotAlpha" });
  });
});
