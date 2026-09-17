import { json } from "@/server/http";
import { checkDevPassword, commons } from "@/lib/devauth";
import { WITHDRAW_SERVERS } from "@/lib/servers";

// GET  /api/dev/commons?view=status|browse|mine[&seasonal=0|1]
// POST /api/dev/commons  { action: "contribute", instanceIds }
//                        { action: "uncontribute", instanceIds }
//                        { action: "withdraw", nodeId, ref, itemId, seasonal, server }
//                        { action: "publish" }
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const c = commons();
  if (!c) return json({ error: "the commons is not running (the fleet is off)" }, { status: 503 });
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "status";
  if (view === "browse" || view === "mine") {
    const seasonal = url.searchParams.get("seasonal");
    const r = view === "browse" ? await c.browse(seasonal === null ? undefined : seasonal === "1") : await c.mine();
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json({ ok: true, items: r.items, status: r.status, servers: WITHDRAW_SERVERS });
  }
  return json({ ok: true, ...c.status(), servers: WITHDRAW_SERVERS });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const c = commons();
  if (!c) return json({ error: "the commons is not running (the fleet is off)" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { action?: string; instanceIds?: unknown; nodeId?: unknown; ref?: unknown; itemId?: unknown; seasonal?: unknown; server?: unknown } | null;
  if (!body) return json({ error: "Bad JSON" }, { status: 400 });
  const ids = Array.isArray(body.instanceIds) ? body.instanceIds.map(String) : [];
  switch (body.action) {
    case "contribute": {
      const r = await c.contribute(ids);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, added: r.added, ...c.status() });
    }
    case "uncontribute": {
      const r = await c.uncontribute(ids);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, removed: r.removed, ...c.status() });
    }
    case "withdraw": {
      const server = String(body.server ?? "");
      if (!WITHDRAW_SERVERS.includes(server)) return json({ error: "Pick a server" }, { status: 400 });
      const r = await c.withdraw({ nodeId: String(body.nodeId ?? ""), ref: String(body.ref ?? ""), itemId: String(body.itemId ?? ""), seasonal: body.seasonal !== false && body.seasonal !== 0 && body.seasonal !== "0", server });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, rendezvous: r.rendezvous, botIgn: r.botIgn });
    }
    case "publish": {
      const ok = await c.publish(true);
      return json({ ok, ...c.status() });
    }
    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
}
