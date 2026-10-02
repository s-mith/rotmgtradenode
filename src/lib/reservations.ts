import type Database from "better-sqlite3";
import { CLAIMED_TIMEOUT_MS } from "./timeouts";

/** A communism give never queued as a meeting on this node stops holding its items after this long. */
export const GIVE_UNQUEUED_MS = 10 * 60_000;

/**
 * Instances spoken for: named by any open per-instance withdraw (a pool pick,
 * a swap side, a communism hand-over), promised in an offer this node posted
 * or accepted that is still open or accepted on the hub (src/node/swaps.ts),
 * or in a hand-over this node is giving that has not finished
 * (src/node/communism.ts). A reserved item can't be contributed, withdrawn by
 * the owner, tucked into storage or moved by consolidation until whatever
 * named it ends. `openOffers: false` leaves out what open offers alone promise:
 * one item may sit in several offers at once, and be offered again, given in
 * an accept or a hand-over, or withdrawn from the pool while it does (the hub
 * holds the other offers while a meeting has it, and withdraws them once it
 * is traded away; a pool withdraw withdraws the offers naming it).
 */
export function reservedInstanceIds(db: Database.Database, o: { openOffers?: boolean } = {}): Set<string> {
  const out = reservedByRequests(db);
  if (hasTable(db, "swap_offers")) {
    const offers = db.prepare(`SELECT refs_json FROM swap_offers WHERE status IN (${o.openOffers === false ? "'accepted'" : "'open','accepted'"})`).all() as { refs_json: string }[];
    for (const o of offers) {
      try {
        const refs = JSON.parse(o.refs_json) as Record<string, string>;
        for (const id of Object.values(refs)) out.add(String(id));
      } catch {
        // a malformed local row reserves nothing
      }
    }
  }
  if (hasTable(db, "communism_meetings")) {
    // A give is under way until its meeting closes; one the swap coordinator never queued (it called the meeting off
    // before, or the hub never scheduled it) holds its items only GIVE_UNQUEUED_MS, not for good.
    const swaps = hasTable(db, "swap_rendezvous");
    const finished = swaps ? "AND NOT EXISTS (SELECT 1 FROM swap_rendezvous r WHERE r.rendezvous_id = m.rendezvous_id AND r.state NOT IN ('meet', 'receipt-pending'))" : "";
    const queued = swaps ? "AND (m.created_at > ? OR EXISTS (SELECT 1 FROM swap_rendezvous r WHERE r.rendezvous_id = m.rendezvous_id))" : "";
    const gives = db.prepare(`SELECT instance_ids_json FROM communism_meetings m WHERE m.kind = 'give' ${finished} ${queued}`).all(...(swaps ? [Date.now() - GIVE_UNQUEUED_MS] : [])) as { instance_ids_json: string }[];
    for (const g of gives) {
      try {
        const ids = JSON.parse(g.instance_ids_json);
        if (Array.isArray(ids)) for (const id of ids) out.add(String(id));
      } catch {
        // likewise
      }
    }
  }
  return out;
}

/** What open pool withdraws name, meetings' swap rows left out: items a withdraw took, which the node's open offers must let go of. */
export function pickedByWithdraws(db: Database.Database): Set<string> {
  const out = new Set<string>();
  const rows = db.prepare("SELECT instance_ids_json FROM withdraw_requests WHERE status IN ('pending','claimed') AND instance_ids_json IS NOT NULL AND swap_json IS NULL").all() as { instance_ids_json: string }[];
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.instance_ids_json);
      if (Array.isArray(arr)) for (const id of arr) out.add(String(id));
    } catch {
      // malformed open row — the stale-request sweep will cancel it
    }
  }
  return out;
}

/** Only what open withdraw rows name (a pick, a swap side, a hand-over): what a meeting about to be queued must not collide with. */
export function reservedByRequests(db: Database.Database): Set<string> {
  const out = new Set<string>();
  // A row cancelled while a bot was mid-trade on it (claimed_by still set:
  // only the fleet's own give-up clears it) keeps its items held until that
  // trade could no longer be running, so they are not promised twice.
  const rows = db
    .prepare(
      `SELECT instance_ids_json FROM withdraw_requests WHERE instance_ids_json IS NOT NULL
         AND (status IN ('pending','claimed') OR (status = 'cancelled' AND claimed_by IS NOT NULL AND updated_at >= ?))`,
    )
    .all(Date.now() - CLAIMED_TIMEOUT_MS) as { instance_ids_json: string }[];
  for (const r of rows) {
    try {
      const arr = JSON.parse(r.instance_ids_json);
      if (Array.isArray(arr)) for (const id of arr) out.add(String(id));
    } catch {
      // malformed open row — the stale-request sweep will cancel it
    }
  }
  return out;
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * The first item type a set of picks would leave short: for each bot and
 * type picked, the open rows on that bot (by-type and per-instance alike,
 * by their items_json) plus the new picks must not exceed the copies there.
 * Picks on another character are left out, as by-type rows never reach them.
 */
export function picksOverCommitted(
  db: Database.Database,
  picks: { bot_guid: string; item_id: string; stored: { charId: number | null } | null }[],
  stockByBot: Map<string, Map<string, number>>,
): string | null {
  const want = new Map<string, Map<string, number>>();
  for (const p of picks) {
    if (p.stored?.charId != null) continue;
    let m = want.get(p.bot_guid);
    if (!m) want.set(p.bot_guid, (m = new Map()));
    m.set(p.item_id, (m.get(p.item_id) ?? 0) + 1);
  }
  const stmt = db.prepare("SELECT items_json FROM withdraw_requests WHERE status IN ('pending','claimed') AND target_bot_guid = ? AND swap_json IS NULL");
  for (const [bot, items] of want) {
    const committed = new Map<string, number>();
    for (const r of stmt.all(bot) as { items_json: string }[]) {
      try {
        const arr = JSON.parse(r.items_json) as { itemId: string; qty: number }[];
        if (Array.isArray(arr)) for (const it of arr) committed.set(it.itemId, (committed.get(it.itemId) ?? 0) + (Number(it.qty) || 0));
      } catch {
        // a malformed row commits nothing
      }
    }
    for (const [itemId, n] of items) {
      if ((committed.get(itemId) ?? 0) + n > (stockByBot.get(bot)?.get(itemId) ?? 0)) return itemId;
    }
  }
  return null;
}
