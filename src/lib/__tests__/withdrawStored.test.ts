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
  it("refuses items on two characters of one account, and more than the character's slots from one account", async () => {
    const r = await post({ instanceIds: ["inst-0001", "st-char08"] });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/different characters/);
    // Another character's item together with a container item is one character's trade.
    expect((await post({ instanceIds: ["st-char08", "st-vault1"] })).status).toBe(200);
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
