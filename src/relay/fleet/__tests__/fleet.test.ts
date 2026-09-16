import { describe, expect, it } from "vitest";
import fixtures from "./fixtures.json";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectionTargets, electRoles, fragmentation, planMoves, splitStats, type Inventories } from "../potionConsolidation";
import { InventoryTracker } from "../inventoryTracker";
import { deriveBotGuid } from "../botPool";
import { ProxyPool } from "../proxyPool";
import { HttpSiteApi } from "../siteApi";
import { parseProxyList, type Proxy } from "../../net/proxy";

describe("bot guid", () => {
  for (const g of fixtures.guids) {
    it(`derives ${g.email}`, () => expect(deriveBotGuid(g.email)).toBe(g.botGuid));
  }
});

describe("proxy pinning", () => {
  for (const p of fixtures.pins) {
    it(`ranks hosts for ${p.guid} like pyrelay`, () => {
      const pool = new ProxyPool(p.hosts.map((host): Proxy => ({ host, port: 1080, type: 5, username: "", password: "" })));
      expect(pool.preferenceFor(p.guid)).toEqual(p.preference);
    });
  }
  it("gives each account its home host and never shares one", () => {
    const hosts = fixtures.pins[0].hosts;
    const pool = new ProxyPool(hosts.map((host): Proxy => ({ host, port: 1080, type: 5, username: "", password: "" })));
    const a = pool.claim("a@example.com")!;
    expect(a.host).toBe(pool.preferenceFor("a@example.com")[0]);
    const taken = new Set([a.host]);
    for (let i = 0; i < hosts.length - 1; i++) {
      const p = pool.claim(`other${i}@example.com`)!;
      expect(taken.has(p.host)).toBe(false);
      taken.add(p.host);
    }
    expect(pool.claim("late@example.com")).toBeNull();
    pool.release("a@example.com");
    expect(pool.claim("a@example.com")!.host).toBe(a.host);
  });
});

describe("potion consolidation planner", () => {
  const caps = (inv: Inventories, cap = 8) => Object.fromEntries(Object.keys(inv).map((g) => [g, cap]));

  it("elects roles by majority and keeps them until clearly outgrown", () => {
    expect(electRoles({ A: { patk: 3, pdef: 4 } })).toEqual({ A: "def" });
    expect(electRoles({ A: { patk: 3, pdef: 4 } }, { previous: { A: "atk" } })).toEqual({ A: "atk" });
    expect(electRoles({ A: { patk: 1, pdef: 4 } }, { previous: { A: "atk" } })).toEqual({ A: "def" });
    expect(electRoles({ A: { pdef: 4 } }, { previous: { A: "atk" } })).toEqual({ A: "def" });
    expect(electRoles({ A: { sep: 1 } })).toEqual({ A: "misc" });
    expect(electRoles({ A: { sep: 2, pdef: 2 } })).toEqual({ A: "def" }); // potions win ties
  });

  it("picks the biggest holders as collectors and merges lesser ones upward", () => {
    // B collects atk (its majority) but holds the most def too: def flows to B, not away from it.
    const inv: Inventories = { A: { pdef: 3 }, B: { patk: 8, pdef: 7 }, C: { pdef: 1 } };
    const caps16 = { A: 8, B: 16, C: 8 };
    expect(collectionTargets(inv, { capacities: caps16 })).toEqual({ def: ["B", "A"] });
    const moves = planMoves(inv, caps16);
    expect(moves.map((m) => `${m.giver}>${m.taker}:${m.items.pdef}`)).toEqual(["C>B:1"]);
    // A is the lesser def collector: once B has room for A's stack, A hands it up.
    expect(planMoves({ A: { pdef: 3 }, B: { patk: 4, pdef: 7 } }, caps16).map((m) => `${m.giver}>${m.taker}:${m.items.pdef}`)).toEqual(["A>B:3"]);
    // Never downhill: a stack is not split to seed a smaller collector. (Only
    // reachable with role-first collectors; by size the collector is always the bigger stack.)
    const roleFirst: Inventories = { A: { pdef: 2, patk: 1, pspd: 1, pwis: 1 }, B: { patk: 7, pdef: 6 } };
    expect(planMoves(roleFirst, { A: 8, B: 16 }, { order: "role" }).filter((m) => m.stat === "def")).toEqual([]); // A collects def but only 3 fit: B would keep a bigger stack
    expect(planMoves(roleFirst, { A: 8, B: 16 })[0]).toMatchObject({ giver: "A", taker: "B", items: { pdef: 2 } });
  });

  it("picks as many collectors as the bucket needs", () => {
    const inv: Inventories = { A: { pdef: 5 }, B: { pdef: 5 }, C: { pdef: 5 }, D: { pdef: 5 }, E: { pdef: 5 }, F: { pdef: 5 }, G: {}, H: {} };
    expect(collectionTargets(inv, { capacities: caps(inv) })).toEqual({ def: ["A", "B", "C", "D"] });
    expect(collectionTargets(inv, { capacities: caps(inv, 16) })).toEqual({ def: ["A", "B"] });
    expect(collectionTargets({ A: { pdef: 5 }, B: { patk: 1 } })).toEqual({});
  });

  it("gathers a bucket onto its collector, greaters first, and fills it", () => {
    const inv: Inventories = { A: { pdef: 5 }, B: { pdef: 1, gpdef: 2, patk: 1 } };
    const moves = planMoves(inv, caps(inv));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ giver: "B", taker: "A", kind: "give", stat: "def", items: { gpdef: 2, pdef: 1 } });
    expect(moves[0].score).toBeCloseTo(9); // 3 moved, clears the giver, fills the collector, giver down to 1 of 8, 5 already there
  });

  it("never moves what a pending withdraw counts on", () => {
    const inv: Inventories = { A: { pdef: 5 }, B: { pdef: 3 } };
    expect(planMoves(inv, caps(inv), { reserved: { B: { pdef: 3 } } })).toEqual([]);
    expect(planMoves(inv, caps(inv), { reserved: { B: { pdef: 2 } } })[0]).toMatchObject({ giver: "B", items: { pdef: 1 } }); // leaves B nearly empty: worth it
    const far: Inventories = { A: { pdef: 5 }, B: { pdef: 3, ubatk: 5 } };
    expect(planMoves(far, { A: 8, B: 8 }, { reserved: { B: { pdef: 2 } } })).toEqual([]); // one potion off a bot that stays full isn't worth a trade
  });

  it("prefers the move that frees a whole bot over a bigger one that doesn't", () => {
    const inv: Inventories = { A: { pdef: 4 }, B: { pdef: 3, patk: 3 }, C: { pdef: 1 } };
    const moves = planMoves(inv, caps(inv), { maxMoves: 1 });
    expect(moves[0]).toMatchObject({ giver: "C", taker: "A", reason: "1 def, empties the giver" });
    expect(moves[0].score).toBeCloseTo(9.2);
    const all = planMoves(inv, caps(inv));
    expect(all.map((m) => `${m.giver}>${m.taker}`)).toEqual(["C>A"]); // A is busy after the first; B waits for the next pass
  });

  it("swaps when two bots hold each other's bucket and neither has room", () => {
    const inv: Inventories = { A: { pdef: 5, patk: 3 }, B: { patk: 5, pdef: 3 } };
    const moves = planMoves(inv, caps(inv));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "swap", giver: "A", taker: "B", items: { patk: 3 }, swapItems: { pdef: 3 }, stat: "def<>atk" });
    expect(moves[0].score).toBeCloseTo(15.5);
    expect(planMoves(inv, caps(inv), { allowSwaps: false })).toEqual([]);
  });

  it("fits a swap to the room each side has", () => {
    const inv: Inventories = { A: { pdef: 5, patk: 3 }, B: { patk: 3, pdef: 2, sep: 3 } };
    const [m] = planMoves(inv, caps(inv));
    expect(m).toMatchObject({ kind: "swap", items: { patk: 2 }, swapItems: { pdef: 2 } }); // both full: A can only take as many as it gives
  });

  it("tops up the bot a stranded withdraw is pinned to before anything else", () => {
    const inv: Inventories = { A: { pdef: 6 }, B: { pdef: 2, gpdef: 1 }, C: { patk: 2 } };
    const moves = planMoves(inv, caps(inv), { demand: [{ items: { gpdef: 1, pdef: 1 }, target: "A" }], maxMoves: 1 });
    expect(moves[0]).toMatchObject({ kind: "demand", giver: "B", taker: "A", items: { gpdef: 1 } });
    expect(moves[0].score).toBeCloseTo(22.5);
  });

  it("picks the bot that already covers most of an unpinned stranded withdraw", () => {
    const inv: Inventories = { A: { pdef: 2, patk: 1 }, B: { pdef: 1 }, C: { patk: 3 } };
    const moves = planMoves(inv, caps(inv), { demand: [{ items: { pdef: 2, patk: 2 }, target: null }], maxMoves: 1 });
    expect(moves[0]).toMatchObject({ kind: "demand", giver: "C", taker: "A", items: { patk: 1 } });
  });

  it("charges for wakes and server hops, and skips what isn't worth a trade", () => {
    const inv: Inventories = { A: { pdef: 5 }, B: { pdef: 1 } };
    expect(planMoves(inv, caps(inv))[0].score).toBeCloseTo(9.25);
    expect(planMoves(inv, caps(inv), { online: new Set(["A"]) })[0].score).toBeCloseTo(7.25);
    expect(planMoves(inv, caps(inv), { online: new Set(["A"]), minScore: 8 })).toEqual([]);
    expect(planMoves(inv, caps(inv), { online: new Set(["A", "B"]), servers: { A: "USEast", B: "EUWest" } })[0].score).toBeCloseTo(6.25);
    expect(planMoves(inv, caps(inv), { online: new Set(["A", "B"]), servers: { A: "USEast", B: "USEast" } })[0].score).toBeCloseTo(9.25);
  });

  it("splits greaters into their own bucket once each kind can fill a bot", () => {
    const inv: Inventories = { A: { pdef: 8 }, B: { gpdef: 8 }, C: { pdef: 1, gpdef: 1 } };
    expect([...splitStats(inv)]).toEqual(["def"]);
    expect(splitStats({ A: { pdef: 8 }, B: { gpdef: 7 } }).size).toBe(0);
    expect(splitStats(inv, { mode: "never" }).size).toBe(0);
    expect(collectionTargets(inv, { capacities: caps(inv) })).toEqual({ pdef: ["A", "C"], gpdef: ["B", "C"] }); // both full: C keeps the overflow of each
    expect(collectionTargets(inv, { capacities: caps(inv), split: new Set() })).toEqual({ def: ["A", "B", "C"] });
  });

  it("gathers everything that isn't a potion as one more bucket, emptying bots", () => {
    const inv: Inventories = { A: { sep: 3, ubatk: 1 }, B: { sep: 1, plife: 1 }, C: { ubdef: 2 } };
    expect(collectionTargets(inv, { capacities: caps(inv) })).toEqual({ misc: ["A"] });
    const moves = planMoves(inv, caps(inv));
    expect(moves).toEqual([expect.objectContaining({ kind: "give", stat: "misc", giver: "C", taker: "A", items: { ubdef: 2 }, reason: "2 misc, empties the giver" })]);
    // A lone non-potion stack stays put: moving it frees nothing.
    expect(planMoves({ A: { pdef: 6, sep: 2 }, B: { pdef: 4 }, C: {} }, caps(inv))).toEqual([]);
    // A hinted deposit of gear lands on the misc collector.
    expect(collectionTargets({ A: { sep: 3 }, B: { ubatk: 1 }, C: { pdef: 5 } }, { capacities: caps(inv) })).toEqual({ misc: ["A"] });
  });

  it("carries instance ids across a consolidation trade", () => {
    const t = new InventoryTracker(path.join(os.tmpdir(), `inv-${process.pid}-${Date.now()}.json`));
    t.updateFromSlots("G", { 4: { itemId: "ubatk", enchantments: [1] }, 5: { itemId: "ubatk", enchantments: [] } }, 8);
    const plain = Object.values(t.instancesFor("G")).find((i) => !i.enchantments.length)!;
    t.noteTransfer("G", "T", [{ itemId: "ubatk", qty: 1 }]);
    t.updateFromSlots("T", { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    expect(t.instancesFor("T")[4].instanceId).toBe(plain.instanceId); // the least-enchanted copy is what the giver offered
    t.updateFromSlots("G", { 4: { itemId: "ubatk", enchantments: [1] } }, 8);
    expect(Object.keys(t.instancesFor("G"))).toEqual(["4"]);
    t.updateFromSlots("T", { 4: { itemId: "ubatk", enchantments: [] }, 5: { itemId: "ubatk", enchantments: [] } }, 8);
    expect(t.instancesFor("T")[5].instanceId).not.toBe(plain.instanceId); // nothing in flight: a fresh id
    t.close();
  });

  it("is deterministic and never plans a bot into two moves", () => {
    const inv: Inventories = { A: { pdef: 3, patk: 2 }, B: { pdef: 2, patk: 3 }, C: { pdef: 1 }, D: { patk: 1 }, E: {} };
    const a = planMoves(inv, caps(inv));
    const b = planMoves(inv, caps(inv));
    expect(a).toEqual(b);
    const seen = new Set<string>();
    for (const m of a) {
      expect(seen.has(m.giver) || seen.has(m.taker)).toBe(false);
      seen.add(m.giver);
      seen.add(m.taker);
    }
  });

  it("measures how spread out the pool is", () => {
    const tidy = fragmentation({ A: { pdef: 8 }, B: { pdef: 8 } }, { capacities: { A: 8, B: 8 } });
    expect(tidy.score).toBe(1);
    expect(tidy.tradesFor16.def).toBe(2);
    expect(tidy.tradesFor16.atk).toBeNull();
    const spread = fragmentation({ A: { pdef: 4 }, B: { pdef: 4 }, C: { pdef: 4 }, D: { pdef: 4 } }, { capacities: { A: 8, B: 8, C: 8, D: 8 } });
    expect(spread.buckets.def).toEqual({ total: 16, holders: 4, ideal: 2, largest: 4 });
    expect(spread.score).toBe(0.5);
    expect(spread.tradesFor16.def).toBe(4);
    expect(fragmentation({}).score).toBe(1);
    const half = fragmentation({ A: { pdef: 4 }, B: { pdef: 4 }, C: {}, D: { sep: 1 } }, { capacities: { A: 8, B: 8, C: 8, D: 8 } });
    expect(half).toMatchObject({ items: 9, potions: 8, bots: 4, emptyBots: 1, couldBeEmpty: 2 });
  });
});

describe("site api signatures vs pyrelay", () => {
  class Capture extends HttpSiteApi {
    calls: { path: string; body: Record<string, unknown> }[] = [];
    protected override async post<T>(path: string, body: Record<string, unknown>) {
      this.calls.push({ path, body });
      return { ok: true } as never as T & { ok: true };
    }
  }
  const f = fixtures.api;
  const api = new Capture("http://site", f.secret, 10_000, { now: () => f.now, nonce: () => f.nonce });
  it("produces byte-identical bodies", async () => {
    await api.heartbeat({ botGuid: "botguid1", alias: "Alias", ign: "IgnName", server: "USEast", freeSlots: 7, status: "idle", seasonal: false });
    await api.claimDeposit("botguid1", 5);
    await api.claimDeposit("botguid1");
    await api.claimWithdraw("botguid1", [{ itemId: "patk", qty: 2 }, { itemId: "ubatk", qty: 1 }], ["inst-b", "inst-a"]);
    await api.fulfillDeposit("botguid1", 42, [{ itemId: "ubatk", qty: 1 }, { itemId: "patk", qty: 2 }], [{ itemId: "patk", enchants: 0 }, { itemId: "ubatk", enchants: 2 }, { itemId: "patk", enchants: 0 }]);
    await api.fulfillDeposit("botguid1", 43, [{ itemId: "patk", qty: 1 }]);
    await api.fulfillWithdraw("botguid1", 44, [{ itemId: "ubatk", qty: 1 }], ["z-inst", "a-inst"]);
    await api.fulfillWithdraw("botguid1", 45, [{ itemId: "ubatk", qty: 1 }]);
    await api.registerPool(123);
    await api.unclaim("botguid1", 46, "deposit");
    await api.giveUp("botguid1", 47, "withdraw");
    await api.listPending();
    expect(api.calls.length).toBe(f.calls.length);
    for (let i = 0; i < f.calls.length; i++) {
      expect(api.calls[i].path).toBe(f.calls[i].path);
      expect(api.calls[i].body).toEqual(f.calls[i].body);
    }
  });
});

describe("connection budget", () => {
  it("is the enabled proxy count unless a ceiling is set, and a fixed number with no pool", async () => {
    const { onlineCapFor } = await import("../constants");
    expect(onlineCapFor(120, 0, 20)).toBe(120);
    expect(onlineCapFor(120, 50, 20)).toBe(50);
    expect(onlineCapFor(30, 50, 20)).toBe(30);
    expect(onlineCapFor(null, 0, 20)).toBe(20);
    expect(onlineCapFor(null, 5, 20)).toBe(5);
  });
});

describe("proxy pool source and operator switch", () => {
  const mk = (hosts: string[]): Proxy[] => hosts.map((host) => ({ host, port: 1080, type: 5, username: "u", password: "p" }));
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "proxypool-"));

  it("parses Webshare's host:port:user:pass download format", () => {
    const list = parseProxyList("1.2.3.4:5000:alice:s3cret\r\n\r\n# comment\n5.6.7.8:6000:bob:pw\njunk\n");
    expect(list).toEqual([
      { host: "1.2.3.4", port: 5000, type: 5, username: "alice", password: "s3cret" },
      { host: "5.6.7.8", port: 6000, type: 5, username: "bob", password: "pw" },
    ]);
  });

  it("disabled hosts are skipped by claim/probe and dropped from capacity, and persist", () => {
    const dir = tmp();
    const stateFile = path.join(dir, "proxy_settings.json");
    const pool = new ProxyPool(mk(["a", "b", "c"]), { stateFile });
    expect(pool.exclusiveCapacity()).toBe(3);
    expect(pool.setEnabled("b", false)).toBe(true);
    expect(pool.setEnabled("nope", false)).toBe(false);
    expect(pool.exclusiveCapacity()).toBe(2);
    expect(pool.configured).toBe(true);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const p = pool.claim(`acct${i}@example.com`);
      if (p) seen.add(p.host);
    }
    expect(seen.has("b")).toBe(false);
    expect(seen.size).toBe(2);
    expect(pool.probeFor("x@example.com")).toBeNull(); // both enabled hosts are occupied
    expect(pool.healthReport().find((h) => h.host === "b")).toMatchObject({ enabled: false, inUse: false });
    // Survives a restart.
    const again = new ProxyPool(mk(["a", "b", "c"]), { stateFile });
    expect(again.isEnabled("b")).toBe(false);
    expect(again.setAllEnabled(true)).toBe(1);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual({ disabled: [] });
    expect(again.setAllEnabled(false)).toBe(3);
    expect(again.exclusiveCapacity()).toBe(0);
    expect(again.claim("anyone@example.com")).toBeNull();
  });

  it("disabling an occupied host leaves the bot on it until release", () => {
    const pool = new ProxyPool(mk(["a"]));
    const p = pool.claim("bot@example.com")!;
    pool.setEnabled(p.host, false);
    expect(pool.healthReport()[0]).toMatchObject({ enabled: false, inUse: true, usedBy: "bot@example.com" });
    pool.release("bot@example.com");
    expect(pool.claim("bot@example.com")).toBeNull();
  });

  it("refresh downloads the list, caches it, and keeps state across the swap", async () => {
    const dir = tmp();
    const file = path.join(dir, "proxies.txt");
    const stateFile = path.join(dir, "proxy_settings.json");
    fs.writeFileSync(file, "1.1.1.1:1080:u:p\n2.2.2.2:1080:u:p\n");
    let body = "2.2.2.2:1080:u:p\n3.3.3.3:2000:u2:p2\n";
    let calls = 0;
    const fakeFetch = (async () => { calls++; return new Response(body, { status: 200 }); }) as unknown as typeof fetch;
    const pool = ProxyPool.fromSource({ url: "https://example.test/list", file, stateFile, fetch: fakeFetch });
    expect(pool.sourceStatus()).toMatchObject({ urlConfigured: true, loadedFrom: "file", fetchedAt: null });
    expect(pool.exclusiveCapacity()).toBe(2);
    pool.setEnabled("2.2.2.2", false);
    const held = pool.claim("bot@example.com")!;
    expect(held.host).toBe("1.1.1.1");

    const r = await pool.refresh();
    expect(r).toEqual({ ok: true, count: 2, error: null });
    expect(calls).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
    expect(pool.sourceStatus().loadedFrom).toBe("url");
    expect(pool.healthReport().map((h) => h.host).sort()).toEqual(["2.2.2.2", "3.3.3.3"]);
    expect(pool.isEnabled("2.2.2.2")).toBe(false);
    expect(pool.exclusiveCapacity()).toBe(1);
    // The removed host's occupant is still tracked until it lets go.
    expect(pool.occupiedCount()).toBe(1);
    pool.release("bot@example.com");
    expect(pool.occupiedCount()).toBe(0);
    expect(pool.claim("bot@example.com")!.host).toBe("3.3.3.3");

    // A bad download keeps the current list and the cache.
    body = "";
    const bad = await pool.refresh();
    expect(bad.ok).toBe(false);
    expect(pool.exclusiveCapacity()).toBe(1);
    expect(pool.sourceStatus().lastError).toMatch(/no usable proxy lines/);
    expect(fs.readFileSync(file, "utf8")).not.toBe("");
  });

  it("refresh without a URL is a no-op", async () => {
    const pool = new ProxyPool(mk(["a"]));
    expect(await pool.refresh()).toEqual({ ok: false, count: 1, error: "PROXIES_URL not configured" });
  });
});

describe("tracker holder index and instance-exact transfers", () => {
  it("knows which bot holds an instance and carries named instances across a move", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
    const tracker = InventoryTracker.at(dir);
    tracker.updateFromSlots("giver", { 4: { itemId: "ubatk", enchantments: [] }, 5: { itemId: "ubatk", enchantments: [7] }, 6: { itemId: "patk", enchantments: [] } }, 8);
    const before = tracker.instancesFor("giver");
    const enchanted = before[5].instanceId;
    expect(tracker.holderOf(enchanted)).toBe("giver");
    // Move exactly the enchanted copy: its id (not the plain one's) shows up on the taker.
    tracker.noteTransferInstances("giver", "taker", [enchanted]);
    tracker.updateFromSlots("giver", { 4: { itemId: "ubatk", enchantments: [] }, 6: { itemId: "patk", enchantments: [] } }, 8);
    tracker.updateFromSlots("taker", { 4: { itemId: "ubatk", enchantments: [7] } }, 8);
    expect(tracker.instancesFor("taker")[4].instanceId).toBe(enchanted);
    expect(tracker.holderOf(enchanted)).toBe("taker");
    expect(tracker.holderOf(before[4].instanceId)).toBe("giver");
    tracker.removeBot("taker");
    expect(tracker.holderOf(enchanted)).toBeUndefined();
    tracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("per-bot capacity", () => {
  it("the tracker reports each bot's own slot count with no pool-wide override", () => {
    const t = new InventoryTracker(path.join(os.tmpdir(), `inv-cap-${process.pid}-${Date.now()}.json`));
    t.updateFromSlots("bp-bot", { 4: { itemId: "pdef", enchantments: [] } }, 16);
    t.updateFromSlots("plain-bot", { 4: { itemId: "pdef", enchantments: [] } }, 8);
    expect(t.capacityFor("bp-bot")).toBe(16);
    expect(t.capacityFor("plain-bot")).toBe(8);
    expect(t.capacityFor("never-seen")).toBe(8);
    expect(t.capacities()).toEqual({ "bp-bot": 16, "plain-bot": 8 });
  });
});

describe("bulk capacity notes", () => {
  it("noteCapacities bumps the revision and fires the change hook once for the whole batch", () => {
    const t = new InventoryTracker(path.join(os.tmpdir(), `inv-bulk-${process.pid}-${Date.now()}.json`));
    let fired = 0;
    t.onChange = () => fired++;
    const caps: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) caps[`bot-${i}`] = i % 3 === 0 ? 16 : 8;
    expect(t.noteCapacities(caps)).toBe(5000);
    expect(fired).toBe(1);
    expect(t.capacityFor("bot-0")).toBe(16);
    expect(t.capacityFor("bot-1")).toBe(8);
    expect(t.noteCapacities(caps)).toBe(0);
    expect(fired).toBe(1);
    expect(t.noteCapacity("bot-1", 16)).toBe(true);
    expect(fired).toBe(2);
  });
});
