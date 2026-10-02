import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/node — build gate, server list, telemetry and feed status.
// POST /api/dev/node — one action:
//   { action: "canary", server? }   log one bot in on the current build
//   { action: "trust" }             record the current build as known
//   { action: "telemetry", enabled, hubUrl? }
//   { action: "flush" }             send queued telemetry now
//   { action: "hub-link", url, code, name? }
//   { action: "hub-unlink" }
//   { action: "hub-heartbeat" }
//   { action: "players", enabled?, maxMeetings?, noShow? }   trades with players on the hub (maxMeetings null: one per bot online)
//   { action: "login-desk", alwaysOn }              keep a login desk bot in game all the time (else: only while someone logs in)
//   { action: "advanced", pool?, communism?, mergeBudget?, lingerS?, passSurplus? }   advanced management (docs/relay/ADVANCED.md)
//   { action: "whisper", ign, code }   a bot of this node whispers "/tell <ign> <code>" (testing a login node from another node)
//   { action: "resume" }               the computer woke up from sleep: log the bots out cleanly, let the proxies back
//   { action: "check-build" }          paused for a Realm update: look again whether the new version is confirmed
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
  const body = (await req.json().catch(() => null)) as { action?: string; server?: string; enabled?: boolean; hubUrl?: string; url?: string; code?: string; name?: string; maxMeetings?: number | null; noShow?: { limit: number; pauseHours: number }; ign?: string } | null;
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
      const r = await pyrelay.hubLink({ url: String(body.url ?? ""), code: String(body.code ?? ""), name: body.name });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "hub-unlink": {
      const r = await pyrelay.hubUnlink();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "whisper": {
      const r = await pyrelay.whisper(String(body.ign ?? ""), String(body.code ?? ""));
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "players": {
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, { status: 400 });
      const r = await pyrelay.setPlayers({ enabled: body.enabled, ...("maxMeetings" in body ? { maxMeetings: body.maxMeetings ?? null } : {}), ...(body.noShow ? { noShow: body.noShow } : {}) });
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "login-desk": {
      if (typeof (body as { alwaysOn?: unknown }).alwaysOn !== "boolean") return json({ error: "alwaysOn must be a boolean" }, { status: 400 });
      const r = await pyrelay.setLoginDesk((body as { alwaysOn: boolean }).alwaysOn);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "advanced": {
      const a = body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of ["pool", "communism", "passSurplus"]) {
        if (k in a) {
          if (typeof a[k] !== "boolean") return json({ error: `${k} must be a boolean` }, { status: 400 });
          patch[k] = a[k];
        }
      }
      if ("mergeBudget" in a) patch.mergeBudget = a.mergeBudget;
      if ("lingerS" in a) patch.lingerS = a.lingerS;
      const r = await pyrelay.setAdvanced(patch);
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "hub-heartbeat": {
      const r = await pyrelay.hubHeartbeat();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "resume": {
      const r = await pyrelay.resume();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    case "check-build": {
      const r = await pyrelay.checkBuild();
      if (!r.ok) return json({ error: r.error }, { status: r.status });
      return json(r.data);
    }
    default:
      return json({ error: "Unknown action" }, { status: 400 });
  }
}
