// The commons coordinator against a scripted hub and a scripted fleet view:
// contributing lists an item and takes it out of the offerable set, a
// hand-over becomes a give-only or receive-only swap row, and the fleet's
// result becomes a receipt with the instance as its ref.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../lib/db";
import * as q from "../../lib/queue";
import { presence } from "../../lib/fleetPresence";
import { SwapCoordinator } from "../swaps";
import { CommonsCoordinator } from "../commons";
import type { HubClient } from "../hub";
import type { PyrelayPool } from "../../lib/devauth";
import type { RendezvousWire } from "../../shared/hubWire";
import { userForIgn } from "../../lib/users";

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "commons-"));
  vi.stubEnv("DATA_DIR", dir);
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const BOT = "bot-guid-1111111111111111111111";
const FULL = "bot-guid-2222222222222222222222";
const NONSEA = "bot-guid-3333333333333333333333";
const inst = (instanceId: string, itemId: string, enchantments: number[] = []) => ({ instanceId, itemId, enchantments, capturedAt: 1 });
/** One seasonal bot with room, one seasonal bot that is full, one non-seasonal bot. */
function pool(overrides: Partial<PyrelayPool> = {}): PyrelayPool {
  const fullSlots: Record<string, ReturnType<typeof inst>> = {};
  for (let i = 0; i < 8; i++) fullSlots[String(i + 4)] = inst(`i-full-${i}`, "pdef");
  return {
    ok: true,
    bots: { [BOT]: { pdef: 2, patk: 1 }, [FULL]: { pdef: 8 }, [NONSEA]: {} },
    capacities: { [BOT]: 8, [FULL]: 8, [NONSEA]: 8 },
    instances: { [BOT]: { 4: inst("i-pdef-plain", "pdef"), 5: inst("i-pdef-ench", "pdef", [7]), 6: inst("i-patk", "patk") }, [FULL]: fullSlots, [NONSEA]: {} },
    botMeta: { [BOT]: { ign: "MyBot", server: "", online: false, seasonal: true }, [FULL]: { ign: "FullBot", server: "", online: true, seasonal: true }, [NONSEA]: { ign: "OldBot", server: "", online: false, seasonal: false } },
    ...overrides,
  };
}

function fakeHub(script: { onCall?: (method: string, path: string, body: unknown) => unknown } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const hub = {
    linked: true,
    signed: async (method: string, pathq: string, body: unknown = {}) => {
      calls.push({ method, path: pathq, body });
      const data = script.onCall?.(method, pathq, body);
      if (data === undefined) return { ok: false, status: 404, error: `no script for ${method} ${pathq}` };
      return { ok: true, data };
    },
  } as unknown as HubClient;
  return { hub, calls };
}

function make(script: Parameters<typeof fakeHub>[0] = {}, p: () => PyrelayPool | null = pool) {
  const { hub, calls } = fakeHub({ onCall: (m, pth, b) => (m === "POST" && pth === "/api/v1/commons/publish" ? { ok: true, listed: (b as { items: unknown[] }).items.length } : script.onCall?.(m, pth, b)) });
  const swaps = new SwapCoordinator({ db: () => db, hub, pool: p, log: () => {} });
  const commons = new CommonsCoordinator({ db: () => db, hub, swaps, pool: p, log: () => {} });
  swaps.setCommonsResolver(commons);
  return { hub, calls, swaps, commons };
}

const giverRv = (ref: string, id = 9): RendezvousWire => ({
  id, kind: "commons", offerId: null, commons: { nodeId: "me", ref }, server: "USSouth3", seasonal: true, state: "meet", createdAt: 1, deadlineAt: Date.now() + 3_600_000,
  me: { role: "give", botIgn: "MyBot", gives: [{ ref, itemId: "patk", enchants: [], count: 0 }], gets: [] },
  partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false },
});

describe("CommonsCoordinator", () => {
  it("contributing lists the item with its holder and takes it out of the offerable set", async () => {
    const { calls, swaps, commons } = make();
    expect(await commons.contribute(["i-patk"])).toEqual({ ok: true, added: 1 });
    const pub = calls.filter((c) => c.path === "/api/v1/commons/publish");
    expect(pub).toHaveLength(1);
    expect(pub[0].body).toMatchObject({ items: [{ ref: "i-patk", itemId: "patk", name: "Potion of Attack", enchants: null, count: 0, seasonal: true, botIgn: "MyBot" }] });
    expect(commons.status().items).toMatchObject([{ instanceId: "i-patk", botIgn: "MyBot", listed: true, why: null }]);
    // Contributed items are not for offers.
    expect(swaps.held().filter((h) => h.botGuid === BOT).map((h) => h.instanceId).sort()).toEqual(["i-pdef-ench", "i-pdef-plain"]);
    expect(await commons.contribute(["i-patk"])).toMatchObject({ ok: false, status: 409 });
    // Nothing changed since: no second publish.
    expect(await commons.publish()).toBe(true);
    expect(calls.filter((c) => c.path === "/api/v1/commons/publish")).toHaveLength(1);
    expect(await commons.uncontribute(["i-patk"])).toEqual({ ok: true, removed: 1 });
    expect(swaps.held().map((h) => h.instanceId)).toContain("i-patk");
    expect(calls.filter((c) => c.path === "/api/v1/commons/publish").at(-1)?.body).toMatchObject({ items: [] });
  });

  it("refuses items that are unknown, owned by a vault user, or already spoken for", async () => {
    const { commons } = make();
    expect(await commons.contribute(["nope"])).toMatchObject({ ok: false, status: 404 });
    const uid = userForIgn(db, "Guest", "guest");
    db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES ('i-pdef-ench', ?, 'pdef', 1, 1, ?, 'claim', 1)").run(uid, BOT);
    expect(await commons.contribute(["i-pdef-ench"])).toMatchObject({ ok: false, status: 409 });
    q.createSwapJob(db, { server: "USSouth3", botGuid: BOT, partnerIgn: "X", seasonal: true, give: [{ itemId: "pdef", qty: 1 }], giveInstanceIds: ["i-pdef-plain"], swap: { rendezvousId: 77, role: "give", gets: [] } });
    expect(await commons.contribute(["i-pdef-plain"])).toMatchObject({ ok: false, status: 409 });
  });

  it("an item that left the fleet is unlisted on the next look", async () => {
    let p = pool();
    const { commons, calls } = make({}, () => p);
    await commons.contribute(["i-patk"]);
    p = pool({ instances: { [BOT]: { 4: inst("i-pdef-plain", "pdef") }, [FULL]: {}, [NONSEA]: {} } });
    expect(commons.status().items).toEqual([]);
    await commons.publish();
    expect(calls.filter((c) => c.path === "/api/v1/commons/publish").at(-1)?.body).toMatchObject({ items: [] });
  });

  it("a hand-over for a contributed ref becomes a give-only swap row, and the fleet's result a receipt with the instance as ref", async () => {
    const receipts: unknown[] = [];
    const { swaps, commons } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [giverRv("i-patk")] } : m === "POST" && p === "/api/v1/rendezvous/9/receipt" ? { ok: true, state: "done" } : undefined) });
    (swaps as unknown as { o: { hub: { signed: HubClient["signed"] } } }).o.hub.signed = new Proxy((swaps as unknown as { o: { hub: HubClient } }).o.hub.signed, {
      apply(target, thisArg, args: [string, string, unknown]) {
        if (args[1] === "/api/v1/rendezvous/9/receipt") receipts.push(args[2]);
        return Reflect.apply(target, thisArg, args);
      },
    });
    await commons.contribute(["i-patk"]);
    await swaps.poll();
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ server: "USSouth3", targetBotGuid: BOT, instanceIds: ["i-patk"], items: [{ itemId: "patk", qty: 1 }], swap: { rendezvousId: 9, role: "give", gets: [] } });
    // While the meeting is on, the item is off the listing but still contributed.
    expect(commons.status().items).toMatchObject([{ instanceId: "i-patk", listed: false, why: "hand-over in progress" }]);
    expect(await commons.uncontribute(["i-patk"])).toMatchObject({ ok: false, status: 409 });
    await swaps.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    swaps.start();
    presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USSouth3", freeSlots: 5, status: "idle", seasonal: true });
    const a = q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i-patk"]);
    expect(a?.requestId).toBe(pending[0].id);
    q.reportSwap(db, BOT, pending[0].id, { ok: true, gave: [{ itemId: "patk", qty: 1 }], gaveInstanceIds: ["i-patk"], got: [], partnerIgn: "TheirBot" });
    await new Promise((r) => setTimeout(r, 20));
    swaps.stop();
    expect(receipts[0]).toMatchObject({ window: 0, ok: true, gave: [{ itemId: "patk", qty: 1 }], gaveRefs: ["i-patk"], got: [], partnerIgn: "TheirBot" });
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
  });

  it("a hand-over for a ref this node never contributed is aborted", async () => {
    const { swaps, calls } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [giverRv("i-pdef-plain", 11)] } : m === "POST" && p === "/api/v1/rendezvous/11/abort" ? { ok: true, state: "aborted" } : undefined) });
    await swaps.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(calls.find((c) => c.path === "/api/v1/rendezvous/11/abort")?.body).toMatchObject({ reason: "the contributed item is no longer here" });
  });

  it("asking for an item picks a receiving bot with room, tells the hub, and queues a receive-only row pinned to that bot", async () => {
    const rv: RendezvousWire = {
      id: 21, kind: "commons", offerId: null, commons: { nodeId: "n2", ref: "their-ref" }, server: "USSouth3", seasonal: true, state: "meet", createdAt: 1, deadlineAt: Date.now() + 3_600_000,
      me: { role: "take", botIgn: "MyBot", gives: [], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false },
    };
    const { commons, calls } = make({ onCall: (m, p) => (m === "POST" && p === "/api/v1/commons/withdraw" ? { rendezvous: rv } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    // The full seasonal bot and the non-seasonal bot are not candidates.
    expect(commons.receivingBot(true)).toMatchObject({ botGuid: BOT, ign: "MyBot", free: 5 });
    expect(commons.receivingBot(false)).toMatchObject({ botGuid: NONSEA, ign: "OldBot", free: 8 });
    const r = await commons.withdraw({ nodeId: "n2", ref: "their-ref", itemId: "pdef", seasonal: true, server: "USSouth3" });
    expect(r).toMatchObject({ ok: true, rendezvous: { id: 21 }, botIgn: "MyBot" });
    expect(calls.find((c) => c.path === "/api/v1/commons/withdraw")?.body).toEqual({ nodeId: "n2", ref: "their-ref", server: "USSouth3", botIgn: "MyBot" });
    expect(commons.receivingBot(21)).toBe(BOT);
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ server: "USSouth3", targetBotGuid: BOT, instanceIds: null, items: [], swap: { rendezvousId: 21, role: "take", gets: [{ itemId: "pdef", qty: 1 }] } });
    expect(commons.status().withdraws).toMatchObject([{ rendezvousId: 21, botIgn: "MyBot", name: "Potion of Defense", state: "meet", requestId: pending[0].id }]);
    // The promised slot is no longer free for a second hand-over.
    expect(commons.receivingBot(true)).toMatchObject({ botGuid: BOT, free: 4 });
    // Only the pinned bot may claim it, and it claims with nothing to give.
    presence.report({ botGuid: FULL, alias: "F", ign: "FullBot", server: "USSouth3", freeSlots: 0, status: "idle", seasonal: true });
    presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USSouth3", freeSlots: 5, status: "idle", seasonal: true });
    expect(q.claimWithdraw(db, FULL, [{ itemId: "pdef", qty: 8 }], [])).toBeNull();
    const a = q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 2 }, { itemId: "patk", qty: 1 }], ["i-pdef-plain", "i-pdef-ench", "i-patk"]);
    expect(a).toMatchObject({ kind: "withdraw", requestId: pending[0].id, ign: "TheirBot", items: [], instanceIds: null, swap: { role: "take", gets: [{ itemId: "pdef", qty: 1 }] } });
  });

  it("refuses to ask when no account of that half has room", async () => {
    const p = pool({ botMeta: { [BOT]: { ign: "", server: "", online: false, seasonal: true }, [FULL]: { ign: "FullBot", server: "", online: true, seasonal: true } } });
    const { commons } = make({}, () => p);
    expect(await commons.withdraw({ nodeId: "n2", ref: "r", itemId: "pdef", seasonal: true, server: "USSouth3" })).toMatchObject({ ok: false, status: 409 });
  });
});
