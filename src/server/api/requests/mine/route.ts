import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { ITEM_BY_ID } from "@/lib/catalog";
import { sessionFromRequest } from "@/lib/session";
import { sweepStaleRequests } from "@/lib/timeouts";
import { openGroupsFor } from "@/lib/cancelCode";
import { depositGroupStatus } from "@/lib/depositStatus";
import { withdrawGroupStatus } from "@/lib/withdrawStatus";

// GET /api/requests/mine — every open deposit and withdraw of the logged-in
// character, with each group's per-trade status and the bot to /trade. This
// is what keeps a request visible across reloads: the page used to know only
// about the request it had just sent.
export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return json({ error: "Log in to see your requests." }, { status: 401 });
  const db = getDb();
  sweepStaleRequests(db);
  const groups = openGroupsFor(db, session.ignLower);
  const requests = [];
  for (const g of groups) {
    const status = g.kind === "deposit" ? await depositGroupStatus(db, g.groupId) : await withdrawGroupStatus(db, g.groupId);
    if (!status) continue;
    requests.push({
      groupId: g.groupId,
      kind: g.kind,
      server: g.server,
      vault: g.vault,
      seasonal: g.seasonal,
      createdAt: g.createdAt,
      itemCount: g.itemCount,
      items: g.items.map((it) => ({ itemId: it.itemId, itemName: ITEM_BY_ID.get(it.itemId)?.name ?? it.itemId, qty: it.qty })),
      groupStatus: status.groupStatus,
      tradeCount: status.tradeCount,
      trades: status.trades,
      endReason: g.kind === "deposit" ? (status as { endReason?: string | null }).endReason ?? null : null,
    });
  }
  return json({ ok: true, ign: session.ign, requests });
}
