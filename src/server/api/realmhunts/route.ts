import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionUser } from "@/lib/users";
import { CALL_IDLE_MS, createHunt, JOIN_COUNT_WINDOW_S, listHunts, realmHuntHook, REGIONS, sweepHunts } from "@/lib/realmhunts";

// Realm hunts (lib/realmhunts.ts, docs/REALMHUNTS.md).
//
// GET  /api/realmhunts  → { hunts, me, regions, limits, hunters }
//      Public. Every hunt with its server, realm, party name, members, the
//      hunter's state and its calls; nothing is hidden. `hunters` says
//      whether a fleet is attached to send bots at all.
// POST /api/realmhunts  { dungeonId, region } → { hunt }
//      Logged in only; one open hunt per requester, one per dungeon+region.

export async function GET(req: Request) {
  const db = getDb();
  sweepHunts(db);
  const me = sessionUser(db, req);
  return json(
    {
      ok: true,
      hunts: listHunts(db, me ? { userId: me.userId, ign: me.ign } : null),
      me: me ? { ign: me.ign } : null,
      regions: REGIONS,
      limits: { joinWindowSeconds: JOIN_COUNT_WINDOW_S, idleMinutes: CALL_IDLE_MS / 60_000 },
      hunters: realmHuntHook() !== null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`realmhunts:post:${ip}`, 5, 5 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to request a hunt." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = createHunt(db, me, { dungeonId: body.dungeonId, region: body.region });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, hunt: r.hunt });
}
