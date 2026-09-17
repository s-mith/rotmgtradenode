import { json } from "@/server/http";
import { checkDevPassword, pyrelay } from "@/lib/devauth";
import { ITEM_BY_ID } from "@/lib/catalog";
import { enchantName } from "@/lib/enchants";
import { realmIdForItemName } from "@/lib/sprites";
import { whereLabel } from "@/lib/poolWire";


// GET /api/dev/account-lookup?q=<text>&limit=<n>
//
// Operator lookup for the dev console's Accounts tab: find a bot account by
// alias, guid, bot_guid or in-game name and report what is on it.
//
// This exists because the console previously had no way to see a bot that
// wasn't online. The Inventories tab polls pyrelay's /inventories, which
// covers ONLINE bots only — and offline is the normal state for most of the
// fleet. /pool covers everything but deliberately subtracts suspended
// accounts, since anything it lists has to be withdrawable. So an item sitting
// on an offline or retired bot was simply invisible, which is the exact case
// someone asking "where did that item go?" is looking at.
//
// An empty `q` lists the head of the fleet rather than erroring, so opening
// the tab shows something to orient against.
//
// Item names and enchant names are resolved here rather than in the browser so
// the client bundle doesn't carry the catalog — same split as
// /api/dev/inventories. Sprites are NOT inlined: items carry a `realmId` and
// the browser fetches each id's artwork once from /api/dev/item-sprites and
// caches it, which keeps a lookup response small.
//
// An item id missing from the catalog falls back to the raw id. Pyrelay tracks
// whatever the bot physically holds, which can include things this site
// doesn't trade, and hiding those would defeat the point of the tool.

export async function GET(req: Request) {
  const auth = checkDevPassword(req);
  if (!auth.ok) return json({ error: auth.error }, { status: auth.status });

  const q = new URL(req.url).searchParams.get("q") ?? "";
  const limitRaw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 25;

  const res = await pyrelay.accountLookup(q, limit);
  if (!res.ok) return json({ error: res.error }, { status: res.status });

  const accounts = res.data.accounts.map((a) => ({
    ...a,
    // pyrelay stamps capture times in epoch SECONDS; the UI works in ms like
    // everything else on the site, so convert at the boundary rather than
    // leaving two units loose in the client.
    lastSeen: a.lastSeen === null ? null : Math.round(a.lastSeen * 1000),
    items: a.items
      .map((it) => {
        const name = ITEM_BY_ID.get(it.itemId)?.name ?? it.itemId;
        return {
          ...it,
          capturedAt: it.capturedAt === null ? null : Math.round(it.capturedAt * 1000),
          name,
          known: ITEM_BY_ID.has(it.itemId),
          category: ITEM_BY_ID.get(it.itemId)?.category ?? null,
          realmId: realmIdForItemName(name),
          enchantNames: it.enchantments.map((id) => enchantName(id)),
        };
      })
      // Slot order, which is how the bot's inventory actually reads in game
      // (4 equip, 8 main, 8 backpack) — an operator comparing this against a
      // screenshot wants the same layout, not a prettier sort.
      .sort((x, y) => x.slot - y.slot),
    // What the account keeps beyond the character (docs/relay/STORAGE.md), named the same way; `where` in words.
    stored: (a.stored ?? []).map((s) => {
      const name = ITEM_BY_ID.get(s.itemId)?.name ?? s.itemId;
      return { instanceId: s.instanceId, itemId: s.itemId, name, known: ITEM_BY_ID.has(s.itemId), realmId: realmIdForItemName(name), enchantments: s.enchantments, enchantNames: s.enchantments.map((id) => enchantName(id)), where: whereLabel(s.where), pools: s.pools };
    }),
  }));

  return json({ ok: true, total: res.data.total, accounts });
}
