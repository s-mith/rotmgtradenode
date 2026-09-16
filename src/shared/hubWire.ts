// The node ↔ hub wire (docs/hub-protocol.md): request signing with the
// node's Ed25519 key, and the payload types both sides agree on. This file
// is what the hub imports from the public repo; keep it free of node-only
// dependencies.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const WIRE_VERSION = "v1";
/** A signature older or newer than this is refused. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface NodeKeypair {
  /** PEM, PKCS#8. Sealed at rest on the node (src/node/secrets.ts). */
  privateKeyPem: string;
  /** PEM, SPKI. What the hub stores. */
  publicKeyPem: string;
}

export function generateNodeKeypair(): NodeKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The string both sides sign / verify. `pathWithQuery` is everything after the host. */
export function canonicalString(nodeId: string, ts: number, method: string, pathWithQuery: string, body: string): string {
  return [WIRE_VERSION, nodeId, String(ts), method.toUpperCase(), pathWithQuery, bodyHash(body)].join("\n");
}

export interface SignedHeaders {
  "X-Node-Id": string;
  "X-Node-Ts": string;
  "X-Node-Sig": string;
}

export function signRequest(privateKeyPem: string, nodeId: string, method: string, pathWithQuery: string, body: string, ts = Date.now()): SignedHeaders {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonicalString(nodeId, ts, method, pathWithQuery, body), "utf8"), key);
  return { "X-Node-Id": nodeId, "X-Node-Ts": String(ts), "X-Node-Sig": sig.toString("base64url") };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing-headers" | "bad-timestamp" | "clock-skew" | "bad-signature" };

/** The hub's side: check the headers against the node's stored public key. */
export function verifyRequest(publicKeyPem: string, headers: { get(name: string): string | null | undefined }, method: string, pathWithQuery: string, body: string, now = Date.now()): VerifyResult {
  const nodeId = headers.get("x-node-id") ?? headers.get("X-Node-Id");
  const tsRaw = headers.get("x-node-ts") ?? headers.get("X-Node-Ts");
  const sigRaw = headers.get("x-node-sig") ?? headers.get("X-Node-Sig");
  if (!nodeId || !tsRaw || !sigRaw) return { ok: false, reason: "missing-headers" };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad-timestamp" };
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: "clock-skew" };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonicalString(nodeId, ts, method, pathWithQuery, body), "utf8"), createPublicKey(publicKeyPem), Buffer.from(sigRaw, "base64url"));
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
}

// --- payloads ---------------------------------------------------------------

export interface VersionInfo {
  minNodeVersion: string;
  latestNodeVersion: string;
  downloadUrl: string;
  build: { gameVersion: string; knownBuilds: string[]; updatedAt: number };
}

export interface LinkRequest {
  email: string;
  password: string;
  publicKey: string;
  name: string;
  version: string;
}
export interface LinkReply {
  nodeId: string;
  userId: number;
  displayName: string;
}

export interface HeartbeatRequest {
  version: string;
  build: string;
  bots: { ign: string; seasonal: boolean; online: boolean }[];
}
export interface HeartbeatReply {
  ok: true;
  serverTime: number;
  minNodeVersion: string;
}

export interface BanReportWire {
  account: string;
  suspendedAt: number;
  lastSeenAt: number | null;
  lastLane: string;
  heldItems: number;
  seasonal: boolean | null;
  nodeVersion: string;
  build: string;
}

/** "1.2.3" style compare: negative when a < b. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
