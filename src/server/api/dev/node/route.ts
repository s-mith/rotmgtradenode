import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/node — build gate, server list, telemetry and feed status.
// POST /api/dev/node — one action:
//   { action: "canary", server? }   log one bot in on the current build
//   { action: "trust" }             record the current build as known
//   { action: "telemetry", enabled, hubUrl? }
//   { action: "flush" }             send queued telemetry now
//   { action: "hub-link", url, email, password, name? }
//   { action: "hub-unlink" }
//   { action: "hub-heartbeat" }
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const r = await pyrelay.nodeStatus();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { action?: string; server?: string; enabled?: boolean; hubUrl?: string; url?: string; email?: string; password?: string; name?: string } | null;
  if (!body || typeof body !== "object") return json({ error: "Bad JSON" }, { status: 400 });
  switch (body.action) {
    case "canary": {
      const r = await pyrelay.buildCanary(body.server);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "trust": {
      const r = await pyrelay.buildTrust();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "telemetry": {
      if (typeof body.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, { status: 400 });
      const r = await pyrelay.setTelemetry(body.enabled, body.hubUrl);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "flush": {
      const r = await pyrelay.flushTelemetry();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "hub-link": {
      const r = await pyrelay.hubLink({ url: String(body.url ?? ""), email: String(body.email ?? ""), password: String(body.password ?? ""), name: body.name });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "hub-unlink": {
      const r = await pyrelay.hubUnlink();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "hub-heartbeat": {
      const r = await pyrelay.hubHeartbeat();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
}
