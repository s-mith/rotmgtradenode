// Contribution scoring — shared by /api/leaderboard (the boards) and
// /api/profile (per-player pages), so a player's profile total can never
// disagree with their board position.
//
// Point values are ERA-SCOPED: a transaction scores by the table that was
// in force when it happened (row created_at vs the cutoff), so re-pricing
// an item never retroactively rewrites anyone's history. Both eras apply
// to withdrawals too — taking an item costs whatever depositing it would
// currently earn.
//
// An item id that has since left the catalog scores the full 1 point; it
// was gear when it was traded, and its rows still live in the ledger.
//
// leaderboard-baseline.json holds scores carried over from before the
// current database existed (the pre-volume deploy lost its transactions
// table; scripts/snapshot-leaderboard.mjs captured the totals first).
// It ships inside the bundle, so it survives redeploys with no volume —
// live ledger points are added ON TOP of each player's baseline.

import type Database from "better-sqlite3";
import { ITEM_BY_ID } from "@/lib/catalog";
import BASELINE from "@/lib/leaderboard-baseline.json";
import { publishedPriceAt, pricingSnapshot } from "@/lib/itemPricing";

// ---- Pricing epochs --------------------------------------------------------
// Ordered list of rule changes. A transaction scores by the LAST epoch whose
// effectiveAt is <= its created_at. Adding a new table = appending an epoch;
// history never moves.
//
// Epochs 1-5 below are hardcoded because they predate the operator console and
// their tables ARE the historical record. Everything after them is published
// at runtime from /dev/settings and lives in the database — see
// lib/itemPricing.ts. Both halves obey the same rule, and the published ones
// always sort after these (their cutoff is the moment save was pressed), so
// they simply extend the list rather than interleaving with it.

// Epoch 2 cutoff — "Leaderboard Points Adjustments" blog post, 2026-07-07
// 18:46 UTC.
export const NEW_RULES_AT = 1783449964511;
// Epoch 3 cutoff — enchant multipliers + ring/bow/egg re-pricing,
// 2026-07-10 07:00 UTC (approx; the moment the change shipped).
export const ENCHANT_RULES_AT = 1783724260747;
// Epoch 4 cutoff — Coral set (Silk Armor / Venom Trap / Sharktooth Sigil)
// priced to 2, 2026-08-12 18:04 UTC (the moment the change shipped). Deposits
// before this keep their old value; only ones after score the new price.
export const CORAL_RULES_AT = 1786557852748;
// Epoch 5 cutoff — Superior Masks (Anubis / Cnidaria / Lightning / Mucus)
// priced to 3, 2026-08-21 07:44:20 UTC (the moment the change shipped).
// Deposits before this keep their old value; only ones after score the new
// price.
export const MASK_RULES_AT = 1787298260667;

// Epoch 1 (pre-2026-07-07): stat potions 0.25, everything else 1.
function pointsEpoch1(itemId: string): number {
  return ITEM_BY_ID.get(itemId)?.category === "Potion" ? 0.25 : 1;
}

// Epoch 2 — see content/blog/2026-07-07-the-pool-is-people.md:
//   regular stat potions 0.15 (greaters stay 0.25), rare eggs 3,
//   uncommon eggs 1.5, Staff of Extreme Prejudice 3, Protective
//   Matrices 3, Amulet of Dispersion 2, Demon Blade 2, Candy-Coated
//   Armor 2.5, everything else 1.
const EPOCH2_SPECIALS: Record<string, number> = {
  sep: 3, // Staff of Extreme Prejudice
  fpm: 3, // Fitted Protective Matrix
  hpm: 3, // Heavy Protective Matrix
  mpm: 3, // Magic Protective Matrix
  aod: 2, // Amulet of Dispersion
  dblade: 2, // Demon Blade
  cca: 2.5, // Candy-Coated Armor
};

function pointsEpoch2(itemId: string): number {
  const special = EPOCH2_SPECIALS[itemId];
  if (special !== undefined) return special;
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return 1;
  if (item.category === "Potion") {
    return item.name.startsWith("Greater") ? 0.25 : 0.15;
  }
  if (item.category === "Egg") {
    if (item.name.startsWith("Rare ")) return 3;
    if (item.name.startsWith("Uncommon ")) return 1.5;
  }
  return 1;
}

// Epoch 3 — epoch 2 plus these overrides, and the enchant multiplier below
// starts applying (the ledger only records enchant counts from this epoch
// on, so older rows are all enchants=0 anyway).
const EPOCH3_SPECIALS: Record<string, number> = {
  rod: 1.5, // Ring of Decades
  tfr: 1.5, // The Forgotten Ring
  ubhp: 1.5, // Ring of Unbound Health
  dbow: 2, // Doom Bow
  dblade: 2.5, // Demon Blade (up from 2)
  uegg_humanoid: 2, // Uncommon Humanoid Egg (other uncommons stay 1.5)
  regg_humanoid: 4, // Rare Humanoid Egg (other rares stay 3)
};

function pointsEpoch3(itemId: string): number {
  const special = EPOCH3_SPECIALS[itemId];
  if (special !== undefined) return special;
  return pointsEpoch2(itemId);
}

// Epoch 4 — epoch 3 plus the Coral set at 2 points each.
const EPOCH4_SPECIALS: Record<string, number> = {
  leather_coralsilk: 2, // Coral Silk Armor
  coral_venom_trap: 2, // Coral Venom Trap
  sharktooth_sigil: 2, // Sharktooth Sigil
};

function pointsEpoch4(itemId: string): number {
  const special = EPOCH4_SPECIALS[itemId];
  if (special !== undefined) return special;
  return pointsEpoch3(itemId);
}

// Epoch 5 — epoch 4 plus the Superior Masks at 3 points each.
const EPOCH5_SPECIALS: Record<string, number> = {
  superior_mask_of_anubis: 3,
  superior_mask_of_cnidaria: 3,
  superior_mask_of_lightning: 3,
  superior_mask_of_mucus: 3,
};

function pointsEpoch5(itemId: string): number {
  const special = EPOCH5_SPECIALS[itemId];
  if (special !== undefined) return special;
  return pointsEpoch4(itemId);
}

// Enchant multiplier (epoch 3+): 1 enchantment ×1.25, 2 or more ×2.
// (The announcement named tiers 1 and 2; 3-4-enchant items are rarer than
// either and capped at the ×2 tier until priced explicitly.)
function enchantMultiplier(enchants: number): number {
  if (enchants >= 2) return 2;
  if (enchants === 1) return 1.25;
  return 1;
}

/** Epoch index (0-based) containing `atMs`. Mirrors the SQL era bucket:
 * (created_at >= NEW_RULES_AT) + (created_at >= ENCHANT_RULES_AT)
 * + (created_at >= CORAL_RULES_AT) + (created_at >= MASK_RULES_AT). */
export function epochIndex(atMs: number): number {
  return (
    (atMs >= NEW_RULES_AT ? 1 : 0) +
    (atMs >= ENCHANT_RULES_AT ? 1 : 0) +
    (atMs >= CORAL_RULES_AT ? 1 : 0) +
    (atMs >= MASK_RULES_AT ? 1 : 0)
  );
}

/** Base points for `itemId` under the hardcoded epochs 1-5 only, before the
 * enchant multiplier. Split out so the published-price path can reuse the
 * multiplier without restating the tables. */
function builtinBasePoints(itemId: string, atMs: number): number {
  const epoch = epochIndex(atMs);
  if (epoch >= 4) return pointsEpoch5(itemId);
  if (epoch === 3) return pointsEpoch4(itemId);
  if (epoch === 2) return pointsEpoch3(itemId);
  if (epoch === 1) return pointsEpoch2(itemId);
  return pointsEpoch1(itemId);
}

/** Points one unit of `itemId` (with `enchants` enchantments) scores in the
 * epoch containing `atMs`.
 *
 * An operator-published price wins when one covers this item at this time —
 * every published epoch is newer than MASK_RULES_AT, so it can only ever
 * override epoch 5, never rewrite an older one. Enchants multiply either way:
 * a published price is a base price, exactly like the hardcoded tables'.
 *
 * Epochs 1 and 2 are the exception, and they predate published prices
 * entirely: no multiplier there, because the ledger recorded no enchant counts
 * until epoch 3 (every older row is enchants=0 anyway). */
export function pointsAt(itemId: string, atMs: number, enchants = 0): number {
  const published = publishedPriceAt(itemId, atMs);
  if (published !== undefined) return published * enchantMultiplier(enchants);
  const base = builtinBasePoints(itemId, atMs);
  return epochIndex(atMs) <= 1 ? base : base * enchantMultiplier(enchants);
}

/** Squash float drift from long alternating sums. Ten-thousandths grid —
 * the ×1.25 multiplier puts values like 0.1875 in play, so hundredths
 * would visibly mis-round. */
export function roundPoints(points: number): number {
  return Math.round(points * 10000) / 10000;
}
