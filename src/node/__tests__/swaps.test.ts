// The swap coordinator against a scripted hub and a scripted fleet view:
// posting locks items, accepting picks the plainest fits, a rendezvous
// becomes a swap row, and the fleet's result becomes a receipt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../lib/db";
import * as q from "../../lib/queue";
import { presence } from "../../lib/fleetPresence";
import { SwapCoordinator } from "../swaps";
import type { HubClient } from "../hub";
import type { PyrelayPool } from "../../lib/devauth";
import type { RendezvousWire } from "../../shared/hubWire";

let dir: string;
let db: ReturnType<typeof openDatabase>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swaps-"));
  vi.stubEnv("DATA_DIR", dir);
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const BOT = "bot-guid-1111111111111111111111";
function pool(): PyrelayPool {
  const inst = (instanceId: string, itemId: string, enchantments: number[] = []) => ({ instanceId, itemId, enchantments, capturedAt: 1 });
  return {
    ok: true, bots: { [BOT]: { pdef: 2, patk: 1 } }, capacities: { [BOT]: 8 },
    instances: { [BOT]: { 4: inst("i-pdef-plain", "pdef"), 5: inst("i-pdef-ench", "pdef", [7]), 6: inst("i-patk", "patk") } },
    botMeta: { [BOT]: { ign: "MyBot", server: "", online: false, seasonal: true } },
  };
}

/** A hub in a closure that records calls and answers like the real one. */
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

describe("SwapCoordinator", () => {
  it("posts an offer with refs for its own instances, and locks them", async () => {
    const { hub, calls } = fakeHub({ onCall: (m, p, body) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: 5, ...(body as object), status: "open", mine: true, poster: "Me", createdAt: 1, expiresAt: 2 } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    expect(c.held().map((h) => h.instanceId).sort()).toEqual(["i-patk", "i-pdef-ench", "i-pdef-plain"]);
    const r = await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USSouth3" });
    expect(r).toMatchObject({ ok: true, offer: { id: 5 } });
    expect(calls[0].body).toMatchObject({ botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [{ ref: "r1", itemId: "patk", count: 0 }], want: [{ itemId: "pdef", qty: 1 }] });
    // Offered items are no longer free.
    expect(c.held().map((h) => h.instanceId).sort()).toEqual(["i-pdef-ench", "i-pdef-plain"]);
    expect(c.status().localOffers).toEqual([{ offerId: 5, side: "poster", botGuid: BOT, refs: { r1: "i-patk" }, status: "open" }]);
  });

  it("previews the plainest fit for someone else's offer, accepts, and queues the swap row from the rendezvous", async () => {
    const rv: RendezvousWire = {
      id: 9, offerId: 5, server: "USEast", seasonal: true, state: "meet", createdAt: 1, deadlineAt: Date.now() + 3_600_000,
      me: { role: "take", botIgn: "MyBot", gives: [{ ref: "r1", itemId: "pdef", enchants: [], count: 0 }], gets: [{ itemId: "patk", qty: 1 }] },
      partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false },
    };
    const { hub, calls } = fakeHub({ onCall: (m, p) => (m === "POST" && p === "/api/v1/offers/5/accept" ? { rendezvous: rv } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    const offer = { id: 5, poster: "Them", mine: false, botIgn: "TheirBot", seasonal: true, server: "USEast", give: [{ ref: "x", itemId: "patk", enchants: [], count: 0 }], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], status: "open" as const, createdAt: 1, expiresAt: 2 };
    const pv = c.preview(offer);
    expect(pv.ok && pv.picks.map((p) => p.instanceId)).toEqual(["i-pdef-plain"]);
    presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USEast", freeSlots: 5, status: "idle", seasonal: true });
    const r = await c.acceptOffer(offer);
    expect(r).toMatchObject({ ok: true, rendezvous: { id: 9 } });
    expect(calls.find((x) => x.path.endsWith("/accept"))?.body).toMatchObject({ botIgn: "MyBot", items: [{ ref: "r1", itemId: "pdef" }] });
    // The rendezvous became a swap row for the fleet, addressed to the holder and the partner bot.
    const pending = q.listPending(db).withdraws;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ server: "USEast", targetBotGuid: BOT, instanceIds: ["i-pdef-plain"], items: [{ itemId: "pdef", qty: 1 }], swap: { rendezvousId: 9, role: "take", gets: [{ itemId: "patk", qty: 1 }] } });
    // Polling again does not queue it twice.
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    // The fleet's result turns into a receipt with the ref of what left.
    const receipts: unknown[] = [];
    (hub as unknown as { signed: (m: string, p: string, b: unknown) => Promise<unknown> }).signed = async (m, p, b) => {
      if (p === "/api/v1/rendezvous/9/receipt") { receipts.push(b); return { ok: true, data: { ok: true, state: "done" } }; }
      return { ok: true, data: { rendezvous: [] } };
    };
    c.start();
    const a = q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 1 }], ["i-pdef-plain"]);
    expect(a?.requestId).toBe(pending[0].id);
    q.reportSwap(db, BOT, pending[0].id, { ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveInstanceIds: ["i-pdef-plain"], got: [{ itemId: "patk", qty: 1 }], partnerIgn: "TheirBot" });
    await new Promise((r) => setTimeout(r, 20));
    c.stop();
    expect(receipts[0]).toMatchObject({ window: 0, ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveRefs: ["r1"], got: [{ itemId: "patk", qty: 1 }], partnerIgn: "TheirBot" });
    expect(c.status().rendezvous.length).toBe(0);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
  });

  it("a meeting past its deadline with no trade is aborted from the node", async () => {
    let now = 1000;
    const rv: RendezvousWire = { id: 4, offerId: 8, server: "USEast", seasonal: true, state: "meet", createdAt: 1, deadlineAt: 5000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "r1", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } };
    const { hub, calls } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : m === "POST" && p === "/api/v1/rendezvous/4/abort" ? { ok: true, state: "aborted" } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {}, now: () => now });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    now = 6000;
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(calls.some((x) => x.path === "/api/v1/rendezvous/4/abort")).toBe(true);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 4").get()).toEqual({ state: "aborted" });
  });

  it("a rendezvous the hub aborted cancels the local row", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 3, offerId: 8, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "r1", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } });
    const { hub } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv()] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    state = "aborted";
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(c.status().localOffers[0].status).toBe("open");
  });
});
