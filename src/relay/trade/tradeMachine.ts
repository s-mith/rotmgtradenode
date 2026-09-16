// Per-bot trade state machine and the fleet-wide partner coordination it
// depends on. Port of pyrelay's CommunismTradeFulfillPlugin.
//
//   IDLE -> REQUESTED -> IN_TRADE -> ACCEPTED -> DONE | FAILED
//
// The bot never accepts on its own initiative except as the receiving end
// of a bot-to-bot consolidation. Everywhere else it mirrors the partner's
// accept, after checking the offer against the assignment.
//
// A consolidation can be a swap: both bots put items up (swapItems is what
// the other side sends back). The taker still accepts first, once its own
// offer is up and the giver's matches; the giver mirrors once the taker's
// offer is exactly the agreed swap.
import type { GameClient } from "../client/gameClient";
import type { AnyPacket, Packet } from "../protocol/packets";
import type { TradeItem } from "../protocol/data";
import { Stat } from "../protocol/stats";
import { enchantCount, MAX_ENCHANTS } from "../protocol/enchants";
import { isPoolItem, isSkinType, minEnchantsFor, toCatalogId, toObjType } from "./itemMap";

export const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000);
export const TRADE_TIMEOUT_MS = Number(process.env.TRADE_TIMEOUT_MS ?? 120_000);
export const PRESENCE_SETTLE_MS = Number(process.env.PRESENCE_SETTLE_MS ?? 6_000);
export const PARTNER_COOLDOWN_MS = Number(process.env.PARTNER_COOLDOWN_MS ?? 1_200);
/**
 * Bot-to-bot moves: the receiving bot accepts first. Realm ignores an accept
 * that lands right after the offer changed (a human can't click that fast),
 * so wait a beat, and re-send while the giver's mirror accept hasn't come.
 */
export const CONSOLIDATION_ACCEPT_DELAY_MS = Number(process.env.CONSOLIDATION_ACCEPT_DELAY_MS ?? 1500);
export const CONSOLIDATION_REACCEPT_MS = Number(process.env.CONSOLIDATION_REACCEPT_MS ?? 6000);
export const CONSOLIDATION_ACCEPT_ATTEMPTS = Number(process.env.CONSOLIDATION_ACCEPT_ATTEMPTS ?? 4);
export const PARTNER_LOCK_MAX_MS = Number(process.env.PARTNER_LOCK_MAX_MS ?? REQUEST_TIMEOUT_MS + TRADE_TIMEOUT_MS);

export type AssignmentKind = "deposit" | "withdraw" | "consolidate_give" | "consolidate_take";
export interface ItemQty {
  itemId: string;
  qty: number;
}
export interface Assignment {
  kind: AssignmentKind;
  requestId?: number;
  partnerIgn: string;
  items: ItemQty[];
  /** Per-instance withdraws: the exact physical items to hand over. */
  instanceIds?: string[] | null;
  /** Deposits: the agreed trade cap (diagnostic only; Realm enforces it). */
  itemCount?: number;
  /** Consolidation swaps: what flows the other way (take: we give these; give: we get these). */
  swapItems?: ItemQty[] | null;
  /** consolidate_take with swapItems: the exact instances to put up (a cross-node swap promised specific items). */
  swapInstanceIds?: string[] | null;
  /** Deposits: also take character skins. Only the operator's own skin deposits set this. */
  acceptSkins?: boolean;
}
export type Outcome =
  | { ok: true; kind: "deposit"; received: ItemQty[]; receivedUnits: { itemId: string; enchants: number }[] }
  | { ok: true; kind: "withdraw"; delivered: ItemQty[]; deliveredInstanceIds: string[] }
  | { ok: true; kind: "consolidate_give" | "consolidate_take"; consolidated: ItemQty[]; swapItems?: ItemQty[] }
  /** A withdraw that failed after one or more chunks crossed reports what did (`delivered`), so the site can re-queue the rest. */
  | { ok: false; error: string; partnerAbsent?: boolean; delivered?: ItemQty[]; deliveredInstanceIds?: string[] };

export type Phase = "IDLE" | "REQUESTED" | "IN_TRADE" | "ACCEPTED" | "DONE" | "FAILED";

/** Realm sends IGNs as "Base,XXXX" on trade packets; the site knows "Base". */
export function ignBase(name: string): string {
  return name ? name.split(",", 1)[0] : name;
}
export function ignMatch(a: string, b: string): boolean {
  return ignBase(a).toLowerCase() === ignBase(b).toLowerCase();
}
function partnerKey(ign: string): string {
  return ignBase(ign).toLowerCase();
}

/** Resolves a tracked instance id to the slot it sits in on this bot. */
export type InstanceResolver = (instanceId: string) => { slot: number; itemId: string } | undefined;

/** Slots in a trade window that hold inventory: the first four are equipment. */
const WINDOW_EQUIP_SLOTS = 4;
/**
 * Empty inventory slots on the partner's side of a trade window, i.e. how
 * many items they can take in this trade. The window lists the 4 equipment
 * slots, then 8 inventory slots (16 with a backpack); a window that does not
 * even reach past the equipment is treated as unknown (null) and no limit is
 * applied.
 */
export function partnerFreeSlots(items: TradeItem[]): number | null {
  if (items.length <= WINDOW_EQUIP_SLOTS) return null;
  let n = 0;
  for (let i = WINDOW_EQUIP_SLOTS; i < items.length; i++) if (items[i].item === -1) n++;
  return n;
}
const unitsOf = (items: ItemQty[]): number => items.reduce((n, it) => n + it.qty, 0);
/** `items` minus `taken`, per item id, dropping what reaches zero. */
function subtractItems(items: ItemQty[], taken: Map<string, number>): ItemQty[] {
  const left = new Map<string, number>();
  for (const it of items) left.set(it.itemId, (left.get(it.itemId) ?? 0) + it.qty);
  for (const [id, n] of taken) left.set(id, (left.get(id) ?? 0) - n);
  return [...left].filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
}
/**
 * The next chunk of a withdraw: at most `room` units of what is still owed.
 * Per-instance withdraws hand over the first `room` picked instances (their
 * item ids come from the tracker); aggregate ones the first `room` units in
 * request order. null when an instance is no longer tracked.
 */
export function pickChunk(
  owed: ItemQty[], owedInstanceIds: string[] | null, room: number, resolve: InstanceResolver,
): { items: ItemQty[]; instanceIds: string[] | null } | null {
  if (owedInstanceIds && owedInstanceIds.length) {
    const ids = owedInstanceIds.slice(0, Math.max(0, room));
    const counts = new Map<string, number>();
    for (const id of ids) {
      const hit = resolve(id);
      if (!hit) return null;
      counts.set(hit.itemId, (counts.get(hit.itemId) ?? 0) + 1);
    }
    return { items: [...counts].map(([itemId, qty]) => ({ itemId, qty })), instanceIds: ids };
  }
  const items: ItemQty[] = [];
  let budget = room;
  for (const it of owed) {
    if (budget <= 0) break;
    const take = Math.min(it.qty, budget);
    if (take > 0) items.push({ itemId: it.itemId, qty: take });
    budget -= take;
  }
  return { items, instanceIds: null };
}

/**
 * Fleet-wide: at most one bot engages a given player at a time, with a short
 * cooldown between consecutive bots so the player can dismiss one window
 * before the next request lands.
 */
export class PartnerCoordinator {
  private locks = new Map<string, { holder: string; since: number }>();
  private cooldownUntil = new Map<string, number>();

  acquire(ign: string, guid: string, holderIsTrading: (guid: string) => boolean, log?: (s: string) => void): boolean {
    const key = partnerKey(ign);
    if (!key) return true;
    const now = Date.now();
    let cur = this.locks.get(key);
    if (cur && cur.holder !== guid) {
      const age = now - cur.since;
      let stale: string | null = null;
      if (age > PARTNER_LOCK_MAX_MS) stale = `held ${Math.floor(age / 1000)}s, past every trade watchdog`;
      else if (!holderIsTrading(cur.holder)) stale = "holder has no assignment and is IDLE";
      if (stale === null) return false;
      log?.(`partner lock on ${key} was stuck (${stale}) — taking it from ${cur.holder} for ${guid}`);
      cur = undefined;
    }
    if (!cur) {
      if ((this.cooldownUntil.get(key) ?? 0) > now) return false;
      this.cooldownUntil.delete(key);
      this.locks.set(key, { holder: guid, since: now });
    }
    return true;
  }
  release(ign: string, guid: string): void {
    const key = partnerKey(ign);
    if (!key) return;
    if (this.locks.get(key)?.holder === guid) {
      this.locks.delete(key);
      this.cooldownUntil.set(key, Date.now() + PARTNER_COOLDOWN_MS);
    }
  }
  releaseAllFor(guid: string): void {
    for (const [k, v] of this.locks) if (v.holder === guid) this.locks.delete(k);
  }
  cooldownRemainingMs(ign: string): number {
    return Math.max(0, (this.cooldownUntil.get(partnerKey(ign)) ?? 0) - Date.now());
  }
}

/** Who this bot can currently see, from UPDATE's arrivals and departures. */
class PresenceView {
  private names = new Map<string, number>();
  private ids = new Map<number, string>();
  private seen = new Set<string>();
  private since = Date.now();

  reset(): void {
    this.names.clear();
    this.ids.clear();
    this.seen.clear();
    this.since = Date.now();
  }
  update(arrived: { objectId: number; ign: string }[], gone: number[]): void {
    for (const { objectId, ign } of arrived) {
      const key = partnerKey(ign);
      if (!key) continue;
      this.ids.set(objectId, key);
      this.names.set(key, objectId);
      this.seen.add(key);
    }
    for (const oid of gone) {
      const key = this.ids.get(oid);
      this.ids.delete(oid);
      // Only forget the name if it still points at the object that left.
      if (key !== undefined && this.names.get(key) === oid) this.names.delete(key);
    }
  }
  /** true = here, false = not here, null = too early to say. */
  present(ign: string): boolean | null {
    const key = partnerKey(ign);
    if (!key) return null;
    if (this.names.has(key)) return true;
    if (this.seen.has(key)) return false;
    if (Date.now() - this.since < PRESENCE_SETTLE_MS) return null;
    return false;
  }
}

export interface TradeSessionOptions {
  coordinator: PartnerCoordinator;
  resolveInstance: InstanceResolver;
  /** Slots that are somebody's personal property: never part of an aggregate offer. */
  excludeSlot?: (slot: number) => boolean;
  /** Called whenever the trade reaches a terminal state. */
  onOutcome?: () => void;
  log?: (line: string) => void;
}

export class TradeSession {
  phase: Phase = "IDLE";
  private assignment: Assignment | null = null;
  partnerIgn = "";
  private lastActionAt = 0;
  private clientItems: TradeItem[] = [];
  private partnerItems: TradeItem[] = [];
  private ourOffer: boolean[] = [];
  /** consolidate_take: when the delayed first accept is due (null = none pending). */
  private takerAcceptDue: number | null = null;
  private takerAcceptSentAt = 0;
  private takerAcceptAttempts = 0;
  private partnerOffer: boolean[] = [];
  /** Withdraw chunking: what crossed in the finished windows of this assignment, the window in flight, and when the next one may be requested. */
  private delivered = new Map<string, number>();
  private deliveredInstanceIds: string[] = [];
  private chunk: { items: ItemQty[]; instanceIds: string[] | null } | null = null;
  private chunkResumeAt: number | null = null;
  private chunks = 0;
  private outcome: Outcome | null = null;
  private readonly presence = new PresenceView();
  private readonly client: GameClient;
  private readonly opts: TradeSessionOptions;
  private readonly onPacket = (p: AnyPacket) => this.handle(p);

  constructor(client: GameClient, opts: TradeSessionOptions) {
    this.client = client;
    this.opts = opts;
    client.on("packet", this.onPacket);
  }

  detach(): void {
    this.client.off("packet", this.onPacket);
    this.reset();
  }

  private log(s: string): void {
    this.opts.log?.(`[trade] ${this.client.alias} ${s}`);
  }
  private get guid(): string {
    return this.client.guid;
  }

  // --- assignment API (what the dispatcher uses) ---------------------------

  getAssignment(): Assignment | null {
    return this.assignment;
  }
  setAssignment(a: Assignment | null): void {
    this.assignment = a;
    this.resetChunks();
  }
  private resetChunks(): void {
    this.delivered.clear();
    this.deliveredInstanceIds = [];
    this.chunk = null;
    this.chunkResumeAt = null;
    this.chunks = 0;
  }
  private deliveredList(): ItemQty[] {
    return [...this.delivered].map(([itemId, qty]) => ({ itemId, qty }));
  }
  /** What this withdraw still has to hand over. */
  private owed(a: Assignment): { items: ItemQty[]; instanceIds: string[] | null } {
    const doneIds = new Set(this.deliveredInstanceIds);
    return {
      items: subtractItems(a.items, this.delivered),
      instanceIds: a.instanceIds ? a.instanceIds.filter((id) => !doneIds.has(id)) : null,
    };
  }
  /** How many trade windows this assignment has completed so far. */
  get chunksDone(): number {
    return this.chunks;
  }
  isIdle(): boolean {
    return this.phase === "IDLE";
  }
  /** True while a partner lock held by this bot is plausibly still in use. */
  isTrading(): boolean {
    return this.assignment !== null || this.phase !== "IDLE";
  }
  partnerPresent(ign: string): boolean | null {
    return this.presence.present(ign);
  }

  /** Send REQUESTTRADE for the current assignment if idle. */
  sendTradeRequest(): boolean {
    const a = this.assignment;
    if (!a || this.phase !== "IDLE") return false;
    return this.request(a);
  }

  /** Pop the last outcome; releases the partner slot. */
  takeOutcome(): Outcome | null {
    if (!this.outcome) return null;
    const out = this.outcome;
    this.outcome = null;
    this.phase = "IDLE";
    this.opts.coordinator.release(this.partnerIgn, this.guid);
    return out;
  }

  /** Drop all state (bot disconnected). */
  reset(): void {
    if (this.partnerIgn) this.opts.coordinator.release(this.partnerIgn, this.guid);
    this.opts.coordinator.releaseAllFor(this.guid);
    this.phase = "IDLE";
    this.assignment = null;
    this.partnerIgn = "";
    this.outcome = null;
    this.resetChunks();
    this.clientItems = [];
    this.partnerItems = [];
    this.ourOffer = [];
    this.partnerOffer = [];
    this.presence.reset();
  }

  /** The other side of an open trade window, for the operator console. */
  partnerView(): { ign: string; phase: Phase; items: { slot: number; realmId: number; tradeable: boolean; enchantment: string; offered: boolean }[] } | null {
    if (this.phase !== "IN_TRADE" && this.phase !== "ACCEPTED") return null;
    const items = [];
    for (let i = 0; i < this.partnerItems.length; i++) {
      const it = this.partnerItems[i];
      if (it.item < 0) continue;
      items.push({ slot: i, realmId: it.item, tradeable: it.tradeable, enchantment: it.enchantment, offered: this.partnerOffer[i] ?? false });
    }
    return { ign: this.partnerIgn, phase: this.phase, items };
  }

  // --- internals ------------------------------------------------------------

  private finish(outcome: Outcome, phase: "DONE" | "FAILED"): void {
    if (!outcome.ok && this.assignment?.kind === "withdraw" && this.delivered.size) {
      outcome = { ...outcome, delivered: this.deliveredList(), deliveredInstanceIds: [...this.deliveredInstanceIds] };
    }
    this.outcome = outcome;
    this.phase = phase;
    this.opts.onOutcome?.();
  }
  private giveUp(reason: string): void {
    this.log(`giving up on ${this.partnerIgn || "?"}: ${reason}`);
    this.finish({ ok: false, error: reason, partnerAbsent: true }, "FAILED");
  }
  private cancel(error: string): void {
    this.client.send("CANCELTRADE", {});
    this.finish({ ok: false, error }, "FAILED");
  }

  private request(a: Assignment): boolean {
    if (this.chunkResumeAt !== null && Date.now() < this.chunkResumeAt) return false;
    this.chunkResumeAt = null;
    if (this.presence.present(a.partnerIgn) === false) {
      this.partnerIgn = a.partnerIgn;
      this.giveUp("partner not in nexus");
      return false;
    }
    const holderIsTrading = (g: string) => g === this.guid && this.isTrading();
    if (!this.opts.coordinator.acquire(a.partnerIgn, this.guid, holderIsTrading, (s) => this.log(s))) return false;
    this.phase = "REQUESTED";
    this.partnerIgn = a.partnerIgn;
    this.lastActionAt = Date.now();
    this.outcome = null;
    this.client.send("REQUESTTRADE", { name: a.partnerIgn });
    this.log(`requested trade with ${a.partnerIgn}`);
    return true;
  }

  private handle(p: AnyPacket): void {
    switch (p.type) {
      case "UPDATE": this.onUpdate(p); break;
      case "MAPINFO": this.onMapInfo(); break;
      case "TRADEREQUESTED": this.onTradeRequested(p); break;
      case "TRADESTART": this.onTradeStart(p); break;
      case "TRADECHANGED": this.onTradeChanged(p); break;
      case "TRADEACCEPTED": this.onTradeAccepted(p); break;
      case "TRADEDONE": this.onTradeDone(p); break;
      // Realm sends PING rarely (none seen in 45s of nexus time on the live
      // fleet); NEWTICK arrives ~5/s, so the watchdog runs on both.
      case "PING":
      case "NEWTICK": this.watchdog(); break;
      default: break;
    }
  }

  private onUpdate(p: Packet<"UPDATE">): void {
    const arrived: { objectId: number; ign: string }[] = [];
    for (const obj of p.newObjs) {
      for (const st of obj.status.stats) {
        if (st.statType === Stat.NAME && st.strStatValue) {
          arrived.push({ objectId: obj.status.objectId, ign: st.strStatValue });
          break;
        }
      }
    }
    if (arrived.length || p.drops.length) this.presence.update(arrived, p.drops);
    if (this.phase !== "REQUESTED" && this.phase !== "IN_TRADE") return;
    if (this.presence.present(this.partnerIgn) === false) {
      if (this.phase !== "REQUESTED") this.client.send("CANCELTRADE", {});
      this.giveUp("partner left");
    }
  }

  private onMapInfo(): void {
    this.presence.reset();
    if (this.assignment && this.phase === "IDLE") this.request(this.assignment);
  }

  private onTradeRequested(p: Packet<"TRADEREQUESTED">): void {
    const a = this.assignment;
    if (!a || !ignMatch(p.name, a.partnerIgn)) return;
    const holderIsTrading = (g: string) => g === this.guid && this.isTrading();
    if (!this.opts.coordinator.acquire(a.partnerIgn, this.guid, holderIsTrading, (s) => this.log(s))) return;
    if (this.phase === "IDLE") {
      this.phase = "REQUESTED";
      this.partnerIgn = a.partnerIgn;
      this.lastActionAt = Date.now();
      this.outcome = null;
    }
    // The same packet type doubles as our accept.
    this.client.send("REQUESTTRADE", { name: p.name });
  }

  private onTradeStart(p: Packet<"TRADESTART">): void {
    const a = this.assignment;
    if (!a) {
      this.client.send("CANCELTRADE", {});
      return;
    }
    if (!ignMatch(p.partnerName, a.partnerIgn)) {
      this.log(`unexpected partner ${p.partnerName} — cancel`);
      this.cancel("wrong partner");
      return;
    }
    this.phase = "IN_TRADE";
    this.clientItems = [...p.clientItems];
    this.partnerItems = [...p.partnerItems];
    this.partnerOffer = [];
    this.lastActionAt = Date.now();
    this.takerAcceptDue = null;
    this.takerAcceptSentAt = 0;
    this.takerAcceptAttempts = 0;

    const swapping = a.kind === "consolidate_take" && !!a.swapItems?.length;
    if (a.kind === "deposit" || (a.kind === "consolidate_take" && !swapping)) {
      this.log(`${a.kind} started, waiting for partner offer`);
      return;
    }
    let giving = swapping ? a.swapItems! : a.items;
    let giveIds = swapping ? a.swapInstanceIds ?? null : a.instanceIds ?? null;
    if (a.kind === "withdraw") {
      // Hand over only what fits in the partner's inventory right now; the
      // rest goes in further windows of the same assignment.
      const owed = this.owed(a);
      const room = partnerFreeSlots(p.partnerItems);
      if (room === 0) {
        this.log("partner has no free inventory slot — cancel");
        this.cancel("partner inventory full");
        return;
      }
      const chunk = room === null ? { items: owed.items, instanceIds: owed.instanceIds } : pickChunk(owed.items, owed.instanceIds, room, this.opts.resolveInstance);
      if (!chunk) {
        this.log("a picked instance is no longer tracked — cancel");
        this.cancel("items not present");
        return;
      }
      this.chunk = chunk;
      giving = chunk.items;
      giveIds = chunk.instanceIds;
      if (room !== null && unitsOf(chunk.items) < unitsOf(owed.items)) this.log(`partner has room for ${room}: offering ${unitsOf(chunk.items)} of the ${unitsOf(owed.items)} still owed (window ${this.chunks + 1})`);
    }
    const offer = this.computeWithdrawOffer(p.clientItems, giving, giveIds);
    if (!offer) {
      this.log(`can't satisfy ${a.kind} — cancel`);
      this.cancel("items not present");
      return;
    }
    this.ourOffer = offer;
    this.client.send("CHANGETRADE", { offer });
    this.log(swapping ? "offered our side of the swap, waiting for the giver's" : `offered ${a.kind} items, waiting for accept`);
  }

  private computeWithdrawOffer(clientItems: TradeItem[], requested: ItemQty[], instanceIds: string[] | null): boolean[] | null {
    if (instanceIds && instanceIds.length) {
      const expected = new Map<string, number>();
      for (const it of requested) {
        const ot = toObjType(it.itemId);
        if (ot === undefined) return null;
        expected.set(it.itemId, ot);
      }
      const offer = clientItems.map(() => false);
      for (const id of instanceIds) {
        const hit = this.opts.resolveInstance(id);
        if (!hit) {
          this.log(`instance ${id} not in tracker; aborting offer`);
          return null;
        }
        if (hit.slot >= clientItems.length) {
          this.log(`instance ${id} sits in slot ${hit.slot} but the window has ${clientItems.length}; aborting`);
          return null;
        }
        const ti = clientItems[hit.slot];
        if (!ti.tradeable) {
          this.log(`slot ${hit.slot} for instance ${id} is non-tradeable; aborting`);
          return null;
        }
        const expectedType = expected.get(hit.itemId) ?? -1;
        if (expectedType !== -1 && ti.item !== expectedType) {
          this.log(`slot ${hit.slot} type ${ti.item} doesn't match tracker ${hit.itemId} (${expectedType}); aborting`);
          return null;
        }
        offer[hit.slot] = true;
      }
      return offer;
    }
    const needed = new Map<number, number>();
    for (const it of requested) {
      const ot = toObjType(it.itemId);
      if (ot === undefined) return null;
      needed.set(ot, (needed.get(ot) ?? 0) + it.qty);
    }
    const offer = clientItems.map(() => false);
    // Least-enchanted first: aggregate withdraws settle against tier-0
    // holdings, so an enchanted copy must not leave when a clean one exists.
    const order = clientItems.map((_, i) => i).sort((a, b) => enchantCount(clientItems[a].enchantment) - enchantCount(clientItems[b].enchantment));
    for (const i of order) {
      const ti = clientItems[i];
      if (!ti.tradeable || this.opts.excludeSlot?.(i)) continue;
      const rem = needed.get(ti.item) ?? 0;
      if (rem <= 0) continue;
      offer[i] = true;
      needed.set(ti.item, rem - 1);
    }
    for (const v of needed.values()) if (v > 0) return null;
    return offer;
  }

  private onTradeChanged(p: Packet<"TRADECHANGED">): void {
    const a = this.assignment;
    if (!a) return;
    if (this.phase !== "IN_TRADE" && this.phase !== "ACCEPTED") return;
    this.partnerOffer = [...p.offer];
    this.lastActionAt = Date.now();
    if (a.kind === "consolidate_give" || a.kind === "consolidate_take") this.log(`TRADECHANGED partner=${mask(p.offer)} phase=${this.phase}`);
    // Any change clears both accept boxes server-side.
    if (this.phase === "ACCEPTED") this.phase = "IN_TRADE";

    if (a.kind === "withdraw" || a.kind === "consolidate_give") {
      const back = a.kind === "consolidate_give" ? a.swapItems ?? [] : [];
      if (p.offer.some(Boolean) && !(back.length && this.partnerOfferWithin(back, p.offer))) {
        this.log(`partner tried to add items in ${a.kind} — cancel`);
        this.cancel("partner added items");
      }
      return;
    }
    if (a.kind === "consolidate_take") {
      // The one place a bot accepts first: the receiving side of a bot-to-bot
      // move gives nothing away, and someone has to break the tie.
      if (!this.partnerOfferMatches(a.items)) {
        this.takerAcceptDue = null;
        return;
      }
      this.takerAcceptAttempts = 0;
      if (CONSOLIDATION_ACCEPT_DELAY_MS <= 0) this.sendTakerAccept();
      else {
        this.takerAcceptDue = Date.now() + CONSOLIDATION_ACCEPT_DELAY_MS;
        this.log(`giver's offer matches — accepting in ${CONSOLIDATION_ACCEPT_DELAY_MS}ms`);
      }
    }
  }

  /** consolidate_take: check our accept box (empty, or our side of a swap); the giver mirrors it. */
  private sendTakerAccept(): void {
    this.takerAcceptDue = null;
    if (!this.assignment?.swapItems?.length) this.ourOffer = this.clientItems.map(() => false);
    this.client.send("ACCEPTTRADE", { clientOffer: this.ourOffer, partnerOffer: [...this.partnerOffer] });
    this.phase = "ACCEPTED";
    this.lastActionAt = Date.now();
    this.takerAcceptSentAt = this.lastActionAt;
    this.takerAcceptAttempts++;
    this.log(this.takerAcceptAttempts === 1 ? "accepted consolidation receive (first mover)" : `re-sent consolidation accept (attempt ${this.takerAcceptAttempts})`);
  }

  private partnerOfferMatches(expected: ItemQty[], mask: boolean[] = this.partnerOffer): boolean {
    const got = this.offeredCounts(mask);
    if (!got) return false;
    const want = new Map<string, number>();
    for (const e of expected) want.set(e.itemId, (want.get(e.itemId) ?? 0) + e.qty);
    if (got.size !== want.size) return false;
    for (const [k, v] of want) if (got.get(k) !== v) return false;
    return true;
  }
  /** Every offered item is part of `expected` (a swap partner still filling its side). */
  private partnerOfferWithin(expected: ItemQty[], mask: boolean[]): boolean {
    const got = this.offeredCounts(mask);
    if (!got) return false;
    const want = new Map<string, number>();
    for (const e of expected) want.set(e.itemId, (want.get(e.itemId) ?? 0) + e.qty);
    for (const [k, v] of got) if ((want.get(k) ?? 0) < v) return false;
    return true;
  }
  /** Catalog id -> count over the partner's window under `mask`; null on an unknown item. */
  private offeredCounts(mask: boolean[]): Map<string, number> | null {
    const got = new Map<string, number>();
    for (let i = 0; i < this.partnerItems.length; i++) {
      if (!mask[i]) continue;
      const cid = toCatalogId(this.partnerItems[i].item);
      if (cid === undefined) return null;
      got.set(cid, (got.get(cid) ?? 0) + 1);
    }
    return got;
  }

  private onTradeAccepted(p: Packet<"TRADEACCEPTED">): void {
    const a = this.assignment;
    if (a && (a.kind === "consolidate_give" || a.kind === "consolidate_take")) this.log(`TRADEACCEPTED client=${mask(p.clientOffer)} partner=${mask(p.partnerOffer)} phase=${this.phase}`);
    if (!a || this.phase !== "IN_TRADE") return;
    if (a.kind === "consolidate_take") return;

    if (a.kind === "withdraw" || a.kind === "consolidate_give") {
      if (!sameMask(p.clientOffer, this.ourOffer)) {
        this.log("accept-time client offer mismatch — cancel");
        this.cancel("offer mismatch at accept");
        return;
      }
      const back = a.kind === "consolidate_give" ? a.swapItems ?? [] : [];
      if (back.length ? !this.partnerOfferMatches(back, p.partnerOffer) : p.partnerOffer.some(Boolean)) {
        this.log(back.length ? "partner's side of the swap doesn't match at accept — cancel" : "partner offered items at accept — cancel");
        this.cancel(back.length ? "swap offer mismatch" : "partner added items");
        return;
      }
      this.client.send("ACCEPTTRADE", { clientOffer: [...this.ourOffer], partnerOffer: [...p.partnerOffer] });
      this.phase = "ACCEPTED";
      this.lastActionAt = Date.now();
      this.log(`accepted ${a.kind}`);
      return;
    }

    // Deposit: accept iff everything checked is a recognised pool item of
    // sufficient rarity. Realm sizes the window to our free slots, so the
    // count cap needs no enforcement here.
    let offered = 0;
    for (let i = 0; i < p.partnerOffer.length; i++) {
      if (!p.partnerOffer[i] || i >= this.partnerItems.length) continue;
      const ti = this.partnerItems[i];
      if (!isPoolItem(ti.item)) {
        if (a.acceptSkins && isSkinType(ti.item)) {
          offered++;
          continue;
        }
        this.log(isSkinType(ti.item) ? "partner offered a skin on a normal deposit — holding" : "partner offered non-pool item at accept — holding");
        return;
      }
      const need = minEnchantsFor(ti.item);
      if (need && enchantCount(ti.enchantment) < need) {
        this.log(`partner offered item ${ti.item} below minimum rarity — holding`);
        return;
      }
      offered++;
    }
    this.ourOffer = this.clientItems.map(() => false);
    this.client.send("ACCEPTTRADE", { clientOffer: this.ourOffer, partnerOffer: [...p.partnerOffer] });
    // Record the mask we validated: the report is built from it.
    this.partnerOffer = [...p.partnerOffer];
    this.phase = "ACCEPTED";
    this.lastActionAt = Date.now();
    this.log(`accepted deposit with ${offered} items (cap=${a.itemCount ?? 0})`);
  }

  private onTradeDone(p: Packet<"TRADEDONE">): void {
    const a = this.assignment;
    if (!a) return;
    if (p.code !== 0) {
      this.log(`TRADEDONE code=${p.code} desc=${p.description}`);
      this.finish({ ok: false, error: p.description || `code ${p.code}` }, "FAILED");
      return;
    }
    let out: Outcome;
    if (a.kind === "consolidate_give" || a.kind === "consolidate_take") {
      out = { ok: true, kind: a.kind, consolidated: [...a.items], ...(a.swapItems?.length ? { swapItems: [...a.swapItems] } : {}) };
    } else if (a.kind === "deposit") {
      const counts = new Map<string, number>();
      const units: { itemId: string; enchants: number }[] = [];
      for (let i = 0; i < this.partnerItems.length; i++) {
        if (!this.partnerOffer[i]) continue;
        const cid = toCatalogId(this.partnerItems[i].item);
        if (cid === undefined) continue;
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
        // The catalog carries at most MAX_ENCHANTS; the wire reserves four.
        units.push({ itemId: cid, enchants: Math.min(MAX_ENCHANTS, enchantCount(this.partnerItems[i].enchantment)) });
      }
      out = { ok: true, kind: "deposit", received: [...counts].map(([itemId, qty]) => ({ itemId, qty })), receivedUnits: units };
    } else {
      const chunk = this.chunk ?? { items: a.items, instanceIds: a.instanceIds ?? null };
      for (const it of chunk.items) this.delivered.set(it.itemId, (this.delivered.get(it.itemId) ?? 0) + it.qty);
      if (chunk.instanceIds) this.deliveredInstanceIds.push(...chunk.instanceIds);
      this.chunk = null;
      this.chunks++;
      const owed = this.owed(a);
      if (unitsOf(owed.items) > 0) {
        // Same assignment, next window: the partner lock stays ours; the
        // request goes out once the partner's client has closed this trade.
        this.log(`TRADEDONE window ${this.chunks}: ${unitsOf(owed.items)} item(s) still owed — requesting the next trade in ${PARTNER_COOLDOWN_MS}ms`);
        this.phase = "IDLE";
        this.clientItems = [];
        this.partnerItems = [];
        this.ourOffer = [];
        this.partnerOffer = [];
        this.lastActionAt = Date.now();
        this.chunkResumeAt = this.lastActionAt + PARTNER_COOLDOWN_MS;
        return;
      }
      out = { ok: true, kind: "withdraw", delivered: this.deliveredList(), deliveredInstanceIds: [...this.deliveredInstanceIds] };
    }
    this.log(`TRADEDONE success kind=${a.kind}${this.chunks > 1 ? ` (${this.chunks} windows)` : ""}`);
    this.finish(out, "DONE");
  }

  /** Timeouts for a trade that stopped moving. */
  private watchdog(): void {
    if (this.phase === "IDLE") {
      if (this.assignment && this.chunkResumeAt !== null && Date.now() >= this.chunkResumeAt) this.request(this.assignment);
      return;
    }
    const now = Date.now();
    if (this.assignment?.kind === "consolidate_take") {
      if (this.phase === "IN_TRADE" && this.takerAcceptDue !== null && now >= this.takerAcceptDue) this.sendTakerAccept();
      else if (this.phase === "ACCEPTED" && this.takerAcceptAttempts < CONSOLIDATION_ACCEPT_ATTEMPTS && now - this.takerAcceptSentAt > CONSOLIDATION_REACCEPT_MS) this.sendTakerAccept();
    }
    const elapsed = now - this.lastActionAt;
    if (this.phase === "REQUESTED" && elapsed > REQUEST_TIMEOUT_MS) {
      this.giveUp(`no trade window ${Math.floor(REQUEST_TIMEOUT_MS / 1000)}s after the request`);
    } else if ((this.phase === "IN_TRADE" || this.phase === "ACCEPTED") && elapsed > TRADE_TIMEOUT_MS) {
      this.log(`trade timed out in ${this.phase} — cancelling`);
      this.cancel("trade timeout");
    }
  }
}

function mask(m: boolean[]): string {
  return m.map((v) => (v ? "1" : "0")).join("");
}

function sameMask(a: boolean[], b: boolean[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
