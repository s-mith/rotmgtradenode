import { json } from "@/server/http";
import { checkDevPassword } from "@/lib/devauth";
import { getDb } from "@/lib/db";
import {
  listLimits,
  removeLimit,
  setLimit,
  withdrawUsage,
} from "@/lib/playerLimits";

// Operator console for per-player withdraw caps.
//
// GET    /api/dev/rate-limits — active limits + each player's rolling-24h usage.
// POST   /api/dev/rate-limits — { ign, itemsPerDay, days } upserts a limit
//        (re-posting an existing IGN rewrites both the cap and the expiry).
// DELETE /api/dev/rate-limits — { ign } lifts the limit immediately.
//
// Same IGN rules as the player-facing forms (letters only, 1-32 chars) so a
// limit row always matches what deposit/withdraw would store in ign_lower.

function parseIgn(v: unknown): { ign: string; ignLower: string } | null {
  const ign = typeof v === "string" ? v.trim() : "";
  if (!ign || ign.length > 32 || !/^[A-Za-z]+$/.test(ign)) return null;
  return { ign, ignLower: ign.toLowerCase() };
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const db = getDb();
  const limits = listLimits(db).map((l) => ({
    ...l,
    usedToday: withdrawUsage(db, l.ignLower),
  }));
  return json({ ok: true, limits });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });
  const itemsPerDay = Number(body.itemsPerDay);
  if (!Number.isInteger(itemsPerDay) || itemsPerDay < 1 || itemsPerDay > 1000)
    return json({ error: "itemsPerDay must be 1-1000" }, { status: 400 });
  const days = Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    return json({ error: "days must be 1-365" }, { status: 400 });

  const db = getDb();
  const limit = setLimit(db, ign.ign, ign.ignLower, itemsPerDay, days);
  return json({
    ok: true,
    limit: { ...limit, usedToday: withdrawUsage(db, limit.ignLower) },
  });
}

export async function DELETE(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const ign = parseIgn(body.ign);
  if (!ign) return json({ error: "Invalid IGN (letters only, 1-32 chars)" }, { status: 400 });

  const db = getDb();
  const removed = removeLimit(db, ign.ignLower);
  if (!removed) return json({ error: "No limit found for that IGN" }, { status: 404 });
  return json({ ok: true });
}
