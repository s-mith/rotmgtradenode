import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "../hub";
import { NodeSettingsStore } from "../settings";
import { resetSecretKey } from "../secrets";
import { verifyRequest } from "../../shared/hubWire";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  vi.stubEnv("DATA_DIR", dir);
  resetSecretKey();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetSecretKey();
});

/** A hub in a closure: records what it saw, verifies signatures with the key it was given at link time. */
function fakeHub(opts: { minNodeVersion?: string; knownBuilds?: string[]; failLink?: boolean } = {}) {
  const seen: { path: string; body: unknown; verified: boolean | null }[] = [];
  let publicKey = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = { get: (k: string) => ((init?.headers ?? {}) as Record<string, string>)[k] ?? null };
    const pathq = url.pathname + url.search;
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (pathq === "/api/v1/version") return json({ minNodeVersion: opts.minNodeVersion ?? "0.1.0", latestNodeVersion: "0.1.0", downloadUrl: "", build: { gameVersion: "7.0.0.2.0", knownBuilds: opts.knownBuilds ?? [], updatedAt: 1 } });
    if (pathq === "/api/v1/nodes/link") {
      if (opts.failLink) return json({ error: "bad password" }, 401);
      const b = JSON.parse(body);
      publicKey = b.publicKey;
      seen.push({ path: pathq, body: b, verified: null });
      return json({ nodeId: "node-abc", userId: 7, displayName: "Owner" });
    }
    const verified = verifyRequest(publicKey, headers, init?.method ?? "GET", pathq, body).ok;
    seen.push({ path: pathq, body: body ? JSON.parse(body) : null, verified });
    if (!verified) return json({ error: "bad signature" }, 401);
    if (pathq === "/api/v1/nodes/heartbeat") return json({ ok: true, serverTime: 5, minNodeVersion: opts.minNodeVersion ?? "0.1.0" });
    if (pathq === "/api/v1/nodes/unlink") return json({ ok: true });
    return json({ error: "no such route" }, 404);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function client(hub: ReturnType<typeof fakeHub>, settings = NodeSettingsStore.at(dir), onKnownBuilds?: (b: string[]) => void) {
  const log: string[] = [];
  return { c: new HubClient({ settings, nodeVersion: "0.1.0", bots: () => [{ ign: "Bot", seasonal: true, online: false }], build: () => "7.0.0.2.0", log: (l) => log.push(l), fetchImpl: hub.fetchImpl, onKnownBuilds }), log, settings };
}

describe("HubClient", () => {
  it("links with the password once, then signs everything with the node key", async () => {
    const hub = fakeHub();
    const { c, settings } = client(hub);
    expect(c.linked).toBe(false);
    const r = await c.linkTo("https://hub.example/", "me@x", "pw", "desk");
    expect(r).toMatchObject({ ok: true, data: { nodeId: "node-abc" } });
    c.stop();
    const link = settings.get().hub!;
    expect(link).toMatchObject({ url: "https://hub.example", nodeId: "node-abc", email: "me@x" });
    expect(link.privateKeyPemSealed.startsWith("rt1:")).toBe(true);
    expect(settings.get().telemetry.hubUrl).toBe("https://hub.example");
    expect(await c.sendHeartbeat()).toBe(true);
    const hb = hub.seen.find((s) => s.path === "/api/v1/nodes/heartbeat")!;
    expect(hb.verified).toBe(true);
    expect(hb.body).toMatchObject({ version: "0.1.0", build: "7.0.0.2.0", bots: [{ ign: "Bot" }] });
    expect(c.status()).toMatchObject({ linked: true, lastHeartbeatAt: expect.any(Number), lastError: null });
    // A signed GET verifies over the empty body it actually sends.
    expect((await c.signed("GET", "/api/v1/rendezvous/mine")).ok).toBe(false); // fake hub has no such route, but the signature checks
    expect(hub.seen.at(-1)).toMatchObject({ path: "/api/v1/rendezvous/mine", verified: true });
    // The link survives a restart: a fresh client on the same settings still signs correctly.
    const again = client(hub, NodeSettingsStore.at(dir));
    expect(await again.c.sendHeartbeat()).toBe(true);
  });

  it("a refused link stores nothing; unlinking forgets the key", async () => {
    const bad = fakeHub({ failLink: true });
    const { c, settings } = client(bad);
    expect(await c.linkTo("https://hub.example", "me@x", "wrong", "desk")).toMatchObject({ ok: false, status: 401, error: "bad password" });
    expect(settings.get().hub).toBeNull();
    const good = fakeHub();
    const g = client(good, settings);
    await g.c.linkTo("https://hub.example", "me@x", "pw", "desk");
    g.c.stop();
    await g.c.unlink();
    expect(settings.get().hub).toBeNull();
    expect(good.seen.some((s) => s.path === "/api/v1/nodes/unlink" && s.verified)).toBe(true);
    expect(await g.c.sendHeartbeat()).toBe(false);
  });

  it("reads the version feed: an outdated node knows it, and hub-confirmed builds reach the gate", async () => {
    const hub = fakeHub({ minNodeVersion: "0.2.0", knownBuilds: ["7.0.0.3.0"] });
    const got: string[][] = [];
    const { c } = client(hub, undefined, (b) => got.push(b));
    await c.linkTo("https://hub.example", "me@x", "pw", "desk");
    c.stop();
    await c.refreshVersion();
    expect(c.outdated).toBe(true);
    expect(got.at(-1)).toEqual(["7.0.0.3.0"]);
    expect(c.status().version?.minNodeVersion).toBe("0.2.0");
  });

  it("a hub that is down is an error, not a crash", async () => {
    const down = { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch, seen: [] };
    const { c } = client(down);
    expect(await c.linkTo("https://hub.example", "me@x", "pw", "desk")).toMatchObject({ ok: false, status: 0 });
    expect(c.status().lastError).toMatch(/unreachable/);
  });
});
