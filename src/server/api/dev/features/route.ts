import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import { FEATURES, grantFeature, isFeature, listFeatureGrants, revokeFeature } from "@/lib/features";

// Operator console for per-player feature access (lib/features.ts).
//
// GET    /api/dev/features — { features: {name: description}, grants: [...] }
// POST   /api/dev/features — { feature, ign } grants.
// DELETE /api/dev/features — { feature, ign } revokes.
//
// Same IGN rules as the other consoles so ign_lower lines up with the
// session cookie and the ledger.

function parseIgn(v: unknown): { ign: string; ignLower: string } | null {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32 || !/^[A-Za-z]+$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  return json({ ok: true, features: FEATURES, grants: listFeatureGrants(getDb()) });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
  if (!isFeature(body.feature)) return json({ error: "Unknown feature" }, { status: 400 });
  return json({ ok: true, grant: grantFeature(getDb(), body.feature, ign.ign, ign.ignLower) });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
  if (!isFeature(body.feature)) return json({ error: "Unknown feature" }, { status: 400 });
  if (!revokeFeature(getDb(), body.feature, ign.ignLower)) return json({ error: "No such grant" }, { status: 404 });
  return json({ ok: true });
}
