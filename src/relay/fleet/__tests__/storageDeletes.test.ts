// Character deletes queued from the console: several at once go in one visit
// (one borrow, one HTTP login for all), each can be taken back until its turn,
// and each says how it went. Realm's HTTP calls and the borrow are scripted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharDetail } from "../../realm/api";

const realm = vi.hoisted(() => {
  // A busy account is looked at again every 20 ms here.
  process.env.DELETE_RETRY_S = "0.02";
  return { alive: new Set<number>(), deleted: [] as number[], tokens: 0, gate: null as null | Promise<void> };
});
vi.mock("../../realm/api", async (orig) => {
  const actual = await orig<typeof import("../../realm/api")>();
  const char = (id: number): CharDetail => ({ id, objectType: 782, level: 20, seasonal: false, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [] });
  return {
    ...actual,
    getAccessToken: vi.fn(async () => {
      realm.tokens++;
      return { ok: true, value: "token" };
    }),
    deleteChar: vi.fn(async (_token: string, charId: number) => {
      if (realm.gate) await realm.gate;
      realm.alive.delete(charId);
      realm.deleted.push(charId);
      return { ok: true };
    }),
    getCharListDetail: vi.fn(async () => ({ ok: true, value: { chars: [...realm.alive].sort((a, b) => a - b).map(char), maxNumChars: 10 } })),
  };
});
vi.mock("../borrow", async (orig) => ({ ...(await orig<typeof import("../borrow")>()), borrowAccount: vi.fn(async () => ({ ok: true, giveBack: () => {} })) }));

import { StorageService, StorageStore } from "../storage";
import { ProxyPool } from "../proxyPool";
import { deleteChar } from "../../realm/api";
import type { BotAccount } from "../botPool";
import type { SweepDeps } from "../sweeps";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-deletes-"));
  realm.alive = new Set([1, 2, 3, 4]);
  realm.deleted = [];
  realm.tokens = 0;
  realm.gate = null;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function service(o: { proxies?: ProxyPool } = {}) {
  const store = new StorageStore(path.join(dir, "storage_state.json"));
  const acc = { alias: "a", guid: "a@x", botGuid: "bot-a", assignedRequestId: null, inUse: false, seasonalOrDefault: false, info: { guid: "a@x", password: "pw" } } as unknown as BotAccount;
  const deps = { log() {}, gate: { pausedRemainingMs: () => 0, lockoutRemainingMs: () => 0 }, proxies: o.proxies ?? { configured: false, releaseProbe() {} }, requireProxy: () => !!o.proxies };
  const sd = { deps, pool: { setPreferredChar() {} }, tracker: { updateFromSlots() {} }, settings: {} } as unknown as SweepDeps;
  const svc = new StorageService({ sd, store, holds: new Set() });
  const st = store.for(acc);
  st.chars = [1, 2, 3, 4].map((id) => ({ id, objectType: 782, level: 20, seasonal: false, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [] }));
  st.loginCharId = 1;
  return { svc, acc, st };
}
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("queued character deletes", () => {
  it("several queued at once go in one visit: one login, one delete after another, each reported", async () => {
    const { svc, acc, st } = service();
    let release!: () => void;
    realm.gate = new Promise<void>((r) => (release = r));
    expect(svc.queueDelete(acc, 2)).toEqual({ ok: true, queue: [2] });
    // Queued while the first is under way: they wait behind it and ride along in the same visit.
    await until(() => svc.characterJobsFor(acc).deleting === 2);
    expect(svc.queueDelete(acc, 3)).toEqual({ ok: true, queue: [2, 3] });
    expect(svc.queueDelete(acc, 4)).toEqual({ ok: true, queue: [2, 3, 4] });
    expect(svc.queueDelete(acc, 3)).toEqual({ ok: true, queue: [2, 3, 4] });
    release();
    realm.gate = null;
    await until(() => svc.characterJobsFor(acc).deleteQueue.length === 0 && svc.characterJobsFor(acc).deleting === null);
    expect(realm.deleted).toEqual([2, 3, 4]);
    expect(realm.tokens).toBe(1);
    expect(st.chars!.map((c) => c.id)).toEqual([1]);
    const jobs = svc.characterJobsFor(acc);
    expect(jobs.recent.map((j) => [j.charId, j.ok])).toEqual([[4, true], [3, true], [2, true]]);
    expect(jobs.last).toMatchObject({ charId: 4, ok: true });
  });

  it("a queued delete can be taken back before its turn; the one under way cannot", async () => {
    const { svc, acc } = service();
    let release!: () => void;
    realm.gate = new Promise<void>((r) => (release = r));
    svc.queueDelete(acc, 2);
    svc.queueDelete(acc, 3);
    svc.queueDelete(acc, 4);
    await until(() => svc.characterJobsFor(acc).deleting === 2);
    expect(svc.unqueueDelete(acc, 2)).toEqual({ ok: false, error: "character #2 is being deleted right now" });
    expect(svc.unqueueDelete(acc, 3)).toEqual({ ok: true, queue: [2, 4] });
    expect(svc.unqueueDelete(acc, 3)).toEqual({ ok: false, error: "character #3 is not queued for deletion" });
    release();
    realm.gate = null;
    await until(() => svc.characterJobsFor(acc).deleteQueue.length === 0 && svc.characterJobsFor(acc).deleting === null);
    expect(realm.deleted).toEqual([2, 4]);
    expect(realm.alive.has(3)).toBe(true);
  });

  it("a busy account is waited for as long as it stays busy, saying why; the queue can be taken back meanwhile", async () => {
    const { svc, acc } = service();
    (acc as { assignedRequestId: number | null }).assignedRequestId = 7; // in a trade
    svc.queueDelete(acc, 2);
    svc.queueDelete(acc, 3);
    await until(() => svc.characterJobsFor(acc).deleteWaiting !== null);
    expect(svc.characterJobsFor(acc)).toMatchObject({ deleteQueue: [2, 3], deleteWaiting: "the account is busy" });
    await new Promise((r) => setTimeout(r, 150));
    // Still queued, nothing failed.
    expect(svc.characterJobsFor(acc)).toMatchObject({ deleteQueue: [2, 3], recent: [] });
    expect(svc.unqueueDelete(acc, 3)).toEqual({ ok: true, queue: [2] });
    (acc as { assignedRequestId: number | null }).assignedRequestId = null; // the trade is over
    await until(() => svc.characterJobsFor(acc).deleteQueue.length === 0 && svc.characterJobsFor(acc).deleting === null);
    expect(realm.deleted).toEqual([2]);
    expect(svc.characterJobsFor(acc)).toMatchObject({ deleteWaiting: null, last: { charId: 2, ok: true } });
  });

  it("refuses a character the account does not have", () => {
    const { svc, acc } = service();
    expect(svc.queueDelete(acc, 9)).toEqual({ ok: false, error: "no character #9 on this account" });
  });
});

describe("after a restart", () => {
  it("deletes still in the saved queue are picked up again", async () => {
    const { svc, acc, st } = service();
    st.deleteQueue = [3, 4];
    expect(svc.resumeQueuedJobs([acc])).toBe(1);
    await until(() => svc.characterJobsFor(acc).deleteQueue.length === 0 && svc.characterJobsFor(acc).deleting === null);
    expect(realm.deleted).toEqual([3, 4]);
    expect(realm.tokens).toBe(1);
  });  it("a suspended account's queue stays saved and is not a login to try", () => {
    const { svc, acc, st } = service();
    st.deleteQueue = [3];
    (acc as { suspended: boolean }).suspended = true;
    expect(svc.resumeQueuedJobs([acc])).toBe(0);
    expect(st.deleteQueue).toEqual([3]);
    expect(realm.tokens).toBe(0);
  });
});

describe("with every proxy host carrying a bot", () => {
  const listed = () => new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }], { file: null });
  it("a queued delete waits for a host to come free, then goes through it", async () => {
    const proxies = listed();
    proxies.claim("someone@x");
    const { svc, acc } = service({ proxies });
    svc.queueDelete(acc, 2);
    await new Promise((r) => setTimeout(r, 300));
    // Neither failed ("no proxy") nor made from this computer: still waiting.
    expect(realm.tokens).toBe(0);
    expect(svc.characterJobsFor(acc).deleteQueue).toEqual([2]);
    expect(svc.activityOf(acc.guid)).toMatch(/waiting for a free proxy/);
    proxies.release("someone@x");
    await until(() => svc.characterJobsFor(acc).deleteQueue.length === 0 && svc.characterJobsFor(acc).deleting === null);
    expect(realm.deleted).toEqual([2]);
    expect(vi.mocked(deleteChar)).toHaveBeenLastCalledWith("token", 2, expect.objectContaining({ host: "1.1.1.1" }));
  });

  it("a snapshot read gives up saying why when no host will come free, and never asks Realm without one", async () => {
    const proxies = listed();
    proxies.setAllEnabled(false);
    const { svc, acc, st } = service({ proxies });
    expect(await svc.read(acc, "test")).toBe("failed");
    expect(realm.tokens).toBe(0);
    expect(st.lastError).toBe("no free proxy: every proxy host is switched off");
  });
});
