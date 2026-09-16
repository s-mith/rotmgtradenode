import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { checkApiKey } from "@/lib/apiKeys";
import { rateLimit } from "@/lib/ratelimit";
import { sweepStaleRequests } from "@/lib/timeouts";
import { cancelOpenRequests } from "@/lib/cancelCode";
import { depositGroupStatus, GROUP_ID_RE } from "@/lib/depositStatus";

// GET    /api/ext/deposit/<groupId>  — poll a queued deposit
// DELETE /api/ext/deposit/<groupId>  — give up on it
//
// The status view an automated client polls between submitting a deposit and
// its bot finishing the trade. Same data the website's vault page reads, minus
// the browser-shaped bits.

export async function GET(
  req: Request,
  ctx: { params: { groupId: string } },
) {
  const auth = checkApiKey(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  // Polling is cheap (one indexed read, plus a pyrelay lookup only when a bot
  // hasn't heartbeated yet), so this is loose enough for a 1s poll loop with
  // room to spare.
  if (!rateLimit(`ext-status:${auth.caller.label}`, 120, 2)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  const { groupId } = ctx.params;
  if (!GROUP_ID_RE.test(groupId)) {
    return json({ error: "Invalid groupId" }, { status: 400 });
  }

  const db = getDb();
  // Age out abandoned rows on read. Without this a caller polling a request no
  // bot ever claimed would watch it sit "waiting" forever, because the sweep
  // otherwise only runs on paths this client never touches.
  sweepStaleRequests(db);
  const status = await depositGroupStatus(db, groupId);
  if (!status) return json({ error: "not found" }, { status: 404 });

  const botIgn = status.trades.find((t) => t.botIgn)?.botIgn ?? null;
  return json({
    ok: true,
    groupId: status.groupId,
    ign: status.ign,
    // in-flight | fulfilled | partial | cancelled, plus the flat "who do I
    // trade right now" answer the caller is really polling for.
    groupStatus: status.groupStatus,
    status: botIgn
      ? "assigned"
      : status.groupStatus === "in-flight"
        ? "waiting"
        : status.groupStatus,
    botIgn,
    itemsDeposited: status.itemsDeposited,
    tradeCount: status.tradeCount,
    trades: status.trades,
    endReason: status.endReason,
  });
}

export async function DELETE(
  req: Request,
  ctx: { params: { groupId: string } },
) {
  const auth = checkApiKey(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });
  if (!rateLimit(`ext-cancel:${auth.caller.label}`, 20, 20 / 60)) {
    return json({ error: "Too many requests" }, { status: 429 });
  }

  const { groupId } = ctx.params;
  if (!GROUP_ID_RE.test(groupId)) {
    return json({ error: "Invalid groupId" }, { status: 400 });
  }

  const db = getDb();
  const status = await depositGroupStatus(db, groupId);
  if (!status) return json({ error: "not found" }, { status: 404 });

  // Cancels every open request for that IGN, not just this group. There can
  // only be one open deposit per IGN anyway (that's the gate in
  // lib/depositRequest.ts), so in practice this group IS the IGN's open work —
  // and reusing the website's cancel path means the bot-freeing side effects
  // stay in one place. Mid-trade rows are cancelled too, so a client that
  // hangs up during a hand-off can lose the items in that window; that's the
  // same trade-off the in-browser cancel button makes.
  const out = cancelOpenRequests(db, status.ignLower);
  return json({
    ok: true,
    groupId,
    ign: status.ign,
    cancelled: out.depositsCancelled,
    tradesInProgress: out.tradesInProgress,
  });
}
