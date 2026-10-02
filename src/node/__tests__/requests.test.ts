// The hub request runner (requests.ts): a request the hub hands out again is
// answered again, never run twice, and an answer the hub did not get is sent
// until it does; one person's requests run in order, different people's at
// once; progress names the bot to /trade now.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { GuestRequestWire } from "../../shared/hubWire";
import type { HubClient } from "../hub";
import { RequestRunner } from "../requests";
import { openDatabase } from "../../lib/db";
import { presence } from "../../lib/fleetPresence";
import { registerAdvancedSettings } from "../../lib/advanced";
import { DEFAULT_ADVANCED } from "../settings";
import type { PyrelayPool } from "../../lib/devauth";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
});

const REQ: GuestRequestWire = {
  id: 7, nodeId: "n1", requester: { userId: 1, displayName: "Pat" }, owner: true, ign: "PatChar", kind: "offer-cancel", seasonal: false,
  server: null, count: null, refs: null, want: null, offerId: 5, communism: null, state: "taken", createdAt: 1, result: null,
};

function runner(opts: { results: () => "up" | "down" | "refuse" }) {
  const results: unknown[] = [];
  let cancels = 0;
  let queue: GuestRequestWire[] = [REQ];
  const hub = {
    linked: true,
    signed: async (method: string, path: string, body: unknown) => {
      if (method === "GET" && path.startsWith("/api/v1/guest-requests")) return { ok: true, data: { requests: queue } };
      if (method === "POST" && path === "/api/v1/guest-requests/7/result") {
        const s = opts.results();
        if (s === "down") return { ok: false, status: 0, error: "hub unreachable" };
        if (s === "refuse") return { ok: false, status: 409, error: "request is done" };
        results.push(body);
        return { ok: true, data: { ok: true, state: "done" } };
      }
      return { ok: false, status: 404, error: "no" };
    },
  } as unknown as HubClient;
  const swaps = { cancelOffer: async () => (cancels++, { ok: true, cancelled: true }) };
  const r = new RequestRunner({ db: () => db, hub, swaps: swaps as never, communism: {} as never, pool: () => null, log: () => {} });
  return { r, results, cancels: () => cancels, setQueue: (q: GuestRequestWire[]) => (queue = q) };
}

describe("RequestRunner", () => {
  it("a request handed out again is answered again, not run twice", async () => {
    const t = runner({ results: () => "up" });
    await t.r.pollRequests();
    await t.r.pollRequests();
    expect(t.cancels()).toBe(1);
    expect(t.results).toEqual([{ ok: true, offerId: 5 }, { ok: true, offerId: 5 }]);
  });

  it("an answer the hub could not take is sent on later rounds until it has it; a refusal is final", async () => {
    let state: "up" | "down" | "refuse" = "down";
    const t = runner({ results: () => state });
    await t.r.pollRequests();
    expect(t.results).toEqual([]);
    t.setQueue([]);
    state = "up";
    await t.r.pollRequests();
    expect(t.results).toEqual([{ ok: true, offerId: 5 }]);
    await t.r.pollRequests();
    expect(t.results).toHaveLength(1);
    expect(t.cancels()).toBe(1);
    // A refused answer is not sent again.
    db.prepare("UPDATE hub_request_results SET delivered = 0").run();
    state = "refuse";
    await t.r.pollRequests();
    state = "up";
    await t.r.pollRequests();
    expect(t.results).toHaveLength(1);
  });
});

// --- lanes, progress, "N of this item" (docs/relay/ADVANCED.md) ------------------------------

const reqOf = (id: number, kind: GuestRequestWire["kind"], userId: number, o: Partial<GuestRequestWire> = {}): GuestRequestWire =>
  ({ ...REQ, id, kind, requester: { userId, displayName: `U${userId}` }, owner: kind !== "deposit" && kind !== "withdraw", offerId: id, ...o });

/** A runner whose hub hands out `queue` once and records every answer; owner requests wait on `gate` when one is set. */
function laneRunner(queue: GuestRequestWire[]) {
  const answered: { id: number; at: number; body: unknown }[] = [];
  const started: number[] = [];
  const gates = new Map<number, () => void>();
  let handed = false;
  const hub = {
    linked: true,
    signed: async (method: string, pathq: string, body: unknown) => {
      if (method === "GET" && pathq.startsWith("/api/v1/guest-requests")) {
        const out = handed ? [] : queue;
        handed = true;
        return { ok: true, data: { requests: out } };
      }
      const m = /^\/api\/v1\/guest-requests\/(\d+)\/result$/.exec(pathq);
      if (method === "POST" && m) {
        answered.push({ id: Number(m[1]), at: answered.length, body });
        return { ok: true, data: { ok: true, state: "done" } };
      }
      return { ok: false, status: 404, error: "no" };
    },
  } as unknown as HubClient;
  const swaps = {
    cancelOffer: async (offerId: number) => {
      started.push(offerId);
      await new Promise<void>((resolve) => gates.set(offerId, resolve));
      return { ok: true, cancelled: true };
    },
  };
  const r = new RequestRunner({ db: () => db, hub, swaps: swaps as never, communism: {} as never, pool: () => null, log: () => {} });
  return { r, answered, started, open: (id: number) => gates.get(id)?.(), gated: (id: number) => gates.has(id) };
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(ok()).toBe(true);
};

describe("RequestRunner lanes", () => {
  afterEach(() => registerAdvancedSettings(null));

  it("advanced management off: every request waits for the one before it, as before", async () => {
    const t = laneRunner([reqOf(1, "offer-cancel", 1), reqOf(3, "withdraw", 2, { server: null, refs: null })]);
    const poll = t.r.pollRequests();
    await until(() => t.gated(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.answered).toEqual([]);
    t.open(1);
    expect(await poll).toBe(2);
    expect(t.answered.map((a) => a.id)).toEqual([1, 3]);
  });

  it("advanced management on for communism: one person's requests run in order; another person's do not wait for them", async () => {
    registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, communism: true }));
    // Two owner requests (one lane, in order) and a hub user's withdraw with no server (answered at once).
    const t = laneRunner([reqOf(1, "offer-cancel", 1), reqOf(2, "offer-cancel", 1), reqOf(3, "withdraw", 2, { server: null, refs: null })]);
    const poll = t.r.pollRequests();
    await until(() => t.answered.some((a) => a.id === 3));
    // The second owner request has not started while the first is still running.
    expect(t.started).toEqual([1]);
    expect(t.answered.map((a) => a.id)).toEqual([3]);
    t.open(1);
    await until(() => t.gated(2));
    expect(t.started).toEqual([1, 2]);
    t.open(2);
    expect(await poll).toBe(3);
    expect(t.answered.map((a) => a.id)).toEqual([3, 1, 2]);
  });
});

describe("RequestRunner progress", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-"));
    vi.stubEnv("DATA_DIR", dir);
    vi.stubEnv("MAX_OPEN_WITHDRAWS", "0");
    db.close();
    db = openDatabase(":memory:");
  });
  afterEach(() => {
    registerAdvancedSettings(null);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const A = "bot-guid-aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bot-guid-bbbbbbbbbbbbbbbbbbbbbbbbbb";
  const inst = (instanceId: string, itemId: string) => ({ instanceId, itemId, enchantments: [], capturedAt: 1 });
  const pool = (): PyrelayPool => ({
    ok: true,
    bots: { [A]: { pdef: 2 }, [B]: { pdef: 1 } },
    capacities: { [A]: 8, [B]: 8 },
    instances: { [A]: { 4: inst("a-1", "pdef"), 5: inst("a-2", "pdef") }, [B]: { 4: inst("b-1", "pdef") } },
    botMeta: { [A]: { ign: "Alpha", server: "", online: false, seasonal: true, communism: true }, [B]: { ign: "Bravo", server: "", online: false, seasonal: true, communism: true } },
  });
  let published = 0;
  function progressRunner() {
    const reports: { id: number; body: { ok: boolean; pending?: boolean; detail?: string; error?: string; botIgn?: string } }[] = [];
    const hub = {
      linked: true,
      signed: async (method: string, pathq: string, body: unknown) => {
        const m = /^\/api\/v1\/guest-requests\/(\d+)\/result$/.exec(pathq);
        if (method === "POST" && m) {
          reports.push({ id: Number(m[1]), body: body as (typeof reports)[number]["body"] });
          return { ok: true, data: { ok: true, state: "taken" } };
        }
        return { ok: true, data: { requests: [] } };
      },
    } as unknown as HubClient;
    const r = new RequestRunner({ db: () => db, hub, swaps: {} as never, communism: { items: () => [], schedulePublish: () => published++ } as never, pool, log: () => {} });
    return { r, reports };
  }

  it("names the bot of the trade under way or next, never one that is done; one report runs at a time", async () => {
    for (const [g, ign] of [[A, "Alpha"], [B, "Bravo"]] as const) presence.report({ botGuid: g, alias: ign, ign, server: "USEast", freeSlots: 8, status: "idle", seasonal: true, communism: true });
    const t = progressRunner();
    registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, communism: true }));
    // Three copies: two off Alpha, one off Bravo, as two trades in one group.
    const res = await t.r.execute(reqOf(41, "withdraw", 5, { ign: "Gwen", server: "USEast", seasonal: true, refs: null, want: [{ itemId: "pdef", qty: 3, slotsMin: 0, slotsExact: 0, enchants: [] }] }));
    expect(res).toMatchObject({ ok: true, pending: true, detail: expect.stringContaining("3× Potion of Defense") });
    expect(res.detail).toContain("in 2 trades");
    // Two reports asked for at once make one round each, never the same word twice.
    await Promise.all([t.r.progress(), t.r.progress()]);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0].body).toMatchObject({ ok: true, pending: true, botIgn: "Alpha", detail: expect.stringContaining("(trade 1 of 2)") });
    // Alpha's trade done: Bravo is the one to /trade now.
    db.prepare("UPDATE withdraw_requests SET status = 'fulfilled' WHERE target_bot_guid = ?").run(A);
    await t.r.progress();
    expect(t.reports[1].body).toMatchObject({ botIgn: "Bravo", detail: expect.stringContaining("Bravo is on the way (trade 2 of 2)") });
    db.prepare("UPDATE withdraw_requests SET status = 'fulfilled'").run();
    await t.r.progress();
    expect(t.reports[2].body).toMatchObject({ ok: true, detail: "done: traded with Alpha, Bravo", botIgn: "Bravo" });
    expect(t.reports[2].body.pending).toBeUndefined();
  });

  it("a first answer the hub never got is not sent once a later note went through", async () => {
    for (const [g, ign] of [[A, "Alpha"], [B, "Bravo"]] as const) presence.report({ botGuid: g, alias: ign, ign, server: "USEast", freeSlots: 8, status: "idle", seasonal: true, communism: true });
    const t = progressRunner();
    registerAdvancedSettings(() => ({ ...DEFAULT_ADVANCED, communism: true }));
    const first = await t.r.execute(reqOf(43, "withdraw", 5, { ign: "Gwen", server: "USEast", seasonal: true, refs: null, want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: 0, enchants: [] }] }));
    // Its first answer ("queued") never reached the hub; the progress note naming the bot does.
    db.prepare("INSERT INTO hub_request_results (hub_id, result_json, delivered, at) VALUES (43, ?, 0, ?)").run(JSON.stringify(first), Date.now());
    await t.r.progress();
    expect(t.reports.map((x) => [x.id, x.body.botIgn])).toEqual([[43, "Alpha"]]);
    // The next round does not put the older word back.
    await t.r.pollRequests();
    expect(t.reports).toHaveLength(1);
  });

  it("a withdraw by count is refused while advanced management is off for communism", async () => {
    const t = progressRunner();
    const res = await t.r.execute(reqOf(42, "withdraw", 5, { ign: "Gwen", server: "USEast", seasonal: true, refs: null, want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: 0, enchants: [] }] }));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("item by item") });
  });
});
