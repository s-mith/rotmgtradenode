import type Database from "better-sqlite3";
import { isPlayersNextTrade } from "./tradeQueue";
import { emitRequest } from "./liveBus";
import { advancedForPool } from "./advanced";

// Pending withdraw: nobody has picked it up. Could be the user gave up, or
// no bot is online for that server. 10 min is plenty for a real claimant to
// grab it.
//
// A pending deposit has no clock of its own: the fleet cancels it, saying
// why, when no account on the node could take it or when the bot on its way
// met the server's login queue (relay/fleet/dispatcher.ts); anything else
// (a login, a cooldown, a busy bot) it simply waits out.
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

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
  const tx = db.transaction(() => {
    const expire = (table: "deposit_requests" | "withdraw_requests", where: string, params: unknown[], why: string): number => {
      const rows = db.prepare(`SELECT id, group_id FROM ${table} WHERE ${where}`).all(...params) as { id: number; group_id: string | null }[];
      if (!rows.length) return 0;
      const kind = table === "deposit_requests" ? "deposit" : "withdraw";
      const upd = db.prepare(`UPDATE ${table} SET status = 'cancelled', end_reason = COALESCE(end_reason, ?), updated_at = ? WHERE id = ? AND status IN ('pending','claimed')`);
      const ev = db.prepare("INSERT INTO request_events (kind, request_id, event, bot_guid, detail, at) VALUES (?, ?, 'expired', NULL, ?, ?)");
      let n = 0;
      for (const r of rows) {
        if (upd.run(why, now, r.id).changes) {
          ev.run(kind, r.id, JSON.stringify({ why }), now);
          groups.push(r.group_id);
          n++;
        }
      }
      return n;
    };
    // Pending withdraws skip rows queued behind the player's own in-flight
    // trade (lib/tradeQueue.ts): those aren't abandoned. Swap rows (design
    // doc §6.2) live by their meeting's deadline, not by these clocks: a bot
    // may wait most of the window for the other node's bot to log in.
    // lib/queue.ts expireSwapJobs fails them past that deadline, through the
    // swap listeners, so a receipt goes out.
    //
    // Under advanced management (docs/relay/ADVANCED.md) a withdraw served
    // one row after another — a bot per account, a character after the
    // vault — can run longer than the clock, and a row only becomes the
    // player's next trade when the one before it ends. Its wait counts from
    // then: from the last time any of the player's rows moved, not from when
    // the whole request was made.
    const adv = { pool: advancedForPool(false) ? 1 : 0, communism: advancedForPool(true) ? 1 : 0 };
    const promoted = adv.pool || adv.communism
      ? ` AND (CASE WHEN communism = 1 THEN ? ELSE ? END = 0
              OR (NOT EXISTS (SELECT 1 FROM withdraw_requests o WHERE o.ign_lower = withdraw_requests.ign_lower AND o.id <> withdraw_requests.id AND o.updated_at >= ?)
                  AND NOT EXISTS (SELECT 1 FROM deposit_requests o WHERE o.ign_lower = withdraw_requests.ign_lower AND o.updated_at >= ?)))`
      : "";
    const pendingWd = expire(
      "withdraw_requests",
      `status = 'pending' AND swap_json IS NULL AND created_at < ? AND ${isPlayersNextTrade("withdraw_requests")}${promoted}`,
      promoted ? [pendingFloor, adv.communism, adv.pool, pendingFloor, pendingFloor] : [pendingFloor],
      "pending too long",
    );
    // Claimed rows age on updated_at (the moment of claim). The bot's own
    // presence report corrects its status; nothing to free here.
    const claimedDep = expire("deposit_requests", "status = 'claimed' AND updated_at < ?", [claimedFloor], "claimed but never fulfilled");
    const claimedWd = expire("withdraw_requests", "status = 'claimed' AND swap_json IS NULL AND updated_at < ?", [claimedFloor], "claimed but never fulfilled");
    return { pendingTimedOut: pendingWd, claimedTimedOut: claimedDep + claimedWd };
  });
  const out = tx.immediate();
  for (const g of groups) emitRequest(g);
  return out;
}
