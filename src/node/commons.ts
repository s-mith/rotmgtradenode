// The commons (design doc §6.3): free hand-overs between nodes, no points.
// A contributor lists items it holds; any other node may take one, bounded
// by the hub's per-node daily cap. A contributed item stays on its bot
// until someone asks for it; the hub then schedules a one-way meeting that
// the swap coordinator runs like a swap with nothing coming back. The hub
// counts a hand-over only when both receipts agree.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { CommonsItemWire, CommonsListingWire, CommonsStatusWire, CommonsWithdrawRequest, PublishCommonsRequest, RendezvousWire } from "../shared/hubWire";
import type { HubClient } from "./hub";
import type { CommonsResolver, SwapCoordinator, SwapsResult } from "./swaps";
import type { PyrelayPool } from "../lib/devauth";
import { ITEM_BY_ID } from "../lib/catalog";
import { SLOTS_PER_BOT } from "../lib/capacity";
import { ownedInstanceIds, reservedInstanceIds, sharedVaultBots, vaultBotGuids } from "../lib/vault";

export const COMMONS_PUBLISH_MS = Number(process.env.COMMONS_PUBLISH_SECONDS ?? 30) * 1000;
/** Republish even when nothing changed, so a hub that lost the listing gets it back. */
const REPUBLISH_MS = 10 * 60_000;
/** Finished hand-overs stay in the status list this long. */
const KEEP_DONE_MS = 24 * 3_600_000;
const MAX_ENCHANTS = 8;

export interface CommonsOptions {
  db: () => Database.Database;
  hub: HubClient;
  swaps: SwapCoordinator;
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
}

/** A contributed item as it stands now: where it is, and whether the hub is told about it. */
export interface ContributedItem {
  instanceId: string;
  itemId: string;
  name: string;
  enchants: number[];
  seasonal: boolean;
  botGuid: string;
  botIgn: string;
  contributedAt: number;
  /** In the published listing. When false, `why` says what keeps it off. */
  listed: boolean;
  why: string | null;
}

/** A hand-over this node asked for: which bot receives, and how the meeting went. */
export interface CommonsWithdraw {
  rendezvousId: number;
  nodeId: string;
  ref: string;
  itemId: string;
  name: string;
  botGuid: string;
  botIgn: string;
  server: string;
  createdAt: number;
  state: string | null;
  requestId: number | null;
}

export class CommonsCoordinator implements CommonsResolver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPublishAt: number | null = null;
  private lastPublishHash = "";
  private lastError: string | null = null;
  private hubStatus: CommonsStatusWire | null = null;
  private readonly now: () => number;
  constructor(private readonly o: CommonsOptions) {
    this.now = o.now ?? Date.now;
    o.db().exec(`
      CREATE TABLE IF NOT EXISTS commons_items (
        instance_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        contributed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commons_withdraws (
        rendezvous_id INTEGER PRIMARY KEY,
        node_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        item_id TEXT NOT NULL,
        bot_guid TEXT NOT NULL,
        server TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // --- what this node contributes ---------------------------------------------------

  /** Every contributed instance, with the live view of where it sits. Rows whose item left the fleet are dropped. */
  items(): ContributedItem[] {
    const db = this.o.db();
    const rows = db.prepare("SELECT instance_id, item_id, contributed_at FROM commons_items ORDER BY contributed_at ASC").all() as { instance_id: string; item_id: string; contributed_at: number }[];
    if (!rows.length) return [];
    const pool = this.o.pool();
    if (!pool) return rows.map((r) => ({ instanceId: r.instance_id, itemId: r.item_id, name: ITEM_BY_ID.get(r.item_id)?.name ?? r.item_id, enchants: [], seasonal: true, botGuid: "", botIgn: "", contributedAt: r.contributed_at, listed: false, why: "the fleet is off" }));
    const where = new Map<string, { botGuid: string; enchants: number[] }>();
    for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) for (const info of Object.values(slots)) where.set(info.instanceId, { botGuid, enchants: info.enchantments ?? [] });
    const reserved = reservedInstanceIds(db);
    const out: ContributedItem[] = [];
    for (const r of rows) {
      const at = where.get(r.instance_id);
      if (!at) {
        // Withdrawn, handed over, or lost: nothing is owed, it just stops being listed.
        db.prepare("DELETE FROM commons_items WHERE instance_id = ?").run(r.instance_id);
        this.o.log(`commons: ${r.item_id} (${r.instance_id.slice(0, 8)}) is no longer on any account; unlisted`);
        continue;
      }
      const meta = pool.botMeta?.[at.botGuid];
      const why = !meta?.ign ? "that account has never logged in here, so its name is unknown" : meta.suspended ? "that account is suspended" : reserved.has(r.instance_id) ? "hand-over in progress" : at.enchants.length > MAX_ENCHANTS ? "too many enchantments to trade" : null;
      out.push({ instanceId: r.instance_id, itemId: r.item_id, name: ITEM_BY_ID.get(r.item_id)?.name ?? r.item_id, enchants: at.enchants, seasonal: meta?.seasonal !== false, botGuid: at.botGuid, botIgn: meta?.ign ?? "", contributedAt: r.contributed_at, listed: why === null, why });
    }
    return out;
  }

  /** Instances the commons has spoken for: not for offers, not for pool picks by the fleet's owner through the trade desk. */
  contributedIds(): Set<string> {
    return new Set((this.o.db().prepare("SELECT instance_id FROM commons_items").all() as { instance_id: string }[]).map((r) => r.instance_id));
  }

  /** Put `instanceIds` in the commons: pool items on this node's bots that nothing else has claimed. */
  async contribute(instanceIds: string[]): Promise<SwapsResult<{ added: number }>> {
    const ids = [...new Set(instanceIds)];
    if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item." };
    const pool = this.o.pool();
    if (!pool) return { ok: false, status: 503, error: "The fleet is off." };
    const db = this.o.db();
    const already = this.contributedIds();
    const owned = ownedInstanceIds(db);
    const reserved = reservedInstanceIds(db);
    const free = new Set(this.o.swaps.held().map((h) => h.instanceId));
    const where = new Map<string, { itemId: string; enchants: number[] }>();
    for (const slots of Object.values(pool.instances ?? {})) for (const info of Object.values(slots)) where.set(info.instanceId, { itemId: info.itemId, enchants: info.enchantments ?? [] });
    for (const id of ids) {
      const at = where.get(id);
      if (!at) return { ok: false, status: 404, error: "One of those items is not on any of your accounts." };
      if (already.has(id)) return { ok: false, status: 409, error: `${ITEM_BY_ID.get(at.itemId)?.name ?? at.itemId} is already in the commons.` };
      if (owned.has(id)) return { ok: false, status: 409, error: `${ITEM_BY_ID.get(at.itemId)?.name ?? at.itemId} belongs to somebody's vault, not the pool.` };
      if (reserved.has(id) || !free.has(id)) return { ok: false, status: 409, error: `${ITEM_BY_ID.get(at.itemId)?.name ?? at.itemId} is already spoken for (an open withdraw or offer).` };
      if (at.enchants.length > MAX_ENCHANTS) return { ok: false, status: 400, error: `${ITEM_BY_ID.get(at.itemId)?.name ?? at.itemId} has too many enchantments to trade in game.` };
    }
    const ins = db.prepare("INSERT INTO commons_items (instance_id, item_id, contributed_at) VALUES (?, ?, ?)");
    const now = this.now();
    db.transaction(() => { for (const id of ids) ins.run(id, where.get(id)!.itemId, now); })();
    this.o.log(`commons: contributed ${ids.length} item(s)`);
    await this.publish();
    return { ok: true, added: ids.length };
  }

  /** Take `instanceIds` back out of the commons. An item mid hand-over stays until the meeting ends. */
  async uncontribute(instanceIds: string[]): Promise<SwapsResult<{ removed: number }>> {
    const ids = [...new Set(instanceIds)];
    if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item." };
    const db = this.o.db();
    const reserved = reservedInstanceIds(db);
    if (ids.some((id) => reserved.has(id))) return { ok: false, status: 409, error: "That item is being handed over right now; it leaves the commons when the meeting ends." };
    const del = db.prepare("DELETE FROM commons_items WHERE instance_id = ?");
    let removed = 0;
    db.transaction(() => { for (const id of ids) removed += del.run(id).changes; })();
    if (removed) await this.publish();
    return { ok: true, removed };
  }

  publishPayload(): PublishCommonsRequest {
    const items: CommonsItemWire[] = this.items().filter((i) => i.listed).map((i) => ({ ref: i.instanceId, itemId: i.itemId, name: i.name, enchants: i.enchants.length ? i.enchants : null, count: i.enchants.length, seasonal: i.seasonal, botIgn: i.botIgn }));
    return { items, at: this.now() };
  }

  /** Tell the hub what this node lists now. Skipped when nothing changed since the last time, unless `force`. */
  async publish(force = false): Promise<boolean> {
    if (!this.o.hub.linked) return false;
    const payload = this.publishPayload();
    const hash = createHash("sha256").update(JSON.stringify(payload.items)).digest("hex");
    const stale = this.lastPublishAt === null || this.now() - this.lastPublishAt > REPUBLISH_MS;
    if (!force && !stale && hash === this.lastPublishHash) return true;
    const r = await this.o.hub.signed<{ ok: true; listed: number }>("POST", "/api/v1/commons/publish", payload);
    if (!r.ok) {
      this.lastError = `publish: ${r.error}`;
      this.o.log(`commons: ${this.lastError}`);
      return false;
    }
    this.lastError = null;
    this.lastPublishAt = this.now();
    this.lastPublishHash = hash;
    return true;
  }

  // --- what other nodes contribute ---------------------------------------------------

  async browse(seasonal?: boolean): Promise<SwapsResult<{ items: CommonsListingWire[]; status: CommonsStatusWire }>> {
    const r = await this.o.hub.signed<{ items: CommonsListingWire[]; status: CommonsStatusWire }>("GET", `/api/v1/commons${seasonal === undefined ? "" : `?seasonal=${seasonal ? 1 : 0}`}`);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.hubStatus = r.data.status;
    return { ok: true, items: r.data.items, status: r.data.status };
  }
  async mine(): Promise<SwapsResult<{ items: CommonsItemWire[]; status: CommonsStatusWire }>> {
    const r = await this.o.hub.signed<{ items: CommonsItemWire[]; status: CommonsStatusWire }>("GET", "/api/v1/commons/mine");
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.hubStatus = r.data.status;
    return { ok: true, items: r.data.items, status: r.data.status };
  }

  /**
   * The account that receives a commons item for the `seasonal` pool: a
   * pool bot of that half with a free slot and a known name, online first,
   * then the one with the most room. Slots promised to hand-overs still
   * under way are not free.
   */
  receivingBot(seasonal: boolean): { botGuid: string; ign: string; free: number } | null;
  receivingBot(rendezvousId: number): string | null;
  receivingBot(arg: boolean | number): { botGuid: string; ign: string; free: number } | string | null {
    if (typeof arg === "number") {
      const row = this.o.db().prepare("SELECT bot_guid FROM commons_withdraws WHERE rendezvous_id = ?").get(arg) as { bot_guid: string } | undefined;
      return row?.bot_guid ?? null;
    }
    const pool = this.o.pool();
    if (!pool) return null;
    const db = this.o.db();
    const vaultBots = sharedVaultBots() ? new Set<string>() : vaultBotGuids(db);
    const pending = new Map<string, number>();
    for (const w of this.withdraws()) if (w.state === "meet" || w.state === "receipt-pending") pending.set(w.botGuid, (pending.get(w.botGuid) ?? 0) + 1);
    let best: { botGuid: string; ign: string; free: number; online: boolean } | null = null;
    for (const [botGuid, meta] of Object.entries(pool.botMeta ?? {})) {
      if (!meta.ign || meta.suspended || vaultBots.has(botGuid)) continue;
      if ((meta.seasonal !== false) !== arg) continue;
      const cap = pool.capacities?.[botGuid] ?? SLOTS_PER_BOT;
      const used = Object.values(pool.bots?.[botGuid] ?? {}).reduce((n, q) => n + q, 0);
      const free = cap - used - (pending.get(botGuid) ?? 0);
      if (free < 1) continue;
      const cand = { botGuid, ign: meta.ign, free, online: !!meta.online };
      if (!best || (cand.online && !best.online) || (cand.online === best.online && cand.free > best.free)) best = cand;
    }
    return best ? { botGuid: best.botGuid, ign: best.ign, free: best.free } : null;
  }

  /** Ask for a listed item: the hub schedules the meeting, this node queues its receiving side. */
  async withdraw(input: { nodeId: string; ref: string; itemId: string; seasonal: boolean; server: string }): Promise<SwapsResult<{ rendezvous: RendezvousWire; botIgn: string }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Fleet → Node)." };
    if (!ITEM_BY_ID.has(input.itemId)) return { ok: false, status: 400, error: "Unknown item." };
    const bot = this.receivingBot(input.seasonal);
    if (!bot) return { ok: false, status: 409, error: `No ${input.seasonal ? "seasonal" : "non-seasonal"} account of yours has a free slot and a known name.` };
    const req: CommonsWithdrawRequest = { nodeId: input.nodeId, ref: input.ref, server: input.server, botIgn: bot.ign };
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire }>("POST", "/api/v1/commons/withdraw", req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    const rv = r.data.rendezvous;
    this.o.db().prepare("INSERT INTO commons_withdraws (rendezvous_id, node_id, ref, item_id, bot_guid, server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rendezvous_id) DO NOTHING")
      .run(rv.id, input.nodeId, input.ref, input.itemId, bot.botGuid, rv.server, this.now());
    this.o.log(`commons: asked for ${ITEM_BY_ID.get(input.itemId)?.name ?? input.itemId} from ${rv.partner.botIgn}; ${bot.ign} receives on ${rv.server} (meeting #${rv.id})`);
    await this.o.swaps.adopt(rv);
    return { ok: true, rendezvous: rv, botIgn: bot.ign };
  }

  withdraws(): CommonsWithdraw[] {
    const db = this.o.db();
    const pool = this.o.pool();
    db.prepare("DELETE FROM commons_withdraws WHERE created_at < ? AND rendezvous_id IN (SELECT rendezvous_id FROM swap_rendezvous WHERE state IN ('done','failed','aborted','expired'))").run(this.now() - KEEP_DONE_MS);
    return (db.prepare(`SELECT w.rendezvous_id, w.node_id, w.ref, w.item_id, w.bot_guid, w.server, w.created_at, r.state, r.request_id
                        FROM commons_withdraws w LEFT JOIN swap_rendezvous r ON r.rendezvous_id = w.rendezvous_id ORDER BY w.created_at DESC`).all() as { rendezvous_id: number; node_id: string; ref: string; item_id: string; bot_guid: string; server: string; created_at: number; state: string | null; request_id: number | null }[])
      .map((w) => ({ rendezvousId: w.rendezvous_id, nodeId: w.node_id, ref: w.ref, itemId: w.item_id, name: ITEM_BY_ID.get(w.item_id)?.name ?? w.item_id, botGuid: w.bot_guid, botIgn: pool?.botMeta?.[w.bot_guid]?.ign ?? "", server: w.server, createdAt: w.created_at, state: w.state, requestId: w.request_id }));
  }

  // --- CommonsResolver (for the swap coordinator's meetings) -----------------------------

  giveInstance(ref: string): string | null {
    const row = this.o.db().prepare("SELECT instance_id FROM commons_items WHERE instance_id = ?").get(ref) as { instance_id: string } | undefined;
    if (!row) return null;
    const pool = this.o.pool();
    if (!pool) return null;
    for (const slots of Object.values(pool.instances ?? {})) for (const info of Object.values(slots)) if (info.instanceId === ref) return ref;
    return null;
  }

  // --- lifecycle ---------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.o.swaps.setCommonsResolver(this);
    void this.publish();
    this.timer = setInterval(() => void this.publish(), COMMONS_PUBLISH_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.o.swaps.setCommonsResolver(null);
  }

  status(): { linked: boolean; items: ContributedItem[]; withdraws: CommonsWithdraw[]; lastPublishAt: number | null; lastError: string | null; hub: CommonsStatusWire | null } {
    return { linked: this.o.hub.linked, items: this.items(), withdraws: this.withdraws(), lastPublishAt: this.lastPublishAt, lastError: this.lastError, hub: this.hubStatus };
  }
}
