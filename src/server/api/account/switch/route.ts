import { json, setCookie } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkIgn } from "@/lib/validation";
import { sessionUser } from "@/lib/users";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, sessionCookieOptions, signSession } from "@/lib/session";

// POST /api/account/switch { ign }
// Act as another character linked to this account. Re-mints the session cookie
// for that IGN; nothing else changes — the vault and the linked list are the
// user's, the ledger rows written from now on are the new character's.
export async function POST(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = checkIgn((body as { ign?: unknown }).ign);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const target = me.igns.find((i) => i.ignLower === parsed.ignLower);
  if (!target) return json({ error: "That character isn't linked to this account." }, { status: 404 });
  const out = json({ ok: true, ign: target.ign, igns: me.igns });
  setCookie(out, SESSION_COOKIE, signSession(target.ign), sessionCookieOptions(SESSION_MAX_AGE_S));
  return out;
}
