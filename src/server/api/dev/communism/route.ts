import { json } from "@/server/http";
import { checkDevPassword, communism, hubRequests } from "@/lib/devauth";
import { WITHDRAW_SERVERS } from "@/lib/servers";

// GET  /api/dev/communism?view=status|browse[&seasonal=0|1]
// POST /api/dev/communism  { action: "take", nodeId, ref, itemId, seasonal, server? }  another node's item onto one of our pool accounts (no server: a random one at 0% load)
//                        { action: "give", nodeId, instanceIds, server }               our pool items into another node's communism
//                        { action: "publish" }
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const c = communism();
  if (!c) return json({ error: "communism is not running (the fleet is off)" }, { status: 503 });
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "status";
  if (view === "browse") {
    const seasonal = url.searchParams.get("seasonal");
    const r = await c.browse(seasonal === null ? undefined : seasonal === "1");
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json({ ok: true, items: r.items, nodes: r.nodes, status: r.status, servers: WITHDRAW_SERVERS });
  }
  return json({ ok: true, ...c.status(), requests: hubRequests()?.status() ?? null, servers: WITHDRAW_SERVERS });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const c = communism();
  if (!c) return json({ error: "communism is not running (the fleet is off)" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { action?: string; instanceIds?: unknown; nodeId?: unknown; ref?: unknown; itemId?: unknown; seasonal?: unknown; server?: unknown } | null;
  if (!body) return json({ error: "Bad JSON" }, { status: 400 });
  const ids = Array.isArray(body.instanceIds) ? body.instanceIds.map(String) : [];
  const server = String(body.server ?? "");
  switch (body.action) {
    case "take": {
      // No server named: the coordinator picks a random one at 0% load.
      const r = await c.withdraw({ nodeId: String(body.nodeId ?? ""), ref: String(body.ref ?? ""), itemId: String(body.itemId ?? ""), seasonal: body.seasonal !== false && body.seasonal !== 0 && body.seasonal !== "0", server: WITHDRAW_SERVERS.includes(server) ? server : undefined });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json({ ok: true, rendezvous: r.rendezvous, botIgn: r.botIgn });
    }
    case "give": {
      if (!WITHDRAW_SERVERS.includes(server)) return json({ error: "Pick a server" }, { status: 400 });
      const r = await c.give({ nodeId: String(body.nodeId ?? ""), instanceIds: ids, server });
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
