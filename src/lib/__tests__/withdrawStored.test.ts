// POST /api/withdraw over items in the accounts' storage (docs/relay/STORAGE.md):
// a stored pick is stock of the halves it serves, rides one row with the
// character's own items, and is bounded by what one character can carry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { PyrelayPool, StoredItem } from "../devauth";

let db: Database.Database;
let poolNow: PyrelayPool;

vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), getDb: () => db }));
vi.mock("../devauth", async (orig) => ({
  ...(await orig<typeof import("../devauth")>()),
  pyrelay: { pool: async () => ({ ok: true as const, status: 200, data: poolNow }) },
}));
vi.mock("../ratelimit", async (orig) => ({ ...(await orig<typeof import("../ratelimit")>()), rateLimit: () => true }));

const { openDatabase } = await import("../db");
const { registerAdvancedSettings } = await import("../advanced");
const { DEFAULT_ADVANCED } = await import("../../node/settings");
const { SESSION_COOKIE, signSession } = await import("../session");
const { POST } = await import("../../server/api/withdraw/route");

const T0 = 1_800_000_000_000;
const slot = (id: string, itemId = "ubatk") => ({ instanceId: id, itemId, enchantments: [], capturedAt: T0 });
const stored = (id: string, itemId: string, where: StoredItem["where"], pools: StoredItem["pools"]): StoredItem => ({ instanceId: id, itemId, enchantments: [], capturedAt: T0, where, pools });
const BOTH = { seasonal: true, nonseasonal: true };
const NON = { seasonal: false, nonseasonal: true };
const SEA = { seasonal: true, nonseasonal: false };

beforeEach(() => {
  db = openDatabase(":memory:");
  const vault = Array.from({ length: 7 }, (_, i) => stored(`st-vault${i + 1}`, "ubatk", { kind: "vault", slot: i }, BOTH));
  poolNow = {
    ok: true,
    bots: { "bot-A": { ubatk: 2 } },
    capacities: { "bot-A": 8, "bot-B": 8 },
    instances: { "bot-A": { "4": slot("inst-0001"), "5": slot("inst-0002") } },
    stored: {
      "bot-A": [...vault, stored("st-char08", "patk", { kind: "char", charId: 8, slot: 4, className: "Wizard", level: 20 }, SEA), stored("st-spoils", "pdef", { kind: "spoils", slot: 0 }, NON)],
      "bot-B": [stored("st-botb-1", "pdef", { kind: "vault", slot: 0 }, NON)],
    },
    botMeta: {
      "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true },
      "bot-B": { ign: "BotB", server: "USWest2", online: true, seasonal: false },
    },
  };
});
afterEach(() => db.close());

function post(body: Record<string, unknown>) {
  return POST(new Request("http://site.local/api/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${signSession("Comrade")}` },
    body: JSON.stringify({ server: "USEast", seasonal: true, ...body }),
  }));
}
const rows = () => db.prepare("SELECT target_bot_guid, items_json, instance_ids_json, seasonal FROM withdraw_requests ORDER BY id").all() as { target_bot_guid: string; items_json: string; instance_ids_json: string | null; seasonal: number }[];

describe("withdrawing from storage", () => {
  it("takes a stored pick with the character's own on one row, and says how many are fetched first", async () => {
    const r = await post({ instanceIds: ["inst-0001", "st-vault1"] });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, tradeCount: 1, fetched: 1 });
    expect(rows()).toEqual([{ target_bot_guid: "bot-A", items_json: '[{"itemId":"ubatk","qty":2,"enchants":0}]', instance_ids_json: '["inst-0001","st-vault1"]', seasonal: 1 }]);
  });
  it("gates a stored item by the halves it serves, like a tracked one", async () => {
    // The spoils chest serves non-seasonal characters only.
    const r = await post({ instanceIds: ["st-spoils"] });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/no longer available/);
    // A non-seasonal player gets it, and the account's current server does not bind a stored pick.
    const ok = await post({ instanceIds: ["st-botb-1"], seasonal: false });
    expect(ok.status).toBe(200);
    expect(rows()).toEqual([{ target_bot_guid: "bot-B", items_json: '[{"itemId":"pdef","qty":1,"enchants":0}]', instance_ids_json: '["st-botb-1"]', seasonal: 0 }]);
  });
  it("makes a trade per character of one account, the played one first, and holds each to its character's slots", async () => {
    const r = await post({ instanceIds: ["st-char08", "inst-0001", "st-vault1"] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, tradeCount: 2 });
    // The played character hands over its own item and the one fetched from the vault; then the account logs in as character 8.
    expect(rows().map((w) => [w.target_bot_guid, w.instance_ids_json])).toEqual([["bot-A", '["inst-0001","st-vault1"]'], ["bot-A", '["st-char08"]']]);
    db.prepare("DELETE FROM withdraw_requests").run();
    // Another character's item alone is that character's trade.
    expect((await post({ instanceIds: ["st-char08"] })).status).toBe(200);
    db.prepare("DELETE FROM withdraw_requests").run();
    poolNow.capacities = { "bot-A": 3 };
    const over = await post({ instanceIds: ["inst-0001", "inst-0002", "st-vault1", "st-vault2"] });
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/at most 3 items/);
  });
  it("counts the containers as stock for a withdraw by type, within the character's slots", async () => {
    // 2 on the character + 7 in the vault, 8 slots: 8 of stock; another character's items are not counted.
    const r = await post({ itemIds: ["ubatk", "ubatk", "ubatk", "ubatk"] });
    expect(r.status).toBe(200);
    expect(rows()).toEqual([{ target_bot_guid: "bot-A", items_json: '[{"itemId":"ubatk","qty":4}]', instance_ids_json: null, seasonal: 1 }]);
    db.prepare("DELETE FROM withdraw_requests").run();
    poolNow.capacities = { "bot-A": 3 };
    const short = await post({ itemIds: ["ubatk", "ubatk", "ubatk", "ubatk"] });
    expect(short.status).toBe(409);
    expect((await short.json()).error).toMatch(/Only 3×/);
    expect((await post({ itemIds: ["patk"] })).status).toBe(409);
  });
});

describe("bulk potion withdraws under advanced management (docs/relay/ADVANCED.md)", () => {
  const charItem = (id: string, charId: number, slot: number) => stored(id, "patk", { kind: "char", charId, slot, className: "Wizard", level: 20, capacity: 8, seasonal: true }, SEA);
  beforeEach(() => {
    // bot-A: 3 on the played character beside a sword, 10 in the vault, 4 on character 8. bot-B: 8 on the character, 12 in the vault.
    poolNow = {
      ok: true,
      bots: { "bot-A": { patk: 3, ubatk: 1 }, "bot-B": { patk: 8 } },
      capacities: { "bot-A": 8, "bot-B": 8 },
      instances: {
        "bot-A": { "4": slot("a-p1", "patk"), "5": slot("a-p2", "patk"), "6": slot("a-p3", "patk"), "7": slot("a-sword") },
        "bot-B": Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(4 + i), slot(`b-p${i}`, "patk")])),
      },
      stored: {
        "bot-A": [...Array.from({ length: 10 }, (_, i) => stored(`a-v${i}`, "patk", { kind: "vault", slot: i }, BOTH)), ...Array.from({ length: 4 }, (_, i) => charItem(`a-c8-${i}`, 8, 4 + i))],
        "bot-B": Array.from({ length: 12 }, (_, i) => stored(`b-v${i}`, "patk", { kind: "vault", slot: i }, BOTH)),
      },
      botMeta: {
        "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true },
        "bot-B": { ign: "BotB", server: "USEast", online: true, seasonal: true },
      },
    };
  });
  afterEach(() => registerAdvancedSettings(null));
  const potionRows = () => rows().map((w) => [w.target_bot_guid, w.items_json, w.instance_ids_json]);

  it("takes the account that just covers the request, its character and vault first, then its other character", async () => {
    registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, pool: true }));
    const r = await post({ potionStat: "atk", potionPoints: 15 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, tradeCount: 3, potion: { pointsFilled: 15, shortfall: 0 } });
    // bot-A holds 17 (two trades, 2 left) against bot-B's 20 (two trades, 5 left). Its 13 on the character and in
    // the vault go by type a trade at a time; the last 2 are picked off character 8, which it logs in as for them.
    expect(potionRows()).toEqual([
      ["bot-A", '[{"itemId":"patk","qty":8}]', null],
      ["bot-A", '[{"itemId":"patk","qty":5}]', null],
      ["bot-A", '[{"itemId":"patk","qty":2,"enchants":0}]', '["a-c8-0","a-c8-1"]'],
    ]);
  });

  it("leaves copies other requests count on where they are", async () => {
    registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, pool: true }));
    // Someone else picked one copy off character 8.
    const now = Date.now();
    db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at)
      VALUES ('Other', 'other', 'USEast', '[{"itemId":"patk","qty":1,"enchants":0}]', 'pending', 'g-other', 'bot-A', '["a-c8-0"]', 1, ?, ?)`).run(now, now);
    expect((await post({ potionStat: "atk", potionPoints: 15 })).status).toBe(200);
    expect(potionRows().slice(1)).toEqual([
      ["bot-A", '[{"itemId":"patk","qty":8}]', null],
      ["bot-A", '[{"itemId":"patk","qty":5}]', null],
      ["bot-A", '[{"itemId":"patk","qty":2,"enchants":0}]', '["a-c8-1","a-c8-2"]'],
    ]);
    // A by-type row on bot-A takes 5 of its character's and vault's: it no longer covers 15 alone, bot-B does.
    db.prepare("DELETE FROM withdraw_requests WHERE ign_lower = 'comrade'").run();
    db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, seasonal, created_at, updated_at)
      VALUES ('Third', 'third', 'USEast', '[{"itemId":"patk","qty":5}]', 'pending', 'g-third', 'bot-A', 1, ?, ?)`).run(now, now);
    expect((await post({ potionStat: "atk", potionPoints: 15 })).status).toBe(200);
    const mine = db.prepare("SELECT target_bot_guid, items_json FROM withdraw_requests WHERE ign_lower = 'comrade' ORDER BY id").all();
    expect(mine).toEqual([
      { target_bot_guid: "bot-B", items_json: '[{"itemId":"patk","qty":8}]' },
      { target_bot_guid: "bot-B", items_json: '[{"itemId":"patk","qty":7}]' },
    ]);
  });

  it("is the old plan with the switch off: one trade's worth of containers per bot, no other characters", async () => {
    expect((await post({ potionStat: "atk", potionPoints: 15 })).status).toBe(200);
    // bot-B's 8 on the character, then bot-A's 3 and the 4 its free slots fit from the vault.
    expect(potionRows()).toEqual([
      ["bot-B", '[{"itemId":"patk","qty":8}]', null],
      ["bot-A", '[{"itemId":"patk","qty":7}]', null],
    ]);
  });
});
