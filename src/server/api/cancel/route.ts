import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sweepStaleRequests } from "@/lib/timeouts";
import { cancelOpenRequests } from "@/lib/cancelCode";
import { sessionFromRequest } from "@/lib/session";

// POST /api/cancel            { groupId? }
// Cancel the logged-in player's open requests — one group when `groupId` is
// given (the In Flight panel's per-request button), else all of them. No code
// challenge — the session already proves control of the character (that's
// what the old whispered cancel code was standing in for). Acts only on the
// session's own IGN. Not rate-limited: a cancel only ever closes the player's
// own requests, and making those is limited already.
export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) {
    return json({ error: "Log in to cancel your requests." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { groupId?: unknown };
  const groupId = typeof body.groupId === "string" && /^[a-f0-9-]{32,40}$/i.test(body.groupId) ? body.groupId : null;
  const db = getDb();
  sweepStaleRequests(db);
  const out = cancelOpenRequests(db, session.ignLower, groupId);
  return json({ ok: true, ...out });
}
