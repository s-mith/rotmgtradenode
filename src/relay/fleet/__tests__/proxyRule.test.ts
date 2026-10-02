import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProxyPool } from "../proxyPool";
import { bringUp, BringUpRefused, type FleetDeps } from "../bringUp";
import { BotPool } from "../botPool";
import { LoginGate } from "../loginGate";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxyrule-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pasted proxy list", () => {
  it("parses, dedupes by host, persists to the file, and reloads on the next boot", () => {
    const file = path.join(dir, "proxies.txt");
    const pool = new ProxyPool([], { file, stateFile: path.join(dir, "proxy_settings.json") });
    expect(pool.configured).toBe(false);
    const r = pool.setList("1.1.1.1:1080:u:p\n\n# comment\n2.2.2.2:1080\n1.1.1.1:2000\nsocks4://3.3.3.3:1080\njunk\n");
    expect(r).toMatchObject({ count: 4, error: null });
    // What each line was read as: blanks and comments are not lines; the junk one says why, without echoing it.
    expect(r.lines.map((l) => [l.line, l.ok])).toEqual([[1, true], [4, true], [5, true], [6, true], [7, false]]);
    expect(r.lines[4]).toMatchObject({ raw: "••••", error: expect.stringMatching(/^Couldn't read this line/) });
    expect(pool.exclusiveCapacity()).toBe(3);
    expect(pool.listText().split("\n")).toEqual(["1.1.1.1:1080:u:p", "2.2.2.2:1080", "socks4://3.3.3.3:1080"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = ProxyPool.fromSource({ file });
    expect(again.exclusiveCapacity()).toBe(3);
    expect(pool.setList("nothing useful")).toMatchObject({ count: 0, error: expect.stringMatching(/^None of these lines is a proxy/) });
    expect(pool.setList("")).toEqual({ count: 0, error: null, lines: [] });
    expect(pool.configured).toBe(false);
  });
});

describe("proxy-only rule", () => {
  function deps(required: boolean, proxies: ProxyPool): FleetDeps {
    fs.writeFileSync(path.join(dir, "Accounts.json"), JSON.stringify([{ alias: "A", guid: "a@x", password: "pw" }]));
    return { pool: BotPool.at(dir), proxies, gate: new LoginGate(), clients: new Map(), log: () => {}, buildVersion: "7.0.0.2.0", requireProxy: () => required };
  }
  it("refuses a login before touching the network when no proxy is listed", async () => {
    const d = deps(true, new ProxyPool([], { file: null }));
    const acc = d.pool.all()[0];
    await expect(bringUp(d, acc, "USSouth3")).rejects.toMatchObject({ verdict: "failed", message: expect.stringMatching(/proxies are required/) });
    expect(d.clients.size).toBe(0);
    expect(() => { throw new BringUpRefused("failed", "x"); }).toThrow();
  });
});
