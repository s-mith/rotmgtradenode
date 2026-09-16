import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { computePlayers, rankedPlayers } from "@/lib/leaderboard";
import { stylesFor } from "@/lib/cosmetics";


// GET /api/leaderboard
// Contribution ranking over the whole transactions ledger. Deposits earn
// points, withdrawals cost them, so the board rewards net givers. All
// scoring rules (era-scoped values, baseline carry-over) live in
// src/lib/leaderboard.ts, shared with /api/profile.
export async function GET() {
  const db = getDb();
  // rankedPlayers drops anyone the operator has disqualified
  // (lib/leaderboardDq.ts). Filtered before the slice, so a hidden player
  // doesn't silently cost the board one of its 50 places.
  const all = rankedPlayers(computePlayers(db));

  // Two boards: net givers ranked best-first, and net takers ranked
  // worst-first. Zero-point players appear on neither — they've squared
  // their account with the collective.
  const comrades = all.filter((p) => p.points > 0).slice(0, 50);
  const capitalists = all
    .filter((p) => p.points < 0)
    .sort((a, b) => a.points - b.points || a.ign.localeCompare(b.ign))
    .slice(0, 50);

  // Donator name effects for the ~100 names actually being sent, in one
  // query. Only granted players with a non-plain style come back, so the
  // payload is unchanged for a board with no donators on it.
  const styles = stylesFor(db, [...comrades, ...capitalists].map((p) => p.ignLower));
  // `disqualified` is dropped alongside ignLower: everything on this board is
  // by definition not disqualified, so shipping the flag would only invite a
  // client to think it means something here.
  const attach = ({ ignLower, disqualified: _dq, ...p }: (typeof all)[number]) => ({
    ...p,
    nameStyle: styles[ignLower] ?? null,
  });

  return json({
    comrades: comrades.map(attach),
    capitalists: capitalists.map(attach),
  });
}
