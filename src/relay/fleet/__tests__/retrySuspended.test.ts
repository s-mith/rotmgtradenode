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
      pool, gate, proxies: new ProxyPool([], { url: null, file: null }), requireProxy: () => false, log: (l) => log.push(l),
      verify: async (acc) => (acc.guid === "fine@x" ? "cleared" : { verdict: "still-suspended", detail: "Realm: suspended" }),
    });
    expect(results.map((r) => [r.alias, r.verdict])).toEqual(expect.arrayContaining([["Fine", "cleared"], ["Gone", "still-suspended"]]));
    expect(results).toHaveLength(2);
    expect(pool.all().map((a) => a.alias).sort()).toEqual(["Fine", "Live"]);
    expect(gate.lockoutRemainingMs("fine@x")).toBe(0);
    expect(gate.lockoutRemainingMs("gone@x")).toBeGreaterThan(0);
    expect(BotPool.at(dir).all().map((a) => a.alias).sort()).toEqual(["Fine", "Live"]);
  });
  it("refuses to probe direct when proxies are required and none are listed", async () => {
    const pool = BotPool.at(dir);
    const results = await retrySuspended({ pool, gate: new LoginGate(), proxies: new ProxyPool([], { url: null, file: null }), requireProxy: () => true, log: () => {} }, ["gone@x"]);
    expect(results).toEqual([expect.objectContaining({ alias: "Gone", verdict: "error", detail: expect.stringMatching(/no proxies/) })]);
    expect(pool.all().some((a) => a.alias === "Gone")).toBe(false);
  });
});
