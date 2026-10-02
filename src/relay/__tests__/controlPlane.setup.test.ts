// The first-run setup, the proxy check, own internet, the status facts, the
// diagnostics, waking from sleep and "check again" through the control plane.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fleet, type FleetOptions } from "../fleet/fleet";
import { createControlPlane } from "../controlPlane";
import { BringUpRefused } from "../fleet/bringUp";
import type { BotAccount } from "../fleet/botPool";
import type { GameClient } from "../client/gameClient";
import { fakeSocks, type FakeSocks } from "../net/__tests__/fakeSocks";

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
  vi.unstubAllGlobals();
});

/** Stands in for a game session: in the world (or not) as the test's script says. */
class FakeClient extends EventEmitter {
  active = true;
  connected = true;
  objectId = -1;
  gameIdValue = -2;
  proxy = null;
  playerData = { name: "" };
  constructor(public server: string) {
    super();
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.emit("stopped");
  }
  arrive(name: string) {
    this.playerData.name = name;
    this.objectId = 7;
    this.emit("inWorld", 7);
  }
}

type Script = (c: FakeClient, acc: BotAccount) => void;
interface Opts {
  accounts?: { alias: string; guid: string; password: string }[];
  proxies?: string;
  /** node.json as it is on disk before the fleet starts; undefined: no file. */
  nodeJson?: unknown;
  script?: Script;
  fleet?: Partial<FleetOptions>;
}
const ONE = [{ alias: "BotOne", guid: "bot1@example.com", password: "hunter2pw" }];

function setup(o: Opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-setup-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify((o.accounts ?? ONE).map((a) => ({ ...a, server: "USSouth3", seasonal: true }))));
  const file = path.join(dataDir, "proxies.txt");
  if (o.proxies !== undefined) fs.writeFileSync(file, o.proxies);
  if (o.nodeJson !== undefined) fs.writeFileSync(path.join(dataDir, "node.json"), typeof o.nodeJson === "string" ? o.nodeJson : JSON.stringify(o.nodeJson));
  const logins: string[] = [];
  const fleet = new Fleet({
    dataDir, buildVersion: "7.0.0.2.0", log: () => {}, proxies: { file, stateFile: path.join(dataDir, "proxy_settings.json") },
    bringUp: async (d, acc, server) => {
      logins.push(acc.alias);
      const c = new FakeClient(server);
      // Like the real one: an exit from the list when there is one, this computer's own otherwise.
      if (d.proxies.configured) c.proxy = d.proxies.claim(acc.guid) as never;
      d.clients.set(acc.guid, c as unknown as GameClient);
      c.on("stopped", () => {
        if (d.clients.get(acc.guid) === (c as unknown as GameClient)) d.clients.delete(acc.guid);
      });
      setTimeout(() => (o.script ?? ((cl) => cl.arrive("TipSticky")))(c, acc), 5);
      return c as unknown as GameClient;
    },
    ...o.fleet,
  });
  cleanup.push(() => fleet.stop());
  const app = createControlPlane(fleet, () => "secret");
  const call = async (method: string, p: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://relay.local${p}`, {
      method, headers: { "X-Pyrelay-Auth": "secret", "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /** Start a test login and wait for its outcome. */
  const testLogin = async (guid?: string) => {
    const r = await call("POST", "/setup", { action: "test-login", ...(guid ? { guid } : {}) });
    if (r.status !== 200) return r;
    for (let i = 0; i < 400; i++) {
      const v = await call("GET", "/setup");
      if (v.body.steps.test.last?.state !== "running") return v.body.steps.test.last;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("test login never finished");
  };
  return { fleet, call, dataDir, file, logins, testLogin };
}
const nodeJson = (dataDir: string) => JSON.parse(fs.readFileSync(path.join(dataDir, "node.json"), "utf8"));

describe("setup for a node that ran before the setup existed", () => {
  it("counts as set up when it has accounts and proxies", async () => {
    const { call, dataDir } = setup({ proxies: "1.1.1.1:1080:u:p\n", nodeJson: { knownBuilds: [] } });
    expect((await call("GET", "/setup")).body).toMatchObject({ ok: true, complete: true });
    expect(nodeJson(dataDir).setup.completedAt).toEqual(expect.any(Number));
  });
  it("counts as set up with own internet allowed from the console back then, or with no settings file at all", async () => {
    expect((await setup({ nodeJson: { proxies: { required: false } } }).call("GET", "/setup")).body.complete).toBe(true);
    expect((await setup({ proxies: "1.1.1.1:1080\n" }).call("GET", "/setup")).body.complete).toBe(true);
  });
  it("is not set up without a way to connect, and stays that way on the next start", async () => {
    const first = setup({ nodeJson: { knownBuilds: [] } });
    expect((await first.call("GET", "/setup")).body).toMatchObject({ complete: false, steps: { connection: { done: false, mode: "none" } } });
    expect(nodeJson(first.dataDir).setup).toEqual({ completedAt: null, hubSkipped: false });
    // Proxies added later, the app restarted mid-setup: the setup is not skipped.
    fs.writeFileSync(path.join(first.dataDir, "proxies.txt"), "1.1.1.1:1080\n");
    const again = new Fleet({ dataDir: first.dataDir, buildVersion: "7.0.0.2.0", log: () => {}, proxies: { file: path.join(first.dataDir, "proxies.txt") } });
    cleanup.push(() => again.stop());
    expect(again.setup.view().complete).toBe(false);
  });
  it("leaves a settings file it cannot read alone", () => {
    const { fleet, dataDir } = setup({ proxies: "1.1.1.1:1080\n", nodeJson: "{broken" });
    expect(fleet.setup.view().complete).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "node.json"), "utf8")).toBe("{broken");
  });
});

describe("the setup steps", () => {
  it("follows accounts, the connection, rotmg trade and the test; complete, skip and start over", async () => {
    const { call, fleet } = setup({ nodeJson: {} });
    let v = (await call("GET", "/setup")).body;
    expect(v).toEqual({
      ok: true, complete: false,
      steps: {
        accounts: { done: true, count: 1, ready: 1 },
        connection: { done: false, mode: "none", proxies: 0, working: null },
        hub: { done: false, linked: false, skipped: false },
        test: { done: false, last: null },
      },
    });
    fleet.gate.noteBadCredentials("bot1@example.com");
    expect((await call("GET", "/setup")).body.steps.accounts).toEqual({ done: false, count: 1, ready: 0 });
    fleet.gate.unlock("bot1@example.com");
    // Own internet.
    expect((await call("POST", "/proxies/own-internet", { allow: true, acknowledged: true })).status).toBe(200);
    expect((await call("GET", "/setup")).body.steps.connection).toEqual({ done: true, mode: "own", proxies: 0, working: null });
    // Proxies win over own internet.
    await call("POST", "/proxies/list", { text: "1.1.1.1:1080\n2.2.2.2:1080\n" });
    expect((await call("GET", "/setup")).body.steps.connection).toEqual({ done: true, mode: "proxies", proxies: 2, working: null });
    await call("POST", "/proxies", { host: null, enabled: false });
    expect((await call("GET", "/setup")).body.steps.connection.done).toBe(false);
    await call("POST", "/proxies", { enabled: true });
    v = (await call("POST", "/setup", { action: "skip-hub" })).body;
    expect(v.steps.hub).toEqual({ done: true, linked: false, skipped: true });
    v = (await call("POST", "/setup", { action: "complete" })).body;
    expect(v.complete).toBe(true);
    expect(fleet.nodeSettings.get().setup).toEqual({ completedAt: expect.any(Number), hubSkipped: true });
    v = (await call("POST", "/setup", { action: "reset" })).body;
    expect(v).toMatchObject({ complete: false, steps: { hub: { skipped: false } } });
    expect((await call("POST", "/setup", { action: "nope" })).status).toBe(400);
    expect((await call("POST", "/setup", {})).status).toBe(400);
  });
});

describe("the test login", () => {
  it("logs a bot in and says where it stands, then logs it out", async () => {
    const { testLogin, fleet, logins } = setup({ proxies: "1.1.1.1:1080\n" });
    const last = await testLogin();
    expect(last).toEqual({ state: "ok", account: "BotOne", ign: "TipSticky", server: "USSouth3", message: "TipSticky is standing in the Nexus on USSouth3.", at: expect.any(Number) });
    expect(logins).toEqual(["BotOne"]);
    expect(fleet.clients.size).toBe(0);
    expect(fleet.tracker.ignFor(fleet.pool.every()[0].botGuid)).toBe("TipSticky");
    expect(fleet.setup.view().steps.test.done).toBe(true);
  });

  it("passes at once when a bot of the account is in the game already", async () => {
    const { testLogin, fleet, logins } = setup({ proxies: "1.1.1.1:1080\n" });
    const live = new FakeClient("EUWest");
    live.arrive("AlreadyIn");
    fleet.clients.set("bot1@example.com", live as unknown as GameClient);
    expect(await testLogin()).toMatchObject({ state: "ok", ign: "AlreadyIn", message: "AlreadyIn is in the game on EUWest right now." });
    expect(logins).toEqual([]);
    fleet.clients.clear();
  });

  it("says Realm refused the password, in words", async () => {
    const { testLogin } = setup({
      proxies: "1.1.1.1:1080\n",
      fleet: {
        bringUp: async (d, acc) => {
          acc.lastLoginError = { at: Date.now(), kind: "bad-credentials", message: "Realm did not accept these credentials" };
          d.gate.noteBadCredentials(acc.guid);
          throw new BringUpRefused("failed", "bad credentials");
        },
      },
    });
    expect(await testLogin()).toMatchObject({ state: "failed", account: "BotOne", message: "Realm says the email or password for BotOne is wrong. Fix them on the Accounts page." });
    // Known wrong now: the next test says so without trying Realm again.
    expect(await testLogin("bot1@example.com")).toMatchObject({ state: "failed", message: expect.stringMatching(/email or password for BotOne is wrong/) });
  });

  it("says what the game server said: in use elsewhere, a blocked proxy, the tutorial", async () => {
    const inUse = setup({ proxies: "1.1.1.1:1080\n", script: (c) => c.emit("failure", { kind: "account-in-use", seconds: 60 }) });
    expect(await inUse.testLogin()).toMatchObject({ state: "failed", message: expect.stringMatching(/^BotOne is logged in somewhere else/) });
    const banned = setup({ proxies: "1.1.1.1:1080\n", script: (c) => c.emit("failure", { kind: "ip-ban", proxyHost: "1.1.1.1" }) });
    expect(await banned.testLogin()).toMatchObject({ state: "failed", message: "Realm has blocked this proxy's address. Replace it with a different proxy." });
    const tutorial = setup({ proxies: "1.1.1.1:1080\n", script: (c) => { c.gameIdValue = -1; c.arrive("Newbie"); } });
    expect(await tutorial.testLogin()).toMatchObject({ state: "failed", message: expect.stringMatching(/hasn't finished the game's tutorial/) });
    expect(tutorial.fleet.clients.size).toBe(0);
  });

  it("refuses with a reason it can give at once", async () => {
    const none = setup({ nodeJson: {} });
    expect(await none.testLogin()).toEqual({ status: 409, body: { error: "Set up how your bots connect first: proxies, or your own internet." } });
    const empty = setup({ accounts: [], proxies: "1.1.1.1:1080\n" });
    expect(await empty.testLogin()).toEqual({ status: 409, body: { error: "Add an account first." } });
    const one = setup({ proxies: "1.1.1.1:1080\n", script: () => {} });
    expect(await one.testLogin("nobody@example.com")).toEqual({ status: 404, body: { error: "That account isn't on this node." } });
    expect((await one.call("POST", "/setup", { action: "test-login" })).body).toEqual({ ok: true, started: true });
    expect((await one.call("POST", "/setup", { action: "test-login" })).status).toBe(409);
    expect((await one.call("GET", "/setup")).body.steps.test.last).toMatchObject({ state: "running", account: "BotOne" });
  });

  it("says when logins are paused for a Realm update", async () => {
    const { testLogin, fleet, logins } = setup({ proxies: "1.1.1.1:1080\n" });
    fleet.gate.hold("Realm build 7.0.0.9.0 is new to this node");
    expect(await testLogin()).toMatchObject({ state: "failed", message: expect.stringMatching(/^Realm updated the game/) });
    expect(logins).toEqual([]);
  });
});

describe("proxies: reading, checking, own internet", () => {
  const servers: FakeSocks[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it("reads a list without saving it, and says what each saved line was", async () => {
    const { call, fleet } = setup();
    let r = await call("POST", "/proxies/parse", { text: "# list\n1.1.1.1:1080:alice:s3cretpw\nbad line here\n" });
    expect(r.body).toEqual({ ok: true, count: 1, lines: [{ line: 2, ok: true, display: "1.1.1.1:1080", type: "socks5" }, { line: 3, ok: false, raw: "•••• •••• ••••", error: expect.stringMatching(/^Couldn't read this line|port/) }] });
    expect(fleet.proxies.configured).toBe(false);
    expect((await call("POST", "/proxies/parse", {})).status).toBe(400);
    r = await call("POST", "/proxies/list", { text: "1.1.1.1:1080:alice:s3cretpw\n1.1.1.1:1080:alice:s3cretpw\n" });
    expect(r.body.saved).toEqual({ count: 1, error: null });
    expect(r.body.lines.map((l: { ok: boolean }) => l.ok)).toEqual([true, false]);
    r = await call("POST", "/proxies/list", { text: "garbage" });
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^None of these lines is a proxy/), lines: [{ ok: false }] } });
  });

  it("checks the listed proxies and remembers which work", async () => {
    // Two exits on one address, one per port (a gateway provider's list).
    vi.stubEnv("PROXY_EXIT_PER_PORT", "1");
    cleanup.push(() => {
      vi.unstubAllEnvs();
    });
    const a = await fakeSocks({ auth: { username: "alice", password: "s3cret" } });
    const b = await fakeSocks({ auth: { username: "alice", password: "s3cret" } });
    servers.push(a, b);
    const { call, fleet } = setup({ proxies: `127.0.0.1:${a.port}:alice:s3cret\n127.0.0.1:${b.port}:alice:wrong\n` });
    fleet.setup.checkTargets = () => ({ web: { host: "www.realmofthemadgod.com", port: 443 }, game: { host: "52.207.206.31", port: 2050 }, timeoutMs: 2000, slowMs: 1500 });
    let r = await call("POST", "/proxies/test", {});
    expect(r.body).toEqual({ ok: true, results: [
      { host: `127.0.0.1:${a.port}`, display: `127.0.0.1:${a.port}`, ok: true, ms: expect.any(Number) },
      { host: `127.0.0.1:${b.port}`, display: `127.0.0.1:${b.port}`, ok: false, error: "Wrong proxy username or password." },
    ] });
    expect(a.connects).toEqual([{ host: "www.realmofthemadgod.com", port: 443 }, { host: "52.207.206.31", port: 2050 }]);
    expect((await call("GET", "/setup")).body.steps.connection).toEqual({ done: true, mode: "proxies", proxies: 2, working: 1 });
    r = await call("POST", "/proxies/test", { hosts: [`127.0.0.1:${b.port}`] });
    expect(r.body.results).toHaveLength(1);
    expect((await call("POST", "/proxies/test", { hosts: ["9.9.9.9"] })).status).toBe(404);
    // The status card's facts carry the checks too.
    expect((await call("GET", "/status")).body.facts.proxies).toMatchObject({ listed: 2, checked: 2, working: 1 });
    // Every proxy tested and none working: the connection step is not done.
    await call("POST", "/proxies/list", { text: `127.0.0.1:${b.port}:alice:wrong\n` });
    await call("POST", "/proxies/test", {});
    expect((await call("GET", "/setup")).body.steps.connection).toEqual({ done: false, mode: "proxies", proxies: 1, working: 0 });
    // A new password for the same address: the old check no longer counts.
    await call("POST", "/proxies/list", { text: `127.0.0.1:${b.port}:alice:s3cret\n` });
    expect((await call("GET", "/setup")).body.steps.connection).toEqual({ done: true, mode: "proxies", proxies: 1, working: null });
  });

  it("has nothing to check without a list", async () => {
    expect(await setup().call("POST", "/proxies/test", {})).toEqual({ status: 409, body: { error: expect.stringMatching(/no proxies to test yet/) } });
  });

  it("allows own internet only with the risk confirmed, and takes it back", async () => {
    const { call, fleet } = setup({ nodeJson: {} });
    expect(await call("POST", "/proxies/own-internet", { allow: true })).toEqual({ status: 400, body: { error: "Please confirm you understand the risk" } });
    expect((await call("POST", "/proxies/own-internet", { allow: "yes" })).status).toBe(400);
    expect(fleet.nodeSettings.get().proxies).toEqual({ required: true, ownInternetAt: null });
    const r = await call("POST", "/proxies/own-internet", { allow: true, acknowledged: true });
    expect(r.body).toMatchObject({ ok: true, required: false, ownInternetAt: expect.any(Number) });
    expect(fleet.nodeSettings.get().proxies.ownInternetAt).toEqual(expect.any(Number));
    expect((await call("POST", "/proxies/own-internet", { allow: false })).body).toMatchObject({ required: true, ownInternetAt: null });
  });
});

describe("status, diagnostics, waking up, checking the build", () => {
  it("serves the fleet's status facts and the card they make", async () => {
    const { call, fleet } = setup({ proxies: "1.1.1.1:1080\n" });
    fleet.gate.noteBadCredentials("bot1@example.com");
    const r = await call("GET", "/status");
    expect(r.body.facts.accounts).toMatchObject({ total: 1, ready: 0, problems: [{ alias: "BotOne", kind: "bad-credentials" }] });
    expect(r.body.status).toMatchObject({ ok: true, state: "problem", headline: "No account can log in" });
  });

  it("writes diagnostics without passwords, proxy logins or emails", async () => {
    const { call, fleet } = setup({ proxies: "45.67.89.10:5646:proxyuser:proxypass99\n" });
    fleet.log("BringUp: using 45.67.89.10:5646 for BotOne (bot1@example.com, password hunter2pw)");
    fleet.log("hub: link code=ABCD1234 accepted");
    const r = await call("POST", "/diagnostics", { site: { frozen: true, communismError: null }, extra: [{ title: "Website side", lines: ["Open requests: 2 deposit(s)"] }] });
    const text: string = r.body.text;
    for (const secret of ["hunter2pw", "proxyuser", "proxypass99", "bot1@example.com", "45.67.89.10", "ABCD1234"]) expect(text).not.toContain(secret);
    expect(text).toContain("b***@example.com");
    expect(text).toContain("45.67.x.x:5646");
    expect(text).toContain("== Website side ==");
    expect(text).toMatch(/paused this node's offers/);
    expect((await call("GET", "/diagnostics")).body.text).toMatch(/^rotmg trade node: diagnostics/);
  });

  it("logs every bot out when the computer wakes up and lets failed proxies back", async () => {
    const { call, fleet } = setup({ proxies: "1.1.1.1:1080\n2.2.2.2:1080\n" });
    const acc = fleet.pool.every()[0];
    const c = new FakeClient("USSouth3");
    c.arrive("Sleepy");
    fleet.clients.set(acc.guid, c as unknown as GameClient);
    fleet.proxies.noteResult("1.1.1.1", false);
    fleet.proxies.noteResult("1.1.1.1", false);
    fleet.proxies.noteBan("2.2.2.2");
    expect(fleet.proxies.isBenched("1.1.1.1")).toBe(true);
    const r = await call("POST", "/node/resume");
    expect(r.body).toEqual({ ok: true, stopped: 1, proxies: 1 });
    expect(c.active).toBe(false);
    expect(fleet.clients.size).toBe(0);
    expect(fleet.proxies.isBenched("1.1.1.1")).toBe(false);
    // Realm's ban stays.
    expect(fleet.proxies.isBenched("2.2.2.2")).toBe(true);
  });

  it("checks again whether rotmg trade confirmed a new Realm build", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ minNodeVersion: "0.0.1", latestNodeVersion: "0.0.1", downloadUrl: "", build: { gameVersion: "7.0.0.9.0", knownBuilds: ["7.0.0.9.0"], updatedAt: 0 } }), { status: String(url).endsWith("/api/v1/version") ? 200 : 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { call, fleet } = setup({ proxies: "1.1.1.1:1080\n", fleet: { buildVersion: "7.0.0.9.0" } });
    fleet.buildGate.onBuild(fleet.versions.current);
    expect(fleet.gate.holdReason).toMatch(/7\.0\.0\.9\.0/);
    const r = await call("POST", "/node/build/check");
    expect(r.body).toMatchObject({ ok: true, build: { held: false, known: true }, message: "The new game version is confirmed. Bots carry on." });
    // Not linked: the public feed of the default hub.
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://rotmg.trade/api/v1/version");
    expect(fleet.gate.holdReason).toBeNull();
  });
});
