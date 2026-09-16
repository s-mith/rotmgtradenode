import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Fleet } from "../fleet/fleet";
import { createControlPlane } from "../controlPlane";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

describe("control plane /proxies", () => {
  it("lists hosts, flips one or all, and refreshes from the URL", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cp-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([
      { alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]));
    const file = path.join(dataDir, "proxies.txt");
    fs.writeFileSync(file, "1.1.1.1:1080:u:p\n2.2.2.2:1080:u:p\n");
    let body = "1.1.1.1:1080:u:p\n2.2.2.2:1080:u:p\n9.9.9.9:1080:u:p\n";
    const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const fleet = new Fleet({
      dataDir, buildVersion: "7.0.0.0.0", log: () => {},
      proxies: { url: "https://example.test/list", file, stateFile: path.join(dataDir, "proxy_settings.json"), fetch: fakeFetch },
    });
    cleanup.push(() => fleet.stop());
    const app = createControlPlane(fleet, () => "secret");
    const call = async (method: string, p: string, json?: unknown) => {
      const res = await app.fetch(new Request(`http://relay.local${p}`, {
        method, headers: { "X-Pyrelay-Auth": "secret", "Content-Type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
      }));
      return { status: res.status, body: await res.json() };
    };

    let r = await call("GET", "/proxies");
    expect(r.status).toBe(200);
    expect(r.body.capacity).toBe(2);
    expect(r.body.source).toMatchObject({ urlConfigured: true, loadedFrom: "file" });

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

    r = await call("POST", "/proxies/refresh");
    expect(r.body.refresh).toEqual({ ok: true, count: 3, error: null });
    expect(r.body.capacity).toBe(2); // 2.2.2.2 stays off across the swap
    expect(r.body.source.loadedFrom).toBe("url");
    expect(fs.readFileSync(file, "utf8")).toBe(body);

    r = await call("POST", "/proxies", { host: null, enabled: false });
    expect(r.body.capacity).toBe(0);
    r = await call("POST", "/proxies", { enabled: true });
    expect(r.body.capacity).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "proxy_settings.json"), "utf8"))).toEqual({ disabled: [] });

    body = "";
    r = await call("POST", "/proxies/refresh");
    expect(r.body.refresh.ok).toBe(false);
    expect(r.body.capacity).toBe(3);
  });
});
