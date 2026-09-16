import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { computePlayers } from "@/lib/leaderboard";
import { disqualify, listDisqualified, requalify } from "@/lib/leaderboardDq";

// Operator console for leaderboard disqualifications.
//
// GET    /api/dev/leaderboard-dq — who is currently off the boards, and what
//        each of them would score if they were put back.
// POST   /api/dev/leaderboard-dq — { ign, reason? } takes them off (re-posting
//        an existing IGN just rewrites the reason).
// DELETE /api/dev/leaderboard-dq — { ign } puts them back.
//
// This hides a player; it never edits the ledger. Their transactions, points
// and profile are untouched, so lifting a disqualification restores their
// exact position — see lib/leaderboardDq.ts.
//
// Same IGN rules as the player-facing forms (letters only, 1-32 chars), so a
// row always matches what deposit/withdraw stores in ign_lower. An IGN that
// has never traded is accepted: disqualifying pre-emptively is legitimate, and
// the row simply does nothing until they show up.

function parseIgn(v: unknown): { ign: string; ignLower: string } | null {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32 || !/^[A-Za-z]+$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}

const MAX_REASON = 200;

function parseReason(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  const reason = v.trim();
  return reason.length > MAX_REASON ? null : reason;
}

// The points a disqualified player would carry if requalified. Shown in the
// console because "should this stay?" is hard to answer against a bare name —
// a hidden 400-point account is a different decision from a hidden 2-point one.
function withScores(db: ReturnType<typeof getDb>) {
  const points = new Map(computePlayers(db).map((p) => [p.ignLower, p.points]));
  return (d: { ignLower: string }) => ({ ...d, points: points.get(d.ignLower) ?? 0 });
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  return json({ ok: true, disqualified: listDisqualified(db).map(withScores(db)) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) {
    return json(
      { error: "Invalid IGN (letters only, 1-32 chars)" },
      { status: 400 },
    );
  }
  const reason = parseReason(body.reason);
  if (reason === null) {
    return json(
      { error: `Reason must be text, ${MAX_REASON} characters or fewer` },
      { status: 400 },
    );
  }

  const db = getDb();
  const row = disqualify(db, ign.ign, ign.ignLower, reason);
  return json({ ok: true, disqualified: withScores(db)(row) });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) {
    return json(
      { error: "Invalid IGN (letters only, 1-32 chars)" },
      { status: 400 },
    );
  }

  const removed = requalify(getDb(), ign.ignLower);
  // Not an error when there was no row: the operator's intent ("this player
  // should be on the board") is satisfied either way, and two console tabs
  // open at once shouldn't produce a scary red line.
  return json({ ok: true, removed });
}
