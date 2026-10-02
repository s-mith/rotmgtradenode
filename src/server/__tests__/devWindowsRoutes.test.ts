// The control panel's routes for the first-run setup, the status card, the
// diagnostics, the proxy actions and waking up, over the embedded relay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dev-routes-"));
vi.stubEnv("PYRELAY_AUTH", "secret");
vi.stubEnv("PYRELAY_URL", "");
vi.stubEnv("DATA_DIR", tmp);
vi.stubEnv("NODE_MODE", "local");
vi.stubEnv("DEV_PASSWORD", "");
// Nothing here goes out to the network: the hub's version feed answers 503 (the fleet's hub client keeps the fetch it was built with).
const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response("{}", { status: 503 }));
vi.stubGlobal("fetch", fetchMock);

const { registerEmbeddedRelay } = await import("@/lib/devauth");
const { openDatabase } = await import("@/lib/db");
const { Fleet } = await import("@/relay/fleet/fleet");
const { createControlPlane } = await import("@/relay/controlPlane");
const { guardRequest } = await import("@/server/guard");
const setupRoute = await import("@/server/api/dev/setup/route");
const statusRoute = await import("@/server/api/dev/status/route");
const diagnosticsRoute = await import("@/server/api/dev/diagnostics/route");
const proxiesRoute = await import("@/server/api/dev/proxies/route");
const nodeRoute = await import("@/server/api/dev/node/route");

let fleet: InstanceType<typeof Fleet>;
beforeAll(() => {
  globalThis.__pool_db__ = openDatabase(":memory:");
  const dataDir = path.join(tmp, "relay");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "BotOne", guid: "bot1@example.com", password: "hunter2pw", server: "USSouth3", seasonal: true }]));
  fleet = new Fleet({ dataDir, buildVersion: "7.0.0.2.0", log: () => {}, proxies: { file: path.join(dataDir, "proxies.txt"), stateFile: path.join(dataDir, "proxy_settings.json") } });
  registerEmbeddedRelay(createControlPlane(fleet, () => "secret"));
});
afterAll(() => {
  vi.unstubAllGlobals();
  registerEmbeddedRelay(undefined);
  fleet.stop();
  globalThis.__pool_db__?.close();
  globalThis.__pool_db__ = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (route: { GET: (r: Request) => Promise<Response> }, p: string) => {
  const res = await route.GET(new Request(`http://127.0.0.1:3000${p}`));
  return { status: res.status, body: await res.json() };
};
const post = async (route: { POST: (r: Request) => Promise<Response> }, p: string, body: unknown) => {
  const res = await route.POST(new Request(`http://127.0.0.1:3000${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("/api/dev/setup", () => {
  it("shows the steps and takes the actions", async () => {
    let r = await get(setupRoute, "/api/dev/setup");
    expect(r).toMatchObject({ status: 200, body: { ok: true, complete: false, steps: { accounts: { count: 1 }, connection: { mode: "none" } } } });
    r = await post(setupRoute, "/api/dev/setup", { action: "skip-hub" });
    expect(r.body.steps.hub).toEqual({ done: true, linked: false, skipped: true });
    expect((await post(setupRoute, "/api/dev/setup", { action: "launch" })).status).toBe(400);
    expect(await post(setupRoute, "/api/dev/setup", { action: "test-login" })).toEqual({ status: 409, body: { error: "Set up how your bots connect first: proxies, or your own internet." } });
  });
});

describe("/api/dev/proxies actions", () => {
  it("reads a list, refuses own internet without the risk confirmed, and saves the old way too", async () => {
    let r = await post(proxiesRoute, "/api/dev/proxies", { action: "parse", text: "alice:s3cret@1.2.3.4:1080\nnope\n" });
    expect(r.body).toMatchObject({ ok: true, count: 1, lines: [{ line: 1, ok: true, display: "1.2.3.4:1080" }, { line: 2, ok: false }] });
    expect(JSON.stringify(r.body)).not.toContain("s3cret");
    expect((await post(proxiesRoute, "/api/dev/proxies", { action: "parse" })).status).toBe(400);
    expect(await post(proxiesRoute, "/api/dev/proxies", { action: "own-internet", allow: true })).toEqual({ status: 400, body: { error: "Please confirm you understand the risk" } });
    r = await post(proxiesRoute, "/api/dev/proxies", { action: "own-internet", allow: true, acknowledged: true });
    expect(r.body).toMatchObject({ ok: true, required: false });
    expect((await get(setupRoute, "/api/dev/setup")).body.steps.connection.mode).toBe("own");
    expect((await post(proxiesRoute, "/api/dev/proxies", { action: "test" })).status).toBe(409);
    expect((await post(proxiesRoute, "/api/dev/proxies", { action: "test", hosts: [7] })).status).toBe(400);
    expect((await post(proxiesRoute, "/api/dev/proxies", { action: "fly" })).status).toBe(400);
    r = await post(proxiesRoute, "/api/dev/proxies", { text: "1.2.3.4:1080:alice:s3cret\n" });
    expect(r.body).toMatchObject({ saved: { count: 1, error: null }, lines: [{ ok: true }] });
    await post(proxiesRoute, "/api/dev/proxies", { action: "own-internet", allow: false });
  });
});

describe("/api/dev/status and /api/dev/diagnostics", () => {
  it("words the status with the site's facts", async () => {
    const r = await get(statusRoute, "/api/dev/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: "needs-setup", headline: "Finish setting up", problems: [{ id: "setup", fix: { kind: "link", href: "/setup" } }] });
  });

  it("still has words when the bots' part does not answer", async () => {
    registerEmbeddedRelay(undefined);
    try {
      const r = await get(statusRoute, "/api/dev/status");
      expect(r.body).toMatchObject({ ok: true, state: "problem", headline: "The bots' part of the app isn't answering", error: expect.any(String) });
      const d = await get(diagnosticsRoute, "/api/dev/diagnostics");
      expect(d.body.text).toMatch(/did not answer/);
    } finally {
      registerEmbeddedRelay(createControlPlane(fleet, () => "secret"));
    }
  });

  it("gives the diagnostics text with the website's side, nothing private", async () => {
    const r = await get(diagnosticsRoute, "/api/dev/diagnostics");
    expect(r.status).toBe(200);
    const text: string = r.body.text;
    expect(text).toMatch(/^rotmg trade node: diagnostics\n/);
    expect(text).toContain("== Website side ==");
    expect(text).toContain("Open requests: 0 deposit(s), 0 withdraw(s)");
    expect(text).toContain("b***@example.com");
    for (const secret of ["bot1@example.com", "hunter2pw", "s3cret"]) expect(text).not.toContain(secret);
  });
});

describe("/api/dev/node: waking up and checking the build", () => {
  it("resumes and checks again", async () => {
    expect((await post(nodeRoute, "/api/dev/node", { action: "resume" })).body).toEqual({ ok: true, stopped: 0, proxies: 0 });
    const r = await post(nodeRoute, "/api/dev/node", { action: "check-build" });
    expect(r.body).toMatchObject({ ok: true, build: { held: false }, message: "Nothing is paused: bots can log in." });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("https://rotmg.trade/api/v1/version");
  });
});

describe("the request guard covers the new routes", () => {
  const LOCAL = { bindHost: "127.0.0.1" };
  it("refuses another site's posts and non-JSON writes", () => {
    const req = (p: string, headers: Record<string, string>) => new Request(`http://127.0.0.1:3000${p}`, { method: "POST", headers: { host: "127.0.0.1:3000", ...headers } });
    expect(guardRequest(req("/api/dev/setup", { origin: "https://evil.example", "content-type": "application/json" }), LOCAL)?.status).toBe(403);
    expect(guardRequest(req("/api/dev/node", { "content-type": "text/plain" }), LOCAL)?.status).toBe(415);
    expect(guardRequest(new Request("http://127.0.0.1:3000/api/dev/diagnostics", { headers: { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" } }), LOCAL)?.status).toBe(403);
    // The desktop app's own call on waking up: no Origin, JSON.
    expect(guardRequest(req("/api/dev/node", { "content-type": "application/json" }), LOCAL)).toBeNull();
  });
});
