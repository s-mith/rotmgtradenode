// Character skins: what they are and how they're named. Skins are real
// tradable items, so the fleet holds and trades them like anything else,
// but they live outside the item catalog, the ledger and the leaderboard:
// no points, no activity, no record of who brought them in. A player gets
// one by completing a mission (lib/missions.ts) and redeeming it
// (lib/skinRedeem.ts), which delivers it through the normal withdraw
// machinery pinned to the bot that holds it.
//
// Catalog id: "skin:<realmId>", where realmId is the game's object type
// (src/lib/skins.json, scraped by scripts/scrape-skins.mjs).
import SKINS from "@/lib/skins.json";
import { ITEM_BY_ID } from "@/lib/catalog";

export type SkinDef = { realmId: string; name: string; image: string };
export const SKIN_DEFS = SKINS as SkinDef[];
const BY_REALM_ID = new Map<string, SkinDef>(SKIN_DEFS.map((s) => [s.realmId, s]));
export const SKIN_ITEM_PREFIX = "skin:";

export function skinDef(realmId: string): SkinDef | undefined {
  return BY_REALM_ID.get(realmId);
}
export function isSkin(realmId: string): boolean {
  return BY_REALM_ID.has(realmId);
}
/** The item id the fleet and the queue use for a skin. */
export function skinItemId(realmId: string): string {
  return SKIN_ITEM_PREFIX + realmId;
}
/** The realm id behind a skin item id, or null for anything else. */
export function skinRealmId(itemId: string): string | null {
  if (!itemId.startsWith(SKIN_ITEM_PREFIX)) return null;
  const id = itemId.slice(SKIN_ITEM_PREFIX.length);
  return BY_REALM_ID.has(id) ? id : null;
}
export function isSkinItem(itemId: string): boolean {
  return skinRealmId(itemId) !== null;
}
/** Display name for any item id the queue can carry: catalog, skin, or the raw id. */
export function itemDisplayName(itemId: string): string {
  const realmId = skinRealmId(itemId);
  if (realmId) return skinDef(realmId)!.name;
  return ITEM_BY_ID.get(itemId)?.name ?? itemId;
}

/**
 * SQL fragment that keeps skins out of anything read from the transactions
 * ledger — the activity feed, profiles, the leaderboard. Skin trades never
 * write a ledger row (lib/queue.ts), so this is belt and braces: whatever
 * gets there must not reveal when a skin moved or by whom.
 */
export function notASkin(column = "item_id"): string {
  return `(${column} NOT LIKE '${SKIN_ITEM_PREFIX}%' AND ${column} NOT IN (${SKIN_ID_LIST}))`;
}
const SKIN_ID_LIST = [...BY_REALM_ID.keys()]
  .map((id) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`skin id ${JSON.stringify(id)} is not safe to inline in SQL`);
    return `'${id}'`;
  })
  .join(",");
