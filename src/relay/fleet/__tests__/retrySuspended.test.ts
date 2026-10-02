import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotPool } from "../botPool";
import { LoginGate } from "../loginGate";
import { ProxyPool } from "../proxyPool";
import { retrySuspended } from "../retrySuspended";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-"));
  fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([
    { alias: "Fine", guid: "fine@x", password: "pw", suspended: true },
    { alias: "Gone", guid: "gone@x", password: "pw", suspended: true },
    { alias: "Live", guid: "live@x", password: "pw" },
  ]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("retry suspended", () => {
  it("un-retires accounts Realm accepts again, leaves the rest, and persists", async () => {
    const pool = BotPool.at(dir);
    const gate = new LoginGate();
    gate.retire("fine@x");
    gate.retire("gone@x");
    const log: string[] = [];
    const results = await retrySuspended({
      pool, gate, proxies: new ProxyPool([], { file: null }), requireProxy: () => false, log: (l) => log.push(l),
      verify: async (acc) => (acc.guid === "fine@x" ? "cleared" : { verdict: "still-suspended", detail: "Realm: suspended" }),
    });
    expect(results.map((r) => [r.alias, r.verdict])).toEqual(expect.arrayContaining([["Fine", "cleared"], ["Gone", "still-suspended"]]));
    expect(results).toHaveLength(2);
    expect(pool.all().map((a) => a.alias).sort()).toEqual(["Fine", "Live"]);
    expect(gate.lockoutRemainingMs("fine@x")).toBe(0);
    expect(gate.lockoutRemainingMs("gone@x")).toBeGreaterThan(0);
    expect(BotPool.at(dir).all().map((a) => a.alias).sort()).toEqual(["Fine", "Live"]);
  });
  it("with a proxy list, waits for a host to come free rather than asking Realm from this computer", async () => {
    const pool = BotPool.at(dir);
    const proxies = new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }], { file: null });
    proxies.claim("live@x");
    const via: (string | null)[] = [];
    const verify = async (_acc: unknown, proxy: { host: string } | null) => {
      via.push(proxy?.host ?? null);
      return "still-suspended" as const;
    };
    setTimeout(() => proxies.release("live@x"), 300);
    expect(await retrySuspended({ pool, gate: new LoginGate(), proxies, requireProxy: () => true, log: () => {}, verify }, ["gone@x"])).toEqual([expect.objectContaining({ alias: "Gone", verdict: "still-suspended" })]);
    expect(via).toEqual(["1.1.1.1"]);
    // No host will come free: said so, and Realm is never asked without one.
    proxies.setAllEnabled(false);
    expect(await retrySuspended({ pool, gate: new LoginGate(), proxies, requireProxy: () => false, log: () => {}, verify }, ["gone@x"])).toEqual([expect.objectContaining({ verdict: "error", detail: "no free proxy: every proxy host is switched off" })]);
    expect(via).toEqual(["1.1.1.1"]);
  });
  it("respects the login gate: nothing is asked while logins are paused or the account cools down, and an attempt limit counts at the gate", async () => {
    const pool = BotPool.at(dir);
    let now = 1_000_000;
    const gate = new LoginGate(() => now);
    gate.retire("fine@x");
    gate.retire("gone@x");
    const asked: string[] = [];
    const verify = async (acc: { guid: string }) => {
      asked.push(acc.guid);
      return { verdict: "attempt-limit" as const, detail: "login attempt limit, wait 60s", lockoutSeconds: 60 };
    };
    const deps = { pool, gate, proxies: new ProxyPool([], { file: null }), requireProxy: () => false, log: () => {}, verify };
    // A suspension alone does not stop the re-check; Realm's attempt limit then locks the account at the gate.
    expect(await retrySuspended(deps, ["gone@x"], 1)).toEqual([expect.objectContaining({ verdict: "attempt-limit" })]);
    expect(gate.cooldownRemainingMs("gone@x")).toBe(60_000);
    // Cooling down: not asked again until it has passed.
    expect(await retrySuspended(deps, ["gone@x"], 1)).toEqual([expect.objectContaining({ verdict: "error", detail: "the account waits out a login cooldown (60s left)" })]);
    expect(asked).toEqual(["gone@x"]);
    // Three attempt limits pause every login: the next account is not asked either.
    gate.noteAttemptLimit("a@x", 60);
    gate.noteAttemptLimit("b@x", 60);
    expect(gate.ratePauseRemainingMs()).toBeGreaterThan(0);
    expect(await retrySuspended(deps, ["fine@x"], 1)).toEqual([expect.objectContaining({ verdict: "error", detail: expect.stringMatching(/logins are paused/) })]);
    expect(asked).toEqual(["gone@x"]);
    // Both over: asked again, and still locked by its suspension until Realm clears it.
    now += 3600_000;
    await retrySuspended(deps, ["fine@x"], 1);
    expect(asked).toEqual(["gone@x", "fine@x"]);
    expect(gate.lockoutRemainingMs("fine@x")).toBeGreaterThan(0);
  });
  it("refuses to probe direct when proxies are required and none are listed", async () => {
    const pool = BotPool.at(dir);
    const results = await retrySuspended({ pool, gate: new LoginGate(), proxies: new ProxyPool([], { file: null }), requireProxy: () => true, log: () => {} }, ["gone@x"]);
    expect(results).toEqual([expect.objectContaining({ alias: "Gone", verdict: "error", detail: expect.stringMatching(/no proxies/) })]);
    expect(pool.all().some((a) => a.alias === "Gone")).toBe(false);
  });
  it("checks one account per enabled exit IP at once, and gives each host back when its check is done", async () => {
    const pool = BotPool.at(dir);
    const proxies = new ProxyPool([{ host: "1.1.1.1", port: 1080, type: 5, username: "", password: "" }, { host: "2.2.2.2", port: 1080, type: 5, username: "", password: "" }], { file: null });
    let live = 0;
    let peak = 0;
    const hosts: string[] = [];
    await retrySuspended({
      pool, gate: new LoginGate(), proxies, requireProxy: () => true, log: () => {},
      verify: async (_acc, proxy) => {
        hosts.push(proxy!.host);
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return "still-suspended";
      },
    });
    expect(peak).toBe(2); // both suspended accounts at once, one per host
    expect(new Set(hosts).size).toBe(2); // never two checks through one exit
    expect(proxies.claim("bot@x")).not.toBeNull(); // leases given back
  });
});
