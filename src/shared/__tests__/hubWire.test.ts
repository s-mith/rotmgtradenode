import { describe, expect, it } from "vitest";
import { canonicalString, compareVersions, generateNodeKeypair, NonceCache, signRequest, verifyRequest, MAX_CLOCK_SKEW_MS } from "../hubWire";

const H = (hs: object) => { const h = hs as Record<string, string>; return { get: (k: string) => h[k] ?? h[k.toLowerCase()] ?? null }; };

describe("hub wire signatures", () => {
  const kp = generateNodeKeypair();
  const body = JSON.stringify({ version: "0.1.0" });
  it("signs and verifies the canonical string", () => {
    const h = signRequest(kp.privateKeyPem, "node-1", "post", "/api/v1/nodes/heartbeat", body, 1000);
    expect(verifyRequest(kp.publicKeyPem, H(h), "POST", "/api/v1/nodes/heartbeat", body, 1000)).toEqual({ ok: true, nonce: h["X-Node-Nonce"], ts: 1000 });
    expect(canonicalString("node-1", 1000, "post", "/x", "")).toMatch(/^v1\nnode-1\n1000\nPOST\n\/x\n[0-9a-f]{64}$/);
  });
  it("refuses a changed body, path, method, key, or a stale clock", () => {
    const h = signRequest(kp.privateKeyPem, "node-1", "POST", "/api/v1/x", body, 1000);
    expect(verifyRequest(kp.publicKeyPem, H(h), "POST", "/api/v1/x", body + " ", 1000)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(verifyRequest(kp.publicKeyPem, H(h), "POST", "/api/v1/y", body, 1000)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(verifyRequest(kp.publicKeyPem, H(h), "GET", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(verifyRequest(generateNodeKeypair().publicKeyPem, H(h), "POST", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(verifyRequest(kp.publicKeyPem, H(h), "POST", "/api/v1/x", body, 1000 + MAX_CLOCK_SKEW_MS + 1)).toMatchObject({ ok: false, reason: "clock-skew" });
    expect(verifyRequest(kp.publicKeyPem, H({}), "POST", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "missing-headers" });
    expect(verifyRequest(kp.publicKeyPem, H({ ...h, "X-Node-Ts": "soon" }), "POST", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "bad-timestamp" });
  });
  it("signs the nonce: a changed or missing one does not verify, and a cache takes each once within the clock window", () => {
    const h = signRequest(kp.privateKeyPem, "node-1", "POST", "/api/v1/x", body, 1000);
    expect(verifyRequest(kp.publicKeyPem, H({ ...h, "X-Node-Nonce": "AAAAAAAAAAAAAAAAAAAAAA" }), "POST", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "bad-signature" });
    const { "X-Node-Nonce": _n, ...bare } = h;
    expect(verifyRequest(kp.publicKeyPem, H(bare), "POST", "/api/v1/x", body, 1000)).toMatchObject({ ok: false, reason: "missing-headers" });
    expect(signRequest(kp.privateKeyPem, "node-1", "POST", "/api/v1/x", body, 1000)["X-Node-Nonce"]).not.toBe(h["X-Node-Nonce"]);
    const cache = new NonceCache();
    expect(cache.take("node-1", "n1", 1000, 1000)).toBe(true);
    expect(cache.take("node-1", "n1", 1000, 2000)).toBe(false);
    expect(cache.take("node-2", "n1", 1000, 2000)).toBe(true);
    expect(cache.take("node-1", "n1", 1000, 1000 + MAX_CLOCK_SKEW_MS + 2000)).toBe(true);
  });
  it("compares versions numerically", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "0.9.9")).toBeGreaterThan(0);
  });
});
