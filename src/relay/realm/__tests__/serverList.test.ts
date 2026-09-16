import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_IPS, SERVER_NAMES, isServerName } from "../constants";
import { applyServerList, ServerList, SERVER_LIST_STALE_MS } from "../serverList";

let dir: string;
const before = { ...SERVER_IPS };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "servers-")); });
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(SERVER_IPS)) delete SERVER_IPS[k];
  Object.assign(SERVER_IPS, before);
  applyServerList([]);
});

const entry = (name: string, dns: string) => ({ name, dns, usage: 0, adminOnly: false });

describe("applyServerList", () => {
  it("moves an address, adds a server, rebuilds the reverse table, ignores junk", () => {
    const changed = applyServerList([entry("USSouth3", "10.0.0.1"), entry("NewLand", "10.0.0.2"), entry("EUWest", SERVER_IPS.EUWest), entry("Broken", "not-an-ip"), entry("", "10.0.0.3")]);
    expect(changed.sort()).toEqual(["NewLand", "USSouth3"]);
    expect(SERVER_IPS.USSouth3).toBe("10.0.0.1");
    expect(SERVER_NAMES["10.0.0.1"]).toBe("USSouth3");
    expect(SERVER_NAMES[before.USSouth3]).toBeUndefined();
    expect(isServerName("NewLand")).toBe(true);
    expect(isServerName("Broken")).toBe(false);
  });
});

describe("ServerList", () => {
  it("refreshes when stale, caches to disk, and a new instance boots from the cache", async () => {
    let calls = 0;
    let now = 10_000_000;
    const list = new ServerList(path.join(dir, "servers.json"), () => {}, async () => { calls++; return [entry("USSouth3", "10.1.1.1")]; }, () => now);
    expect(list.stale).toBe(true);
    expect(await list.refreshIfStale("tok", null)).toBe(true);
    expect(SERVER_IPS.USSouth3).toBe("10.1.1.1");
    expect(list.stale).toBe(false);
    expect(await list.refreshIfStale("tok", null)).toBe(false);
    expect(calls).toBe(1);
    now += SERVER_LIST_STALE_MS + 1;
    expect(list.stale).toBe(true);
    // A second instance reads the cache before any token exists.
    SERVER_IPS.USSouth3 = "0.0.0.0";
    const again = new ServerList(path.join(dir, "servers.json"), () => {}, async () => null, () => now);
    expect(SERVER_IPS.USSouth3).toBe("10.1.1.1");
    expect(again.fetchedAt).toBe(10_000_000);
  });
  it("keeps the table on a failed refresh and records the error", async () => {
    const list = new ServerList(null, () => {}, async () => { throw new Error("boom"); });
    const ip = SERVER_IPS.USSouth3;
    expect(await list.refreshIfStale("tok", null)).toBe(false);
    expect(SERVER_IPS.USSouth3).toBe(ip);
    expect(list.lastError).toBe("boom");
    expect(list.stale).toBe(true);
  });
});
