import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionUser } from "@/lib/users";
import { donateInstances } from "@/lib/vault";

// POST /api/vault/donate { instanceIds }
// Give vault items to the pool. Instant, and credited like a deposit.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`vault-donate:${ip}`, 10, 10 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to donate items." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { instanceIds?: unknown };
  if (!Array.isArray(body.instanceIds) || body.instanceIds.length === 0) return json({ error: "Pick at least 1 item." }, { status: 400 });
  const ids: string[] = [];
  for (const raw of body.instanceIds) {
    if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(raw)) return json({ error: `Invalid instance id: ${String(raw)}` }, { status: 400 });
    ids.push(raw);
  }
  const r = donateInstances(db, me, ids);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, donated: r.donated, seasonal: r.seasonal, used: r.used, slots: r.slots });
}
