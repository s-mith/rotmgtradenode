// Greedy fragmentation: split a user's withdraw across multiple bots when no
// single bot covers all the items. Each output entry is one trade — pinned to
// a specific bot — that adds up to the original request.
//
// Inputs are deterministic, so the same submit produces the same fragmentation
// across retries until inventory state changes. We sort bot_guids so the
// fragmentation is stable regardless of which order Map.entries() yields.

export type ItemReq = { itemId: string; qty: number };

export type BotInventory = {
  botGuid: string;
  inventory: Map<string, number>; // item_id -> qty
};

export type Fragment = {
  botGuid: string;
  items: ItemReq[];
};

export function fragmentWithdraw(
  request: ItemReq[],
  bots: BotInventory[],
): { ok: true; fragments: Fragment[] } | { ok: false; missing: ItemReq[] } {
  // Working copy of bot inventories so we can deduct as we allocate.
  const remaining = new Map<string, Map<string, number>>();
  for (const b of bots) {
    remaining.set(b.botGuid, new Map(b.inventory));
  }

  // Order bots by guid for deterministic output. Two bots with the same item
  // will always be allocated in the same order, so a retry submission gives
  // the same fragmentation if inventories haven't changed.
  const orderedBots = [...bots].sort((a, b) => a.botGuid.localeCompare(b.botGuid));

  // bot_guid -> { item_id -> qty } we're going to ask that bot for.
  const allocation = new Map<string, Map<string, number>>();
  const missing: ItemReq[] = [];

  for (const need of request) {
    let stillNeeded = need.qty;
    for (const bot of orderedBots) {
      if (stillNeeded <= 0) break;
      const inv = remaining.get(bot.botGuid)!;
      const have = inv.get(need.itemId) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, stillNeeded);
      inv.set(need.itemId, have - take);
      let alloc = allocation.get(bot.botGuid);
      if (!alloc) {
        alloc = new Map();
        allocation.set(bot.botGuid, alloc);
      }
      alloc.set(need.itemId, (alloc.get(need.itemId) ?? 0) + take);
      stillNeeded -= take;
    }
    if (stillNeeded > 0) {
      missing.push({ itemId: need.itemId, qty: stillNeeded });
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  // Convert allocation to Fragment[], sorted within each bot for stability.
  const fragments: Fragment[] = [];
  // Sort outer Map keys for deterministic Fragment ordering.
  const allocBots = [...allocation.keys()].sort();
  for (const botGuid of allocBots) {
    const alloc = allocation.get(botGuid)!;
    const items: ItemReq[] = [...alloc.entries()]
      .map(([itemId, qty]) => ({ itemId, qty }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
    // Allocation entries only exist when something was actually taken from
    // a bot (see the `let alloc = allocation.get(...)` insertion above), so
    // items.length is always >= 1. The guard is here defensively in case
    // allocation logic changes — a zero-item fragment would be a no-op trade.
    if (items.length > 0) fragments.push({ botGuid, items });
  }
  return { ok: true, fragments };
}
