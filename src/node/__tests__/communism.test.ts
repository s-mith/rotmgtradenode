// Communism coordinator against a scripted hub and a scripted fleet view:
// communism is what sits on the accounts flagged for it, published with
// their room; a take by another node becomes a give-only swap row off a
// communism account; our own takes and gives, and gives into our communism,
// become the matching swap rows on the right bots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../lib/db";
import * as q from "../../lib/queue";
import { presence } from "../../lib/fleetPresence";
import { COMMUNISM_RESOLVE_GRACE_MS, SwapCoordinator } from "../swaps";
import { CommunismCoordinator, SURPLUS_RETRY_MS, spareRoom, type SurplusRoom } from "../communism";
import { reservedInstanceIds } from "../../lib/reservations";
import { registerAdvancedSettings } from "../../lib/advanced";
import { DEFAULT_ADVANCED } from "../settings";
import type { HubClient } from "../hub";
import type { PyrelayPool } from "../../lib/devauth";
import type { RendezvousWire } from "../../shared/hubWire";

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "communism-"));
  vi.stubEnv("DATA_DIR", dir);
  db = openDatabase(":memory:");
});
afterEach(() => {
  registerAdvancedSettings(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const BOT = "bot-guid-1111111111111111111111";
const FULL = "bot-guid-2222222222222222222222";
const NONSEA = "bot-guid-3333333333333333333333";
const COMMUNISM = "bot-guid-4444444444444444444444";
const inst = (instanceId: string, itemId: string, enchantments: number[] = []) => ({ instanceId, itemId, enchantments, capturedAt: 1 });
/** One seasonal pool bot with room, one that is full, one non-seasonal pool bot, and one seasonal communism account holding a potion. */
function pool(overrides: Partial<PyrelayPool> = {}): PyrelayPool {
  const fullSlots: Record<string, ReturnType<typeof inst>> = {};
  for (let i = 0; i < 8; i++) fullSlots[String(i + 4)] = inst(`i-full-${i}`, "pdef");
  return {
    ok: true,
    bots: { [BOT]: { pdef: 2, patk: 1 }, [FULL]: { pdef: 8 }, [NONSEA]: {}, [COMMUNISM]: { pdef: 1 } },
    capacities: { [BOT]: 8, [FULL]: 8, [NONSEA]: 8, [COMMUNISM]: 16 },
    instances: { [BOT]: { 4: inst("i-pdef-plain", "pdef"), 5: inst("i-pdef-ench", "pdef", [7]), 6: inst("i-patk", "patk") }, [FULL]: fullSlots, [NONSEA]: {}, [COMMUNISM]: { 4: inst("i-c-pdef", "pdef") } },
    botMeta: {
      [BOT]: { ign: "MyBot", server: "", online: false, seasonal: true },
      [FULL]: { ign: "FullBot", server: "", online: true, seasonal: true },
      [NONSEA]: { ign: "OldBot", server: "", online: false, seasonal: false },
      [COMMUNISM]: { ign: "CommunismBot", server: "", online: true, seasonal: true, communism: true },
    },
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

function make(script: Parameters<typeof fakeHub>[0] = {}, p: () => PyrelayPool | null = pool, now?: () => number) {
  const { hub, calls } = fakeHub({ onCall: (m, pth, b) => (m === "POST" && pth === "/api/v1/communism/publish" ? { ok: true, listed: (b as { items: unknown[] }).items.length } : script.onCall?.(m, pth, b)) });
  const swaps = new SwapCoordinator({ db: () => db, hub, pool: p, log: () => {}, ...(now ? { now } : {}) });
  const communism = new CommunismCoordinator({ db: () => db, hub, swaps, pool: p, log: () => {} });
  swaps.setCommunismResolver(communism);
  return { hub, calls, swaps, communism };
}

const rvBase = (id: number): Omit<RendezvousWire, "me" | "partner" | "communism"> => ({ id, kind: "communism", offerId: null, server: "USSouth3", seasonal: true, state: "meet", createdAt: 1, deadlineAt: Date.now() + 3_600_000, reported: { mine: false, partner: false } });
/** Another node takes `ref` off our communism account. */
const takenFromUs = (ref: string, id = 9): RendezvousWire => ({
  ...rvBase(id), communism: { nodeId: "me", ref },
  me: { role: "give", botIgn: "CommunismBot", gives: [{ ref, itemId: "pdef", enchants: [], count: 0 }], gets: [] },
  partner: { botIgn: "TheirBot", poster: "Them" },
});

describe("CommunismCoordinator", () => {
  it("leaves out what communism does not take, and refuses to give it", () => {
    // A skin on the communism account: not on communism's accepted list, so untradable there (the storage chore banks it).
    const view = pool({ instances: { ...pool().instances, [COMMUNISM]: { 4: inst("i-c-pdef", "pdef"), 5: inst("i-c-skin", "2_bit_archer_skin") } } });
    const { communism } = make({}, () => view);
    expect(communism.items().map((i) => i.instanceId)).toEqual(["i-c-pdef"]);
    expect(communism.giveInstance(takenFromUs("i-c-pdef"), "i-c-pdef")).toBe("i-c-pdef");
    expect(communism.giveInstance(takenFromUs("i-c-skin"), "i-c-skin")).toBeNull();
  });
  it("communism is what the flagged accounts hold, published with their room, and never offered", async () => {
    const { calls, swaps, communism } = make();
    expect(communism.accounts()).toMatchObject([{ botGuid: COMMUNISM, ign: "CommunismBot", seasonal: true, slots: 16, used: 1, free: 15, online: true }]);
    expect(communism.items()).toMatchObject([{ instanceId: "i-c-pdef", itemId: "pdef", name: "Potion of Defense", botIgn: "CommunismBot", seasonal: true, stored: false, reserved: false }]);
    expect(communism.room(true)).toEqual({ accounts: 1, slots: 16, used: 1, free: 15 });
    expect(communism.room(false)).toEqual({ accounts: 0, slots: 0, used: 0, free: 0 });
    expect(await communism.publish()).toBe(true);
    const pub = calls.filter((c) => c.path === "/api/v1/communism/publish");
    expect(pub).toHaveLength(1);
    expect(pub[0].body).toMatchObject({
      accounts: [{ ign: "CommunismBot", seasonal: true, slots: 16, free: 15, online: true }],
      items: [{ ref: "i-c-pdef", itemId: "pdef", name: "Potion of Defense", enchants: null, count: 0, seasonal: true, botIgn: "CommunismBot" }],
    });
    // Nothing changed since: no second publish.
    expect(await communism.publish()).toBe(true);
    expect(calls.filter((c) => c.path === "/api/v1/communism/publish")).toHaveLength(1);
    // Communism is not the owner's to offer.
    expect(swaps.held().map((h) => h.instanceId)).not.toContain("i-c-pdef");
    expect(swaps.held().filter((h) => h.botGuid === BOT).map((h) => h.instanceId).sort()).toEqual(["i-patk", "i-pdef-ench", "i-pdef-plain"]);
  });

  it("after the first whole listing only the difference goes to the hub; a hub that lost it (409) gets the whole listing again; a change on a bot publishes after a short debounce", async () => {
    vi.useFakeTimers();
    try {
      let view = pool();
      let hubHash = "h1";
      let refuse = false;
      const hooks = new Set<() => void>();
      const { hub, calls } = fakeHub({ onCall: (m, pth, b) => {
        if (m !== "POST" || pth !== "/api/v1/communism/publish") return undefined;
        const body = b as { items?: unknown[]; base?: string; added?: unknown[]; removed?: string[] };
        if (body.items === undefined && (refuse || body.base !== hubHash)) return undefined;
        hubHash = `h${calls.length}`;
        return { ok: true, listed: 1, accounts: 1, hash: hubHash };
      } });
      // The fake hub answers a refused difference with a 409, as the real one does.
      const signed = hub.signed.bind(hub);
      (hub as { signed: unknown }).signed = async (m: string, pth: string, b: unknown) => {
        const r = await signed(m, pth, b);
        const body = b as { items?: unknown[] };
        return !r.ok && pth === "/api/v1/communism/publish" && body.items === undefined ? { ok: false, status: 409, error: "base mismatch" } : r;
      };
      const swaps = new SwapCoordinator({ db: () => db, hub, pool: () => view, log: () => {} });
      const communism = new CommunismCoordinator({ db: () => db, hub, swaps, pool: () => view, log: () => {}, onPoolChanged: (fn) => { hooks.add(fn); return () => hooks.delete(fn); } });
      communism.start();
      await vi.advanceTimersByTimeAsync(0);
      const pubs = () => calls.filter((c) => c.path === "/api/v1/communism/publish").map((c) => c.body as { items?: { ref: string }[]; base?: string; added?: { ref: string }[]; removed?: string[] });
      expect(pubs()).toHaveLength(1);
      expect(pubs()[0].items?.map((i) => i.ref)).toEqual(["i-c-pdef"]);
      // Nothing moved: the tick sends nothing.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(pubs()).toHaveLength(1);
      // A potion arrives on communism account and the old one goes: the change signal publishes the difference after the debounce.
      view = pool({ instances: { ...pool().instances, [COMMUNISM]: { 5: inst("i-c-patk", "patk") } }, bots: { ...pool().bots, [COMMUNISM]: { patk: 1 } } });
      for (const fn of hooks) fn();
      await vi.advanceTimersByTimeAsync(100);
      expect(pubs()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pubs()).toHaveLength(2);
      expect(pubs()[1]).toMatchObject({ base: "h1", added: [{ ref: "i-c-patk" }], removed: ["i-c-pdef"] });
      expect(pubs()[1].items).toBeUndefined();
      // The hub lost the listing: the difference is refused and the whole listing follows at once.
      refuse = true;
      view = pool({ instances: { ...pool().instances, [COMMUNISM]: { 5: inst("i-c-patk", "patk"), 6: inst("i-c-pdef2", "pdef") } }, bots: { ...pool().bots, [COMMUNISM]: { patk: 1, pdef: 1 } } });
      for (const fn of hooks) fn();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pubs()).toHaveLength(4);
      expect(pubs()[2]).toMatchObject({ added: [{ ref: "i-c-pdef2" }], removed: [] });
      expect(pubs()[3].items?.map((i) => i.ref).sort()).toEqual(["i-c-patk", "i-c-pdef2"]);
      communism.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a communism account's room is every character of its side when the fleet described them, not only the played one", async () => {
    const { calls, communism } = make({}, () => pool({ accountRoom: { [COMMUNISM]: { slots: 840, used: 551 } } }));
    expect(communism.accounts()).toMatchObject([{ botGuid: COMMUNISM, slots: 840, used: 551, free: 289 }]);
    expect(communism.room(true)).toEqual({ accounts: 1, slots: 840, used: 551, free: 289 });
    expect(await communism.publish()).toBe(true);
    expect(calls.find((c) => c.path === "/api/v1/communism/publish")!.body).toMatchObject({ accounts: [{ ign: "CommunismBot", slots: 840, free: 289 }] });
  });

  it("a communism account with characters on the other side of the split is room on both sides, published once per side", async () => {
    const { calls, communism } = make({}, () => pool({ accountRoom: { [COMMUNISM]: { slots: 840, used: 551 } }, communismAcross: { [COMMUNISM]: { seasonal: false, slots: 80, used: 3 } } }));
    expect(communism.accounts()).toMatchObject([
      { botGuid: COMMUNISM, seasonal: true, slots: 840, free: 289, online: true },
      { botGuid: COMMUNISM, seasonal: false, slots: 80, used: 3, free: 77, online: false },
    ]);
    expect(communism.room(false)).toEqual({ accounts: 1, slots: 80, used: 3, free: 77 });
    expect(await communism.publish()).toBe(true);
    expect(calls.find((c) => c.path === "/api/v1/communism/publish")!.body).toMatchObject({
      accounts: [{ ign: "CommunismBot", seasonal: true, slots: 840, free: 289 }, { ign: "CommunismBot", seasonal: false, slots: 80, free: 77, online: false }],
    });
  });

  it("an open communism deposit takes room away; an item in an open withdraw is not published", async () => {
    const { calls, communism } = make();
    const now = Date.now();
    db.prepare("INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, communism, created_at, updated_at) VALUES ('A', 'a', 'USSouth3', 8, 8, 'pending', 'g1', 1, 1, ?, ?)").run(now, now);
    expect(communism.room(true).free).toBe(7);
    db.prepare("INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, group_id, target_bot_guid, instance_ids_json, seasonal, communism, created_at, updated_at) VALUES ('B', 'b', 'USSouth3', '[{\"itemId\":\"pdef\",\"qty\":1}]', 'pending', 'g2', ?, '[\"i-c-pdef\"]', 1, 1, ?, ?)").run(COMMUNISM, now, now);
    expect(communism.items()).toMatchObject([{ instanceId: "i-c-pdef", reserved: true }]);
    await communism.publish();
    expect(calls.filter((c) => c.path === "/api/v1/communism/publish").at(-1)?.body).toMatchObject({ items: [] });
  });

  it("a take by another node becomes a give-only swap row off communism account, and the fleet's result a receipt with the instance as ref", async () => {
    const receipts: unknown[] = [];
    const { swaps } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [takenFromUs("i-c-pdef")] } : m === "POST" && p === "/api/v1/rendezvous/9/receipt" ? { ok: true, state: "done" } : undefined) });
    (swaps as unknown as { o: { hub: { signed: HubClient["signed"] } } }).o.hub.signed = new Proxy((swaps as unknown as { o: { hub: HubClient } }).o.hub.signed, {
      apply(target, thisArg, args: [string, string, unknown]) {
        if (args[1] === "/api/v1/rendezvous/9/receipt") receipts.push(args[2]);
        return Reflect.apply(target, thisArg, args);
      },
    });
    await swaps.poll();
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ server: "USSouth3", targetBotGuid: COMMUNISM, instanceIds: ["i-c-pdef"], items: [{ itemId: "pdef", qty: 1 }], swap: { rendezvousId: 9, role: "give", gets: [] } });
    await swaps.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    swaps.start();
    presence.report({ botGuid: COMMUNISM, alias: "C", ign: "CommunismBot", server: "USSouth3", freeSlots: 15, status: "idle", seasonal: true, communism: true });
    const a = q.claimWithdraw(db, COMMUNISM, [{ itemId: "pdef", qty: 1 }], ["i-c-pdef"]);
    expect(a?.requestId).toBe(pending[0].id);
    q.reportSwap(db, COMMUNISM, pending[0].id, { ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveInstanceIds: ["i-c-pdef"], got: [], partnerIgn: "TheirBot" });
    await new Promise((r) => setTimeout(r, 20));
    swaps.stop();
    expect(receipts[0]).toMatchObject({ window: 0, ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveRefs: ["i-c-pdef"], got: [], partnerIgn: "TheirBot" });
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
  });

  it("a take for a ref that is not on a communism account is aborted, once the grace for a reply still on its way is over", async () => {
    let t = Date.now();
    const { swaps, calls } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [takenFromUs("i-pdef-plain", 11)] } : m === "POST" && p === "/api/v1/rendezvous/11/abort" ? { ok: true, state: "aborted" } : undefined) }, pool, () => t);
    await swaps.poll();
    expect(calls.find((c) => c.path === "/api/v1/rendezvous/11/abort")).toBeUndefined();
    t += COMMUNISM_RESOLVE_GRACE_MS;
    await swaps.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(calls.find((c) => c.path === "/api/v1/rendezvous/11/abort")?.body).toMatchObject({ reason: "the item is no longer here" });
  });

  it("a give the hub lists before our own call came back waits for it instead of being aborted", async () => {
    const rv: RendezvousWire = {
      ...rvBase(31), communism: null,
      me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-pdef-plain", itemId: "pdef", enchants: [], count: 0 }], gets: [] },
      partner: { botIgn: "TheirComm", poster: "Them" },
    };
    const { swaps, calls } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    // Nothing recorded for meeting #31 yet (the reply to our give is still on its way): no abort, no row.
    await swaps.poll();
    expect(calls.find((c) => c.path === "/api/v1/rendezvous/31/abort")).toBeUndefined();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    // The reply lands and records it: the next poll queues our side.
    db.prepare("INSERT INTO communism_meetings (rendezvous_id, kind, node_id, item_ids_json, instance_ids_json, bot_guid, server, created_at) VALUES (31, 'give', 'n2', '[\"pdef\"]', '[\"i-pdef-plain\"]', ?, 'USSouth3', 1)").run(BOT);
    await swaps.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
  });

  it("a give hands over only the items it recorded, and another node's take only what we published", async () => {
    const { communism } = make();
    await communism.publish(true);
    const ours: RendezvousWire = { ...rvBase(41), communism: null, me: { role: "give", botIgn: "MyBot", gives: [], gets: [] }, partner: { botIgn: "TheirComm", poster: "Them" } };
    db.prepare("INSERT INTO communism_meetings (rendezvous_id, kind, node_id, item_ids_json, instance_ids_json, bot_guid, server, created_at) VALUES (41, 'give', 'n2', '[\"pdef\"]', '[\"i-pdef-plain\"]', ?, 'USSouth3', 1)").run(BOT);
    expect(communism.giveInstance(ours, "i-pdef-plain")).toBe("i-pdef-plain");
    expect(communism.giveInstance(ours, "i-pdef-ench")).toBeNull();
    expect(communism.itemIdOf(41, "i-pdef-plain")).toBe("pdef");
    expect(communism.giveInstance(takenFromUs("i-not-listed", 42), "i-not-listed")).toBeNull();
  });

  it("taking from another node picks a pool bot with room, tells the hub, and queues a receive-only row pinned to it", async () => {
    const rv: RendezvousWire = {
      ...rvBase(21), communism: { nodeId: "n2", ref: "their-ref" },
      me: { role: "take", botIgn: "MyBot", gives: [], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" },
    };
    const { communism, calls } = make({ onCall: (m, p) => (m === "POST" && p === "/api/v1/communism/withdraw" ? { rendezvous: rv } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    const r = await communism.withdraw({ nodeId: "n2", ref: "their-ref", itemId: "pdef", seasonal: true, server: "USSouth3" });
    expect(r).toMatchObject({ ok: true, rendezvous: { id: 21 }, botIgn: "MyBot" });
    expect(calls.find((c) => c.path === "/api/v1/communism/withdraw")?.body).toEqual({ nodeId: "n2", ref: "their-ref", server: "USSouth3", botIgn: "MyBot" });
    // The full pool bot and communism account are not candidates; the receiving bot is remembered.
    expect(communism.receivingBot(rv)).toBe(BOT);
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ server: "USSouth3", targetBotGuid: BOT, instanceIds: null, items: [], swap: { rendezvousId: 21, role: "take", gets: [{ itemId: "pdef", qty: 1 }] } });
    expect(communism.meetings()).toMatchObject([{ rendezvousId: 21, kind: "take", botIgn: "MyBot", names: ["Potion of Defense"], state: "meet", requestId: pending[0].id }]);
    // Only the pinned bot may claim it, and it claims with nothing to give.
    presence.report({ botGuid: FULL, alias: "F", ign: "FullBot", server: "USSouth3", freeSlots: 0, status: "idle", seasonal: true });
    presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USSouth3", freeSlots: 5, status: "idle", seasonal: true });
    expect(q.claimWithdraw(db, FULL, [{ itemId: "pdef", qty: 8 }], [])).toBeNull();
    const a = q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 2 }, { itemId: "patk", qty: 1 }], ["i-pdef-plain", "i-pdef-ench", "i-patk"]);
    expect(a).toMatchObject({ kind: "withdraw", requestId: pending[0].id, ign: "TheirBot", items: [], instanceIds: null, swap: { role: "take", gets: [{ itemId: "pdef", qty: 1 }] } });
  });

  it("refuses to take when no pool account of that half has room", async () => {
    const p = pool({ botMeta: { [BOT]: { ign: "", server: "", online: false, seasonal: true }, [FULL]: { ign: "FullBot", server: "", online: true, seasonal: true }, [COMMUNISM]: { ign: "CommunismBot", server: "", online: true, seasonal: true, communism: true } } });
    const { communism } = make({}, () => p);
    expect(await communism.withdraw({ nodeId: "n2", ref: "r", itemId: "pdef", seasonal: true, server: "USSouth3" })).toMatchObject({ ok: false, status: 409 });
  });

  it("giving to another node's communism sends pool items and queues a give-only row off their bot", async () => {
    const rv: RendezvousWire = {
      ...rvBase(31), communism: null,
      me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: null, count: 0 }], gets: [] }, partner: { botIgn: "TheirCommunism", poster: "Them" },
    };
    const { communism, calls, swaps } = make({ onCall: (m, p) => (m === "POST" && p === "/api/v1/communism/give" ? { rendezvous: rv } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    expect(await communism.give({ nodeId: "n2", instanceIds: ["i-c-pdef"], server: "USSouth3" })).toMatchObject({ ok: false, status: 409 });
    const r = await communism.give({ nodeId: "n2", instanceIds: ["i-patk"], server: "USSouth3" });
    expect(r).toMatchObject({ ok: true, rendezvous: { id: 31 }, botIgn: "MyBot" });
    expect(calls.find((c) => c.path === "/api/v1/communism/give")?.body).toEqual({ nodeId: "n2", seasonal: true, items: [{ ref: "i-patk", itemId: "patk", enchants: null, count: 0 }], server: "USSouth3", botIgn: "MyBot" });
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ targetBotGuid: BOT, instanceIds: ["i-patk"], items: [{ itemId: "patk", qty: 1 }], swap: { rendezvousId: 31, role: "give", gets: [] } });
    expect(communism.meetings()).toMatchObject([{ rendezvousId: 31, kind: "give", names: ["Potion of Attack"], botIgn: "MyBot" }]);
    expect(swaps.held().map((h) => h.instanceId)).not.toContain("i-patk");
  });

  it("a give holds its items while the hub is asked and lets them go when it refuses", async () => {
    let seen: Set<string> | null = null;
    const { communism } = make({ onCall: (m, p) => { if (m === "POST" && p === "/api/v1/communism/give") seen = reservedInstanceIds(db); return undefined; } });
    expect(await communism.give({ nodeId: "n2", instanceIds: ["i-patk"], server: "USSouth3" })).toMatchObject({ ok: false });
    expect([...(seen ?? [])]).toEqual(["i-patk"]);
    expect(reservedInstanceIds(db).size).toBe(0);
    expect(communism.meetings()).toEqual([]);
  });

  it("a give into our communism lands on communism account the hub named", async () => {
    const rv: RendezvousWire = {
      ...rvBase(41), communism: null,
      me: { role: "take", botIgn: "CommunismBot", gives: [], gets: [{ itemId: "patk", qty: 2 }] }, partner: { botIgn: "TheirBot", poster: "Them" },
    };
    const { swaps, communism } = make({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    expect(communism.receivingBot(rv)).toBe(COMMUNISM);
    await swaps.poll();
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ targetBotGuid: COMMUNISM, instanceIds: null, items: [], swap: { rendezvousId: 41, role: "take", gets: [{ itemId: "patk", qty: 2 }] } });
  });
});

describe("where a take meets", () => {
  it("picks a random server at 0% load, the least loaded when none is at zero, and any server without a report", async () => {
    const { pickQuietServer } = await import("../communism");
    const report = [{ name: "USSouth3", usage: 0.75 }, { name: "EUWest", usage: 0 }, { name: "USEast", usage: 0 }, { name: "Australia", usage: 0.1 }];
    const cands = ["USSouth3", "EUWest", "USEast", "Australia", "Asia"]; // Asia has no report
    expect(pickQuietServer(cands, report, () => 0)).toEqual({ server: "EUWest", why: "2 servers at 0%" });
    expect(pickQuietServer(cands, report, () => 0.99)).toEqual({ server: "USEast", why: "2 servers at 0%" });
    expect(pickQuietServer(cands, report.map((r) => ({ ...r, usage: r.usage || 0.5 })), () => 0)).toMatchObject({ server: "Australia", why: expect.stringContaining("10% is the least loaded") });
    expect(pickQuietServer(cands, null, () => 0)).toEqual({ server: "USSouth3", why: "no load report" });
    expect(pickQuietServer([], report)).toMatchObject({ server: "USSouth3" });
  });
});

describe("surplus (advanced management, docs/relay/ADVANCED.md)", () => {
  const COMM2 = "bot-guid-5555555555555555555555";
  const aged = (instanceId: string, itemId: string, capturedAt: number) => ({ instanceId, itemId, enchantments: [] as number[], capturedAt });
  /** Two full seasonal communism accounts: CommunismBot (4 slots, online on USEast) and Comm2; Defense potions are the over-stocked item. */
  const full = (): PyrelayPool => pool({
    capacities: { ...pool().capacities, [COMMUNISM]: 4, [COMM2]: 4 },
    instances: {
      ...pool().instances,
      [COMMUNISM]: { 4: aged("c-pdef-5", "pdef", 5), 5: aged("c-patk-0", "patk", 0), 6: aged("c-pdef-1", "pdef", 1), 7: aged("c-pdef-3", "pdef", 3) },
      [COMM2]: { 4: aged("d-pdef-2", "pdef", 2), 5: aged("d-pspd-9", "pspd", 9) },
    },
    botMeta: {
      ...pool().botMeta,
      [COMMUNISM]: { ign: "CommunismBot", server: "USEast", online: true, seasonal: true, communism: true },
      [COMM2]: { ign: "CommTwo", server: "", online: false, seasonal: true, communism: true },
    },
  });
  const allFull: SurplusRoom[] = [{ seasonal: true, accounts: 2, emptyChars: 0, vaultFree: 0 }];
  function surplus(o: { room?: () => SurplusRoom[]; give?: (body: unknown) => unknown; now?: () => number } = {}) {
    const { hub, calls } = fakeHub({
      onCall: (m, p, b) => {
        if (m === "POST" && p === "/api/v1/communism/publish") return { ok: true, listed: ((b as { items?: unknown[] }).items ?? []).length };
        if (m === "POST" && p === "/api/v1/communism/give") return o.give?.(b);
        return undefined;
      },
    });
    const swaps = new SwapCoordinator({ db: () => db, hub, pool: full, log: () => {}, ...(o.now ? { now: o.now } : {}) });
    const communism = new CommunismCoordinator({ db: () => db, hub, swaps, pool: full, log: () => {}, surplusRoom: o.room ?? (() => allFull), ...(o.now ? { now: o.now } : {}) });
    swaps.setCommunismResolver(communism);
    return { communism, calls, swaps };
  }
  const on = (passSurplus = true) => registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, communism: true, passSurplus }));
  /** The hub's reply to a pass: the receiving account had room for `room` of the items offered. */
  const passed = (room: number) => (body: unknown) => {
    const req = body as { items: { ref: string; itemId: string; enchants: null; count: number }[]; server: string };
    const rv: RendezvousWire = { ...rvBase(77), server: req.server, communism: null, me: { role: "give", botIgn: "CommunismBot", gives: req.items.slice(0, room), gets: [] }, partner: { botIgn: "TheirComm", poster: "" } };
    return { rendezvous: rv, nodeId: "n_other" };
  };

  it("a full side gives its oldest copies of the most over-stocked items off one character to another node's communism, one meeting at a time", async () => {
    on();
    const { communism, calls } = surplus({ give: passed(3) });
    const r = await communism.passSurplus();
    expect(r).toEqual({ rendezvousId: 77, items: 3, nodeId: "n_other" });
    const give = calls.filter((c) => c.path === "/api/v1/communism/give");
    expect(give).toHaveLength(1);
    // CommunismBot holds the oldest Defense potion: its character goes, Defense oldest first, then the rest; where it already is.
    expect(give[0].body).toEqual({
      nodeId: "", seasonal: true, server: "USEast", botIgn: "CommunismBot", pass: true,
      items: ["c-pdef-1", "c-pdef-3", "c-pdef-5", "c-patk-0"].map((ref) => ({ ref, itemId: ref.includes("patk") ? "patk" : "pdef", enchants: null, count: 0 })),
    });
    expect(communism.meetings()).toMatchObject([{ rendezvousId: 77, kind: "give", pass: true, nodeId: "n_other", itemIds: ["pdef", "pdef", "pdef"] }]);
    // What the hub scheduled is spoken for and off the listing at once; the fourth stays communism's.
    const items = new Map(communism.items().map((i) => [i.instanceId, i.reserved]));
    expect([items.get("c-pdef-1"), items.get("c-pdef-3"), items.get("c-pdef-5"), items.get("c-patk-0")]).toEqual([true, true, true, false]);
    const published = calls.filter((c) => c.path === "/api/v1/communism/publish").pop()!.body as { items?: { ref: string }[]; removed?: string[] };
    expect((published.items ?? []).map((i) => i.ref)).not.toContain("c-pdef-1");
    // The communism bot hands them over: a give-only swap row off it.
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ targetBotGuid: COMMUNISM, instanceIds: ["c-pdef-1", "c-pdef-3", "c-pdef-5"], swap: { rendezvousId: 77, role: "give", gets: [] } });
    // One meeting at a time.
    expect(await communism.passSurplus()).toBeNull();
    expect(calls.filter((c) => c.path === "/api/v1/communism/give")).toHaveLength(1);
  });

  it("nothing is passed on with room left, with the switch or the rule off, and a hub with no room anywhere is asked again later", async () => {
    let now = 1_000_000;
    let reply: unknown = undefined;
    const t = surplus({ give: () => reply, now: () => now });
    // Off by default.
    expect(await t.communism.passSurplus()).toBeNull();
    on(false);
    expect(await t.communism.passSurplus()).toBeNull();
    on();
    const roomy = surplus({ room: () => [{ seasonal: true, accounts: 2, emptyChars: 1, vaultFree: 0 }, { seasonal: false, accounts: 1, emptyChars: 0, vaultFree: 3 }] });
    expect(await roomy.communism.passSurplus()).toBeNull();
    expect(roomy.calls.some((c) => c.path === "/api/v1/communism/give")).toBe(false);
    // No node with room: refused (the fake hub has no answer), and not asked again until SURPLUS_RETRY_MS has passed.
    expect(await t.communism.passSurplus()).toBeNull();
    expect(await t.communism.passSurplus()).toBeNull();
    expect(t.calls.filter((c) => c.path === "/api/v1/communism/give")).toHaveLength(1);
    now += SURPLUS_RETRY_MS;
    reply = passed(8)((t.calls.find((c) => c.path === "/api/v1/communism/give")!.body));
    expect(await t.communism.passSurplus()).toMatchObject({ items: 4 });
  });

  it("spare room is the vault's room and every empty character but the one kept for intake", () => {
    expect(spareRoom([{ seasonal: true, accounts: 3, emptyChars: 3, vaultFree: 5 }, { seasonal: false, accounts: 1, emptyChars: 1, vaultFree: 0 }])).toEqual({ seasonal: 21, nonseasonal: 0 });
    expect(spareRoom([{ seasonal: true, accounts: 1, emptyChars: 0, vaultFree: -4 }])).toEqual({ seasonal: 0, nonseasonal: 0 });
    expect(spareRoom([])).toEqual({ seasonal: 0, nonseasonal: 0 });
  });

  it("items are spoken for while the hub is asked, and let go when it refuses or the meeting never starts here", async () => {
    on();
    // While the hub is asked, the items are reserved on the node.
    let seen: Set<string> | null = null;
    const refused = surplus({ give: () => { seen = reservedInstanceIds(db); return undefined; } });
    expect(await refused.communism.passSurplus()).toBeNull();
    expect([...(seen ?? [])].sort()).toEqual(["c-patk-0", "c-pdef-1", "c-pdef-3", "c-pdef-5"]);
    expect(reservedInstanceIds(db).size).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM communism_meetings").get()).toEqual({ n: 0 });
    // The hub schedules it, but by then a withdraw holds one of the items: the swap coordinator calls it off, and the rest is free again.
    const raced = surplus({
      give: (body) => {
        q.createSwapJob(db, { server: "USEast", botGuid: COMMUNISM, partnerIgn: "Someone", seasonal: true, give: [{ itemId: "pdef", qty: 1 }], giveInstanceIds: ["c-pdef-1"], swap: { rendezvousId: 5, role: "give", gets: [], deadlineAt: Date.now() + 60_000 } });
        return passed(4)(body);
      },
      now: () => Date.now() + 2 * SURPLUS_RETRY_MS,
    });
    expect(await raced.communism.passSurplus()).toBeNull();
    expect(raced.calls.some((c) => c.path === "/api/v1/rendezvous/77/abort")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM communism_meetings").get()).toEqual({ n: 0 });
    expect([...reservedInstanceIds(db)]).toEqual(["c-pdef-1"]);
  });

  it("the room for a deposit is bounded by the fleet's biggest communism deposit when advanced management reports one", () => {
    const { communism } = make({}, () => pool({ room: { seasonal: { largestFree: 8, canMake: false }, nonseasonal: { largestFree: 8, canMake: false }, communism: { seasonal: { largestFree: 6 }, nonseasonal: { largestFree: 0 } } } }));
    expect(communism.room(true)).toEqual({ accounts: 1, slots: 16, used: 1, free: 6 });
    // Without it (advanced management off), as before.
    expect(make().communism.room(true)).toEqual({ accounts: 1, slots: 16, used: 1, free: 15 });
  });
});
