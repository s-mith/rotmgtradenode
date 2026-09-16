import type Database from "better-sqlite3";

// Operator-imposed per-player withdraw caps. A row in player_rate_limits
// means "this IGN may take at most items_per_day items per rolling 24h
// window until expires_at". The withdraw route calls checkWithdrawAllowance
// inside its write transaction; the /api/dev/rate-limits console manages
// the rows. Deposits are never limited — giving to the pool is always fine.

export type PlayerRateLimit = {
  ignLower: string;
  ign: string;
  itemsPerDay: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

type LimitRow = {
  ign_lower: string;
  ign: string;
  items_per_day: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

function rowToLimit(r: LimitRow): PlayerRateLimit {
  return {
    ignLower: r.ign_lower,
    ign: r.ign,
    itemsPerDay: r.items_per_day,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function listLimits(db: Database.Database): PlayerRateLimit[] {
  // Prune expired rows on read — the console is the only reader, so this
  // doubles as garbage collection without needing a background sweep.
  db.prepare("DELETE FROM player_rate_limits WHERE expires_at <= ?").run(Date.now());
  const rows = db
    .prepare("SELECT * FROM player_rate_limits ORDER BY ign_lower")
    .all() as LimitRow[];
  return rows.map(rowToLimit);
}

export function setLimit(
  db: Database.Database,
  ign: string,
  ignLower: string,
  itemsPerDay: number,
  days: number,
): PlayerRateLimit {
  const now = Date.now();
  db.prepare(
    `INSERT INTO player_rate_limits
       (ign_lower, ign, items_per_day, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ign_lower) DO UPDATE SET
       ign = excluded.ign,
       items_per_day = excluded.items_per_day,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run(ignLower, ign, itemsPerDay, now + days * DAY_MS, now, now);
  const row = db
    .prepare("SELECT * FROM player_rate_limits WHERE ign_lower = ?")
    .get(ignLower) as LimitRow;
  return rowToLimit(row);
}

export function removeLimit(db: Database.Database, ignLower: string): boolean {
  const r = db.prepare("DELETE FROM player_rate_limits WHERE ign_lower = ?").run(ignLower);
  return r.changes > 0;
}

// Items the IGN has claimed from the pool in the rolling 24h window:
// fulfilled withdraws (transactions ledger) plus everything committed in
// still-open withdraw rows — counting open rows stops a player from
// queueing past the cap before any trade completes.
export function withdrawUsage(db: Database.Database, ignLower: string, now = Date.now()): number {
  const fulfilled = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty), 0) AS n FROM transactions
         WHERE kind = 'withdraw' AND ign_lower = ? AND created_at >= ?`,
      )
      .get(ignLower, now - DAY_MS) as { n: number }
  ).n;
  const openRows = db
    .prepare(
      `SELECT items_json FROM withdraw_requests
       WHERE ign_lower = ? AND status IN ('pending','claimed')`,
    )
    .all(ignLower) as { items_json: string }[];
  let open = 0;
  for (const row of openRows) {
    try {
      const items = JSON.parse(row.items_json);
      if (!Array.isArray(items)) continue;
      for (const it of items) open += Number(it?.qty) || 0;
    } catch {
      // malformed open row — the stale-request sweep will cancel it
    }
  }
  return fulfilled + open;
}

// Called from the withdraw route's write transaction (must stay sync).
export function checkWithdrawAllowance(
  db: Database.Database,
  ignLower: string,
  requested: number,
): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const row = db
    .prepare("SELECT * FROM player_rate_limits WHERE ign_lower = ? AND expires_at > ?")
    .get(ignLower, now) as LimitRow | undefined;
  if (!row) return { ok: true };
  const used = withdrawUsage(db, ignLower, now);
  if (used + requested > row.items_per_day) {
    const left = Math.max(0, row.items_per_day - used);
    return {
      ok: false,
      error:
        `Withdraw limit reached: this IGN is limited to ${row.items_per_day} ` +
        `item${row.items_per_day === 1 ? "" : "s"} per day (${left} left in the current 24h window).`,
    };
  }
  return { ok: true };
}
