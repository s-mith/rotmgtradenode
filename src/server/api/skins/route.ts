import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { pyrelay } from "@/lib/devauth";
import { skinStock } from "@/lib/skinRedeem";

// GET /api/skins — the skins a player can redeem right now: held by a
// non-seasonal bot and not already promised to an open redemption. Skins are
// non-seasonal items only. Public: name, sprite and count.
export async function GET() {
  const pool = await pyrelay.pool();
  if (!pool.ok) return json({ ok: false, skins: [], error: "Bot service unavailable — try again in a minute." }, { status: 200 });
  return json({ ok: true, skins: skinStock(getDb(), pool.data) }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
