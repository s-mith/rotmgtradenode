// The hub's login node: codes the hub minted go to the login desk, the hub
// hears which bot to whisper, and the character that whispered a code is
// reported back. The hub and the desk are scripted.
import { describe, expect, it } from "vitest";
import { RealmLoginRunner } from "../realmLogins";
import { LoginCodes } from "../../relay/fleet/stores";
import type { HubClient } from "../hub";

function fakeHub(logins: { id: number; code: string; expiresAt: number }[], opts: { failVerified?: number } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let failVerified = opts.failVerified ?? 0;
  const hub = {
    loginNode: true,
    signed: async (method: string, path: string, body: unknown = {}) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("/api/v1/realm-logins/pending")) return { ok: true as const, data: { logins: logins.splice(0) } };
      if (path.endsWith("/verified") && failVerified > 0) {
        failVerified--;
        return { ok: false as const, status: 0, error: "hub unreachable" };
      }
      return { ok: true as const, data: { ok: true } };
    },
  } as unknown as Pick<HubClient, "signed" | "loginNode">;
  return { hub, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("RealmLoginRunner", () => {
  it("registers each code at the login desk, names the bot to whisper, and reports who whispered it", async () => {
    const codes = new LoginCodes();
    const { hub, calls } = fakeHub([{ id: 7, code: "ABCD2345", expiresAt: Date.now() + 600_000 }]);
    const r = new RealmLoginRunner({ hub, codes, desk: () => ({ ign: "DeskBot", server: "USWest4" }), log: () => {}, sleep: async () => {} });
    r.listen();
    expect(await r.pollOnce()).toBe(1);
    await settle();
    expect(calls.find((c) => c.path === "/api/v1/realm-logins/7/ready")?.body).toEqual({ botIgn: "DeskBot", server: "USWest4" });
    // Somebody whispers the code: Realm names them "Name,1a2b" on some packets.
    expect(codes.noteTell("Somebody,1a2b", "ABCD2345")).toBe(true);
    await settle();
    expect(calls.find((c) => c.path === "/api/v1/realm-logins/7/verified")?.body).toEqual({ ign: "Somebody" });
    expect(r.status()).toMatchObject({ served: 1, pending: 0 });
    // A code nobody registered is nobody's login.
    expect(codes.noteTell("Other", "ZZZZ9999")).toBe(false);
    r.stop();
  });

  it("tells the hub when no desk bot came in time, and sends a verified login again after the hub was unreachable", async () => {
    const codes = new LoginCodes();
    let t = 0;
    const { hub, calls } = fakeHub([{ id: 8, code: "EFGH2345", expiresAt: 600_000 }], { failVerified: 1 });
    let desk: { ign: string; server: string | null } | null = null;
    const r = new RealmLoginRunner({ hub, codes, desk: () => desk, log: () => {}, now: () => t, sleep: async (ms) => { t += ms; } });
    r.listen();
    await r.pollOnce();
    await settle();
    expect(calls.find((c) => c.path === "/api/v1/realm-logins/8/ready")?.body).toMatchObject({ error: expect.stringContaining("no login bot") });

    // Next time a desk is there; the hub is down when the whisper lands, and hears of it on the next round.
    desk = { ign: "DeskBot", server: null };
    const again = fakeHub([{ id: 9, code: "JKLM2345", expiresAt: 600_000 }], { failVerified: 1 });
    const r2 = new RealmLoginRunner({ hub: again.hub, codes, desk: () => desk, log: () => {}, now: () => t, sleep: async () => {} });
    r2.listen();
    await r2.pollOnce();
    await settle();
    codes.noteTell("Player", "JKLM2345");
    await settle();
    expect(again.calls.filter((c) => c.path === "/api/v1/realm-logins/9/verified")).toHaveLength(1);
    await r2.pollOnce();
    expect(again.calls.filter((c) => c.path === "/api/v1/realm-logins/9/verified")).toHaveLength(2);
    r.stop();
    r2.stop();
  });
});
