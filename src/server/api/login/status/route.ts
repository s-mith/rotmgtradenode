import { json, setCookie } from "@/server/http";
import { getDb } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { pollLogin } from "@/lib/login";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, sessionCookieOptions, signSession } from "@/lib/session";
import { checkIgn } from "@/lib/validation";
import { ignsOf, linkIgn, sessionUser, userForIgn } from "@/lib/users";

// POST /api/login/status   { code, link?: boolean }
// Poll whether the player's pasted "/tell <bot> <code>" has landed. "pending"
// until it does; once "verified", set the signed session cookie for the sender
// IGN and report it. Verified is single-use on pyrelay's side, so the first
// poll that sees it is the one that logs in.
//
// With `link: true` from a logged-in session the verified character is
// attached to the session's account instead: same proof, no cookie change, so
// the player keeps acting as the character they were on.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`login-status:${ip}`, 20, 5)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { code?: unknown; link?: unknown };
  const code = typeof body.code === "string" ? body.code : "";
  if (!/^[A-Za-z0-9]{4,32}$/.test(code)) {
    return json({ error: "Invalid code" }, { status: 400 });
  }

  // A link needs a session; check it before the poll, which spends a verified code.
  const db = getDb();
  const me = body.link === true ? sessionUser(db, req) : null;
  if (body.link === true && !me) {
    return json({ error: "Your session ended. Log in again, then link the character.", state: "logged-out" }, { status: 401 });
  }

  const res = await pollLogin(code);
  if (!res.ok) return json({ error: res.error }, { status: res.status });
  if (res.state !== "verified") {
    return json({ ok: true, state: res.state });
  }
  const verified = checkIgn(res.ign);
  if (!verified.ok) return json({ error: "The bot reported an unusable name." }, { status: 502 });

  if (me) {
    const r = linkIgn(db, me.userId, verified.ign, verified.ignLower);
    if (!r.ok) return json({ error: r.error, state: "verified" }, { status: r.status });
    return json({ ok: true, state: "verified", ign: me.ign, linked: verified.ign, igns: ignsOf(db, me.userId).map((i) => ({ ign: i.ign, linkedAt: i.linkedAt })) });
  }

  const userId = userForIgn(db, verified.ign, verified.ignLower);
  const out = json({ ok: true, state: "verified", ign: verified.ign, igns: ignsOf(db, userId).map((i) => ({ ign: i.ign, linkedAt: i.linkedAt })) });
  setCookie(out, SESSION_COOKIE, signSession(verified.ign), sessionCookieOptions(SESSION_MAX_AGE_S));
  return out;
}
