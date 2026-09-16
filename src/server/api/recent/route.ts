import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { ITEM_BY_ID } from "@/lib/catalog";
import { stylesFor } from "@/lib/cosmetics";
import { notASkin } from "@/lib/skins";


type Row = {
  id: number;
  kind: "deposit" | "withdraw";
  ign: string;
  ign_lower: string;
  item_id: string;
  qty: number;
  server: string | null;
  createdAt: number;
};

// GET /api/recent — the latest deposits & withdrawals across the whole
// ledger, newest first. Powers the Recent Activity panel; leans on the
// idx_tx_created(created_at DESC) index so it stays cheap under polling.
//
// item_id is a catalog code (e.g. "pwis"), so we resolve it to a display
// name here — same as /api/profile — and let ItemSprite draw the sprite
// from that name. createdAt is a ms epoch, passed through untouched.
export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, kind, ign, ign_lower, item_id, qty, server, created_at AS createdAt
         FROM transactions
        WHERE ${notASkin()}
        ORDER BY created_at DESC
        LIMIT 30`,
    )
    .all() as Row[];

  // Donator name effects for the names in this page of the feed.
  const styles = stylesFor(db, rows.map((r) => r.ign_lower));

  const events = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ign: r.ign,
    nameStyle: styles[r.ign_lower] ?? null,
    itemName: ITEM_BY_ID.get(r.item_id)?.name ?? r.item_id,
    qty: r.qty,
    server: r.server,
    createdAt: r.createdAt,
  }));

  return json({ events });
}
