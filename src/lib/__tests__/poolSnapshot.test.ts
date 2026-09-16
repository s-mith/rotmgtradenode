// The served pool: compact wire form, one snapshot per fleet state, deltas by
// revision, and the browser-side apply that must reproduce what
// projectInstances says the grid shows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import type { PyrelayPool } from "../devauth";
import type { PoolWire } from "../poolWire";

let db: Database.Database;
let poolNow: PyrelayPool;

vi.mock("../db", async (orig) => ({ ...(await orig<typeof import("../db")>()), getDb: () => db }));
vi.mock("../devauth", async (orig) => ({
  ...(await orig<typeof import("../devauth")>()),
  pyrelay: { pool: async () => ({ ok: true as const, status: 200, data: poolNow }) },
}));

const { openDatabase } = await import("../db");
const { projectInstances } = await import("../pool");
const { applyPoolWire, emptyPoolState, instancesFromState } = await import("../poolWire");
const { computeSnapshot, markPoolDirty, poolDelta, refreshPoolSnapshot, resetPoolSnapshot } = await import("../poolSnapshot");
const { GET } = await import("../../server/api/pool/route");
const { userForIgn } = await import("../users");
const { claimInstances, vaultBotCandidates } = await import("../vault");

type Slots = PyrelayPool["instances"][string];
const T0 = 1_800_000_000_000;
const slot = (id: string, itemId = "ubatk", enchantments: number[] = [], at = T0): Slots[string] => ({ instanceId: id, itemId, enchantments, capturedAt: at });
const META: NonNullable<PyrelayPool["botMeta"]> = {
  "bot-A": { ign: "BotA", server: "USEast", online: true, seasonal: true },
  "bot-B": { ign: "BotB", server: "", online: false, seasonal: false },
  "bot-C": { ign: "BotC", server: "", online: false, seasonal: true },
};
function fleet(spec: Record<string, Slots>, meta = META): PyrelayPool {
  const bots: PyrelayPool["bots"] = {};
  for (const [g, slots] of Object.entries(spec)) {
    bots[g] = {};
    for (const s of Object.values(slots)) bots[g][s.itemId] = (bots[g][s.itemId] ?? 0) + 1;
  }
  return { ok: true, bots, capacities: {}, instances: spec, botMeta: meta };
}
const parse = <T = PoolWire>(json: string): T => JSON.parse(json) as T;
const decode = (msg: PoolWire) => {
  const st = emptyPoolState();
  expect(applyPoolWire(st, msg)).toBe("replaced");
  return instancesFromState(st);
};

const NONE = new Set<string>();

describe("pool wire form", () => {
  it("reproduces the per-instance projection, names included", () => {
    const pool = fleet({
      "bot-A": { "4": slot("inst-1"), "5": slot("inst-2", "acsl", [283]) },
      "bot-B": { "4": slot("inst-3", "ubatk", [283, 999999]) },
    });
    const snap = computeSnapshot(null, pool, NONE, "[]");
    const full = parse(snap.fullJson);
    expect(full.full).toBe(true);
    expect(decode(full)).toEqual(projectInstances(pool));
    // Names travel once, in dictionaries.
    const f = full as Extract<PoolWire, { full: true }>;
    expect(f.items).toEqual({ ubatk: expect.any(String), acsl: "Acidic Slasher" });
    expect(f.enchants["283"]).toBe("Speed Bonus I");
    expect(f.enchants["999999"]).toBeUndefined();
  });

  it("keeps the revision when only capturedAt moved, and drops what the catalog does not know", () => {
    const a = fleet({ "bot-A": { "4": slot("inst-1"), "5": slot("inst-x", "no-such-item") } });
    const s1 = computeSnapshot(null, a, NONE, "[]");
    expect(decode(parse(s1.fullJson)).map((i) => i.instanceId)).toEqual(["inst-1"]);
    const s2 = computeSnapshot(s1, fleet({ "bot-A": { "4": slot("inst-1", "ubatk", [], T0 + 5000) } }), NONE, "[]");
    expect(s2).toBe(s1);
    // Same content from a cold start hashes the same: a restarted server can
    // still answer "unchanged" to a tab that kept its revision.
    expect(computeSnapshot(null, a, NONE, "[]").rev).toBe(s1.rev);
  });

  it("answers deltas by revision and the browser patches to the same grid", () => {
    const s1 = computeSnapshot(null, fleet({ "bot-A": { "4": slot("inst-1"), "5": slot("inst-2") }, "bot-B": { "4": slot("inst-3") } }), NONE, "[]");
    const s2 = computeSnapshot(s1, fleet({ "bot-A": { "4": slot("inst-1") }, "bot-B": { "4": slot("inst-3") }, "bot-C": { "4": slot("inst-4", "acsl", [283]) } }), NONE, "[]");
    const s3 = computeSnapshot(s2, fleet({ "bot-A": { "4": slot("inst-1") }, "bot-C": { "4": slot("inst-4", "acsl", [283]) } }), NONE, "[]");
    expect(new Set([s1.rev, s2.rev, s3.rev]).size).toBe(3);

    const d12 = parse<Extract<PoolWire, { full: false }>>(poolDelta(s2, s1.rev)!);
    expect(Object.keys(d12.bots).sort()).toEqual(["bot-A", "bot-C"]);
    expect(d12.bots["bot-A"]!.slots).toEqual([["inst-1", "ubatk", []]]);
    expect(d12.items).toEqual({ ubatk: expect.any(String), acsl: "Acidic Slasher" });
    expect(d12.enchants).toEqual({ "283": "Speed Bonus I" });

    const d13 = parse<Extract<PoolWire, { full: false }>>(poolDelta(s3, s1.rev)!);
    expect(Object.keys(d13.bots).sort()).toEqual(["bot-A", "bot-B", "bot-C"]);
    expect(d13.bots["bot-B"]).toBeNull();
    expect(parse(poolDelta(s3, s2.rev)!).bots).toEqual({ "bot-B": null });
    expect(parse(poolDelta(s3, s3.rev)!)).toMatchObject({ rev: s3.rev, since: s3.rev, full: false, bots: {} });
    expect(poolDelta(s3, "never-seen")).toBeNull();

    // A tab at s1 patched with the s1->s3 delta shows exactly the s3 grid.
    const st = emptyPoolState();
    applyPoolWire(st, parse(s1.fullJson));
    expect(applyPoolWire(st, d13)).toBe("patched");
    expect(st.rev).toBe(s3.rev);
    expect(instancesFromState(st)).toEqual(decode(parse(s3.fullJson)));
    // The same delta on the wrong base is refused, not half-applied.
    const other = emptyPoolState();
    applyPoolWire(other, parse(s2.fullJson));
    expect(applyPoolWire(other, d13)).toBe("mismatch");
    expect(other.rev).toBe(s2.rev);
    expect(applyPoolWire(other, parse(poolDelta(s2, s2.rev)!))).toBe("unchanged");
  });

  it("hides owned instances and carries a changed catalog in the delta", () => {
    const pool = fleet({ "bot-A": { "4": slot("inst-1"), "5": slot("inst-2") } });
    const s1 = computeSnapshot(null, pool, new Set(["inst-1"]), "[]");
    expect(decode(parse(s1.fullJson)).map((i) => i.instanceId)).toEqual(["inst-2"]);
    const s2 = computeSnapshot(s1, pool, new Set(["inst-1"]), '[{"itemId":"ubatk"}]');
    expect(s2.rev).not.toBe(s1.rev);
    const d = parse<Extract<PoolWire, { full: false }>>(poolDelta(s2, s1.rev)!);
    expect(d.bots).toEqual({});
    expect(d.catalog).toEqual([{ itemId: "ubatk" }]);
    expect(parse(poolDelta(s2, s2.rev)!)).not.toHaveProperty("catalog");
  });
});

describe("GET /api/pool", () => {
  beforeEach(() => {
    db = openDatabase(":memory:");
    resetPoolSnapshot();
    poolNow = fleet({ "bot-A": { "4": slot("inst-1"), "5": slot("inst-2", "acsl", [283]) } });
  });
  afterEach(() => {
    db.close();
    resetPoolSnapshot();
  });
  const get = (path: string, headers: Record<string, string> = {}) => GET(new Request(`http://site.local${path}`, { headers }));

  it("serves one gzipped snapshot with an ETag, 304 on a match, and the same bytes to everyone", async () => {
    const r1 = await get("/api/pool?v=2", { "accept-encoding": "gzip, deflate, br" });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-encoding")).toBe("gzip");
    expect(r1.headers.get("vary")).toBe("Accept-Encoding");
    const etag = r1.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const body = parse<Extract<PoolWire, { full: true }>>(gunzipSync(Buffer.from(await r1.arrayBuffer())).toString("utf8"));
    expect(body.full).toBe(true);
    expect(body.rev).toBe(etag.slice(1, -1));
    expect(Object.keys(body.bots)).toEqual(["bot-A"]);
    expect(body.catalog.length).toBeGreaterThan(100);
    expect(decode(body)).toEqual(projectInstances(poolNow));

    const r2 = await get("/api/pool?v=2", { "accept-encoding": "gzip", "if-none-match": etag });
    expect(r2.status).toBe(304);
    const r3 = await get("/api/pool?v=2");
    expect(r3.headers.get("content-encoding")).toBeNull();
    expect(r3.headers.get("etag")).toBe(etag);
    expect(parse(await r3.text())).toEqual(body);
  });

  it("tells a page from before the format change to reload instead of sending it the pool", async () => {
    const r = await get("/api/pool");
    expect(r.status).toBe(200);
    const legacy = (await r.json()) as { instances: unknown[]; error: string; bots: Record<string, unknown> };
    expect(legacy.instances).toEqual([]);
    expect(legacy.bots).toEqual({});
    expect(legacy.error).toMatch(/reload/i);
    expect(Number(r.headers.get("content-length") ?? 0)).toBeLessThan(400);
  });

  it("answers ?since= with only what changed, and in full when it cannot", async () => {
    const first = parse<Extract<PoolWire, { full: true }>>(await (await get("/api/pool?v=2")).text());
    poolNow = fleet({ "bot-A": { "4": slot("inst-1"), "5": slot("inst-2", "acsl", [283]) }, "bot-C": { "4": slot("inst-9") } });
    markPoolDirty();
    const r = await get(`/api/pool?since=${first.rev}`, { "accept-encoding": "gzip" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull(); // a few hundred bytes: not worth a gzip header
    const d = parse<Extract<PoolWire, { full: false }>>(await r.text());
    expect(d).toMatchObject({ full: false, since: first.rev });
    expect(Object.keys(d.bots)).toEqual(["bot-C"]);
    const st = emptyPoolState();
    applyPoolWire(st, first);
    expect(applyPoolWire(st, d)).toBe("patched");
    expect(instancesFromState(st)).toEqual(projectInstances(poolNow));

    const same = parse(await (await get(`/api/pool?since=${d.rev}`)).text());
    expect(same).toMatchObject({ full: false, bots: {} });
    const full = parse(await (await get("/api/pool?since=stale-rev")).text());
    expect(full.full).toBe(true);
  });

  it("drops an instance the moment it becomes somebody's property", async () => {
    const before = parse<Extract<PoolWire, { full: true }>>(await (await get("/api/pool?v=2")).text());
    expect(before.bots["bot-A"].slots.map((s) => s[0])).toEqual(["inst-1", "inst-2"]);
    const userId = userForIgn(db, "Comrade", "comrade");
    const actor = { userId, ign: "Comrade", ignLower: "comrade" };
    const r = claimInstances(db, actor, [{ instanceId: "inst-1", itemId: "ubatk", enchants: 0, botGuid: "bot-A", seasonal: true }], vaultBotCandidates(db, poolNow, true, userId));
    expect(r).toMatchObject({ ok: true, claimed: 1 });
    // claimInstances raises the pool-changed signal itself; the snapshot is
    // re-checked on the next read whether or not the fleet object changed.
    const after = parse<Extract<PoolWire, { full: false }>>(await (await get(`/api/pool?since=${before.rev}`)).text());
    expect(after.bots["bot-A"]!.slots.map((s) => s[0])).toEqual(["inst-2"]);
    expect((await refreshPoolSnapshot())!.rev).toBe(after.rev);
  });
});
