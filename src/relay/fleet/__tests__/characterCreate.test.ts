// New characters: Realm lets an account make one only every 30 seconds, so
// the node waits out that cooldown between two on one account, and several
// asked for at once are queued and made one at a time (a login each).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharDetail, CharListDetail } from "../../realm/api";

// A busy account is looked at again every 20 ms here.
vi.hoisted(() => {
  process.env.DELETE_RETRY_S = "0.02";
});

/** The char list Realm would answer with: the characters made so far. */
const made: CharDetail[] = [];
const charDetail = (id: number, seasonal: boolean): CharDetail => ({ id, objectType: 782, level: 1, seasonal, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [] });
vi.mock("../../realm/api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../realm/api")>();
  return { ...orig, getCharListDetail: vi.fn(async () => ({ ok: true, value: { nextCharId: made.length + 2, maxNumChars: 4, chars: [...made] } satisfies CharListDetail })) };
});

import { StorageService, StorageStore } from "../storage";
import { BringUpRefused } from "../bringUp";
import { LoginGate } from "../loginGate";
import { NEXUS_MAP } from "../vaultTrip";
import type { BotAccount } from "../botPool";
import type { SweepDeps } from "../sweeps";
import type { GameClient } from "../../client/gameClient";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "char-create-"));
  made.length = 0;
  made.push(charDetail(1, false));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** One account with 4 character slots and 1 character, a fleet whose logins land in the Nexus at once, and the times each login began. */
function setup(o: { cooldownMs: number; refuse?: () => Error | null }) {
  const store = new StorageStore(path.join(dir, "storage_state.json"));
  const acc = { alias: "A", guid: "a@x", botGuid: "bot-a", info: { guid: "a@x", server: "USSouth3" }, seasonal: false, seasonalOrDefault: false, suspended: false, assignedRequestId: null, inUse: false, client: null } as unknown as BotAccount;
  const st = store.for(acc);
  st.maxNumChars = 4;
  st.chars = [...made];
  // The login gate's own clock runs fast: the grace after each session is over by the next login.
  let g = 1_000_000;
  const clients = new Map<string, GameClient>();
  const logins: { at: number; seasonal: boolean }[] = [];
  const deps = {
    pool: {}, proxies: { release() {}, releaseProbe() {} }, gate: new LoginGate(() => (g += 60_000)), buildVersion: "7", clients, log: () => {},
    bringUp: async (_d: unknown, a: BotAccount, _s: string, opts?: { createSeasonal?: boolean; createForce?: boolean }) => {
      logins.push({ at: Date.now(), seasonal: !!opts?.createSeasonal });
      const refused = o.refuse?.();
      if (refused) throw refused;
      const id = made.length + 1;
      made.push(charDetail(id, !!opts?.createSeasonal));
      const c = { active: true, connected: true, objectId: 5, mapName: NEXUS_MAP, charId: id, token: "t", proxy: null, playerData: { name: "Ign" }, stop: () => {}, on() {} };
      c.stop = () => { c.active = false; };
      clients.set(a.guid, c as unknown as GameClient);
      return c as unknown as GameClient;
    },
  };
  const sd = { deps, pool: { every: () => [acc] }, tracker: {}, settings: {} } as unknown as SweepDeps;
  const svc = new StorageService({ sd, store, holds: new Set(), createCooldownMs: o.cooldownMs });
  return { svc, acc, st, logins };
}

/** Until the account's queue is empty and nothing is being made. */
async function drained(svc: StorageService, acc: BotAccount, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const j = svc.characterJobsFor(acc);
    if (!j.createQueue.length && j.creating === null) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the queue did not drain");
}

describe("new characters", () => {
  it("are queued and made one at a time, a login each, the cooldown apart; no more than the empty slots", async () => {
    const { svc, acc, st, logins } = setup({ cooldownMs: 300 });
    expect(svc.queueCreate(acc, true, 0)).toEqual({ ok: false, error: "how many: at least 1" });
    expect(svc.queueCreate(acc, true, 4)).toEqual({ ok: false, error: "only 3 empty slots left for new characters" });
    expect(svc.queueCreate(acc, true, 2)).toMatchObject({ ok: true });
    // Asked again while those are on the way: they hold their slots.
    expect(svc.queueCreate(acc, false, 2)).toEqual({ ok: false, error: "only 1 empty slot left for new characters" });
    expect(svc.queueCreate(acc, false, 1)).toMatchObject({ ok: true });
    expect(svc.queueCreate(acc, false, 1)).toEqual({ ok: false, error: "every empty slot already has a new character on the way (3)" });
    await drained(svc, acc);

    expect(logins.map((l) => l.seasonal)).toEqual([true, true, false]);
    for (let i = 1; i < logins.length; i++) expect(logins[i].at - logins[i - 1].at).toBeGreaterThanOrEqual(290);
    expect(st.chars?.filter((c) => !c.dead)).toHaveLength(4);
    expect(st.lastCreatedAt).toEqual(expect.any(Number));
    const jobs = svc.characterJobsFor(acc);
    expect(jobs.recent.map((j) => [j.kind, j.ok, j.charId])).toEqual([["create", true, 4], ["create", true, 3], ["create", true, 2]]);
    expect(jobs.recent[0].summary).toBe("new non-seasonal character #4 made; 4 of 4 slots hold one");
    expect(svc.queueCreate(acc, true, 1)).toEqual({ ok: false, error: "every character slot is taken (4 of 4)" });
  });

  it("wait out what is left of the cooldown since the account's last one, and can be taken back while they wait", async () => {
    const { svc, acc, st, logins } = setup({ cooldownMs: 700 });
    st.lastCreatedAt = Date.now() - 100;
    expect(svc.createCooldownLeft(acc)).toBeGreaterThan(500);
    expect(svc.queueCreate(acc, false, 3)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 100));
    // The first has left the queue and waits on the cooldown; the card sees when the next can go.
    const waiting = svc.characterJobsFor(acc);
    expect(waiting).toMatchObject({ creating: false, createQueue: [false, false], createCooldownS: 1 });
    expect(waiting.nextCreateAt).toBeGreaterThan(Date.now());
    expect(logins).toHaveLength(0);
    expect(svc.unqueueCreates(acc)).toEqual({ ok: true, dropped: 2 });
    await drained(svc, acc);
    // Only the one already on its way was made, and not before the cooldown was over.
    expect(logins).toHaveLength(1);
    expect(st.chars?.filter((c) => !c.dead)).toHaveLength(2);
  });

  it("wait for a busy account as long as it stays busy, or for a free proxy host, and cancel takes back the one waiting", async () => {
    let full = 3;
    const { svc, acc, st, logins } = setup({ cooldownMs: 10, refuse: () => (full-- > 0 ? new BringUpRefused("failed", "no free proxy", true) : null) });
    (acc as { assignedRequestId: number | null }).assignedRequestId = 7; // in a trade
    expect(svc.queueCreate(acc, true, 2)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(svc.characterJobsFor(acc)).toMatchObject({ creating: true, createWaiting: "the account is busy", createQueue: [true], recent: [] });
    expect(logins).toHaveLength(0);
    // Free again, but every proxy host carries a bot for three tries: still waiting, not failed.
    (acc as { assignedRequestId: number | null }).assignedRequestId = null;
    await drained(svc, acc);
    expect(logins).toHaveLength(5);
    expect(st.chars?.filter((c) => !c.dead)).toHaveLength(3);
    expect(svc.characterJobsFor(acc).recent.map((j) => j.ok)).toEqual([true, true]);

    // Taken back while it waits for the account: never made, nothing failed.
    (acc as { assignedRequestId: number | null }).assignedRequestId = 8;
    expect(svc.queueCreate(acc, false, 1)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.characterJobsFor(acc).createWaiting).toBe("the account is busy");
    expect(svc.unqueueCreates(acc)).toEqual({ ok: true, dropped: 1 });
    await drained(svc, acc);
    expect(logins).toHaveLength(5);
    expect(svc.characterJobsFor(acc).recent).toHaveLength(2);
  });

  it("a failure that another try would not fix takes the rest of the queue with it, saying why", async () => {
    const { svc, acc, logins } = setup({ cooldownMs: 50, refuse: () => new BringUpRefused("failed", "socket connect failed") });
    expect(svc.queueCreate(acc, true, 3)).toMatchObject({ ok: true });
    await drained(svc, acc);
    expect(logins).toHaveLength(1);
    expect(svc.characterJobsFor(acc).recent.map((j) => [j.ok, j.summary])).toEqual([
      [false, "2 more new characters not made: bring-up failed: socket connect failed"],
      [false, "new seasonal character not made: bring-up failed: socket connect failed"],
    ]);
  });
});
