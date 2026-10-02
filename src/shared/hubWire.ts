// The node ↔ hub wire (docs/hub-protocol.md): request signing with the
// node's Ed25519 key, and the payload types both sides agree on. This file
// is what the hub imports from the public repo; keep it free of node-only
// dependencies.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

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

/**
 * The string both sides sign / verify. `pathWithQuery` is everything after the host. `nonce` (X-Node-Nonce) is signed
 * too, as a last line: the hub takes each nonce once within the clock window, so a captured request cannot be replayed.
 */
export function canonicalString(nodeId: string, ts: number, method: string, pathWithQuery: string, body: string, nonce?: string): string {
  const lines = [WIRE_VERSION, nodeId, String(ts), method.toUpperCase(), pathWithQuery, bodyHash(body)];
  if (nonce !== undefined) lines.push(nonce);
  return lines.join("\n");
}

export interface SignedHeaders {
  "X-Node-Id": string;
  "X-Node-Ts": string;
  "X-Node-Nonce": string;
  "X-Node-Sig": string;
}

/** A nonce: 16 random bytes, base64url. */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function signRequest(privateKeyPem: string, nodeId: string, method: string, pathWithQuery: string, body: string, ts = Date.now(), nonce = randomBytes(16).toString("base64url")): SignedHeaders {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonicalString(nodeId, ts, method, pathWithQuery, body, nonce), "utf8"), key);
  return { "X-Node-Id": nodeId, "X-Node-Ts": String(ts), "X-Node-Nonce": nonce, "X-Node-Sig": sig.toString("base64url") };
}

export type VerifyResult = { ok: true; nonce: string; ts: number } | { ok: false; reason: "missing-headers" | "bad-timestamp" | "clock-skew" | "bad-signature" | "replayed" };

/** The hub's side: check the headers against the node's stored public key. A request without a well-formed nonce is refused. */
export function verifyRequest(publicKeyPem: string, headers: { get(name: string): string | null | undefined }, method: string, pathWithQuery: string, body: string, now = Date.now()): VerifyResult {
  const nodeId = headers.get("x-node-id") ?? headers.get("X-Node-Id");
  const tsRaw = headers.get("x-node-ts") ?? headers.get("X-Node-Ts");
  const sigRaw = headers.get("x-node-sig") ?? headers.get("X-Node-Sig");
  const nonce = headers.get("x-node-nonce") ?? headers.get("X-Node-Nonce");
  if (!nodeId || !tsRaw || !sigRaw || !nonce || !NONCE_RE.test(nonce)) return { ok: false, reason: "missing-headers" };
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad-timestamp" };
  if (Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: "clock-skew" };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonicalString(nodeId, ts, method, pathWithQuery, body, nonce), "utf8"), createPublicKey(publicKeyPem), Buffer.from(sigRaw, "base64url"));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, nonce, ts } : { ok: false, reason: "bad-signature" };
}

/**
 * Nonces seen within the clock window, per node: a second request with one is a replay. In memory: a restarted hub
 * forgets them, which reopens at most one clock window (MAX_CLOCK_SKEW_MS either side) for requests captured before it.
 */
export class NonceCache {
  private seen = new Map<string, number>();
  private lastPrune = 0;
  /** True the first time `nodeId` + `nonce` is seen; false for a replay. */
  take(nodeId: string, nonce: string, ts: number, now = Date.now()): boolean {
    if (now - this.lastPrune > 30_000) {
      for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k);
      this.lastPrune = now;
    }
    const key = `${nodeId}\n${nonce}`;
    const until = this.seen.get(key);
    if (until !== undefined && until > now) return false;
    // Kept until the signature could no longer pass the clock check anyway.
    this.seen.set(key, Math.max(ts, now) + MAX_CLOCK_SKEW_MS + 1_000);
    return true;
  }
}

// --- payloads ---------------------------------------------------------------

export interface VersionInfo {
  minNodeVersion: string;
  latestNodeVersion: string;
  downloadUrl: string;
  build: { gameVersion: string; knownBuilds: string[]; updatedAt: number };
}

/** How a node proves it may join an account: a one-shot link code the owner copied from the rotmg trade website. */
export interface LinkRequest {
  code: string;
  publicKey: string;
  name: string;
  version: string;
}
export interface LinkReply {
  nodeId: string;
  userId: number;
  displayName: string;
  /** The account the node is now part of. */
  email: string;
}

/** What the hub website shows on a node's card besides its bots. Optional: older nodes do not send it. */
export interface NodeStatusWire {
  /** The login gate: held (no logins) with why, and whether the current Realm build is known to work. */
  gate: { held: boolean; reason: string | null; known: boolean };
  /** Proxies listed on the node. */
  proxies: number;
  /** How many bots the node can have online at once: one per enabled proxy (or its direct cap). The hub lets it take this many offers at once. */
  onlineCap?: number;
  /**
   * The biggest trade inventory among its accounts: 8, or 16 or 24 with a
   * backpack and extender. The hub's items-per-side limit for this node. The
   * trade window shows both sides the real size, so overstating it only makes
   * the node's own trades fail.
   */
  maxTradeSlots?: number;
  /** Accounts on the roster, and how many of them Realm has suspended. */
  accounts: number;
  suspended: number;
  /** Where the node's desk bot waits, so the website can suggest that server for meetings. */
  deskServer: string | null;
  /**
   * Trades with players (docs/hub-protocol.md, "Player meetings"): whether hub
   * users without a node may take this node's offers in game, how many such
   * meetings it runs at once, and the servers its bots meet on. Older nodes
   * omit it and never get a player meeting.
   */
  players?: {
    enabled: boolean;
    maxMeetings: number;
    servers: string[];
    /** The owner's rule for people who never came: this many no-shows within a day pause them this many hours on this node. A limit of 0 never pauses. Absent: 2 and 24. */
    noShow?: { limit: number; pauseHours: number };
  };
  /**
   * The login desk, sent by the hub's login node only: the bot a person
   * whispers their sign-in code to, and where it is (null while none is in
   * game). `alwaysOn` false: the desk is staffed only while someone signs in,
   * so no bot there is the normal state, not an outage.
   */
  login?: { botIgn: string | null; server: string | null; alwaysOn?: boolean };
  /**
   * Advanced management (docs/relay/ADVANCED.md), per pool. `communism` on:
   * the node takes "N of this potion" communism withdraws and picks the
   * copies itself. `spare` (with `communism` only): per side, how many items
   * its communism can take without then having to pass surplus on itself;
   * the hub sends other nodes' surplus only there, and never to a node with
   * none (one passing its own). Older nodes omit it.
   */
  advanced?: { pool: boolean; communism: boolean; spare?: { seasonal: number; nonseasonal: number } };
}

/** Accounts a node may have: the hub keeps track of this many per node (a heartbeat lists no more), so the node adds no more. */
export const MAX_NODE_BOTS = 500;

export interface HeartbeatRequest {
  version: string;
  build: string;
  bots: { ign: string; seasonal: boolean; online: boolean }[];
  status?: NodeStatusWire;
}
export interface HeartbeatReply {
  ok: true;
  serverTime: number;
  minNodeVersion: string;
  /** This node is the hub's login node: it takes realm logins (`/api/v1/realm-logins`). Absent means no. */
  loginNode?: boolean;
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

/**
 * A ref in this form is the node's instance id for the item: the node names
 * the same physical item by it in every offer, accept and hand-over, so the
 * hub can tell when two of them promise the same item (one item may sit in
 * several offers at once; docs/hub-protocol.md). A node from before
 * 2026-09-29 named items r1, r2… afresh in each offer; those never match.
 */
export const ITEM_REF_RE = /^[0-9a-f]{32}$/;

/** One physical item as an offer describes it. `ref` is the node's own handle for it (ITEM_REF_RE). */
export interface OfferItemWire {
  ref: string;
  itemId: string;
  /** Enchantment ids the poster's tracker saw, or null when unknown. */
  enchants: number[] | null;
  /** Number of enchantments (always known). */
  count: number;
}

/** One line of what an offer asks for. `enchants` is the node's SlotSpec[] shape (lib/enchantMatch.ts); the hub stores it opaquely. */
export interface WantLineWire {
  itemId: string;
  qty: number;
  slotsMin: number;
  slotsExact: number | null;
  enchants: unknown[];
}

/**
 * `done`: the poster's node reported that its bot traded. `cancelled`: by the
 * poster, or by the hub when one of its items was traded away in another
 * meeting (`closedReason`). `void`: only on offers from before 2026-09-28,
 * when a disputed meeting voided its offer.
 */
export type OfferStatusWire = "open" | "accepted" | "done" | "cancelled" | "expired" | "void";

export interface OfferWire {
  id: number;
  /** The poster's hub display name. */
  poster: string;
  /** True on the poster's own node. */
  mine: boolean;
  /** The poster's bot: on the poster's own node only, "" everywhere else (the taker learns it from the rendezvous). */
  botIgn: string;
  seasonal: boolean;
  server: string;
  give: OfferItemWire[];
  want: WantLineWire[];
  status: OfferStatusWire;
  createdAt: number;
  expiresAt: number;
  /**
   * The poster's own view of an open offer while one of its items is in a
   * meeting of the same node (another offer taken, an accept, a hand-over):
   * that meeting. Nobody can take the offer meanwhile (it is left out of the
   * open list); the item traded away there, the offer is withdrawn.
   */
  heldBy?: number;
  /** The poster's own view: why the hub closed the offer on its own (its item was traded away in another meeting). */
  closedReason?: string;
}

export interface CreateOfferRequest {
  botIgn: string;
  seasonal: boolean;
  /** Where the poster's bot will meet the taker. */
  server: string;
  give: OfferItemWire[];
  want: WantLineWire[];
  /**
   * The node's own key for this post (CLIENT_KEY_RE). The same key posted again (the first reply was lost) returns the
   * offer the first post made rather than a second one. Optional for older nodes.
   */
  clientKey?: string;
}

export const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface AcceptOfferRequest {
  botIgn: string;
  /** The taker's items that cover the offer's want lines, in want-line order. */
  items: OfferItemWire[];
  /** Where to meet instead of the offer's server: the taker's node found that one busy or closed. Optional. */
  server?: string;
}

/**
 * `done`: a side reported the trade and the other did not contradict it
 * (both agreeing is what counts it: completed swaps, attestations); `failed` /
 * `aborted`: nobody traded (`aborted`: a side gave up); `disputed`: the two
 * sides contradicted each other, a record that freezes nobody. Each side's
 * own word settles its own side whatever the whole comes to (docs/hub-protocol.md).
 */
export type RendezvousState = "meet" | "done" | "failed" | "aborted" | "disputed";

/**
 * What a meeting is for: a two-way swap from an offer (§6.2), a one-way
 * communism hand-over (§6.3), or a player who runs no node taking an offer
 * with their own character (`player`: the node is always the giver, and the
 * partner is that character rather than another node's bot).
 */
export type RendezvousKind = "swap" | "communism" | "player";

/** One side's view of a scheduled meeting. The hub tells each node only what it needs. */
export interface RendezvousWire {
  id: number;
  kind: RendezvousKind;
  /** The offer behind a swap; null for a communism hand-over. */
  offerId: number | null;
  /** Communism: the contributor's node and the item's ref there. */
  communism?: { nodeId: string; ref: string } | null;
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
    /** The same, one entry per physical item with the enchantments the counterparty's node reported (null = unknown), so the trade window can be checked item by item. */
    getsItems?: { itemId: string; enchants: number[] | null; count: number }[];
    /** A player meeting: the offer's want lines, which whatever the player puts up must cover exactly (their items are not known in advance). */
    getsLines?: WantLineWire[];
  };
  /** `player`: the partner is a person's own character (`botIgn` is their IGN, `poster` their hub name), not another node's bot. */
  partner: { botIgn: string; poster: string; player?: boolean };
  /** Receipts the hub has for this rendezvous: which sides reported. */
  reported: { mine: boolean; partner: boolean };
}

/** Where a player meeting stands, as the node reports it along the way (`POST /api/v1/rendezvous/:id/progress`). */
export type MeetingStage = "queued" | "on-the-way" | "ready" | "trading" | "holding" | "retry";
export interface MeetingProgressWire {
  stage: MeetingStage;
  /** One line for the player: what is happening, or what to do about it. */
  detail: string;
  /** The bot to /trade, once the node knows which one goes. */
  botIgn?: string;
  server?: string;
  at: number;
}

export interface ReceiptWire {
  window: number;
  ok: boolean;
  /** What left this bot (catalog counts) and which of its refs. */
  gave: { itemId: string; qty: number }[];
  gaveRefs: string[];
  /** What arrived. */
  got: { itemId: string; qty: number }[];
  /** The same two lists per physical item with the enchantments the trade window showed (null = unreadable), when the node could read the window. The hub compares these when both sides send them. */
  gaveItems?: { itemId: string; enchants: number[] | null; count: number }[];
  gotItems?: { itemId: string; enchants: number[] | null; count: number }[];
  /** The counterparty's IGN as seen in the trade window (attestation). */
  partnerIgn: string;
  error?: string;
  /** A failure because the partner never came to trade (a player meeting counts it as a no-show). */
  partnerAbsent?: boolean;
  at: number;
}

export interface NodeLimitsWire {
  /** Open offers at once: the same for every node. */
  maxOpenOffers: number;
  /** Items on either side of an offer this node posts or takes: its biggest trade inventory (NodeStatusWire.maxTradeSlots), 8 until it reports one. */
  maxItemsPerSide: number;
  /** Swaps where both receipts agreed; shown, no longer a limit. */
  completedSwaps: number;
  /** The hub operator froze this node: no new offers or accepts, and its offers are hidden. */
  frozen: boolean;
  /** Offers it may have taken at once: one per bot it can have online (NodeStatusWire.onlineCap). */
  maxTakes?: number;
}

// --- hub requests: what a hub user asks a node to do (design doc §6.3, §6.5) ---

/**
 * `deposit` / `withdraw`: any signed-in hub user meets the node's communism bot
 * in game with their IGN. `offer-*`: the node's owner posting, accepting or
 * cancelling offers from the hub website. `communism-take`: the owner's node
 * takes a listed item from another node's communism onto its own bot.
 * `communism-give`: the owner's node hands items from its pool to another
 * node's communism bot.
 */
export type GuestRequestKind = "deposit" | "withdraw" | "offer-create" | "offer-accept" | "offer-cancel" | "communism-take" | "communism-give";
export type GuestRequestState = "pending" | "taken" | "done" | "failed" | "expired";

/** A hub user's intent, queued on the hub and executed by the node it names. */
export interface GuestRequestWire {
  id: number;
  nodeId: string;
  requester: { userId: number; displayName: string };
  /** True when the requester owns the node. */
  owner: boolean;
  /** deposit / withdraw: the character communism bot meets. Empty for the owner's own kinds. */
  ign: string;
  kind: GuestRequestKind;
  seasonal: boolean;
  /** Where the bot meets the player (deposit / withdraw), the taker (offer-create), or the other node's bot (communism-take / communism-give). */
  server: string | null;
  /** deposit: how many items the player brings (trade size, 1..24). */
  count: number | null;
  /** withdraw: refs of the node's communism items. offer-create / communism-give: refs of the owner's pool items. */
  refs: string[] | null;
  /**
   * offer-create: want lines. withdraw without refs: "N of this item" from a
   * node that takes them (CommunismNodeWire.byCount): plain copies
   * (`slotsExact` 0), the node picks which.
   */
  want: WantLineWire[] | null;
  /**
   * withdraw by count: refs of this node's communism items that other open
   * requests on the hub hold (a withdraw by ref, waiting its turn or not, a
   * take, a take meeting): the node's pick leaves them alone.
   */
  held?: string[];
  /** offer-accept / offer-cancel. */
  offerId: number | null;
  /** communism-take: the listed item. communism-give: the node whose communism receives (`ref` null). */
  communism: { nodeId: string; ref: string | null } | null;
  state: GuestRequestState;
  createdAt: number;
  /** The node's latest word on it. */
  result: GuestRequestResult | null;
}

/**
 * What a node reports about a request. `pending: true` is a progress note
 * (the row is queued, a bot has claimed it, ...) that keeps the request
 * open; without it the report closes the request as done or failed.
 */
export interface GuestRequestResult {
  ok: boolean;
  pending?: boolean;
  error?: string;
  detail?: string;
  /** deposit / withdraw: the node's queue row id. offer-*: the hub offer id. */
  requestId?: number;
  offerId?: number;
  /** deposit / withdraw: the bot the player should /trade, once one has claimed the row. */
  botIgn?: string;
}

// --- communism (design doc §6.3, no points, no caps) -------------------------------

/** One account a node has set aside for communism: its slots are communism capacity. */
export interface CommunismAccountWire {
  ign: string;
  seasonal: boolean;
  /** Trade slots on the account (8, or 16 with a backpack). */
  slots: number;
  /** Slots not holding an item and not promised to an open deposit. */
  free: number;
  online: boolean;
}

/** One item on a communism account as the node publishes it. `ref` is the node's handle (its instance id). */
export interface CommunismItemWire {
  ref: string;
  itemId: string;
  name: string;
  enchants: number[] | null;
  count: number;
  seasonal: boolean;
  /** Communism account holding it. */
  botIgn: string;
}

/**
 * What a node's communism holds. Either the whole listing (`items`, which
 * replaces what the hub has) or a difference against it: `base` is the hub's
 * fingerprint of the listing the node last saw (the `hash` every publish
 * reply carries), `added` the items new or changed since, `removed` the refs
 * gone. A difference against a fingerprint the hub no longer has is refused
 * with 409, and the node sends the whole listing.
 */
export interface PublishCommunismRequest {
  accounts: CommunismAccountWire[];
  items?: CommunismItemWire[];
  base?: string;
  added?: CommunismItemWire[];
  removed?: string[];
  at: number;
}

export interface PublishCommunismReply {
  ok: true;
  listed: number;
  accounts: number;
  /** The hub's fingerprint of the listing now: the `base` of the next difference. */
  hash: string;
}

/** A listed item as browsers see it. */
export interface CommunismListingWire extends CommunismItemWire {
  nodeId: string;
  /** The node's name. */
  node: string;
  /** Always "": who runs a node is not said (kept for older nodes). `botIgn` is filled in on the node's own items only. */
  contributor: string;
  /** True on the caller's own node. */
  mine: boolean;
  listedAt: number;
}

/** One node's communism on the board: how much room it has per pool half. */
export interface CommunismNodeWire {
  nodeId: string;
  name: string;
  /** Always "": who runs a node is not said (kept for older nodes). */
  owner: string;
  online: boolean;
  /** Where the node's desk bot waits, if it said. */
  server: string | null;
  seasonal: { accounts: number; slots: number; free: number };
  nonseasonal: { accounts: number; slots: number; free: number };
  items: number;
  /**
   * The node takes "N of this item" withdraws (advanced management for
   * communism, docs/relay/ADVANCED.md): a person asks for a count of plain
   * copies and the node picks them. Absent from older hubs.
   */
  byCount?: boolean;
}

/** Node-to-node take: the caller's bot receives a listed item from communism account holding it. */
export interface CommunismWithdrawRequest {
  nodeId: string;
  ref: string;
  /** Where the caller's bot meets communism bot. */
  server: string;
  /** The caller's receiving bot (must have room). */
  botIgn: string;
}

/** Node-to-node give: the caller's bot hands `items` to a communism account of `nodeId` with room for them. */
export interface CommunismGiveRequest {
  nodeId: string;
  seasonal: boolean;
  items: OfferItemWire[];
  server: string;
  /** The caller's giving bot. */
  botIgn: string;
  /**
   * Passing surplus on (docs/relay/ADVANCED.md): the items are the caller's
   * own listed communism copies, in the order it would rather part with them,
   * and its communism is full. The hub picks the receiving node (`nodeId` is
   * not read): another node's communism account of that half with the most
   * room, which takes as many of the items, from the first, as it has room
   * for. The reply names the receiving node (`nodeId`).
   */
  pass?: boolean;
}

/** This node's communism as the hub holds it. */
export interface CommunismStatusWire {
  accounts: number;
  slots: number;
  free: number;
  listed: number;
}

// --- realm logins: signing in to the hub with a character (the login node) ---

/**
 * A sign-in code a person got on the hub website. The hub's login node (one
 * node the operator designates) registers it with its login desk; the person
 * whispers it to that bot in game, and the node reports which character sent
 * it. Only a character's own player can /tell as it, so that is the proof.
 */
export interface RealmLoginWire {
  id: number;
  code: string;
  expiresAt: number;
}
/** The login desk has the code: the bot to whisper, or why no bot can take it right now. */
export interface RealmLoginReady {
  botIgn?: string;
  server?: string | null;
  error?: string;
}
/** The whisper arrived: the character that sent the code. */
export interface RealmLoginVerified {
  ign: string;
}
