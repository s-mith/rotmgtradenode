import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { stylesFor } from "@/lib/cosmetics";

// GET /api/name-styles?igns=a,b,c -> { styles: { <ignLower>: NameStyle } }
//
// Bulk name-effect lookup for render sites whose own endpoint doesn't carry
// the style — the operator console's lists, and anything added later. The
// endpoints that build a player list themselves (/api/leaderboard,
// /api/recent, /api/profile) still embed the style directly, which saves
// their pages this second round trip.
//
// Public, and deliberately so: an effect is visible to everyone on the
// leaderboard the moment it's set, so there's nothing here that isn't
// already on the front page. Only granted, non-plain players come back, so
// an absent key means "no effect", not "no such player" — this is not a
// way to enumerate who exists.


// One board is 50 names; 100 covers the biggest caller with room to spare.
const MAX_IGNS = 100;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("igns") ?? "";
  const igns = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 32 && /^[a-z]+$/.test(s))
    .slice(0, MAX_IGNS);

  if (igns.length === 0) return json({ ok: true, styles: {} });
  return json({ ok: true, styles: stylesFor(getDb(), igns) });
}
