import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { deleteHunt, endHunt, listHuntEvents, listHunts, realmHuntHook } from "@/lib/realmhunts";

// Operator console for realm hunts (lib/realmhunts.ts, docs/REALMHUNTS.md).
// A hunt closes on its own (the hunter's idle clock, the ceiling, a failed
// hunter); this is the only place a person can close one.
//
// GET    /api/dev/realmhunts                      — every hunt (open, and ended within the hour) and the fleet's hunters
// GET    /api/dev/realmhunts?events=<hunt id>     — that hunt's audit log
// POST   /api/dev/realmhunts { op: "end", id }    — end a hunt now (the hunter leaves the party)
//        /api/dev/realmhunts { op: "delete", id } — remove it outright (its calls go with it; the audit stays)

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const db = getDb();
  const events = parseId(new URL(req.url).searchParams.get("events"));
  if (events !== null) return json({ ok: true, events: listHuntEvents(db, events) });
  const hook = realmHuntHook();
  return json({ ok: true, hunts: listHunts(db, null), huntersEnabled: hook !== null, hunters: hook?.list() ?? [] });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const db = getDb();
  const body = (await req.json().catch(() => ({}))) as { op?: unknown; id?: unknown };
  const id = parseId(body.id);
  if (id === null) return json({ error: "Bad id" }, { status: 400 });
  if (body.op === "end") {
    const r = endHunt(db, "operator", id);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json({ ok: true, hunt: r.hunt });
  }
  if (body.op === "delete") return json({ ok: deleteHunt(db, id) });
  return json({ error: "op must be end or delete" }, { status: 400 });
}
