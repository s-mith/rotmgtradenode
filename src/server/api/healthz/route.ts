import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { presence } from "@/lib/fleetPresence";

// GET /api/healthz — platform health check. 200 when the database answers;
// the rest is a status summary for a human reading the deploy logs. Public,
// but it says nothing that /api/pool doesn't already reveal.
const startedAt = Date.now();

export async function GET(): Promise<Response> {
  let db: "ok" | string = "ok";
  try {
    getDb().prepare("SELECT 1").get();
  } catch (e) {
    db = (e as Error).message;
  }
  const body = {
    ok: db === "ok",
    db,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    fleet: process.env.RELAY_EMBEDDED === "1" ? { online: presence.online().length, ready: presence.readyCount() } : null,
  };
  return json(body, { status: body.ok ? 200 : 503 });
}
