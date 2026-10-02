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
//
// A player swap is a person trading with their own character against one of
// this node's offers. The bot puts up the offer's items, judges whatever the
// person puts up against the offer's want lines, and mirrors their accept
// only when it covers them exactly. A person fumbles: a wrong item is held
// with a reason rather than cancelled, and a window that closes without the
// trade does not end the meeting; they /trade again until its deadline.
import type { GameClient } from "../client/gameClient";
import type { AnyPacket, Packet } from "../protocol/packets";
import type { TradeItem } from "../protocol/data";
import { Stat } from "../protocol/stats";
import { decodeEnchantRecord, enchantCount, MAX_ENCHANTS } from "../protocol/enchants";
import { isPoolItem, isSkinType, minEnchantsFor, toCatalogId, toObjType } from "./itemMap";

export const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000);
export const TRADE_TIMEOUT_MS = Number(process.env.TRADE_TIMEOUT_MS ?? 120_000);
export const PRESENCE_SETTLE_MS = Number(process.env.PRESENCE_SETTLE_MS ?? 6_000);
export const PARTNER_COOLDOWN_MS = Number(process.env.PARTNER_COOLDOWN_MS ?? 1_200);
/**
 * Bot-to-bot moves: the receiving bot accepts first. Realm ignores an accept
 * that lands right after the offer changed (a human can't click that fast),
 * so wait a beat, and re-send while the giver's mirror accept hasn't come.
 * The giver's offer is judged again right before each of those accepts
 * (sendTakerAccept), not only when it changed.
 */
export const CONSOLIDATION_ACCEPT_DELAY_MS = Number(process.env.CONSOLIDATION_ACCEPT_DELAY_MS ?? 1500);
export const CONSOLIDATION_REACCEPT_MS = Number(process.env.CONSOLIDATION_REACCEPT_MS ?? 6000);
export const CONSOLIDATION_ACCEPT_ATTEMPTS = Number(process.env.CONSOLIDATION_ACCEPT_ATTEMPTS ?? 4);
export const PARTNER_LOCK_MAX_MS = Number(process.env.PARTNER_LOCK_MAX_MS ?? REQUEST_TIMEOUT_MS + TRADE_TIMEOUT_MS);
/**
 * A cross-node meeting (Assignment.meetingDeadlineAt): a request the partner
 * does not answer is sent again this much later, until the deadline. The
 * other node's bot may still be logging in; one unanswered request is not
 * a verdict on the meeting.
 */
export const REQUEST_RETRY_MS = Number(process.env.REQUEST_RETRY_MS ?? 15_000);
/**
 * A player meeting: the person's own /trade is the usual way in. The bot
 * invites once when it first sees them in the nexus, and after that no more
 * often than this, so a player who is sorting their inventory is not nagged.
 */
export const PLAYER_REINVITE_MS = Number(process.env.PLAYER_REINVITE_MS ?? 120_000);
/** A player meeting gives up after this many trade windows closed without the trade (cancelled, idle, wrong items, no room). */
export const PLAYER_MAX_WINDOWS = Number(process.env.PLAYER_MAX_WINDOWS ?? 6);

export type AssignmentKind = "deposit" | "withdraw" | "consolidate_give" | "consolidate_take" | "player_swap";
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
  /**
   * A meeting with another node's bot (design doc §6.2): the giver keeps
   * inviting until this time, the taker never invites (it answers the
   * giver's request), and only the deadline makes an absent partner a failure.
   */
  meetingDeadlineAt?: number | null;
  /**
   * What must arrive, one entry per physical item, when the counterparty's
   * enchantments are known: the partner's window is checked against these,
   * not only against catalog counts. `enchants: null` accepts any copy.
   */
  expectIncoming?: ItemDetail[] | null;
  /**
   * player_swap: judges what the person put up (every offered item, in
   * window order), since which copies they bring is theirs to choose.
   * `exact` false while they are still filling their side, true when they
   * accept. `why` is shown to them.
   */
  incomingCheck?: ((offered: ItemDetail[], exact: boolean) => { ok: true } | { ok: false; why: string }) | null;
  /** player_swap: how many items the person hands over in a trade that fits (for the room check). */
  incomingCount?: number;
}
/** One physical item as a trade window shows it: catalog id and decoded enchant ids (null when the record could not be read). */
export interface ItemDetail {
  itemId: string;
  enchants: number[] | null;
}
export type Outcome =
  | { ok: true; kind: "deposit"; received: ItemQty[]; receivedUnits: { itemId: string; enchants: number }[] }
  | { ok: true; kind: "withdraw"; delivered: ItemQty[]; deliveredInstanceIds: string[] }
  | { ok: true; kind: "consolidate_give" | "consolidate_take"; consolidated: ItemQty[]; swapItems?: ItemQty[]; partnerName?: string; ourOffered?: ItemDetail[]; partnerOffered?: ItemDetail[] }
  | { ok: true; kind: "player_swap"; gave: ItemQty[]; got: ItemQty[]; partnerName?: string; ourOffered: ItemDetail[]; partnerOffered: ItemDetail[] }
  /** A withdraw that failed after one or more chunks crossed reports what did (`delivered`), so the site can re-queue the rest. */
  | { ok: false; error: string; partnerAbsent?: boolean; delivered?: ItemQty[]; deliveredInstanceIds?: string[]; partnerName?: string };

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
  /** The node's own say on a pool item offered in a deposit: false holds the trade (src/lib/itemPolicy.ts). */
  acceptsType?: (objType: number) => boolean;
  /** Called whenever the trade reaches a terminal state. */
  onOutcome?: () => void;
  /** What a player meeting is doing now, for the person waiting on the hub (invited, window open, holding and why, window closed). Repeats are not sent. */
  onNote?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * True: a map change does not ask for the trade by itself; the dispatcher
   * asks once the bot has arrived in the Nexus (a bot that waited in its Vault,
   * whose request would otherwise go out before the Nexus streams in).
   */
  requestOnArrival?: () => boolean;
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
  /** Whispers already sent to the partner this assignment (tellPartner). */
  private toldPartner = new Set<string>();
  /** A meeting's request went unanswered: when to send the next one (null = none due). */
  private requestRetryAt: number | null = null;
  /** The partner's name as the trade window showed it (TRADESTART), for the receipt. */
  private observedPartner = "";
  /** A player meeting: when the bot last invited, the windows opened and closed without the trade, whether the person was ever seen, the last note sent. */
  private lastInviteAt = 0;
  private windowsOpened = 0;
  private windowFailures = 0;
  private playerSeen = false;
  private lastNoteKey = "";
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
  /** A meeting's new deadline (the hub extended it): requests keep going until then. */
  extendMeeting(deadlineAt: number): void {
    if (this.assignment && this.assignment.meetingDeadlineAt != null && deadlineAt > this.assignment.meetingDeadlineAt) this.assignment = { ...this.assignment, meetingDeadlineAt: deadlineAt };
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
    this.toldPartner.clear();
    this.requestRetryAt = null;
    this.observedPartner = "";
    this.lastInviteAt = 0;
    this.windowsOpened = 0;
    this.windowFailures = 0;
    this.playerSeen = false;
    this.lastNoteKey = "";
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
  /** Whisper the trade partner, once per distinct message per assignment. */
  private tellPartner(text: string): void {
    const to = this.partnerIgn || this.assignment?.partnerIgn || "";
    if (!to || this.toldPartner.has(text)) return;
    this.toldPartner.add(text);
    this.client.send("PLAYERTEXT", { text: `/tell ${to} ${text}` });
  }
  /** A withdraw's finished windows so far, when any crossed: what a disconnect must still report. */
  partialDelivery(): { delivered: ItemQty[]; deliveredInstanceIds: string[] } | null {
    if (this.assignment?.kind !== "withdraw" || !this.delivered.size) return null;
    return { delivered: this.deliveredList(), deliveredInstanceIds: [...this.deliveredInstanceIds] };
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
  /** A player meeting so far: whether the person was ever seen or traded, and how many windows opened and closed without the trade. */
  playerProgress(): { seen: boolean; windowsOpened: number; windowFailures: number } {
    return { seen: this.playerSeen || this.windowsOpened > 0, windowsOpened: this.windowsOpened, windowFailures: this.windowFailures };
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
    // The view of who is around is kept: the bot is still on the same map,
    // and the server never re-announces players already in view, so wiping
    // it here made everyone "not in nexus" once the settle window passed
    // (live 2026-10-01: a withdraw right after a failed deposit with the same
    // player gave up in 0s). onMapInfo clears it when the map really changes.
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
    this.finish({ ok: false, error: reason, partnerAbsent: true, ...(this.observedPartner ? { partnerName: this.observedPartner } : {}) }, "FAILED");
  }
  private cancel(error: string): void {
    this.client.send("CANCELTRADE", {});
    this.finish({ ok: false, error, ...(this.observedPartner ? { partnerName: this.observedPartner } : {}) }, "FAILED");
  }

  /** A player meeting's news, once per change (the same hold reason on every TRADECHANGED is one note). */
  private note(event: string, detail: Record<string, unknown> = {}): void {
    const key = `${event}|${JSON.stringify(detail)}`;
    if (key === this.lastNoteKey) return;
    this.lastNoteKey = key;
    this.opts.onNote?.(event, detail);
  }
  /**
   * A player meeting's window closed without the trade: the meeting goes on
   * (the person can /trade again) until too many windows have failed. The
   * partner lock is let go so its short cooldown applies before the next one.
   */
  private windowFailed(why: string): void {
    this.windowFailures++;
    this.log(`player window ${this.windowFailures}/${PLAYER_MAX_WINDOWS} closed without the trade: ${why}`);
    if (this.windowFailures >= PLAYER_MAX_WINDOWS) {
      this.note("player-window-failed", { why, windows: this.windowFailures, max: PLAYER_MAX_WINDOWS, final: true });
      this.finish({ ok: false, error: `${why} (${this.windowFailures} trade windows closed without the trade)`, ...(this.observedPartner ? { partnerName: this.observedPartner } : {}) }, "FAILED");
      return;
    }
    this.note("player-window-failed", { why, windows: this.windowFailures, max: PLAYER_MAX_WINDOWS });
    this.opts.coordinator.release(this.partnerIgn, this.guid);
    this.phase = "IDLE";
    this.clientItems = [];
    this.partnerItems = [];
    this.ourOffer = [];
    this.partnerOffer = [];
    this.lastActionAt = Date.now();
  }
  private cancelWindow(why: string): void {
    this.client.send("CANCELTRADE", {});
    this.windowFailed(why);
  }

  /** A player meeting: wait to be asked, or invite the person once they are in view, then no more often than PLAYER_REINVITE_MS. */
  private invitePlayer(a: Assignment): boolean {
    this.partnerIgn = a.partnerIgn;
    if (this.presence.present(a.partnerIgn) !== true) return false;
    this.playerSeen = true;
    const now = Date.now();
    if (this.lastInviteAt && now - this.lastInviteAt < PLAYER_REINVITE_MS) return false;
    const holderIsTrading = (g: string) => g === this.guid && this.isTrading();
    if (!this.opts.coordinator.acquire(a.partnerIgn, this.guid, holderIsTrading, (s) => this.log(s))) return false;
    this.phase = "REQUESTED";
    this.lastActionAt = now;
    this.lastInviteAt = now;
    this.outcome = null;
    this.client.send("REQUESTTRADE", { name: a.partnerIgn });
    this.log(`invited player ${a.partnerIgn}`);
    this.note("player-invited");
    return true;
  }

  private request(a: Assignment): boolean {
    if (a.kind === "player_swap") return this.invitePlayer(a);
    // The receiving side of a bot-to-bot move never invites: the giver's
    // request reaches it as TRADEREQUESTED and it answers there. Two bots
    // inviting each other worked when both were ready at once, but a taker's
    // lone request timed out and failed the whole meeting when the giver's
    // node was a few seconds behind.
    if (a.kind === "consolidate_take") {
      this.partnerIgn = a.partnerIgn;
      return false;
    }
    if (this.chunkResumeAt !== null && Date.now() < this.chunkResumeAt) return false;
    this.chunkResumeAt = null;
    if (this.requestRetryAt !== null && Date.now() < this.requestRetryAt) return false;
    const present = this.presence.present(a.partnerIgn);
    if (present === false) {
      this.partnerIgn = a.partnerIgn;
      // A player who queued a trade and is not here has left; another
      // node's bot may still be logging in for its side of a meeting, so a
      // swap waits (the dispatcher fails it at the meeting deadline).
      if (a.kind === "deposit" || a.kind === "withdraw") this.giveUp("partner not in nexus");
      return false;
    }
    // A meeting waits for a sighting rather than inviting into a map still streaming in.
    if (present === null && a.meetingDeadlineAt != null) {
      this.partnerIgn = a.partnerIgn;
      return false;
    }
    this.requestRetryAt = null;
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
    const a = this.assignment;
    if (a?.kind === "player_swap") {
      const here = this.presence.present(a.partnerIgn);
      if (here === true && !this.playerSeen) {
        this.playerSeen = true;
        this.note("player-seen");
      }
      // A person who walks off mid-window can come back: that window is over, the meeting is not.
      if (here === false && this.phase === "IN_TRADE") this.cancelWindow("you left the nexus");
      else if (here === false && this.phase === "REQUESTED") {
        this.opts.coordinator.release(this.partnerIgn, this.guid);
        this.phase = "IDLE";
      }
      return;
    }
    if (this.phase !== "REQUESTED" && this.phase !== "IN_TRADE") return;
    if (this.presence.present(this.partnerIgn) === false) {
      if (this.phase !== "REQUESTED") this.client.send("CANCELTRADE", {});
      // A meeting: the other node's bot dropped (its node restarted, it reconnected) and comes back for its side;
      // nothing traded without TRADEDONE, so wait for it until the deadline (live 2026-09-24: a taker node killed
      // for half a minute failed the whole meeting here).
      const deadline = this.assignment?.meetingDeadlineAt ?? null;
      const now = Date.now();
      if (deadline !== null && now < deadline) {
        this.log(`${this.partnerIgn} left the nexus — waiting for it to come back (meeting deadline in ${Math.floor((deadline - now) / 1000)}s)`);
        this.phase = "IDLE";
        this.requestRetryAt = now + REQUEST_RETRY_MS;
        return;
      }
      this.giveUp("partner left");
    }
  }

  private onMapInfo(): void {
    this.presence.reset();
    if (this.assignment && this.phase === "IDLE" && !this.opts.requestOnArrival?.()) this.request(this.assignment);
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
    if (a.kind === "player_swap") this.playerSeen = true;
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
      // Somebody else's window is no reason to end a player's meeting.
      if (a.kind === "player_swap") this.client.send("CANCELTRADE", {});
      else this.cancel("wrong partner");
      return;
    }
    this.phase = "IN_TRADE";
    this.observedPartner = ignBase(p.partnerName);
    this.clientItems = [...p.clientItems];
    this.partnerItems = [...p.partnerItems];
    this.partnerOffer = [];
    this.lastActionAt = Date.now();
    this.takerAcceptDue = null;
    this.takerAcceptSentAt = 0;
    this.takerAcceptAttempts = 0;

    if (a.kind === "player_swap") {
      this.windowsOpened++;
      this.playerSeen = true;
      const offer = this.computeWithdrawOffer(p.clientItems, a.items, a.instanceIds ?? null);
      if (!offer) {
        this.log("the offer's items are not all in this window — cancel");
        this.cancel("items not present");
        return;
      }
      // What they end up with has to fit: what the bot hands over, less the slots their own items free.
      const need = unitsOf(a.items) - (a.incomingCount ?? 0);
      const room = partnerFreeSlots(p.partnerItems);
      if (room !== null && need > room) {
        this.log(`player has ${room} free slot(s) and would need ${need} — cancel window`);
        this.cancelWindow(`you need ${need} free inventory slot${need === 1 ? "" : "s"} and have ${room}; make room, then /trade again`);
        return;
      }
      this.ourOffer = offer;
      this.client.send("CHANGETRADE", { offer });
      this.log(`player window ${this.windowsOpened}: offered the offer's items, waiting for theirs`);
      this.note("player-window-open", { window: this.windowsOpened });
      return;
    }

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

    if (a.kind === "player_swap") {
      // A person fills their side a click at a time: say what is off, never cancel for it.
      const r = this.judgePlayer(a, p.offer, false);
      if (!r.ok) {
        this.note("player-holding", { why: r.why });
        return;
      }
      const exact = this.judgePlayer(a, p.offer, true);
      this.note(exact.ok ? "player-matches" : "player-filling", exact.ok ? {} : { why: exact.why });
      return;
    }

    if (a.kind === "withdraw" || a.kind === "consolidate_give") {
      const back = a.kind === "consolidate_give" ? a.swapItems ?? [] : [];
      if (p.offer.some(Boolean)) {
        if (!(back.length && this.partnerOfferWithin(back, p.offer))) {
          this.log(`partner tried to add items in ${a.kind} — cancel`);
          this.cancel("partner added items");
        } else if (!this.partnerDetailWithin(a, p.offer)) {
          this.log("partner's items are not the meeting's (wrong enchantments) — cancel");
          this.cancel("partner's items differ from the meeting's");
        }
      }
      return;
    }
    if (a.kind === "consolidate_take") {
      // The one place a bot accepts first: the receiving side of a bot-to-bot
      // move gives nothing away, and someone has to break the tie.
      if (!this.partnerOfferMatches(a.items) || !this.partnerDetailMatches(a, this.partnerOffer)) {
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

  /**
   * consolidate_take: check our accept box (empty, or our side of a swap);
   * the giver mirrors it. The giver's side is judged again in the same
   * instant the accept goes out, every time (the first one after the delay
   * Realm needs, and each re-send): an accept never goes out on a window
   * that no longer holds exactly what the meeting promised.
   */
  private sendTakerAccept(): void {
    this.takerAcceptDue = null;
    const a = this.assignment;
    if (!a) return;
    if (!this.partnerOfferMatches(a.items) || !this.partnerDetailMatches(a, this.partnerOffer)) {
      this.log("the giver's offer no longer matches at the moment of accepting — not accepting");
      if (this.phase === "ACCEPTED") this.phase = "IN_TRADE";
      return;
    }
    if (!a.swapItems?.length) this.ourOffer = this.clientItems.map(() => false);
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
  /** The partner's offered items under `mask`, with their enchant records decoded; null on an unknown item. */
  private offeredDetail(mask: boolean[]): ItemDetail[] | null {
    const out: ItemDetail[] = [];
    for (let i = 0; i < this.partnerItems.length; i++) {
      if (!mask[i]) continue;
      const cid = toCatalogId(this.partnerItems[i].item);
      if (cid === undefined) return null;
      out.push({ itemId: cid, enchants: decodeEnchantRecord(this.partnerItems[i].enchantment) });
    }
    return out;
  }
  /** Our own offered items under `mask`, the same way. */
  private ourDetail(mask: boolean[]): ItemDetail[] {
    const out: ItemDetail[] = [];
    for (let i = 0; i < this.clientItems.length; i++) {
      if (!mask[i]) continue;
      const cid = toCatalogId(this.clientItems[i].item);
      if (cid === undefined) continue;
      out.push({ itemId: cid, enchants: decodeEnchantRecord(this.clientItems[i].enchantment) });
    }
    return out;
  }
  /** The partner's whole offer is exactly what the meeting promised, enchantments included (when the assignment carries them). */
  private partnerDetailMatches(a: Assignment, mask: boolean[]): boolean {
    if (!a.expectIncoming) return true;
    const offered = this.offeredDetail(mask);
    if (!offered) return false;
    const r = matchItemDetails(a.expectIncoming, offered, true);
    if (!r.ok) this.log(`partner's offer differs from the meeting's items: ${r.why}`);
    return r.ok;
  }
  /** Every item the partner has put up so far is one the meeting promised (a swap partner still filling its side). */
  private partnerDetailWithin(a: Assignment, mask: boolean[]): boolean {
    if (!a.expectIncoming) return true;
    const offered = this.offeredDetail(mask);
    if (!offered) return false;
    const r = matchItemDetails(a.expectIncoming, offered, false);
    if (!r.ok) this.log(`partner put up something the meeting did not promise: ${r.why}`);
    return r.ok;
  }

  /** A player's side of the window under `mask`, judged against the offer's want lines (the assignment's check). */
  private judgePlayer(a: Assignment, mask: boolean[], exact: boolean): { ok: true; offered: ItemDetail[] } | { ok: false; why: string } {
    const offered = this.offeredDetail(mask);
    if (!offered) return { ok: false, why: "one of your items is not one the bot knows; take it out" };
    if (!a.incomingCheck) return { ok: false, why: "the bot does not know what this trade asks for" };
    const r = a.incomingCheck(offered, exact);
    return r.ok ? { ok: true, offered } : r;
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

    if (a.kind === "player_swap") {
      if (!sameMask(p.clientOffer, this.ourOffer)) {
        this.log("accept-time client offer mismatch — cancel window");
        this.cancelWindow("the trade window changed on the bot's side; /trade again");
        return;
      }
      const r = this.judgePlayer(a, p.partnerOffer, true);
      if (!r.ok) {
        this.log(`player accepted, but their side does not fit: ${r.why} — holding`);
        this.note("player-holding", { why: r.why });
        return;
      }
      // Room after the trade: their free slots plus the slots their own items leave, against what the bot hands over.
      const room = partnerFreeSlots(this.partnerItems);
      const gives = this.ourOffer.filter(Boolean).length;
      if (room !== null && room + r.offered.length < gives) {
        const need = gives - r.offered.length;
        this.cancelWindow(`you need ${need} free inventory slot${need === 1 ? "" : "s"} and have ${room}; make room, then /trade again`);
        return;
      }
      this.client.send("ACCEPTTRADE", { clientOffer: [...this.ourOffer], partnerOffer: [...p.partnerOffer] });
      this.partnerOffer = [...p.partnerOffer];
      this.phase = "ACCEPTED";
      this.lastActionAt = Date.now();
      this.log("the player's side fits — accepted");
      this.note("player-accepted");
      return;
    }

    if (a.kind === "withdraw" || a.kind === "consolidate_give") {
      if (!sameMask(p.clientOffer, this.ourOffer)) {
        this.log("accept-time client offer mismatch — cancel");
        this.cancel("offer mismatch at accept");
        return;
      }
      const back = a.kind === "consolidate_give" ? a.swapItems ?? [] : [];
      if (back.length ? !this.partnerOfferMatches(back, p.partnerOffer) || !this.partnerDetailMatches(a, p.partnerOffer) : p.partnerOffer.some(Boolean)) {
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
    // What the bot won't take, by reason, so the player is told rather than
    // left looking at a window that never accepts.
    const refused: string[] = [];
    for (let i = 0; i < p.partnerOffer.length; i++) {
      if (!p.partnerOffer[i] || i >= this.partnerItems.length) continue;
      const ti = this.partnerItems[i];
      if (!isPoolItem(ti.item)) {
        if (a.acceptSkins && isSkinType(ti.item)) {
          offered++;
          continue;
        }
        this.log(isSkinType(ti.item) ? "partner offered a skin on a normal deposit — holding" : "partner offered non-pool item at accept — holding");
        refused.push(`${itemLabel(ti.item)} (not tradeable into the pool)`);
        continue;
      }
      if (this.opts.acceptsType && !this.opts.acceptsType(ti.item)) {
        this.log(`partner offered item ${ti.item}, which this node does not take — holding`);
        refused.push(`${itemLabel(ti.item)} (this node does not take it)`);
        continue;
      }
      const need = minEnchantsFor(ti.item);
      if (need && enchantCount(ti.enchantment) < need) {
        this.log(`partner offered item ${ti.item} below minimum rarity — holding`);
        refused.push(`${itemLabel(ti.item)} (needs ${need}+ enchantments)`);
        continue;
      }
      offered++;
    }
    if (refused.length) {
      this.tellPartner(`I can't take: ${refused.join(", ")}. Take ${refused.length === 1 ? "it" : "them"} off and accept again.`);
      return;
    }
    // Nothing offered: accepting would close an empty trade the site can't
    // record (a deposit is 1+ items), leaving the row claimed for nothing.
    if (offered === 0) {
      this.log("partner accepted an empty deposit — holding");
      this.tellPartner("Put the items you are depositing in the trade window, then accept.");
      return;
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
    if (a.kind === "player_swap") {
      // The echo of a window this side already closed changes nothing.
      if (this.phase !== "REQUESTED" && this.phase !== "IN_TRADE" && this.phase !== "ACCEPTED") return;
      if (p.code !== 0) {
        this.log(`TRADEDONE code=${p.code} desc=${p.description}`);
        this.windowFailed(p.description ? `the trade window closed: ${p.description}` : `the trade window closed (code ${p.code})`);
        return;
      }
      const partnerOffered = this.offeredDetail(this.partnerOffer) ?? [];
      const got = new Map<string, number>();
      for (const d of partnerOffered) got.set(d.itemId, (got.get(d.itemId) ?? 0) + 1);
      this.log(`TRADEDONE success kind=player_swap (window ${this.windowsOpened})`);
      this.note("player-traded");
      this.finish({
        ok: true, kind: "player_swap", gave: [...a.items], got: [...got].map(([itemId, qty]) => ({ itemId, qty })),
        ...(this.observedPartner ? { partnerName: this.observedPartner } : {}), ourOffered: this.ourDetail(this.ourOffer), partnerOffered,
      }, "DONE");
      return;
    }
    if (p.code !== 0) {
      this.log(`TRADEDONE code=${p.code} desc=${p.description}`);
      this.finish({ ok: false, error: p.description || `code ${p.code}` }, "FAILED");
      return;
    }
    let out: Outcome;
    if (a.kind === "consolidate_give" || a.kind === "consolidate_take") {
      out = {
        ok: true, kind: a.kind, consolidated: [...a.items], ...(a.swapItems?.length ? { swapItems: [...a.swapItems] } : {}),
        ...(this.observedPartner ? { partnerName: this.observedPartner } : {}),
        ourOffered: this.ourDetail(this.ourOffer), partnerOffered: this.offeredDetail(this.partnerOffer) ?? [],
      };
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
      const a = this.assignment;
      if (a && ((this.chunkResumeAt !== null && Date.now() >= this.chunkResumeAt) || (this.requestRetryAt !== null && Date.now() >= this.requestRetryAt))) this.request(a);
      return;
    }
    const now = Date.now();
    if (this.assignment?.kind === "player_swap") {
      const idle = now - this.lastActionAt;
      if (this.phase === "REQUESTED" && idle > REQUEST_TIMEOUT_MS) {
        // An invite nobody answered: wait for their /trade, or the next invite.
        this.opts.coordinator.release(this.partnerIgn, this.guid);
        this.phase = "IDLE";
      } else if ((this.phase === "IN_TRADE" || this.phase === "ACCEPTED") && idle > TRADE_TIMEOUT_MS) {
        this.log(`player window idle in ${this.phase} — cancelling it`);
        this.cancelWindow(`the trade window sat untouched for ${Math.floor(TRADE_TIMEOUT_MS / 1000)}s`);
      }
      return;
    }
    if (this.assignment?.kind === "consolidate_take") {
      if (this.phase === "IN_TRADE" && this.takerAcceptDue !== null && now >= this.takerAcceptDue) this.sendTakerAccept();
      else if (this.phase === "ACCEPTED" && this.takerAcceptAttempts < CONSOLIDATION_ACCEPT_ATTEMPTS && now - this.takerAcceptSentAt > CONSOLIDATION_REACCEPT_MS) this.sendTakerAccept();
    }
    const elapsed = now - this.lastActionAt;
    if (this.phase === "REQUESTED" && elapsed > REQUEST_TIMEOUT_MS) {
      const deadline = this.assignment?.meetingDeadlineAt ?? null;
      if (deadline !== null && now < deadline) {
        // A meeting: the partner's node may not have claimed its side yet.
        // Ask again in a while; the partner lock stays ours.
        this.log(`no trade window ${Math.floor(REQUEST_TIMEOUT_MS / 1000)}s after the request — asking again in ${Math.floor(REQUEST_RETRY_MS / 1000)}s (meeting deadline in ${Math.floor((deadline - now) / 1000)}s)`);
        this.phase = "IDLE";
        this.requestRetryAt = now + REQUEST_RETRY_MS;
        return;
      }
      this.giveUp(deadline !== null ? "partner never answered before the meeting deadline" : `no trade window ${Math.floor(REQUEST_TIMEOUT_MS / 1000)}s after the request`);
    } else if ((this.phase === "IN_TRADE" || this.phase === "ACCEPTED") && elapsed > TRADE_TIMEOUT_MS) {
      this.log(`trade timed out in ${this.phase} — cancelling`);
      this.cancel("trade timeout");
    }
  }
}

function mask(m: boolean[]): string {
  return m.map((v) => (v ? "1" : "0")).join("");
}

const sameSet = (a: number[], b: number[]): boolean => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
/** An expectation accepts an offered copy: same catalog id, and the enchant ids agree when both are known (null on the offered side = the record could not be read: only a plain or any-copy expectation takes it). */
export function detailFits(expected: ItemDetail, offered: ItemDetail): boolean {
  if (expected.itemId !== offered.itemId) return false;
  if (expected.enchants === null) return true;
  if (offered.enchants === null) return expected.enchants.length === 0;
  return sameSet(expected.enchants, offered.enchants);
}
/**
 * Match offered items against per-unit expectations, each expectation used
 * once, the most specific expectation first. `exact`: every expectation must
 * be met and nothing may be left over; otherwise the offered items only have
 * to be a subset (a side still being filled).
 */
export function matchItemDetails(expected: ItemDetail[], offered: ItemDetail[], exact: boolean): { ok: true } | { ok: false; why: string } {
  const pool = expected.map((e, i) => ({ e, i, specificity: e.enchants === null ? 0 : e.enchants.length + 1 }));
  const used = new Set<number>();
  for (const o of offered) {
    const cands = pool.filter((c) => !used.has(c.i) && detailFits(c.e, o)).sort((a, b) => b.specificity - a.specificity);
    if (!cands.length) return { ok: false, why: `${o.itemId} with ${o.enchants === null ? "unreadable enchantments" : o.enchants.length ? `enchantments ${o.enchants.join(",")}` : "no enchantments"} is not part of the meeting` };
    used.add(cands[0].i);
  }
  if (exact && used.size !== expected.length) {
    const missing = pool.find((c) => !used.has(c.i))!.e;
    return { ok: false, why: `${missing.itemId}${missing.enchants?.length ? ` with enchantments ${missing.enchants.join(",")}` : ""} is missing` };
  }
  return { ok: true };
}

function sameMask(a: boolean[], b: boolean[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A readable name for an object type in a whisper: its catalog id spelled out, else the type number. */
function itemLabel(objType: number): string {
  const id = toCatalogId(objType);
  return id ? id.replace(/^skin:/, "skin ").replace(/_/g, " ") : `item ${objType}`;
}
