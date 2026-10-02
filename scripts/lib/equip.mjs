// Shared access to the extracted client data a build mirror publishes
// (equip.xml, players.xml, sprite index, atlases). Used by sync-equip.mjs and
// build-item-tooltips.mjs so both read the same build from the same cache.
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

export const DEFAULT_BASE = "https://builds.him.is/latest";
export const CACHE_ROOT = path.join(process.cwd(), ".cache", "equip-sync");

export const parseNum = (s) => (/^0x/i.test(String(s)) ? parseInt(s, 16) : parseInt(s, 10));
export const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
// Name key for "already on the site": tier prefix and punctuation dropped, so
// "Oryxmas Ornament: Weak" (xml) matches "Oryxmas Ornament Weak" (site).
export const loose = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// The item-index / sprite key (same normalizer as src/lib/sprites.ts).
export const normName = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

export function baseUrl(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--base");
  return (i >= 0 ? argv[i + 1] : process.env.EQUIP_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}
/** A base that is a directory on disk (an extracted client, e.g. ~/Projects/rotmgclient/7.0.0.2.0) rather than a mirror URL. */
export const isLocalBase = (base) => !/^https?:\/\//i.test(base);

export async function fetchBytes(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "user-agent": "rotmgcommunism-equip-sync/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function buildIdentity(base) {
  try {
    const j = JSON.parse((isLocalBase(base) ? fs.readFileSync(path.join(base, "build_identity.json")) : await fetchBytes(`${base}/build_identity.json`)).toString("utf8"));
    return { version: j.version ?? "?", hash: j.build_hash ?? "?" };
  } catch {
    return { version: "?", hash: "latest" };
  }
}

/** Returns get(name) that serves `${base}/${name}` from a per-build cache. */
export async function openBuild(base, log = () => {}) {
  const ident = await buildIdentity(base);
  if (isLocalBase(base)) {
    // Served straight from the extract; nothing to cache.
    const get = async (name) => {
      const file = path.join(base, name);
      if (!fs.existsSync(file)) throw new Error(`${file}: not in the local build`);
      return fs.readFileSync(file);
    };
    return { ident, get };
  }
  const dir = path.join(CACHE_ROOT, ident.hash);
  fs.mkdirSync(dir, { recursive: true });
  const get = async (name) => {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
    log(`  fetching ${name} …`);
    const bytes = await fetchBytes(`${base}/${name}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return bytes;
  };
  return { ident, get };
}

// Elements that repeat per object and must always parse as arrays.
const LIST_TAGS = new Set(["Object", "Enchantment", "Activate", "ActivateOnEquip", "Projectile", "Subattack", "OnPlayerShootActivate", "OnPlayerAbilityActivate", "OnPlayerHitActivate", "OnEnemyHitActivate", "OnConditionEndActivate", "OnPlayerHealActivate", "ConditionEffect", "EffectInfo", "Texture"]);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", allowBooleanAttributes: true, parseTagValue: false, isArray: (n) => LIST_TAGS.has(n) });

export function readObjects(xml) {
  return parser.parse(xml.toString("utf8")).Objects?.Object ?? [];
}
readObjects.parser = parser;

export const itemName = (o) => String(o.DisplayId ?? o["@_id"]).trim();
export const labelsOf = (o) => String(o.Labels ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const firstTexture = (o) => (o.Texture ? o.Texture[0] : undefined);

// SlotType -> slot group used by the class/slot filter rail.
const WEAPON_SLOTS = new Set([1, 2, 3, 8, 17, 24]);
const ARMOR_SLOTS = new Set([6, 7, 14]);
export const RING_SLOT = 9;
export const CONSUMABLE_SLOT = 10;
/** Pet eggs (equipEggs.xml) sit in slot 26: consumables, not abilities. */
const EGG_SLOT = 26;
export function slotGroup(slotType) {
  if (slotType === EGG_SLOT) return "consumable";
  if (WEAPON_SLOTS.has(slotType)) return "weapon";
  if (ARMOR_SLOTS.has(slotType)) return "armor";
  if (slotType === RING_SLOT) return "ring";
  if (slotType === CONSUMABLE_SLOT) return "consumable";
  return "ability";
}

// Display name of a slot, refined by the item's own labels (dual blades,
// longbows, tachis and the like share a SlotType with their base weapon).
const SLOT_NAMES = { 1: "Sword", 2: "Dagger", 3: "Bow", 4: "Tome", 5: "Shield", 6: "Leather Armor", 7: "Heavy Armor", 8: "Wand", 9: "Ring", 10: "Consumable", 11: "Spell", 12: "Seal", 13: "Cloak", 14: "Robe", 15: "Quiver", 16: "Helm", 17: "Staff", 18: "Poison", 19: "Skull", 20: "Trap", 21: "Orb", 22: "Prism", 23: "Scepter", 24: "Katana", 25: "Star", 27: "Wakizashi", 28: "Lute", 29: "Mace", 30: "Sheath", 31: "Sigil" };
const LABEL_KINDS = [["DUALBLADE", "Dual Blades"], ["LONGBOW", "Longbow"], ["SPELLBLADE", "Spellblade"], ["TACHI", "Tachi"], ["FLAIL", "Flail"], ["MORNINGSTAR", "Morning Star"], ["STATPOTION", "Stat Potion"], ["EGG", "Pet Egg"]];
export function slotName(o) {
  const labels = new Set(labelsOf(o));
  for (const [l, name] of LABEL_KINDS) if (labels.has(l)) return name;
  return SLOT_NAMES[Number(o.SlotType)] ?? "Item";
}

// players.xml: each class lists the SlotTypes it can equip.
export function classSlots(playersXml) {
  const out = [];
  for (const o of readObjects(playersXml)) {
    if (!("Player" in o) || !o.SlotTypes) continue;
    const slots = String(o.SlotTypes).split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
    out.push({ name: o["@_id"], slots: new Set(slots) });
  }
  return out;
}

export function classesFor(slotType, classes) {
  const able = classes.filter((c) => c.slots.has(slotType)).map((c) => c.name);
  return able.length === classes.length ? ["ALL"] : able;
}

/** The tier: the Tier attribute, else a T<n> label (the void weapons carry only the label). */
export function tierOf(o) {
  if (o.Tier !== undefined) return Number(o.Tier);
  const t = labelsOf(o).find((l) => /^T\d+$/.test(l));
  return t ? Number(t.slice(1)) : null;
}

/**
 * Every item a player can trade, as the game files say it: an Item with a
 * slot and a bag type that is not Soulbound. The game's own TRADEABLE
 * label is not the criterion (2026-09-17: 206 soulbound items carry it and
 * 241 tradeable ones lack it). Internal objects are left out: effects,
 * testers, and numbered ids without a display name ("Potion of Health1").
 */
export function tradeableItem(o, why) {
  const labels = labelsOf(o);
  const slot = Number(o.SlotType);
  const fail = (r) => { if (why) why(r); return false; };
  if (!("Item" in o)) return fail("not an item");
  if ("Soulbound" in o) return fail("soulbound");
  if (!Number.isFinite(slot) || slot <= 0) return fail(`slot ${o.SlotType}`);
  if (o.BagType === undefined) return fail("no BagType (pseudo-item)");
  if (labels.includes("EFFECT")) return fail("EFFECT pseudo-item");
  const name = itemName(o);
  if (/\btest(er)?\b/i.test(name)) return fail("test item");
  // Numbered ids without a display name are the client's internal variants — except the legacy
  // healing potions, which really are called "Potion of Health1".."6" in the game.
  if (!o.DisplayId && /[A-Za-z]\d+$/.test(String(o["@_id"])) && !/^Potion of (Health|Magic)\d+$/.test(String(o["@_id"]))) return fail("internal item (numbered id, no display name)");
  return true;
}

const GROUP_NAMES = { weapon: "Weapon", armor: "Armor", ring: "Ring", ability: "Ability" };
/**
 * Where a tradeable item goes in the catalog: consumables split into potions
 * (the stat potions), eggs and the rest; tiered equipment is "T<n> <Group>";
 * untiered equipment is "UT/ST". The subtype is the slot name for tiered
 * weapons, armor and abilities (as the curated entries have it), and Ring or
 * Armor for untiered pieces (as the earlier syncs wrote them).
 */
/** Readable books, letters and journals: their own category, so the accepted-items tab can list them apart from the other consumables. */
export const LORE = new Set(["Book of Chess", "Book of Backgammon", "Book of Arcade", "Captain's Log", "Forgotten Log I", "Forgotten Log II", "Intercepted Letter 1", "Intercepted Letter 2", "Izel's Prayer", "Nefret's Journal", "Ozuchi's Vow", "Shrouded Summons", "Vagrant's Journal", "The Wanderer's Journal Page 1", "The Wanderer's Journal Page 2", "The Wanderer's Journal Page 3"]);
/** The dungeon treasure sets (RealmEye "Dungeon Treasures"): once quest items, now only traded. */
export const TREASURES = new Set(["Golden Femur", "Golden Ribcage", "Golden Skull", "Golden Nut", "Golden Bolt", "Golden Candelabra", "Holy Cross", "Pearl Necklace", "Golden Chalice", "Ruby Gemstone", "Golden Cockle", "Golden Conch", "Golden Horn Conch", "Golden Ankh", "Eye of Osiris", "Pharaoh's Mask"]);

export function classify(o) {
  const slot = Number(o.SlotType);
  const group = slotGroup(slot);
  const labels = labelsOf(o);
  const name = itemName(o);
  if (group === "consumable") {
    // Stat potions are "Potion of <stat>"; the legacy numbered "Potion of Health1".."6" heal and are plain consumables.
    // Pet eggs carry a PetFamily (equipEggs.xml); drake eggs are consumables, egg-shaped or not.
    const legacyHeal = /^Potion of (Health|Magic)\d+$/.test(name);
    const category = LORE.has(name) ? "Lore" : TREASURES.has(name) ? "Treasure" : !legacyHeal && (labels.includes("STATPOTION") || /^(Greater )?Potion of /.test(name)) ? "Potion" : "PetFamily" in o ? "Egg" : "Consumable";
    return { kind: "consumable", group, tier: null, category, subtype: null };
  }
  const tier = tierOf(o);
  if (tier !== null && !labels.includes("UT") && !labels.includes("ST")) {
    return { kind: "tiered", group, tier, category: `T${tier} ${GROUP_NAMES[group]}`, subtype: group === "ring" ? null : slotName(o) };
  }
  return { kind: "untiered", group, tier: null, category: "UT/ST", subtype: group === "ring" ? "Ring" : group === "armor" ? "Armor" : null };
}

/** Tradeable equipment as the site defines it (see sync-equip.mjs). */
export function tradeableEquipment(o, why) {
  const labels = labelsOf(o);
  const slot = Number(o.SlotType);
  const fail = (r) => { if (why) why(r); return false; };
  if (!("Item" in o)) return fail("not an item");
  if ("Soulbound" in o) return fail("soulbound");
  if (o.Tier !== undefined) return fail(`tiered T${o.Tier}`);
  if (!Number.isFinite(slot) || slot <= 0 || slot === CONSUMABLE_SLOT) return fail(`slot ${o.SlotType}`);
  if (!o.BagType) return fail("no BagType (pseudo-item)");
  if (!labels.includes("EQUIPMENT")) return fail("no EQUIPMENT label");
  if (labels.includes("EFFECT")) return fail("EFFECT pseudo-item");
  if (/\btest\b/i.test(itemName(o))) return fail("test item");
  return true;
}
