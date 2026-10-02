// Cross-site requests and foreign Host names (CSRF, DNS rebinding) are refused before any handler runs.
import { describe, expect, it } from "vitest";
import { guardRequest } from "../guard";
import { bindRefusal, isLoopbackHost } from "@/node/config";

const LOCAL = { bindHost: "127.0.0.1" };
function req(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`http://127.0.0.1:3000${path}`, { method: init.method ?? "GET", headers: { host: "127.0.0.1:3000", ...init.headers } });
}

describe("guardRequest", () => {
  it("lets the node's own page, the Vite dev proxy, Electron and curl through", () => {
    // Same origin.
    expect(guardRequest(req("/api/dev/node", { method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" } }), LOCAL)).toBeNull();
    // Vite keeps the browser's Host (localhost:5173) when it proxies.
    expect(guardRequest(req("/api/deposit", { method: "POST", headers: { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" } }), LOCAL)).toBeNull();
    // No Origin: curl, scripts, the desktop shell's own fetch.
    expect(guardRequest(req("/api/dev/shutdown", { method: "POST", headers: { "content-type": "application/json" } }), LOCAL)).toBeNull();
    expect(guardRequest(req("/api/pool"), LOCAL)).toBeNull();
  });

  it("refuses another site's form post or no-cors fetch", () => {
    const evil = { origin: "https://evil.example", "content-type": "text/plain" };
    expect(guardRequest(req("/api/dev/node", { method: "POST", headers: evil }), LOCAL)?.status).toBe(403);
    expect(guardRequest(req("/api/login/start", { method: "POST", headers: { origin: "https://evil.example" } }), LOCAL)?.status).toBe(403);
    expect(guardRequest(req("/api/cancel", { method: "POST", headers: { origin: "null" } }), LOCAL)?.status).toBe(403);
    // Another local port is another origin too.
    expect(guardRequest(req("/api/dev/proxies", { method: "POST", headers: { origin: "http://127.0.0.1:8080", "content-type": "application/json" } }), LOCAL)?.status).toBe(403);
    expect(guardRequest(req("/api/deposit", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }), LOCAL)?.status).toBe(403);
    // Even a read of the console, which a rebinding page could otherwise see.
    expect(guardRequest(req("/api/dev/proxies", { headers: { "sec-fetch-site": "cross-site" } }), LOCAL)?.status).toBe(403);
  });

  it("refuses a host name that is not this machine's (DNS rebinding)", () => {
    expect(guardRequest(req("/api/dev/overview", { headers: { host: "attacker.example:3000" } }), LOCAL)?.status).toBe(421);
    expect(guardRequest(req("/api/dev/overview", { headers: { host: "[::1]:3000" } }), LOCAL)).toBeNull();
    expect(guardRequest(req("/api/dev/overview", { headers: { host: "localhost" } }), LOCAL)).toBeNull();
    expect(guardRequest(req("/api/pool", { headers: { host: "node.lan:3000" } }), { ...LOCAL, allowedHosts: "node.lan" })).toBeNull();
  });

  it("serves any host name on a network bind unless the owner lists them", () => {
    expect(guardRequest(req("/api/pool", { headers: { host: "192.168.1.5:3000" } }), { bindHost: "0.0.0.0" })).toBeNull();
    expect(guardRequest(req("/api/pool", { headers: { host: "other.example" } }), { bindHost: "0.0.0.0", allowedHosts: "node.example" })?.status).toBe(421);
  });

  it("only takes JSON for control panel writes", () => {
    expect(guardRequest(req("/api/dev/node", { method: "POST", headers: { "content-type": "text/plain" } }), LOCAL)?.status).toBe(415);
    expect(guardRequest(req("/api/dev/node", { method: "POST" }), LOCAL)?.status).toBe(415);
    expect(guardRequest(req("/api/dev/node", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" } }), LOCAL)).toBeNull();
  });
});

describe("bindRefusal", () => {
  it("allows loopback binds, and a network bind only with DEV_PASSWORD", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(bindRefusal("127.0.0.1", {})).toBeNull();
    expect(bindRefusal("0.0.0.0", {})).toMatch(/DEV_PASSWORD/);
    expect(bindRefusal("192.168.1.5", {})).toMatch(/DEV_PASSWORD/);
    expect(bindRefusal("0.0.0.0", { DEV_PASSWORD: "x" })).toBeNull();
  });
});

describe("the app", () => {
  it("refuses before any handler runs", async () => {
    const { createApp } = await import("../app");
    const app = createApp();
    const evil = await app.request("http://127.0.0.1:3000/api/dev/node", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "https://evil.example", "content-type": "text/plain" }, body: '{"action":"hub-unlink"}' });
    expect(evil.status).toBe(403);
    const rebound = await app.request("http://attacker.example:3000/api/dev/overview", { headers: { host: "attacker.example:3000" } });
    expect(rebound.status).toBe(421);
    // The public endpoint that listed everyone's open withdraws is gone.
    const gone = await app.request("http://127.0.0.1:3000/api/withdraw-requests", { headers: { host: "127.0.0.1:3000" } });
    expect(gone.status).toBe(404);
  });
});
