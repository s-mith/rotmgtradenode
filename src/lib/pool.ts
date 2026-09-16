// The pool projection: pyrelay's raw `/pool` payload -> the per-instance shape
// the grid renders, plus the deposit catalog.
//
// The browser no longer receives this per-instance list: /api/pool serves the
// compact form built by lib/poolSnapshot.ts (see lib/poolWire.ts), and the
// browser derives the same records itself. projectInstances stays as the
// server-side reference for what the pool shows (tests check the wire form
// against it) and for callers that want the list in-process.
import { CATALOG, ITEM_BY_ID } from "./catalog";
import { enchantName } from "./enchants";
import { pointsAt } from "./leaderboard";
import { pricingSnapshot } from "./itemPricing";
import type { PyrelayPool } from "./devauth";
import { rarityFor, type Rarity } from "./poolWire";

export type PoolInstance = {
  instanceId: string;
  itemId: string;
  itemName: string;
  sprite: string | null;
  botGuid: string;
  botIgn: string;
  server: string;
  // Which pool holds this item: seasonal bots can only trade seasonal
  // players, so the UI splits the view into tabs on this flag.
  seasonal: boolean;
  enchantments: { id: number; name: string | null }[];
  rarity: Rarity;
};

/** Deposit-grid catalog projection, shared by the live and mock paths.
 *
 * This IS the list of what the pool accepts, so delisted items are dropped
 * here (see lib/itemPricing.ts) — the deposit grid is built from it, and an
 * item the operator has stopped taking should not be advertised.
 *
 * It deliberately does not touch projectInstances below: a delisted item
 * already sitting on a bot stays in the pool view and stays withdrawable.
 * Hiding it there would strand it, since nothing else can take it off the bot.
 */
export function projectCatalog() {
  const { delisted } = pricingSnapshot();
  return CATALOG.filter((c) => !delisted.has(c.id)).map((c) => ({
    itemId: c.id,
    itemName: c.name,
    sprite: null,
    category: c.category,
    subtype: c.subtype ?? null,
    points: pointsAt(c.id, Date.now(), 0),
  }));
}

/**
 * pyrelay's `/pool` payload -> the sorted instance list /api/pool returns.
 *
 * `owned` is personal storage (lib/vault.ts): those instances are somebody's
 * private property and never appear in, or can be picked from, the pool —
 * whichever bot happens to hold them.
 */
export function projectInstances(data: PyrelayPool, owned: Set<string> = new Set()): PoolInstance[] {
  const meta = data.botMeta ?? {};
  const instances: PoolInstance[] = [];
  for (const [botGuid, slots] of Object.entries(data.instances ?? {})) {
    const botMeta = meta[botGuid] ?? { ign: "", server: "", online: false };
    for (const info of Object.values(slots)) {
      if (owned.has(info.instanceId)) continue;
      const item = ITEM_BY_ID.get(info.itemId);
      if (!item) continue; // unknown item id — drop silently rather than break UI
      const enchantments = (info.enchantments ?? []).map((id) => ({
        id,
        name: enchantName(id),
      }));
      const rarity = rarityFor(enchantments.length);
      instances.push({
        instanceId: info.instanceId,
        itemId: info.itemId,
        itemName: item.name,
        // Sprites now ship once via the packed spritesheet (see ItemSprite +
        // scripts/build-spritesheet.mjs); the client resolves the tile by name
        // from the atlas. Kept as a null field so any pre-atlas cached client
        // degrades to its 3-letter fallback instead of erroring.
        sprite: null,
        botGuid,
        botIgn: botMeta.ign ?? "",
        server: botMeta.server ?? "",
        seasonal: botMeta.seasonal !== false,
        enchantments,
        rarity,
      });
    }
  }
  // Stable sort: item type then instance ID so the grid order is
  // deterministic across refreshes.
  instances.sort((a, b) => {
    if (a.itemId !== b.itemId) return a.itemId.localeCompare(b.itemId);
    return a.instanceId.localeCompare(b.instanceId);
  });
  return instances;
}
