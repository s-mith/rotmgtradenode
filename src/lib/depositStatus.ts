// Aggregate status of a deposit group, shared by the website's poll endpoint
// (/api/request-status/deposit-group/<id>) and the automation API
// (/api/ext/deposit/<id>). Both answer the same question — "has a bot come to
// meet me yet, and is the deposit still running?" — so they read it the same
// way.
import type Database from "better-sqlite3";
import { pyrelay } from "./devauth";
import { presence } from "./fleetPresence";

export type DepositGroupTrade = {
  requestId: number;
  status: string;
  /** The bot to trade, once one has been assigned. Null while pending. */
  botIgn: string | null;
};

export type DepositGroupStatus = {
  groupId: string;
  groupStatus: "in-flight" | "fulfilled" | "partial" | "cancelled";
  tradeCount: number;
  trades: DepositGroupTrade[];
  /** Why the deposit stopped, when it stopped for a reason other than the
   *  player under-filling a trade. Only 'vault-full' today; null otherwise. */
  endReason: string | null;
  /** The IGN the group was queued for — the automation API needs it to cancel. */
  ign: string;
  ignLower: string;
  /** Items actually received across the group so far (transactions ledger). */
  itemsDeposited: number;
};

export const GROUP_ID_RE = /^[a-f0-9-]{32,40}$/i;

/** Read a deposit group's status, or null if no such group exists. */
export async function depositGroupStatus(
  db: Database.Database,
  groupId: string,
): Promise<DepositGroupStatus | null> {
  const rawRows = db
    .prepare(
      `SELECT d.id, d.ign, d.ign_lower, d.status, d.claimed_by, d.target_bot_guid,
              d.end_reason,
              (SELECT COALESCE(SUM(t.qty), 0) FROM transactions t
                WHERE t.kind = 'deposit' AND t.request_id = d.id) AS deposited
       FROM deposit_requests d
       WHERE d.group_id = ?
       ORDER BY d.id ASC`,
    )
    .all(groupId) as {
    id: number;
    ign: string;
    ign_lower: string;
    status: string;
    claimed_by: string | null;
    target_bot_guid: string | null;
    end_reason: string | null;
    deposited: number;
  }[];
  const rows = rawRows.map((r) => ({
    ...r,
    bot_ign: presence.ignFor(r.claimed_by) || null,
    target_bot_ign: presence.ignFor(r.target_bot_guid) || null,
  }));

  if (rows.length === 0) return null;

  // Fall back to pyrelay's botMeta when the local `bots` table has no
  // row (offline bots may not have heartbeated yet). Same logic as the
  // withdraw-group route — see comment there.
  const missingGuids = new Set<string>();
  for (const r of rows) {
    if (!r.bot_ign && r.claimed_by) missingGuids.add(r.claimed_by);
    if (!r.bot_ign && !r.target_bot_ign && r.target_bot_guid)
      missingGuids.add(r.target_bot_guid);
  }
  const pyrelayIgn = new Map<string, string>();
  if (missingGuids.size > 0) {
    const p = await pyrelay.pool();
    if (p.ok) {
      for (const [guid, m] of Object.entries(p.data.botMeta ?? {})) {
        if (missingGuids.has(guid) && m.ign) pyrelayIgn.set(guid, m.ign);
      }
    }
  }

  const trades: DepositGroupTrade[] = rows.map((r) => ({
    requestId: r.id,
    status: r.status,
    botIgn:
      r.bot_ign ??
      r.target_bot_ign ??
      (r.claimed_by ? pyrelayIgn.get(r.claimed_by) ?? null : null) ??
      (r.target_bot_guid ? pyrelayIgn.get(r.target_bot_guid) ?? null : null),
  }));

  const counts = { pending: 0, claimed: 0, fulfilled: 0, cancelled: 0, failed: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof typeof counts]++;
  }
  let groupStatus: DepositGroupStatus["groupStatus"];
  if (counts.pending + counts.claimed > 0) groupStatus = "in-flight";
  else if (counts.fulfilled === rows.length) groupStatus = "fulfilled";
  else if (counts.fulfilled > 0) groupStatus = "partial";
  else groupStatus = "cancelled";

  return {
    groupId,
    groupStatus,
    tradeCount: rows.length,
    trades,
    // Deposits are one row per group in practice, so the first non-null
    // answers for the group.
    endReason: rows.find((r) => r.end_reason)?.end_reason ?? null,
    ign: rows[0]!.ign,
    ignLower: rows[0]!.ign_lower,
    itemsDeposited: rows.reduce((n, r) => n + (Number(r.deposited) || 0), 0),
  };
}
