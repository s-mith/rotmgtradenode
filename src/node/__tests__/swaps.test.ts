// The swap coordinator against a scripted hub and a scripted fleet view:
// posting names items by instance id (one item may be in several offers),
// accepting picks the plainest fits, a rendezvous becomes a swap row, and
// the fleet's result becomes a receipt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../lib/db";
import * as q from "../../lib/queue";
import { presence } from "../../lib/fleetPresence";
import { SwapCoordinator } from "../swaps";
import { reservedInstanceIds } from "../../lib/reservations";
import type { HubClient } from "../hub";
import type { PyrelayPool } from "../../lib/devauth";
import type { RendezvousWire } from "../../shared/hubWire";
import { setServerControl } from "../../lib/serverControls";
import { WITHDRAW_SERVERS } from "../../lib/servers";

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
/** When the hub made a meeting: fixed, as a real hub's is (the node tells meetings apart by it). */
const MADE_AT = Date.now();
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
      // null: the hub could not be reached; undefined: it answered 404.
      if (data === null) return { ok: false, status: 0, error: "hub unreachable" };
      if (data === undefined) return { ok: false, status: 404, error: `no script for ${method} ${pathq}` };
      return { ok: true, data };
    },
  } as unknown as HubClient;
  return { hub, calls };
}

describe("SwapCoordinator", () => {
  it("posts an offer naming each item by its instance id; the item may go in more offers, until a meeting has it", async () => {
    let next = 5;
    const rv: RendezvousWire = {
      id: 3, kind: "swap", offerId: 5, server: "USSouth3", seasonal: true, state: "meet", createdAt: MADE_AT, deadlineAt: Date.now() + 3_600_000,
      me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] },
      partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false },
    };
    let meetings: RendezvousWire[] = [];
    const { hub, calls } = fakeHub({ onCall: (m, p, body) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: next++, ...(body as object), status: "open", mine: true, poster: "Me", createdAt: 1, expiresAt: 2 } } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: meetings } : undefined) });
    const logs: string[] = [];
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: (s) => logs.push(s) });
    expect(c.held().map((h) => [h.instanceId, h.offers])).toEqual([["i-pdef-plain", []], ["i-pdef-ench", []], ["i-patk", []]]);
    const want = [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }];
    expect(await c.createOffer({ instanceIds: ["i-patk"], want, server: "USSouth3" })).toMatchObject({ ok: true, offer: { id: 5 } });
    expect(calls[0].body).toMatchObject({ botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [{ ref: "i-patk", itemId: "patk", count: 0 }], want: [{ itemId: "pdef", qty: 1 }] });
    expect(c.status().localOffers).toEqual([{ offerId: 5, side: "poster", botGuid: BOT, refs: { "i-patk": "i-patk" }, status: "open" }]);
    // Still free to offer again, saying where it already is; the hub sees the same ref in both.
    expect(c.held().find((h) => h.instanceId === "i-patk")?.offers).toEqual([5]);
    expect(await c.createOffer({ instanceIds: ["i-patk", "i-pdef-ench"], want: [{ itemId: "patk", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USSouth3" })).toMatchObject({ ok: true, offer: { id: 6 } });
    expect(calls[1].body).toMatchObject({ give: [{ ref: "i-patk", itemId: "patk" }, { ref: "i-pdef-ench", itemId: "pdef" }] });
    expect(c.held().find((h) => h.instanceId === "i-patk")?.offers).toEqual([5, 6]);
    expect(logs.at(-1)).toBe("swaps: posted offer #6: 2 item(s) from MyBot on USSouth3; also in offer #5");
    // Offer #5 is taken: its meeting has the item now, and nothing else can count on it until that ends.
    meetings = [rv];
    await c.poll();
    expect(q.listPending(db).withdraws[0]).toMatchObject({ instanceIds: ["i-patk"] });
    expect(c.held().map((h) => h.instanceId)).toEqual(["i-pdef-plain", "i-pdef-ench"]);
    expect(await c.createOffer({ instanceIds: ["i-patk"], want, server: "USSouth3" })).toMatchObject({ ok: false, status: 409, error: "One of those items is no longer free on this node (in a trade right now, reserved, or gone)." });
  });

  it("accepting hands over a copy no offer names when an equally plain one would, and says when it cannot", async () => {
    const live = pool();
    live.instances[BOT][7] = { instanceId: "i-pdef-two", itemId: "pdef", enchantments: [], capturedAt: 2 };
    let next = 5;
    const { hub } = fakeHub({ onCall: (m, p, body) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: next++, ...(body as object), status: "open", mine: true, poster: "Me", createdAt: 1, expiresAt: 2 } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {} });
    const theirs = { id: 40, poster: "Them", mine: false, botIgn: "", seasonal: true, server: "USEast", give: [{ ref: "x", itemId: "patk", enchants: [], count: 0 }], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], status: "open" as const, createdAt: 1, expiresAt: 2 };
    const pick = () => { const pv = c.preview(theirs); return pv.ok ? pv.picks.map((p) => [p.instanceId, p.offers]) : pv.error; };
    // The older plain copy goes first while nothing names either.
    expect(pick()).toEqual([["i-pdef-plain", []]]);
    await c.createOffer({ instanceIds: ["i-pdef-plain"], want: [{ itemId: "patk", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    expect(pick()).toEqual([["i-pdef-two", []]]);
    // Both plain copies offered: one of them still goes (before a better copy), and the pick says which offer it would end.
    await c.createOffer({ instanceIds: ["i-pdef-two"], want: [{ itemId: "patk", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    expect(pick()).toEqual([["i-pdef-plain", [5]]]);
  });

  it("previews the plainest fit for someone else's offer, accepts, and queues the swap row from the rendezvous", async () => {
    const rv: RendezvousWire = {
      id: 9, kind: "swap", offerId: 5, server: "USEast", seasonal: true, state: "meet", createdAt: 1, deadlineAt: Date.now() + 3_600_000,
      me: { role: "take", botIgn: "MyBot", gives: [{ ref: "i-pdef-plain", itemId: "pdef", enchants: [], count: 0 }], gets: [{ itemId: "patk", qty: 1 }] },
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
    expect(calls.find((x) => x.path.endsWith("/accept"))?.body).toMatchObject({ botIgn: "MyBot", items: [{ ref: "i-pdef-plain", itemId: "pdef" }] });
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
    expect(receipts[0]).toMatchObject({ window: 0, ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveRefs: ["i-pdef-plain"], got: [{ itemId: "patk", qty: 1 }], partnerIgn: "TheirBot" });
    expect(c.status().rendezvous.length).toBe(0);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
  });

  it("a meeting past its deadline with no trade is aborted from the node", async () => {
    // The queue's own expiry runs on the wall clock (five minutes past the deadline), so the deadline sits in real time and the coordinator's clock moves past it.
    const base = Date.now();
    let now = base + 1000;
    const rv: RendezvousWire = { id: 4, kind: "swap", offerId: 8, server: "USEast", seasonal: true, state: "meet", createdAt: base, deadlineAt: base + 4000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } };
    const { hub, calls } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : m === "POST" && p === "/api/v1/rendezvous/4/abort" ? { ok: true, state: "aborted" } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {}, now: () => now });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    now = base + 5000;
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(calls.some((x) => x.path === "/api/v1/rendezvous/4/abort")).toBe(true);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 4").get()).toEqual({ state: "aborted" });
  });

  it("an operator abort tells the hub, and the poll after it cancels the local row and reopens the offer", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 12, kind: "swap", offerId: 8, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } });
    const { hub, calls } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv()] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : m === "POST" && p === "/api/v1/rendezvous/12/abort" ? ((state = "aborted"), { ok: true, state: "aborted" }) : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    expect(await c.abortRendezvous(12, "server full")).toEqual({ ok: true, aborted: true, state: "aborted" });
    expect(calls.find((x) => x.path === "/api/v1/rendezvous/12/abort")?.body).toEqual({ reason: "server full" });
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 12").get()).toEqual({ state: "aborted" });
    expect(c.status().localOffers[0].status).toBe("open");
  });

  it("a taker whose meeting failed on its own receipt gets its promised items back", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 14, kind: "swap", offerId: 5, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "take", botIgn: "MyBot", gives: [{ ref: "i-pdef-plain", itemId: "pdef", enchants: [], count: 0 }], gets: [{ itemId: "patk", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } });
    const { hub } = fakeHub({ onCall: (m, p) => (m === "POST" && p === "/api/v1/offers/5/accept" ? { rendezvous: rv() } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv()] } : m === "POST" && p === "/api/v1/rendezvous/14/receipt" ? ((state = "failed"), { ok: true, state: "failed" }) : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    const offer = { id: 5, poster: "Them", mine: false, botIgn: "TheirBot", seasonal: true, server: "USEast", give: [{ ref: "x", itemId: "patk", enchants: [], count: 0 }], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], status: "open" as const, createdAt: 1, expiresAt: 2 };
    presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USEast", freeSlots: 5, status: "idle", seasonal: true });
    await c.acceptOffer(offer);
    expect(c.held().map((h) => h.instanceId)).not.toContain("i-pdef-plain");
    const row = q.listPending(db).withdraws[0];
    c.start();
    q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 1 }], ["i-pdef-plain"]);
    // This side's receipt is the one that closes the meeting: the hub answers "failed" right here.
    q.reportSwap(db, BOT, row.id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "TheirBot", error: "partner left" });
    await new Promise((r) => setTimeout(r, 20));
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 14").get()).toEqual({ state: "failed" });
    await c.poll();
    c.stop();
    expect(c.status().localOffers[0].status).toBe("failed");
    expect(c.held().map((h) => h.instanceId)).toContain("i-pdef-plain");
  });

  it("a rendezvous the hub aborted cancels the local row", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 3, kind: "swap", offerId: 8, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } });
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

  it("a poster's offer follows its own bot's word: a meeting the hub calls done on the partner's claim leaves it open", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 21, kind: "swap", offerId: 8, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: true } });
    const { hub } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv()] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    // The partner says it traded and this node's bot never did: the hub's "done" is the partner's word, not this side's.
    state = "done";
    await c.poll();
    expect(c.status().localOffers[0].status).toBe("open");
  });

  it("a poster whose own bot traded has its offer done, whatever the partner said", async () => {
    let state: RendezvousWire["state"] = "meet";
    const rv = (): RendezvousWire => ({ id: 22, kind: "swap", offerId: 8, server: "USEast", seasonal: true, state, createdAt: 1, deadlineAt: Date.now() + 3_600_000, me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] }, partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false } });
    const { hub } = fakeHub({ onCall: (m, p) => (m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv()] } : m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : m === "POST" && p === "/api/v1/rendezvous/22/receipt" ? { ok: true, state: "meet" } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], server: "USEast" });
    await c.poll();
    const row = q.listPending(db).withdraws[0];
    c.start();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i-patk"]);
    q.reportSwap(db, BOT, row.id, { ok: true, gave: [{ itemId: "patk", qty: 1 }], gaveInstanceIds: ["i-patk"], got: [{ itemId: "pdef", qty: 1 }], partnerIgn: "TheirBot" });
    await new Promise((r) => setTimeout(r, 20));
    // The partner then contradicts it: the meeting is disputed, and this node's offer is still done on its own bot's word.
    state = "disputed";
    await c.poll();
    c.stop();
    expect(c.status().localOffers[0].status).toBe("done");
  });
});

describe("SwapCoordinator: receipts, lost outcomes, storage, servers, reconciliation", () => {
  const WANT = (qty = 1) => [{ itemId: "pdef", qty, slotsMin: 0, slotsExact: null, enchants: [] }];
  const OFFER = { id: 5, poster: "Them", mine: false, botIgn: "TheirBot", seasonal: true, server: "USEast", give: [{ ref: "x", itemId: "patk", enchants: [], count: 0 }], want: WANT(), status: "open" as const, createdAt: 1, expiresAt: 2 };
  const RV = (over: Partial<RendezvousWire> = {}): RendezvousWire => ({
    id: 9, kind: "swap", offerId: 5, server: "USEast", seasonal: true, state: "meet", createdAt: MADE_AT, deadlineAt: Date.now() + 30 * 60_000,
    me: { role: "take", botIgn: "MyBot", gives: [{ ref: "i-pdef-plain", itemId: "pdef", enchants: [], count: 0 }], gets: [{ itemId: "patk", qty: 1 }], getsItems: [{ itemId: "patk", enchants: [], count: 0 }] },
    partner: { botIgn: "TheirBot", poster: "Them" }, reported: { mine: false, partner: false }, ...over,
  });
  const online = () => presence.report({ botGuid: BOT, alias: "B", ign: "MyBot", server: "USEast", freeSlots: 5, status: "idle", seasonal: true });
  const tick = () => new Promise((r) => setTimeout(r, 25));

  it("a receipt the hub cannot be reached for is kept and sent again on the next poll", async () => {
    let hubUp = false;
    const receipts: unknown[] = [];
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers/5/accept") return { rendezvous: RV() };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV()] };
      if (m === "POST" && p === "/api/v1/rendezvous/9/receipt") {
        if (!hubUp) return null;
        receipts.push(body);
        return { ok: true, state: "done" };
      }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    online();
    await c.acceptOffer(OFFER);
    const row = q.listPending(db).withdraws[0];
    c.start();
    await tick();
    q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 1 }], ["i-pdef-plain"]);
    q.reportSwap(db, BOT, row.id, { ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveInstanceIds: ["i-pdef-plain"], got: [{ itemId: "patk", qty: 1 }], gotItems: [{ itemId: "patk", enchants: [], count: 0 }], partnerIgn: "TheirBot" });
    await tick();
    expect(db.prepare("SELECT state, receipt_sent_at FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "receipt-pending", receipt_sent_at: null });
    expect(c.status().rendezvous[0]).toMatchObject({ receiptPending: true, localState: "receipt-pending" });
    expect(receipts).toHaveLength(0);
    hubUp = true;
    await c.poll();
    c.stop();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: true, gaveRefs: ["i-pdef-plain"], gotItems: [{ itemId: "patk", enchants: [], count: 0 }], partnerIgn: "TheirBot" });
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
    expect(c.status().rendezvous[0].events.map((e) => e.event)).toEqual(["swap-queued", "claimed", "swap-done"]);
  });

  it("a swap row back on pending whose items are gone after a fresh look is reported as done", async () => {
    const receipts: unknown[] = [];
    const verifies: string[] = [];
    const live = pool();
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers/5/accept") return { rendezvous: RV() };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV()] };
      if (m === "POST" && p === "/api/v1/rendezvous/9/receipt") {
        receipts.push(body);
        return { ok: true, state: "done" };
      }
      return undefined;
    } });
    let seenAt: number | null = null;
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {}, verifiedAt: () => seenAt, verify: async (g) => { verifies.push(g); } });
    online();
    await c.acceptOffer(OFFER);
    const row = q.listPending(db).withdraws[0];
    // The bot claimed it, dropped, and the row came back to pending a minute ago; this process holds no outcome for it.
    expect(q.claimWithdraw(db, BOT, [{ itemId: "pdef", qty: 1 }], ["i-pdef-plain"])).toMatchObject({ requestId: row.id });
    expect(q.unclaim(db, BOT, row.id, "withdraw")).toBe(true);
    db.prepare("UPDATE withdraw_requests SET updated_at = ? WHERE id = ?").run(Date.now() - 61_000, row.id);
    live.botMeta![BOT].online = false;
    c.start();
    await tick();
    // No look since the row came back: the bot is logged in for one, once.
    expect(verifies).toEqual([BOT]);
    await c.poll();
    expect(verifies).toEqual([BOT]);
    expect(receipts).toHaveLength(0);
    // The look shows the item gone: the trade happened, and the hub hears so.
    delete live.instances[BOT][4];
    seenAt = Date.now();
    await c.poll();
    await tick();
    c.stop();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: true, gave: [{ itemId: "pdef", qty: 1 }], gaveRefs: ["i-pdef-plain"], got: [{ itemId: "patk", qty: 1 }], partnerIgn: "TheirBot" });
    expect(q.swapJobsFor(db, 9)).toMatchObject([{ id: row.id, status: "fulfilled" }]);
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 9").get()).toEqual({ state: "done" });
  });

  it("a swap row no bot ever claimed is not reported as traded when its items go missing (a storage fetch that failed)", async () => {
    const live = pool();
    const receipts: unknown[] = [];
    const verifies: string[] = [];
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers/5/accept") return { rendezvous: RV() };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV()] };
      if (m === "POST" && p === "/api/v1/rendezvous/9/receipt") { receipts.push(body); return { ok: true, state: "done" }; }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {}, verifiedAt: () => Date.now(), verify: async (g) => { verifies.push(g); } });
    online();
    await c.acceptOffer(OFFER);
    const row = q.listPending(db).withdraws[0];
    // Still pending a minute on, never claimed; a fresh look no longer shows the item where the node thought it was.
    db.prepare("UPDATE withdraw_requests SET updated_at = ? WHERE id = ?").run(Date.now() - 61_000, row.id);
    delete live.instances[BOT][4];
    c.start();
    await tick();
    await c.poll();
    await tick();
    c.stop();
    expect(receipts).toHaveLength(0);
    expect(verifies).toHaveLength(0);
    expect(q.swapJobsFor(db, 9)).toMatchObject([{ id: row.id, status: "pending" }]);
  });

  it("a swap row back on pending whose items are still there is left for the fleet to retry", async () => {
    const live = pool();
    const receipts: unknown[] = [];
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers/5/accept") return { rendezvous: RV() };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV()] };
      if (m === "POST" && p === "/api/v1/rendezvous/9/receipt") { receipts.push(body); return { ok: true, state: "done" }; }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {}, verifiedAt: () => Date.now() });
    online();
    await c.acceptOffer(OFFER);
    const row = q.listPending(db).withdraws[0];
    db.prepare("UPDATE withdraw_requests SET updated_at = ? WHERE id = ?").run(Date.now() - 61_000, row.id);
    c.start();
    await tick();
    await c.poll();
    c.stop();
    expect(receipts).toHaveLength(0);
    expect(q.listPending(db).withdraws).toHaveLength(1);
  });

  it("storage copies can be offered, copies on the character are picked first, and the account must have room for what comes back", async () => {
    const live = pool();
    live.stored = { [BOT]: [{ instanceId: "s-patk", itemId: "patk", enchantments: [], capturedAt: 1, where: { kind: "vault", slot: 0 }, pools: { seasonal: true, nonseasonal: false } }] };
    let next = 6;
    const { hub } = fakeHub({ onCall: (m, p, body) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: next++, ...(body as object), status: "open", mine: true, poster: "Me", createdAt: 1, expiresAt: 2 } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {} });
    expect(c.held().find((h) => h.instanceId === "s-patk")).toMatchObject({ stored: true, where: "in a vault chest", seasonal: true });
    const pv = c.preview({ ...OFFER, give: [{ ref: "x", itemId: "pdef", enchants: [], count: 0 }], want: [{ itemId: "patk", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }] });
    expect(pv.ok && pv.picks.map((p) => p.instanceId)).toEqual(["i-patk"]);
    expect(await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "Nowhere" })).toMatchObject({ ok: false, status: 400 });
    setServerControl(db, "USWest4", false, true);
    expect(await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USWest4" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("disabled") });
    // 8 slots, 3 held: room for 5, plus whatever leaves the character in the same window. A storage copy frees no slot.
    expect(await c.createOffer({ instanceIds: ["s-patk"], want: WANT(6), server: "USSouth3" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("free slot") });
    expect(await c.createOffer({ instanceIds: ["i-patk"], want: WANT(6), server: "USSouth3" })).toMatchObject({ ok: true, offer: { id: 6 } });
    expect(await c.createOffer({ instanceIds: ["s-patk"], want: WANT(5), server: "USSouth3" })).toMatchObject({ ok: true, offer: { id: 7 } });
    expect(c.status().localOffers.map((o) => [o.offerId, o.refs])).toEqual([[6, { "i-patk": "i-patk" }], [7, { "s-patk": "s-patk" }]]);
    // Both are in an offer now: still offerable again (each says which), but not the owner's to withdraw.
    expect(c.held().filter((h) => h.offers.length).map((h) => [h.instanceId, h.offers])).toEqual([["i-patk", [6]], ["s-patk", [7]]]);
    expect(reservedInstanceIds(db)).toEqual(new Set(["i-patk", "s-patk"]));
  });

  it("accepting proposes another server when the offer's is closed on this node", async () => {
    setServerControl(db, "USEast", false, true);
    let accepted: { server?: string } | null = null;
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers/5/accept") {
        accepted = body as { server?: string };
        return { rendezvous: RV({ server: (body as { server?: string }).server ?? "USEast" }) };
      }
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [] };
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    online();
    expect((await c.acceptOffer(OFFER)).ok).toBe(true);
    expect(accepted!.server).toBeDefined();
    expect(accepted!.server).not.toBe("USEast");
    expect(WITHDRAW_SERVERS).toContain(accepted!.server);
    expect(q.listPending(db).withdraws[0].server).toBe(accepted!.server);
  });

  it("an offer gives no more than the giving account trades at once, and the desk knows each account's size", async () => {
    const small = pool();
    small.capacities = { [BOT]: 2 };
    const { hub, calls } = fakeHub({ onCall: (m, p) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: 5, status: "open" } } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => small, log: () => {} });
    expect(c.status().tradeSlots).toEqual({ biggest: 8, byBot: { [BOT]: 2 } });
    expect(await c.createOffer({ instanceIds: ["i-patk", "i-pdef-plain", "i-pdef-ench"], want: WANT(), server: "USSouth3" })).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/at most 2 items at once/) });
    expect(calls).toHaveLength(0);
    expect(await c.createOffer({ instanceIds: ["i-patk", "i-pdef-plain"], want: WANT(), server: "USSouth3" })).toMatchObject({ ok: true });
  });

  it("withdraws a posted offer whose items left the node", async () => {
    const live = pool();
    const deleted: string[] = [];
    let status = "open";
    const { hub } = fakeHub({ onCall: (m, p) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "GET" && p === "/api/v1/offers/mine") return { offers: [{ id: 8, status, poster: "Me", mine: true, botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [], want: [], createdAt: 1, expiresAt: 2 }] };
      if (m === "DELETE" && p === "/api/v1/offers/8") { deleted.push(p); status = "cancelled"; return { ok: true }; }
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [] };
      return undefined;
    } });
    let clock = Date.now();
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {}, now: () => clock });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USSouth3" });
    await c.poll();
    expect(deleted).toEqual([]);
    delete live.instances[BOT][6];
    clock += 61_000;
    await c.poll();
    expect(deleted).toEqual(["/api/v1/offers/8"]);
    expect(c.status().localOffers[0].status).toBe("cancelled");
  });

  it("a pool withdraw takes an item out of open offers: they are withdrawn at once, or by the offer check when the hub was not reached", async () => {
    const deleted: string[] = [];
    const statuses: Record<number, string> = { 8: "open", 9: "open", 10: "open" };
    let hubDown = true;
    let next = 8;
    const { hub } = fakeHub({ onCall: (m, p) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: next++, status: "open" } };
      if (m === "GET" && p === "/api/v1/offers/mine") return { offers: Object.entries(statuses).map(([id, status]) => ({ id: Number(id), status, poster: "Me", mine: true, botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [], want: [], createdAt: 1, expiresAt: 2 })) };
      const del = /^\/api\/v1\/offers\/(\d+)$/.exec(p);
      if (m === "DELETE" && del) {
        if (hubDown) return undefined;
        deleted.push(p);
        statuses[Number(del[1])] = "cancelled";
        return { ok: true };
      }
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [] };
      return undefined;
    } });
    let clock = Date.now();
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {}, now: () => clock });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USSouth3" });
    await c.createOffer({ instanceIds: ["i-patk", "i-pdef-plain"], want: WANT(), server: "USSouth3" });
    await c.createOffer({ instanceIds: ["i-pdef-ench"], want: WANT(), server: "USSouth3" });
    // Open offers do not hold an item back from a withdraw.
    expect(reservedInstanceIds(db, { openOffers: false }).has("i-patk")).toBe(false);
    // The hub is not reached: nothing withdrawn now.
    expect(await c.withdrawOffersNaming(["i-patk"], "a withdraw took its items")).toEqual([]);
    expect(c.status().localOffers.map((o) => o.status)).toEqual(["open", "open", "open"]);
    // The withdraw row is open; the next offer check withdraws both offers naming the item, and leaves the third.
    db.prepare("INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at) VALUES ('P', 'p', 'USSouth3', '[]', 'pending', ?, '[\"i-patk\"]', 1, 1, 1)").run(BOT);
    hubDown = false;
    await c.poll();
    clock += 61_000;
    await c.poll();
    expect(deleted.sort()).toEqual(["/api/v1/offers/8", "/api/v1/offers/9"]);
    expect(c.status().localOffers.map((o) => [o.offerId, o.status])).toEqual([[8, "cancelled"], [9, "cancelled"], [10, "open"]]);
    // Reached at once: withdrawn right away.
    expect(await c.withdrawOffersNaming(["i-pdef-ench"], "a withdraw took its items")).toEqual([10]);
  });

  it("forgets a posted offer the hub says is no longer open, saying why when the hub closed it", async () => {
    let status = "open";
    const { hub } = fakeHub({ onCall: (m, p) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "GET" && p === "/api/v1/offers/mine") return { offers: [{ id: 8, status, poster: "Me", mine: true, botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [], want: [], createdAt: 1, expiresAt: 2 }] };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [] };
      return undefined;
    } });
    let clock = Date.now();
    const logs: string[] = [];
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: (s) => logs.push(s), now: () => clock });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USSouth3" });
    expect(c.held().find((h) => h.instanceId === "i-patk")?.offers).toEqual([8]);
    expect(reservedInstanceIds(db)).toContain("i-patk");
    status = "expired";
    clock += 61_000;
    await c.poll();
    expect(c.status().localOffers[0].status).toBe("expired");
    expect(c.held().find((h) => h.instanceId === "i-patk")?.offers).toEqual([]);
    expect(reservedInstanceIds(db)).not.toContain("i-patk");
    expect(logs).toContain("swaps: offer #8 is expired on the hub; its items are free again");
  });

  it("renews an offer for another fourteen days; an expired one comes back only while its items are all still free", async () => {
    const live = pool();
    const renewed: string[] = [];
    const { hub } = fakeHub({ onCall: (m, p) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "POST" && p === "/api/v1/offers/8/renew") { renewed.push(p); return { offer: { id: 8, status: "open", expiresAt: Date.now() + 14 * 86400_000 } }; }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USSouth3" });
    expect(await c.renewOffer(8)).toMatchObject({ ok: true, offer: { id: 8 } });
    // Expired on the hub: back to open here too once renewed, the item reserved for it again.
    db.prepare("UPDATE swap_offers SET status = 'expired' WHERE offer_id = 8").run();
    expect(await c.renewOffer(8)).toMatchObject({ ok: true });
    expect(c.status().localOffers[0].status).toBe("open");
    // Expired, and its item has gone in the meantime: nothing to renew.
    db.prepare("UPDATE swap_offers SET status = 'expired' WHERE offer_id = 8").run();
    delete live.instances[BOT][6];
    expect(await c.renewOffer(8)).toMatchObject({ ok: false, status: 409 });
    expect(renewed).toHaveLength(2);
  });

  it("an offer the hub withdrew because its item was traded away in another meeting is logged with the reason", async () => {
    const { hub } = fakeHub({ onCall: (m, p) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "GET" && p === "/api/v1/offers/mine") return { offers: [{ id: 8, status: "cancelled", closedReason: "Potion of Attack was traded away in meeting #3", poster: "Me", mine: true, botIgn: "MyBot", seasonal: true, server: "USSouth3", give: [], want: [], createdAt: 1, expiresAt: 2 }] };
      return undefined;
    } });
    const logs: string[] = [];
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: (s) => logs.push(s) });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USSouth3" });
    await c.mine();
    expect(c.status().localOffers[0].status).toBe("cancelled");
    expect(logs).toContain("swaps: offer #8 is cancelled on the hub (Potion of Attack was traded away in meeting #3)");
  });

  it("gives a meeting up instead of asking for more time when the items it was to give are nowhere on the node", async () => {
    const asked: unknown[] = [];
    const aborted: unknown[] = [];
    const live = pool();
    let clock = Date.now();
    const give = { role: "give" as const, botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] };
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV({ id: 12, offerId: 8, deadlineAt: clock + 4 * 60_000, me: give })] };
      if (m === "POST" && p === "/api/v1/rendezvous/12/extend") { asked.push(body); return { ok: true, deadlineAt: clock + 14 * 60_000 }; }
      if (m === "POST" && p === "/api/v1/rendezvous/12/abort") { aborted.push(body); return { ok: true, state: "aborted" }; }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool: () => live, log: () => {}, now: () => clock });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USEast" });
    await c.poll();
    // The item left the node (a storage read gave it another identity, say) before any bot claimed the row.
    delete live.instances[BOT][6];
    await c.poll();
    expect(asked).toHaveLength(0);
    expect(aborted).toHaveLength(0);
    clock += 2 * 60_000;
    await c.poll();
    expect(asked).toHaveLength(0);
    expect(aborted).toEqual([{ reason: "1 of the 1 item(s) to give are no longer on the node" }]);
    expect(q.swapJobsFor(db, 12)[0].status).toBe("cancelled");
    expect(db.prepare("SELECT state FROM swap_rendezvous WHERE rendezvous_id = 12").get()).toEqual({ state: "aborted" });
  });

  it("asks the hub for more time when a meeting nears its deadline while this side still tries", async () => {
    const asked: unknown[] = [];
    // A minute and a half left: inside the two minutes that ask for more.
    let deadline = Date.now() + 90_000;
    const give = { role: "give" as const, botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }] };
    const { hub } = fakeHub({ onCall: (m, p, body) => {
      if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
      if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [RV({ id: 12, offerId: 8, deadlineAt: deadline, me: give })] };
      if (m === "POST" && p === "/api/v1/rendezvous/12/extend") {
        asked.push(body);
        deadline += 10 * 60_000;
        return { ok: true, deadlineAt: deadline };
      }
      return undefined;
    } });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {} });
    await c.createOffer({ instanceIds: ["i-patk"], want: WANT(), server: "USEast" });
    await c.poll();
    expect(asked).toHaveLength(0);
    await c.poll();
    expect(asked).toHaveLength(1);
    expect(q.swapJobsFor(db, 12)[0].spec.deadlineAt).toBe(deadline);
    expect(db.prepare("SELECT deadline_at FROM swap_rendezvous WHERE rendezvous_id = 12").get()).toEqual({ deadline_at: deadline });
    await c.poll();
    expect(asked).toHaveLength(1);
  });
});

describe("SwapCoordinator: player meetings (a person trading with their own character)", () => {
  const LINES = [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }];
  const PRV = (over: Partial<RendezvousWire> = {}): RendezvousWire => ({
    id: 20, kind: "player", offerId: 8, server: "USEast", seasonal: true, state: "meet", createdAt: MADE_AT, deadlineAt: Date.now() + 30 * 60_000,
    me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }], getsLines: LINES },
    partner: { botIgn: "SomePlayer", poster: "Some Player", player: true }, reported: { mine: false, partner: false }, ...over,
  });
  function coordinator(rv: () => RendezvousWire, players = { enabled: true, maxMeetings: 2 }, now?: () => number) {
    const progress: unknown[] = [];
    const { hub, calls } = fakeHub({
      onCall: (m, p, body) => {
        if (m === "POST" && p === "/api/v1/offers") return { offer: { id: 8, status: "open" } };
        if (m === "GET" && p === "/api/v1/rendezvous/mine") return { rendezvous: [rv()] };
        if (m === "POST" && p === "/api/v1/rendezvous/20/progress") return (progress.push(body), { ok: true });
        if (m === "POST" && p === "/api/v1/rendezvous/20/abort") return { ok: true, state: "aborted" };
        if (m === "POST" && p === "/api/v1/rendezvous/20/extend") return { ok: true, deadlineAt: Date.now() + 40 * 60_000 };
        if (m === "POST" && p === "/api/v1/rendezvous/20/receipt") return { ok: true, state: "done" };
        return undefined;
      },
    });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {}, players: () => players, ...(now ? { now } : {}) });
    return { c, calls, progress };
  }
  const post = (c: SwapCoordinator) => c.createOffer({ instanceIds: ["i-patk"], want: LINES, server: "USEast" });
  const rowId = () => (db.prepare("SELECT id FROM withdraw_requests WHERE swap_json IS NOT NULL").get() as { id: number }).id;

  it("becomes a swap row with the offer's want lines and the player's IGN, and the fleet's notes reach the hub as progress", async () => {
    const { c, progress } = coordinator(() => PRV());
    await post(c);
    await c.poll();
    const [row] = q.listPending(db).withdraws;
    expect(row).toMatchObject({ targetBotGuid: BOT, instanceIds: ["i-patk"], swap: { rendezvousId: 20, role: "give", player: { lines: LINES } } });
    expect(db.prepare("SELECT ign FROM withdraw_requests WHERE id = ?").get(row.id)).toEqual({ ign: "SomePlayer" });
    // The first word: which bot is coming (never the account's alias).
    expect(progress.at(-1)).toMatchObject({ stage: "queued", botIgn: "MyBot", server: "USEast", detail: "MyBot is logging in to USEast" });

    c.start();
    q.noteSwap(db, row.id, "swap-assigned", BOT, { bot: "b-alias", inNexus: false, server: "USEast" });
    await c.flushProgress();
    expect(progress.at(-1)).toMatchObject({ stage: "on-the-way", botIgn: "MyBot", detail: "MyBot is on its way to the USEast nexus" });
    q.noteSwap(db, row.id, "player-ready", BOT, { bot: "MyBot", server: "USEast" });
    await c.flushProgress();
    expect(progress.at(-1)).toMatchObject({ stage: "ready", detail: "MyBot is in the USEast nexus: /trade MyBot" });
    expect((db.prepare("SELECT ready_at FROM swap_rendezvous WHERE rendezvous_id = 20").get() as { ready_at: number | null }).ready_at).not.toBeNull();
    // The same news twice is sent once; a hold says why.
    const n = progress.length;
    q.noteSwap(db, row.id, "swap-waiting", BOT, { bot: "b-alias", waitedS: 60 });
    await c.flushProgress();
    expect(progress.length).toBe(n);
    q.noteSwap(db, row.id, "player-holding", BOT, { bot: "MyBot", why: "Potion of Attack is not part of this trade; take it out" });
    await c.flushProgress();
    expect(progress.at(-1)).toMatchObject({ stage: "holding", detail: "the bot is not accepting yet: Potion of Attack is not part of this trade; take it out" });
    expect(JSON.stringify(progress)).not.toContain("b-alias");
    c.stop();
  });

  it("is called off at once when this node will not run it: trades with players off, a server it does not trade on, its cap reached", async () => {
    const off = coordinator(() => PRV(), { enabled: false, maxMeetings: 2 });
    await post(off.c);
    await off.c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(0);
    expect(off.calls.find((x) => x.path === "/api/v1/rendezvous/20/abort")?.body).toEqual({ reason: "this node no longer takes trades with players" });

    db.exec("DELETE FROM swap_offers; DELETE FROM swap_rendezvous;");
    const closed = coordinator(() => PRV({ server: "Nowhere9" }));
    await post(closed.c);
    await closed.c.poll();
    expect(closed.calls.find((x) => x.path === "/api/v1/rendezvous/20/abort")?.body).toEqual({ reason: "Pick a server this node trades on." });

    db.exec("DELETE FROM swap_offers; DELETE FROM swap_rendezvous;");
    db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, kind, created_at, updated_at) VALUES (77, NULL, NULL, 'meet', 'player', 1, 1)").run();
    const full = coordinator(() => PRV(), { enabled: true, maxMeetings: 1 });
    await post(full.c);
    await full.c.poll();
    expect(full.calls.find((x) => x.path === "/api/v1/rendezvous/20/abort")?.body).toEqual({ reason: "this node already runs 1 player meeting, its limit" });
  });

  it("asks no more time once its bot waits in the nexus, and its receipt says when the player never came", async () => {
    let now = Date.now();
    const deadline = now + 30 * 60_000;
    const { c, calls } = coordinator(() => PRV({ deadlineAt: deadline }), { enabled: true, maxMeetings: 2 }, () => now);
    await post(c);
    await c.poll();
    const id = rowId();
    q.claimWithdraw(db, BOT, [{ itemId: "patk", qty: 1 }], ["i-patk"]);
    c.start();
    q.noteSwap(db, id, "player-ready", BOT, { bot: "MyBot", server: "USEast" });
    now = deadline - 60_000;
    await c.poll();
    expect(calls.some((x) => x.path === "/api/v1/rendezvous/20/extend")).toBe(false);
    q.reportSwap(db, BOT, id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "SomePlayer", error: "the player never came before the meeting deadline", partnerAbsent: true });
    await new Promise((r) => setTimeout(r, 20));
    c.stop();
    expect(calls.find((x) => x.path === "/api/v1/rendezvous/20/receipt")?.body).toMatchObject({ ok: false, partnerAbsent: true, partnerIgn: "SomePlayer" });
  });
});

describe("SwapCoordinator: the hub's meeting numbers", () => {
  it("a hub that started over reuses a number: the old local row is not the new meeting, which is queued", async () => {
    const LINES = [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }];
    const rv: RendezvousWire = {
      id: 1, kind: "player", offerId: 8, server: "USEast", seasonal: true, state: "meet", createdAt: MADE_AT, deadlineAt: Date.now() + 30 * 60_000,
      me: { role: "give", botIgn: "MyBot", gives: [{ ref: "i-patk", itemId: "patk", enchants: [], count: 0 }], gets: [{ itemId: "pdef", qty: 1 }], getsLines: LINES },
      partner: { botIgn: "SomePlayer", poster: "Some Player", player: true }, reported: { mine: false, partner: false },
    };
    const { hub } = fakeHub({ onCall: (m, p) => (m === "POST" && p === "/api/v1/offers" ? { offer: { id: 8, status: "open" } } : m === "GET" && p === "/api/v1/rendezvous/mine" ? { rendezvous: [rv] } : m === "POST" ? { ok: true } : undefined) });
    const c = new SwapCoordinator({ db: () => db, hub, pool, log: () => {}, players: () => ({ enabled: true, maxMeetings: 2 }) });
    await c.createOffer({ instanceIds: ["i-patk"], want: LINES, server: "USEast" });
    // Meeting #1 of the hub's previous life: long done here.
    db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, created_at, updated_at) VALUES (1, 3, 99, 'done', 1, 1)").run();
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
    expect(db.prepare("SELECT state, kind, hub_created_at FROM swap_rendezvous WHERE rendezvous_id = 1").get()).toEqual({ state: "meet", kind: "player", hub_created_at: rv.createdAt });
    // The same meeting polled again is the same meeting.
    await c.poll();
    expect(q.listPending(db).withdraws).toHaveLength(1);
  });
});
