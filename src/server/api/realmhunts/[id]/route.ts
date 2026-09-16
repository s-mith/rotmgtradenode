import { json, type RouteContext } from "@/server/http";
import { getDb } from "@/lib/db";
import { sessionUser } from "@/lib/users";
import { getHunt } from "@/lib/realmhunts";

// One realm hunt (lib/realmhunts.ts).
//
// GET /api/realmhunts/:id → { hunt }
//
// There is no POST: a hunt closes on its own (the hunter's 20-minute idle
// clock, the ceiling, a failed hunter) and an operator can close one from
// the dev console (/api/dev/realmhunts). Nobody else can.

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
  const hunt = getHunt(db, id, me ? { userId: me.userId, ign: me.ign } : null);
  if (!hunt) return json({ error: "That hunt is gone." }, { status: 404 });
  return json({ ok: true, hunt }, { headers: { "Cache-Control": "no-store" } });
}
