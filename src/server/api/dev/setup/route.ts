import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/setup — the first-run setup (the desktop app's wizard): which
//      steps are done (accounts, how bots connect, rotmg trade, a test login)
//      and whether the owner finished it (src/node/setup.ts).
// POST /api/dev/setup — one action:
//   { action: "complete" }            the owner finished the setup
//   { action: "skip-hub" }            no rotmg trade link for now
//   { action: "reset" }               start the setup over
//   { action: "test-login", guid? }   log a bot in and out again; how it goes shows in steps.test.last
const ACTIONS = new Set(["complete", "skip-hub", "reset", "test-login"]);

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const r = await pyrelay.setup();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => null)) as { action?: unknown; guid?: unknown } | null;
  const action = body?.action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return json({ error: "Unknown action" }, { status: 400 });
  const guid = typeof body?.guid === "string" ? body.guid.trim() : "";
  if (guid.length > 320) return json({ error: "That account id is too long." }, { status: 400 });
  const r = await pyrelay.setupAction({ action: action as "complete" | "skip-hub" | "reset" | "test-login", ...(guid && action === "test-login" ? { guid } : {}) });
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
