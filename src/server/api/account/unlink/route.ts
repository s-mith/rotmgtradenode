import { json, setCookie } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkIgn } from "@/lib/validation";
import { sessionUser, unlinkIgn } from "@/lib/users";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, sessionCookieOptions, signSession } from "@/lib/session";

// POST /api/account/unlink { ign }
// Detach a character from this account. Unlinking the one the session is acting
// as switches the session to another linked character; the last character can't
// be unlinked (that would strand the vault).
export async function POST(req: Request) {
  const db = getDb();
  const me = sessionUser(db, req);
  if (!me) return json({ error: "Log in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = checkIgn((body as { ign?: unknown }).ign);
  if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
  const r = unlinkIgn(db, me.userId, parsed.ignLower);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  const active = parsed.ignLower === me.ignLower ? r.remaining[0] : me.igns.find((i) => i.ignLower === me.ignLower)!;
  const out = json({ ok: true, ign: active.ign, igns: r.remaining });
  if (parsed.ignLower === me.ignLower) setCookie(out, SESSION_COOKIE, signSession(active.ign), sessionCookieOptions(SESSION_MAX_AGE_S));
  return out;
}
