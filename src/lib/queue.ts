// The request queue's transitions, in one place.
//
// Every way a deposit or withdraw row moves — claimed by a bot, fulfilled,
// handed back, cancelled, aged out — goes through a function here, inside
// one immediate transaction, and writes a row to request_events. The
// in-process fleet calls these directly (relay/fleet/localSiteApi.ts); there
// is no HTTP protocol, no signature, no nonce between them any more.
//
// Bot presence comes from lib/fleetPresence.ts, not a table.
import type Database from "better-sqlite3";
import type { WantLineWire } from "@/shared/hubWire";
import { ITEM_BY_ID } from "./catalog";
import { poolRoomForDeposits, SLOTS_PER_BOT } from "./capacity";
import { MAX_TRADE_SLOTS } from "./depositSizes";
import { presence, type PresenceBot } from "./fleetPresence";
import { emitRequest, emitTx } from "./liveBus";
import { sweepStaleRequests } from "./timeouts";
import { CONTINUING_DEPOSITORS, isPlayersNextTrade } from "./tradeQueue";
import { reservedInstanceIds } from "./reservations";
import { advancedForPool } from "./advanced";

export type Kind = "deposit" | "withdraw";
export type ItemQty = { itemId: string; qty: number };
export type Unit = { itemId: string; enchants: number };

/** One physical item with its enchant ids (null = unknown), as the hub describes a meeting's items and as a receipt reports what crossed. */
export type ItemDetailQty = { itemId: string; enchants: number[] | null; count: number };
/**
 * A cross-node swap on a withdraw row (design doc §6.2). `deadlineAt` is the
 * hub's meeting deadline: the fleet keeps trying until then, and a row still
 * open a while after it is failed here (expireSwapJobs) whatever happened
 * to the process meanwhile. `getsItems` carries the counterparty's
 * enchantments, so the trade window is checked item by item.
 */
export type SwapSpec = { rendezvousId: number; role: "give" | "take"; gets: ItemQty[]; getsItems?: ItemDetailQty[]; deadlineAt?: number; player?: { lines: WantLineWire[] } };
export type SwapResult = { ok: boolean; gave: ItemQty[]; gaveInstanceIds: string[]; got: ItemQty[]; gaveItems?: ItemDetailQty[]; gotItems?: ItemDetailQty[]; partnerIgn: string; error?: string; partnerAbsent?: boolean };
/** How long after its deadline an open swap row is failed by the queue itself (the fleet normally reports well before). */
export const SWAP_EXPIRE_GRACE_MS = Number(process.env.SWAP_EXPIRE_GRACE_SECONDS ?? 300) * 1000;

export type Assignment =
  | { kind: "deposit"; requestId: number; ign: string; server: string; itemCount: number; botIgn: string; communism: boolean }
  | { kind: "withdraw"; requestId: number; ign: string; server: string; items: ItemQty[]; instanceIds: string[] | null; keepInstanceIds?: string[]; botIgn: string; communism: boolean; swap?: SwapSpec | null };

/** A physical item a deposit received, as the fleet's tracker identifies it. */
export type ReceivedInstance = { instanceId: string; itemId: string; enchants: number };

/** A transition that can't happen. The message is part of the contract:
 *  the fleet stops retrying a fulfill on the terminal ones. */
export class QueueError extends Error {}

export function recordEvent(db: Database.Database, kind: Kind, requestId: number, event: string, botGuid: string | null, detail?: unknown): void {
  db.prepare("INSERT INTO request_events (kind, request_id, event, bot_guid, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(
    kind, requestId, event, botGuid, detail === undefined ? null : JSON.stringify(detail), Date.now(),
  );
}

function groupOf(db: Database.Database, kind: Kind, requestId: number): string | null {
  const table = kind === "deposit" ? "deposit_requests" : "withdraw_requests";
  const row = db.prepare(`SELECT group_id FROM ${table} WHERE id = ?`).get(requestId) as { group_id: string | null } | undefined;
  return row?.group_id ?? null;
}

/** Is this bot allowed to take work right now? */
function claimable(bot: PresenceBot | undefined, now: number): bot is PresenceBot {
  return !!bot && presence.isOnline(bot, now) && bot.status === "idle" && !!bot.server;
}

// --- claims ---------------------------------------------------------------------

/**
 * Claim a pending deposit for this bot. A deposit is one trade of the size
 * the player asked for (item_count), so only a bot with that many free
 * slots may take it, and a bot with room to spare takes the biggest request
 * it fits first — an empty backpack bot is the only kind that can serve a
 * 16-slot trade, and shouldn't be spent on an 8. `preferRequestId` asks for
 * one row in particular — the fleet sends a deposit whose declared items
 * match what this bot gathers — and falls back to the best fit when that
 * row is gone or too big.
 *
 * Under advanced management (the bot reports `emptyOnly`, docs/relay/
 * ADVANCED.md) only an empty character claims, pool or communism alike. It
 * takes a deposit it fits whole first (the biggest, then the oldest), else
 * the oldest bigger one: that trade fills the character and the rest
 * continues on the next empty one (fulfillDeposit).
 */
export function claimDeposit(db: Database.Database, botGuid: string, liveFreeSlots?: number, preferRequestId?: number | null): Assignment | null {
  const now = Date.now();
  const bot = presence.get(botGuid);
  if (!claimable(bot, now)) return null;
  const liveFree = liveFreeSlots ?? bot.freeSlots;
  if (liveFree < 1) return null;
  // A character holding anything is no intake for an advanced pool. Its trade
  // slots come with the same report; without them the smallest character is assumed.
  const emptyOnly = !!bot.emptyOnly;
  if (emptyOnly && liveFree < (bot.capacity ?? SLOTS_PER_BOT)) return null;
  let out: Assignment | null = null;
  let groupId: string | null = null;
  let cap = liveFree;
  db.transaction(() => {
    // A communism account takes only communism deposits, with whatever room it
    // has (it is one of the few bots that can come, so it takes the row
    // whatever size was asked); a pool bot takes only pool deposits it has
    // the room for. The site is where this is enforced — the fleet's
    // routing is an optimisation on top.
    const communism = !!bot.communism;
    const kindClause = emptyOnly ? `communism = ${communism ? 1 : 0}` : communism ? "communism = 1" : "communism = 0 AND item_count <= ?";
    const params: unknown[] = emptyOnly || communism ? [] : [liveFree];
    const order = emptyOnly
      ? "(item_count <= ?) DESC, CASE WHEN item_count <= ? THEN item_count END DESC, created_at ASC"
      : communism ? "created_at ASC" : "item_count DESC, created_at ASC";
    const orderParams: unknown[] = emptyOnly ? [liveFree, liveFree] : [];
    const where = `status = 'pending' AND server = ? AND seasonal = ? AND ${kindClause} AND ${isPlayersNextTrade("deposit_requests")}`;
    type Row = { id: number; ign: string; server: string; group_id: string | null; communism: number; item_count: number };
    let row: Row | undefined;
    if (preferRequestId != null) {
      row = db.prepare(`SELECT id, ign, server, group_id, communism, item_count FROM deposit_requests WHERE id = ? AND ${where}`).get(preferRequestId, bot.server, bot.seasonal ? 1 : 0, ...params) as Row | undefined;
    }
    row ??= db
      .prepare(`SELECT id, ign, server, group_id, communism, item_count FROM deposit_requests WHERE ${where} ORDER BY ${order} LIMIT 1`)
      .get(bot.server, bot.seasonal ? 1 : 0, ...params, ...orderParams) as Row | undefined;
    if (!row) return;
    cap = communism || emptyOnly ? Math.min(row.item_count, liveFree) : row.item_count;
    // A communism account short of the whole deposit takes what it has room
    // for, and the rest continues on the next character or account with room
    // (fulfillDeposit), as an advanced pool's empty characters do.
    const continues = emptyOnly || (communism && cap < row.item_count);
    const claimed = db
      .prepare(`UPDATE deposit_requests SET status = 'claimed', claimed_by = ?, current_cap = ?, continues = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(botGuid, cap, continues ? 1 : 0, now, row.id);
    if (claimed.changes !== 1) return;
    recordEvent(db, "deposit", row.id, "claimed", botGuid, continues ? { cap, continues: true } : { cap });
    groupId = row.group_id;
    out = { kind: "deposit", requestId: row.id, ign: row.ign, server: row.server, itemCount: cap, botIgn: bot.ign, communism: row.communism === 1 };
  }).immediate();
  if (out) {
    presence.setStatus(botGuid, "busy", now);
    console.log(`[queue] claim-deposit bot=${botGuid.slice(0, 8)} req=${(out as Assignment).requestId} cap=${cap}${(out as Assignment).communism ? " communism" : ""}`);
    emitRequest(groupId);
  }
  return out;
}

/**
 * Claim a pending withdraw this bot can hand over now. `heldItems` (advanced
 * management) maps each copy on the played character to its catalog id: a
 * by-type row then leaves alone only the picked copies actually there, not
 * those an account's other characters hold for its later rows. Without it,
 * every pick pinned to the bot counts against its copies, as before.
 */
export function claimWithdraw(db: Database.Database, botGuid: string, inventory: ItemQty[], heldInstances: string[], heldItems?: Record<string, string>): Assignment | null {
  const now = Date.now();
  const bot = presence.get(botGuid);
  if (!claimable(bot, now)) return null;
  const inv = new Map<string, number>();
  for (const it of inventory) if (ITEM_BY_ID.has(it.itemId) && Number.isInteger(it.qty) && it.qty > 0) inv.set(it.itemId, (inv.get(it.itemId) ?? 0) + it.qty);
  const held = new Set(heldInstances);
  let out: Assignment | null = null;
  let groupId: string | null = null;
  db.transaction(() => {
    // What else on this bot is spoken for: by-type rows leave those copies
    // alone, both in the count that lets them claim and in the bot's offer.
    const reservedHere = [...reservedInstanceIds(db, { openOffers: false })].filter((id) => held.has(id));
    const pickedHere = new Map<string, number>();
    for (const r of db
      .prepare("SELECT items_json, instance_ids_json FROM withdraw_requests WHERE status IN ('pending','claimed') AND instance_ids_json IS NOT NULL AND target_bot_guid = ?")
      .all(botGuid) as { items_json: string; instance_ids_json: string }[]) {
      try {
        if (heldItems) {
          for (const id of JSON.parse(r.instance_ids_json) as unknown[]) {
            const itemId = heldItems[String(id)];
            if (itemId) pickedHere.set(itemId, (pickedHere.get(itemId) ?? 0) + 1);
          }
        } else {
          for (const it of JSON.parse(r.items_json) as ItemQty[]) pickedHere.set(it.itemId, (pickedHere.get(it.itemId) ?? 0) + it.qty);
        }
      } catch {
        // a malformed row reserves nothing
      }
    }
    const candidates = db
      .prepare(
        `SELECT id, ign, server, items_json, target_bot_guid, instance_ids_json, group_id, communism, swap_json FROM withdraw_requests
         WHERE status = 'pending' AND server = ? AND seasonal = ?
           AND ${isPlayersNextTrade("withdraw_requests")}
         ORDER BY created_at ASC`,
      )
      // Every pending row of this server and side: a head-of-queue window
      // would hide a row this bot can serve behind ones it can't.
      .all(bot.server, bot.seasonal ? 1 : 0) as { id: number; ign: string; server: string; items_json: string; target_bot_guid: string | null; instance_ids_json: string | null; group_id: string | null; communism: number; swap_json: string | null }[];
    for (const cand of candidates) {
      let items: ItemQty[];
      try {
        items = JSON.parse(cand.items_json);
      } catch {
        continue;
      }
      let needed: string[] | null = null;
      // A swap row pinned to a bot (a receive-only side has no items to match on) is that bot's alone.
      if (cand.swap_json && cand.target_bot_guid && cand.target_bot_guid !== botGuid) continue;
      // A communism pick names its holder; a pool pick never comes off a communism account,
      // and a communism row by type (it names no holder to pin it) never off a pool bot.
      if (!cand.swap_json && cand.communism !== 1 && bot.communism) continue;
      if (!cand.swap_json && cand.communism === 1 && cand.instance_ids_json === null && !bot.communism) continue;
      if (cand.instance_ids_json !== null) {
        if (cand.target_bot_guid !== botGuid) continue;
        try {
          needed = JSON.parse(cand.instance_ids_json);
        } catch {
          continue;
        }
        if (!Array.isArray(needed) || !needed.every((id) => held.has(id))) continue;
      } else if (!items.every((i) => (inv.get(i.itemId) ?? 0) - (pickedHere.get(i.itemId) ?? 0) >= i.qty)) {
        continue;
      }
      const claimed = db
        .prepare(`UPDATE withdraw_requests SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(botGuid, now, cand.id);
      if (claimed.changes !== 1) continue;
      recordEvent(db, "withdraw", cand.id, "claimed", botGuid, { perInstance: needed !== null });
      groupId = cand.group_id;
      out = { kind: "withdraw", requestId: cand.id, ign: cand.ign, server: cand.server, items, instanceIds: needed, ...(needed === null && reservedHere.length ? { keepInstanceIds: reservedHere } : {}), botIgn: bot.ign, communism: cand.communism === 1, swap: parseSwap(cand.swap_json) };
      return;
    }
  }).immediate();
  if (out) {
    presence.setStatus(botGuid, "busy", now);
    console.log(`[queue] claim-withdraw bot=${botGuid.slice(0, 8)} req=${(out as Assignment).requestId}`);
    emitRequest(groupId);
  }
  return out;
}

// --- fulfils --------------------------------------------------------------------

export interface DepositResult {
  ign: string;
  server: string;
  count: number;
  /** Slots the deposit still has to bring: 0 unless it continues on the next empty character (advanced management). */
  remaining: number;
  /** True unless the deposit continues on another row. */
  terminal: boolean;
  /** No room for another deposit into this pool half (or communism) right now. */
  vaultFull: boolean;
  /** The row the rest of the deposit continues on (advanced management), when it does. */
  continuedAs?: number;
}

export function fulfillDeposit(db: Database.Database, botGuid: string, requestId: number, items: ItemQty[], units: Unit[] | null = null, instances: ReceivedInstance[] | null = null): DepositResult {
  // One line per item type: a full trade of all-different items is MAX_TRADE_SLOTS lines.
  if (!items.length || items.length > MAX_TRADE_SLOTS) throw new QueueError(`items must be 1-${MAX_TRADE_SLOTS} entries`);
  for (const it of items) {
    if (!ITEM_BY_ID.has(it.itemId)) throw new QueueError(`Unknown item: ${it.itemId}`);
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new QueueError("Item qty must be >= 1");
  }
  if (units) {
    const unitCounts = new Map<string, number>();
    for (const u of units) unitCounts.set(u.itemId, (unitCounts.get(u.itemId) ?? 0) + 1);
    const itemCounts = new Map<string, number>();
    for (const it of items) itemCounts.set(it.itemId, (itemCounts.get(it.itemId) ?? 0) + it.qty);
    if (unitCounts.size !== itemCounts.size || [...itemCounts].some(([id, n]) => unitCounts.get(id) !== n)) throw new QueueError("units do not reconcile with items");
  }
  let groupId: string | null = null;
  const out = db.transaction((): DepositResult => {
    const row = db
      .prepare("SELECT id, ign, ign_lower, server, item_count, remaining_count, current_cap, status, claimed_by, seasonal, group_id, communism, continues, items_json FROM deposit_requests WHERE id = ?")
      .get(requestId) as { id: number; ign: string; ign_lower: string; server: string; item_count: number; remaining_count: number | null; current_cap: number | null; status: string; claimed_by: string | null; seasonal: number; group_id: string | null; communism: number; continues: number; items_json: string | null } | undefined;
    if (!row) throw new QueueError("Request not found");
    if (row.status === "fulfilled") throw new QueueError("Already fulfilled");
    // Cancelled while this bot was mid-trade on it (the player's cancel, the
    // stale sweep): the items are on the bot all the same, so they are
    // credited and the row closes as fulfilled.
    if (row.status === "cancelled" && row.claimed_by !== botGuid) throw new QueueError("Request cancelled");
    if (row.claimed_by !== botGuid) throw new QueueError("This request was claimed by a different bot");
    // The fleet reports one entry per item type with a quantity; the slots
    // taken are about physical items, so count quantities. The trade window
    // is sized by the bot's free slots, which may exceed the size asked for
    // (a backpack bot serving an 8-slot trade): whatever crossed is on the
    // bot, so it is all credited. Only a count no bot could hold is refused.
    const got = items.reduce((a, i) => a + i.qty, 0);
    if (got > MAX_TRADE_SLOTS) throw new QueueError(`Trade reported ${got} items; a bot holds at most ${MAX_TRADE_SLOTS}`);
    groupId = row.group_id;
    const now = Date.now();
    const lines = units
      ? [...units.reduce((m, u) => {
          const k = `${u.itemId}:${u.enchants}`;
          const cur = m.get(k);
          if (cur) cur.qty++;
          else m.set(k, { itemId: u.itemId, qty: 1, enchants: u.enchants });
          return m;
        }, new Map<string, { itemId: string; qty: number; enchants: number }>()).values()]
      : items.map((it) => ({ itemId: it.itemId, qty: it.qty, enchants: 0 }));
    presence.tookSlots(botGuid, got);
    presence.setStatus(botGuid, "idle", now);
    // A deposit is one trade: it is done now, however much crossed. What is
    // still recorded is whether there would be room for another one —
    // `vaultFull` tells the player not to bother queueing again just yet.
    // The ledger has one row per item received, for pool and communism alike:
    // it is the history the site shows and what the deposit gate sums.
    const insert = db.prepare(`INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('deposit', ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) insert.run(row.ign, row.ign_lower, l.itemId, l.qty, l.enchants, row.server, requestId, now);
    const vaultFull = poolRoomForDeposits(db, row.seasonal ? 1 : 0, requestId, got, row.communism === 1) < 1;
    db.prepare(`UPDATE deposit_requests SET status = 'fulfilled', remaining_count = 0, current_cap = NULL, claimed_by = ?, end_reason = ?, updated_at = ? WHERE id = ?`)
      .run(botGuid, vaultFull ? "vault-full" : null, now, requestId);
    recordEvent(db, "deposit", requestId, "fulfilled", botGuid, { items, units, vaultFull });
    // Advanced management: an empty character took what it could hold of a
    // bigger deposit and was filled by it. The rest continues on the next
    // empty character as a new row of the same group, the player's next trade.
    // A communism account short of a whole deposit continues it the same way.
    // A trade the player under-filled ends the deposit as before, and so do a
    // pool with no room left for the rest and a deposit cancelled mid-trade.
    const rest = row.item_count - got;
    if (row.continues === 1 && row.status === "claimed" && row.current_cap !== null && got >= row.current_cap && rest > 0 && !vaultFull) {
      const res = db
        .prepare(
          `INSERT INTO deposit_requests (ign, ign_lower, server, item_count, remaining_count, status, group_id, seasonal, items_json, communism, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.ign, row.ign_lower, row.server, rest, rest, row.group_id, row.seasonal, hintLeft(row.items_json, items), row.communism, now, now);
      const next = Number(res.lastInsertRowid);
      recordEvent(db, "deposit", next, "continued", botGuid, { from: requestId, slots: rest });
      return { ign: row.ign, server: row.server, count: got, remaining: rest, terminal: false, vaultFull, continuedAs: next };
    }
    return { ign: row.ign, server: row.server, count: got, remaining: 0, terminal: true, vaultFull };
  }).immediate();
  console.log(`[queue] deposit-fulfill bot=${botGuid.slice(0, 8)} req=${requestId} got=${out.count} terminal=${out.terminal}${out.continuedAs ? ` (continues as #${out.continuedAs}, ${out.remaining} slot(s))` : ""}`);
  emitTx();
  emitRequest(groupId);
  if (out.continuedAs) notifyPendingChange();
  return out;
}

/** What a continuing deposit still says it brings: its hint less what the trade just received, or null. */
function hintLeft(itemsJson: string | null, received: ItemQty[]): string | null {
  if (!itemsJson) return null;
  try {
    const hint = JSON.parse(itemsJson) as ItemQty[];
    if (!Array.isArray(hint)) return null;
    const got = new Map<string, number>();
    for (const it of received) got.set(it.itemId, (got.get(it.itemId) ?? 0) + it.qty);
    const left: ItemQty[] = [];
    for (const h of hint) {
      if (!h || typeof h.itemId !== "string" || !Number.isInteger(h.qty)) continue;
      const take = Math.min(h.qty, got.get(h.itemId) ?? 0);
      got.set(h.itemId, (got.get(h.itemId) ?? 0) - take);
      if (h.qty - take > 0) left.push({ itemId: h.itemId, qty: h.qty - take });
    }
    return left.length ? JSON.stringify(left) : null;
  } catch {
    return null;
  }
}

/**
 * A bot reports what it handed over for a withdraw. The full set closes the
 * row. A strict subset (a chunked trade that broke off after some windows,
 * because the player's inventory only had room for part of it) records the
 * delivered items and puts the row back to `pending` with what is still
 * owed, so the next claim — usually the same bot — finishes it.
 */
export function fulfillWithdraw(db: Database.Database, botGuid: string, requestId: number, items: ItemQty[], deliveredInstances: string[] = []): { ign: string; server: string; count: number; partial: boolean; remaining: ItemQty[] } {
  // One line per item kind and enchant level: a full trade is at most MAX_TRADE_SLOTS lines.
  if (!items.length || items.length > MAX_TRADE_SLOTS) throw new QueueError(`items must be 1-${MAX_TRADE_SLOTS} entries`);
  for (const it of items) if (!ITEM_BY_ID.has(it.itemId)) throw new QueueError(`Unknown item: ${it.itemId}`);
  let groupId: string | null = null;
  const out = db.transaction(() => {
    const row = db
      .prepare("SELECT id, ign, ign_lower, server, items_json, instance_ids_json, status, claimed_by, group_id FROM withdraw_requests WHERE id = ?")
      .get(requestId) as { id: number; ign: string; ign_lower: string; server: string; items_json: string; instance_ids_json: string | null; status: string; claimed_by: string | null; group_id: string | null } | undefined;
    if (!row) throw new QueueError("Request not found");
    if (row.status === "fulfilled") throw new QueueError("Already fulfilled");
    // Cancelled (by the player, or the stale sweep) while this bot was mid-trade
    // on it: the items crossed anyway, so the ledger still records them. A
    // row the fleet itself gave up on has no claimant left and stays refused.
    const lateAfterCancel = row.status === "cancelled" && row.claimed_by === botGuid;
    if (row.status === "cancelled" && !lateAfterCancel) throw new QueueError("Request cancelled");
    if (row.claimed_by !== botGuid) throw new QueueError("This request was claimed by a different bot");
    groupId = row.group_id;
    const requested = JSON.parse(row.items_json) as (ItemQty & { enchants?: number })[];
    const want = new Map<string, number>();
    for (const r of requested) want.set(r.itemId, (want.get(r.itemId) ?? 0) + r.qty);
    const got = new Map<string, number>();
    for (const it of items) got.set(it.itemId, (got.get(it.itemId) ?? 0) + it.qty);
    for (const id of got.keys()) if (!want.has(id)) throw new QueueError("Reported item shape doesn't match request");
    for (const [id, qty] of got) if (qty > (want.get(id) ?? 0) || qty <= 0) throw new QueueError(`Item mismatch on ${id}`);
    const full = got.size === want.size && [...want].every(([id, qty]) => got.get(id) === qty);
    let remainingInstances: string[] | null = null;
    if (row.instance_ids_json !== null) {
      const expected = new Set(JSON.parse(row.instance_ids_json) as string[]);
      if (!deliveredInstances.length) throw new QueueError("Per-instance withdraw requires instanceIds in fulfill body");
      const delivered = new Set(deliveredInstances);
      if (!deliveredInstances.every((id) => expected.has(id)) || (full && delivered.size !== expected.size)) throw new QueueError("Delivered instance UUIDs don't match the picked set");
      remainingInstances = [...expected].filter((id) => !delivered.has(id));
      if (!full && !remainingInstances.length) throw new QueueError("Partial item report but every picked instance delivered");
    }
    const now = Date.now();
    const split = splitDelivered(requested, got);
    {
      const insert = db.prepare(`INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('withdraw', ?, ?, ?, ?, ?, ?, ?, ?)`);
      // Each entry is credited with its own enchant count: two entries may
      // share an item at different enchant levels.
      for (const it of split.delivered) insert.run(row.ign, row.ign_lower, it.itemId, it.qty, it.enchants ?? 0, row.server, requestId, now);
    }
    let remaining: ItemQty[] = split.remaining;
    if (full) {
      db.prepare("UPDATE withdraw_requests SET status = 'fulfilled', updated_at = ? WHERE id = ?").run(now, requestId);
      recordEvent(db, "withdraw", requestId, "fulfilled", botGuid, { items, instanceIds: deliveredInstances, ...(lateAfterCancel ? { afterCancel: true } : {}) });
    } else if (lateAfterCancel) {
      // Part crossed before the cancel landed: recorded, and the rest stays cancelled.
      db.prepare("UPDATE withdraw_requests SET claimed_by = NULL, updated_at = ? WHERE id = ?").run(now, requestId);
      recordEvent(db, "withdraw", requestId, "partial", botGuid, { items, instanceIds: deliveredInstances, afterCancel: true });
    } else {
      // The remainder starts a fresh pending clock: it is new work for the
      // player, and an old created_at would let the pending sweep cancel it
      // on the next pass.
      db.prepare("UPDATE withdraw_requests SET items_json = ?, instance_ids_json = ?, status = 'pending', claimed_by = NULL, created_at = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(remaining), remainingInstances ? JSON.stringify(remainingInstances) : null, now, now, requestId);
      recordEvent(db, "withdraw", requestId, "partial", botGuid, { items, instanceIds: deliveredInstances, remaining, remainingInstances });
    }
    presence.setStatus(botGuid, "idle", now);
    return { ign: row.ign, server: row.server, count: items.length, partial: !full, remaining };
  }).immediate();
  console.log(`[queue] withdraw-fulfill bot=${botGuid.slice(0, 8)} req=${requestId} items=${out.count}${out.partial ? ` (partial, ${out.remaining.length} line(s) re-queued)` : ""}`);
  emitTx();
  emitRequest(groupId);
  if (out.partial) notifyPendingChange();
  return out;
}

/**
 * Split a withdraw's entries into what crossed and what is still owed, given
 * the delivered count per item. Entries sharing an item (different enchant
 * levels) are drawn down in order, so the counts carry across them instead of
 * the delivered count being taken off every entry of that item.
 */
export function splitDelivered<T extends ItemQty & { enchants?: number }>(requested: T[], got: Map<string, number>): { delivered: T[]; remaining: T[] } {
  const left = new Map(got);
  const delivered: T[] = [];
  const remaining: T[] = [];
  for (const r of requested) {
    const take = Math.min(r.qty, left.get(r.itemId) ?? 0);
    if (take > 0) {
      delivered.push({ ...r, qty: take });
      left.set(r.itemId, (left.get(r.itemId) ?? 0) - take);
    }
    if (r.qty - take > 0) remaining.push({ ...r, qty: r.qty - take });
  }
  return { delivered, remaining };
}

// --- releases ----------------------------------------------------------------------

/** Hand a claimed row back to 'pending' so another bot can take it. */
export function unclaim(db: Database.Database, botGuid: string, requestId: number, kind: Kind): boolean {
  const table = kind === "withdraw" ? "withdraw_requests" : "deposit_requests";
  const now = Date.now();
  const changed = db.transaction(() => {
    const n = db.prepare(`UPDATE ${table} SET status = 'pending', claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`).run(now, requestId, botGuid).changes;
    if (n) recordEvent(db, kind, requestId, "unclaimed", botGuid);
    return n > 0;
  }).immediate();
  if (changed) {
    presence.setStatus(botGuid, "idle", now);
    emitRequest(groupOf(db, kind, requestId));
    notifyPendingChange();
  }
  return changed;
}

/**
 * Cancel a row the fleet cannot serve, saying why (its bot met the server's
 * login queue, no account on the node can take it), so the player is told
 * rather than left waiting. Only a pending row, or one `botGuid` itself has
 * claimed: never one another bot is trading on, and never a swap row, which
 * lives by its meeting's deadline. A deposit keeps the reason as its
 * end_reason, which the player's page shows.
 */
export function cancelRequest(db: Database.Database, botGuid: string | null, requestId: number, kind: Kind, why: string): boolean {
  const table = kind === "withdraw" ? "withdraw_requests" : "deposit_requests";
  const now = Date.now();
  const out = db.transaction((): { changed: boolean; claimedBy: string | null } => {
    const row = db.prepare(`SELECT status, claimed_by${kind === "withdraw" ? ", swap_json" : ""} FROM ${table} WHERE id = ?`).get(requestId) as { status: string; claimed_by: string | null; swap_json?: string | null } | undefined;
    if (!row || row.swap_json) return { changed: false, claimedBy: null };
    const mine = row.status === "claimed" && botGuid !== null && row.claimed_by === botGuid;
    if (row.status !== "pending" && !mine) return { changed: false, claimedBy: null };
    if (kind === "deposit") db.prepare("UPDATE deposit_requests SET status = 'cancelled', claimed_by = NULL, end_reason = ?, updated_at = ? WHERE id = ?").run(why, now, requestId);
    else db.prepare("UPDATE withdraw_requests SET status = 'cancelled', claimed_by = NULL, end_reason = ?, updated_at = ? WHERE id = ?").run(why, now, requestId);
    recordEvent(db, kind, requestId, "cancelled", botGuid, { why });
    return { changed: true, claimedBy: mine ? botGuid : null };
  }).immediate();
  if (out.changed) {
    if (out.claimedBy) presence.setStatus(out.claimedBy, "idle", now);
    console.log(`[queue] ${kind} #${requestId} cancelled: ${why}`);
    emitRequest(groupOf(db, kind, requestId));
  }
  return out.changed;
}

/** Cancel a claimed row for good (absent partner). */
export function giveUp(db: Database.Database, botGuid: string, requestId: number, kind: Kind, why = "partner absent"): boolean {
  const table = kind === "withdraw" ? "withdraw_requests" : "deposit_requests";
  const now = Date.now();
  const changed = db.transaction(() => {
    const n = db.prepare(`UPDATE ${table} SET status = 'cancelled', claimed_by = NULL, end_reason = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`).run(why, now, requestId, botGuid).changes;
    if (n) recordEvent(db, kind, requestId, "cancelled", botGuid, { why });
    return n > 0;
  }).immediate();
  if (changed) {
    presence.setStatus(botGuid, "idle", now);
    emitRequest(groupOf(db, kind, requestId));
  }
  return changed;
}

// --- reads -------------------------------------------------------------------------

function parseSwap(raw: string | null): SwapSpec | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as SwapSpec;
    if (!j || (j.role !== "give" && j.role !== "take") || !Array.isArray(j.gets)) return null;
    const out: SwapSpec = { rendezvousId: Number(j.rendezvousId), role: j.role, gets: j.gets };
    if (Array.isArray(j.getsItems)) out.getsItems = j.getsItems;
    if (typeof j.deadlineAt === "number" && Number.isFinite(j.deadlineAt)) out.deadlineAt = j.deadlineAt;
    if (j.player && Array.isArray(j.player.lines)) out.player = { lines: j.player.lines };
    return out;
  } catch {
    return null;
  }
}

/**
 * Queue one side of a cross-node swap. `give` and `giveInstanceIds` are
 * what this node's bot (`botGuid`, the holder) hands over on `server` to
 * the partner bot `partnerIgn`; `swap.gets` is what it must receive in the
 * same window. The dispatcher routes it like a per-instance withdraw.
 */
export function createSwapJob(db: Database.Database, job: { server: string; botGuid: string; partnerIgn: string; seasonal: boolean; give: ItemQty[]; giveInstanceIds: string[]; swap: SwapSpec }): number {
  // A communism hand-over's receiving side gives nothing: an empty-items row
  // pinned to the receiving bot, which only waits and accepts.
  const receiveOnly = !job.give.length && job.swap.role === "take" && job.swap.gets.length > 0;
  if (!receiveOnly && (!job.give.length || !job.giveInstanceIds.length)) throw new QueueError("a swap side must give at least one item");
  if (!job.partnerIgn) throw new QueueError("partner IGN required");
  const now = Date.now();
  const r = db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, target_bot_guid, instance_ids_json, seasonal, created_at, updated_at, swap_json)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
    .run(job.partnerIgn, job.partnerIgn.toLowerCase(), job.server, JSON.stringify(job.give), job.botGuid, receiveOnly ? null : JSON.stringify(job.giveInstanceIds), job.seasonal ? 1 : 0, now, now, JSON.stringify(job.swap));
  const id = Number(r.lastInsertRowid);
  recordEvent(db, "withdraw", id, "swap-queued", job.botGuid, { rendezvousId: job.swap.rendezvousId, role: job.swap.role });
  notifyPendingChange();
  return id;
}

/** A swap row as the coordinator reads it back. */
export interface SwapJobRow {
  id: number;
  status: string;
  updatedAt: number;
  targetBotGuid: string | null;
  claimedBy: string | null;
  instanceIds: string[];
  spec: SwapSpec;
}
function swapRows(db: Database.Database): SwapJobRow[] {
  const rows = db.prepare("SELECT id, status, updated_at, target_bot_guid, claimed_by, instance_ids_json, swap_json FROM withdraw_requests WHERE swap_json IS NOT NULL").all() as { id: number; status: string; updated_at: number; target_bot_guid: string | null; claimed_by: string | null; instance_ids_json: string | null; swap_json: string }[];
  const out: SwapJobRow[] = [];
  for (const r of rows) {
    const spec = parseSwap(r.swap_json);
    if (!spec) continue;
    let ids: string[] = [];
    try {
      const j = r.instance_ids_json === null ? [] : JSON.parse(r.instance_ids_json);
      if (Array.isArray(j)) ids = j.map(String);
    } catch { /* malformed: treated as none */ }
    out.push({ id: r.id, status: r.status, updatedAt: r.updated_at, targetBotGuid: r.target_bot_guid, claimedBy: r.claimed_by, instanceIds: ids, spec });
  }
  return out;
}
/** Swap rows for `rendezvousId` in any state (normally one). */
export function swapJobsFor(db: Database.Database, rendezvousId: number): SwapJobRow[] {
  return swapRows(db).filter((r) => r.spec.rendezvousId === rendezvousId);
}
/** Every swap row still open (pending or claimed). */
export function openSwapJobs(db: Database.Database): SwapJobRow[] {
  return swapRows(db).filter((r) => r.status === "pending" || r.status === "claimed");
}

/** Whether a bot ever claimed this withdraw row. A claim needs the items in hand, so a row never claimed cannot have traded. */
export function wasClaimed(db: Database.Database, requestId: number): boolean {
  return !!db.prepare("SELECT 1 FROM request_events WHERE kind = 'withdraw' AND request_id = ? AND event = 'claimed' LIMIT 1").get(requestId);
}

/** Whether a swap row is still open (pending or claimed): the fleet lets go of a meeting whose row was cancelled under it. */
export function swapRowOpen(db: Database.Database, requestId: number): boolean {
  return swapRowState(db, requestId).open;
}
/** A swap row's open state and its meeting's current deadline (the hub may have extended it since a bot claimed the row). */
export function swapRowState(db: Database.Database, requestId: number): { open: boolean; deadlineAt: number | null } {
  const row = db.prepare("SELECT status, swap_json FROM withdraw_requests WHERE id = ? AND swap_json IS NOT NULL").get(requestId) as { status: string; swap_json: string } | undefined;
  if (!row) return { open: false, deadlineAt: null };
  return { open: row.status === "pending" || row.status === "claimed", deadlineAt: parseSwap(row.swap_json)?.deadlineAt ?? null };
}

const pendingListeners = new Set<() => void>();
/** The fleet hears that a pending row appeared (a new request, a continuation, a re-opened remainder): it claims at once rather than at its next poll. */
export function onPendingChange(fn: () => void): () => void {
  pendingListeners.add(fn);
  return () => pendingListeners.delete(fn);
}
/** Tell the listeners a pending row appeared. Called after the insert has committed; never throws. */
export function notifyPendingChange(): void {
  for (const fn of pendingListeners) {
    try {
      fn();
    } catch (e) {
      console.error("[queue] pending listener raised:", e);
    }
  }
}

type SwapNoteListener = (requestId: number, event: string, botGuid: string | null, detail: unknown) => void;
const swapNoteListeners = new Set<SwapNoteListener>();
/** The swap coordinator hears the fleet's notes on swap rows (a player meeting passes them on to the person waiting). */
export function onSwapNote(fn: SwapNoteListener): () => void {
  swapNoteListeners.add(fn);
  return () => swapNoteListeners.delete(fn);
}
/** A note on a swap row's timeline: recorded in request_events, then handed to the listeners. */
export function noteSwap(db: Database.Database, requestId: number, event: string, botGuid: string | null, detail?: unknown): void {
  recordEvent(db, "withdraw", requestId, event, botGuid, detail);
  for (const fn of swapNoteListeners) {
    try {
      fn(requestId, event, botGuid, detail);
    } catch (e) {
      console.error("[queue] swap note listener raised:", e);
    }
  }
}

export function cancelSwapJob(db: Database.Database, requestId: number, why: string): boolean {
  const r = db.prepare("UPDATE withdraw_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND swap_json IS NOT NULL AND status IN ('pending','claimed')").run(Date.now(), requestId);
  if (r.changes) recordEvent(db, "withdraw", requestId, "swap-cancelled", null, { why });
  return r.changes > 0;
}

/**
 * Swap rows still open well past their meeting deadline are failed here, and
 * the listeners hear a failure so a receipt goes out: the fleet normally
 * reports long before, but a process that was down over the deadline, or a
 * bot that never came back, must not leave the hub waiting on nothing. Rows
 * whose spec carries no deadline (an older node's) are left to the sweeps.
 */
export function expireSwapJobs(db: Database.Database, now = Date.now()): number {
  let n = 0;
  for (const row of openSwapJobs(db)) {
    const deadline = row.spec.deadlineAt;
    if (deadline === undefined || now < deadline + SWAP_EXPIRE_GRACE_MS) continue;
    try {
      reportSwap(db, row.claimedBy ?? row.targetBotGuid ?? "", row.id, { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: "", error: `the meeting deadline passed ${Math.floor((now - deadline) / 60_000)} min ago with the row still open on this node` }, now);
      n++;
    } catch (e) {
      console.log(`[queue] swap #${row.id} could not be expired: ${String((e as Error).message ?? e)}`);
    }
  }
  return n;
}

/**
 * At startup: a swap row a bot had claimed belongs to nobody now (the
 * process that assigned it is gone). Back to pending, so the fleet claims
 * it again if the items are still there, and the coordinator's outcome check
 * (a fresh look at the bot's inventory) settles it if they are not.
 */
export function orphanClaimedSwapJobs(db: Database.Database, now = Date.now()): number {
  let n = 0;
  db.transaction(() => {
    for (const row of openSwapJobs(db)) {
      if (row.status !== "claimed") continue;
      if (db.prepare("UPDATE withdraw_requests SET status = 'pending', claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'").run(now, row.id).changes) {
        recordEvent(db, "withdraw", row.id, "swap-orphaned", row.claimedBy, { why: "claimed by a bot of a process that is gone" });
        n++;
      }
    }
  }).immediate();
  if (n) notifyPendingChange();
  return n;
}

type SwapListener = (requestId: number, swap: SwapSpec, result: SwapResult) => void;
const swapListeners = new Set<SwapListener>();
/** The swap coordinator (src/node/swaps.ts) hears every swap outcome here. */
export function onSwapResult(fn: SwapListener): () => void {
  swapListeners.add(fn);
  return () => swapListeners.delete(fn);
}

/**
 * The fleet's report for a swap row: closes it either way and tells the
 * listeners. No ledger. A success on a row that was cancelled meanwhile (the
 * meeting was called off while its window was already open) is still
 * recorded: the items moved, so a receipt has to go out and the hub decides.
 */
export function reportSwap(db: Database.Database, botGuid: string, requestId: number, result: SwapResult, now = Date.now()): { swap: SwapSpec } {
  const swap = db.transaction(() => {
    const row = db.prepare("SELECT status, claimed_by, swap_json FROM withdraw_requests WHERE id = ?").get(requestId) as { status: string; claimed_by: string | null; swap_json: string | null } | undefined;
    if (!row || !row.swap_json) throw new QueueError("Not a swap row");
    const spec = parseSwap(row.swap_json);
    if (!spec) throw new QueueError("Bad swap spec");
    const late = row.status === "cancelled" && result.ok;
    if (!late && (row.status === "fulfilled" || row.status === "failed" || row.status === "cancelled")) throw new QueueError("Already closed");
    if (row.claimed_by && row.claimed_by !== botGuid) throw new QueueError("This request was claimed by a different bot");
    db.prepare("UPDATE withdraw_requests SET status = ?, updated_at = ? WHERE id = ?").run(result.ok ? "fulfilled" : "failed", now, requestId);
    recordEvent(db, "withdraw", requestId, late ? "swap-done-late" : result.ok ? "swap-done" : "swap-failed", botGuid, result);
    return spec;
  }).immediate();
  if (botGuid) presence.setStatus(botGuid, "idle", now);
  console.log(`[queue] swap #${requestId} ${result.ok ? "done" : `failed: ${result.error ?? "?"}`}`);
  for (const fn of swapListeners) {
    try {
      fn(requestId, swap, result);
    } catch (e) {
      console.error("[queue] swap listener raised:", e);
    }
  }
  return { swap };
}

export interface PendingWithdraw {
  id: number;
  server: string;
  items: ItemQty[];
  targetBotGuid: string | null;
  instanceIds: string[] | null;
  seasonal: boolean;
  /** Into or out of communism rather than the pool. */
  /** A communism pick: comes off a communism account. */
  communism: boolean;
  swap?: SwapSpec | null;
  /** Advanced management: the player's next row after the one served now; not claimable yet (listed for waking and fetching ahead). */
  upcoming?: boolean;
  /** On an upcoming row: the player's row before it is claimed (a bot is trading it now), not still pending. */
  headClaimed?: boolean;
}
export interface PendingDeposit {
  id: number;
  server: string;
  /** The one trade's size: the bot must have this many free slots. */
  itemCount: number;
  /** The same number; the old declared upper bound, kept for the wire shape. */
  declaredCount: number;
  seasonal: boolean;
  /** What the player said they are bringing, when they said. */
  items?: ItemQty[];
  /** Into communism: only a communism account of this pool half may claim it. */
  communism: boolean;
}

type PendingWithdrawRow = { id: number; ign_lower?: string; server: string; items_json: string; target_bot_guid: string | null; instance_ids_json: string | null; seasonal: number; communism: number; swap_json: string | null };
function pendingWithdrawOf(w: PendingWithdrawRow): PendingWithdraw {
  let items: ItemQty[] = [];
  let instanceIds: string[] | null = null;
  try {
    const j = JSON.parse(w.items_json);
    if (Array.isArray(j)) items = j;
  } catch { /* skip */ }
  if (w.instance_ids_json !== null) {
    try {
      const j = JSON.parse(w.instance_ids_json);
      if (Array.isArray(j)) instanceIds = j.filter((x): x is string => typeof x === "string");
    } catch { /* aggregate */ }
  }
  return { id: w.id, server: w.server, items, targetBotGuid: w.target_bot_guid, instanceIds, seasonal: w.seasonal !== 0, communism: w.communism === 1, swap: parseSwap(w.swap_json) };
}

/**
 * Advanced management (docs/relay/ADVANCED.md): each player's withdraw that
 * comes after the one being served now — the first pending row of a player
 * mid-trade, else the second — for the pools whose switch is on. The fleet
 * wakes its bot or fetches its items in time for its turn; it is claimed
 * only once it is the player's next trade, like any row. Swap rows live by
 * their meetings and are never listed ahead.
 */
function upcomingWithdraws(db: Database.Database, adv: { pool: boolean; communism: boolean }): PendingWithdraw[] {
  const busy = new Set(
    (db.prepare("SELECT ign_lower FROM withdraw_requests WHERE status = 'claimed' UNION SELECT ign_lower FROM deposit_requests WHERE status = 'claimed'").all() as { ign_lower: string }[]).map((r) => r.ign_lower),
  );
  // A player whose deposit continues on the next bot is served that first (lib/tradeQueue.ts): their first withdraw is the one coming up.
  const continuing = new Set((db.prepare(CONTINUING_DEPOSITORS).all() as { ign_lower: string }[]).map((r) => r.ign_lower));
  const rows = db
    .prepare("SELECT id, ign_lower, server, items_json, target_bot_guid, instance_ids_json, seasonal, communism, swap_json FROM withdraw_requests WHERE status = 'pending' ORDER BY id")
    .all() as (PendingWithdrawRow & { ign_lower: string })[];
  const passed = new Map<string, number>();
  const out: PendingWithdraw[] = [];
  for (const r of rows) {
    const n = passed.get(r.ign_lower) ?? 0;
    passed.set(r.ign_lower, n + 1);
    if (n !== (busy.has(r.ign_lower) || continuing.has(r.ign_lower) ? 0 : 1) || r.swap_json) continue;
    if (!(r.communism === 1 ? adv.communism : adv.pool)) continue;
    out.push({ ...pendingWithdrawOf(r), upcoming: true, headClaimed: busy.has(r.ign_lower) });
  }
  return out;
}

/**
 * The rows a bot could act on right now (one per player, oldest first).
 * Under advanced management each player's row after that one follows,
 * flagged `upcoming` (upcomingWithdraws).
 */
export function listPending(db: Database.Database): { withdraws: PendingWithdraw[]; deposits: PendingDeposit[] } {
  sweepStaleRequests(db);
  expireSwapJobs(db);
  const withdraws = (db
    .prepare(`SELECT id, server, items_json, target_bot_guid, instance_ids_json, seasonal, communism, swap_json FROM withdraw_requests WHERE status = 'pending' AND ${isPlayersNextTrade("withdraw_requests")} ORDER BY created_at ASC`)
    .all() as PendingWithdrawRow[])
    .map(pendingWithdrawOf);
  const adv = { pool: advancedForPool(false), communism: advancedForPool(true) };
  if (adv.pool || adv.communism) withdraws.push(...upcomingWithdraws(db, adv));
  const deposits = (db
    .prepare(`SELECT id, server, item_count, seasonal, items_json, communism
              FROM deposit_requests
              WHERE status = 'pending' AND ${isPlayersNextTrade("deposit_requests")} ORDER BY created_at ASC`)
    .all() as { id: number; server: string; item_count: number; seasonal: number; items_json: string | null; communism: number }[])
    .map((d) => {
      // itemCount is the trade size: the bot that comes must have that many
      // free slots. declaredCount is the same number, kept for the wire.
      const out: PendingDeposit = { id: d.id, server: d.server, itemCount: d.item_count, declaredCount: d.item_count, seasonal: d.seasonal !== 0, communism: d.communism === 1 };
      if (d.items_json) {
        try {
          const j = JSON.parse(d.items_json);
          if (Array.isArray(j)) out.items = j.filter((x): x is ItemQty => !!x && typeof x.itemId === "string" && Number.isInteger(x.qty) && x.qty > 0);
        } catch { /* no hint */ }
      }
      return out;
    });
  return { withdraws, deposits };
}

/** Event history for one request, oldest first. */
export function eventsFor(db: Database.Database, kind: Kind, requestId: number): { event: string; botGuid: string | null; detail: unknown; at: number }[] {
  return (db.prepare("SELECT event, bot_guid, detail, at FROM request_events WHERE kind = ? AND request_id = ? ORDER BY id").all(kind, requestId) as { event: string; bot_guid: string | null; detail: string | null; at: number }[])
    .map((r) => ({ event: r.event, botGuid: r.bot_guid, detail: r.detail ? JSON.parse(r.detail) : null, at: r.at }));
}
