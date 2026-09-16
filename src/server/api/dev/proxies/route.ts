import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/proxies — the exit-IP list, per-host switches, health, and the
//      "proxy only" rule.
// POST /api/dev/proxies — one of:
//      { text }                       replace the list with what the owner pasted
//      { required: boolean }          logins only through a proxy (on) or direct when none is listed (off)
//      { host, enabled }              flip one host; { host: null, enabled } flips all
//      { refresh: true }              re-download PROXIES_URL, if one is set
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const r = await pyrelay.proxies();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.text === "string") {
    const r = await pyrelay.setProxyList(body.text);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (typeof body.required === "boolean") {
    const r = await pyrelay.setProxyRequired(body.required);
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (body.refresh === true) {
    const r = await pyrelay.refreshProxies();
    if (!r.ok) return json({ error: r.error }, { status: r.status });
    return json(r.data);
  }
  if (typeof body.enabled !== "boolean") return json({ error: "Nothing to do" }, { status: 400 });
  const host = body.host === undefined || body.host === null ? null : String(body.host).trim();
  if (host !== null && !/^[A-Za-z0-9.\-:]{1,253}$/.test(host)) return json({ error: "Invalid host" }, { status: 400 });
  const r = await pyrelay.setProxyEnabled(host, body.enabled);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
