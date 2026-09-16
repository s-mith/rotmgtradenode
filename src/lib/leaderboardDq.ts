// Leaderboard disqualification: an operator switch that takes one IGN off the
// public boards.
//
// Deliberately NOT a scoring change. The ledger is the record of what actually
// moved through the pool and nothing here edits it — a disqualified player's
// points are still computed, still shown on their own profile, and still
// correct the moment the row is removed. What they lose is placement: they
// don't appear on either board and they hold no rank, so everyone below them
// moves up rather than the board showing a gap.
//
// The rows are managed from /dev/settings (Leaderboard tab). There is no
// expiry — unlike a withdraw cap, "should this person be on the board" isn't a
// question that answers itself after N days.
import type Database from "better-sqlite3";

export type Disqualification = {
  ignLower: string;
  ign: string;
  /** Operator's note. Free text, may be empty. */
  reason: string;
  createdAt: number;
};

type DqRow = {
  ign_lower: string;
  ign: string;
  reason: string;
  created_at: number;
};

function rowToDq(r: DqRow): Disqualification {
  return { ignLower: r.ign_lower, ign: r.ign, reason: r.reason, createdAt: r.created_at };
}

export function listDisqualified(db: Database.Database): Disqualification[] {
  const rows = db
    .prepare("SELECT * FROM leaderboard_dq ORDER BY created_at DESC")
    .all() as DqRow[];
  return rows.map(rowToDq);
}

/**
 * The set of disqualified IGNs, lowercased.
 *
 * This is what computePlayers reads, so it runs on every board and profile
 * request — hence a single indexed scan of a table that holds a handful of
 * rows, rather than a per-player lookup.
 */
export function disqualifiedSet(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT ign_lower FROM leaderboard_dq").all() as {
    ign_lower: string;
  }[];
  return new Set(rows.map((r) => r.ign_lower));
}

/** Disqualify an IGN, or rewrite the reason on one already disqualified. */
export function disqualify(
  db: Database.Database,
  ign: string,
  ignLower: string,
  reason: string,
): Disqualification {
  const now = Date.now();
  db.prepare(
    `INSERT INTO leaderboard_dq (ign_lower, ign, reason, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ign_lower) DO UPDATE SET
       ign = excluded.ign,
       reason = excluded.reason`,
  ).run(ignLower, ign, reason, now);
  const row = db
    .prepare("SELECT * FROM leaderboard_dq WHERE ign_lower = ?")
    .get(ignLower) as DqRow;
  return rowToDq(row);
}

/** Put them back on the board. Returns false if they weren't disqualified. */
export function requalify(db: Database.Database, ignLower: string): boolean {
  return db.prepare("DELETE FROM leaderboard_dq WHERE ign_lower = ?").run(ignLower).changes > 0;
}
