// Fleet lifecycle fixes: bad credentials stop retries, an outdated-build kick
// holds the gate, IP bans bench the exit, the direct-IP budget, probe leases,
// stop-during-login charges no proxy, caps follow the exit count, a canary's
// second arrival restarts its hold, suspended accounts' queues stay put.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The scripted client bringUp builds instead of the real one.
type Script = { auth?: { ok: true } | { ok: false; error: { kind: string; [k: string]: unknown } }; onAuth?: (c: FakeGameClient) => void; connect?: boolean };
let script: Script = {};
const built: FakeGameClient[] = [];
class FakeGameClient extends EventEmitter {
  active = true;
  proxy: unknown;
  server = "USSouth3";
  charSeasonal = null;
  charHasBackpack = null;
  knownBackpack = false;
  token = "";
  authCalls = 0;
  constructor(cfg: { proxy?: unknown }) {
    super();
    this.proxy = cfg.proxy ?? null;
    built.push(this);
  }
  async authenticate() {
    this.authCalls++;
    script.onAuth?.(this);
    return script.auth ?? { ok: true };
  }
  async connect() {
    return script.connect ?? true;
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.emit("stopped");
  }
}
vi.mock("../../client/gameClient", () => ({ GameClient: FakeGameClient }));

const { bringUp } = await import("../bringUp");
const { BotPool } = await import("../botPool");
const { LoginGate } = await import("../loginGate");
const { ProxyPool, PROXY_BENCH_AFTER_FAILS } = await import("../proxyPool");
const C = await import("../constants");
type FleetDeps = import("../bringUp").FleetDeps;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"));
  fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([{ alias: "A", guid: "a@x", password: "pw" }, { alias: "B", guid: "b@x", password: "pw" }]));
  script = {};
  built.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function deps(proxies = new ProxyPool([], { file: null }), extra: Partial<FleetDeps> = {}): FleetDeps & { logs: string[] } {
  const logs: string[] = [];
  return { pool: BotPool.at(dir), proxies, gate: new LoginGate(), clients: new Map(), log: (l) => logs.push(l), buildVersion: "7.0.0.2.0", logs, ...extra };
}
const twoHosts = () => new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }, { host: "2.2.2.2", port: 1080, type: 5, username: "", password: "" }], { file: null });

describe("bad credentials", () => {
  it("lock the account until corrected: the next wake never reaches Realm", async () => {
    const d = deps();
    const acc = d.pool.all()[0];
    script = { auth: { ok: false, error: { kind: "bad-credentials" } } };
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ message: "bad credentials" });
    expect(d.gate.hasBadCredentials(acc.guid)).toBe(true);
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBeGreaterThan(24 * 3600 * 1000);
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ verdict: "locked" });
    expect(built).toHaveLength(1); // no second authenticate
    expect(acc.lastLoginError?.kind).toBe("bad-credentials"); // the console's attention line
    d.gate.unlock(acc.guid); // what a credentials correction does
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBe(0);
  });
});

describe("failures after login", () => {
  it("an s.update_client kick holds every login until the feed moves", async () => {
    const d = deps();
    const c = await bringUp(d, d.pool.all()[0], "USSouth3");
    c.emit("failure", { kind: "update-client" });
    expect(d.gate.holdReason).toMatch(/^Realm build 7\.0\.0\.2\.0 was refused/);
    expect(d.gate.pausedRemainingMs()).toBeGreaterThan(0);
    await expect(bringUp(d, d.pool.all()[1], "USSouth3")).rejects.toMatchObject({ verdict: "paused" });
  });
  it("an IP ban benches the exit for good, even when it is the only free host", async () => {
    const proxies = twoHosts();
    const d = deps(proxies);
    const [a, b] = d.pool.all();
    const c = await bringUp(d, a, "USSouth3");
    const banned = (c.proxy as { host: string }).host;
    c.emit("failure", { kind: "ip-ban", proxyHost: banned });
    c.stop();
    // Bench the other host too: a fully benched pool still hands out a host, but never the banned one.
    const other = banned === "1.1.1.1" ? "2.2.2.2" : "1.1.1.1";
    for (let i = 0; i < PROXY_BENCH_AFTER_FAILS; i++) proxies.noteResult(other, false);
    expect(proxies.claim(b.guid)?.host).toBe(other);
    proxies.release(b.guid);
    proxies.claim("someone-else");
    expect(proxies.claim(b.guid)).toBeNull();
  });
});

describe("this computer's own IP", () => {
  it("carries DIRECT_ONLINE_BOTS accounts at most, whoever brings them up", async () => {
    const d = deps();
    const [a, b] = d.pool.all();
    await bringUp(d, a, "USSouth3");
    await expect(bringUp(d, b, "USSouth3")).rejects.toMatchObject({ busy: true, message: expect.stringMatching(/own IP|IP already/) });
    d.clients.get(a.guid)!.stop();
    await expect(bringUp(d, b, "USSouth3")).resolves.toBeTruthy();
  });
});

describe("a client stopped while it logs in", () => {
  it("charges nothing to its proxy", async () => {
    const proxies = twoHosts();
    const d = deps(proxies);
    script = { onAuth: (c) => c.stop() };
    for (let i = 0; i < PROXY_BENCH_AFTER_FAILS + 1; i++) await expect(bringUp(d, d.pool.all()[0], "USSouth3")).rejects.toMatchObject({ message: "stopped during login" });
    expect(proxies.healthReport().every((h) => h.fail === 0 && !h.benched)).toBe(true);
    expect(d.clients.size).toBe(0);
    expect(proxies.occupiedCount()).toBe(0);
  });
});

describe("probe leases", () => {
  it("hold a host while an HTTP call goes out, so no other account logs in or probes through it", () => {
    const proxies = new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }], { file: null });
    expect(proxies.leaseProbe("reader")?.host).toBe("1.1.1.1");
    expect(proxies.claim("bot")).toBeNull();
    expect(proxies.probeFor("other")).toBeNull();
    expect(proxies.probeFor("reader")?.host).toBe("1.1.1.1"); // its own lease
    proxies.releaseProbe("reader");
    expect(proxies.claim("bot")?.host).toBe("1.1.1.1");
  });
  it("lapse on their own when nobody gives them back", async () => {
    const proxies = new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }], { file: null });
    proxies.leaseProbe("reader", 20);
    expect(proxies.claim("bot")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(proxies.claim("bot")?.host).toBe("1.1.1.1");
  });
  it("probeWhenFree leases what it returns", async () => {
    const proxies = new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }], { file: null });
    expect((await proxies.probeWhenFree("reader", Date.now() + 100))?.host).toBe("1.1.1.1");
    expect(await proxies.probeWhenFree("other", Date.now() + 100)).toBeNull();
  });
});

describe("exits by port", () => {
  it("count one host on several ports once, unless the list is a gateway's (PROXY_EXIT_PER_PORT)", () => {
    const list = [
      { host: "gw", port: 1001, type: 5 as const, username: "", password: "" },
      { host: "gw", port: 1002, type: 5 as const, username: "", password: "" },
      { host: "gw", port: 1002, type: 5 as const, username: "", password: "" },
    ];
    expect(new ProxyPool(list, { file: null }).exclusiveCapacity()).toBe(1);
    vi.stubEnv("PROXY_EXIT_PER_PORT", "1");
    try {
      const pool = new ProxyPool(list, { file: null });
      expect(pool.exclusiveCapacity()).toBe(2);
      const a = pool.claim("a")!;
      const b = pool.claim("b")!;
      expect(new Set([a.port, b.port])).toEqual(new Set([1001, 1002]));
      pool.noteResult(pool.keyOf(a), false);
      expect(pool.healthReport().find((h) => h.host === `gw:${a.port}`)?.fail).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("caps that follow the exit count", () => {
  it("wakes per pass and consolidation pairs scale with the enabled proxy hosts", () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 1080, type: 5 as const, username: "", password: "" }));
    new ProxyPool(hosts(40), { file: null });
    expect(C.MAX_WAKES_PER_TICK).toBe(40);
    expect(C.CONSOLIDATION_MAX_CONCURRENT).toBe(20);
    const pool = new ProxyPool(hosts(6), { file: null });
    expect(C.MAX_WAKES_PER_TICK).toBe(6);
    pool.setEnabled("10.0.0.1", false);
    expect(C.MAX_WAKES_PER_TICK).toBe(5);
    new ProxyPool([], { file: null });
    expect(C.MAX_WAKES_PER_TICK).toBe(C.DIRECT_ONLINE_BOTS);
  });
});
