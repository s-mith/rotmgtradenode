import type Database from "better-sqlite3";

// Who is pulling how much off the API, for the operator (dev console →
// Players → Traffic). Railway bills the bytes that leave the container, and
// nearly all of them are API responses, so every /api response is attributed
// to a visitor — the session's IGN when logged in, the client IP otherwise —
// and summed by route into hourly buckets. The request path only touches a
// Map; the scheduler flushes it to `traffic_hourly` every half minute and
// keeps RETENTION_DAYS of history. The report ranks visitors over a window
// and flags the ones far above the crowd: the tab left open on a slow
// machine that never stops refetching, the script polling /api/pool, the
// account that is somehow awake all day.

export const RETENTION_DAYS = 14;
const HOUR = 3_600_000;
/** Beyond this many unflushed cells new visitors are dropped rather than grow without bound (the flush normally empties it every 30s). */
const MAX_PENDING = 200_000;
/** A visitor is flagged when it moves at least this much AND this many times the typical visitor. */
export const UNUSUAL_MIN_BYTES = 25 * 1024 * 1024;
export const UNUSUAL_MIN_REQUESTS = 2_000;
export const UNUSUAL_FACTOR = 5;

type Cell = { requests: number; bytes: number };

// hour|who|route → counts, for what the scheduler hasn't written yet.
let pending = new Map<string, Cell>();

/** "ign:<lowercase name>" for a logged-in visitor, "ip:<address>" otherwise. */
export function visitorKey(ignLower: string | null, ip: string): string {
  return ignLower ? `ign:${ignLower}` : `ip:${ip}`;
}

/** One response went out: `bytes` of body on `route` to `who`. */
export function recordTraffic(who: string, route: string, bytes: number, now = Date.now()): void {
  const hour = Math.floor(now / HOUR) * HOUR;
  const key = `${hour}|${who}|${route}`;
  const cell = pending.get(key);
  if (cell) {
    cell.requests++;
    cell.bytes += bytes;
  } else if (pending.size < MAX_PENDING) {
    pending.set(key, { requests: 1, bytes });
  }
}

/** How many cells wait for the next flush (tests, the report's freshness note). */
export function pendingTrafficCells(): number {
  return pending.size;
}

let tableReady = new WeakSet<Database.Database>();

function ensureTable(db: Database.Database): void {
  if (tableReady.has(db)) return;
  // Operational telemetry, not player data: created on first use rather
  // than numbered with the schema migrations, so a branch adding it never
  // collides with one adding a real table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS traffic_hourly (
      hour INTEGER NOT NULL,
      who TEXT NOT NULL,
      route TEXT NOT NULL,
      requests INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (hour, who, route)
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_hour ON traffic_hourly(hour);
  `);
  tableReady.add(db);
}

/** Write what has accumulated since the last flush, and drop history past the retention. */
export function flushTraffic(db: Database.Database, now = Date.now()): { cells: number } {
  ensureTable(db);
  const batch = pending;
  pending = new Map();
  if (batch.size) {
    const up = db.prepare(
      `INSERT INTO traffic_hourly (hour, who, route, requests, bytes) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hour, who, route) DO UPDATE SET requests = requests + excluded.requests, bytes = bytes + excluded.bytes`,
    );
    db.transaction(() => {
      for (const [key, c] of batch) {
        const first = key.indexOf("|");
        const second = key.indexOf("|", first + 1);
        up.run(Number(key.slice(0, first)), key.slice(first + 1, second), key.slice(second + 1), c.requests, c.bytes);
      }
    })();
  }
  db.prepare("DELETE FROM traffic_hourly WHERE hour < ?").run(now - RETENTION_DAYS * 24 * HOUR);
  return { cells: batch.size };
}

/** Forget everything unflushed (tests). */
export function resetTraffic(): void {
  pending = new Map();
  tableReady = new WeakSet();
}

export interface VisitorReport {
  who: string;
  kind: "ign" | "ip";
  /** The IGN (as last seen, lowercase) or the IP. */
  id: string;
  requests: number;
  bytes: number;
  /** Distinct hours with any traffic, and the first and last of them. */
  activeHours: number;
  firstHour: number;
  lastHour: number;
  /** Of the window's bytes. */
  share: number;
  routes: { route: string; requests: number; bytes: number }[];
  unusual: boolean;
  why: string | null;
}

export interface TrafficReport {
  from: number;
  to: number;
  hours: number;
  total: { requests: number; bytes: number; visitors: number };
  /** The median visitor in the window — what "usual" means for the flags. */
  typical: { requests: number; bytes: number };
  visitors: VisitorReport[];
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Every visitor of the last `hours`, busiest first, with what they hit.
 * Reads the table and the unflushed cells together, so it is current to the
 * request. A visitor is unusual when it is far above the median on bytes or
 * on requests and above an absolute floor, so a quiet site with three
 * visitors doesn't flag whoever happened to load the pool twice.
 */
export function trafficReport(db: Database.Database, opts: { hours?: number; limit?: number; now?: number } = {}): TrafficReport {
  ensureTable(db);
  const now = opts.now ?? Date.now();
  const hours = Math.max(1, Math.min(24 * RETENTION_DAYS, Math.floor(opts.hours ?? 24)));
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const from = Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR;
  type Acc = { requests: number; bytes: number; hours: Set<number>; routes: Map<string, Cell> };
  const acc = new Map<string, Acc>();
  const add = (hour: number, who: string, route: string, requests: number, bytes: number) => {
    if (hour < from) return;
    let a = acc.get(who);
    if (!a) {
      a = { requests: 0, bytes: 0, hours: new Set(), routes: new Map() };
      acc.set(who, a);
    }
    a.requests += requests;
    a.bytes += bytes;
    a.hours.add(hour);
    const r = a.routes.get(route);
    if (r) {
      r.requests += requests;
      r.bytes += bytes;
    } else a.routes.set(route, { requests, bytes });
  };
  const rows = db.prepare("SELECT hour, who, route, requests, bytes FROM traffic_hourly WHERE hour >= ?").all(from) as { hour: number; who: string; route: string; requests: number; bytes: number }[];
  for (const r of rows) add(r.hour, r.who, r.route, r.requests, r.bytes);
  for (const [key, c] of pending) {
    const first = key.indexOf("|");
    const second = key.indexOf("|", first + 1);
    add(Number(key.slice(0, first)), key.slice(first + 1, second), key.slice(second + 1), c.requests, c.bytes);
  }

  const totalBytes = [...acc.values()].reduce((n, a) => n + a.bytes, 0);
  const totalRequests = [...acc.values()].reduce((n, a) => n + a.requests, 0);
  const typical = { requests: median([...acc.values()].map((a) => a.requests)), bytes: median([...acc.values()].map((a) => a.bytes)) };
  const visitors: VisitorReport[] = [...acc]
    .map(([who, a]) => {
      const hoursList = [...a.hours].sort((x, y) => x - y);
      const byteRatio = typical.bytes > 0 ? a.bytes / typical.bytes : Infinity;
      const reqRatio = typical.requests > 0 ? a.requests / typical.requests : Infinity;
      const bigBytes = a.bytes >= UNUSUAL_MIN_BYTES && byteRatio >= UNUSUAL_FACTOR;
      const manyReqs = a.requests >= UNUSUAL_MIN_REQUESTS && reqRatio >= UNUSUAL_FACTOR;
      const why = bigBytes && manyReqs
        ? `${fmtRatio(byteRatio)} the typical visitor's bytes and ${fmtRatio(reqRatio)} its requests`
        : bigBytes
          ? `${fmtRatio(byteRatio)} the typical visitor's bytes`
          : manyReqs
            ? `${fmtRatio(reqRatio)} the typical visitor's requests`
            : null;
      const sep = who.indexOf(":");
      return {
        who,
        kind: (who.slice(0, sep) === "ign" ? "ign" : "ip") as "ign" | "ip",
        id: who.slice(sep + 1),
        requests: a.requests,
        bytes: a.bytes,
        activeHours: hoursList.length,
        firstHour: hoursList[0] ?? from,
        lastHour: hoursList[hoursList.length - 1] ?? from,
        share: totalBytes > 0 ? a.bytes / totalBytes : 0,
        routes: [...a.routes].map(([route, c]) => ({ route, ...c })).sort((x, y) => y.bytes - x.bytes || y.requests - x.requests).slice(0, 8),
        unusual: bigBytes || manyReqs,
        why,
      };
    })
    .sort((x, y) => y.bytes - x.bytes || y.requests - x.requests)
    .slice(0, limit);
  return { from, to: now, hours, total: { requests: totalRequests, bytes: totalBytes, visitors: acc.size }, typical, visitors };
}

function fmtRatio(r: number): string {
  if (!Number.isFinite(r)) return "all of";
  return r >= 100 ? `${Math.round(r)}×` : `${Math.round(r * 10) / 10}×`;
}
