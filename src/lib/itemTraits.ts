// Per-item facts the storage layout needs beyond the catalog: whether a
// quickslot takes the item and how many make a stack (the client's object
// XML, src/lib/quickslots.json), and which equipment slot and classes an
// item is worn by (the tooltip data's kind and class list). Pure.
import { ITEM_BY_ID } from "./catalog";
import quickslotsJson from "./quickslots.json";
import tooltips from "./item-tooltips.json";

const QUICK_STACK: Record<string, number> = (quickslotsJson as { stack: Record<string, number> }).stack;
type Tooltip = { k?: string; c?: string[] };
const TOOLTIPS = tooltips as Record<string, Tooltip>;

/** How many of the item one quickslot holds; null when quickslots do not take it. Potions are also capped by the account's MaxStackablePotions. */
export function quickslotStack(itemId: string): number | null {
  return QUICK_STACK[itemId] ?? null;
}

/** The character's equipment slots, in INVSWAP slot-id order. */
export type EquipSlot = 0 | 1 | 2 | 3;
export const EQUIP_SLOT_NAMES: Record<EquipSlot, string> = { 0: "weapon", 1: "ability", 2: "armor", 3: "ring" };
const WEAPON_KINDS = new Set(["Sword", "Bow", "Wand", "Staff", "Dagger", "Katana"]);
const ARMOR_KINDS = new Set(["Leather Armor", "Robe", "Heavy Armor"]);
const ABILITY_KINDS = new Set(["Spell", "Tome", "Helm", "Shield", "Seal", "Cloak", "Quiver", "Poison", "Skull", "Trap", "Orb", "Prism", "Scepter", "Star", "Wakizashi", "Lute", "Mace", "Sheath"]);

function tooltipOf(itemId: string): Tooltip | undefined {
  const name = ITEM_BY_ID.get(itemId)?.name;
  return name ? TOOLTIPS[name.toLowerCase()] : undefined;
}

/** Which equipment slot the item is worn in; null for anything that is not gear. */
export function equipSlotOf(itemId: string): EquipSlot | null {
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return null;
  const group = /^T\d+ (Weapon|Armor|Ring|Ability)$/.exec(item.category)?.[1] ?? (item.category === "UT/ST" ? item.subtype : undefined);
  if (group === "Weapon") return 0;
  if (group === "Ability") return 1;
  if (group === "Armor") return 2;
  if (group === "Ring") return 3;
  const k = tooltipOf(itemId)?.k;
  if (!k) return null;
  if (k === "Ring") return 3;
  if (WEAPON_KINDS.has(k)) return 0;
  if (ARMOR_KINDS.has(k)) return 2;
  if (ABILITY_KINDS.has(k)) return 1;
  return null;
}

/** Whether a character of `className` (as CLASS_NAMES spells it) can wear the item; false for non-gear. Unknown class lists are taken as everyone. */
export function wearableBy(itemId: string, className: string): boolean {
  if (equipSlotOf(itemId) === null) return false;
  const classes = tooltipOf(itemId)?.c;
  if (!classes || !classes.length || classes.includes("ALL")) return true;
  return classes.some((c) => c.toLowerCase() === className.toLowerCase());
}
