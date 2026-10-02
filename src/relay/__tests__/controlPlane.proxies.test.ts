import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Realm's answer to an account check, and the exit it went out through.
vi.mock("../fleet/accountProbe", () => ({
  probeAccount: vi.fn(async (_creds: unknown, proxy: { host: string } | null) => ({ verdict: "ok", detail: `via ${proxy?.host ?? "this computer"}`, chars: [], tutorialDone: true, loaded: null })),
}));
import { Fleet } from "../fleet/fleet";
import { createControlPlane } from "../controlPlane";
import { probeAccount } from "../fleet/accountProbe";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
  vi.mocked(probeAccount).mockClear();
});

/** A fleet with one account and the proxy list the console saved, and a caller for its control plane. */
function setup(list: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cp-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([
    { alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true },
  ]));
  const file = path.join(dataDir, "proxies.txt");
  fs.writeFileSync(file, list);
  const fleet = new Fleet({ dataDir, buildVersion: "7.0.0.0.0", log: () => {}, proxies: { file, stateFile: path.join(dataDir, "proxy_settings.json") } });
  cleanup.push(() => fleet.stop());
  const app = createControlPlane(fleet, () => "secret");
  const call = async (method: string, p: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://relay.local${p}`, {
      method, headers: { "X-Pyrelay-Auth": "secret", "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { fleet, call, dataDir, file };
}

describe("control plane /proxies", () => {
  it("lists hosts, flips one or all, and saves the owner's list", async () => {
    const { fleet, call, dataDir, file } = setup("1.1.1.1:1080:u:p\n2.2.2.2:1080:u:p\n");
    let r = await call("GET", "/proxies");
    expect(r.status).toBe(200);
    expect(r.body.capacity).toBe(2);

    fleet.proxies.claim("bot1@example.com");
    r = await call("POST", "/proxies", { host: "2.2.2.2", enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.capacity).toBe(1);
    const rows = r.body.proxies as { host: string; enabled: boolean; usedBy: string | null; username: string; password: string }[];
    expect(rows.find((p) => p.host === "2.2.2.2")).toMatchObject({ enabled: false, username: "u", password: "p" });
    // The occupant is reported by alias, not guid.
    expect(rows.find((p) => p.usedBy !== null)?.usedBy).toBe("BotOne");

    expect((await call("POST", "/proxies", { host: "8.8.8.8", enabled: false })).status).toBe(404);
    expect((await call("POST", "/proxies", { host: "1.1.1.1", enabled: "yes" })).status).toBe(400);
    // The list is entered by hand only: there is nothing to download it from.
    expect((await call("POST", "/proxies/refresh")).status).toBe(404);

    r = await call("POST", "/proxies", { host: null, enabled: false });
    expect(r.body.capacity).toBe(0);
    r = await call("POST", "/proxies", { enabled: true });
    expect(r.body.capacity).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "proxy_settings.json"), "utf8"))).toEqual({ disabled: [] });

    r = await call("POST", "/proxies/list", { text: "1.1.1.1:1080:u:p\n3.3.3.3:1080:u:p\n" });
    expect(r.body.saved).toEqual({ count: 2, error: null });
    expect(r.body.proxies.map((p: { host: string }) => p.host).sort()).toEqual(["1.1.1.1", "3.3.3.3"]);
    expect(fs.readFileSync(file, "utf8")).toBe("1.1.1.1:1080:u:p\n3.3.3.3:1080:u:p\n");
  });
});

describe("an account check with Realm", () => {
  it("waits for a proxy host to come free rather than going out from this computer", async () => {
    const { fleet, call } = setup("1.1.1.1:1080:u:p\n");
    fleet.proxies.claim("bot1@example.com");
    setTimeout(() => fleet.proxies.release("bot1@example.com"), 400);
    const started = Date.now();
    const r = await call("POST", "/accounts/probe", { email: "new@example.com", password: "pw" });
    expect(r.status).toBe(200);
    expect(r.body.probe.detail).toBe("via 1.1.1.1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("says why when no host will come free, and never asks Realm without one", async () => {
    const { fleet, call } = setup("1.1.1.1:1080:u:p\n");
    fleet.proxies.setAllEnabled(false);
    for (const [p, body] of [["/accounts/probe", { email: "new@example.com", password: "pw" }], ["/accounts", { email: "new@example.com", password: "pw" }], ["/accounts/credentials", { guid: "bot1@example.com", password: "pw2" }]] as const) {
      const r = await call("POST", p, body);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/no free proxy .*every proxy host is switched off/);
    }
    expect(probeAccount).not.toHaveBeenCalled();
  });
});
