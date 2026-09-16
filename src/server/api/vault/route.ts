import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { pyrelay } from "@/lib/devauth";
import { sessionUser } from "@/lib/users";
import { vaultView } from "@/lib/vault";

// GET /api/vault — the logged-in account's personal storage: allocation,
// slots, the bot dedicated to it, and every item with where the fleet sees it
// right now. Private: only the owner ever sees these instances (the public
// pool leaves them out).
export async function GET(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to see your vault." }, { status: 401 });
  const pool = await pyrelay.pool();
  return json({ ok: true, ign: me.ign, ...vaultView(db, me.userId, pool.ok ? pool.data : null), live: pool.ok });
}
