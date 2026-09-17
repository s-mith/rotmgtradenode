// Shared vaults on the node: grants become local users with quotas, guest
// vaults get published, and guest requests run against the queue and the
// swap coordinator, all against a scripted hub and a scripted fleet view.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../lib/db";
import * as q from "../../lib/queue";
import { presence } from "../../lib/fleetPresence";
import { registerEmbeddedPool, type PyrelayPool } from "../../lib/devauth";
import { vaultHalf, vaultItems } from "../../lib/vault";
import { GuestCoordinator } from "../guests";
import { SwapCoordinator } from "../swaps";
import type { HubClient } from "../hub";
import type { GrantWire, GuestRequestWire } from "../../shared/hubWire";

let dir: string;
let db: ReturnType<typeof openDatabase>;
const BOT = "bot-guid-2222222222222222222222";
function pool(): PyrelayPool {
  const inst = (instanceId: string, itemId: string, enchantments: number[] = []) => ({ instanceId, itemId, enchantments, capturedAt: 1 });
  return {
    ok: true, bots: { [BOT]: { pdef: 1, patk: 1, ubatk: 1 } }, capacities: { [BOT]: 8 },
    instances: { [BOT]: { 4: inst("i-owner-pdef", "pdef"), 5: inst("i-guest-patk", "patk"), 6: inst("i-guest-ring", "ubatk", [3]) } },
    botMeta: { [BOT]: { ign: "HostBot", server: "USSouth3", online: true, seasonal: true } },
  };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "guests-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("SHARED_VAULT_BOTS", "1");
  db = openDatabase(":memory:");
  registerEmbeddedPool(pool);
  presence.report({ botGuid: BOT, alias: "H", ign: "HostBot", server: "USSouth3", freeSlots: 5, status: "idle", seasonal: true });
});
afterEach(() => {
  registerEmbeddedPool(undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const grant = (over: Partial<GrantWire> = {}): GrantWire => ({ id: 1, nodeId: "n1", guest: { userId: 77, displayName: "Guest" }, ign: "GuestIgn", slotsSeasonal: 4, slotsNonseasonal: 0, role: "withdraw-own", trade: true, paused: false, createdAt: 1, updatedAt: 1, ...over });

function fakeHub(state: { grants: GrantWire[]; requests: GuestRequestWire[] }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const hub = {
    linked: true,
    signed: async (method: string, p: string, body: unknown = {}) => {
      calls.push({ method, path: p, body });
      if (p === "/api/v1/grants" && method === "GET") return { ok: true, data: { grants: state.grants } };
      if (p === "/api/v1/guest-requests" && method === "GET") { const r = state.requests; state.requests = []; return { ok: true, data: { requests: r } }; }
      if (p.startsWith("/api/v1/guest-requests/") && p.endsWith("/result")) return { ok: true, data: { ok: true, state: "done" } };
      if (p === "/api/v1/vaults/publish") return { ok: true, data: { ok: true } };
      if (p === "/api/v1/offers" && method === "POST") return { ok: true, data: { offer: { id: 9, ...(body as object), status: "open", mine: true, poster: "Guest", createdAt: 1, expiresAt: 2 } } };
      return { ok: false, status: 404, error: `no script for ${method} ${p}` };
    },
  } as unknown as HubClient;
  return { hub, calls };
}

function setup(state: { grants: GrantWire[]; requests: GuestRequestWire[] }) {
  const { hub, calls } = fakeHub(state);
  const log: string[] = [];
  const swaps = new SwapCoordinator({ db: () => db, hub, pool, log: (l) => log.push(l) });
  const g = new GuestCoordinator({ db: () => db, hub, swaps, pool, log: (l) => log.push(l) });
  return { g, swaps, calls, log };
}

/** Put two of the bot's items into the guest's vault, as a finished deposit would. */
function seedGuestVault(localUserId: number) {
  const ins = db.prepare("INSERT INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES (?, ?, ?, ?, 1, ?, 'deposit', 1)");
  ins.run("i-guest-patk", localUserId, "patk", 0, BOT);
  ins.run("i-guest-ring", localUserId, "ubatk", 1, BOT);
}

describe("GuestCoordinator", () => {
  it("mirrors grants into local users with the quota as their vault caps, and revokes to zero", async () => {
    const state = { grants: [grant()], requests: [] as GuestRequestWire[] };
    const { g } = setup(state);
    expect(await g.refreshGrants()).toBe(true);
    const [guest] = g.guests();
    expect(guest).toMatchObject({ hubUserId: 77, ign: "GuestIgn", slotsSeasonal: 4, slotsNonseasonal: 0, role: "withdraw-own", trade: true, usedSeasonal: 0 });
    expect(vaultHalf(db, guest.localUserId, true).slots).toBe(4);
    expect(vaultHalf(db, guest.localUserId, false).slots).toBe(0);
    state.grants = [grant({ slotsSeasonal: 2 })];
    await g.refreshGrants();
    expect(vaultHalf(db, guest.localUserId, true).slots).toBe(2);
    state.grants = [];
    await g.refreshGrants();
    expect(g.guests()).toEqual([]);
    expect(vaultHalf(db, guest.localUserId, true).slots).toBe(0);
  });

  it("publishes each guest's vault with names, enchants and holder state", async () => {
    const state = { grants: [grant()], requests: [] as GuestRequestWire[] };
    const { g, calls } = setup(state);
    await g.refreshGrants();
    seedGuestVault(g.guests()[0].localUserId);
    expect(await g.publish()).toBe(true);
    const pub = calls.find((c) => c.path === "/api/v1/vaults/publish")!.body as { guests: { userId: number; seasonal: { slots: number; used: number; items: { ref: string; name: string; count: number; online: boolean }[] } }[] };
    expect(pub.guests[0].userId).toBe(77);
    expect(pub.guests[0].seasonal).toMatchObject({ slots: 4, used: 2 });
    expect(pub.guests[0].seasonal.items.map((i) => [i.ref, i.name, i.count, i.online])).toEqual([["i-guest-patk", "Potion of Attack", 0, true], ["i-guest-ring", "Ring of Unbound Attack", 1, true]]);
    // Unchanged vaults are not re-sent.
    expect(await g.publish()).toBe(false);
  });

  it("runs guest requests: a deposit over the quota is refused, a withdraw queues a vault row, and results go back", async () => {
    const req = (over: Partial<GuestRequestWire>): GuestRequestWire => ({ id: 1, nodeId: "n1", guest: { userId: 77, displayName: "Guest" }, ign: "GuestIgn", kind: "deposit", seasonal: true, server: "USSouth3", count: 1, refs: null, want: null, offerId: null, state: "taken", createdAt: 1, result: null, ...over });
    const state = { grants: [grant()], requests: [] as GuestRequestWire[] };
    const { g, calls } = setup(state);
    await g.refreshGrants();
    const local = g.guests()[0].localUserId;
    seedGuestVault(local);
    state.requests = [req({ id: 1, kind: "deposit", count: 3 }), req({ id: 2, kind: "deposit", count: 2 }), req({ id: 3, kind: "withdraw", refs: ["i-guest-patk"] })];
    expect(await g.pollRequests()).toBe(3);
    const results = calls.filter((c) => c.path.endsWith("/result")).map((c) => [c.path, c.body]) as [string, { ok: boolean; error?: string }][];
    expect(results[1][1]).toMatchObject({ ok: true });
    expect(results[1][1]).toMatchObject({ ok: true });
    expect(results[2][1]).toMatchObject({ ok: true });
    const pending = q.listPending(db);
    expect(pending.deposits).toHaveLength(1);
    expect(pending.deposits[0]).toMatchObject({ vaultUserId: local, itemCount: 2, seasonal: true });
    expect(pending.withdraws).toHaveLength(1);
    expect(pending.withdraws[0]).toMatchObject({ vaultUserId: local, targetBotGuid: BOT, instanceIds: ["i-guest-patk"] });
    expect(g.status().recent.map((r) => [r.kind, r.ok])).toEqual([["withdraw", true], ["deposit", true], ["deposit", false]]);
  });

  it("a guest's offer gives only their vault items, is posted on their behalf, and the owner's held() excludes them", async () => {
    const state = { grants: [grant()], requests: [] as GuestRequestWire[] };
    const { g, swaps, calls } = setup(state);
    await g.refreshGrants();
    const local = g.guests()[0].localUserId;
    seedGuestVault(local);
    // The owner sees only the pool item; the guest only their vault.
    expect(swaps.held().map((h) => h.instanceId)).toEqual(["i-owner-pdef"]);
    expect(swaps.held(undefined, local).map((h) => h.instanceId).sort()).toEqual(["i-guest-patk", "i-guest-ring"]);
    state.requests = [{ id: 5, nodeId: "n1", guest: { userId: 77, displayName: "Guest" }, ign: "GuestIgn", kind: "offer-create", seasonal: true, server: "USSouth3", count: null, refs: ["i-guest-ring"], want: [{ itemId: "pdef", qty: 1, slotsMin: 0, slotsExact: null, enchants: [] }], offerId: null, state: "taken", createdAt: 1, result: null }];
    await g.pollRequests();
    const posted = calls.find((c) => c.path === "/api/v1/offers")!.body as { onBehalfOf?: number; give: { ref: string; itemId: string }[] };
    expect(posted.onBehalfOf).toBe(77);
    expect(posted.give).toEqual([{ ref: "r1", itemId: "ubatk", enchants: [3], count: 1 }]);
    expect(swaps.status().localOffers[0]).toMatchObject({ offerId: 9, localUserId: local });
    // Asking for more than the guest's half can hold is refused.
    state.requests = [{ id: 6, nodeId: "n1", guest: { userId: 77, displayName: "Guest" }, ign: "GuestIgn", kind: "offer-create", seasonal: true, server: "USSouth3", count: null, refs: ["i-guest-patk"], want: [{ itemId: "pdef", qty: 4, slotsMin: 0, slotsExact: null, enchants: [] }], offerId: null, state: "taken", createdAt: 1, result: null }];
    await g.pollRequests();
    expect(g.status().recent[0]).toMatchObject({ kind: "offer-create", ok: false, detail: expect.stringMatching(/room for/) });
    // A paused guest gets nothing done.
    state.grants = [grant({ paused: true })];
    await g.refreshGrants();
    state.requests = [{ id: 7, nodeId: "n1", guest: { userId: 77, displayName: "Guest" }, ign: "GuestIgn", kind: "deposit", seasonal: true, server: "USSouth3", count: 1, refs: null, want: null, offerId: null, state: "taken", createdAt: 1, result: null }];
    await g.pollRequests();
    expect(g.status().recent[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/paused/) });
    expect(vaultItems(db, local)).toHaveLength(2);
  });
});
