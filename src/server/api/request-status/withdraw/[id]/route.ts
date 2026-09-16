import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { presence } from "@/lib/fleetPresence";

// GET /api/request-status/withdraw/<id>
// Public, no auth. The website's withdraw form polls this after submit so it
// can show the user the assigned bot's IGN ("trade <bot> in nexus") once a
// bot claims the request. Status is one of:
//   pending   - no bot claimed yet
//   claimed   - bot picked up; bot.ign returned in `botIgn`
//   fulfilled - trade completed
//   cancelled - timed out or operator-cancelled
export async function GET(
  _req: Request,
  ctx: { params: { id: string } },
) {
  const { id } = ctx.params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId < 1) {
    return json({ error: "Invalid id" }, { status: 400 });
  }

  const db = getDb();
  // The bot IGN comes from live presence once the request is claimed.
  // No PII risk: bot IGNs are public in Realm anyway.
  const row = db
    .prepare("SELECT id, status, claimed_by FROM withdraw_requests WHERE id = ?")
    .get(requestId) as { id: number; status: string; claimed_by: string | null } | undefined;

  if (!row) return json({ error: "not found" }, { status: 404 });

  return json({
    requestId: row.id,
    status: row.status,
    botIgn: presence.ignFor(row.claimed_by) || null,
  });
}
