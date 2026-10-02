// Advanced management's login path (docs/relay/ADVANCED.md, "Sessions"): an
// advanced account reuses its access token, logs out with no reconnect
// grace when we stop a live session, and may be woken again at once after a
// login that worked. Accounts of a pool without the switch log in as before.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AuthResult = { ok: true } | { ok: false; error: { kind: string; [k: string]: unknown } };
// The scripted client bringUp builds instead of the real one.
type Script = { auth?: AuthResult; resume?: AuthResult; connect?: boolean };
let script: Script = {};
const built: FakeGameClient[] = [];
let mints = 0;
class FakeGameClient extends EventEmitter {
  active = true;
  connected = false;
  proxy: unknown;
  server = "USSouth3";
  charSeasonal = null;
  charHasBackpack = null;
  knownBackpack = false;
  token = "";
  tokenIssuedAt = 0;
  tokenLifetimeS: number | null = null;
  authCalls = 0;
  resumed: string[] = [];
  constructor(cfg: { proxy?: unknown }) {
    super();
    this.proxy = cfg.proxy ?? null;
    built.push(this);
  }
  async authenticate() {
    this.authCalls++;
    const r = script.auth ?? { ok: true };
    if (r.ok) {
      this.token = `minted-${++mints}`;
      this.tokenIssuedAt = Date.now();
    }
    return r;
  }
  async resume(token: string, issuedAt: number) {
    this.resumed.push(token);
    const r = script.resume ?? { ok: true };
    if (r.ok) {
      this.token = token;
      this.tokenIssuedAt = issuedAt;
    }
    return r;
  }
  async connect() {
    this.connected = script.connect ?? true;
    return this.connected;
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.connected = false;
    this.emit("stopped");
  }
}
vi.mock("../../client/gameClient", () => ({ GameClient: FakeGameClient }));

const { bringUp, takeDown } = await import("../bringUp");
const { BotPool } = await import("../botPool");
const { LoginGate } = await import("../loginGate");
const { ProxyPool } = await import("../proxyPool");
const { WakeScheduler } = await import("../wakes");
const { loginStats, resetLoginStats, tokenCache } = await import("../tokenCache");
const C = await import("../constants");
type FleetDeps = import("../bringUp").FleetDeps;
type BotAccount = import("../botPool").BotAccount;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-"));
  fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([{ alias: "A", guid: "a@x", password: "pw" }, { alias: "B", guid: "b@x", password: "pw" }]));
  script = {};
  built.length = 0;
  tokenCache.clear();
  resetLoginStats();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Fleet deps where `advanced` decides which accounts follow the advanced rules (by alias). */
function deps(advanced: (alias: string) => boolean, extra: Partial<FleetDeps> = {}): FleetDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    pool: BotPool.at(dir), proxies: new ProxyPool([], { file: null }), gate: new LoginGate(), clients: new Map(),
    log: (l) => logs.push(l), buildVersion: "7.0.0.2.0", logs, isAdvanced: (acc: BotAccount) => advanced(acc.alias), ...extra,
  };
}
/** Log the account in, then out again the way the fleet does when it is done with it. */
async function session(d: FleetDeps, acc: BotAccount): Promise<FakeGameClient> {
  const c = (await bringUp(d, acc, "USSouth3")) as unknown as FakeGameClient;
  takeDown(d, acc, "done");
  return c;
}

describe("token reuse", () => {
  it("an advanced account's next login goes straight to char/list with the token it minted", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    const first = await session(d, acc);
    expect(first.authCalls).toBe(1);
    const second = await session(d, acc);
    expect(second.authCalls).toBe(0);
    expect(second.resumed).toEqual([first.token]);
    expect(second.tokenIssuedAt).toBe(first.tokenIssuedAt); // the FAILURE line's token age counts from the mint
    expect(loginStats()).toEqual({ minted: 1, reused: 1, reuseFailed: 0 });
  });
  it("a pool without the switch mints a token at every login and keeps none", async () => {
    const d = deps(() => false);
    const acc = d.pool.all()[0];
    await session(d, acc);
    d.gate.unlock(acc.guid); // past the reconnect grace
    const second = await session(d, acc);
    expect(second.authCalls).toBe(1);
    expect(second.resumed).toEqual([]);
    expect(tokenCache.size).toBe(0);
    expect(loginStats()).toEqual({ minted: 2, reused: 0, reuseFailed: 0 });
  });
  it("a kept token char/list refuses is spent: forgotten, a fresh one minted, and the account not judged by it", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    const first = await session(d, acc);
    script = { resume: { ok: false, error: { kind: "bad-credentials", body: "Account credentials not valid" } } };
    const second = await session(d, acc);
    expect(second.resumed).toEqual([first.token]);
    expect(second.authCalls).toBe(1);
    expect(d.gate.hasBadCredentials(acc.guid)).toBe(false);
    expect(acc.lastLoginError).toBeNull();
    expect(loginStats()).toEqual({ minted: 2, reused: 0, reuseFailed: 1 });
    // The fresh token is the one kept now.
    script = {};
    const third = await session(d, acc);
    expect(third.resumed).toEqual([second.token]);
  });
  it("credentials a fresh mint is refused with lock the account as before, and drop the kept token", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    await session(d, acc);
    script = { resume: { ok: false, error: { kind: "unknown", body: "<Error>?</Error>" } }, auth: { ok: false, error: { kind: "bad-credentials", body: "x" } } };
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ message: "bad credentials" });
    expect(d.gate.hasBadCredentials(acc.guid)).toBe(true);
    expect(tokenCache.size).toBe(0);
  });
  it("an account still in use answers the same with a kept token: the cooldown, and the token stays", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    await session(d, acc);
    script = { resume: { ok: false, error: { kind: "account-in-use", seconds: 30, body: "Account in use" } } };
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ verdict: "locked", message: "account in use" });
    expect(built.at(-1)!.authCalls).toBe(0);
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBeGreaterThan(25_000);
    expect(tokenCache.size).toBe(1);
  });
  it("a token error in game forgets the token, so the next wake mints", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    const c = (await bringUp(d, acc, "USSouth3")) as unknown as FakeGameClient;
    expect(tokenCache.size).toBe(1);
    c.emit("failure", { kind: "token-error", errorId: 20 });
    expect(tokenCache.size).toBe(0);
  });
  it("a suspension forgets the token", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    await session(d, acc);
    script = { resume: { ok: false, error: { kind: "suspended", body: "SUSPENDED" } } };
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ verdict: "suspended" });
    expect(tokenCache.size).toBe(0);
  });
  it("only the advanced pool's accounts keep tokens", async () => {
    const d = deps((alias) => alias === "A");
    const [a, b] = d.pool.all();
    await session(d, a);
    d.gate.unlock(a.guid);
    await bringUp(d, b, "USSouth3");
    expect(tokenCache.size).toBe(1);
  });
});

describe("the reconnect grace", () => {
  it("is skipped when we stop an advanced account's live session", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    await bringUp(d, acc, "USSouth3");
    takeDown(d, acc, "done");
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBe(0);
    await expect(bringUp(d, acc, "USSouth3")).resolves.toBeTruthy();
  });
  it("stays for an account of a pool without the switch", async () => {
    const d = deps(() => false);
    const acc = d.pool.all()[0];
    await bringUp(d, acc, "USSouth3");
    takeDown(d, acc, "done");
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBeGreaterThan((C.RECONNECT_GRACE_S - 1) * 1000);
  });
  it("stays when the session had already dropped or stopped: Realm may still hold it", async () => {
    const d = deps(() => true);
    const [a, b] = d.pool.all();
    const ca = (await bringUp(d, a, "USSouth3")) as unknown as FakeGameClient;
    ca.connected = false; // the socket went; the client would re-dial
    takeDown(d, a, "dropped");
    expect(d.gate.lockoutRemainingMs(a.guid)).toBeGreaterThan(0);
    const cb = (await bringUp(d, b, "USSouth3")) as unknown as FakeGameClient;
    cb.active = false; // a FAILURE stopped it before the fleet came to take it down
    takeDown(d, b, "zombie");
    expect(d.gate.lockoutRemainingMs(b.guid)).toBeGreaterThan(0);
  });
  it("leaves a failure's own cooldown standing", async () => {
    const d = deps(() => true);
    const acc = d.pool.all()[0];
    await bringUp(d, acc, "USSouth3");
    d.gate.noteCooldown(acc.guid, 60, "account in use");
    takeDown(d, acc, "done");
    expect(d.gate.lockoutRemainingMs(acc.guid)).toBeGreaterThan(55_000);
  });
});

describe("wake pacing", () => {
  async function wakeTwice(advanced: boolean): Promise<boolean> {
    const d = deps(() => advanced, { bringUp: async () => new FakeGameClient({}) as never });
    const wakes = new WakeScheduler(d);
    const acc = d.pool.all()[0];
    const done = new Promise<void>((resolve) => wakes.start(acc, "USSouth3", () => resolve(), () => {}));
    await done;
    // Logged out again at once (a character switch): the account is offline.
    return wakes.start(acc, "USSouth3", () => {}, () => {});
  }
  it("lets an advanced account be woken again right after a login that worked", async () => {
    expect(await wakeTwice(true)).toBe(true);
  });
  it("keeps the retry cooldown for a pool without the switch", async () => {
    expect(await wakeTwice(false)).toBe(false);
  });
  it("keeps the retry cooldown after a failed login, advanced or not", async () => {
    const d = deps(() => true, { bringUp: async () => { throw new Error("no"); } });
    const wakes = new WakeScheduler(d);
    const acc = d.pool.all()[0];
    await new Promise<void>((resolve) => wakes.start(acc, "USSouth3", () => resolve(), () => {}));
    expect(wakes.start(acc, "USSouth3", () => {}, () => {})).toBe(false);
  });
});
