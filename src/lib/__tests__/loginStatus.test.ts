// Linking a character needs a live session; a lapsed one is caught before the poll spends the code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db";

let db: Database.Database;
const pollLogin = vi.fn();
vi.mock("@/lib/login", () => ({ pollLogin: (...a: unknown[]) => pollLogin(...a) }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("../db")>()), getDb: () => db }));

beforeEach(() => {
  db = openDatabase(":memory:");
  pollLogin.mockReset();
});
afterEach(() => db.close());

function post(body: unknown) {
  return new Request("http://127.0.0.1:3000/api/login/status", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) });
}

describe("POST /api/login/status", () => {
  it("does not spend the code when a link has no session", async () => {
    const { POST } = await import("@/server/api/login/status/route");
    const r = await POST(post({ code: "ABCD2345EF", link: true }));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ state: "logged-out" });
    expect(pollLogin).not.toHaveBeenCalled();
  });
  it("logs in with a verified code", async () => {
    pollLogin.mockResolvedValue({ ok: true, state: "verified", ign: "Comrade" });
    const { POST } = await import("@/server/api/login/status/route");
    const r = await POST(post({ code: "ABCD2345EF" }));
    expect(await r.json()).toMatchObject({ ok: true, state: "verified", ign: "Comrade" });
    expect(r.headers.get("set-cookie")).toMatch(/rc_ign=/);
  });
  it("says so when the verified name is unusable: the code is spent, so the page must not poll on into \"expired\"", async () => {
    pollLogin.mockResolvedValue({ ok: true, state: "verified", ign: "Not A Name!" });
    const { POST } = await import("@/server/api/login/status/route");
    const r = await POST(post({ code: "ABCD2345EF" }));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ state: "verified", error: expect.any(String) });
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("clientIp", () => {
  it("only believes forwarding headers from a trusted proxy", async () => {
    const { clientIp, noteSocketAddress } = await import("../ratelimit");
    const viaLan = new Request("http://x/", { headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" } });
    noteSocketAddress(viaLan, "192.168.1.20");
    expect(clientIp(viaLan)).toBe("192.168.1.20");
    const viaLocalProxy = new Request("http://x/", { headers: { "x-forwarded-for": "9.9.9.9, 5.6.7.8" } });
    noteSocketAddress(viaLocalProxy, "::ffff:127.0.0.1");
    expect(clientIp(viaLocalProxy)).toBe("5.6.7.8");
    vi.stubEnv("TRUSTED_PROXIES", "10.1.1.1");
    const viaListed = new Request("http://x/", { headers: { "x-real-ip": "1.2.3.4" } });
    noteSocketAddress(viaListed, "10.1.1.1");
    expect(clientIp(viaListed)).toBe("1.2.3.4");
    vi.unstubAllEnvs();
  });
});
