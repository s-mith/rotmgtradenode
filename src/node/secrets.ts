// Credentials at rest. The roster (Accounts.json) and the onboarding pool
// hold game passwords, and a node lives on a player's machine, so they are
// sealed with a key that is not in the file next to them:
//
//   - under the Electron shell, the key comes from the OS keychain
//     (safeStorage) and reaches this process as ROTMGTRADE_SECRET_KEY;
//   - without the shell, it is a 0600 file in the data dir, which keeps the
//     passwords out of casual reads and backups but not away from someone
//     who can read that directory.
//
// Sealed strings are "rt1:" + base64(iv | tag | ciphertext), AES-256-GCM.
// Anything without the prefix is returned as it was, so files written before
// sealing existed still load, and are sealed on their next write.
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "rt1:";
const KEY_FILE = "secret_key";
let cached: Buffer | null = null;

function keyFromEnv(): Buffer | null {
  const raw = (process.env.ROTMGTRADE_SECRET_KEY ?? "").trim();
  if (!raw) return null;
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

/** The sealing key: env first, else the data-dir file (created on first use). */
export function secretKey(dataDir = process.env.DATA_DIR || "./data"): Buffer {
  if (cached) return cached;
  const env = keyFromEnv();
  if (env) return (cached = env);
  const file = path.join(dataDir, KEY_FILE);
  try {
    const b = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (b.length === 32) return (cached = b);
  } catch {
    // create below
  }
  const b = randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, b.toString("base64") + "\n", { mode: 0o600 });
  return (cached = b);
}

/** Tests: forget the cached key. */
export function resetSecretKey(): void {
  cached = null;
}

export function isSealed(s: string): boolean {
  return s.startsWith(PREFIX);
}

export function seal(plain: string, key = secretKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** Unseal, or hand back a plaintext string untouched. Throws on a sealed string the key does not open. */
export function open(s: string, key = secretKey()): string {
  if (!isSealed(s)) return s;
  const buf = Buffer.from(s.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
