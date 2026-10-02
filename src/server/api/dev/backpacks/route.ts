import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// POST /api/dev/backpacks  body { action: "claim", guid, seasonal? } | { action: "consume", guid, charId } | { action: "cancel", guid } | { action: "daily-login" }
//
// A thin pass-through to the fleet's /backpacks control-plane routes
// (docs/relay/BACKPACKS.md): the per-account claim and use jobs, and a pass
// of today's logins. This route only carries the operator's intent.
const ACTIONS: Record<string, string> = {
  // Per account (the Accounts tab): { action: "claim", guid, seasonal? } and { action: "consume", guid, charId }, and
  // { action: "cancel", guid } to take back one still waiting for the account; a pass of today's logins.
  claim: "/claim", consume: "/consume", cancel: "/cancel", "daily-login": "/daily-login",
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
  const r = await pyrelay.backpacksPost<Record<string, unknown>>(path, opts);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
