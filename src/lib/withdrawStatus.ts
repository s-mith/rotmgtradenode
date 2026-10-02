// Aggregate status of a withdraw group, shared by the website's poll endpoint
// (/api/request-status/withdraw-group/<id>) and the In Flight list
// (/api/requests/mine). One request may have been split into several rows
// (one per fulfilling bot); this rolls them up the way the page shows them.
import type Database from "better-sqlite3";
import { pyrelay } from "./devauth";
import { presence } from "./fleetPresence";

export type WithdrawGroupTrade = { requestId: number; status: string; botIgn: string | null; endReason?: string | null };
export type WithdrawGroupStatus = {
  groupId: string;
  groupStatus: "in-flight" | "fulfilled" | "partial" | "cancelled";
  tradeCount: number;
  trades: WithdrawGroupTrade[];
  /** Why the group's trades that ended unfulfilled ended (the first such reason), else null. */
  endReason: string | null;
};

export async function withdrawGroupStatus(db: Database.Database, groupId: string): Promise<WithdrawGroupStatus | null> {
  const rows = (
    db
      .prepare("SELECT id, status, claimed_by, target_bot_guid, end_reason FROM withdraw_requests WHERE group_id = ? ORDER BY id ASC")
      .all(groupId) as { id: number; status: string; claimed_by: string | null; target_bot_guid: string | null; end_reason: string | null }[]
  ).map((r) => ({ ...r, bot_ign: presence.ignFor(r.claimed_by) || null, target_bot_ign: presence.ignFor(r.target_bot_guid) || null }));
  if (rows.length === 0) return null;

  // Presence only knows bots that have reported. For rows pinned to a bot
  // that is still offline, fall back to the fleet's botMeta for the IGN so
  // the "/trade <bot>" hint can show before the bot is even up.
  const missingGuids = new Set<string>();
  for (const r of rows) {
    if (!r.bot_ign && r.claimed_by) missingGuids.add(r.claimed_by);
    if (!r.bot_ign && !r.target_bot_ign && r.target_bot_guid) missingGuids.add(r.target_bot_guid);
  }
  const pyrelayIgn = new Map<string, string>();
  if (missingGuids.size > 0) {
    const p = await pyrelay.pool();
    if (p.ok) for (const [guid, m] of Object.entries(p.data.botMeta ?? {})) if (missingGuids.has(guid) && m.ign) pyrelayIgn.set(guid, m.ign);
  }
  const trades = rows.map((r) => ({
    requestId: r.id,
    status: r.status,
    ...(r.status === "cancelled" && r.end_reason ? { endReason: r.end_reason } : {}),
    botIgn:
      r.bot_ign ??
      r.target_bot_ign ??
      (r.claimed_by ? pyrelayIgn.get(r.claimed_by) ?? null : null) ??
      (r.target_bot_guid ? pyrelayIgn.get(r.target_bot_guid) ?? null : null),
  }));
  const counts = { pending: 0, claimed: 0, fulfilled: 0, cancelled: 0, failed: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status as keyof typeof counts]++;
  let groupStatus: WithdrawGroupStatus["groupStatus"];
  if (counts.pending + counts.claimed > 0) groupStatus = "in-flight";
  else if (counts.fulfilled === rows.length) groupStatus = "fulfilled";
  else if (counts.fulfilled > 0) groupStatus = "partial";
  else groupStatus = "cancelled";
  const endReason = rows.find((r) => r.status === "cancelled" && r.end_reason)?.end_reason ?? null;
  return { groupId, groupStatus, tradeCount: rows.length, trades, endReason };
}
