import type Database from "better-sqlite3";
import { isPlayersNextTrade } from "./tradeQueue";
import { emitRequest } from "./liveBus";
import { releaseVaultBotIfEmpty } from "./vault";

// Pending: nobody has picked it up. Could be the user gave up, or no bot is
// online for that server. 10 min is plenty for a real claimant to grab it.
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
// A deposit bigger than a plain bot may be waiting for the fleet to fit an
// account with a backpack first (a trip of its own, behind whatever the
// backpack lane was doing), so it gets twice as long.
export const BIG_PENDING_TIMEOUT_MS = 2 * PENDING_TIMEOUT_MS;

// Claimed: a bot picked it up but never reported success/failure. Probably
// the bot crashed mid-trade or the trade window in-game timed out. The
// trade plugin's own watchdog cancels at 120s, so 5 min on the server side
// gives generous slack for the fulfill API call to land.
export const CLAIMED_TIMEOUT_MS = 5 * 60 * 1000;

// Sweep stale deposit/withdraw requests. Called inline from pending-summary
// so there's no separate cron — every supervise tick lazily prunes the queue.
//
// On timeout we set status = 'cancelled' and leave inventory alone:
//   - Withdraws decrement inventory only at fulfill, so a timed-out claimed
//     withdraw means the bot still has the items. Correct already.
//   - Deposits credit inventory only at fulfill, so a timed-out claimed
//     deposit means the bot didn't actually receive items. Correct already.
//
// We do NOT flip the bot's `bots.status` back to 'idle' on cancel — the
// bot's own next heartbeat is the source of truth for its current state.
export function sweepStaleRequests(db: Database.Database): {
  pendingTimedOut: number;
  claimedTimedOut: number;
} {
  const now = Date.now();
  const pendingFloor = now - PENDING_TIMEOUT_MS;
  const claimedFloor = now - CLAIMED_TIMEOUT_MS;

  // Group ids of every row about to be cancelled, so their browsers hear
  // about it, and so the events table says why each one ended.
  const groups: (string | null)[] = [];
  const vaultUsers = new Set<number>();
  const tx = db.transaction(() => {
    const expire = (table: "deposit_requests" | "withdraw_requests", where: string, params: unknown[], why: string): number => {
      const rows = db.prepare(`SELECT id, group_id, vault_user_id FROM ${table} WHERE ${where}`).all(...params) as { id: number; group_id: string | null; vault_user_id: number | null }[];
      if (!rows.length) return 0;
      const kind = table === "deposit_requests" ? "deposit" : "withdraw";
      const upd = db.prepare(`UPDATE ${table} SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','claimed')`);
      const ev = db.prepare("INSERT INTO request_events (kind, request_id, event, bot_guid, detail, at) VALUES (?, ?, 'expired', NULL, ?, ?)");
      let n = 0;
      for (const r of rows) {
        if (upd.run(now, r.id).changes) {
          ev.run(kind, r.id, JSON.stringify({ why }), now);
          groups.push(r.group_id);
          if (r.vault_user_id !== null) vaultUsers.add(r.vault_user_id);
          n++;
        }
      }
      return n;
    };
    // Pending deposits: created_at AND updated_at, because a multi-bot deposit
    // swings pending -> claimed -> pending and a recent updated_at means the
    // player is still engaged. Both skip rows queued behind the player's own
    // in-flight trade (lib/tradeQueue.ts) — those aren't abandoned.
    const bigFloor = now - BIG_PENDING_TIMEOUT_MS;
    const pendingDep = expire(
      "deposit_requests",
      `status = 'pending' AND created_at < (CASE WHEN item_count > 8 THEN ? ELSE ? END) AND updated_at < (CASE WHEN item_count > 8 THEN ? ELSE ? END) AND ${isPlayersNextTrade("deposit_requests")}`,
      [bigFloor, pendingFloor, bigFloor, pendingFloor],
      "pending too long",
    );
    const pendingWd = expire(
      "withdraw_requests",
      `status = 'pending' AND created_at < ? AND ${isPlayersNextTrade("withdraw_requests")}`,
      [pendingFloor],
      "pending too long",
    );
    // Claimed rows age on updated_at (the moment of claim). The bot's own
    // presence report corrects its status; nothing to free here.
    const claimedDep = expire("deposit_requests", "status = 'claimed' AND updated_at < ?", [claimedFloor], "claimed but never fulfilled");
    const claimedWd = expire("withdraw_requests", "status = 'claimed' AND updated_at < ?", [claimedFloor], "claimed but never fulfilled");
    // A vault whose last open request just lapsed may have nothing left on
    // its bot; hand the bot back.
    for (const u of vaultUsers) releaseVaultBotIfEmpty(db, u);
    return { pendingTimedOut: pendingDep + pendingWd, claimedTimedOut: claimedDep + claimedWd };
  });
  const out = tx.immediate();
  for (const g of groups) emitRequest(g);
  return out;
}
