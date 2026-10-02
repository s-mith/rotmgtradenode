import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/proxies — the exit-IP list, per-host switches, health, and the
//      "proxy only" rule.
// POST /api/dev/proxies — one of:
//      { text }                       replace the list with what the owner pasted (`lines`: what each line was read as)
//      { action: "parse", text }      read a pasted list without saving it: per line, the address or why it can't be used
//      { action: "test", hosts? }     check listed proxies (all, or the hosts named): login, Realm's website, a game server
//      { action: "own-internet", allow, acknowledged? }   logins from this computer's own internet when no proxy is listed
//                                     (one bot at a time); allowing needs acknowledged: true
//      { required: boolean }          logins only through a proxy (on) or direct when none is listed (off)
//      { host, enabled }              flip one host; { host: null, enabled } flips all
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
  if (body.action !== undefined) {
    switch (body.action) {
      case "parse": {
        if (typeof body.text !== "string") return json({ error: "Paste the list first." }, { status: 400 });
        const r = await pyrelay.parseProxies(body.text);
        if (!r.ok) return json({ error: r.error }, { status: r.status });
        return json(r.data);
      }
      case "test": {
        if (body.hosts !== undefined && (!Array.isArray(body.hosts) || body.hosts.some((h) => typeof h !== "string" || !/^[A-Za-z0-9.\-:]{1,260}$/.test(h)))) return json({ error: "hosts must be a list of proxy addresses" }, { status: 400 });
        const r = await pyrelay.testProxies(body.hosts as string[] | undefined);
        if (!r.ok) return json({ error: r.error }, { status: r.status });
        return json(r.data);
      }
      case "own-internet": {
        if (typeof body.allow !== "boolean") return json({ error: "allow must be true or false" }, { status: 400 });
        if (body.allow && body.acknowledged !== true) return json({ error: "Please confirm you understand the risk" }, { status: 400 });
        const r = await pyrelay.setOwnInternet(body.allow, body.acknowledged === true);
        if (!r.ok) return json({ error: r.error }, { status: r.status });
        return json(r.data);
      }
      default:
        return json({ error: "Unknown action" }, { status: 400 });
    }
  }
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
  if (typeof body.enabled !== "boolean") return json({ error: "Nothing to do" }, { status: 400 });
  const host = body.host === undefined || body.host === null ? null : String(body.host).trim();
  if (host !== null && !/^[A-Za-z0-9.\-:]{1,253}$/.test(host)) return json({ error: "Invalid host" }, { status: 400 });
  const r = await pyrelay.setProxyEnabled(host, body.enabled);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
