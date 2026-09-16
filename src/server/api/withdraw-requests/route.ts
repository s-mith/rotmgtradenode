import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { itemDisplayName } from "@/lib/skins";


type ItemEntry = { itemId: string; qty: number };

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, ign, server, items_json, status, claimed_by, created_at
       FROM withdraw_requests
       WHERE status IN ('pending','claimed')
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all() as {
    id: number;
    ign: string;
    server: string;
    items_json: string;
    status: "pending" | "claimed";
    claimed_by: string | null;
    created_at: number;
  }[];

  return json({
    requests: rows.map((r) => {
      let items: { itemId: string; itemName: string; qty: number }[] = [];
      try {
        const parsed = JSON.parse(r.items_json) as ItemEntry[];
        items = parsed.map((it) => ({
          itemId: it.itemId,
          itemName: itemDisplayName(it.itemId),
          qty: it.qty,
        }));
      } catch {
        // malformed json — surface empty items array, request is still listed
      }
      return {
        id: r.id,
        ign: r.ign,
        server: r.server,
        items,
        status: r.status,
        claimedBy: r.claimed_by,
        createdAt: r.created_at,
      };
    }),
  });
}
