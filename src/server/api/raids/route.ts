import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionUser } from "@/lib/users";
import { AFK_SECONDS, createRaid, listRaids, MAX_DESCRIPTION, MAX_KEYS, MAX_PARTY, POP_EXTEND_S, POP_WINDOW_S, postingHold, raidBanned, raidWatchHook, sweepRaids } from "@/lib/raids";

// Raids — the group finder (lib/raids.ts, docs/RAIDS.md).
//
// GET  /api/raids  → { raids, me, limits, watchers }
//      Public. Each raid comes as the caller may see it: everyone gets the
//      region, description, raider list, the watcher's state and the pop
//      verdicts; the server and bazaar only reach a raider who joined the
//      AFK check, the party name a raider once the check is complete. `me`
//      is null when not logged in, else { ign, banned, hold } — `hold` says
//      whether the caller may post (strikes: a cooldown `until`, or blocked).
//      `watchers` says whether a fleet watcher can confirm pops at all.
// POST /api/raids  { dungeonId, server, location, party?, description?, keys? } → { raid }
//      Logged in only; one open raid per leader.
//
// The list is per-viewer (it depends on who is asking), so unlike /api/pool
// it is not served from a shared snapshot. It is a handful of rows.

export async function GET(req: Request) {
  const db = getDb();
  // Time-driven stage changes are applied before answering, so a countdown
  // that just hit zero reads as the next stage even between scheduler ticks.
  sweepRaids(db);
  const me = sessionUser(db, req);
  return json(
    {
      ok: true,
      raids: listRaids(db, me ? { userId: me.userId, ign: me.ign } : null),
      me: me ? { ign: me.ign, banned: raidBanned(db, me.userId), hold: postingHold(db, me.userId) } : null,
      limits: { description: MAX_DESCRIPTION, party: MAX_PARTY, keys: MAX_KEYS, afkSeconds: AFK_SECONDS, popWindowSeconds: POP_WINDOW_S, popExtendSeconds: POP_EXTEND_S },
      watchers: raidWatchHook() !== null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`raids:post:${ip}`, 5, 5 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in to post a raid." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = createRaid(db, me, { dungeonId: body.dungeonId, server: body.server, location: body.location, party: body.party, description: body.description, keys: body.keys });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json({ ok: true, raid: r.raid });
}
