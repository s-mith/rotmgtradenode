import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/storage?view=status | view=account&botGuid=...
// POST /api/dev/storage  { action: "queue", botGuid, add: [{kind, instanceId|slot}] }
//                        { action: "unqueue", botGuid, ids?: [...] }   (no ids: clear)
//                        { action: "run" | "refresh", guids?: [...] }
//                        { action: "cancel" }
//                        { action: "create-character", guid, seasonal, count? }   queue `count` new characters (Wizards of that side; 1 by default) on the account, made one at a time, Realm's 30 s cooldown apart
//                        { action: "create-character", guid, cancel: true }        take back the new characters still waiting (the one waiting for a busy account too)
//                        { action: "delete-character", guid, charId }      char/delete: the character and everything on it (queued; several go in one visit)
//                        { action: "unqueue-delete", guid, charId }        take a queued delete back before it runs
//                        { action: "drop", guid, instanceIds }               throw those items away in game (queued)
//                        { action: "drop", guid, cancel: true }              take back the drops still queued
//                        { action: "tuck", guid[, plan: true] }               put the played character's items into its equipment slots and quickslots (plan: only say what would move)
//                        { action: "create-character", fill: true }       one fill pass over every account with an empty slot
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
  let body: { action?: string; botGuid?: string; add?: unknown; ids?: unknown; guids?: unknown; guid?: string; seasonal?: unknown; fill?: unknown; plan?: unknown; charId?: unknown; instanceIds?: unknown; count?: unknown; cancel?: unknown } = {};
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
    case "delete-character": r = await pyrelay.storagePost("/delete-character", { guid: body.guid, charId: body.charId }); break;
    case "unqueue-delete": r = await pyrelay.storagePost("/unqueue-delete", { guid: body.guid, charId: body.charId }); break;
    case "drop": r = await pyrelay.storagePost("/drop", body.cancel === true ? { guid: body.guid, cancel: true } : { guid: body.guid, instanceIds: body.instanceIds }); break;
    case "tuck": r = await pyrelay.storagePost("/tuck", { guid: body.guid, plan: body.plan === true }); break;
    case "create-character": r = await pyrelay.storagePost("/create-character", { guid: body.guid, seasonal: body.seasonal === true, fill: body.fill === true, ...(body.count !== undefined ? { count: body.count } : {}), ...(body.cancel === true ? { cancel: true } : {}) }); break;
    case "refresh": r = await pyrelay.storagePost("/run", { guids: body.guids, refresh: true }); break;
    case "cancel": r = await pyrelay.storagePost("/run/cancel"); break;
    default: return json({ error: "action must be queue, unqueue, run, refresh or cancel" }, { status: 400 });
  }
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
