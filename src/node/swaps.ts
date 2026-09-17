// The swap coordinator (design doc §6.2): the node's side of offers and
// rendezvous. It knows which physical items back each offer, turns a hub
// rendezvous into a swap row for the fleet, and turns the fleet's result
// into a signed receipt. The physical trade is the fleet's job; the hub's
// job is to match the two receipts.
import type Database from "better-sqlite3";
import type { AcceptOfferRequest, CreateOfferRequest, NodeLimitsWire, OfferItemWire, OfferWire, ReceiptWire, RendezvousWire } from "../shared/hubWire";
import type { HubClient } from "./hub";
import type { PyrelayPool } from "../lib/devauth";
import { ITEM_BY_ID } from "../lib/catalog";
import * as queue from "../lib/queue";
import { pickForLines, shortfall, wantFromWire, wantToWire, type HeldItem, type WantLine, MAX_GIVE_ITEMS } from "../lib/offers";
import { ownedInstanceIds, reservedInstanceIds, vaultCount, vaultHalf, vaultItems, wishCount } from "../lib/vault";

/** Phase 4b: a guest of this node acting through the hub; their items are their personal vault here. */
export interface ForUser {
  localUserId: number;
  hubUserId: number;
}

export const RENDEZVOUS_POLL_MS = Number(process.env.SWAP_POLL_SECONDS ?? 10) * 1000;
const MAX_ENCHANTS = 8;

export type SwapsResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface SwapsOptions {
  db: () => Database.Database;
  hub: HubClient;
  /** The fleet's live view: every instance on every bot, with IGNs. */
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
}

/**
 * How a commons meeting (design doc §6.3) maps onto this node: the giver's
 * item is one of its contributed instances; the taker's side is the bot it
 * chose to receive with. Registered by the commons coordinator.
 */
export interface CommonsResolver {
  /** Giver: the instance id behind a contributed ref, if still contributed and held. */
  giveInstance(ref: string): string | null;
  /** Taker: the bot this node picked to receive with when it asked for the item. */
  receivingBot(rendezvousId: number): string | null;
  /** Everything contributed: not for offers. */
  contributedIds(): Set<string>;
}

/** What this node remembers about an offer it posted or accepted: which of its instances back the refs. */
interface LocalOffer {
  offerId: number;
  side: "poster" | "taker";
  botGuid: string;
  refs: Record<string, string>;
  status: string;
  /** Phase 4b: the guest whose vault the items belong to, or null for the owner. */
  localUserId: number | null;
}

export class SwapCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offResult: (() => void) | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private rendezvous: RendezvousWire[] = [];
  private readonly now: () => number;
  private commons: CommonsResolver | null = null;
  constructor(private readonly o: SwapsOptions) {
    this.now = o.now ?? Date.now;
    o.db().exec(`
      CREATE TABLE IF NOT EXISTS swap_offers (
        offer_id INTEGER PRIMARY KEY,
        side TEXT NOT NULL,
        bot_guid TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS swap_rendezvous (
        rendezvous_id INTEGER PRIMARY KEY,
        offer_id INTEGER,
        request_id INTEGER,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const cols = (o.db().prepare("PRAGMA table_info(swap_offers)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("local_user_id")) o.db().exec("ALTER TABLE swap_offers ADD COLUMN local_user_id INTEGER");
    // Commons meetings have no offer: an older table declared offer_id NOT NULL.
    const rvCols = o.db().prepare("PRAGMA table_info(swap_rendezvous)").all() as { name: string; notnull: number }[];
    if (rvCols.find((c) => c.name === "offer_id")?.notnull) {
      o.db().exec(`
        CREATE TABLE swap_rendezvous_new (rendezvous_id INTEGER PRIMARY KEY, offer_id INTEGER, request_id INTEGER, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO swap_rendezvous_new SELECT rendezvous_id, offer_id, request_id, state, created_at, updated_at FROM swap_rendezvous;
        DROP TABLE swap_rendezvous; ALTER TABLE swap_rendezvous_new RENAME TO swap_rendezvous;`);
    }
  }

  // --- what this node holds ------------------------------------------------------

  /**
   * Items that could be offered, with holder and IGN. The owner's are the
   * pool's: everything on the bots that no vault user owns. A guest's
   * (`localUserId`) are the rows of their personal vault that a bot holds.
   */
  held(seasonal?: boolean, localUserId: number | null = null): (HeldItem & { botGuid: string; botIgn: string; seasonal: boolean; name: string })[] {
    const pool = this.o.pool();
    if (!pool) return [];
    const reserved = this.reservedRefs();
    for (const id of this.commons?.contributedIds() ?? []) reserved.add(id);
    const owned = ownedInstanceIds(this.o.db());
    const mine = localUserId === null ? null : new Set(vaultItems(this.o.db(), localUserId).map((r) => r.instanceId));
    const out: (HeldItem & { botGuid: string; botIgn: string; seasonal: boolean; name: string })[] = [];
    for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
      const meta = pool.botMeta?.[botGuid];
      if (!meta || meta.suspended) continue;
      const s = meta.seasonal !== false;
      if (seasonal !== undefined && s !== seasonal) continue;
      for (const info of Object.values(slots)) {
        if (reserved.has(info.instanceId)) continue;
        if (mine ? !mine.has(info.instanceId) : owned.has(info.instanceId)) continue;
        const item = ITEM_BY_ID.get(info.itemId);
        if (!item) continue;
        out.push({ instanceId: info.instanceId, itemId: info.itemId, enchantIds: info.enchantments ?? [], createdAt: info.capturedAt, botGuid, botIgn: meta.ign, seasonal: s, name: item.name });
      }
    }
    return out;
  }
  /** Instances already promised: open offers of ours, plus open withdraw/swap rows. */
  private reservedRefs(): Set<string> {
    const out = new Set<string>();
    for (const o of this.localOffers()) if (o.status === "open" || o.status === "accepted") for (const id of Object.values(o.refs)) out.add(id);
    return out;
  }
  private localOffers(): LocalOffer[] {
    return (this.o.db().prepare("SELECT offer_id, side, bot_guid, refs_json, status, local_user_id FROM swap_offers").all() as { offer_id: number; side: string; bot_guid: string; refs_json: string; status: string; local_user_id: number | null }[])
      .map((r) => ({ offerId: r.offer_id, side: r.side as "poster" | "taker", botGuid: r.bot_guid, refs: JSON.parse(r.refs_json) as Record<string, string>, status: r.status, localUserId: r.local_user_id }));
  }
  private localOffer(offerId: number): LocalOffer | undefined {
    return this.localOffers().find((o) => o.offerId === offerId);
  }
  private saveLocalOffer(o: LocalOffer): void {
    const now = this.now();
    this.o.db().prepare("INSERT INTO swap_offers (offer_id, side, bot_guid, refs_json, status, created_at, updated_at, local_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(offer_id) DO UPDATE SET status = excluded.status, refs_json = excluded.refs_json, updated_at = excluded.updated_at, local_user_id = excluded.local_user_id")
      .run(o.offerId, o.side, o.botGuid, JSON.stringify(o.refs), o.status, now, now, o.localUserId);
  }
  private setLocalStatus(offerId: number, status: string): void {
    this.o.db().prepare("UPDATE swap_offers SET status = ?, updated_at = ? WHERE offer_id = ?").run(status, this.now(), offerId);
  }

  // --- offers -------------------------------------------------------------------

  private toWire(items: (HeldItem & { botGuid: string })[]): { give: OfferItemWire[]; refs: Record<string, string> } {
    const refs: Record<string, string> = {};
    const give = items.map((it, i) => {
      const ref = `r${i + 1}`;
      refs[ref] = it.instanceId;
      return { ref, itemId: it.itemId, enchants: it.enchantIds, count: it.enchantIds.length };
    });
    return { give, refs };
  }

  /** Post an offer: `instanceIds` for `want`, met on `server`. All items must sit on one bot. `forUser`: a guest's vault items, posted under their name. */
  async createOffer(input: { instanceIds: string[]; want: WantLine[]; server: string; forUser?: ForUser }): Promise<SwapsResult<{ offer: OfferWire }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Fleet → Node)." };
    const ids = [...new Set(input.instanceIds)];
    if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item to give." };
    if (ids.length > MAX_GIVE_ITEMS) return { ok: false, status: 400, error: `At most ${MAX_GIVE_ITEMS} items in one offer.` };
    const held = this.held(undefined, input.forUser?.localUserId ?? null);
    const items = ids.map((id) => held.find((h) => h.instanceId === id));
    if (items.some((h) => !h)) return { ok: false, status: 409, error: "One of those items is no longer free on this node (already offered, reserved, or gone)." };
    const picked = items as (HeldItem & { botGuid: string; botIgn: string; seasonal: boolean })[];
    const bots = new Set(picked.map((p) => p.botGuid));
    if (bots.size !== 1) return { ok: false, status: 400, error: "All items of one offer must sit on the same account (one bot trades at a time)." };
    if (picked.some((p) => p.enchantIds.length > MAX_ENCHANTS)) return { ok: false, status: 400, error: "An item has too many enchantments to trade in game." };
    const bot = picked[0];
    if (!bot.botIgn) return { ok: false, status: 409, error: "That account has never logged in on this node, so its name is unknown. Log it in once first." };
    const { give, refs } = this.toWire(picked);
    if (input.forUser) {
      // What the guest asks for has to fit their vault half once their gives leave.
      const room = this.guestRoom(input.forUser.localUserId, bot.seasonal, ids.length);
      const incoming = input.want.reduce((n, w) => n + w.qty, 0);
      if (incoming > room) return { ok: false, status: 409, error: `Their vault half has room for ${room} more item(s); this offer asks for ${incoming}.` };
    }
    const req: CreateOfferRequest = { botIgn: bot.botIgn, seasonal: bot.seasonal, server: input.server, give, want: wantToWire(input.want), ...(input.forUser ? { onBehalfOf: input.forUser.hubUserId } : {}) };
    const r = await this.o.hub.signed<{ offer: OfferWire }>("POST", "/api/v1/offers", req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.saveLocalOffer({ offerId: r.data.offer.id, side: "poster", botGuid: bot.botGuid, refs, status: "open", localUserId: input.forUser?.localUserId ?? null });
    this.o.log(`swaps: posted offer #${r.data.offer.id}: ${give.length} item(s) from ${bot.botIgn} on ${input.server}`);
    return { ok: true, offer: r.data.offer };
  }

  async cancelOffer(offerId: number): Promise<SwapsResult<{ cancelled: true }>> {
    const r = await this.o.hub.signed<{ ok: true }>("DELETE", `/api/v1/offers/${offerId}`, {});
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.setLocalStatus(offerId, "cancelled");
    return { ok: true, cancelled: true };
  }

  /** Free slots in a guest's half after `leaving` items go: slots − held − wishes + leaving. */
  private guestRoom(localUserId: number, seasonal: boolean, leaving: number): number {
    const db = this.o.db();
    const half = vaultHalf(db, localUserId, seasonal);
    return Math.max(0, half.slots - vaultCount(db, localUserId, seasonal) - wishCount(db, localUserId, seasonal) + leaving);
  }

  /** What I would hand over for `offer`, or why I can't. `forUser`: from a guest's vault. */
  preview(offer: OfferWire, forUser?: ForUser): { ok: true; picks: (HeldItem & { botGuid: string; botIgn: string; name: string })[] } | { ok: false; error: string } {
    const want = wantFromWire(offer.want);
    const mine = this.held(offer.seasonal, forUser?.localUserId ?? null);
    const picks = pickForLines(want, mine);
    if (!picks) return { ok: false, error: shortfall(want, mine) };
    const full = picks.map((p) => mine.find((m) => m.instanceId === p.instanceId)!);
    if (new Set(full.map((p) => p.botGuid)).size !== 1) return { ok: false, error: "The items that fit are spread over several of your accounts; one account has to hold them all for a single trade." };
    if (!full[0].botIgn) return { ok: false, error: "The account holding the fitting items has never logged in here, so its name is unknown." };
    if (forUser) {
      const room = this.guestRoom(forUser.localUserId, offer.seasonal, full.length);
      if (offer.give.length > room) return { ok: false, error: `Their vault half has room for ${room} more item(s); this offer gives ${offer.give.length}.` };
    }
    return { ok: true, picks: full };
  }

  /** Accept `offer` with exactly the previewed picks. `forUser`: a guest accepts with their vault items. */
  async acceptOffer(offer: OfferWire, forUser?: ForUser): Promise<SwapsResult<{ rendezvous: RendezvousWire }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Fleet → Node)." };
    const pv = this.preview(offer, forUser);
    if (!pv.ok) return { ok: false, status: 409, error: pv.error };
    const { give, refs } = this.toWire(pv.picks);
    const req: AcceptOfferRequest = { botIgn: pv.picks[0].botIgn, items: give, ...(forUser ? { onBehalfOf: forUser.hubUserId } : {}) };
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire }>("POST", `/api/v1/offers/${offer.id}/accept`, req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.saveLocalOffer({ offerId: offer.id, side: "taker", botGuid: pv.picks[0].botGuid, refs, status: "accepted", localUserId: forUser?.localUserId ?? null });
    this.o.log(`swaps: accepted offer #${offer.id}; rendezvous #${r.data.rendezvous.id} on ${r.data.rendezvous.server}`);
    await this.adopt(r.data.rendezvous);
    return { ok: true, rendezvous: r.data.rendezvous };
  }

  async browse(): Promise<SwapsResult<{ offers: OfferWire[]; limits: NodeLimitsWire | null }>> {
    const r = await this.o.hub.signed<{ offers: OfferWire[]; limits?: NodeLimitsWire }>("GET", "/api/v1/offers?open=1");
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    return { ok: true, offers: r.data.offers, limits: r.data.limits ?? null };
  }
  async mine(): Promise<SwapsResult<{ offers: OfferWire[]; limits: NodeLimitsWire | null }>> {
    const r = await this.o.hub.signed<{ offers: OfferWire[]; limits?: NodeLimitsWire }>("GET", "/api/v1/offers/mine");
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    for (const o of r.data.offers) if (this.localOffer(o.id) && o.status !== "open" && o.status !== "accepted") this.setLocalStatus(o.id, o.status);
    return { ok: true, offers: r.data.offers, limits: r.data.limits ?? null };
  }

  // --- rendezvous ------------------------------------------------------------------

  setCommonsResolver(r: CommonsResolver | null): void {
    this.commons = r;
  }

  /** A rendezvous the hub scheduled: queue my side as a swap row once. */
  async adopt(rv: RendezvousWire): Promise<void> {
    const db = this.o.db();
    const known = db.prepare("SELECT request_id, state FROM swap_rendezvous WHERE rendezvous_id = ?").get(rv.id) as { request_id: number | null; state: string } | undefined;
    if (rv.state !== "meet") {
      if (known && known.state !== rv.state) {
        db.prepare("UPDATE swap_rendezvous SET state = ?, updated_at = ? WHERE rendezvous_id = ?").run(rv.state, this.now(), rv.id);
        if (known.request_id !== null && (rv.state === "aborted" || rv.state === "failed" || rv.state === "disputed")) queue.cancelSwapJob(db, known.request_id, `hub says ${rv.state}`);
        const local = rv.offerId === null ? undefined : this.localOffer(rv.offerId);
        if (local && rv.offerId !== null) this.setLocalStatus(rv.offerId, rv.state === "done" ? "done" : local.side === "poster" && rv.state !== "disputed" ? "open" : rv.state);
      }
      return;
    }
    if (known) {
      // Still "meet" but past the deadline with our side not traded: give the
      // row back and tell the hub, so the offer reopens instead of hanging.
      if (this.now() > rv.deadlineAt && known.state === "meet" && known.request_id !== null) {
        const row = queue.swapJobsFor(db, rv.id).find((j) => j.id === known.request_id);
        if (row && (row.status === "pending" || row.status === "claimed")) {
          queue.cancelSwapJob(db, known.request_id, "deadline passed");
          db.prepare("UPDATE swap_rendezvous SET state = 'aborted', updated_at = ? WHERE rendezvous_id = ?").run(this.now(), rv.id);
          this.o.log(`swaps: rendezvous #${rv.id} passed its deadline without a trade; aborting`);
          await this.o.hub.signed("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "deadline passed, no trade" });
        }
      }
      return;
    }
    const abort = async (reason: string) => {
      this.o.log(`swaps: rendezvous #${rv.id}: ${reason}; aborting`);
      await this.o.hub.signed("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason });
    };
    // What this side hands over and from which bot, by kind.
    let giveIds: string[];
    let fallbackBot: string | null;
    let vaultUserId: number | null = null;
    if (rv.kind === "commons") {
      if (!this.commons) return abort("commons not running on this node");
      if (rv.me.role === "give") {
        giveIds = rv.me.gives.map((g) => this.commons!.giveInstance(g.ref)).filter((id): id is string => !!id);
        if (giveIds.length !== rv.me.gives.length) return abort("the contributed item is no longer here");
        fallbackBot = null;
      } else {
        giveIds = [];
        fallbackBot = this.commons.receivingBot(rv.id);
        if (!fallbackBot) return abort("no receiving bot recorded for this hand-over");
      }
    } else {
      const local = rv.offerId === null ? undefined : this.localOffer(rv.offerId);
      if (!local) {
        this.o.log(`swaps: rendezvous #${rv.id} refers to offer #${rv.offerId} this node has no record of; ignoring`);
        return;
      }
      giveIds = rv.me.gives.map((g) => local.refs[g.ref]).filter((id): id is string => !!id);
      if (giveIds.length !== rv.me.gives.length) return abort("items no longer known to the node");
      fallbackBot = local.botGuid;
      vaultUserId = local.localUserId;
    }
    // An item already promised elsewhere (an owner withdraw, another meeting) cannot be handed over twice.
    if (giveIds.length) {
      const reserved = reservedInstanceIds(db);
      if (giveIds.some((id) => reserved.has(id))) return abort("an item is already reserved by another request");
    }
    // The holder now: an item may have moved bots since it was offered.
    const pool = this.o.pool();
    const holders = new Set<string>();
    if (pool && giveIds.length) for (const [g, slots] of Object.entries(pool.instances ?? {})) for (const info of Object.values(slots)) if (giveIds.includes(info.instanceId)) holders.add(g);
    const botGuid = holders.size === 1 ? [...holders][0] : fallbackBot;
    if (!botGuid) return abort("the items are not on one bot");
    if (giveIds.length && holders.size !== 1) this.o.log(`swaps: rendezvous #${rv.id}: items on ${holders.size} bots; using the offer's account`);
    const give = collapse(rv.me.gives.map((g) => g.itemId));
    const requestId = queue.createSwapJob(db, { server: rv.server, botGuid, partnerIgn: rv.partner.botIgn, seasonal: rv.seasonal, give, giveInstanceIds: giveIds, swap: { rendezvousId: rv.id, role: rv.me.role, gets: rv.me.gets, vaultUserId } });
    db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, 'meet', ?, ?)").run(rv.id, rv.offerId, requestId, this.now(), this.now());
    this.o.log(`swaps: ${rv.kind === "commons" ? "hand-over" : "rendezvous"} #${rv.id} queued as swap #${requestId}: ${rv.me.role} with ${rv.partner.botIgn} on ${rv.server}`);
  }

  /**
   * Give a meeting up from this side, before the deadline: a full server,
   * a bot that will not log in. The hub marks it aborted (an offer reopens,
   * a commons item is listed again) and the poll that follows cancels the
   * local row and puts the offer back the way the hub says.
   */
  async abortRendezvous(rendezvousId: number, reason = "aborted by the operator"): Promise<SwapsResult<{ aborted: true; state: string }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Fleet → Node)." };
    const r = await this.o.hub.signed<{ ok: true; state: string }>("POST", `/api/v1/rendezvous/${rendezvousId}/abort`, { reason });
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.o.log(`swaps: rendezvous #${rendezvousId} aborted from this node: ${reason}`);
    await this.poll();
    return { ok: true, aborted: true, state: r.data.state };
  }

  /** The fleet finished (or failed) a swap row: send the receipt. */
  private async onResult(requestId: number, swap: queue.SwapSpec, result: queue.SwapResult): Promise<void> {
    const db = this.o.db();
    const receipt: ReceiptWire = {
      window: 0, ok: result.ok, gave: result.gave, gaveRefs: this.refsFor(swap.rendezvousId, result.gaveInstanceIds), got: result.got,
      partnerIgn: result.partnerIgn, ...(result.error ? { error: result.error } : {}), at: this.now(),
    };
    const r = await this.o.hub.signed<{ ok: true; state: string }>("POST", `/api/v1/rendezvous/${swap.rendezvousId}/receipt`, receipt);
    if (!r.ok) {
      this.lastError = `receipt for #${swap.rendezvousId}: ${r.error}`;
      this.o.log(`swaps: ${this.lastError}`);
      db.prepare("UPDATE swap_rendezvous SET state = 'receipt-pending', updated_at = ? WHERE rendezvous_id = ?").run(this.now(), swap.rendezvousId);
      return;
    }
    db.prepare("UPDATE swap_rendezvous SET state = ?, updated_at = ? WHERE rendezvous_id = ?").run(r.data.state, this.now(), swap.rendezvousId);
    this.o.log(`swaps: receipt for rendezvous #${swap.rendezvousId} sent (${result.ok ? "ok" : result.error}); hub says ${r.data.state}`);
  }
  private refsFor(rendezvousId: number, instanceIds: string[]): string[] {
    const row = this.o.db().prepare("SELECT offer_id FROM swap_rendezvous WHERE rendezvous_id = ?").get(rendezvousId) as { offer_id: number | null } | undefined;
    // Commons hand-overs use the instance id as the ref.
    if (row && row.offer_id === null) return instanceIds;
    const local = row?.offer_id != null ? this.localOffer(row.offer_id) : undefined;
    if (!local) return [];
    const byId = new Map(Object.entries(local.refs).map(([ref, id]) => [id, ref]));
    return instanceIds.map((id) => byId.get(id)).filter((r): r is string => !!r);
  }

  async poll(): Promise<void> {
    if (!this.o.hub.linked) return;
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire[] }>("GET", "/api/v1/rendezvous/mine");
    this.lastPollAt = this.now();
    if (!r.ok) {
      this.lastError = r.error;
      return;
    }
    this.lastError = null;
    this.rendezvous = r.data.rendezvous;
    for (const rv of r.data.rendezvous) await this.adopt(rv);
  }

  start(): void {
    if (this.timer) return;
    this.offResult = queue.onSwapResult((id, swap, result) => void this.onResult(id, swap, result));
    void this.poll();
    this.timer = setInterval(() => void this.poll(), RENDEZVOUS_POLL_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offResult?.();
    this.offResult = null;
  }

  status(): { linked: boolean; lastPollAt: number | null; lastError: string | null; rendezvous: (RendezvousWire & { requestId: number | null; localState: string | null })[]; localOffers: LocalOffer[] } {
    const db = this.o.db();
    const rows = new Map((db.prepare("SELECT rendezvous_id, request_id, state FROM swap_rendezvous").all() as { rendezvous_id: number; request_id: number | null; state: string }[]).map((r) => [r.rendezvous_id, r]));
    return {
      linked: this.o.hub.linked, lastPollAt: this.lastPollAt, lastError: this.lastError,
      rendezvous: this.rendezvous.map((rv) => ({ ...rv, requestId: rows.get(rv.id)?.request_id ?? null, localState: rows.get(rv.id)?.state ?? null })),
      localOffers: this.localOffers(),
    };
  }
}

function collapse(itemIds: string[]): { itemId: string; qty: number }[] {
  const m = new Map<string, number>();
  for (const id of itemIds) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m].map(([itemId, qty]) => ({ itemId, qty }));
}
