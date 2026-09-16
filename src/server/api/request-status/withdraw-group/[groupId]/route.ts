import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { withdrawGroupStatus } from "@/lib/withdrawStatus";

// GET /api/request-status/withdraw-group/<groupId>
// Aggregate status for a fragmented withdraw. The user submitted ONE withdraw
// but the server may have split it into N rows (one per fulfilling bot). The
// vault page polls this so it can show "trade 2 of 3" progress + the bot
// IGN(s) the user needs to look for in nexus. The read itself is
// lib/withdrawStatus.ts, shared with the In Flight list.
export async function GET(_req: Request, ctx: { params: { groupId: string } }) {
  const { groupId } = ctx.params;
  if (!/^[a-f0-9-]{32,40}$/i.test(groupId)) {
    return json({ error: "Invalid groupId" }, { status: 400 });
  }
  const status = await withdrawGroupStatus(getDb(), groupId);
  if (!status) return json({ error: "not found" }, { status: 404 });
  return json(status);
}
