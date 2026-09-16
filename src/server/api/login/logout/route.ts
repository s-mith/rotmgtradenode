import { json, setCookie } from "@/server/http";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

// POST /api/login/logout -> clears the session cookie.
export async function POST() {
  const out = json({ ok: true });
  setCookie(out, SESSION_COOKIE, "", sessionCookieOptions(0));
  return out;
}
