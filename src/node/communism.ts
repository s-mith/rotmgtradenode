// Communism (design doc §6.3): the accounts the operator sets aside for
// it, and everything on them. Anyone on the hub may deposit into them and
// take from them, as much as they like, by meeting a communism account in the
// game (src/node/requests.ts runs those requests); other nodes' bots may take
// an item onto their own accounts, or hand items over into ours, in a
// one-way meeting the swap coordinator runs like a swap with nothing coming
// back. No points, no caps: what bounds communism is the room on the
// accounts, and the operator can unflag an account (or withdraw) at any time.
import type Database from "better-sqlite3";
import { MAX_ENCHANTS, tradeableEnchants } from "../relay/protocol/enchants";
import type { CommunismAccountWire, CommunismGiveRequest, CommunismItemWire, CommunismListingWire, CommunismNodeWire, CommunismStatusWire, CommunismWithdrawRequest, OfferItemWire, PublishCommunismReply, PublishCommunismRequest, RendezvousWire } from "../shared/hubWire";
import type { HubClient } from "./hub";
import type { CommunismResolver, SwapCoordinator, SwapsResult } from "./swaps";
import type { PyrelayPool } from "../lib/devauth";
import { WITHDRAW_SERVERS } from "../lib/servers";
import { ITEM_BY_ID } from "../lib/catalog";
import { isCommunismBot } from "../lib/communismPool";
import { communismTakes } from "../lib/itemPolicy";
import { SLOTS_PER_BOT } from "../lib/capacity";
import { reservedInstanceIds } from "../lib/reservations";
import { pickQuietServer } from "../lib/quietServer";
import { blockMessage, isWithdrawsDisabled, withdrawBlock } from "../lib/serverControls";
import { USAGE_FRESH_MS } from "../lib/serverUsage";
import { advancedForPool, advancedSettings } from "../lib/advanced";

/**
 * The publish tick. A change on a communism account (a trade, a storage read)
 * publishes within PUBLISH_DEBOUNCE_MS of it anyway; the tick catches what
 * the fleet's change signal does not carry (an account logging in or out,
 * which moves its `online` flag and, with it, the room the hub shows) and
 * costs nothing when nothing changed.
 */
export const COMMUNISM_PUBLISH_MS = Number(process.env.COMMUNISM_PUBLISH_SECONDS ?? 10) * 1000;
/** A change publishes this long after the last one in a burst (a trade moves several slots at once). */
export const PUBLISH_DEBOUNCE_MS = Number(process.env.COMMUNISM_PUBLISH_DEBOUNCE_MS ?? 1500);
/** Check in with the hub even when nothing changed (an empty difference, a few hundred bytes), so a hub that lost the listing asks for it again. */
const REPUBLISH_MS = 10 * 60_000;
/** Finished meetings stay in the status list this long. */
const KEEP_DONE_MS = 24 * 3_600_000;
/** After the hub found no communism with room to pass surplus on to, ask again this much later. */
export const SURPLUS_RETRY_MS = 5 * 60_000;
/** A surplus pass recorded but never seen on the swap coordinator's side counts as under way this long, then as dead. */
const PASS_UNSEEN_MS = 10 * 60_000;

/** One side of this node's communism under advanced management (Dispatcher.communismRoom): its accounts, their empty characters, and the vault room left past the transit reserves. */
export interface SurplusRoom {
  seasonal: boolean;
  accounts: number;
  emptyChars: number;
  vaultFree: number;
}

/**
 * Per side, how many items this node's communism can take from another
 * node's surplus without then having to pass surplus on itself: its vault
 * room past the reserves, and every empty character but the one kept for
 * intake, at a plain character's eight slots. The heartbeat carries it
 * (NodeStatusWire.advanced.spare); the hub sends passes only into it, so a
 * pass never bounces back.
 */
export function spareRoom(rooms: SurplusRoom[]): { seasonal: number; nonseasonal: number } {
  const out = { seasonal: 0, nonseasonal: 0 };
  for (const r of rooms) out[r.seasonal ? "seasonal" : "nonseasonal"] += Math.max(0, r.vaultFree + Math.max(0, r.emptyChars - 1) * 8);
  return out;
}

export interface CommunismOptions {
  db: () => Database.Database;
  hub: HubClient;
  swaps: SwapCoordinator;
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
  /** Subscribe to the fleet's "something on a bot moved" signal; the coordinator publishes shortly after each. */
  onPoolChanged?: (fn: () => void) => () => void;
  /** Realm's per-server load as the fleet last read it (ServerUsageWatch), for choosing where a take meets. */
  serverUsage?: () => { servers: { name: string; usage: number }[]; fetchedAt: number | null };
  /** Advanced management's room per side (docs/relay/ADVANCED.md): a side with no empty character and no vault room passes surplus on. */
  surplusRoom?: () => SurplusRoom[];
}

/** How old a load report may be and still steer a take's server: the load gate's own window (SERVER_USAGE_FRESH_SECONDS, 90 s). */
export const SERVER_USAGE_FRESH_MS = USAGE_FRESH_MS;

export { pickQuietServer } from "../lib/quietServer";

/** One communism account as it stands now. */
export interface CommunismAccountView {
  botGuid: string;
  ign: string;
  seasonal: boolean;
  slots: number;
  used: number;
  free: number;
  online: boolean;
  server: string;
  suspended: boolean;
}

/** One item on a communism account. */
export interface CommunismItemView {
  instanceId: string;
  itemId: string;
  name: string;
  enchants: number[];
  seasonal: boolean;
  botGuid: string;
  botIgn: string;
  /** In the account's storage rather than on its character (fetched before a trade). */
  stored: boolean;
  /** In an open withdraw or hand-over. */
  reserved: boolean;
}

/** A node-to-node meeting this node is part of: taking a listed item onto its pool, or giving pool items into another node's communism. */
export interface CommunismMeeting {
  rendezvousId: number;
  kind: "take" | "give";
  /** A give of communism's own surplus to another node's communism (docs/relay/ADVANCED.md), not of pool items. */
  pass?: boolean;
  nodeId: string;
  itemIds: string[];
  names: string[];
  botGuid: string;
  botIgn: string;
  server: string;
  createdAt: number;
  state: string | null;
  requestId: number | null;
}

export class CommunismCoordinator implements CommunismResolver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private unhook: (() => void) | null = null;
  private lastPublishAt: number | null = null;
  /** What the hub holds for this node, as of its last reply: the items by ref (their wire form, to spot a change) and the hub's fingerprint of the ref set. */
  private published: Map<string, string> | null = null;
  private publishedAccounts = "";
  private hubHash: string | null = null;
  private publishing: Promise<boolean> | null = null;
  private lastError: string | null = null;
  private hubStatus: CommunismStatusWire | null = null;
  /** A surplus pass being arranged right now, and when the hub may next be asked after it found no room anywhere. */
  private passing = false;
  private passRetryAt = 0;
  private readonly now: () => number;
  constructor(private readonly o: CommunismOptions) {
    this.now = o.now ?? Date.now;
    o.db().exec(`
      CREATE TABLE IF NOT EXISTS communism_meetings (
        rendezvous_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        node_id TEXT NOT NULL,
        item_ids_json TEXT NOT NULL,
        instance_ids_json TEXT NOT NULL,
        bot_guid TEXT NOT NULL,
        server TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      DROP TABLE IF EXISTS communism_withdraws;
    `);
    // A give of communism's own surplus (docs/relay/ADVANCED.md) is a give whose items come off communism accounts.
    const cols = o.db().prepare("PRAGMA table_info(communism_meetings)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "pass")) o.db().exec("ALTER TABLE communism_meetings ADD COLUMN pass INTEGER NOT NULL DEFAULT 0");
  }

  // --- this node's communism ------------------------------------------------------------

  accounts(): CommunismAccountView[] {
    const pool = this.o.pool();
    if (!pool) return [];
    const out: CommunismAccountView[] = [];
    for (const [botGuid, meta] of Object.entries(pool.botMeta ?? {})) {
      if (!isCommunismBot(meta)) continue;
      // The whole account's side when the fleet described it; else the played character alone.
      const whole = pool.accountRoom?.[botGuid];
      const slots = whole?.slots ?? pool.capacities?.[botGuid] ?? SLOTS_PER_BOT;
      const used = whole?.used ?? Object.values(pool.bots?.[botGuid] ?? {}).reduce((n, q) => n + q, 0);
      out.push({ botGuid, ign: meta.ign, seasonal: meta.seasonal !== false, slots, used, free: Math.max(0, slots - used), online: !!meta.online, server: meta.server ?? "", suspended: !!meta.suspended });
    }
    return out.sort((a, b) => a.ign.localeCompare(b.ign));
  }

  items(): CommunismItemView[] {
    const pool = this.o.pool();
    if (!pool) return [];
    const meta = pool.botMeta ?? {};
    const reserved = reservedInstanceIds(this.o.db());
    const out: CommunismItemView[] = [];
    for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
      const m = meta[botGuid];
      if (!isCommunismBot(m)) continue;
      for (const info of Object.values(slots)) {
        if (!tradeableEnchants((info.enchantments ?? []).length)) continue;
        // On a communism account only what communism takes is communism's to give; the rest is untradable there (the storage chore banks it).
        if (!communismTakes(info.itemId)) continue;
        out.push({ instanceId: info.instanceId, itemId: info.itemId, name: ITEM_BY_ID.get(info.itemId)?.name ?? info.itemId, enchants: info.enchantments ?? [], seasonal: m!.seasonal !== false, botGuid, botIgn: m!.ign, stored: false, reserved: reserved.has(info.instanceId) });
      }
    }
    for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) {
      const m = meta[botGuid];
      if (!isCommunismBot(m)) continue;
      for (const s of stored) {
        if (!tradeableEnchants((s.enchantments ?? []).length)) continue;
        if (!communismTakes(s.itemId)) continue;
        // Storage serves whichever half a character of the account can carry it to; the other side's containers, none yet.
        if (!s.pools.seasonal && !s.pools.nonseasonal) continue;
        const seasonal = s.pools.seasonal || !s.pools.nonseasonal;
        out.push({ instanceId: s.instanceId, itemId: s.itemId, name: ITEM_BY_ID.get(s.itemId)?.name ?? s.itemId, enchants: s.enchantments ?? [], seasonal, botGuid, botIgn: m!.ign, stored: true, reserved: reserved.has(s.instanceId) });
      }
    }
    return out;
  }

  /**
   * Room for deposits into one half: communism accounts' free slots, minus
   * what open communism deposits and incoming hand-overs have promised. Under
   * advanced management a deposit goes to an empty character, so the fleet's
   * word on the biggest deposit the half takes now bounds it too.
   */
  room(seasonal: boolean): { accounts: number; slots: number; used: number; free: number } {
    const accs = this.accounts().filter((a) => a.seasonal === seasonal && !a.suspended);
    const slots = accs.reduce((n, a) => n + a.slots, 0);
    const used = accs.reduce((n, a) => n + a.used, 0);
    const db = this.o.db();
    const committed = (db.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'claimed' THEN COALESCE(current_cap, item_count) ELSE item_count END), 0) AS n FROM deposit_requests WHERE status IN ('pending','claimed') AND communism = 1 AND seasonal = ?").get(seasonal ? 1 : 0) as { n: number }).n;
    const free = Math.max(0, slots - used - committed);
    const largest = this.o.pool()?.room?.communism?.[seasonal ? "seasonal" : "nonseasonal"]?.largestFree;
    return { accounts: accs.length, slots, used, free: largest === undefined ? free : Math.min(free, Math.max(0, largest)) };
  }

  publishPayload(): PublishCommunismRequest & { items: CommunismItemWire[] } {
    const accounts: CommunismAccountWire[] = this.accounts().filter((a) => a.ign && !a.suspended).map((a) => ({ ign: a.ign, seasonal: a.seasonal, slots: a.slots, free: a.free, online: a.online }));
    const named = new Set(accounts.map((a) => a.ign));
    // Character slots first, then storage; nothing is left out.
    const items: CommunismItemWire[] = this.items()
      .filter((i) => named.has(i.botIgn) && !i.reserved && i.enchants.length <= MAX_ENCHANTS)
      .sort((x, y) => Number(x.stored) - Number(y.stored))
      .map((i) => ({ ref: i.instanceId, itemId: i.itemId, name: i.name, enchants: i.enchants.length ? i.enchants : null, count: i.enchants.length, seasonal: i.seasonal, botIgn: i.botIgn }));
    return { accounts, items, at: this.now() };
  }

  /**
   * Tell the hub what this node's communism holds now. After the first, whole
   * listing, only the difference since the hub's last reply goes over the
   * wire (a trade is a few hundred bytes, not the whole listing); the hub
   * refuses a difference against a fingerprint it does not hold, and the
   * whole listing goes again. Nothing changed and not due for a check-in:
   * nothing is sent. Concurrent calls share one publish.
   */
  publish(force = false): Promise<boolean> {
    if (this.publishing) return this.publishing;
    this.publishing = this.doPublish(force).finally(() => {
      this.publishing = null;
    });
    return this.publishing;
  }
  private async doPublish(force: boolean): Promise<boolean> {
    if (!this.o.hub.linked) return false;
    const payload = this.publishPayload();
    const items = new Map(payload.items.map((it) => [it.ref, JSON.stringify(it)]));
    const accounts = JSON.stringify(payload.accounts);
    let req: PublishCommunismRequest = payload;
    let whole = true;
    if (!force && this.published !== null) {
      const added: CommunismItemWire[] = [];
      const removed: string[] = [];
      for (const it of payload.items) if (this.published.get(it.ref) !== items.get(it.ref)) added.push(it);
      for (const ref of this.published.keys()) if (!items.has(ref)) removed.push(ref);
      const stale = this.lastPublishAt === null || this.now() - this.lastPublishAt > REPUBLISH_MS;
      if (!added.length && !removed.length && accounts === this.publishedAccounts && !stale) return true;
      // A hub that gave no fingerprint (an older one) gets the whole listing on every change.
      if (this.hubHash !== null) {
        req = { accounts: payload.accounts, base: this.hubHash, added, removed, at: payload.at };
        whole = false;
      }
    }
    let r = await this.o.hub.signed<PublishCommunismReply>("POST", "/api/v1/communism/publish", req);
    if (!r.ok && !whole && r.status === 409) {
      // The hub holds something else (a restart on either side): send it all.
      this.o.log("communism: the hub's listing differs from ours; publishing the whole listing");
      r = await this.o.hub.signed<PublishCommunismReply>("POST", "/api/v1/communism/publish", payload);
    }
    if (!r.ok) {
      this.lastError = `publish: ${r.error}`;
      this.o.log(`communism: ${this.lastError}`);
      return false;
    }
    this.lastError = null;
    this.lastPublishAt = this.now();
    this.published = items;
    this.publishedAccounts = accounts;
    this.hubHash = typeof r.data.hash === "string" ? r.data.hash : null;
    return true;
  }

  /** Something on a bot moved: publish once the burst settles. */
  schedulePublish(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.publish();
    }, PUBLISH_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  // --- the board ------------------------------------------------------------------------

  async browse(seasonal?: boolean): Promise<SwapsResult<{ items: CommunismListingWire[]; nodes: CommunismNodeWire[]; status: CommunismStatusWire }>> {
    const r = await this.o.hub.signed<{ items: CommunismListingWire[]; nodes: CommunismNodeWire[]; status: CommunismStatusWire }>("GET", `/api/v1/communism${seasonal === undefined ? "" : `?seasonal=${seasonal ? 1 : 0}`}`);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.hubStatus = r.data.status;
    return { ok: true, items: r.data.items, nodes: r.data.nodes ?? [], status: r.data.status };
  }

  // --- node-to-node: take a listed item onto this node's pool ------------------------------

  /**
   * The pool account that receives a communism item for the `seasonal` half:
   * a pool bot of that half with a free slot and a known name, online first,
   * then the one with the most room. Slots promised to takes still under
   * way are not free.
   */
  private takingBot(seasonal: boolean): { botGuid: string; ign: string; free: number } | null {
    const pool = this.o.pool();
    if (!pool) return null;
    const pending = new Map<string, number>();
    for (const m of this.meetings()) if (m.kind === "take" && (m.state === "meet" || m.state === "receipt-pending")) pending.set(m.botGuid, (pending.get(m.botGuid) ?? 0) + m.itemIds.length);
    let best: { botGuid: string; ign: string; free: number; online: boolean } | null = null;
    for (const [botGuid, meta] of Object.entries(pool.botMeta ?? {})) {
      if (!meta.ign || meta.suspended || isCommunismBot(meta)) continue;
      if ((meta.seasonal !== false) !== seasonal) continue;
      const cap = pool.capacities?.[botGuid] ?? SLOTS_PER_BOT;
      const used = Object.values(pool.bots?.[botGuid] ?? {}).reduce((n, q) => n + q, 0);
      const free = cap - used - (pending.get(botGuid) ?? 0);
      if (free < 1) continue;
      const cand = { botGuid, ign: meta.ign, free, online: !!meta.online };
      if (!best || (cand.online && !best.online) || (cand.online === best.online && cand.free > best.free)) best = cand;
    }
    return best ? { botGuid: best.botGuid, ign: best.ign, free: best.free } : null;
  }

  /** Where a take would meet right now: a random server at 0% load (pickQuietServer over the fleet's last report, when fresh) among those the node's switches leave open. */
  quietServer(): { server: string; why: string } {
    const u = this.o.serverUsage?.();
    const fresh = !!u && u.fetchedAt !== null && this.now() - u.fetchedAt <= SERVER_USAGE_FRESH_MS;
    const open = WITHDRAW_SERVERS.filter((s) => !isWithdrawsDisabled(this.o.db(), s));
    return pickQuietServer(open.length ? open : WITHDRAW_SERVERS, fresh ? u!.servers : null);
  }
  /** Why a take or a hand-over may not meet on `server` right now: the node's server switches and Realm's load, as for a swap. Null when it may. */
  private serverProblem(server: string): string | null {
    if (!WITHDRAW_SERVERS.includes(server)) return "Pick a server this node trades on.";
    const block = withdrawBlock(this.o.db(), server);
    return block ? blockMessage(server, "withdraw", block) : null;
  }
  /** Ask for a listed item: the hub schedules the meeting, this node queues its receiving side. Without a `server`, a quiet one is picked. */
  async withdraw(input: { nodeId: string; ref: string; itemId: string; seasonal: boolean; server?: string }): Promise<SwapsResult<{ rendezvous: RendezvousWire; botIgn: string }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    if (!ITEM_BY_ID.has(input.itemId)) return { ok: false, status: 400, error: "Unknown item." };
    if (!communismTakes(input.itemId)) return { ok: false, status: 409, error: `${ITEM_BY_ID.get(input.itemId)?.name} is not taken into communism.` };
    const bot = this.takingBot(input.seasonal);
    if (!bot) return { ok: false, status: 409, error: `No ${input.seasonal ? "seasonal" : "non-seasonal"} pool account of yours has a free slot and a known name.` };
    let server = input.server;
    if (!server) {
      const q = this.quietServer();
      server = q.server;
      this.o.log(`communism: receiving on ${server} (${q.why})`);
    }
    const problem = this.serverProblem(server);
    if (problem) return { ok: false, status: 409, error: problem };
    const req: CommunismWithdrawRequest = { nodeId: input.nodeId, ref: input.ref, server, botIgn: bot.ign };
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire }>("POST", "/api/v1/communism/withdraw", req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    const rv = r.data.rendezvous;
    this.recordMeeting(rv.id, "take", input.nodeId, [input.itemId], [], bot.botGuid, rv.server);
    this.o.log(`communism: taking ${ITEM_BY_ID.get(input.itemId)?.name ?? input.itemId} from ${rv.partner.botIgn}; ${bot.ign} receives on ${rv.server} (meeting #${rv.id})`);
    await this.o.swaps.adopt(rv);
    return { ok: true, rendezvous: rv, botIgn: bot.ign };
  }

  // --- node-to-node: give pool items into another node's communism ------------------------------

  /** Hand `instanceIds` (pool items on one account) to a communism account of `nodeId`. */
  async give(input: { nodeId: string; instanceIds: string[]; server: string }): Promise<SwapsResult<{ rendezvous: RendezvousWire; botIgn: string }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    const ids = [...new Set(input.instanceIds)];
    if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item." };
    if (ids.length > 24) return { ok: false, status: 400, error: "At most 24 items in one hand-over." };
    const problem = this.serverProblem(input.server);
    if (problem) return { ok: false, status: 409, error: problem };
    const held = this.o.swaps.held();
    const picked = ids.map((id) => held.find((h) => h.instanceId === id));
    if (picked.some((p) => !p)) return { ok: false, status: 409, error: "One of those items is no longer free on this node (in a trade right now, reserved, in communism, or gone)." };
    const items = picked as NonNullable<(typeof picked)[number]>[];
    if (new Set(items.map((p) => p.botGuid)).size !== 1) return { ok: false, status: 400, error: "All items of one hand-over must sit on the same account (one bot trades at a time)." };
    if (items.some((p) => p.enchantIds.length > MAX_ENCHANTS)) return { ok: false, status: 400, error: "An item has too many enchantments to trade in game." };
    const bot = items[0];
    if (!bot.botIgn) return { ok: false, status: 409, error: "That account has never logged in on this node, so its name is unknown." };
    const wire: OfferItemWire[] = items.map((p) => ({ ref: p.instanceId, itemId: p.itemId, enchants: p.enchantIds.length ? p.enchantIds : null, count: p.enchantIds.length }));
    const req: CommunismGiveRequest = { nodeId: input.nodeId, seasonal: bot.seasonal, items: wire, server: input.server, botIgn: bot.botIgn };
    // Spoken for while the hub is asked: nothing else on the node picks them meanwhile.
    const provisional = this.reserveGive(input.nodeId, items.map((p) => p.itemId), ids, bot.botGuid, input.server, false);
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire }>("POST", "/api/v1/communism/give", req);
    if (!r.ok) {
      this.releaseGive(provisional);
      return { ok: false, status: r.status || 502, error: r.error };
    }
    const rv = r.data.rendezvous;
    this.settleGive(provisional, rv.id, input.nodeId, items.map((p) => p.itemId), ids, rv.server);
    this.o.log(`communism: giving ${ids.length} item(s) from ${bot.botIgn} to ${rv.partner.botIgn} on ${rv.server} (meeting #${rv.id})`);
    if (!(await this.startGive(rv))) return { ok: false, status: 409, error: "The hand-over could not start on this node (one of the items was taken for something else meanwhile); nothing was handed over." };
    return { ok: true, rendezvous: rv, botIgn: bot.botIgn };
  }

  // --- node-to-node: pass communism's surplus on to another node's communism (docs/relay/ADVANCED.md) ---

  /**
   * The surplus rule the owner chose, "pass on": with advanced management on
   * for communism and `passSurplus` set, a side whose communism accounts have
   * no empty character left and no vault room to bank into gives what one of
   * its characters holds to another node's communism through the hub, so that
   * character is empty again: the account whose character holds the oldest
   * copies of the most over-stocked items, those first. Only what sits on the
   * character it plays (a fetch out of a full vault onto a full character
   * could not happen), never what something else has spoken for, and one such
   * meeting at a time; the hub picks a node with room and may take fewer
   * items than offered. Every step is logged. Null when nothing was passed on.
   */
  async passSurplus(): Promise<{ rendezvousId: number; items: number; nodeId: string | null } | null> {
    if (this.passing || !this.o.hub.linked || !advancedForPool(true) || !advancedSettings().passSurplus) return null;
    if (this.now() < this.passRetryAt || this.passUnderWay()) return null;
    const full = (this.o.surplusRoom?.() ?? []).filter((r) => r.accounts > 0 && r.emptyChars <= 0 && r.vaultFree <= 0);
    if (!full.length) return null;
    this.passing = true;
    try {
      for (const side of full) {
        const r = await this.passSide(side.seasonal);
        if (r) return r;
      }
      return null;
    } finally {
      this.passing = false;
    }
  }

  private async passSide(seasonal: boolean): Promise<{ rendezvousId: number; items: number; nodeId: string | null } | null> {
    const half = seasonal ? "seasonal" : "non-seasonal";
    const pool = this.o.pool();
    if (!pool) return null;
    const age = new Map<string, number>();
    for (const slots of Object.values(pool.instances ?? {})) for (const info of Object.values(slots)) age.set(info.instanceId, info.capturedAt ?? 0);
    const items = this.items().filter((i) => i.seasonal === seasonal && !i.reserved && i.enchants.length <= MAX_ENCHANTS && !!i.botIgn);
    // How over-stocked each item is: copies of it across the half's communism, wherever they sit.
    const copies = new Map<string, number>();
    for (const i of items) copies.set(i.itemId, (copies.get(i.itemId) ?? 0) + 1);
    const rank = (a: CommunismItemView, b: CommunismItemView) => (copies.get(b.itemId) ?? 0) - (copies.get(a.itemId) ?? 0) || (age.get(a.instanceId) ?? 0) - (age.get(b.instanceId) ?? 0) || (a.instanceId < b.instanceId ? -1 : 1);
    const meta = pool.botMeta ?? {};
    const byBot = new Map<string, CommunismItemView[]>();
    for (const i of items) if (!i.stored && !meta[i.botGuid]?.suspended) byBot.set(i.botGuid, [...(byBot.get(i.botGuid) ?? []), i]);
    if (!byBot.size) {
      this.passRetryAt = this.now() + SURPLUS_RETRY_MS;
      this.o.log(`communism: ${half} communism is full but no character holds anything free to pass on; looking again in ${SURPLUS_RETRY_MS / 60_000} min`);
      return null;
    }
    // The account whose character holds the most over-stocked, oldest copies: its best copy ranks first.
    const [botGuid, held] = [...byBot.entries()].map(([g, l]) => [g, [...l].sort(rank)] as const).sort(([, a], [, b]) => rank(a[0], b[0]))[0];
    const give = held.slice(0, Math.min(24, pool.capacities?.[botGuid] ?? 24));
    const bot = meta[botGuid];
    // Where its bot already is, when that is a server this node trades on; else a quiet one.
    const here = bot?.online && bot.server && !this.serverProblem(bot.server) ? bot.server : null;
    const server = here ?? this.quietServer().server;
    const wire: OfferItemWire[] = give.map((i) => ({ ref: i.instanceId, itemId: i.itemId, enchants: i.enchants.length ? i.enchants : null, count: i.enchants.length }));
    this.o.log(`communism: ${half} communism has no empty character and no vault room; offering ${give.length} item(s) from ${bot?.ign ?? botGuid} (${describeWire(give)}) to another node's communism on ${server}`);
    const req: CommunismGiveRequest = { nodeId: "", seasonal, items: wire, server, botIgn: bot!.ign, pass: true };
    // Spoken for while the hub is asked: nothing else on the node (a withdraw by count in another lane) picks them meanwhile.
    const provisional = this.reserveGive("", give.map((i) => i.itemId), give.map((i) => i.instanceId), botGuid, server, true);
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire; nodeId?: string }>("POST", "/api/v1/communism/give", req);
    if (!r.ok) {
      this.releaseGive(provisional);
      this.passRetryAt = this.now() + SURPLUS_RETRY_MS;
      this.o.log(`communism: could not pass surplus on (${r.error}); asking again in ${SURPLUS_RETRY_MS / 60_000} min`);
      return null;
    }
    const rv = r.data.rendezvous;
    // The hub may take fewer than offered (the roomiest account it found, items someone holds): what it scheduled is what goes.
    const ids = rv.me.gives.map((g) => g.ref);
    const itemIds = ids.map((id) => give.find((i) => i.instanceId === id)?.itemId ?? "");
    this.settleGive(provisional, rv.id, r.data.nodeId ?? "", itemIds, ids, rv.server);
    this.o.log(`communism: passing ${ids.length} item(s) of ${half} surplus from ${bot!.ign} to ${rv.partner.botIgn} on ${rv.server} (meeting #${rv.id})`);
    // Off the board at once: what is being handed over is not anyone's to take meanwhile (a publish already on its way
    // was built before the meeting, so a fresh one follows it).
    if (this.publishing) await this.publishing;
    await this.publish();
    if (!(await this.startGive(rv))) {
      this.passRetryAt = this.now() + SURPLUS_RETRY_MS;
      return null;
    }
    return { rendezvousId: rv.id, items: ids.length, nodeId: r.data.nodeId ?? null };
  }

  /** A surplus pass still going: its meeting not closed yet, or recorded lately and not seen by the swap coordinator yet. */
  private passUnderWay(): boolean {
    return !!this.o.db().prepare(`SELECT 1 FROM communism_meetings m LEFT JOIN swap_rendezvous r ON r.rendezvous_id = m.rendezvous_id
      WHERE m.kind = 'give' AND m.pass = 1 AND (r.state IN ('meet', 'receipt-pending') OR (r.state IS NULL AND m.created_at > ?)) LIMIT 1`).get(this.now() - PASS_UNSEEN_MS);
  }

  /**
   * Speak for a give's items before the hub is asked: a meeting row under a
   * provisional id (negative; the hub's are positive), which reservedInstanceIds
   * counts like any give under way. `settleGive` makes it the meeting's once the
   * hub scheduled one; `releaseGive` lets the items go when none came of it.
   */
  private reserveGive(nodeId: string, itemIds: string[], instanceIds: string[], botGuid: string, server: string, pass: boolean): number {
    const id = (this.o.db().prepare("SELECT MIN(COALESCE(MIN(rendezvous_id), 0), 0) - 1 AS id FROM communism_meetings").get() as { id: number }).id;
    this.recordMeeting(id, "give", nodeId, itemIds, instanceIds, botGuid, server, pass);
    return id;
  }
  private settleGive(provisional: number, rendezvousId: number, nodeId: string, itemIds: string[], instanceIds: string[], server: string): void {
    const db = this.o.db();
    db.transaction(() => {
      // A row by that number belongs to an older meeting (the hub's numbers started over): this one replaces it.
      db.prepare("DELETE FROM communism_meetings WHERE rendezvous_id = ?").run(rendezvousId);
      db.prepare("UPDATE communism_meetings SET rendezvous_id = ?, node_id = ?, item_ids_json = ?, instance_ids_json = ?, server = ?, created_at = ? WHERE rendezvous_id = ?")
        .run(rendezvousId, nodeId, JSON.stringify(itemIds), JSON.stringify(instanceIds), server, this.now(), provisional);
    })();
  }
  private releaseGive(rendezvousId: number): void {
    this.o.db().prepare("DELETE FROM communism_meetings WHERE rendezvous_id = ?").run(rendezvousId);
  }
  /**
   * Queue our side of a give the hub scheduled. False when the swap
   * coordinator did not queue it (it called the meeting off: an item was
   * spoken for meanwhile, or is gone); its items are let go here then, so
   * they are not held for a meeting that never runs.
   */
  private async startGive(rv: RendezvousWire): Promise<boolean> {
    const queued = () => !!this.o.db().prepare("SELECT 1 FROM swap_rendezvous WHERE rendezvous_id = ?").get(rv.id);
    try {
      await this.o.swaps.adopt(rv);
    } finally {
      if (!queued()) {
        this.releaseGive(rv.id);
        this.o.log(`communism: meeting #${rv.id} did not start on this node; its items are free again`);
      }
    }
    return queued();
  }

  private recordMeeting(rendezvousId: number, kind: "take" | "give", nodeId: string, itemIds: string[], instanceIds: string[], botGuid: string, server: string, pass = false): void {
    this.o.db().prepare("INSERT INTO communism_meetings (rendezvous_id, kind, node_id, item_ids_json, instance_ids_json, bot_guid, server, created_at, pass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rendezvous_id) DO NOTHING")
      .run(rendezvousId, kind, nodeId, JSON.stringify(itemIds), JSON.stringify(instanceIds), botGuid, server, this.now(), pass ? 1 : 0);
  }

  meetings(): CommunismMeeting[] {
    const db = this.o.db();
    const pool = this.o.pool();
    db.prepare("DELETE FROM communism_meetings WHERE created_at < ? AND rendezvous_id IN (SELECT rendezvous_id FROM swap_rendezvous WHERE state IN ('done','failed','aborted','expired'))").run(this.now() - KEEP_DONE_MS);
    return (db.prepare(`SELECT m.rendezvous_id, m.kind, m.pass, m.node_id, m.item_ids_json, m.bot_guid, m.server, m.created_at, r.state, r.request_id
                        FROM communism_meetings m LEFT JOIN swap_rendezvous r ON r.rendezvous_id = m.rendezvous_id WHERE m.rendezvous_id > 0 ORDER BY m.created_at DESC`).all() as { rendezvous_id: number; kind: string; pass: number; node_id: string; item_ids_json: string; bot_guid: string; server: string; created_at: number; state: string | null; request_id: number | null }[])
      .map((m) => {
        const itemIds = JSON.parse(m.item_ids_json) as string[];
        return { rendezvousId: m.rendezvous_id, kind: m.kind as "take" | "give", ...(m.pass ? { pass: true } : {}), nodeId: m.node_id, itemIds, names: itemIds.map((id) => ITEM_BY_ID.get(id)?.name ?? id), botGuid: m.bot_guid, botIgn: pool?.botMeta?.[m.bot_guid]?.ign ?? "", server: m.server, createdAt: m.created_at, state: m.state, requestId: m.request_id };
      });
  }

  // --- CommunismResolver (for the swap coordinator's meetings) -----------------------------

  /**
   * Giver: a ref is an instance id. Our give hands a pool item over; another
   * node's take comes off a communism account — from its character, or from
   * its storage (the fleet fetches it onto the character before the meeting,
   * as for any per-instance withdraw).
   */
  giveInstance(rv: RendezvousWire, ref: string): string | null {
    const pool = this.o.pool();
    if (!pool) return null;
    const mine = this.o.db().prepare("SELECT kind, pass, instance_ids_json FROM communism_meetings WHERE rendezvous_id = ?").get(rv.id) as { kind: string; pass: number; instance_ids_json: string } | undefined;
    // A surplus pass is a give of ours whose items come off communism accounts.
    const passing = mine?.kind === "give" && mine.pass === 1;
    const fromCommunism = mine?.kind !== "give" || passing;
    // Only what this node itself put up: a give of ours hands over exactly the items it asked to give, and another
    // node's take only an item this node listed (the hub names the ref; it is checked against what we published; a
    // pass took its items off the listing when it started).
    if (mine?.kind === "give" && !(JSON.parse(mine.instance_ids_json) as string[]).includes(ref)) return null;
    if (fromCommunism && !passing && this.published !== null && !this.published.has(ref)) return null;
    const meta = pool.botMeta ?? {};
    for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
      if (isCommunismBot(meta[botGuid]) !== fromCommunism) continue;
      for (const info of Object.values(slots)) if (info.instanceId === ref) return fromCommunism && !communismTakes(info.itemId) ? null : ref;
    }
    if (fromCommunism) {
      for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) {
        if (!isCommunismBot(meta[botGuid])) continue;
        for (const s of stored) if (s.instanceId === ref) return communismTakes(s.itemId) ? ref : null;
      }
    }
    return null;
  }

  /** The catalog id of an item our give handed over, from what the give recorded (the pool no longer has it). */
  itemIdOf(rendezvousId: number, instanceId: string): string | null {
    const row = this.o.db().prepare("SELECT item_ids_json, instance_ids_json FROM communism_meetings WHERE rendezvous_id = ?").get(rendezvousId) as { item_ids_json: string; instance_ids_json: string } | undefined;
    if (!row) return null;
    const i = (JSON.parse(row.instance_ids_json) as string[]).indexOf(instanceId);
    return i < 0 ? null : (JSON.parse(row.item_ids_json) as string[])[i] ?? null;
  }

  /** Taker: our take receives on the pool bot we picked; a give into our communism lands on communism account the hub named. */
  receivingBot(rv: RendezvousWire): string | null {
    const row = this.o.db().prepare("SELECT bot_guid FROM communism_meetings WHERE rendezvous_id = ? AND kind = 'take'").get(rv.id) as { bot_guid: string } | undefined;
    if (row) return row.bot_guid;
    const pool = this.o.pool();
    if (!pool) return null;
    for (const [botGuid, meta] of Object.entries(pool.botMeta ?? {})) if (isCommunismBot(meta) && meta.ign && meta.ign.toLowerCase() === rv.me.botIgn.toLowerCase()) return botGuid;
    return null;
  }

  // --- lifecycle ---------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.o.swaps.setCommunismResolver(this);
    void this.publish();
    this.timer = setInterval(() => {
      void this.publish();
      void this.passSurplus().catch((e) => this.o.log(`communism: passing surplus on failed: ${String(e)}`));
    }, COMMUNISM_PUBLISH_MS);
    this.timer.unref?.();
    this.unhook = this.o.onPoolChanged?.(() => this.schedulePublish()) ?? null;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.unhook?.();
    this.unhook = null;
    this.o.swaps.setCommunismResolver(null);
  }

  status(): { linked: boolean; accounts: CommunismAccountView[]; items: CommunismItemView[]; room: { seasonal: ReturnType<CommunismCoordinator["room"]>; nonseasonal: ReturnType<CommunismCoordinator["room"]> }; meetings: CommunismMeeting[]; lastPublishAt: number | null; lastError: string | null; hub: CommunismStatusWire | null; receiveServer: { server: string; why: string } } {
    return { linked: this.o.hub.linked, accounts: this.accounts(), items: this.items(), room: { seasonal: this.room(true), nonseasonal: this.room(false) }, meetings: this.meetings(), lastPublishAt: this.lastPublishAt, lastError: this.lastError, hub: this.hubStatus, receiveServer: this.quietServer() };
  }
}

/** Names for items about to be handed over, for the log. */
function describeWire(items: { itemId: string }[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.itemId, (counts.get(i.itemId) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${n > 1 ? `${n}× ` : ""}${ITEM_BY_ID.get(id)?.name ?? id}`).join(", ");
}
