import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkDevPassword } from "@/lib/devauth";

// POST /api/dev/cancel-open
// Hard-cancels every pending+claimed deposit/withdraw request. Use this
// after a code change to clear out stuck rows from a previous schema or
// when the server thinks items are reserved but no real user is waiting.
export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  const now = Date.now();
  const result = db.transaction(() => {
    const w = db
      .prepare(
        `UPDATE withdraw_requests SET status = 'cancelled', updated_at = ?
         WHERE status IN ('pending', 'claimed')`,
      )
      .run(now);
    const d = db
      .prepare(
        `UPDATE deposit_requests SET status = 'cancelled', updated_at = ?
         WHERE status IN ('pending', 'claimed')`,
      )
      .run(now);
    return { withdrawsCancelled: w.changes, depositsCancelled: d.changes };
  })();

  return json({ ok: true, ...result });
}
