import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { missionProgress } from "@/lib/skinRedeem";
import { sweepStaleRequests } from "@/lib/timeouts";

// GET /api/missions?ign=<name> — that player's mission balance: live NET
// progress from the ledger, redemptions earned and spent, and the redemption
// in flight if there is one (see lib/skinRedeem.ts).
export async function GET(req: Request) {
  const ignLower = (new URL(req.url).searchParams.get("ign") ?? "").trim().toLowerCase();
  if (!ignLower || ignLower.length > 32) return json({ error: "Bad ign" }, { status: 400 });
  const db = getDb();
  sweepStaleRequests(db);
  const p = missionProgress(db, ignLower);
  return json({ ok: true, ...p.stats, earned: p.earned, used: p.used, available: p.available, open: p.open }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
