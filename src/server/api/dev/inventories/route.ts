import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";
import { ITEM_BY_ID } from "@/lib/catalog";
import { realmIdForItemName } from "@/lib/sprites";


// GET /api/dev/inventories?since=<rev>
//
// Live inventory of every ONLINE bot, for the dev console's Inventories tab.
// A thin pass-through to pyrelay's /inventories — pyrelay is the source of
// truth for what a bot is holding and the website keeps no copy.
//
// The `since` round trip is what makes this cheap enough to poll: hand back
// the `rev` from the previous response and an unchanged fleet replies
// `{ unchanged: true }` with no bot array at all. The client then skips its
// state update entirely, so a quiet fleet costs one small request per interval
// and zero React re-renders.
//
// Item names are resolved here rather than in the browser so the client bundle
// doesn't carry the catalog, and unchanged responses stay tiny. An id missing
// from the catalog falls back to the raw id — pyrelay tracks whatever the bot
// physically holds, which can include things the website doesn't trade.
//
// What is NOT resolved here is the sprite. Bot items carry a `realmId` and
// trade-window items already arrive as one, which puts both on the same key
// space for /api/dev/item-sprites; the browser fetches each id's artwork once
// and keeps it. Inlining ~1.5 KB of base64 per item would add a few hundred KB
// to every poll that anything moved, which is exactly the cost the `rev`
// round trip exists to avoid.
export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const since = new URL(req.url).searchParams.get("since") ?? undefined;
  const res = await pyrelay.inventories(since);
  if (!res.ok) {
    return json({ error: res.error }, { status: res.status });
  }

  const data = res.data;
  if (data.unchanged) {
    return json({ ok: true, unchanged: true, rev: data.rev });
  }

  const bots = (data.bots ?? []).map((b) => ({
    ...b,
    items: Object.entries(b.items ?? {})
      .map(([id, qty]) => {
        const name = ITEM_BY_ID.get(id)?.name ?? id;
        return {
          id,
          qty,
          name,
          category: ITEM_BY_ID.get(id)?.category ?? null,
          realmId: realmIdForItemName(name),
        };
      })
      // Biggest stacks first, then alphabetical — a bot's contents read the
      // same way every refresh, so the eye can track a change instead of
      // re-reading the whole row.
      .sort((a, b2) => b2.qty - a.qty || a.name.localeCompare(b2.name)),
  }));

  return json({
    ok: true,
    rev: data.rev,
    capturedAt: data.capturedAt ?? Date.now() / 1000,
    bots,
  });
}
