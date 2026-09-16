import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { listGrants, removeGrant, setEnabled } from "@/lib/cosmetics";

// Operator console for donator name effects.
//
// GET    /api/dev/cosmetics — every grant row, granted first.
// POST   /api/dev/cosmetics — { ign, enabled } grants or revokes. Revoking
//        keeps the row (and the player's chosen style) so a re-grant puts
//        their name back the way they had it.
// DELETE /api/dev/cosmetics — { ign } drops the row entirely, discarding
//        the style pick. Use when you want a clean slate, not a pause.
//
// Same IGN rules as the rate-limit console so ign_lower lines up with what
// the ledger and the session cookie store.


function parseIgn(v: unknown): { ign: string; ignLower: string } | null {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32 || !/^[A-Za-z]+$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  return json({ ok: true, grants: listGrants(getDb()) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
  if (typeof body.enabled !== "boolean")
    return json({ error: "enabled must be a boolean" }, { status: 400 });

  const grant = setEnabled(getDb(), ign.ign, ign.ignLower, body.enabled);
  return json({ ok: true, grant });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });

  if (!removeGrant(getDb(), ign.ignLower))
    return json({ error: "No cosmetics row for that IGN" }, { status: 404 });
  return json({ ok: true });
}
