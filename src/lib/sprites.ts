import fs from "node:fs";
import path from "node:path";
import { CATALOG } from "./catalog";

type RealmItem = { id: string; realmId: string; name: string; sprite: string };

let cache: Map<string, string> | null = null;
let byRealmId: Map<number, { name: string; sprite: string }> | null = null;
let realmIdByName: Map<string, number> | null = null;

// Realm's items.json prefixes UT/ST/etc. on display names ("UT. Ring of
// Decades"); our catalog uses bare names. Normalize both sides so the
// match works regardless of which tier prefix the source asset has.
function normalize(name: string): string {
  return name.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();
}

// realm-items.json is ~2.5 MB and every lookup below wants a different slice
// of it, so it is parsed at most once per process no matter how many of the
// maps get built. Server-side only — nothing here is ever sent to a browser
// wholesale; the sprites alone would be a couple of megabytes.
function readRealmItems(): RealmItem[] {
  const file = path.join(process.cwd(), "realm-items.json");
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as RealmItem[];
}

export function getSpriteMap(): Map<string, string> {
  if (cache) return cache;
  const map = new Map<string, string>();
  const wanted = new Set(CATALOG.map((c) => normalize(c.name)));
  for (const it of readRealmItems()) {
    if (!it.sprite) continue;
    const k = normalize(it.name);
    if (wanted.has(k) && !map.has(k)) {
      map.set(k, `data:image/png;base64,${it.sprite}`);
    }
  }
  cache = map;
  return map;
}

export function spriteForItemName(name: string): string | null {
  return getSpriteMap().get(normalize(name)) ?? null;
}

// --- lookups by Realm type id ----------------------------------------------
//
// The catalog covers what the site trades. A trade partner's bags do not: a
// player can bring anything in the game to a trade window, and the packet
// identifies it only by Realm's numeric type id. So these maps deliberately
// span the WHOLE item file rather than being filtered to CATALOG the way
// getSpriteMap is.

function getByRealmId(): Map<number, { name: string; sprite: string }> {
  if (byRealmId) return byRealmId;
  const map = new Map<number, { name: string; sprite: string }>();
  for (const it of readRealmItems()) {
    const id = Number(it.realmId);
    if (!Number.isFinite(id) || map.has(id)) continue;
    map.set(id, {
      name: it.name,
      sprite: it.sprite ? `data:image/png;base64,${it.sprite}` : "",
    });
  }
  byRealmId = map;
  return map;
}

export function realmItemById(
  realmId: number,
): { name: string; sprite: string | null } | null {
  const hit = getByRealmId().get(realmId);
  if (!hit) return null;
  return { name: hit.name, sprite: hit.sprite || null };
}

/** Realm type id for a catalog item name, so bot inventories and trade
 *  windows share one sprite cache key space in the browser. */
export function realmIdForItemName(name: string): number | null {
  if (!realmIdByName) {
    const map = new Map<string, number>();
    for (const it of readRealmItems()) {
      const id = Number(it.realmId);
      if (!Number.isFinite(id)) continue;
      const k = normalize(it.name);
      if (!map.has(k)) map.set(k, id);
    }
    realmIdByName = map;
  }
  return realmIdByName.get(normalize(name)) ?? null;
}
