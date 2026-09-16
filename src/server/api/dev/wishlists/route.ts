import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { listAllWishlists } from "@/lib/wishlist";

// Operator view of every player's standing claims (lib/wishlist.ts).
//
// GET /api/dev/wishlists — { players: [{ userId, igns, access, room, rules }] }
//
// Read-only: a wish is the player's to keep or drop. Revoking the feature
// (Feature access) leaves wishes in place but stops them being served.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  return json({ ok: true, players: listAllWishlists(getDb()) });
}
