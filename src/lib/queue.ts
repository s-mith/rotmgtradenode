// The request queue's transitions, in one place.
//
// Every way a deposit or withdraw row moves — claimed by a bot, fulfilled,
// handed back, cancelled, aged out — goes through a function here, inside
// one immediate transaction, and writes a row to request_events. The
// in-process fleet calls these directly (relay/fleet/localSiteApi.ts); there
// is no HTTP protocol, no signature, no nonce between them any more.
//
// Bot presence comes from lib/fleetPresence.ts, not a table.
import { sharedVaultBots } from "./vault";
import type Database from "better-sqlite3";
import { ITEM_BY_ID } from "./catalog";
import { poolRoomForDeposits } from "./capacity";
import { MAX_TRADE_SLOTS } from "./depositSizes";
import { presence, type PresenceBot } from "./fleetPresence";
import { emitRequest, emitTx } from "./liveBus";
import { sweepStaleRequests } from "./timeouts";
import { isPlayersNextTrade } from "./tradeQueue";
import { releaseVaultBotIfEmpty, vaultCount, vaultHalf, vaultHalfOfBot } from "./vault";

export type Kind = "deposit" | "withdraw";
export type ItemQty = { itemId: string; qty: number };
export type Unit = { itemId: string; enchants: number };

/** A cross-node swap on a withdraw row (design doc §6.2). */
export type SwapSpec = { rendezvousId: number; role: "give" | "take"; gets: ItemQty[]; /** Phase 4b: the guest whose vault the items belong to (and receive into). */ vaultUserId?: number | null };
export type SwapResult = { ok: boolean; gave: ItemQty[]; gaveInstanceIds: string[]; got: ItemQty[]; partnerIgn: string; error?: string; partnerAbsent?: boolean };

export type Assignment =
  | { kind: "deposit"; requestId: number; ign: string; server: string; itemCount: number; botIgn: string; vault: number | null }
  | { kind: "withdraw"; requestId: number; ign: string; server: string; items: ItemQty[]; instanceIds: string[] | null; botIgn: string; vault: number | null; swap?: SwapSpec | null };

/** A physical item a vault deposit received, as the fleet's tracker identifies it. */
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
 */
export function claimDeposit(db: Database.Database, botGuid: string, liveFreeSlots?: number, preferRequestId?: number | null): Assignment | null {
  const now = Date.now();
  const bot = presence.get(botGuid);
  if (!claimable(bot, now)) return null;
  const liveFree = liveFreeSlots ?? bot.freeSlots;
  if (liveFree < 1) return null;
  let out: Assignment | null = null;
  let groupId: string | null = null;
  let cap = liveFree;
  db.transaction(() => {
    // A bot dedicated to somebody's personal storage takes only that
    // account's vault deposits, capped at the slots the account has left
    // and at its own free slots (it is the only bot that can come, so it
    // takes the row whatever size was asked); every other bot takes only
    // pool deposits it has the room for. The site is where this is
    // enforced — the fleet's routing is an optimisation on top.
    const half = vaultHalfOfBot(db, botGuid);
    let vaultClause = "vault_user_id IS NULL AND item_count <= ?";
    let params: unknown[] = [liveFree];
    let order = "item_count DESC, created_at ASC";
    let left = 0;
    if (half) {
      left = half.slots - vaultCount(db, half.userId, half.seasonal);
      if (left < 1) return;
      vaultClause = "vault_user_id = ?";
      params = [half.userId];
      order = "created_at ASC";
    }
    const where = `status = 'pending' AND server = ? AND seasonal = ? AND ${vaultClause} AND ${isPlayersNextTrade("deposit_requests")}`;
    type Row = { id: number; ign: string; server: string; group_id: string | null; vault_user_id: number | null; item_count: number };
    let row: Row | undefined;
    if (preferRequestId != null) {
      row = db.prepare(`SELECT id, ign, server, group_id, vault_user_id, item_count FROM deposit_requests WHERE id = ? AND ${where}`).get(preferRequestId, bot.server, bot.seasonal ? 1 : 0, ...params) as Row | undefined;
    }
    row ??= db
      .prepare(`SELECT id, ign, server, group_id, vault_user_id, item_count FROM deposit_requests WHERE ${where} ORDER BY ${order} LIMIT 1`)
      .get(bot.server, bot.seasonal ? 1 : 0, ...params) as Row | undefined;
    if (!row) return;
    cap = half ? Math.min(row.item_count, liveFree, left) : row.item_count;
    const claimed = db
      .prepare(`UPDATE deposit_requests SET status = 'claimed', claimed_by = ?, current_cap = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(botGuid, cap, now, row.id);
    if (claimed.changes !== 1) return;
    recordEvent(db, "deposit", row.id, "claimed", botGuid, { cap });
    groupId = row.group_id;
    out = { kind: "deposit", requestId: row.id, ign: row.ign, server: row.server, itemCount: cap, botIgn: bot.ign, vault: row.vault_user_id };
  }).immediate();
  if (out) {
    presence.setStatus(botGuid, "busy", now);
    console.log(`[queue] claim-deposit bot=${botGuid.slice(0, 8)} req=${(out as Assignment).requestId} cap=${cap}${(out as Assignment).vault !== null ? ` vault=${(out as Assignment).vault}` : ""}`);
    emitRequest(groupId);
  }
  return out;
}

export function claimWithdraw(db: Database.Database, botGuid: string, inventory: ItemQty[], heldInstances: string[]): Assignment | null {
  const now = Date.now();
  const bot = presence.get(botGuid);
  if (!claimable(bot, now)) return null;
  const inv = new Map<string, number>();
  for (const it of inventory) if (ITEM_BY_ID.has(it.itemId) && Number.isInteger(it.qty) && it.qty > 0) inv.set(it.itemId, (inv.get(it.itemId) ?? 0) + it.qty);
  const held = new Set(heldInstances);
  let out: Assignment | null = null;
  let groupId: string | null = null;
  db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT id, ign, server, items_json, target_bot_guid, instance_ids_json, group_id, vault_user_id, swap_json FROM withdraw_requests
         WHERE status = 'pending' AND server = ? AND seasonal = ?
           AND ${isPlayersNextTrade("withdraw_requests")}
         ORDER BY created_at ASC LIMIT 50`,
      )
      .all(bot.server, bot.seasonal ? 1 : 0) as { id: number; ign: string; server: string; items_json: string; target_bot_guid: string | null; instance_ids_json: string | null; group_id: string | null; vault_user_id: number | null; swap_json: string | null }[];
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
      if (cand.instance_ids_json !== null) {
        if (cand.target_bot_guid !== botGuid) continue;
        try {
          needed = JSON.parse(cand.instance_ids_json);
        } catch {
          continue;
        }
        if (!Array.isArray(needed) || !needed.every((id) => held.has(id))) continue;
      } else if (!items.every((i) => (inv.get(i.itemId) ?? 0) >= i.qty)) {
        continue;
      }
      const claimed = db
        .prepare(`UPDATE withdraw_requests SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(botGuid, now, cand.id);
      if (claimed.changes !== 1) continue;
      recordEvent(db, "withdraw", cand.id, "claimed", botGuid, { perInstance: needed !== null });
      groupId = cand.group_id;
      out = { kind: "withdraw", requestId: cand.id, ign: cand.ign, server: cand.server, items, instanceIds: needed, botIgn: bot.ign, vault: cand.vault_user_id, swap: parseSwap(cand.swap_json) };
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
  /** Always 0: a deposit is one trade. Kept for the fleet's wire shape. */
  remaining: number;
  /** Always true, likewise. */
  terminal: boolean;
  /** No room for another deposit into this pool half (or this vault) right now. */
  vaultFull: boolean;
}

export function fulfillDeposit(db: Database.Database, botGuid: string, requestId: number, items: ItemQty[], units: Unit[] | null = null, instances: ReceivedInstance[] | null = null): DepositResult {
  if (!items.length || items.length > 16) throw new QueueError("items must be 1-16 entries");
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
      .prepare("SELECT id, ign, ign_lower, server, item_count, remaining_count, current_cap, status, claimed_by, seasonal, group_id, vault_user_id FROM deposit_requests WHERE id = ?")
      .get(requestId) as { id: number; ign: string; ign_lower: string; server: string; item_count: number; remaining_count: number | null; current_cap: number | null; status: string; claimed_by: string | null; seasonal: number; group_id: string | null; vault_user_id: number | null } | undefined;
    if (!row) throw new QueueError("Request not found");
    if (row.status === "fulfilled") throw new QueueError("Already fulfilled");
    if (row.status === "cancelled") throw new QueueError("Request cancelled");
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
    let vaultFull: boolean;
    if (row.vault_user_id !== null) {
      // Personal storage: the items are the account's property, off the
      // ledger. Record who owns each physical item the fleet identified; a
      // unit the fleet could not pin to an instance is logged for the
      // operator rather than left to look like pool stock silently.
      const owned = db.prepare("INSERT OR IGNORE INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'deposit', ?)");
      const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      let recorded = 0;
      for (const inst of instances ?? []) {
        if (owned.run(inst.instanceId, row.vault_user_id, inst.itemId, inst.enchants, row.seasonal, botGuid, now).changes) {
          recorded++;
          ev.run(row.vault_user_id, row.ign, "deposited", inst.instanceId, inst.itemId, JSON.stringify({ enchants: inst.enchants, requestId }), now);
        }
      }
      if (recorded < got) {
        ev.run(row.vault_user_id, row.ign, "deposit-unmatched", null, null, JSON.stringify({ requestId, items, recorded }), now);
        console.log(`[queue] vault deposit #${requestId}: ${recorded} of ${got} received item(s) matched to tracker instances`);
      }
      const left = vaultHalf(db, row.vault_user_id, !!row.seasonal).slots - vaultCount(db, row.vault_user_id, !!row.seasonal);
      vaultFull = left < 1;
    } else {
      const insert = db.prepare(`INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('deposit', ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const l of lines) insert.run(row.ign, row.ign_lower, l.itemId, l.qty, l.enchants, row.server, requestId, now);
      vaultFull = poolRoomForDeposits(db, row.seasonal ? 1 : 0, requestId, got) < 1;
    }
    db.prepare(`UPDATE deposit_requests SET status = 'fulfilled', remaining_count = 0, current_cap = NULL, claimed_by = ?, end_reason = ?, updated_at = ? WHERE id = ?`)
      .run(botGuid, vaultFull ? "vault-full" : null, now, requestId);
    recordEvent(db, "deposit", requestId, "fulfilled", botGuid, { items, units, vaultFull });
    return { ign: row.ign, server: row.server, count: got, remaining: 0, terminal: true, vaultFull };
  }).immediate();
  console.log(`[queue] deposit-fulfill bot=${botGuid.slice(0, 8)} req=${requestId} got=${out.count} terminal=${out.terminal}`);
  emitTx();
  emitRequest(groupId);
  return out;
}

/**
 * A bot reports what it handed over for a withdraw. The full set closes the
 * row. A strict subset (a chunked trade that broke off after some windows,
 * because the player's inventory only had room for part of it) records the
 * delivered items and puts the row back to `pending` with what is still
 * owed, so the next claim — usually the same bot — finishes it.
 */
export function fulfillWithdraw(db: Database.Database, botGuid: string, requestId: number, items: ItemQty[], deliveredInstances: string[] = []): { ign: string; server: string; count: number; partial: boolean; remaining: ItemQty[] } {
  if (!items.length || items.length > 16) throw new QueueError("items must be 1-16 entries");
  for (const it of items) if (!ITEM_BY_ID.has(it.itemId)) throw new QueueError(`Unknown item: ${it.itemId}`);
  let groupId: string | null = null;
  const out = db.transaction(() => {
    const row = db
      .prepare("SELECT id, ign, ign_lower, server, items_json, instance_ids_json, status, claimed_by, group_id, vault_user_id FROM withdraw_requests WHERE id = ?")
      .get(requestId) as { id: number; ign: string; ign_lower: string; server: string; items_json: string; instance_ids_json: string | null; status: string; claimed_by: string | null; group_id: string | null; vault_user_id: number | null } | undefined;
    if (!row) throw new QueueError("Request not found");
    if (row.status === "fulfilled") throw new QueueError("Already fulfilled");
    if (row.status === "cancelled") throw new QueueError("Request cancelled");
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
    if (row.vault_user_id !== null) {
      // The owner took their own property back: no points, the ownership
      // rows go, and the vault bot is released if nothing is left.
      const del = db.prepare("DELETE FROM vault_items WHERE instance_id = ? AND user_id = ?");
      const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, ?, 'withdrawn', ?, NULL, ?, ?)");
      for (const id of deliveredInstances) {
        if (del.run(id, row.vault_user_id).changes) ev.run(row.vault_user_id, row.ign, id, JSON.stringify({ requestId }), now);
      }
    } else {
      const insert = db.prepare(`INSERT INTO transactions (kind, ign, ign_lower, item_id, qty, enchants, server, request_id, created_at) VALUES ('withdraw', ?, ?, ?, ?, ?, ?, ?, ?)`);
      const enchantsOf = (itemId: string): number => {
        const r = requested.find((x) => x.itemId === itemId);
        return r && Number.isInteger(r.enchants) && r.enchants! > 0 ? r.enchants! : 0;
      };
      const credited: ItemQty[] = full ? requested : [...got].map(([itemId, qty]) => ({ itemId, qty }));
      for (const it of credited) insert.run(row.ign, row.ign_lower, it.itemId, it.qty, enchantsOf(it.itemId), row.server, requestId, now);
    }
    let remaining: ItemQty[] = [];
    if (full) {
      db.prepare("UPDATE withdraw_requests SET status = 'fulfilled', updated_at = ? WHERE id = ?").run(now, requestId);
      if (row.vault_user_id !== null) releaseVaultBotIfEmpty(db, row.vault_user_id);
      recordEvent(db, "withdraw", requestId, "fulfilled", botGuid, { items, instanceIds: deliveredInstances });
    } else {
      remaining = requested
        .map((r) => ({ ...r, qty: r.qty - (got.get(r.itemId) ?? 0) }))
        .filter((r) => r.qty > 0);
      db.prepare("UPDATE withdraw_requests SET items_json = ?, instance_ids_json = ?, status = 'pending', claimed_by = NULL, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(remaining), remainingInstances ? JSON.stringify(remainingInstances) : null, now, requestId);
      recordEvent(db, "withdraw", requestId, "partial", botGuid, { items, instanceIds: deliveredInstances, remaining, remainingInstances });
    }
    presence.setStatus(botGuid, "idle", now);
    return { ign: row.ign, server: row.server, count: items.length, partial: !full, remaining };
  }).immediate();
  console.log(`[queue] withdraw-fulfill bot=${botGuid.slice(0, 8)} req=${requestId} items=${out.count}${out.partial ? ` (partial, ${out.remaining.length} line(s) re-queued)` : ""}`);
  emitTx();
  emitRequest(groupId);
  return out;
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
  }
  return changed;
}

/** Cancel a claimed row for good (absent partner). */
export function giveUp(db: Database.Database, botGuid: string, requestId: number, kind: Kind, why = "partner absent"): boolean {
  const table = kind === "withdraw" ? "withdraw_requests" : "deposit_requests";
  const now = Date.now();
  const changed = db.transaction(() => {
    const n = db.prepare(`UPDATE ${table} SET status = 'cancelled', claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?`).run(now, requestId, botGuid).changes;
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
    return j && (j.role === "give" || j.role === "take") && Array.isArray(j.gets) ? { rendezvousId: Number(j.rendezvousId), role: j.role, gets: j.gets, vaultUserId: j.vaultUserId == null ? null : Number(j.vaultUserId) } : null;
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
  // A commons hand-over's receiving side gives nothing: an empty-items row
  // pinned to the receiving bot, which only waits and accepts.
  const receiveOnly = !job.give.length && job.swap.role === "take" && job.swap.gets.length > 0;
  if (!receiveOnly && (!job.give.length || !job.giveInstanceIds.length)) throw new QueueError("a swap side must give at least one item");
  if (!job.partnerIgn) throw new QueueError("partner IGN required");
  const now = Date.now();
  const r = db.prepare(`INSERT INTO withdraw_requests (ign, ign_lower, server, items_json, status, target_bot_guid, instance_ids_json, seasonal, vault_user_id, created_at, updated_at, swap_json)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
    .run(job.partnerIgn, job.partnerIgn.toLowerCase(), job.server, JSON.stringify(job.give), job.botGuid, receiveOnly ? null : JSON.stringify(job.giveInstanceIds), job.seasonal ? 1 : 0, job.swap.vaultUserId ?? null, now, now, JSON.stringify(job.swap));
  const id = Number(r.lastInsertRowid);
  recordEvent(db, "withdraw", id, "swap-queued", job.botGuid, { rendezvousId: job.swap.rendezvousId, role: job.swap.role });
  return id;
}

/** Swap rows for `rendezvousId` in any state (normally one). */
export function swapJobsFor(db: Database.Database, rendezvousId: number): { id: number; status: string }[] {
  return (db.prepare("SELECT id, status, swap_json FROM withdraw_requests WHERE swap_json IS NOT NULL").all() as { id: number; status: string; swap_json: string }[])
    .filter((r) => parseSwap(r.swap_json)?.rendezvousId === rendezvousId)
    .map((r) => ({ id: r.id, status: r.status }));
}

export function cancelSwapJob(db: Database.Database, requestId: number, why: string): boolean {
  const r = db.prepare("UPDATE withdraw_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND swap_json IS NOT NULL AND status IN ('pending','claimed')").run(Date.now(), requestId);
  if (r.changes) recordEvent(db, "withdraw", requestId, "swap-cancelled", null, { why });
  return r.changes > 0;
}

/** Phase 4b: the physical items a guest's swap brought in, once the tracker has seen them, become the guest's. */
export function attachSwapReceived(db: Database.Database, requestId: number, vaultUserId: number, instances: ReceivedInstance[]): number {
  const row = db.prepare("SELECT seasonal, claimed_by, swap_json FROM withdraw_requests WHERE id = ?").get(requestId) as { seasonal: number; claimed_by: string | null; swap_json: string | null } | undefined;
  if (!row || !row.swap_json) throw new QueueError("Not a swap row");
  const now = Date.now();
  const ins = db.prepare("INSERT OR IGNORE INTO vault_items (instance_id, user_id, item_id, enchants, seasonal, bot_guid, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'deposit', ?)");
  const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, '', 'traded-in', ?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const i of instances) {
      if (ins.run(i.instanceId, vaultUserId, i.itemId, i.enchants, row.seasonal, row.claimed_by, now).changes) {
        n++;
        ev.run(vaultUserId, i.instanceId, i.itemId, JSON.stringify({ requestId }), now);
      }
    }
  })();
  return n;
}

type SwapListener = (requestId: number, swap: SwapSpec, result: SwapResult) => void;
const swapListeners = new Set<SwapListener>();
/** The swap coordinator (src/node/swaps.ts) hears every swap outcome here. */
export function onSwapResult(fn: SwapListener): () => void {
  swapListeners.add(fn);
  return () => swapListeners.delete(fn);
}

/** The fleet's report for a swap row: closes it either way and tells the listeners. No ledger, no vault rows. */
export function reportSwap(db: Database.Database, botGuid: string, requestId: number, result: SwapResult): { swap: SwapSpec } {
  const now = Date.now();
  const swap = db.transaction(() => {
    const row = db.prepare("SELECT status, claimed_by, swap_json FROM withdraw_requests WHERE id = ?").get(requestId) as { status: string; claimed_by: string | null; swap_json: string | null } | undefined;
    if (!row || !row.swap_json) throw new QueueError("Not a swap row");
    const spec = parseSwap(row.swap_json);
    if (!spec) throw new QueueError("Bad swap spec");
    if (row.status === "fulfilled" || row.status === "failed" || row.status === "cancelled") throw new QueueError("Already closed");
    if (row.claimed_by && row.claimed_by !== botGuid) throw new QueueError("This request was claimed by a different bot");
    db.prepare("UPDATE withdraw_requests SET status = ?, updated_at = ? WHERE id = ?").run(result.ok ? "fulfilled" : "failed", now, requestId);
    recordEvent(db, "withdraw", requestId, result.ok ? "swap-done" : "swap-failed", botGuid, result);
    // A guest's items left their vault: drop the ownership rows (the
    // received ones are attached once the tracker sees them, attachSwapReceived).
    if (result.ok && spec.vaultUserId != null) {
      const del = db.prepare("DELETE FROM vault_items WHERE instance_id = ? AND user_id = ?");
      const ev = db.prepare("INSERT INTO vault_events (user_id, ign, event, instance_id, item_id, detail, at) VALUES (?, ?, 'traded-away', ?, NULL, ?, ?)");
      for (const id of result.gaveInstanceIds) if (del.run(id, spec.vaultUserId).changes) ev.run(spec.vaultUserId, result.partnerIgn, id, JSON.stringify({ requestId, rendezvousId: spec.rendezvousId }), now);
    }
    return spec;
  }).immediate();
  presence.setStatus(botGuid, "idle", now);
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
  /** Personal storage: the account whose items these are. */
  vaultUserId: number | null;
  swap?: SwapSpec | null;
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
  /** Personal storage: only this account's vault bot may claim it. */
  vaultUserId: number | null;
  vaultBotGuid: string | null;
}

/**
 * The rows a bot could act on right now (one per player, oldest first), plus
 * the bots dedicated to somebody's personal storage — those are not pool bots
 * whatever they hold, and the fleet must neither wake them for pool work nor
 * count their slots.
 */
export function listPending(db: Database.Database): { withdraws: PendingWithdraw[]; deposits: PendingDeposit[]; vaultBots: string[] } {
  sweepStaleRequests(db);
  const withdraws = (db
    .prepare(`SELECT id, server, items_json, target_bot_guid, instance_ids_json, seasonal, vault_user_id, swap_json FROM withdraw_requests WHERE status = 'pending' AND ${isPlayersNextTrade("withdraw_requests")} ORDER BY created_at ASC`)
    .all() as { id: number; server: string; items_json: string; target_bot_guid: string | null; instance_ids_json: string | null; seasonal: number; vault_user_id: number | null; swap_json: string | null }[])
    .map((w) => {
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
      return { id: w.id, server: w.server, items, targetBotGuid: w.target_bot_guid, instanceIds, seasonal: w.seasonal !== 0, vaultUserId: w.vault_user_id, swap: parseSwap(w.swap_json) };
    });
  // The vault bot comes from a correlated subquery rather than a join: the
  // next-trade predicate names the table's own columns, and a join would make
  // `id` ambiguous. A vault deposit lands in the half its pool names.
  const deposits = (db
    .prepare(`SELECT id, server, item_count, seasonal, items_json, vault_user_id,
                     (SELECT h.bot_guid FROM vault_halves h WHERE h.user_id = deposit_requests.vault_user_id AND h.seasonal = deposit_requests.seasonal) AS vault_bot_guid
              FROM deposit_requests
              WHERE status = 'pending' AND ${isPlayersNextTrade("deposit_requests")} ORDER BY created_at ASC`)
    .all() as { id: number; server: string; item_count: number; seasonal: number; items_json: string | null; vault_user_id: number | null; vault_bot_guid: string | null }[])
    .map((d) => {
      // itemCount is the trade size: the bot that comes must have that many
      // free slots. declaredCount is the same number, kept for the wire.
      const out: PendingDeposit = { id: d.id, server: d.server, itemCount: d.item_count, declaredCount: d.item_count, seasonal: d.seasonal !== 0, vaultUserId: d.vault_user_id, vaultBotGuid: d.vault_user_id !== null ? d.vault_bot_guid : null };
      if (d.items_json) {
        try {
          const j = JSON.parse(d.items_json);
          if (Array.isArray(j)) out.items = j.filter((x): x is ItemQty => !!x && typeof x.itemId === "string" && Number.isInteger(x.qty) && x.qty > 0);
        } catch { /* no hint */ }
      }
      return out;
    });
  // Shared mode: no bot is anybody's alone, so the fleet treats them all as pool bots.
  const vaultBots = sharedVaultBots() ? [] : (db.prepare("SELECT bot_guid FROM vault_halves WHERE bot_guid IS NOT NULL").all() as { bot_guid: string }[]).map((r) => r.bot_guid);
  return { withdraws, deposits, vaultBots };
}

/** Event history for one request, oldest first. */
export function eventsFor(db: Database.Database, kind: Kind, requestId: number): { event: string; botGuid: string | null; detail: unknown; at: number }[] {
  return (db.prepare("SELECT event, bot_guid, detail, at FROM request_events WHERE kind = ? AND request_id = ? ORDER BY id").all(kind, requestId) as { event: string; bot_guid: string | null; detail: string | null; at: number }[])
    .map((r) => ({ event: r.event, botGuid: r.bot_guid, detail: r.detail ? JSON.parse(r.detail) : null, at: r.at }));
}
