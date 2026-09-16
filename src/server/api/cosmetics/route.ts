import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sessionFromRequest } from "@/lib/session";
import { DEFAULT_STYLE, getGrant, parseNameStyle, setStyle } from "@/lib/cosmetics";

// The player's own name-effect settings, keyed off the session cookie —
// never off a submitted IGN, so nobody can restyle someone else's name.
//
// GET  /api/cosmetics -> { enabled, style }. `enabled: false` for everyone
//      who hasn't been granted effects; the menu stays hidden for them.
// POST /api/cosmetics  { style } -> stores the pick. The grant is re-checked
//      server-side in setStyle(): hiding the menu is a UI convenience, this
//      is the actual gate.


export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return json({ ok: true, enabled: false, style: DEFAULT_STYLE });

  const grant = getGrant(getDb(), s.ignLower);
  return json({
    ok: true,
    enabled: Boolean(grant?.enabled),
    style: grant?.style ?? DEFAULT_STYLE,
  });
}

export async function POST(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return json({ error: "Log in first." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const style = parseNameStyle(body.style);
  if (!style) return json({ error: "Bad style payload" }, { status: 400 });

  const res = setStyle(getDb(), s.ignLower, style);
  if (!res.ok) return json({ error: res.error }, { status: 403 });
  return json({ ok: true, enabled: true, style: res.grant.style });
}
