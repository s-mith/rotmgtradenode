// The node's process configuration. rotmgcommunism was configured by a
// dozen env vars set on a Railway service; the node is one program a player
// runs, so everything gets a default here and `npm start` (or the Electron
// shell) just works. Explicit env still wins for anyone who wants it.
//
// Local mode (design doc §4.3): the server binds to loopback, the fleet and
// the onboarding service run in-process, and the operator console needs no
// password because only this machine can reach it.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface NodeConfig {
  mode: "local";
  dataDir: string;
  host: string;
  port: number;
}

function setDefault(key: string, value: string): void {
  if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
}

/** Read-or-create a secret file; the value only ever lives in the data dir. */
function persistedSecret(file: string): string {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch {
    // create below
  }
  const v = randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, v + "\n", { mode: 0o600 });
  return v;
}

export function applyNodeDefaults(): NodeConfig {
  const dataDir = path.resolve(process.env.ROTMGTRADE_DATA_DIR || process.env.DATA_DIR || "./data");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  setDefault("NODE_MODE", "local");
  setDefault("RELAY_DATA_DIR", path.join(dataDir, "relay"));
  setDefault("ACCOUNTGEN_DATA_DIR", path.join(dataDir, "onboarding"));
  setDefault("RELAY_EMBEDDED", "1");
  setDefault("ACCOUNTGEN_EMBEDDED", "1");
  // Loopback only: the operator console trusts every request in local mode.
  setDefault("HOST", "127.0.0.1");
  setDefault("PORT", "3000");
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = persistedSecret(path.join(dataDir, "session_secret"));
  // Nothing outside this process reaches the control plane; a per-boot token is enough.
  if (!process.env.PYRELAY_AUTH) process.env.PYRELAY_AUTH = randomBytes(24).toString("base64url");
  // A home connection is the whole point: no exit-IP list unless the owner sets one.
  setDefault("PROXIES_URL", "");
  return { mode: "local", dataDir, host: process.env.HOST!, port: Number(process.env.PORT) };
}

/** True when the operator console may be used without a password. */
export function isLocalMode(): boolean {
  return (process.env.NODE_MODE ?? "local") === "local" && !process.env.DEV_PASSWORD;
}
