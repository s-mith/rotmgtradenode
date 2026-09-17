import { json } from "@/server/http";
import { checkDevPassword, guests } from "@/lib/devauth";

// GET  /api/dev/shares — grants mirrored from the hub, each guest's usage, recent guest requests.
// POST /api/dev/shares — { action: "grant", email, ign, slotsSeasonal, slotsNonseasonal, role, trade }
//                        { action: "update", id, ...patch (slotsSeasonal, slotsNonseasonal, role, trade, paused, ign) }
//                        { action: "revoke", id }
//                        { action: "refresh" }
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const g = guests();
  if (!g) return json({ error: "shared vaults are not running (the fleet is off)" }, { status: 503 });
  return json({ ok: true, ...g.status() }, { headers: { "Cache-Control": "no-store" } });
}

const ROLES = new Set(["deposit", "withdraw-own", "withdraw-any", "co-owner"]);
const slots = (v: unknown) => Math.max(0, Math.min(200, Number(v) || 0));

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const g = guests();
  if (!g) return json({ error: "shared vaults are not running (the fleet is off)" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Bad JSON" }, { status: 400 });
  switch (body.action) {
    case "grant": {
      const role = String(body.role ?? "deposit");
      if (!ROLES.has(role)) return json({ error: "bad role" }, { status: 400 });
      const r = await g.createGrant({ email: String(body.email ?? "").trim(), ign: String(body.ign ?? "").trim(), slotsSeasonal: slots(body.slotsSeasonal), slotsNonseasonal: slots(body.slotsNonseasonal), role: role as "deposit", trade: body.trade === true });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, grant: r.grant });
    }
    case "update": {
      const patch: Record<string, unknown> = {};
      for (const k of ["ign", "role", "trade", "paused"]) if (body[k] !== undefined) patch[k] = body[k];
      for (const k of ["slotsSeasonal", "slotsNonseasonal"]) if (body[k] !== undefined) patch[k] = slots(body[k]);
      if (patch.role !== undefined && !ROLES.has(String(patch.role))) return json({ error: "bad role" }, { status: 400 });
      const r = await g.updateGrant(Number(body.id), patch);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true });
    }
    case "revoke": {
      const r = await g.deleteGrant(Number(body.id));
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true });
    }
    case "refresh":
      await g.refreshGrants();
      await g.pollRequests();
      return json({ ok: true, ...g.status() });
    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
}
