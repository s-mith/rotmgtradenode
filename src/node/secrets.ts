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

/** Thrown when sealed data exists but no key, or the wrong key, is at hand. Never papered over with a fresh key. */
export class SecretKeyError extends Error {}

const CHECK_FILE = "secret_key.check";
const CHECK_TEXT = "rotmgtradenode sealing key";

function readKeyFile(file: string): Buffer | null {
  try {
    const b = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/**
 * One sealed string already on disk (the roster, the hub link's key), so a
 * key can be checked against data written before the check file existed.
 */
export function sealedSample(dataDir: string): { file: string; sealed: string } | null {
  const relay = process.env.RELAY_DATA_DIR || path.join(dataDir, "relay");
  for (const file of [path.join(relay, "Accounts.json"), path.join(relay, "node.json"), path.join(dataDir, "node.json")]) {
    try {
      const m = /rt1:[A-Za-z0-9+/=]+/.exec(fs.readFileSync(file, "utf8"));
      if (m) return { file, sealed: m[0] };
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * The sealing key: env first, else the data-dir file. A new key is only
 * minted when nothing sealed exists yet; a missing or different key in front
 * of sealed data is an error, because sealing anything new with a fresh key
 * would orphan every stored password for good.
 */
export function secretKey(dataDir = process.env.DATA_DIR || "./data"): Buffer {
  if (cached) return cached;
  const file = path.join(dataDir, KEY_FILE);
  const checkFile = path.join(dataDir, CHECK_FILE);
  const env = keyFromEnv();
  let key = env ?? readKeyFile(file);
  if (!key) {
    const sample = sealedSample(dataDir);
    if (sample || fs.existsSync(checkFile)) {
      throw new SecretKeyError(
        `sealed credentials exist (${sample?.file ?? checkFile}) but the sealing key is missing: ${env === null && process.env.ROTMGTRADE_SECRET_KEY ? "ROTMGTRADE_SECRET_KEY is not a 32-byte base64 key" : `restore ${file} (or run the node the way it was set up, e.g. the desktop app)`}. Refusing to make a new key, which would lose them.`,
      );
    }
    key = randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    if (!env) fs.writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600 });
  }
  // The key must open what is already sealed: the check file, else whatever sealed data predates it.
  let check: string | null = null;
  try {
    check = fs.readFileSync(checkFile, "utf8").trim();
  } catch {
    // first run with a check file
  }
  const probe = check ?? sealedSample(dataDir)?.sealed ?? null;
  if (probe) {
    let opened: string | null = null;
    try {
      opened = open(probe, key);
    } catch {
      opened = null;
    }
    if (opened === null || (check !== null && opened !== CHECK_TEXT)) {
      throw new SecretKeyError(`the sealing key ${env ? "from ROTMGTRADE_SECRET_KEY" : `in ${file}`} does not open this data dir's sealed credentials (${dataDir}). Run the node with the key it was set up with; refusing to continue, which would lose them.`);
    }
  }
  if (check === null) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(checkFile, seal(CHECK_TEXT, key) + "\n", { mode: 0o600 });
    } catch {
      // read-only data dir: the sample check above still guards it
    }
  }
  return (cached = key);
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
