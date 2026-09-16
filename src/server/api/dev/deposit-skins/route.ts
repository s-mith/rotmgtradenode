import { MAX_TRADE_SLOTS } from "@/lib/depositSizes";
import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkDevPassword } from "@/lib/devauth";
import { checkIgn } from "@/lib/validation";
import { SERVER_SET } from "@/lib/servers";
import { createDepositRequest } from "@/lib/depositRequest";
import { depositGroupStatus } from "@/lib/depositStatus";

// Operator console: bring skins into the pool.
//   POST /api/dev/deposit-skins  { ign, server, slots? }   (1-16, default 8; one trade)
// Queues a NON-SEASONAL deposit for the operator's own character that the
// bot will take skins on — the only deposit that does. Skins are
// non-seasonal items only, so trade it from a non-seasonal character; the
// skins land on the bot, in the tracker, and nowhere on the ledger.
//   GET  /api/dev/deposit-skins?groupId=  — that deposit's status (bot to trade).
export async function POST(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { ign?: unknown; server?: unknown; slots?: unknown; itemCount?: unknown };
  const i = checkIgn(body.ign);
  if (!i.ok) return json({ error: i.error }, { status: 400 });
  if (typeof body.server !== "string" || !SERVER_SET.has(body.server)) return json({ error: "Unknown server" }, { status: 400 });
  const raw = body.slots ?? body.itemCount;
  const slots = raw === undefined || raw === null ? 8 : Number(raw);
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_TRADE_SLOTS) return json({ error: `slots must be 1-${MAX_TRADE_SLOTS}` }, { status: 400 });
  const created = await createDepositRequest(getDb(), { ign: i.ign, ignLower: i.ignLower, server: body.server, slots, seasonal: 0, skinsAllowed: true });
  if (!created.ok) return json({ error: created.error, ...(created.hasOpen ? { hasOpen: true } : {}) }, { status: created.status });
  console.log(`[skins] operator skin deposit queued for ${i.ign} on ${body.server} (#${created.requestId})`);
  return json({ ok: true, groupId: created.groupId, requestId: created.requestId });
}

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  const groupId = new URL(req.url).searchParams.get("groupId") ?? "";
  if (!/^[a-f0-9-]{32,40}$/i.test(groupId)) return json({ error: "Invalid groupId" }, { status: 400 });
  const status = await depositGroupStatus(getDb(), groupId);
  if (!status) return json({ error: "not found" }, { status: 404 });
  return json({ ok: true, ...status });
}
