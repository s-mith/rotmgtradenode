// What this node takes in (design doc §4.1). The catalog is every item the
// game lets players trade; the owner decides which of them the node's bots
// accept. Rules by category set the default — the stat potions, eggs, other
// consumables, untiered gear, and a lowest tier per gear group — and a pin
// per item beats the rule either way. Pure: the settings store keeps it, the
// trade machine and the site both ask it.
import { CATALOG, ITEM_BY_ID, type CatalogItem, type EquipmentGroup } from "./catalog";

export const GROUPS: EquipmentGroup[] = ["Weapon", "Armor", "Ring", "Ability"];

export interface ItemPolicy {
  potions: boolean;
  eggs: boolean;
  consumables: boolean;
  /** UT and ST gear. */
  untiered: boolean;
  /** Lowest tier taken per gear group; null takes none of that group. */
  minTier: Record<EquipmentGroup, number | null>;
  /** Per-item pins: true always taken, false never, whatever the rules say. */
  overrides: Record<string, boolean>;
}

/** Everything the game lets players trade. */
export const DEFAULT_ITEM_POLICY: ItemPolicy = {
  potions: true, eggs: true, consumables: true, untiered: true,
  minTier: { Weapon: 0, Armor: 0, Ring: 0, Ability: 0 },
  overrides: {},
};

export type CategoryKind = { kind: "tiered"; group: EquipmentGroup; tier: number } | { kind: "potion" | "egg" | "consumable" | "untiered" };
export function parseCategory(category: string): CategoryKind {
  const m = /^T(\d+) (Weapon|Armor|Ring|Ability)$/.exec(category);
  if (m) return { kind: "tiered", group: m[2] as EquipmentGroup, tier: Number(m[1]) };
  if (category === "Potion") return { kind: "potion" };
  if (category === "Egg") return { kind: "egg" };
  if (category === "Consumable") return { kind: "consumable" };
  return { kind: "untiered" };
}

/** What the rules alone say about an item. */
export function ruleAccepts(policy: ItemPolicy, item: CatalogItem): boolean {
  const c = parseCategory(item.category);
  switch (c.kind) {
    case "tiered": {
      const min = policy.minTier[c.group];
      return min !== null && c.tier >= min;
    }
    case "potion": return policy.potions;
    case "egg": return policy.eggs;
    case "consumable": return policy.consumables;
    case "untiered": return policy.untiered;
  }
}

/** Whether the node takes this catalog item: its pin, else the rules. Unknown ids are never taken. */
export function acceptsItem(policy: ItemPolicy, itemId: string): boolean {
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return false;
  const pin = policy.overrides[itemId];
  return pin !== undefined ? pin : ruleAccepts(policy, item);
}

export function acceptedIds(policy: ItemPolicy): Set<string> {
  return new Set(CATALOG.filter((i) => acceptsItem(policy, i.id)).map((i) => i.id));
}

/** A policy from anything (a settings file, a console form): unknown fields dropped, missing ones defaulted, pins on unknown items dropped. */
export function normalizeItemPolicy(raw: unknown): ItemPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ItemPolicy, unknown>>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const minTier = { ...DEFAULT_ITEM_POLICY.minTier };
  const mt = (r.minTier && typeof r.minTier === "object" ? r.minTier : {}) as Record<string, unknown>;
  for (const g of GROUPS) {
    const v = mt[g];
    if (v === null) minTier[g] = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) minTier[g] = v;
    else if (typeof v === "string" && /^\d+$/.test(v)) minTier[g] = Number(v);
  }
  const overrides: Record<string, boolean> = {};
  const ov = (r.overrides && typeof r.overrides === "object" ? r.overrides : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(ov)) if (typeof v === "boolean" && ITEM_BY_ID.has(id)) overrides[id] = v;
  return { potions: bool(r.potions, true), eggs: bool(r.eggs, true), consumables: bool(r.consumables, true), untiered: bool(r.untiered, true), minTier, overrides };
}

/** Whether a policy is the default (everything tradeable). */
export function acceptsEverything(policy: ItemPolicy): boolean {
  return policy.potions && policy.eggs && policy.consumables && policy.untiered && GROUPS.every((g) => policy.minTier[g] === 0) && !Object.values(policy.overrides).some((v) => v === false);
}

// --- the process-wide policy ------------------------------------------------------
// The node's settings store owns the policy; the site's validators and the
// pool projection read it through here. Without a registration (tests, a
// process with no fleet) everything tradeable is taken.
let getter: (() => ItemPolicy) | null = null;
export function registerItemPolicy(get: (() => ItemPolicy) | null): void {
  getter = get;
}
export function currentItemPolicy(): ItemPolicy {
  return getter ? getter() : DEFAULT_ITEM_POLICY;
}
/** The site's answer for one item, with the reason for the form. */
export function nodeTakes(itemId: string): boolean {
  return acceptsItem(currentItemPolicy(), itemId);
}
