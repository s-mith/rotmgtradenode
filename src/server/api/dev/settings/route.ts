import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";

// GET  /api/dev/settings — read the current pool-wide operator settings.
// POST /api/dev/settings — body { pool_has_backpack?: boolean }. Unknown
// keys are ignored on the pyrelay side, so a stale client doesn't 400.
//
// Both proxy to pyrelay's /settings endpoint, which persists the toggle
// to data/pool_settings.json. Currently the only knob is the backpack
// override — when on, every bot is treated as 16-slot regardless of the
// in-game HAS_BACKPACK stat (which doesn't reliably arrive on some accounts).

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const r = await pyrelay.settings();
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}

export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: { pool_has_backpack?: boolean } = {};
  if (typeof body.pool_has_backpack === "boolean") {
    patch.pool_has_backpack = body.pool_has_backpack;
  }

  const r = await pyrelay.setSettings(patch);
  if (!r.ok) return json({ error: r.error }, { status: r.status });
  return json(r.data);
}
