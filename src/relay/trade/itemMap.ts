// Catalog id <-> in-game object type for the curated set the pool trades.
import raw from "./itemMap.json";
import skins from "../../lib/skins.json";

const CURATED: Record<string, number> = raw.communism;
const MIN_ENCHANTS: Record<string, number> = raw.minEnchants;

// Character skins are "skin:<type>": the fleet can hold, track and hand
// them over, but they are NOT pool items — a deposit only takes one when the
// site queued that deposit for skins (Assignment.acceptSkins), and the site
// keeps them off the ledger and hands them out through missions
// (src/lib/skins.ts).
const SKINS: Record<string, number> = {};
for (const s of skins as { realmId: string }[]) {
  const t = Number(s.realmId);
  if (Number.isInteger(t) && t > 0) SKINS[`skin:${s.realmId}`] = t;
}

const ID_TO_TYPE = new Map<string, number>([...Object.entries(SKINS), ...Object.entries(CURATED)]);
const CURATED_TYPE_TO_ID = new Map<number, string>(Object.entries(CURATED).map(([id, t]) => [t, id]));
// A curated id keeps its type; nothing curated is a skin today.
const SKIN_TYPE_TO_ID = new Map<number, string>();
for (const [id, t] of Object.entries(SKINS)) if (!CURATED_TYPE_TO_ID.has(t)) SKIN_TYPE_TO_ID.set(t, id);

export function toObjType(catalogId: string): number | undefined {
  return ID_TO_TYPE.get(catalogId);
}

export function toCatalogId(objType: number): string | undefined {
  return CURATED_TYPE_TO_ID.get(objType) ?? SKIN_TYPE_TO_ID.get(objType);
}

/** Something the pool accepts from anyone. Skins are not (see isSkinType). */
export function isPoolItem(objType: number): boolean {
  return CURATED_TYPE_TO_ID.has(objType);
}

/** A character skin: accepted only on a deposit the operator queued for skins. */
export function isSkinType(objType: number): boolean {
  return SKIN_TYPE_TO_ID.has(objType);
}

export function minEnchantsFor(objType: number): number {
  return MIN_ENCHANTS[String(objType)] ?? 0;
}
