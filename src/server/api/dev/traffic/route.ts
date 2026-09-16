import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { flushTraffic, trafficReport, RETENTION_DAYS, UNUSUAL_FACTOR, UNUSUAL_MIN_BYTES, UNUSUAL_MIN_REQUESTS } from "@/lib/traffic";

// GET /api/dev/traffic?hours=24&limit=50
// Who is pulling how much off the API (lib/traffic.ts): every visitor of the
// window — a logged-in IGN, or an IP for the logged-out — busiest first,
// with the routes they hit and a flag for the ones far above the typical
// visitor. Flushes the in-memory counters first so the answer is current.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? 24);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * RETENTION_DAYS) return json({ error: `hours must be 1-${24 * RETENTION_DAYS}` }, { status: 400 });
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) return json({ error: "limit must be 1-500" }, { status: 400 });
  const db = getDb();
  flushTraffic(db);
  const report = trafficReport(db, { hours, limit });
  return json({ ok: true, ...report, rules: { minBytes: UNUSUAL_MIN_BYTES, minRequests: UNUSUAL_MIN_REQUESTS, factor: UNUSUAL_FACTOR, retentionDays: RETENTION_DAYS } });
}
