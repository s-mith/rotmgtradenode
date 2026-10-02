import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretKeyError, isSealed, open, resetSecretKey, seal, secretKey } from "../secrets";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
  resetSecretKey();
  vi.stubEnv("ROTMGTRADE_SECRET_KEY", "");
  vi.stubEnv("RELAY_DATA_DIR", "");
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
    // Windows has no POSIX modes (every file reads 0666); the profile folder's per-user ACLs keep it private there.
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "secret_key")).mode & 0o777).toBe(0o600);
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
  it("never makes a new key over sealed credentials it has no key for", () => {
    const key = secretKey(dir);
    fs.mkdirSync(path.join(dir, "relay"));
    fs.writeFileSync(path.join(dir, "relay", "Accounts.json"), seal("[]", key));
    // The key file is lost (or the data dir is started without the shell's keychain key).
    fs.rmSync(path.join(dir, "secret_key"));
    fs.rmSync(path.join(dir, "secret_key.check"));
    resetSecretKey();
    expect(() => secretKey(dir)).toThrow(SecretKeyError);
    expect(fs.existsSync(path.join(dir, "secret_key"))).toBe(false);
  });
  it("refuses a key that does not open this data dir's sealed data", () => {
    secretKey(dir);
    expect(fs.existsSync(path.join(dir, "secret_key.check"))).toBe(true);
    resetSecretKey();
    vi.stubEnv("ROTMGTRADE_SECRET_KEY", Buffer.alloc(32, 9).toString("base64"));
    expect(() => secretKey(dir)).toThrow(/does not open/);
  });
  it("checks sealed data written before the check file existed", () => {
    const old = Buffer.alloc(32, 3);
    fs.mkdirSync(path.join(dir, "relay"));
    fs.writeFileSync(path.join(dir, "relay", "node.json"), JSON.stringify({ hub: { privateKeyPemSealed: seal("pem", old) } }));
    fs.writeFileSync(path.join(dir, "secret_key"), Buffer.alloc(32, 4).toString("base64"));
    expect(() => secretKey(dir)).toThrow(SecretKeyError);
    resetSecretKey();
    fs.writeFileSync(path.join(dir, "secret_key"), old.toString("base64"));
    expect(secretKey(dir).equals(old)).toBe(true);
    expect(fs.existsSync(path.join(dir, "secret_key.check"))).toBe(true);
  });
});
