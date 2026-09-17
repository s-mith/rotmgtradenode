import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/storage?view=status | view=account&botGuid=...
// POST /api/dev/storage  { action: "queue", botGuid, add: [{kind, instanceId|slot}] }
//                        { action: "unqueue", botGuid, ids?: [...] }   (no ids: clear)
//                        { action: "run" | "refresh", guids?: [...] }
//                        { action: "cancel" }
//
// A thin pass-through to the fleet's /storage control-plane routes
// (docs/relay/STORAGE.md): what each account's vault holds, the moves the
// operator queued, and the runs that carry them out.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "status";
  let path = "";
  if (view === "account") {
    const botGuid = url.searchParams.get("botGuid");
    if (!botGuid) return json({ error: "botGuid required" }, { status: 400 });
    path = `/accounts/${encodeURIComponent(botGuid)}`;
  } else if (view !== "status") return json({ error: "view must be status or account" }, { status: 400 });
  const r = await pyrelay.storageGet<Record<string, unknown>>(path);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  let body: { action?: string; botGuid?: string; add?: unknown; ids?: unknown; guids?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "JSON body required" }, { status: 400 });
  }
  let r;
  switch (body.action) {
    case "queue": r = await pyrelay.storagePost("/moves", { botGuid: body.botGuid, add: body.add }); break;
    case "unqueue": r = await pyrelay.storagePost("/moves", { botGuid: body.botGuid, ...(Array.isArray(body.ids) ? { remove: body.ids } : { clear: true }) }); break;
    case "run": r = await pyrelay.storagePost("/run", { guids: body.guids }); break;
    case "refresh": r = await pyrelay.storagePost("/run", { guids: body.guids, refresh: true }); break;
    case "cancel": r = await pyrelay.storagePost("/run/cancel"); break;
    default: return json({ error: "action must be queue, unqueue, run, refresh or cancel" }, { status: 400 });
  }
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
