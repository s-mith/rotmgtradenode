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

// --- phase 3: offers, rendezvous, receipts (design doc §6.2) -----------------

/** One physical item as an offer describes it. `ref` is the node's own handle (its instance id stays local). */
export interface OfferItemWire {
  ref: string;
  itemId: string;
  /** Enchantment ids the poster's tracker saw, or null when unknown. */
  enchants: number[] | null;
  /** Number of enchantments (always known). */
  count: number;
}

/** One line of what an offer asks for. `enchants` is the node's wishlist SlotSpec[] shape; the hub stores it opaquely. */
export interface WantLineWire {
  itemId: string;
  qty: number;
  slotsMin: number;
  slotsExact: number | null;
  enchants: unknown[];
}

export type OfferStatusWire = "open" | "accepted" | "cancelled" | "expired" | "void";

export interface OfferWire {
  id: number;
  /** The poster's hub display name (a guest's, when posted on their behalf). */
  poster: string;
  /** True on the poster's own node. */
  mine: boolean;
  /** Phase 4b: set when a guest of the node posted it. */
  onBehalfOf?: number | null;
  botIgn: string;
  seasonal: boolean;
  server: string;
  give: OfferItemWire[];
  want: WantLineWire[];
  status: OfferStatusWire;
  createdAt: number;
  expiresAt: number;
}

export interface CreateOfferRequest {
  /** Phase 4b: the offer is a guest's (their vault items), shown under their name. */
  onBehalfOf?: number;
  botIgn: string;
  seasonal: boolean;
  /** Where the poster's bot will meet the taker. */
  server: string;
  give: OfferItemWire[];
  want: WantLineWire[];
}

export interface AcceptOfferRequest {
  /** Phase 4b: the acceptor is a guest of this node. */
  onBehalfOf?: number;
  botIgn: string;
  /** The taker's items that cover the offer's want lines, in want-line order. */
  items: OfferItemWire[];
}

export type RendezvousState = "meet" | "done" | "failed" | "aborted" | "disputed";

/** One side's view of a scheduled swap. The hub tells each node only what it needs. */
export interface RendezvousWire {
  id: number;
  offerId: number;
  server: string;
  seasonal: boolean;
  state: RendezvousState;
  createdAt: number;
  deadlineAt: number;
  me: {
    /** "give": this bot sends the trade request and is the giver in the trade machine; "take": it waits and accepts first. */
    role: "give" | "take";
    botIgn: string;
    /** What this side hands over (refs are this node's own). */
    gives: OfferItemWire[];
    /** What this side receives (catalog shape; the counterparty's refs are not shared). */
    gets: { itemId: string; qty: number }[];
  };
  partner: { botIgn: string; poster: string };
  /** Receipts the hub has for this rendezvous: which sides reported. */
  reported: { mine: boolean; partner: boolean };
}

export interface ReceiptWire {
  window: number;
  ok: boolean;
  /** What left this bot (catalog counts) and which of its refs. */
  gave: { itemId: string; qty: number }[];
  gaveRefs: string[];
  /** What arrived. */
  got: { itemId: string; qty: number }[];
  /** The counterparty's IGN as seen in the trade window (attestation). */
  partnerIgn: string;
  error?: string;
  at: number;
}

export interface NodeLimitsWire {
  maxOpenOffers: number;
  maxItemsPerSide: number;
  completedSwaps: number;
  frozen: boolean;
}

// --- phase 4b: shared vaults (design doc §6.5) --------------------------------

export type GrantRole = "deposit" | "withdraw-own" | "withdraw-any" | "co-owner";

/** One guest's access to one node: their personal vault there. */
export interface GrantWire {
  id: number;
  nodeId: string;
  guest: { userId: number; displayName: string; email?: string };
  /** The IGN the guest trades from; the node's bot trades with this name only. */
  ign: string;
  slotsSeasonal: number;
  slotsNonseasonal: number;
  role: GrantRole;
  /** May the guest post and accept offers with their vault items. */
  trade: boolean;
  /** Owner paused this guest (requests refused, offers hidden) without revoking. */
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateGrantRequest {
  /** The guest's hub account, by email. */
  email: string;
  ign: string;
  slotsSeasonal: number;
  slotsNonseasonal: number;
  role: GrantRole;
  trade: boolean;
}
export type UpdateGrantRequest = Partial<Pick<CreateGrantRequest, "ign" | "slotsSeasonal" | "slotsNonseasonal" | "role" | "trade">> & { paused?: boolean };

/** What a node publishes about one guest's vault half. */
export interface GuestVaultHalfWire {
  slots: number;
  used: number;
  /** Items the guest owns in this half; `ref` is the node's handle, `name` the catalog name. */
  items: { ref: string; itemId: string; name: string; enchants: number[] | null; count: number; online: boolean }[];
}
export interface PublishVaultsRequest {
  guests: { userId: number; seasonal: GuestVaultHalfWire; nonseasonal: GuestVaultHalfWire }[];
  at: number;
}

export type GuestRequestKind = "deposit" | "withdraw" | "offer-create" | "offer-accept" | "offer-cancel";
export type GuestRequestState = "pending" | "taken" | "done" | "failed" | "expired";

/** A guest's intent, queued on the hub and executed by the owner's node. */
export interface GuestRequestWire {
  id: number;
  nodeId: string;
  guest: { userId: number; displayName: string };
  ign: string;
  kind: GuestRequestKind;
  seasonal: boolean;
  /** deposit / withdraw: where the guest will meet the bot. offer-create: where the poster's bot meets a taker. */
  server: string | null;
  /** deposit: how many items the guest brings (trade size). */
  count: number | null;
  /** withdraw / offer-create: the guest's item refs (from the published vault). */
  refs: string[] | null;
  /** offer-create: want lines. */
  want: WantLineWire[] | null;
  /** offer-accept / offer-cancel. */
  offerId: number | null;
  state: GuestRequestState;
  createdAt: number;
  /** Set by the node's result. */
  result: { ok: boolean; error?: string; detail?: string; requestId?: number; offerId?: number } | null;
}

export interface GuestRequestResult {
  ok: boolean;
  error?: string;
  detail?: string;
  /** deposit / withdraw: the node's queue row id. offer-*: the hub offer id. */
  requestId?: number;
  offerId?: number;
}
