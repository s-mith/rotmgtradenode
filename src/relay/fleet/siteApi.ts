// HMAC-signed client for the site's /api/bot/* endpoints. Payload strings
// must match the routes in src/server/api/bot exactly. Kept as HTTP so the
// relay can run against a separately deployed site during the transition;
// an in-process implementation of the same interface is the next step.
import { createHash, createHmac, randomBytes } from "node:crypto";

export type ApiResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string; status: number | null };
export interface ItemQty {
  itemId: string;
  qty: number;
}
/** A cross-node swap riding a withdraw row (design doc §6.2): what comes back, and which side sends the request. */
export interface SwapSpec {
  rendezvousId: number;
  role: "give" | "take";
  /** What this bot receives, catalog shape. */
  gets: ItemQty[];
  /** The same, one entry per physical item with its enchantments when the hub knows them. */
  getsItems?: ItemDetailQty[];
  /** The meeting's deadline on the hub: the bot keeps trying until then and fails the meeting after it. */
  deadlineAt?: number;
  /**
   * A player meeting: the partner is a person's own character, and what they
   * put up must cover these want lines exactly (the offer's; `WantLineWire`
   * shape). The bot never accepts first and lets them retry a failed window.
   */
  player?: { lines: PlayerWantLine[] };
}
/** An offer's want line as a player meeting carries it (hubWire's WantLineWire). */
export interface PlayerWantLine {
  itemId: string;
  qty: number;
  slotsMin: number;
  slotsExact: number | null;
  enchants: unknown[];
}
/** One physical item with its enchant ids (null = unknown / unreadable). */
export interface ItemDetailQty {
  itemId: string;
  enchants: number[] | null;
  count: number;
}
export interface SwapResult {
  ok: boolean;
  gave: ItemQty[];
  gaveInstanceIds: string[];
  got: ItemQty[];
  /** What crossed, per physical item as the trade window showed it, when the machine could read the window. */
  gaveItems?: ItemDetailQty[];
  gotItems?: ItemDetailQty[];
  partnerIgn: string;
  error?: string;
  partnerAbsent?: boolean;
}

export interface Assignment {
  kind: "deposit" | "withdraw";
  requestId: number;
  ign: string;
  server: string;
  itemCount?: number;
  /** Deposits: the operator queued this one for character skins; the bot may take them. */
  skins?: boolean;
  items?: ItemQty[];
  instanceIds?: string[] | null;
  /** By-type withdraws: instances on this bot that something else has named (a pick, a meeting, a hand-over). The offer leaves them alone. */
  keepInstanceIds?: string[];
  botIgn?: string;
  /** Into or out of communism accounts rather than the pool. */
  communism?: boolean;
  /** Set on a swap row: the trade is two-way and the partner is another node's bot. */
  swap?: SwapSpec | null;
}
export interface PendingWithdraw {
  id: number;
  server: string;
  items: ItemQty[];
  targetBotGuid: string | null;
  instanceIds: string[] | null;
  seasonal: boolean;
  /** A communism pick: comes off a communism account. */
  communism?: boolean;
  swap?: SwapSpec | null;
  /**
   * Advanced management only: not claimable yet. The player's next row after
   * the one being served (or claimed) now, listed so its bot can be woken or
   * its items fetched in time for its turn. Never counted as work, cancelled
   * or claimed while it is upcoming.
   */
  upcoming?: boolean;
  /** On an upcoming row: the player's row before it is claimed (a bot is trading it now), not still pending. */
  headClaimed?: boolean;
}
export interface PendingDeposit {
  id: number;
  server: string;
  /** The one trade's size: only a bot with this many free slots may claim it (16 = an empty backpack bot). */
  itemCount: number;
  /** The same number; kept for the wire shape. */
  declaredCount: number;
  seasonal: boolean;
  /** What the player said they are bringing, when they said. */
  items?: ItemQty[];
  /** Into communism: only a communism account of this half may claim it. */
  communism?: boolean;
}
/** A physical item a deposit just received, as the tracker knows it. */
export interface ReceivedInstance {
  instanceId: string;
  itemId: string;
  enchants: number;
}

/** One server's load as account/servers reports it (0..1). */
export interface ServerUsageReport {
  name: string;
  usage: number;
}

/** Free trade slots per pool across every account on the roster, online or not; `communism` the same for communism accounts. */
export interface PoolRoom {
  seasonal: number;
  nonseasonal: number;
  communism?: { seasonal: number; nonseasonal: number };
}

/** What a bot reports with every heartbeat (lib/fleetPresence.ts PresenceBot). */
export interface HeartbeatReport {
  botGuid: string;
  alias: string;
  ign: string;
  server: string;
  freeSlots: number;
  status: "idle" | "busy" | "offline";
  seasonal: boolean;
  communism?: boolean;
  /** The played character's trade slots (8, 16 or 24). */
  capacity?: number;
  /** Advanced management (docs/relay/ADVANCED.md): claim a deposit only while the character is empty; a bigger one continues on the next empty character. */
  emptyOnly?: boolean;
}

export interface SiteApi {
  heartbeat(p: HeartbeatReport): Promise<ApiResult>;
  /** `preferRequestId`: the row this bot should take if it is still open (a deposit routed to its collector). */
  claimDeposit(botGuid: string, freeSlots?: number, preferRequestId?: number | null): Promise<ApiResult<{ assignment: Assignment | null }>>;
  /** `heldItems` (advanced management): each instance id on the played character -> its catalog id, so picks on the account's other characters don't count against a by-type row here (lib/queue.ts claimWithdraw). */
  claimWithdraw(botGuid: string, inventory: ItemQty[], instanceIds: string[], heldItems?: Record<string, string>): Promise<ApiResult<{ assignment: Assignment | null }>>;
  /** `instances`: the physical items received, when the tracker could tell them apart. */
  fulfillDeposit(botGuid: string, requestId: number, items: ItemQty[], units?: { itemId: string; enchants: number }[] | null, instances?: ReceivedInstance[] | null): Promise<ApiResult>;
  fulfillWithdraw(botGuid: string, requestId: number, items: ItemQty[], instanceIds?: string[]): Promise<ApiResult>;
  /** Pool size, plus the room left per pool across the whole roster — what
   *  the site's fulfill-time "is the vault full?" check reads. */
  /** `onlineCap`: bots the fleet may have online at once (its proxies' budget); the site's per-player limits follow it. */
  registerPool(readyCount: number, room?: PoolRoom, onlineCap?: number): Promise<ApiResult>;
  /** Every server's current load, fresh from Realm; `null` means the fetch failed and the last reading should age out. The site gates trades on it. */
  reportServerUsage(servers: ServerUsageReport[] | null, error?: string): Promise<ApiResult>;
  unclaim(botGuid: string, requestId: number, kind: "deposit" | "withdraw"): Promise<ApiResult<{ unclaimed?: boolean }>>;
  /** Cancel a claimed row for good; `why` is what the player is told. */
  giveUp(botGuid: string, requestId: number, kind: "deposit" | "withdraw", why?: string): Promise<ApiResult<{ cancelled?: boolean }>>;
  /**
   * Cancel a row the fleet cannot serve, saying why: the player is told
   * rather than left waiting. A pending row, or one `botGuid` itself claimed;
   * never a swap row. Without it only a row the bot claimed can be given up.
   */
  cancel?(botGuid: string | null, requestId: number, kind: "deposit" | "withdraw", why: string): Promise<ApiResult<{ cancelled?: boolean }>>;
  listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>>;
  /**
   * Hear that a pending row appeared (a new request, a deposit continuing on
   * the next bot, a re-opened remainder), so the fleet can claim at once
   * rather than at its next poll. Returns the unsubscribe. Only a site in
   * this process can call back.
   */
  onPendingChange?(cb: () => void): () => void;
  /** A swap row's outcome, success or not (replaces fulfill/giveUp for swap rows). */
  reportSwap?(botGuid: string, requestId: number, result: SwapResult): Promise<ApiResult>;
  /** A note on a swap row's timeline (request_events): what the fleet is doing about the meeting. Best effort. */
  noteSwap?(botGuid: string, requestId: number, event: string, detail?: unknown): Promise<ApiResult>;
  /** Whether a swap row is still open: a meeting called off (by the hub, the owner, the player) is let go by the bot working it. */
  /** Also the meeting's deadline as it stands now: an extension reaches a bot already waiting. */
  swapRowOpen?(requestId: number): Promise<ApiResult<{ open: boolean; deadlineAt?: number | null }>>;
  readonly timeoutMs: number;
  readonly stats: ApiStats;
}

export class ApiStats {
  calls = 0;
  errors = 0;
  totalMs = 0;
  maxMs = 0;
  slowest = "";
  record(path: string, ms: number, ok: boolean): void {
    this.calls++;
    if (!ok) this.errors++;
    this.totalMs += ms;
    if (ms > this.maxMs) {
      this.maxMs = ms;
      this.slowest = path;
    }
  }
  drain(): { calls: number; errors: number; avgMs: number; maxMs: number; slowest: string } | null {
    if (!this.calls) return null;
    const out = { calls: this.calls, errors: this.errors, avgMs: this.totalMs / this.calls, maxMs: this.maxMs, slowest: this.slowest };
    this.calls = 0;
    this.errors = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.slowest = "";
    return out;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
export function itemsHash(items: ItemQty[]): string {
  return sha256(items.map((i) => `${i.itemId}:${i.qty}`).sort().join(","));
}

export class HttpSiteApi implements SiteApi {
  readonly stats = new ApiStats();
  private readonly base: string;
  private readonly secret: Buffer;
  private readonly clock: () => number;
  private readonly mintNonce: () => string;
  constructor(baseUrl: string, secret: string, readonly timeoutMs = 10_000, hooks: { now?: () => number; nonce?: () => string } = {}) {
    if (!secret || secret.length < 32) throw new Error("site secret must be at least 32 chars");
    this.base = baseUrl.replace(/\/$/, "");
    this.secret = Buffer.from(secret, "utf8");
    this.clock = hooks.now ?? Date.now;
    this.mintNonce = hooks.nonce ?? (() => randomBytes(16).toString("base64url"));
  }
  static fromEnv(prefix: "COMMUNISM" | "CAPITALISM"): HttpSiteApi | null {
    const url = process.env[`${prefix}_URL`];
    const secret = process.env[`${prefix}_SECRET`];
    if (!url || !secret) return null;
    return new HttpSiteApi(url, secret);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload, "utf8").digest("hex");
  }
  /** Build the signed body for `path` without sending it (tests, in-process callers). */
  signedBody(path: string, body: Record<string, unknown>): Record<string, unknown> {
    void path;
    return body;
  }
  protected async post<T>(path: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      this.stats.record(path, Date.now() - started, false);
      return { ok: false, error: `network: ${(e as Error).message}`, status: null };
    }
    this.stats.record(path, Date.now() - started, res.status < 400);
    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: `non-json response: ${res.status}`, status: res.status };
    }
    if (res.status >= 400) return { ok: false, error: String(data.error ?? `http ${res.status}`), status: res.status };
    return data as ApiResult<T>;
  }
  private auth(payloadParts: (string | number)[]) {
    const ts = this.clock();
    const nonce = this.mintNonce();
    const payload = [...payloadParts, ts, nonce].join("|");
    return { nonce, timestamp: ts, signature: this.sign(payload) };
  }

  // The signature covers the fields the remote site checks; the newer ones (capacity, emptyOnly) ride along unsigned.
  heartbeat(p: HeartbeatReport) {
    const auth = this.auth(["heartbeat", p.botGuid, p.server, p.freeSlots, p.status]);
    return this.post("/api/bot/heartbeat", { ...p, ...auth });
  }
  claimDeposit(botGuid: string, freeSlots?: number, preferRequestId?: number | null) {
    const auth = freeSlots === undefined ? this.auth(["claim-deposit", botGuid]) : this.auth(["claim-deposit", botGuid, freeSlots]);
    const body: Record<string, unknown> = { botGuid, ...auth };
    if (freeSlots !== undefined) body.freeSlots = freeSlots;
    if (preferRequestId != null) body.preferRequestId = preferRequestId;
    return this.post<{ assignment: Assignment | null }>("/api/bot/claim-deposit", body);
  }
  claimWithdraw(botGuid: string, inventory: ItemQty[], instanceIds: string[], heldItems?: Record<string, string>) {
    const invCanonical = inventory.map((i) => `${i.itemId}:${i.qty}`).sort().join(",");
    const instCanonical = [...instanceIds].sort().join(",");
    const invHash = sha256(`${invCanonical}|${instCanonical}`);
    const auth = this.auth(["claim-withdraw", botGuid, invHash]);
    // heldItems rides along unsigned, like the other fields newer than the remote site's signature.
    return this.post<{ assignment: Assignment | null }>("/api/bot/claim-withdraw", { botGuid, inventory, instanceIds, ...(heldItems ? { heldItems } : {}), ...auth });
  }
  fulfillDeposit(botGuid: string, requestId: number, items: ItemQty[], units?: { itemId: string; enchants: number }[] | null, instances?: ReceivedInstance[] | null) {
    const clean = (units ?? []).filter((u) => typeof u.itemId === "string" && Number.isInteger(u.enchants) && u.enchants >= 0);
    const parts: (string | number)[] = ["fulfill", botGuid, requestId, itemsHash(items)];
    if (clean.length) parts.push(sha256(clean.map((u) => `${u.itemId}:${u.enchants}`).sort().join(",")));
    const auth = this.auth(parts);
    const body: Record<string, unknown> = { botGuid, requestId, items, ...auth };
    if (clean.length) body.units = clean;
    // Unsigned; the HTTP site predates per-instance reports.
    if (instances?.length) body.instances = instances;
    return this.post("/api/bot/fulfill", body);
  }
  fulfillWithdraw(botGuid: string, requestId: number, items: ItemQty[], instanceIds: string[] = []) {
    const inst = instanceIds.filter((x) => typeof x === "string");
    const instCanonical = [...inst].sort().join(",");
    const parts: (string | number)[] = ["withdraw-fulfill", botGuid, requestId, itemsHash(items)];
    if (instCanonical) parts.push(instCanonical);
    const auth = this.auth(parts);
    const body: Record<string, unknown> = { botGuid, requestId, items, ...auth };
    if (inst.length) body.instanceIds = inst;
    return this.post("/api/bot/withdraw-fulfill", body);
  }
  // The HTTP site has no field for the room report (its body is fixed by the
  // wire fixtures); a site behind this client keeps answering from presence.
  registerPool(readyCount: number, _room?: PoolRoom, _onlineCap?: number) {
    return this.post("/api/bot/register-pool", { readyCount, ...this.auth(["register-pool", readyCount]) });
  }
  // Server load reaches the site's gate only when the fleet runs in-process;
  // the HTTP protocol predates it, so a remote site keeps every server open.
  async reportServerUsage(): Promise<ApiResult> {
    return { ok: true };
  }
  unclaim(botGuid: string, requestId: number, kind: "deposit" | "withdraw") {
    return this.post<{ unclaimed?: boolean }>("/api/bot/unclaim", { botGuid, requestId, kind, ...this.auth(["unclaim", botGuid, kind, requestId]) });
  }
  giveUp(botGuid: string, requestId: number, kind: "deposit" | "withdraw", why?: string) {
    return this.post<{ cancelled?: boolean }>("/api/bot/give-up", { botGuid, requestId, kind, ...(why ? { why } : {}), ...this.auth(["give-up", botGuid, kind, requestId]) });
  }
  listPending() {
    return this.post<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>("/api/bot/list-pending", { ...this.auth(["list-pending"]) });
  }
}
