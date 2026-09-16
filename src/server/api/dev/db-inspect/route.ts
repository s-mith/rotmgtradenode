import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { presence } from "@/lib/fleetPresence";
import { checkDevPassword } from "@/lib/devauth";

// GET /api/dev/db-inspect
// Diagnostic snapshot of the rows the supervisor cares about. Helps figure
// out why a particular bot isn't being chosen or why a withdraw can't find
// candidates. Auth via DEV_PASSWORD header so it's not just a public dump.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  const now = Date.now();

  const bots = presence
    .all()
    .map((b) => ({ ...b, staleness_ms: now - b.lastSeen }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  // The bot_inventory table is gone; inventory lives in the fleet tracker.
  const inventory: unknown[] = [];

  const openWithdraws = db
    .prepare(
      `SELECT id, ign, server, items_json, status, claimed_by,
              ? - created_at AS age_ms
       FROM withdraw_requests
       WHERE status IN ('pending','claimed')
       ORDER BY id`,
    )
    .all(now);

  const openDeposits = db
    .prepare(
      `SELECT id, ign, server, item_count, status, claimed_by,
              ? - created_at AS age_ms
       FROM deposit_requests
       WHERE status IN ('pending','claimed')
       ORDER BY id`,
    )
    .all(now);

  return json({ now, bots, inventory, openWithdraws, openDeposits });
}
