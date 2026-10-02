// Communism withdraws as the hub request runner queues them: picked items one
// trade per character (bounded by its slots), and under advanced management
// (docs/relay/ADVANCED.md) a pick bigger than a character split into trades
// back to back, and "N of this item", the node picking the copies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db";
import { registerAdvancedSettings } from "../advanced";
import { DEFAULT_ADVANCED } from "../../node/settings";
import { onPendingChange } from "../queue";
import { countWant, createCommunismWithdraw } from "../communismWithdraw";
import type { PyrelayPool } from "../devauth";

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "communism-withdraw-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("MAX_OPEN_WITHDRAWS", "0");
  db = openDatabase(":memory:");
});
afterEach(() => {
  registerAdvancedSettings(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const advanced = (on: boolean) => registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, communism: on }));

const A = "bot-guid-aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bot-guid-bbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "bot-guid-cccccccccccccccccccccccccc";
const inst = (instanceId: string, itemId: string, enchantments: number[] = []) => ({ instanceId, itemId, enchantments, capturedAt: 1 });
const vault = (instanceId: string, itemId: string, slot: number, enchantments: number[] = []) => ({ ...inst(instanceId, itemId, enchantments), where: { kind: "vault" as const, slot, seasonal: true }, pools: { seasonal: true, nonseasonal: false } });
const onChar = (instanceId: string, itemId: string, charId: number, slot: number) => ({ ...inst(instanceId, itemId), where: { kind: "char" as const, charId, slot, className: "Wizard", level: 20, capacity: 8, seasonal: true }, pools: { seasonal: true, nonseasonal: false } });

/**
 * Two seasonal communism accounts and a pool bot. A plays a 4-slot character
 * with three Defense potions (one enchanted copy of nothing, just plain) and
 * keeps two more in its vault, plus one on character 2; B keeps six in its
 * vault and one worn ring. The pool bot's potion is never communism's.
 */
function pool(overrides: Partial<PyrelayPool> = {}): PyrelayPool {
  return {
    ok: true,
    bots: { [A]: { pdef: 3, patk: 1 }, [B]: {}, [C]: { pdef: 1 } },
    capacities: { [A]: 4, [B]: 8, [C]: 8 },
    instances: { [A]: { 4: inst("a-1", "pdef"), 5: inst("a-2", "pdef"), 6: inst("a-3", "pdef"), 7: inst("a-atk", "patk") }, [B]: {}, [C]: { 4: inst("c-1", "pdef") } },
    stored: {
      [A]: [vault("a-v1", "pdef", 0), vault("a-v2", "pdef", 1), onChar("a-c2", "pdef", 2, 4)],
      [B]: [...Array.from({ length: 6 }, (_, i) => vault(`b-v${i}`, "pdef", i)), vault("b-ench", "pdef", 6, [7]), { ...inst("b-ring", "pdef"), where: { kind: "worn" as const, charId: 9, slot: 3, className: "Wizard", level: 20, seasonal: true }, pools: { seasonal: true, nonseasonal: false } }],
    },
    botMeta: {
      [A]: { ign: "Alpha", server: "", online: false, seasonal: true, communism: true },
      [B]: { ign: "Bravo", server: "", online: false, seasonal: true, communism: true },
      [C]: { ign: "PoolBot", server: "", online: false, seasonal: true },
    },
    ...overrides,
  };
}
const rows = () => db.prepare("SELECT id, target_bot_guid AS bot, instance_ids_json, items_json, group_id, communism FROM withdraw_requests ORDER BY id").all() as { id: number; bot: string; instance_ids_json: string; items_json: string; group_id: string; communism: number }[];
const ids = (r: { instance_ids_json: string }) => JSON.parse(r.instance_ids_json) as string[];
const req = (o: Partial<Parameters<typeof createCommunismWithdraw>[2]>) => ({ ign: "Gwen", server: "USEast", seasonal: true, ...o });

describe("picked communism items", () => {
  it("one trade per character; more picks than its slots are refused while advanced management is off", () => {
    const five = ["a-1", "a-2", "a-3", "a-v1", "a-v2"];
    expect(createCommunismWithdraw(db, pool(), req({ instanceIds: five }))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("at most 4 items in one trade") });
    expect(rows()).toEqual([]);
    const r = createCommunismWithdraw(db, pool(), req({ instanceIds: ["a-1", "a-v1", "a-c2"] }));
    expect(r).toMatchObject({ ok: true, fetched: 1 });
    // The played character's trade first (with the fetched one), then character 2's.
    expect(rows().map((x) => [x.bot, ids(x)])).toEqual([[A, ["a-1", "a-v1"]], [A, ["a-c2"]]]);
  });

  it("advanced management hands a bigger pick over in trades back to back, the character's own items first", () => {
    advanced(true);
    let heard = 0;
    const off = onPendingChange(() => heard++);
    const r = createCommunismWithdraw(db, pool(), req({ instanceIds: ["a-v2", "a-1", "a-2", "a-v1", "a-3", "a-c2"] }));
    off();
    expect(r).toMatchObject({ ok: true, fetched: 2 });
    const got = rows();
    expect(got.map((x) => ids(x))).toEqual([["a-1", "a-2", "a-3", "a-v1"], ["a-v2"], ["a-c2"]]);
    expect(new Set(got.map((x) => x.group_id)).size).toBe(1);
    expect(got.every((x) => x.communism === 1 && x.bot === A)).toBe(true);
    expect(heard).toBe(1);
  });
});

describe("N of this item (advanced management)", () => {
  it("is refused while advanced management is off for communism", () => {
    expect(createCommunismWithdraw(db, pool(), req({ want: [{ itemId: "pdef", qty: 2 }] }))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("item by item") });
    expect(rows()).toEqual([]);
  });

  it("takes plain copies from as few accounts as it can, the played character's first", () => {
    advanced(true);
    // A and B hold six plain copies each (B's enchanted one and the worn one never count); A has some on its
    // character, so five come off A alone: its 4-slot character's three and two out of its vault, in two trades.
    expect(createCommunismWithdraw(db, pool(), req({ want: [{ itemId: "pdef", qty: 5 }] }))).toMatchObject({ ok: true, fetched: 2 });
    expect(rows().map((x) => [x.bot, ids(x)])).toEqual([[A, ["a-1", "a-2", "a-3", "a-v1"]], [A, ["a-v2"]]]);
    db.prepare("DELETE FROM withdraw_requests").run();
    // With A gone, all from B's vault.
    const noA = pool({ botMeta: { ...pool().botMeta!, [A]: { ign: "Alpha", server: "", online: false, seasonal: true, communism: true, suspended: true } } });
    expect(createCommunismWithdraw(db, noA, req({ want: [{ itemId: "pdef", qty: 5 }] }))).toMatchObject({ ok: true, fetched: 5 });
    expect(rows().map((x) => [x.bot, ids(x).length])).toEqual([[B, 5]]);
    db.prepare("DELETE FROM withdraw_requests").run();
    // Seven: all six of A's (character, vault, then character 2) and one of B's. A's character takes 4 per trade.
    expect(createCommunismWithdraw(db, pool(), req({ want: [{ itemId: "pdef", qty: 7 }] }))).toMatchObject({ ok: true });
    const got = rows().map((x) => [x.bot, ids(x)]);
    expect(got).toEqual([[A, ["a-1", "a-2", "a-3", "a-v1"]], [A, ["a-v2"]], [A, ["a-c2"]], [B, ["b-v0"]]]);
  });

  it("from other characters, the fewest trades: the smallest stack that covers what is left, else the biggest first", () => {
    advanced(true);
    // D plays an empty character; its Vitality potions sit on characters 76 (1), 99 (7), 169 (8) and 188 (5).
    const D = "bot-guid-dddddddddddddddddddddddddd";
    const stacks: [number, number][] = [[76, 1], [99, 7], [169, 8], [188, 5]];
    const stored = stacks.flatMap(([charId, n]) => Array.from({ length: n }, (_, i) => onChar(`d-${charId}-${i}`, "pvit", charId, 4 + i)));
    const only = pool({ bots: { [D]: {} }, capacities: { [D]: 8 }, instances: { [D]: {} }, stored: { [D]: stored }, botMeta: { [D]: { ign: "Delta", server: "", online: false, seasonal: true, communism: true } } });
    const chars = () => rows().map((x) => [...new Set(ids(x).map((id) => Number(id.split("-")[1])))]);
    const ask = (qty: number) => {
      db.prepare("DELETE FROM withdraw_requests").run();
      expect(createCommunismWithdraw(db, only, req({ want: [{ itemId: "pvit", qty }] }))).toMatchObject({ ok: true });
      return chars();
    };
    expect(ask(3)).toEqual([[188]]);
    expect(ask(6)).toEqual([[99]]);
    expect(ask(8)).toEqual([[169]]);
    // Nothing smaller covers 1: the single copy on 76.
    expect(ask(1)).toEqual([[76]]);
  });

  it("leaves out copies spoken for, and an account busy on another server keeps what is on its character", () => {
    advanced(true);
    const busy = pool({ botMeta: { ...pool().botMeta!, [A]: { ign: "Alpha", server: "EUWest", online: true, seasonal: true, communism: true } } });
    // Someone already picked two of B's copies.
    expect(createCommunismWithdraw(db, pool(), req({ instanceIds: ["b-v0", "b-v1"] }))).toMatchObject({ ok: true });
    expect(createCommunismWithdraw(db, busy, req({ want: [{ itemId: "pdef", qty: 8 }] }))).toMatchObject({ ok: false, status: 409, error: "Only 7 Potion of Defense left in seasonal communism right now." });
    expect(createCommunismWithdraw(db, busy, req({ ign: "Other", want: [{ itemId: "pdef", qty: 7 }] }))).toMatchObject({ ok: true });
    const taken = rows().slice(1).flatMap(ids);
    expect(taken).toHaveLength(7);
    expect(taken.some((id) => ["a-1", "a-2", "a-3", "b-v0", "b-v1", "b-ench", "b-ring", "c-1"].includes(id))).toBe(false);
  });

  it("leaves alone the copies the hub holds for other requests", () => {
    advanced(true);
    // The hub holds A's three character copies and two of B's for withdraws by ref (some still waiting their turn).
    const held = ["a-1", "a-2", "a-3", "b-v0", "b-v1"];
    expect(createCommunismWithdraw(db, pool(), req({ want: [{ itemId: "pdef", qty: 8 }], exclude: held }))).toMatchObject({ ok: false, error: "Only 7 Potion of Defense left in seasonal communism right now." });
    expect(createCommunismWithdraw(db, pool(), req({ want: [{ itemId: "pdef", qty: 5 }], exclude: held }))).toMatchObject({ ok: true });
    // B's four that are left, then the first of A's (its vault, A's character copies being held).
    expect(rows().flatMap(ids).sort()).toEqual(["a-v1", "b-v2", "b-v3", "b-v4", "b-v5"]);
  });

  it("reads the hub's want lines: plain copies, each item once, one withdraw's worth", () => {
    const line = (itemId: string, qty: number, slotsExact: number | null = 0) => ({ itemId, qty, slotsMin: 0, slotsExact, enchants: [] });
    expect(countWant([line("pdef", 2), line("pdef", 1), line("patk", 1)])).toEqual([{ itemId: "pdef", qty: 3 }, { itemId: "patk", qty: 1 }]);
    expect(countWant([line("pdef", 1, 2)])).toMatch(/plain copies/);
    expect(countWant([line("nope", 1)])).toBe("Unknown item.");
    expect(countWant([line("pdef", 0)])).toMatch(/at least one/);
    expect(countWant([line("pdef", 9)])).toMatch(/At most 8/);
    expect(countWant([])).toMatch(/at least one/);
  });
});
