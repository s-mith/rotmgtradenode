import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSealed, open, resetSecretKey, seal, secretKey } from "../secrets";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
  resetSecretKey();
  vi.stubEnv("ROTMGTRADE_SECRET_KEY", "");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetSecretKey();
  vi.unstubAllEnvs();
});

describe("secrets", () => {
  it("round-trips, leaves plaintext alone, and never repeats a ciphertext", () => {
    const key = secretKey(dir);
    const a = seal("hunter2", key);
    expect(isSealed(a)).toBe(true);
    expect(open(a, key)).toBe("hunter2");
    expect(seal("hunter2", key)).not.toBe(a);
    expect(open("hunter2", key)).toBe("hunter2");
  });
  it("creates the key file once, mode 0600, and rejects the wrong key", () => {
    const key = secretKey(dir);
    expect(fs.statSync(path.join(dir, "secret_key")).mode & 0o777).toBe(0o600);
    resetSecretKey();
    expect(secretKey(dir).equals(key)).toBe(true);
    const sealed = seal("x", key);
    expect(() => open(sealed, Buffer.alloc(32, 1))).toThrow();
  });
  it("prefers the key from the environment (the Electron shell's keychain)", () => {
    const k = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("ROTMGTRADE_SECRET_KEY", k);
    resetSecretKey();
    expect(secretKey(dir).equals(Buffer.alloc(32, 7))).toBe(true);
    expect(fs.existsSync(path.join(dir, "secret_key"))).toBe(false);
  });
});
