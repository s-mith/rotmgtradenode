import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";


// Operator-only view of deposits awaiting a bot. This used to be a public
// panel ("Awaiting Bot") backed by /api/requests, but exposing the live IGN +
// server of whoever was mid-deposit let people snipe/intercept them in game.
// The data now lives behind the dev password and is surfaced in the Deposits
// tab of the operator console. Every open deposit is listed: there is at most
// one per IGN, so the list is as long as the players depositing right now.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, ign, server, item_count, remaining_count, status, claimed_by, created_at FROM deposit_requests WHERE status IN ('pending','claimed') ORDER BY created_at DESC",
    )
    .all() as {
    id: number;
    ign: string;
    server: string;
    item_count: number;
    remaining_count: number | null;
    status: "pending" | "claimed";
    claimed_by: string | null;
    created_at: number;
  }[];

  return json({
    ok: true,
    // Surface remaining_count as `itemCount` — it's the user-meaningful
    // "still to deposit." Declared upper bound is preserved as
    // `declaredCount` if anyone wants it.
    requests: rows.map((r) => ({
      id: r.id,
      ign: r.ign,
      server: r.server,
      itemCount: r.remaining_count ?? r.item_count,
      declaredCount: r.item_count,
      status: r.status,
      claimedBy: r.claimed_by,
      createdAt: r.created_at,
    })),
  });
}
