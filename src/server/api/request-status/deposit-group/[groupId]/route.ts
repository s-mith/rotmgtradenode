import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { depositGroupStatus, GROUP_ID_RE } from "@/lib/depositStatus";

// GET /api/request-status/deposit-group/<groupId>
// Aggregate status for a fragmented deposit. The user submitted ONE deposit
// but the server may have split it into N rows (one per target bot) when no
// single bot had enough free slots. The vault page polls this so it can show
// "trade 2 of 3" progress + the bot IGN(s) the user needs to look for.
//
// The read itself is lib/depositStatus.ts, shared with the automation API.
export async function GET(
  _req: Request,
  ctx: { params: { groupId: string } },
) {
  const { groupId } = ctx.params;
  if (!GROUP_ID_RE.test(groupId)) {
    return json({ error: "Invalid groupId" }, { status: 400 });
  }

  const status = await depositGroupStatus(getDb(), groupId);
  if (!status) return json({ error: "not found" }, { status: 404 });

  return json({
    groupId: status.groupId,
    groupStatus: status.groupStatus,
    tradeCount: status.tradeCount,
    trades: status.trades,
    // Why the deposit stopped, when it stopped for a reason other than the
    // player under-filling a trade. Only 'vault-full' today; null on a
    // normal ending.
    endReason: status.endReason,
  });
}
