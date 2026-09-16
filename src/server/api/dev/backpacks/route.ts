import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/backpacks?view=status|plan|accounts[&buffer=0.2][&only=claimable|nobackpack|banked|needlogin|errors][&limit=200]
// POST /api/dev/backpacks  body { action: "audit"|"logins"|"chore"|"cancel-audit"|"cancel-logins"|"cancel-chore", ...run options }
//
// A thin pass-through to the fleet's /backpacks control-plane routes
// (docs/relay/BACKPACKS.md §12): the HTTP audit, the daily login pass, the
// demand-driven plan and the in-game chore. The fleet enforces the live-chore
// gate (BACKPACK_CHORE_LIVE=1); this route only carries the operator's intent.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "status";
  let path = "";
  if (view === "plan") path = `/plan${url.searchParams.has("buffer") ? `?buffer=${encodeURIComponent(url.searchParams.get("buffer")!)}` : ""}`;
  else if (view === "accounts") {
    const q = new URLSearchParams();
    for (const k of ["only", "limit"]) if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k)!);
    path = `/accounts${q.size ? `?${q}` : ""}`;
  } else if (view === "settings") path = "/settings";
  else if (view !== "status") return json({ error: "view must be status, plan, accounts or settings" }, { status: 400 });
  const r = await pyrelay.backpacksGet<Record<string, unknown>>(path);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}

const ACTIONS: Record<string, string> = {
  audit: "/audit", logins: "/logins", chore: "/chore",
  "cancel-audit": "/audit/cancel", "cancel-logins": "/logins/cancel", "cancel-chore": "/chore/cancel",
  settings: "/settings", tick: "/scheduler/tick", recycle: "/recycle", "cancel-recycle": "/recycle/cancel",
};

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  let body: { action?: string; [k: string]: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "JSON body required" }, { status: 400 });
  }
  const path = ACTIONS[String(body.action ?? "")];
  if (!path) return json({ error: `action must be one of ${Object.keys(ACTIONS).join(", ")}` }, { status: 400 });
  const { action: _action, ...opts } = body;
  if (opts.unauditedOnly !== undefined) opts.unauditedOnly = opts.unauditedOnly === true;
  const r = await pyrelay.backpacksPost<Record<string, unknown>>(path, opts);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
