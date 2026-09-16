import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkDevPassword } from "@/lib/devauth";
import { pyrelay } from "@/lib/devauth";
import { presence } from "@/lib/fleetPresence";
import { listRedemptions, skinInventory } from "@/lib/skinRedeem";

// GET /api/dev/skins — every skin with what the fleet holds of it (per pool,
// and which bots), plus recent redemptions. Skins enter the pool by trading
// them to any bot through a normal deposit; there is nothing to seed here.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const db = getDb();
  const pool = await pyrelay.pool();
  const skins = pool.ok ? skinInventory(db, pool.data) : null;
  const botIgnFor = (guid: string | null) => presence.ignFor(guid) || (guid && pool.ok ? pool.data.botMeta?.[guid]?.ign ?? "" : "");
  return json({ ok: true, skins, poolError: pool.ok ? null : pool.error, redemptions: listRedemptions(db, botIgnFor) });
}
