import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { pyrelay } from "@/lib/devauth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { sessionFromRequest } from "@/lib/session";
import { SERVER_SET, isDepositOnly } from "@/lib/servers";
import { sweepStaleRequests } from "@/lib/timeouts";
import { blockMessage, withdrawBlock } from "@/lib/serverControls";
import { createRedemption } from "@/lib/skinRedeem";

// POST /api/redeem-skin  { skinId, server }
//
// Spend one earned mission redemption on a skin. Queues a withdraw pinned to
// the non-seasonal bot holding that skin; the bot meets the player's
// non-seasonal character on `server` like any withdraw, and the Vault polls
// the group status for the "/trade <bot>" hint.
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`redeem:${ip}`, 5, 5 / 60)) return json({ error: "Too many requests" }, { status: 429 });
  const session = sessionFromRequest(req);
  if (!session) return json({ error: "Log in to redeem a skin." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { skinId?: unknown; server?: unknown };
  const skinId = typeof body.skinId === "string" ? body.skinId : "";
  const server = typeof body.server === "string" ? body.server : "";
  if (!SERVER_SET.has(server)) return json({ error: "Pick a valid server" }, { status: 400 });
  if (isDepositOnly(server)) return json({ error: `${server} is deposit-only — pick another server.` }, { status: 400 });

  const db = getDb();
  const block = withdrawBlock(db, server);
  if (block) return json({ error: blockMessage(server, "withdraw", block) }, { status: 403 });
  sweepStaleRequests(db);
  const pool = await pyrelay.pool();
  if (!pool.ok) return json({ error: "Bot service unavailable — try again in a minute." }, { status: 503 });

  const out = createRedemption(db, pool.data, { ign: session.ign, ignLower: session.ignLower, server, skinId });
  if (!out.ok) return json({ error: out.error, ...(out.hasOpen ? { hasOpen: true } : {}) }, { status: out.status });
  return json({ ok: true, groupId: out.groupId, requestId: out.requestId, botIgn: out.botIgn, name: out.name });
}
