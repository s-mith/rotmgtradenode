import { json, type RouteContext } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionUser } from "@/lib/users";
import { advanceRaid, callWatcher, endRaid, extendPop, getRaid, joinRaid, leaveRaid, nextPop } from "@/lib/raids";

// One raid (lib/raids.ts).
//
// GET  /api/raids/:id              → { raid } as the caller may see it
// POST /api/raids/:id { action }   → { raid }
//      action: join | leave | advance | end | next | extend | call.
//      Logged in only. advance moves the raid on (headcount → AFK check →
//      pop, running → ended), next opens the next key's pop window, extend
//      lengthens the open one, call orders the watcher early; those five are
//      the leader's, and a leader who leaves ends the raid.

type Params = { id: string };

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request, { params }: RouteContext<Params>) {
  const id = parseId(params.id);
  if (id === null) return json({ error: "Bad id" }, { status: 400 });
  const db = getDb();
  const me = sessionUser(db, req);
  const raid = getRaid(db, id, me ? { userId: me.userId, ign: me.ign } : null);
  if (!raid) return json({ error: "That raid is gone." }, { status: 404 });
  return json({ ok: true, raid }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, { params }: RouteContext<Params>) {
  const id = parseId(params.id);
  if (id === null) return json({ error: "Bad id" }, { status: 400 });
  const ip = clientIp(req);
  if (!rateLimit(`raids:act:${ip}`, 30, 30 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to join a raid." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  const who = { userId: me.userId, ign: me.ign };
  const r =
    body.action === "join" ? joinRaid(db, who, id)
    : body.action === "leave" ? leaveRaid(db, who, id)
    : body.action === "advance" ? advanceRaid(db, who, id)
    : body.action === "end" ? endRaid(db, who, id)
    : body.action === "next" ? nextPop(db, who, id)
    : body.action === "extend" ? extendPop(db, who, id)
    : body.action === "call" ? callWatcher(db, who, id)
    : null;
  if (r === null) return json({ error: "action must be join, leave, advance, end, next, extend or call" }, { status: 400 });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, raid: r.raid });
}
