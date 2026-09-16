import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("CANARY_HOLD_SECONDS", "0.05");
vi.stubEnv("CANARY_CONNECT_SECONDS", "0.3");

const { BuildGate } = await import("../buildGate");
const { BotPool } = await import("../botPool");
const { LoginGate } = await import("../loginGate");
const { ProxyPool } = await import("../proxyPool");
const { GameVersion } = await import("../../realm/gameVersion");
const { NodeSettingsStore } = await import("../../../node/settings");
type FleetDeps = import("../bringUp").FleetDeps;
type GameClient = import("../../client/gameClient").GameClient;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildgate-"));
  fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([{ alias: "Canary", guid: "c@x", password: "pw", seasonal: true }]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

class FakeClient extends EventEmitter {
  objectId = -1;
  playerData = { name: "CanaryIgn" };
  stopped = false;
  stop() { this.stopped = true; this.emit("stopped"); }
}

function setup(build: string, script: (c: FakeClient) => void, opts: { refuse?: boolean } = {}) {
  const pool = BotPool.at(dir);
  const gate = new LoginGate();
  const clients = new Map<string, GameClient>();
  const log: string[] = [];
  const versions = new GameVersion({ seed: build, url: null, log: () => {} });
  const deps: FleetDeps = {
    pool, gate, clients, log: (l) => log.push(l), proxies: ProxyPool.fromSource({ url: null, file: path.join(dir, "none.txt") }), buildVersion: build,
    bringUp: async (d, acc) => {
      if (opts.refuse) throw new Error("no");
      const c = new FakeClient();
      d.clients.set(acc.guid, c as unknown as GameClient);
      setTimeout(() => script(c), 10);
      return c as unknown as GameClient;
    },
  };
  const settings = NodeSettingsStore.at(dir);
  const bg = new BuildGate({ versions, deps, pool, settings, log: (l) => log.push(l), compiled: ["7.0.0.2.0"] });
  return { bg, gate, versions, settings, log, clients };
}

describe("BuildGate", () => {
  it("lets a compiled-in build through and holds an unknown one", () => {
    const known = setup("7.0.0.2.0", () => {});
    known.bg.start();
    expect(known.gate.holdReason).toBeNull();
    const unknown = setup("7.0.0.3.0", () => {});
    unknown.bg.start();
    expect(unknown.gate.holdReason).toMatch(/7\.0\.0\.3\.0/);
    expect(unknown.gate.pausedRemainingMs()).toBeGreaterThan(0);
    expect(unknown.gate.ratePauseRemainingMs()).toBe(0);
    expect(unknown.bg.status()).toMatchObject({ build: "7.0.0.3.0", known: false, held: true });
  });

  it("a canary that reaches the world and holds it records the build and releases the gate", async () => {
    const t = setup("7.0.0.3.0", (c) => { c.objectId = 5; c.emit("inWorld", 5); });
    t.bg.start();
    const r = await t.bg.canary();
    expect(r).toMatchObject({ ok: true, build: "7.0.0.3.0", ign: "CanaryIgn" });
    expect(t.gate.holdReason).toBeNull();
    expect(t.settings.get().knownBuilds).toEqual(["7.0.0.3.0"]);
    expect(t.clients.size).toBe(0);
    // A fresh gate on the same data dir knows the build now.
    const again = setup("7.0.0.3.0", () => {});
    again.bg.start();
    expect(again.gate.holdReason).toBeNull();
  });

  it("a canary kicked with FAILURE leaves the hold on", async () => {
    const t = setup("7.0.0.4.0", (c) => { c.objectId = 5; c.emit("inWorld", 5); setTimeout(() => c.emit("failure", { kind: "other", errorId: 0, description: "bad message" }), 5); });
    t.bg.start();
    const r = await t.bg.canary();
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/bad message/);
    expect(t.gate.holdReason).not.toBeNull();
    expect(t.settings.get().knownBuilds).toEqual([]);
  });

  it("a canary that never reaches the world times out; a refused login reports why", async () => {
    const t = setup("7.0.0.5.0", () => {});
    t.bg.start();
    expect(await t.bg.canary()).toMatchObject({ ok: false, reason: expect.stringMatching(/not in world/) });
    const r = setup("7.0.0.5.0", () => {}, { refuse: true });
    r.bg.start();
    expect(await r.bg.canary()).toMatchObject({ ok: false, reason: expect.stringMatching(/login refused/) });
  });

  it("trust records the build without a login, and a feed change re-holds", () => {
    const t = setup("7.0.0.6.0", () => {});
    t.bg.start();
    expect(t.gate.holdReason).not.toBeNull();
    t.bg.trust();
    expect(t.gate.holdReason).toBeNull();
    expect(t.bg.status().knownBuilds).toContain("7.0.0.6.0");
  });
});
