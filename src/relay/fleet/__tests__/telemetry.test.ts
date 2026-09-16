import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Telemetry } from "../telemetry";
import { BotPool } from "../botPool";
import { InventoryTracker } from "../inventoryTracker";
import { GameVersion } from "../../realm/gameVersion";
import { NodeSettingsStore } from "../../../node/settings";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-"));
  fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([
    { alias: "Old", guid: "old@x", password: "pw", seasonal: true, suspended: true },
    { alias: "Fresh", guid: "fresh@x", password: "pw", seasonal: false },
  ]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(posts: { url: string; body: unknown }[], fail = false) {
  const pool = BotPool.at(dir);
  const tracker = InventoryTracker.at(dir);
  const settings = NodeSettingsStore.at(dir);
  const t = new Telemetry({
    settings, pool, tracker, versions: new GameVersion({ seed: "7.0.0.2.0", url: null, log: () => {} }), nodeVersion: "0.1.0", log: () => {},
    now: () => 123_000,
    fetchImpl: (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(fail ? "no" : "{}", { status: fail ? 500 : 200 });
    }) as typeof fetch,
  });
  return { t, pool, tracker, settings };
}

describe("Telemetry", () => {
  it("notes only new suspensions, and sends nothing while off", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const { t, pool } = setup(posts);
    expect(t.tick()).toEqual([]);
    pool.markSuspended("fresh@x");
    const fresh = t.tick();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ suspendedAt: 123_000, lastLane: "unknown", heldItems: 0, seasonal: false, nodeVersion: "0.1.0", build: "7.0.0.2.0" });
    expect(fresh[0].account).not.toContain("fresh");
    expect(t.tick()).toEqual([]);
    expect(await t.flush()).toBe(0);
    expect(posts).toEqual([]);
    expect(t.status()).toMatchObject({ enabled: false, queued: 1, sent: 0 });
  });

  it("posts the queue to the hub once enabled, and keeps it on failure", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const { t, pool } = setup(posts);
    pool.markSuspended("fresh@x");
    t.setEnabled(true, "https://hub.example/");
    expect(await t.flush()).toBe(1);
    expect(posts[0].url).toBe("https://hub.example/api/v1/telemetry/bans");
    expect((posts[0].body as { reports: unknown[] }).reports).toHaveLength(1);
    expect(t.status()).toMatchObject({ enabled: true, queued: 0, sent: 1, lastFlushAt: 123_000 });

    const failing: { url: string; body: unknown }[] = [];
    fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([{ alias: "Fresh", guid: "fresh@x", password: "pw" }]));
    const f = setup(failing, true);
    f.pool.markSuspended("fresh@x");
    f.t.setEnabled(true, "https://hub.example");
    expect(await f.t.flush()).toBe(0);
    expect(f.t.status()).toMatchObject({ queued: 1, sent: 0, lastError: "HTTP 500" });
  });

  it("hashes with the node's own salt, so two nodes never agree on an account", () => {
    const a = setup([]);
    const salted = a.t.hashAccount("someone@x");
    a.settings.update((s) => { s.telemetry.salt = "other"; });
    expect(a.t.hashAccount("someone@x")).not.toBe(salted);
    expect(a.t.hashAccount("SOMEONE@x")).toBe(a.t.hashAccount("someone@x"));
  });
});
