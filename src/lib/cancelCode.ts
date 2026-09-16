// The open-request gate and direct cancel for the vault.
//
// A logged-in session proves the player controls the character (lib/session.ts),
// so cancelling their own queued/claimed requests needs no further challenge —
// see cancelOpenRequests. openRequestsFor is the shared "do they already have
// something open?" check the deposit and withdraw routes gate on.

import type Database from "better-sqlite3";
import { emitRequest } from "./liveBus";
import { releaseVaultBotIfEmpty } from "./vault";

export type OpenRequests = { deposits: number; withdraws: number };

/**
 * What `ignLower` currently has queued.
 *
 * The counts match the gates in /api/deposit and /api/withdraw exactly —
 * including the withdraw side's `group_id IS NOT NULL`, which skips the
 * pre-grouping legacy rows those gates also skip. A mismatch here would mean
 * flagging a queue as full when the submit path doesn't, or vice versa.
 */
/** A player may have this many withdraws open at once (the fragmenter makes several rows from one request). */
export const MAX_OPEN_WITHDRAWS = 3;

export function openRequestsFor(db: Database.Database, ignLower: string): OpenRequests {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM deposit_requests
           WHERE ign_lower = ? AND status IN ('pending','claimed')) AS deposits,
         (SELECT COUNT(*) FROM withdraw_requests
           WHERE ign_lower = ? AND status IN ('pending','claimed')
             AND group_id IS NOT NULL) AS withdraws`,
    )
    .get(ignLower, ignLower) as OpenRequests;
}

export type CancelResult = {
  depositsCancelled: number;
  withdrawsCancelled: number;
  /** Trades left alone because a bot is mid-trade on them right now. */
  tradesInProgress: number;
};

/** One open request as the In Flight panel lists it. */
export type OpenGroup = {
  groupId: string;
  kind: "deposit" | "withdraw";
  server: string;
  /** Personal storage rather than the pool. */
  vault: boolean;
  seasonal: boolean;
  createdAt: number;
  /** Deposits: the declared upper bound; withdraws: what was asked for. */
  items: { itemId: string; qty: number }[];
  itemCount: number;
};

/**
 * Every open request group of `ignLower`, oldest first. A group is one submit
 * from the player, whatever rows the server split it into; the per-row
 * status comes from depositGroupStatus / withdrawGroupStatus.
 */
export function openGroupsFor(db: Database.Database, ignLower: string): OpenGroup[] {
  const out: OpenGroup[] = [];
  const deposits = db
    .prepare(
      `SELECT group_id, MIN(server) AS server, MAX(vault_user_id IS NOT NULL) AS vault, MAX(seasonal) AS seasonal,
              MIN(created_at) AS created_at, MAX(item_count) AS item_count
         FROM deposit_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL
        GROUP BY group_id ORDER BY MIN(created_at)`,
    )
    .all(ignLower) as { group_id: string; server: string; vault: number; seasonal: number; created_at: number; item_count: number }[];
  for (const d of deposits) {
    out.push({ groupId: d.group_id, kind: "deposit", server: d.server, vault: d.vault === 1, seasonal: d.seasonal !== 0, createdAt: d.created_at, items: [], itemCount: d.item_count });
  }
  const withdraws = db
    .prepare(
      `SELECT group_id, server, items_json, vault_user_id, seasonal, created_at
         FROM withdraw_requests WHERE ign_lower = ? AND status IN ('pending','claimed') AND group_id IS NOT NULL
        ORDER BY created_at, id`,
    )
    .all(ignLower) as { group_id: string; server: string; items_json: string; vault_user_id: number | null; seasonal: number; created_at: number }[];
  const byGroup = new Map<string, OpenGroup>();
  for (const w of withdraws) {
    let g = byGroup.get(w.group_id);
    if (!g) {
      g = { groupId: w.group_id, kind: "withdraw", server: w.server, vault: w.vault_user_id !== null, seasonal: w.seasonal !== 0, createdAt: w.created_at, items: [], itemCount: 0 };
      byGroup.set(w.group_id, g);
      out.push(g);
    }
    try {
      const items = JSON.parse(w.items_json) as { itemId: string; qty: number }[];
      for (const it of items) {
        const cur = g.items.find((x) => x.itemId === it.itemId);
        if (cur) cur.qty += it.qty;
        else g.items.push({ itemId: it.itemId, qty: it.qty });
        g.itemCount += it.qty;
      }
    } catch {
      // malformed row — listed without items; the sweep will age it out
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Cancel `ignLower`'s open requests directly, no code challenge.
 *
 * This is the logged-in path: a session already proves control of the
 * character (lib/session.ts), so the whispered-code proof the cancel challenge
 * provided is redundant. Cancels EVERY open row — pending and claimed alike,
 * with no grace window — so a player can pull a request even while a bot is
 * mid-trade on it. (Tradeoff: cancelling during the exact hand-off moment can
 * lose the items in that window; the player asked to be able to cancel anytime.)
 */
export function cancelOpenRequests(db: Database.Database, ignLower: string, groupId: string | null = null): CancelResult {
  const now = Date.now();
  const groups: (string | null)[] = [];
  const vaultUsers = new Set<number>();
  const out = db.transaction(() => {
    const cancel = (table: "deposit_requests" | "withdraw_requests"): number => {
      const kind = table === "deposit_requests" ? "deposit" : "withdraw";
      // One group when asked (the In Flight panel's per-request cancel),
      // else everything the character has open.
      const rows = db
        .prepare(`SELECT id, group_id, vault_user_id FROM ${table} WHERE ign_lower = ? AND status IN ('pending', 'claimed')${groupId ? " AND group_id = ?" : ""}`)
        .all(...(groupId ? [ignLower, groupId] : [ignLower])) as { id: number; group_id: string | null; vault_user_id: number | null }[];
      const upd = db.prepare(`UPDATE ${table} SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'claimed')`);
      const ev = db.prepare("INSERT INTO request_events (kind, request_id, event, bot_guid, detail, at) VALUES (?, ?, 'cancelled', NULL, ?, ?)");
      let n = 0;
      for (const r of rows) {
        if (upd.run(now, r.id).changes) {
          ev.run(kind, r.id, JSON.stringify({ why: "cancelled by player" }), now);
          groups.push(r.group_id);
          if (r.vault_user_id !== null) vaultUsers.add(r.vault_user_id);
          n++;
        }
      }
      return n;
    };
    // A bot mid-trade on one of these rows learns from the fleet's own next
    // status report; there is no bot table to free any more.
    const depositsCancelled = cancel("deposit_requests");
    const withdrawsCancelled = cancel("withdraw_requests");
    for (const u of vaultUsers) releaseVaultBotIfEmpty(db, u);
    return { depositsCancelled, withdrawsCancelled, tradesInProgress: 0 };
  }).immediate();
  for (const g of groups) emitRequest(g);
  return out;
}
