// The swap coordinator (design doc §6.2): the node's side of offers and
// rendezvous. It knows which physical items back each offer, turns a hub
// rendezvous into a swap row for the fleet, and turns the fleet's result
// into a signed receipt. The physical trade is the fleet's job; the hub's
// job is to match the two receipts.
//
// What it also keeps straight, because a meeting spans two machines and a
// game server: a receipt the hub did not take is kept and sent again; a
// swap row whose trade result was lost (a disconnect, a restart) is settled
// from a fresh look at the bot; a meeting the hub still shows as due gets
// its deadline stretched while this side is trying; and an offer whose items
// left the node is withdrawn rather than left to fail at the meeting.
//
// One item may sit in several offers at once. Each names it by its instance
// id, the same ref everywhere, so the hub can see it: while a meeting has the
// item the hub holds the other offers, and once it is traded away there it
// withdraws them (docs/hub-protocol.md).
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_ENCHANTS, tradeableEnchants } from "../relay/protocol/enchants";
import type { AcceptOfferRequest, CreateOfferRequest, MeetingProgressWire, NodeLimitsWire, OfferItemWire, OfferWire, ReceiptWire, RendezvousWire } from "../shared/hubWire";
import { wantLineWords } from "../shared/wantWords";
import type { HubClient } from "./hub";
import type { PyrelayPool } from "../lib/devauth";
import { ITEM_BY_ID } from "../lib/catalog";
import { nodeTakes } from "../lib/itemPolicy";
import * as queue from "../lib/queue";
import { pickForLines, shortfall, wantFromWire, wantToWire, type HeldItem, type WantLine, MAX_GIVE_ITEMS } from "../lib/offers";
import { pickedByWithdraws, reservedByRequests, reservedInstanceIds } from "../lib/reservations";
import { isCommunismBot } from "../lib/communismPool";
import { SLOTS_PER_BOT } from "../lib/capacity";
import { WITHDRAW_SERVERS } from "../lib/servers";
import { blockMessage, withdrawBlock } from "../lib/serverControls";
import { serverUsage } from "../lib/serverUsage";
import { pickQuietServer } from "../lib/quietServer";

export const RENDEZVOUS_POLL_MS = Number(process.env.SWAP_POLL_SECONDS ?? 10) * 1000;
/** Local offer statuses are checked against the hub's, and posted offers against the pool, this often. */
export const OFFER_SYNC_MS = Number(process.env.SWAP_OFFER_SYNC_SECONDS ?? 60) * 1000;
/** A swap row back on pending this long without a bot on it is looked into: did the trade already happen? */
export const OUTCOME_CHECK_AFTER_MS = Number(process.env.SWAP_OUTCOME_CHECK_SECONDS ?? 60) * 1000;
/** How long a giving row's items may be missing from the node before its meeting is given up. */
export const MISSING_ITEMS_GRACE_MS = Number(process.env.SWAP_MISSING_ITEMS_GRACE_SECONDS ?? 120) * 1000;
/** With this much of a meeting's window left and this side still trying, the hub is asked for more time (meetings get six minutes). */
export const EXTEND_WINDOW_MS = Number(process.env.SWAP_EXTEND_WINDOW_SECONDS ?? 120) * 1000;
/** At most one extension request per meeting this often. */
export const EXTEND_EVERY_MS = Number(process.env.SWAP_EXTEND_EVERY_SECONDS ?? 600) * 1000;
/**
 * A communism meeting this node cannot place yet (which bot receives, which item it gives) is given this long before it
 * is called off: the hub may list a take or give we asked for before our own call has come back and recorded it.
 */
export const COMMUNISM_RESOLVE_GRACE_MS = Number(process.env.SWAP_COMMUNISM_GRACE_SECONDS ?? 30) * 1000;

export type SwapsResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface SwapsOptions {
  db: () => Database.Database;
  hub: HubClient;
  /** The fleet's live view: every instance on every bot, with IGNs. */
  pool: () => PyrelayPool | null;
  log: (s: string) => void;
  now?: () => number;
  /** When the fleet last read a bot's live inventory (ms epoch), null when never: the outcome check trusts only a look taken after the row went back to pending. */
  verifiedAt?: (botGuid: string) => number | null;
  /** Log a bot in for a look at what it holds (a storage read) and out again; the outcome check asks for one when the bot is offline. */
  verify?: (botGuid: string, why: string) => Promise<unknown>;
  /** Trades with players (node settings): whether this node takes them now, and how many at once. Absent: never. */
  players?: () => { enabled: boolean; maxMeetings: number };
}

/** A player meeting's progress is sent this long after the fleet's note (a trade window produces several at once). */
export const PROGRESS_DEBOUNCE_MS = Number(process.env.SWAP_PROGRESS_DEBOUNCE_MS ?? 400);

/**
 * How a communism meeting (design doc §6.3) maps onto this node. Giving: the
 * item behind a ref (a communism account's instance for a take, a pool
 * instance for a give to another node's communism). Taking: the bot this node
 * chose to receive with. Registered by communism coordinator.
 */
export interface CommunismResolver {
  /** Giver: the instance id behind a ref, if still held. */
  giveInstance(rv: RendezvousWire, ref: string): string | null;
  /** Taker: the bot this node picked to receive with, or communism account the hub named. */
  receivingBot(rv: RendezvousWire): string | null;
  /** The catalog id of an instance this node handed over in a communism meeting, as it recorded the meeting; null if unknown. */
  itemIdOf?(rendezvousId: number, instanceId: string): string | null;
}

/** What this node remembers about an offer it posted or accepted: which of its instances back the refs. */
interface LocalOffer {
  offerId: number;
  side: "poster" | "taker";
  botGuid: string;
  refs: Record<string, string>;
  status: string;
}

/** An item this node could put in an offer, with where it sits and the open offers of ours that already name it. */
export type HeldView = HeldItem & { botGuid: string; botIgn: string; seasonal: boolean; name: string; stored: boolean; where?: string; offers: number[] };

interface LocalRendezvous {
  rendezvous_id: number;
  offer_id: number | null;
  request_id: number | null;
  state: string;
  deadline_at: number | null;
  receipt_json: string | null;
  receipt_sent_at: number | null;
  verify_at: number | null;
  extended_at: number | null;
  /** swap, communism or player (null on rows from before kinds were kept). */
  kind: string | null;
  /** A player meeting whose bot has reached the nexus: from then on it only waits for the person, and no extension is asked. */
  ready_at: number | null;
  /** A player meeting's latest progress, and when the hub took it (null: still to send). */
  progress_json: string | null;
  progress_sent_at: number | null;
  /** When the hub made the meeting: its ids are its own, and a hub whose database started over (or another hub, after relinking) reuses them. */
  hub_created_at: number | null;
  updated_at: number;
}

/** Local meeting states that are over: the hub never takes a meeting from one of these back to `meet`. */
const CLOSED_LOCALLY = new Set(["done", "failed", "aborted", "disputed", "lost"]);

export class SwapCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offResult: (() => void) | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private lastOfferSyncAt = 0;
  /** The hub's limits for this node as of its last reply (browse or mine): whether the operator has frozen it. */
  private limits: NodeLimitsWire | null = null;
  private rendezvous: RendezvousWire[] = [];
  private readonly now: () => number;
  private communism: CommunismResolver | null = null;
  /** Meetings whose giving row names items the node no longer has anywhere: since when (ms). */
  private readonly missingSince = new Map<number, number>();
  /** Communism meetings first seen unplaceable, by rendezvous id (COMMUNISM_RESOLVE_GRACE_MS). */
  private readonly unresolvedSince = new Map<number, number>();
  private offNote: (() => void) | null = null;
  private progressTimers = new Map<number, ReturnType<typeof setTimeout>>();
  constructor(private readonly o: SwapsOptions) {
    this.now = o.now ?? Date.now;
    const db = o.db();
    db.exec(`
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
    // Communism meetings have no offer: an older table declared offer_id NOT NULL.
    const rvCols = db.prepare("PRAGMA table_info(swap_rendezvous)").all() as { name: string; notnull: number }[];
    if (rvCols.find((c) => c.name === "offer_id")?.notnull) {
      db.exec(`
        CREATE TABLE swap_rendezvous_new (rendezvous_id INTEGER PRIMARY KEY, offer_id INTEGER, request_id INTEGER, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO swap_rendezvous_new SELECT rendezvous_id, offer_id, request_id, state, created_at, updated_at FROM swap_rendezvous;
        DROP TABLE swap_rendezvous; ALTER TABLE swap_rendezvous_new RENAME TO swap_rendezvous;`);
    }
    // The receipt that closes a meeting is kept until the hub has it; the deadline and the two timers below drive the outcome check and extensions.
    const have = new Set((db.prepare("PRAGMA table_info(swap_rendezvous)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, type] of [["deadline_at", "INTEGER"], ["receipt_json", "TEXT"], ["receipt_sent_at", "INTEGER"], ["verify_at", "INTEGER"], ["extended_at", "INTEGER"], ["kind", "TEXT"], ["ready_at", "INTEGER"], ["progress_json", "TEXT"], ["progress_sent_at", "INTEGER"], ["hub_created_at", "INTEGER"]] as const) {
      if (!have.has(col)) db.exec(`ALTER TABLE swap_rendezvous ADD COLUMN ${col} ${type}`);
    }
  }

  // --- what this node holds ------------------------------------------------------

  /**
   * Everything this node could put in an offer or hand over for one: what its
   * pool accounts hold that no open request, meeting, accepted offer or
   * hand-over has spoken for. An item already in open offers of ours is here
   * too, with those offers (`offers`): one item may sit in several, and
   * whichever meeting takes it first, the hub holds the others meanwhile and
   * withdraws them once it is traded away. Items on a character trade at once;
   * items in the account's storage (a chest, another character) are listed
   * too, marked `stored`: the fleet fetches them onto the character before the
   * meeting, which costs a few minutes.
   */
  held(seasonal?: boolean): HeldView[] {
    const pool = this.o.pool();
    if (!pool) return [];
    const reserved = reservedInstanceIds(this.o.db(), { openOffers: false });
    const offered = this.offeredIn();
    const offers = (instanceId: string) => offered.get(instanceId) ?? [];
    const out: HeldView[] = [];
    const meta = pool.botMeta ?? {};
    for (const [botGuid, slots] of Object.entries(pool.instances ?? {})) {
      const m = meta[botGuid];
      // Communism is not the owner's to offer.
      if (!m || m.suspended || isCommunismBot(m)) continue;
      const s = m.seasonal !== false;
      if (seasonal !== undefined && s !== seasonal) continue;
      for (const info of Object.values(slots)) {
        if (reserved.has(info.instanceId)) continue;
        const item = ITEM_BY_ID.get(info.itemId);
        if (!item) continue;
        if (!tradeableEnchants((info.enchantments ?? []).length)) continue;
        out.push({ instanceId: info.instanceId, itemId: info.itemId, enchantIds: info.enchantments ?? [], createdAt: info.capturedAt, botGuid, botIgn: m.ign, seasonal: s, name: item.name, stored: false, offers: offers(info.instanceId) });
      }
    }
    for (const [botGuid, stored] of Object.entries(pool.stored ?? {})) {
      const m = meta[botGuid];
      if (!m || m.suspended || isCommunismBot(m)) continue;
      for (const st of stored) {
        if (reserved.has(st.instanceId)) continue;
        const item = ITEM_BY_ID.get(st.itemId);
        if (!item) continue;
        if (!tradeableEnchants((st.enchantments ?? []).length)) continue;
        // Storage serves whichever half a character of the account can carry it to.
        if (!st.pools.seasonal && !st.pools.nonseasonal) continue;
        const s = seasonal === undefined ? st.pools.seasonal || !st.pools.nonseasonal : seasonal;
        if (seasonal !== undefined && !st.pools[seasonal ? "seasonal" : "nonseasonal"]) continue;
        out.push({ instanceId: st.instanceId, itemId: st.itemId, enchantIds: st.enchantments ?? [], createdAt: st.capturedAt, botGuid, botIgn: m.ign, seasonal: s, name: item.name, stored: true, where: whereText(st.where), offers: offers(st.instanceId) });
      }
    }
    return out;
  }
  /**
   * Each pool account's trade slots (its played character's: 8, or 16 or 24
   * with a backpack and extender) and the biggest among them: one offer's
   * side holds no more than the giving account can put in a trade window, and
   * nothing on this node can trade more than the biggest.
   */
  tradeSlots(): { biggest: number; byBot: Record<string, number> } {
    const pool = this.o.pool();
    const byBot: Record<string, number> = {};
    for (const [botGuid, m] of Object.entries(pool?.botMeta ?? {})) {
      if (m.suspended || isCommunismBot(m)) continue;
      byBot[botGuid] = pool?.capacities?.[botGuid] ?? SLOTS_PER_BOT;
    }
    return { biggest: Math.max(SLOTS_PER_BOT, ...Object.values(byBot)), byBot };
  }
  /** Free trade slots on a bot's played character right now. */
  private freeSlots(botGuid: string): number {
    const pool = this.o.pool();
    if (!pool) return 0;
    const cap = pool.capacities?.[botGuid] ?? SLOTS_PER_BOT;
    const held = Object.keys(pool.instances?.[botGuid] ?? {}).length;
    return Math.max(0, cap - held);
  }
  /** Whether a bot (or its storage) still holds an instance. */
  private holds(pool: PyrelayPool, botGuid: string, instanceId: string): boolean {
    if (Object.values(pool.instances?.[botGuid] ?? {}).some((i) => i.instanceId === instanceId)) return true;
    return (pool.stored?.[botGuid] ?? []).some((s) => s.instanceId === instanceId);
  }
  /** Instance id -> the open offers of ours that name it. */
  private offeredIn(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const o of this.localOffers()) {
      if (o.side !== "poster" || o.status !== "open") continue;
      for (const id of Object.values(o.refs)) out.set(id, [...(out.get(id) ?? []), o.offerId]);
    }
    return out;
  }
  private localOffers(): LocalOffer[] {
    return (this.o.db().prepare("SELECT offer_id, side, bot_guid, refs_json, status FROM swap_offers").all() as { offer_id: number; side: string; bot_guid: string; refs_json: string; status: string }[])
      .map((r) => ({ offerId: r.offer_id, side: r.side as "poster" | "taker", botGuid: r.bot_guid, refs: JSON.parse(r.refs_json) as Record<string, string>, status: r.status }));
  }
  private localOffer(offerId: number): LocalOffer | undefined {
    return this.localOffers().find((o) => o.offerId === offerId);
  }
  private saveLocalOffer(o: LocalOffer): void {
    const now = this.now();
    this.o.db().prepare("INSERT INTO swap_offers (offer_id, side, bot_guid, refs_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(offer_id) DO UPDATE SET status = excluded.status, refs_json = excluded.refs_json, bot_guid = excluded.bot_guid, side = excluded.side, updated_at = excluded.updated_at")
      .run(o.offerId, o.side, o.botGuid, JSON.stringify(o.refs), o.status, now, now);
  }
  private setLocalStatus(offerId: number, status: string): void {
    this.o.db().prepare("UPDATE swap_offers SET status = ?, updated_at = ? WHERE offer_id = ?").run(status, this.now(), offerId);
  }
  private localRendezvous(id: number): LocalRendezvous | undefined {
    return this.o.db().prepare("SELECT * FROM swap_rendezvous WHERE rendezvous_id = ?").get(id) as LocalRendezvous | undefined;
  }

  // --- offers -------------------------------------------------------------------

  /** Items as the hub sees them: each named by its instance id, the same ref in every offer and accept (ITEM_REF_RE). */
  private toWire(items: (HeldItem & { botGuid: string })[]): { give: OfferItemWire[]; refs: Record<string, string> } {
    const refs: Record<string, string> = {};
    const give = items.map((it) => {
      refs[it.instanceId] = it.instanceId;
      return { ref: it.instanceId, itemId: it.itemId, enchants: it.enchantIds, count: it.enchantIds.length };
    });
    return { give, refs };
  }

  /** Why a meeting may not be on `server` right now, in the player's words; null when it may. */
  private serverProblem(server: string): string | null {
    if (!WITHDRAW_SERVERS.includes(server)) return "Pick a server this node trades on.";
    const block = withdrawBlock(this.o.db(), server);
    return block ? blockMessage(server, "withdraw", block) : null;
  }

  /** Post an offer: `instanceIds` for `want`, met on `server`. All items must sit on one account, which must have room for what comes back. */
  async createOffer(input: { instanceIds: string[]; want: WantLine[]; server: string }): Promise<SwapsResult<{ offer: OfferWire }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    const ids = [...new Set(input.instanceIds)];
    if (!ids.length) return { ok: false, status: 400, error: "Pick at least one item to give." };
    if (ids.length > MAX_GIVE_ITEMS) return { ok: false, status: 400, error: `At most ${MAX_GIVE_ITEMS} items in one offer.` };
    const problem = this.serverProblem(input.server);
    if (problem) return { ok: false, status: WITHDRAW_SERVERS.includes(input.server) ? 409 : 400, error: problem };
    const held = this.held();
    const items = ids.map((id) => held.find((h) => h.instanceId === id));
    if (items.some((h) => !h)) return { ok: false, status: 409, error: "One of those items is no longer free on this node (in a trade right now, reserved, or gone)." };
    const picked = items as HeldView[];
    const bots = new Set(picked.map((p) => p.botGuid));
    if (bots.size !== 1) return { ok: false, status: 400, error: "All items of one offer must sit on the same account (one bot trades at a time)." };
    if (picked.some((p) => p.enchantIds.length > MAX_ENCHANTS)) return { ok: false, status: 400, error: "An item has too many enchantments to trade in game." };
    const bot = picked[0];
    if (!bot.botIgn) return { ok: false, status: 409, error: "That account has never logged in on this node, so its name is unknown. Log it in once first." };
    // No more than the account can put in one trade window.
    const slots = this.tradeSlots().byBot[bot.botGuid] ?? SLOTS_PER_BOT;
    if (picked.length > slots) return { ok: false, status: 409, error: `${bot.botIgn} can trade at most ${slots} items at once (its character's trade slots); give fewer from it.` };
    // The trade window needs room on this character for what comes back, net of what leaves it.
    const wantTotal = input.want.reduce((n, w) => n + w.qty, 0);
    const onChar = picked.filter((p) => !p.stored).length;
    const free = this.freeSlots(bot.botGuid);
    if (free + onChar < wantTotal) return { ok: false, status: 409, error: `${bot.botIgn} would need ${wantTotal - onChar} free slot${wantTotal - onChar === 1 ? "" : "s"} for what comes back and has ${free}. Ask for less, give more from that account, or make room on it first.` };
    const { give, refs } = this.toWire(picked);
    // One key for this post: sent again after a lost reply, the hub answers with the offer the first one made (not a second).
    const req: CreateOfferRequest = { botIgn: bot.botIgn, seasonal: bot.seasonal, server: input.server, give, want: wantToWire(input.want), clientKey: randomUUID() };
    let r = await this.o.hub.signed<{ offer: OfferWire }>("POST", "/api/v1/offers", req);
    if (!r.ok && r.status === 0) r = await this.o.hub.signed<{ offer: OfferWire }>("POST", "/api/v1/offers", req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.saveLocalOffer({ offerId: r.data.offer.id, side: "poster", botGuid: bot.botGuid, refs, status: "open" });
    const stored = picked.filter((p) => p.stored).length;
    const also = [...new Set(picked.flatMap((p) => p.offers))];
    this.o.log(`swaps: posted offer #${r.data.offer.id}: ${give.length} item(s) from ${bot.botIgn} on ${input.server}${stored ? ` (${stored} in storage, fetched before the meeting)` : ""}${also.length ? `; also in offer${also.length === 1 ? "" : "s"} ${also.map((id) => `#${id}`).join(", ")}` : ""}`);
    return { ok: true, offer: r.data.offer };
  }

  /** Another fourteen days for an offer of ours. An expired one comes back only while all its items are still here and free. */
  async renewOffer(offerId: number): Promise<SwapsResult<{ offer: OfferWire }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    const local = this.localOffer(offerId);
    if (local?.side === "poster" && local.status !== "open") {
      const free = new Set(this.held().map((h) => h.instanceId));
      if (Object.values(local.refs).some((id) => !free.has(id))) return { ok: false, status: 409, error: "An item of this offer is no longer free on this node (in a trade right now, reserved, or gone)." };
    }
    const r = await this.o.hub.signed<{ offer: OfferWire }>("POST", `/api/v1/offers/${offerId}/renew`, {});
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    if (local && local.status !== "open") this.setLocalStatus(offerId, "open");
    this.o.log(`swaps: offer #${offerId} renewed until ${new Date(r.data.offer.expiresAt).toISOString().slice(0, 10)}`);
    return { ok: true, offer: r.data.offer };
  }

  /**
   * Withdraw this node's open offers that name any of `instanceIds`: a pool
   * withdraw took those items. An item may sit in open offers, and a withdraw
   * wins over them; the offer check (reconcileOffers) tries again for any the
   * hub did not take now. Resolves with the offers withdrawn.
   */
  async withdrawOffersNaming(instanceIds: string[], why: string): Promise<number[]> {
    const ids = new Set(instanceIds);
    const done: number[] = [];
    for (const o of this.localOffers()) {
      if (o.side !== "poster" || o.status !== "open" || !Object.values(o.refs).some((id) => ids.has(id))) continue;
      const r = await this.cancelOffer(o.offerId);
      if (r.ok) {
        done.push(o.offerId);
        this.o.log(`swaps: offer #${o.offerId} withdrawn: ${why}`);
      } else this.o.log(`swaps: offer #${o.offerId} could not be withdrawn yet (${r.error}); the offer check tries again`);
    }
    return done;
  }

  async cancelOffer(offerId: number): Promise<SwapsResult<{ cancelled: true }>> {
    const r = await this.o.hub.signed<{ ok: true }>("DELETE", `/api/v1/offers/${offerId}`, {});
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.setLocalStatus(offerId, "cancelled");
    return { ok: true, cancelled: true };
  }

  /**
   * What I would hand over for `offer`, or why I can't: the plainest copies
   * that fit its want lines, all on one account with the room to take what
   * the offer gives. Copies on a character come before copies in storage.
   */
  preview(offer: OfferWire): { ok: true; picks: HeldView[] } | { ok: false; error: string } {
    // What would come in has to be something this node takes.
    const refused = offer.give.find((g) => !nodeTakes(g.itemId));
    if (refused) return { ok: false, error: `${ITEM_BY_ID.get(refused.itemId)?.name ?? refused.itemId} is not taken on this node.` };
    const want = wantFromWire(offer.want);
    const mine = this.held(offer.seasonal);
    if (!pickForLines(want, mine)) return { ok: false, error: shortfall(want, mine) };
    const byBot = new Map<string, HeldView[]>();
    for (const h of mine) byBot.set(h.botGuid, [...(byBot.get(h.botGuid) ?? []), h]);
    let roomError: string | null = null;
    let nameError: string | null = null;
    const bots = [...byBot.keys()].sort((a, b) => this.freeSlots(b) - this.freeSlots(a) || a.localeCompare(b));
    for (const botGuid of bots) {
      const items = byBot.get(botGuid)!;
      const picks = pickForLines(want, items);
      if (!picks) continue;
      const full = picks.map((p) => items.find((m) => m.instanceId === p.instanceId)!);
      if (!full[0].botIgn) {
        nameError = "The account holding the fitting items has never logged in here, so its name is unknown.";
        continue;
      }
      const slots = this.tradeSlots().byBot[botGuid] ?? SLOTS_PER_BOT;
      if (full.length > slots) {
        roomError = `${full[0].botIgn} has the items, but can trade at most ${slots} at once and the offer asks for ${full.length}.`;
        continue;
      }
      const onChar = full.filter((p) => !p.stored).length;
      const free = this.freeSlots(botGuid);
      if (free + onChar < offer.give.length) {
        roomError = `${full[0].botIgn} has the items but not the room: it needs ${offer.give.length - onChar} free slot${offer.give.length - onChar === 1 ? "" : "s"} for what the offer gives and has ${free}.`;
        continue;
      }
      return { ok: true, picks: full };
    }
    return { ok: false, error: roomError ?? nameError ?? "The items that fit are spread over several of your accounts; one account has to hold them all for a single trade." };
  }

  /** Accept `offer` with exactly the previewed picks, on the offer's server unless this node cannot trade there right now. */
  async acceptOffer(offer: OfferWire): Promise<SwapsResult<{ rendezvous: RendezvousWire }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    const pv = this.preview(offer);
    if (!pv.ok) return { ok: false, status: 409, error: pv.error };
    const { give, refs } = this.toWire(pv.picks);
    const req: AcceptOfferRequest = { botIgn: pv.picks[0].botIgn, items: give };
    const problem = this.serverProblem(offer.server);
    if (problem) {
      const open = WITHDRAW_SERVERS.filter((s) => !withdrawBlock(this.o.db(), s));
      const u = serverUsage.status();
      const q = pickQuietServer(open, u.fresh ? Object.entries(u.servers).map(([name, usage]) => ({ name, usage })) : null);
      req.server = q.server;
      this.o.log(`swaps: offer #${offer.id} meets on ${offer.server}, which this node cannot trade on now (${problem}); proposing ${q.server} (${q.why})`);
    }
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire }>("POST", `/api/v1/offers/${offer.id}/accept`, req);
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.saveLocalOffer({ offerId: offer.id, side: "taker", botGuid: pv.picks[0].botGuid, refs, status: "accepted" });
    this.o.log(`swaps: accepted offer #${offer.id}; rendezvous #${r.data.rendezvous.id} on ${r.data.rendezvous.server}`);
    await this.adopt(r.data.rendezvous);
    return { ok: true, rendezvous: r.data.rendezvous };
  }

  async browse(): Promise<SwapsResult<{ offers: OfferWire[]; limits: NodeLimitsWire | null }>> {
    const r = await this.o.hub.signed<{ offers: OfferWire[]; limits?: NodeLimitsWire }>("GET", "/api/v1/offers?open=1");
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.limits = r.data.limits ?? this.limits;
    return { ok: true, offers: r.data.offers, limits: r.data.limits ?? null };
  }
  async mine(): Promise<SwapsResult<{ offers: OfferWire[]; limits: NodeLimitsWire | null }>> {
    const r = await this.o.hub.signed<{ offers: OfferWire[]; limits?: NodeLimitsWire }>("GET", "/api/v1/offers/mine");
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.syncLocalStatuses(r.data.offers);
    this.limits = r.data.limits ?? this.limits;
    return { ok: true, offers: r.data.offers, limits: r.data.limits ?? null };
  }
  /** The hub's word on our posted offers: a cancel from the website, an expiry, a void, an item traded away in another meeting. */
  private syncLocalStatuses(offers: OfferWire[]): void {
    for (const o of offers) {
      const local = this.localOffer(o.id);
      if (local && local.side === "poster" && o.status !== "open" && o.status !== "accepted" && local.status !== o.status) {
        this.setLocalStatus(o.id, o.status);
        this.o.log(`swaps: offer #${o.id} is ${o.status} on the hub${o.closedReason ? ` (${o.closedReason})` : "; its items are free again"}`);
      }
    }
  }

  /**
   * Posted offers whose items are no longer on the node (a suspended account,
   * an item that left some other way) are withdrawn from the hub now, with a
   * reason in the log, rather than left to fail at somebody's meeting.
   */
  private async reconcileOffers(): Promise<void> {
    const r = await this.mine();
    if (!r.ok) return;
    const pool = this.o.pool();
    if (!pool) return;
    const picked = pickedByWithdraws(this.o.db());
    for (const o of r.offers) {
      if (o.status !== "open") continue;
      const local = this.localOffer(o.id);
      if (!local) {
        // An offer the hub has from us that this node keeps no record of (the reply to its post never came back): nobody
        // could ever meet it, since its refs mean nothing here. Withdrawn rather than taken and failed again and again.
        this.o.log(`swaps: offer #${o.id} is on the hub but this node has no record of it; withdrawing it`);
        await this.cancelOffer(o.id);
        continue;
      }
      if (local.side !== "poster") continue;
      // A pool withdraw took one of its items (withdrawOffersNaming did not get through): the withdraw wins.
      const taken = Object.values(local.refs).filter((id) => picked.has(id));
      if (taken.length) {
        this.o.log(`swaps: offer #${o.id}: ${taken.length} of its item(s) are in an open withdraw; withdrawing the offer`);
        await this.cancelOffer(o.id);
        continue;
      }
      const gone = Object.entries(local.refs).filter(([, id]) => !this.holds(pool, local.botGuid, id));
      if (!gone.length) continue;
      this.o.log(`swaps: offer #${o.id}: ${gone.length} of its ${Object.keys(local.refs).length} item(s) are no longer on ${pool.botMeta?.[local.botGuid]?.ign || "the account"} (${gone.map(([ref]) => ref).join(", ")}); withdrawing the offer`);
      await this.cancelOffer(o.id);
    }
  }

  // --- rendezvous ------------------------------------------------------------------

  setCommunismResolver(r: CommunismResolver | null): void {
    this.communism = r;
  }

  /** A rendezvous the hub scheduled: queue my side as a swap row once. */
  async adopt(rv: RendezvousWire): Promise<void> {
    const db = this.o.db();
    let known = this.localRendezvous(rv.id);
    // The same number for another meeting: the hub's database started over, or this node was relinked to another hub. The
    // local row is an older meeting's (made at another time, or closed while the hub says this one is on); it is not this one.
    if (known && rv.state === "meet" && (known.hub_created_at !== null ? known.hub_created_at !== rv.createdAt : CLOSED_LOCALLY.has(known.state))) {
      this.o.log(`swaps: rendezvous #${rv.id} is a new meeting; the local row by that number belonged to an older one (${known.state}); replacing it`);
      db.prepare("DELETE FROM swap_rendezvous WHERE rendezvous_id = ?").run(rv.id);
      known = undefined;
    }
    if (rv.state !== "meet") {
      if (known && known.state !== rv.state) {
        db.prepare("UPDATE swap_rendezvous SET state = ?, updated_at = ? WHERE rendezvous_id = ?").run(rv.state, this.now(), rv.id);
        if (known.request_id !== null && (rv.state === "aborted" || rv.state === "failed" || rv.state === "disputed")) queue.cancelSwapJob(db, known.request_id, `hub says ${rv.state}`);
      }
      // The offer behind it follows this side's own word, never the partner's
      // (the hub settles each side on its own node's word): a poster's offer is
      // done only when its own bot traded and open again otherwise; a taker's
      // row closes with the meeting, so the items it had promised are free again.
      const local = rv.offerId === null ? undefined : this.localOffer(rv.offerId);
      if (local && rv.offerId !== null && (local.status === "open" || local.status === "accepted")) {
        const mineTraded = !!known?.receipt_json && (JSON.parse(known.receipt_json) as ReceiptWire).ok;
        const next = local.side === "poster" ? (mineTraded ? "done" : "open") : rv.state;
        if (local.status !== next) this.setLocalStatus(rv.offerId, next);
      }
      return;
    }
    if (known) {
      db.prepare("UPDATE swap_rendezvous SET deadline_at = ? WHERE rendezvous_id = ?").run(rv.deadlineAt, rv.id);
      if (known.request_id === null) return;
      const row = queue.swapJobsFor(db, rv.id).find((j) => j.id === known.request_id);
      const open = !!row && (row.status === "pending" || row.status === "claimed");
      const now = this.now();
      if (now > rv.deadlineAt) {
        // Past the deadline with nobody on the row: give it back and tell the
        // hub, so the offer reopens instead of hanging. A claimed row is the
        // fleet's to finish or fail (a window may be open this very second).
        if (row && row.status === "pending") {
          queue.cancelSwapJob(db, known.request_id, "deadline passed");
          db.prepare("UPDATE swap_rendezvous SET state = 'aborted', updated_at = ? WHERE rendezvous_id = ?").run(now, rv.id);
          this.o.log(`swaps: rendezvous #${rv.id} passed its deadline without a trade; aborting`);
          await this.o.hub.signed("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason: "deadline passed, no trade" });
        }
        return;
      }
      // A giving row no bot ever claimed whose items are nowhere on the node any more cannot happen: give the meeting
      // up rather than stretch its deadline (a fetch moving an item out of storage is given a couple of minutes).
      if (open && row!.status === "pending" && row!.instanceIds.length && row!.targetBotGuid && !queue.wasClaimed(db, row!.id)) {
        const pool = this.o.pool();
        const missing = pool ? row!.instanceIds.filter((id) => !this.holds(pool, row!.targetBotGuid!, id)) : [];
        if (missing.length) {
          const since = this.missingSince.get(rv.id) ?? now;
          this.missingSince.set(rv.id, since);
          if (now - since >= MISSING_ITEMS_GRACE_MS) {
            this.missingSince.delete(rv.id);
            const reason = `${missing.length} of the ${row!.instanceIds.length} item(s) to give are no longer on the node`;
            queue.cancelSwapJob(db, known.request_id, reason);
            db.prepare("UPDATE swap_rendezvous SET state = 'aborted', updated_at = ? WHERE rendezvous_id = ?").run(now, rv.id);
            this.o.log(`swaps: rendezvous #${rv.id}: ${reason}; aborting`);
            await this.o.hub.signed("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason });
          }
          return;
        }
        this.missingSince.delete(rv.id);
      }
      // Still trying with the window closing: ask the hub for more time. A player meeting whose bot already
      // stands in the nexus is waiting for the person, and that is what the deadline is for.
      const waitingOnPlayer = rv.kind === "player" && known.ready_at !== null;
      if (open && !waitingOnPlayer && rv.deadlineAt - now <= EXTEND_WINDOW_MS && now - (known.extended_at ?? 0) >= EXTEND_EVERY_MS) {
        db.prepare("UPDATE swap_rendezvous SET extended_at = ? WHERE rendezvous_id = ?").run(now, rv.id);
        const r = await this.o.hub.signed<{ ok: true; deadlineAt: number }>("POST", `/api/v1/rendezvous/${rv.id}/extend`, { reason: row!.status === "claimed" ? "a bot is on it and waiting for the partner" : "waiting for a bot to reach the server" });
        if (r.ok) {
          this.o.log(`swaps: rendezvous #${rv.id} extended by the hub to ${new Date(r.data.deadlineAt).toISOString()}`);
          db.prepare("UPDATE swap_rendezvous SET deadline_at = ? WHERE rendezvous_id = ?").run(r.data.deadlineAt, rv.id);
          const spec = { ...row!.spec, deadlineAt: r.data.deadlineAt };
          db.prepare("UPDATE withdraw_requests SET swap_json = ? WHERE id = ? AND status IN ('pending','claimed')").run(JSON.stringify(spec), row!.id);
        } else this.o.log(`swaps: rendezvous #${rv.id} not extended: ${r.error}`);
      }
      return;
    }
    const abort = async (reason: string) => {
      this.unresolvedSince.delete(rv.id);
      this.o.log(`swaps: rendezvous #${rv.id}: ${reason}; aborting`);
      await this.o.hub.signed("POST", `/api/v1/rendezvous/${rv.id}/abort`, { reason });
    };
    // A communism meeting we cannot place may be one we asked for whose reply is still on its way: wait a little first.
    const notYet = async (reason: string) => {
      const now = this.now();
      const since = this.unresolvedSince.get(rv.id);
      if (since === undefined) this.unresolvedSince.set(rv.id, now);
      if (since === undefined || now - since < COMMUNISM_RESOLVE_GRACE_MS) return;
      await abort(reason);
    };
    // What this side hands over and from which bot, by kind.
    let giveIds: string[];
    let fallbackBot: string | null;
    if (rv.kind === "communism") {
      if (!this.communism) return abort("communism not running on this node");
      if (rv.me.role === "give") {
        giveIds = rv.me.gives.map((g) => this.communism!.giveInstance(rv, g.ref)).filter((id): id is string => !!id);
        if (giveIds.length !== rv.me.gives.length) return notYet("the item is no longer here");
        fallbackBot = null;
      } else {
        giveIds = [];
        fallbackBot = this.communism.receivingBot(rv);
        if (!fallbackBot) return notYet("no receiving bot recorded for this hand-over");
      }
      this.unresolvedSince.delete(rv.id);
    } else if (rv.kind === "player") {
      // A person with their own character: somebody is waiting on the hub, so a meeting this node will not run is called off now.
      const refusal = this.playerRefusal(rv);
      if (refusal) return abort(refusal);
      const local = this.localOffer(rv.offerId!)!;
      giveIds = rv.me.gives.map((g) => local.refs[g.ref]).filter((id): id is string => !!id);
      if (giveIds.length !== rv.me.gives.length) return abort("items no longer known to the node");
      fallbackBot = local.botGuid;
    } else {
      const local = rv.offerId === null ? undefined : this.localOffer(rv.offerId);
      if (!local) {
        this.o.log(`swaps: rendezvous #${rv.id} refers to offer #${rv.offerId} this node has no record of; ignoring`);
        return;
      }
      giveIds = rv.me.gives.map((g) => local.refs[g.ref]).filter((id): id is string => !!id);
      if (giveIds.length !== rv.me.gives.length) return abort("items no longer known to the node");
      fallbackBot = local.botGuid;
    }
    // An item already promised elsewhere (an owner withdraw, another meeting) cannot be handed over twice.
    if (giveIds.length) {
      const reserved = reservedByRequests(db);
      if (giveIds.some((id) => reserved.has(id))) return abort("an item is already reserved by another request");
    }
    // The holder now: an item may have moved bots since it was offered. Storage counts as the account's.
    const pool = this.o.pool();
    const holders = new Set<string>();
    if (pool && giveIds.length) {
      for (const [g, slots] of Object.entries(pool.instances ?? {})) for (const info of Object.values(slots)) if (giveIds.includes(info.instanceId)) holders.add(g);
      for (const [g, stored] of Object.entries(pool.stored ?? {})) for (const st of stored) if (giveIds.includes(st.instanceId)) holders.add(g);
      if (holders.size === 0) return abort("the items are no longer on this node");
    }
    const botGuid = holders.size === 1 ? [...holders][0] : fallbackBot;
    if (!botGuid) return abort("the items are not on one bot");
    if (giveIds.length && holders.size !== 1) this.o.log(`swaps: rendezvous #${rv.id}: items on ${holders.size} bots; using the offer's account`);
    const give = collapse(rv.me.gives.map((g) => g.itemId));
    const player = rv.kind === "player" ? { player: { lines: rv.me.getsLines ?? [] } } : {};
    const requestId = queue.createSwapJob(db, {
      server: rv.server, botGuid, partnerIgn: rv.partner.botIgn, seasonal: rv.seasonal, give, giveInstanceIds: giveIds,
      swap: { rendezvousId: rv.id, role: rv.me.role, gets: rv.me.gets, ...(rv.me.getsItems ? { getsItems: rv.me.getsItems } : {}), deadlineAt: rv.deadlineAt, ...player },
    });
    db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, deadline_at, kind, hub_created_at, created_at, updated_at) VALUES (?, ?, ?, 'meet', ?, ?, ?, ?, ?)").run(rv.id, rv.offerId, requestId, rv.deadlineAt, rv.kind, rv.createdAt, this.now(), this.now());
    this.o.log(`swaps: ${rv.kind === "communism" ? "hand-over" : rv.kind === "player" ? "player meeting" : "rendezvous"} #${rv.id} queued as swap #${requestId}: ${rv.me.role} with ${rv.partner.botIgn} on ${rv.server}`);
    if (rv.kind === "player") {
      const pool = this.o.pool();
      const ign = this.botIgnOf(botGuid) || rv.me.botIgn;
      const stored = (pool?.stored?.[botGuid] ?? []).some((st) => giveIds.includes(st.instanceId));
      const online = !!pool?.botMeta?.[botGuid]?.online;
      this.queueProgress(rv.id, {
        stage: "queued", botIgn: ign, server: rv.server,
        detail: stored ? `${ign} is taking the items out of storage first (a few minutes), then comes to the ${rv.server} nexus` : online ? `${ign} is on its way to the ${rv.server} nexus` : `${ign} is logging in to ${rv.server}`,
      });
    }
  }

  // --- player meetings: telling the person on the hub how it goes ------------------------

  /** Why this node will not run a player meeting the hub scheduled, or null. */
  private playerRefusal(rv: RendezvousWire): string | null {
    const players = this.o.players?.();
    if (!players?.enabled) return "this node no longer takes trades with players";
    const local = rv.offerId === null ? undefined : this.localOffer(rv.offerId);
    if (!local || local.side !== "poster") return "this node has no record of that offer";
    if (!rv.me.getsLines?.length) return "the meeting came without the offer's want lines";
    const problem = this.serverProblem(rv.server);
    if (problem) return problem;
    const running = (this.o.db().prepare("SELECT COUNT(*) AS n FROM swap_rendezvous WHERE kind = 'player' AND state = 'meet'").get() as { n: number }).n;
    if (running >= players.maxMeetings) return `this node already runs ${running} player meeting${running === 1 ? "" : "s"}, its limit`;
    return null;
  }
  private botIgnOf(botGuid: string): string {
    return this.o.pool()?.botMeta?.[botGuid]?.ign || "";
  }

  /** The fleet's note on a swap row: for a player meeting, what the person should know now. */
  private onSwapNote(requestId: number, event: string, botGuid: string | null, detail: unknown): void {
    const row = this.o.db().prepare("SELECT * FROM swap_rendezvous WHERE request_id = ?").get(requestId) as LocalRendezvous | undefined;
    if (!row || row.kind !== "player" || row.state !== "meet") return;
    const rv = this.rendezvous.find((r) => r.id === row.rendezvous_id);
    const d = (detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>;
    // The bot's name from the pool, never from the note (the fleet's own notes carry the account alias).
    const ign = (botGuid ? this.botIgnOf(botGuid) : "") || (event.startsWith("player-") && typeof d.bot === "string" ? d.bot : "") || rv?.me.botIgn || "";
    const server = rv?.server ?? (typeof d.server === "string" ? d.server : "");
    const wants = rv?.me.getsLines?.map((l) => wantLineWords(l, (id) => ITEM_BY_ID.get(id)?.name ?? id)).join(", ") ?? "";
    const p = playerProgress(event, d, ign, server, wants);
    if (!p) return;
    if (p.stage === "ready" && row.ready_at === null) this.o.db().prepare("UPDATE swap_rendezvous SET ready_at = ? WHERE rendezvous_id = ?").run(this.now(), row.rendezvous_id);
    this.queueProgress(row.rendezvous_id, { ...p, ...(ign ? { botIgn: ign } : {}), ...(server ? { server } : {}) });
  }

  /** Keep a player meeting's latest progress and send it shortly (a window's notes come in bursts); an unchanged one is not sent again. */
  private queueProgress(rendezvousId: number, p: Omit<MeetingProgressWire, "at">): void {
    const row = this.localRendezvous(rendezvousId);
    if (!row) return;
    const last = row.progress_json ? (JSON.parse(row.progress_json) as MeetingProgressWire) : null;
    if (last && last.stage === p.stage && last.detail === p.detail && last.botIgn === p.botIgn) return;
    this.o.db().prepare("UPDATE swap_rendezvous SET progress_json = ?, progress_sent_at = NULL WHERE rendezvous_id = ?").run(JSON.stringify({ ...p, at: this.now() }), rendezvousId);
    if (this.progressTimers.has(rendezvousId)) return;
    const t = setTimeout(() => {
      this.progressTimers.delete(rendezvousId);
      void this.sendProgress(rendezvousId);
    }, PROGRESS_DEBOUNCE_MS);
    t.unref?.();
    this.progressTimers.set(rendezvousId, t);
  }
  private async sendProgress(rendezvousId: number): Promise<void> {
    const row = this.localRendezvous(rendezvousId);
    if (!row?.progress_json || row.progress_sent_at !== null) return;
    const r = await this.o.hub.signed<{ ok: true }>("POST", `/api/v1/rendezvous/${rendezvousId}/progress`, JSON.parse(row.progress_json) as MeetingProgressWire);
    // A meeting the hub already closed wants no more news: stop sending either way.
    if (r.ok || r.status === 409 || r.status === 404) this.o.db().prepare("UPDATE swap_rendezvous SET progress_sent_at = ? WHERE rendezvous_id = ? AND progress_json = ?").run(this.now(), rendezvousId, row.progress_json);
    else this.o.log(`swaps: progress for player meeting #${rendezvousId} not delivered: ${r.error} (sent again on the next poll)`);
  }
  /** Send every kept progress note now (tests; shutdown). */
  async flushProgress(): Promise<void> {
    for (const [id, t] of this.progressTimers) {
      clearTimeout(t);
      this.progressTimers.delete(id);
    }
    const rows = this.o.db().prepare("SELECT rendezvous_id FROM swap_rendezvous WHERE kind = 'player' AND state = 'meet' AND progress_json IS NOT NULL AND progress_sent_at IS NULL").all() as { rendezvous_id: number }[];
    for (const r of rows) await this.sendProgress(r.rendezvous_id);
  }

  /**
   * Give a meeting up from this side, before the deadline: a full server,
   * a bot that will not log in. The hub marks it aborted (an offer reopens,
   * a communism item is listed again) and the poll that follows cancels the
   * local row and puts the offer back the way the hub says.
   */
  async abortRendezvous(rendezvousId: number, reason = "aborted by the operator"): Promise<SwapsResult<{ aborted: true; state: string }>> {
    if (!this.o.hub.linked) return { ok: false, status: 503, error: "Link this node to the hub first (Overview)." };
    const r = await this.o.hub.signed<{ ok: true; state: string }>("POST", `/api/v1/rendezvous/${rendezvousId}/abort`, { reason });
    if (!r.ok) return { ok: false, status: r.status || 502, error: r.error };
    this.o.log(`swaps: rendezvous #${rendezvousId} aborted from this node: ${reason}`);
    await this.poll();
    return { ok: true, aborted: true, state: r.data.state };
  }

  // --- receipts ------------------------------------------------------------------

  /** The fleet finished (or failed) a swap row: keep the receipt, then send it. */
  private async onResult(requestId: number, swap: queue.SwapSpec, result: queue.SwapResult): Promise<void> {
    const db = this.o.db();
    const receipt: ReceiptWire = {
      window: 0, ok: result.ok, gave: result.gave, gaveRefs: this.refsFor(swap.rendezvousId, result.gaveInstanceIds), got: result.got,
      ...(result.gaveItems ? { gaveItems: result.gaveItems } : {}), ...(result.gotItems ? { gotItems: result.gotItems } : {}),
      partnerIgn: result.partnerIgn, ...(result.error ? { error: result.error } : {}), ...(result.partnerAbsent ? { partnerAbsent: true } : {}), at: this.now(),
    };
    // Kept until the hub has it: a hub that is down at this moment does not lose the trade.
    const changed = db.prepare("UPDATE swap_rendezvous SET receipt_json = ?, receipt_sent_at = NULL, state = 'receipt-pending', updated_at = ? WHERE rendezvous_id = ?").run(JSON.stringify(receipt), this.now(), swap.rendezvousId).changes;
    if (!changed) db.prepare("INSERT INTO swap_rendezvous (rendezvous_id, offer_id, request_id, state, receipt_json, created_at, updated_at) VALUES (?, NULL, ?, 'receipt-pending', ?, ?, ?)").run(swap.rendezvousId, requestId, JSON.stringify(receipt), this.now(), this.now());
    await this.sendReceipt(swap.rendezvousId);
  }
  private async sendReceipt(rendezvousId: number): Promise<boolean> {
    const db = this.o.db();
    const row = this.localRendezvous(rendezvousId);
    if (!row?.receipt_json) return false;
    const receipt = JSON.parse(row.receipt_json) as ReceiptWire;
    const r = await this.o.hub.signed<{ ok: true; state: string }>("POST", `/api/v1/rendezvous/${rendezvousId}/receipt`, receipt);
    if (!r.ok) {
      this.lastError = `receipt for #${rendezvousId}: ${r.error}`;
      if (r.status >= 400 && r.status < 500) {
        // Refused for good (no such meeting there, a shape it will never take): kept for the record, not sent again.
        db.prepare("UPDATE swap_rendezvous SET receipt_sent_at = ?, updated_at = ? WHERE rendezvous_id = ?").run(this.now(), this.now(), rendezvousId);
        this.o.log(`swaps: ${this.lastError} (the hub refused it; kept here, not sent again)`);
        return false;
      }
      this.o.log(`swaps: ${this.lastError} (kept; sent again on the next poll)`);
      return false;
    }
    db.prepare("UPDATE swap_rendezvous SET state = ?, receipt_sent_at = ?, updated_at = ? WHERE rendezvous_id = ?").run(r.data.state, this.now(), this.now(), rendezvousId);
    this.o.log(`swaps: receipt for rendezvous #${rendezvousId} sent (${receipt.ok ? "ok" : receipt.error}); hub says ${r.data.state}`);
    return true;
  }
  private async resendPendingReceipts(): Promise<void> {
    const rows = this.o.db().prepare("SELECT rendezvous_id FROM swap_rendezvous WHERE receipt_json IS NOT NULL AND receipt_sent_at IS NULL").all() as { rendezvous_id: number }[];
    for (const r of rows) await this.sendReceipt(r.rendezvous_id);
  }
  private refsFor(rendezvousId: number, instanceIds: string[]): string[] {
    const row = this.localRendezvous(rendezvousId);
    // Communism hand-overs use the instance id as the ref.
    if (row && row.offer_id === null) return instanceIds;
    const local = row?.offer_id != null ? this.localOffer(row.offer_id) : undefined;
    if (!local) return [];
    const byId = new Map(Object.entries(local.refs).map(([ref, id]) => [id, ref]));
    return instanceIds.map((id) => byId.get(id)).filter((r): r is string => !!r);
  }

  /**
   * A swap row back on pending with nobody on it: did the trade already
   * happen? A bot that dropped right after TRADEDONE, or a process restart,
   * loses the trade machine's outcome; the row comes back to pending but
   * cannot be claimed again, because its items are gone. A fresh look at
   * the bot decides: the items gone means the trade happened and an ok
   * receipt goes out (the hub matches it against the partner's); the items
   * still there means the fleet simply retries. An offline bot is logged in
   * for that look once. Only a row some bot claimed is looked at: a row still
   * waiting on a storage fetch never reached a trade window, and items
   * missing from a stale or partial storage read say nothing about a trade.
   */
  private async checkLostOutcomes(): Promise<void> {
    const db = this.o.db();
    const pool = this.o.pool();
    if (!pool) return;
    const now = this.now();
    for (const row of queue.openSwapJobs(db)) {
      if (row.status !== "pending" || !row.targetBotGuid || !row.instanceIds.length) continue;
      if (now - row.updatedAt < OUTCOME_CHECK_AFTER_MS) continue;
      const local = this.localRendezvous(row.spec.rendezvousId);
      if (!local || (local.state !== "meet" && local.state !== "receipt-pending")) continue;
      if (!queue.wasClaimed(db, row.id)) continue;
      const bot = row.targetBotGuid;
      const seenAt = this.o.verifiedAt?.(bot) ?? null;
      if (seenAt === null || seenAt <= row.updatedAt) {
        const online = !!pool.botMeta?.[bot]?.online;
        if (!online && this.o.verify && (local.verify_at ?? 0) < row.updatedAt) {
          db.prepare("UPDATE swap_rendezvous SET verify_at = ? WHERE rendezvous_id = ?").run(now, local.rendezvous_id);
          this.o.log(`swaps: swap #${row.id} (rendezvous #${local.rendezvous_id}) is back on pending with its bot offline; logging ${pool.botMeta?.[bot]?.ign || bot.slice(0, 8)} in for a look at whether the trade happened`);
          void this.o.verify(bot, `swap #${row.id} outcome check`).catch((e) => this.o.log(`swaps: look at ${bot.slice(0, 8)} failed: ${String(e)}`));
        }
        continue;
      }
      if (row.instanceIds.some((id) => this.holds(pool, bot, id))) continue;
      const rv = this.rendezvous.find((r) => r.id === row.spec.rendezvousId);
      const partnerIgn = rv?.partner.botIgn ?? "";
      const gave = collapse(row.instanceIds.map((id) => this.instanceItemId(id, local) ?? "").filter(Boolean));
      this.o.log(`swaps: swap #${row.id} (rendezvous #${local.rendezvous_id}): a look at ${pool.botMeta?.[bot]?.ign || bot.slice(0, 8)} taken after the row went back to pending shows its ${row.instanceIds.length} item(s) gone — the trade happened; reporting it`);
      try {
        queue.reportSwap(db, bot, row.id, { ok: true, gave, gaveInstanceIds: row.instanceIds, got: row.spec.gets, partnerIgn }, now);
      } catch (e) {
        this.o.log(`swaps: swap #${row.id} could not be reported: ${String((e as Error).message ?? e)}`);
      }
    }
  }
  /**
   * The catalog id a handed-over instance had (the pool no longer has it): from the hub's gives of the meeting, by the
   * ref it went under — a communism hand-over names the instance itself, an offer's item the ref in the local offer.
   * Then from what the local communism meeting recorded.
   */
  private instanceItemId(instanceId: string, local: LocalRendezvous): string | null {
    const offer = local.offer_id === null ? undefined : this.localOffer(local.offer_id);
    const ref = local.offer_id === null ? instanceId : Object.entries(offer?.refs ?? {}).find(([, id]) => id === instanceId)?.[0];
    if (ref) {
      for (const rv of this.rendezvous) if (rv.id === local.rendezvous_id || (local.offer_id !== null && rv.offerId === local.offer_id)) {
        const g = rv.me.gives.find((x) => x.ref === ref);
        if (g) return g.itemId;
      }
    }
    return this.communism?.itemIdOf?.(local.rendezvous_id, instanceId) ?? null;
  }

  /** Local meetings the hub no longer lists (it keeps the last twenty finished): a still-open one past its deadline is over. */
  private reconcileLocalRows(listed: Set<number>): void {
    const db = this.o.db();
    const now = this.now();
    const rows = db.prepare("SELECT * FROM swap_rendezvous WHERE state = 'meet' AND request_id IS NOT NULL").all() as LocalRendezvous[];
    for (const r of rows) {
      if (listed.has(r.rendezvous_id) || r.deadline_at === null || now <= r.deadline_at) continue;
      const cancelled = queue.cancelSwapJob(db, r.request_id!, "the hub no longer lists the meeting and its deadline has passed");
      db.prepare("UPDATE swap_rendezvous SET state = 'lost', updated_at = ? WHERE rendezvous_id = ?").run(now, r.rendezvous_id);
      if (cancelled) this.o.log(`swaps: rendezvous #${r.rendezvous_id} is gone from the hub and past its deadline; the local row is cancelled`);
    }
    // An offer we took whose meeting the hub no longer lists, with nothing of it still running here: the items it spoke for are free again.
    const listedOffers = new Set(this.rendezvous.map((rv) => rv.offerId).filter((id): id is number => id !== null));
    for (const o of this.localOffers()) {
      if (o.side !== "taker" || o.status !== "accepted" || listedOffers.has(o.offerId)) continue;
      const running = db.prepare("SELECT 1 FROM swap_rendezvous WHERE offer_id = ? AND state IN ('meet', 'receipt-pending')").get(o.offerId);
      if (running) continue;
      this.setLocalStatus(o.offerId, "lost");
      this.o.log(`swaps: offer #${o.offerId} we took is no longer on the hub's list and nothing of it runs here; its items are free again`);
    }
  }

  async poll(): Promise<void> {
    if (!this.o.hub.linked) return;
    await this.resendPendingReceipts();
    const r = await this.o.hub.signed<{ rendezvous: RendezvousWire[] }>("GET", "/api/v1/rendezvous/mine");
    this.lastPollAt = this.now();
    if (!r.ok) {
      this.lastError = r.error;
      return;
    }
    this.lastError = null;
    this.rendezvous = r.data.rendezvous;
    for (const rv of r.data.rendezvous) await this.adopt(rv);
    this.reconcileLocalRows(new Set(r.data.rendezvous.map((rv) => rv.id)));
    await this.flushProgress();
    await this.checkLostOutcomes();
    if (this.now() - this.lastOfferSyncAt >= OFFER_SYNC_MS) {
      this.lastOfferSyncAt = this.now();
      await this.reconcileOffers();
    }
  }

  start(): void {
    if (this.timer) return;
    const orphaned = queue.orphanClaimedSwapJobs(this.o.db(), this.now());
    if (orphaned) this.o.log(`swaps: ${orphaned} swap row(s) were claimed by a bot of the previous run; back on pending, to be claimed again or settled from a fresh look`);
    this.offResult = queue.onSwapResult((id, swap, result) => void this.onResult(id, swap, result));
    this.offNote = queue.onSwapNote((id, event, botGuid, detail) => this.onSwapNote(id, event, botGuid, detail));
    void this.poll();
    this.timer = setInterval(() => void this.poll(), RENDEZVOUS_POLL_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offResult?.();
    this.offResult = null;
    this.offNote?.();
    this.offNote = null;
    for (const t of this.progressTimers.values()) clearTimeout(t);
    this.progressTimers.clear();
  }

  status(): { linked: boolean; lastPollAt: number | null; lastError: string | null; limits: NodeLimitsWire | null; tradeSlots: { biggest: number; byBot: Record<string, number> }; rendezvous: (RendezvousWire & { requestId: number | null; localState: string | null; receiptPending: boolean; events: { event: string; detail: unknown; at: number }[] })[]; localOffers: LocalOffer[] } {
    const db = this.o.db();
    const rows = new Map((db.prepare("SELECT rendezvous_id, request_id, state, receipt_json, receipt_sent_at FROM swap_rendezvous").all() as LocalRendezvous[]).map((r) => [r.rendezvous_id, r]));
    return {
      linked: this.o.hub.linked, lastPollAt: this.lastPollAt, lastError: this.lastError, limits: this.limits, tradeSlots: this.tradeSlots(),
      rendezvous: this.rendezvous.map((rv) => {
        const row = rows.get(rv.id);
        const events = row?.request_id != null ? queue.eventsFor(db, "withdraw", row.request_id).map((e) => ({ event: e.event, detail: e.detail, at: e.at })) : [];
        return { ...rv, requestId: row?.request_id ?? null, localState: row?.state ?? null, receiptPending: !!row?.receipt_json && row.receipt_sent_at === null, events };
      }),
      localOffers: this.localOffers(),
    };
  }
}

function collapse(itemIds: string[]): { itemId: string; qty: number }[] {
  const m = new Map<string, number>();
  for (const id of itemIds) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m].map(([itemId, qty]) => ({ itemId, qty }));
}

/** Where a stored item sits, in words. */
function whereText(w: { kind: string; charId?: number; className?: string }): string {
  switch (w.kind) {
    case "char": return `on character ${w.className ?? w.charId ?? "?"}`;
    case "worn": return `worn by ${w.className ?? "a character"}`;
    case "quickslot": return `in a quickslot of ${w.className ?? "a character"}`;
    case "vault": return "in a vault chest";
    case "rack": return "on the potion rack";
    case "gift": return "in the gift chest";
    case "spoils": return "in the spoils chest";
    default: return w.kind;
  }
}

/**
 * A fleet note on a player meeting's swap row, as the person on the hub
 * reads it; null for notes that change nothing for them. `bot` is the bot's
 * IGN, `wants` the offer's want lines in words.
 */
export function playerProgress(event: string, d: Record<string, unknown>, bot: string, server: string, wants: string): Pick<MeetingProgressWire, "stage" | "detail"> | null {
  const trade = bot ? `/trade ${bot}` : "/trade the bot";
  const why = typeof d.why === "string" ? d.why : "";
  const inNexus = `${bot || "the bot"} is in the ${server} nexus: ${trade}`;
  switch (event) {
    case "swap-assigned": return d.inNexus ? { stage: "ready", detail: inNexus } : { stage: "on-the-way", detail: `${bot || "the bot"} is on its way to the ${server} nexus` };
    case "player-ready":
    case "swap-waiting": return { stage: "ready", detail: inNexus };
    case "player-invited": return { stage: "ready", detail: `${bot || "the bot"} sent you a trade request: accept it, or ${trade}` };
    case "player-window-open": return { stage: "trading", detail: `trade window open: put up ${wants || "what the offer asks for"}, then accept` };
    case "player-filling": return { stage: "trading", detail: `so far so good; ${why}` };
    case "player-matches": return { stage: "trading", detail: "your side fits: accept, and the bot accepts too" };
    case "player-holding": return { stage: "holding", detail: `the bot is not accepting yet: ${why}` };
    case "player-accepted": return { stage: "trading", detail: "both sides accepted; the trade is going through" };
    case "player-window-failed": return d.final ? null : { stage: "retry", detail: `${why}. ${trade} again when you are ready (${String(d.windows)} of ${String(d.max)} tries used)` };
    case "swap-interrupted": return { stage: "on-the-way", detail: `${bot || "the bot"} dropped out of the game and is logging back in` };
    default: return null;
  }
}
