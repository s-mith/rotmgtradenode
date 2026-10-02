// One in-game trade per player at a time.
//
// Realm only lets a player be in one trade window at once, so handing several
// bots work for the same IGN simultaneously never made them go faster — the
// bots just queued behind each other on pyrelay's per-partner lock while the
// player worked through them one by one.
//
// That queueing used to be actively harmful. A fragmented withdraw (the
// fragmenter splits across bots, and a bulk potion withdraw can produce a
// dozen fragments) had every row offered at once, so the bots at the back
// spent their whole trade-assignment budget waiting for a turn that hadn't
// come yet. Each timed out, unclaimed, disconnected and retried — and after a
// few rounds the row was abandoned, so the player never received part of their
// withdraw. It also burned a wake, a connection slot and an exit IP per bot
// that was only ever going to wait.
//
// So a row is only actionable when it is that player's NEXT trade:
//
//   1. nothing of theirs is currently claimed (in either table), and
//   2. it is the oldest pending row of its kind for them.
//
// (1) alone would serialize claiming, because claims are atomic — but the
// dispatcher sizes its wake budget from the pending list, so without (2) it
// would still wake a bot per fragment and let all but one idle out. Together
// the two mean exactly one bot is woken and exactly one row is claimable per
// player, with the next released the moment the previous is fulfilled.
//
// Applied everywhere a row is judged actionable — claiming, the pending list
// the dispatcher wakes from, and the stale-request sweep — so those views can
// never disagree about which rows are live.

type RequestTable = "withdraw_requests" | "deposit_requests";

/**
 * SQL predicate: true when this row is the player's next trade.
 *
 * `table` must be the table being selected/updated; the subqueries reference
 * it by name to correlate with the outer row, so it cannot be aliased at the
 * call site.
 *
 * Deadlock is bounded by the existing sweeps. A claimed row whose bot died is
 * cancelled after CLAIMED_TIMEOUT_MS, releasing everything queued behind it. A
 * head-of-queue withdraw that no bot can serve ages out on PENDING_TIMEOUT_MS,
 * and a deposit no account on the node can take is cancelled by the fleet
 * (relay/fleet/dispatcher.ts), promoting the next one — so a group that is
 * genuinely unservable drains rather than wedging.
 *
 * Cross-table ordering is only enforced at the claimed level: a player with a
 * pending deposit AND a pending withdraw and nothing in flight can have one of
 * each offered. That combination is not reachable through the normal UI, and
 * the claimed-check still stops the two from running at the same time.
 */
export function isPlayersNextTrade(table: RequestTable): string {
  return `
      ign_lower NOT IN (SELECT ign_lower FROM withdraw_requests WHERE status = 'claimed')
      AND ign_lower NOT IN (SELECT ign_lower FROM deposit_requests WHERE status = 'claimed')${table === "withdraw_requests" ? `
      AND ign_lower NOT IN (${CONTINUING_DEPOSITORS})` : ""}
      AND id = (SELECT MIN(q.id) FROM ${table} q
                 WHERE q.ign_lower = ${table}.ign_lower AND q.status = 'pending')`;
}

/**
 * Players whose deposit is continuing on the next empty bot (advanced
 * management, lib/queue.ts fulfillDeposit): a pending deposit row whose group
 * already has a fulfilled one. The rest of that deposit is still in their
 * inventory, so it goes before any withdraw they queued meanwhile. Without
 * advanced management no deposit continues, and this is always empty.
 */
export const CONTINUING_DEPOSITORS = `SELECT c.ign_lower FROM deposit_requests c
        WHERE c.status = 'pending' AND c.group_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM deposit_requests f WHERE f.group_id = c.group_id AND f.status = 'fulfilled')`;
