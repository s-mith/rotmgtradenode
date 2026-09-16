import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/proxies — every exit IP the relay knows, with its operator
//      switch, health tallies and the bot currently on it.
// POST /api/dev/proxies — body { host: string, enabled: boolean } flips one
//      host; { host: null, enabled } flips all of them; { refresh: true }
//      re-downloads the list from PROXIES_URL.
//
// Thin proxy to the relay's /proxies endpoints, which own the state: the
// on/off flags persist in the relay's data dir (proxy_settings.json) and the
// list itself comes from PROXIES_URL, cached to PROXIES_FILE.

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const r = await pyrelay.proxies();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.refresh === true) {
    const r = await pyrelay.refreshProxies();
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (typeof body.enabled !== "boolean") {
    return json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const host = body.host === undefined || body.host === null ? null : String(body.host).trim();
  if (host !== null && !/^[A-Za-z0-9.\-:]{1,253}$/.test(host)) {
    return json({ error: "Invalid host" }, { status: 400 });
  }
  const r = await pyrelay.setProxyEnabled(host, body.enabled);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
