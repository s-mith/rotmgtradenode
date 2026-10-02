import { effectsOfEnchant } from "./enchantEffects";
import { enchantName } from "./enchants";

// Enchantment filters for the items a trade offer asks for (lib/offers.ts).
// A wanted line names an item, how many enchantment slots it should carry,
// and a filter per slot — exact names, or the "+HP" / "-Speed" effect flags
// the pool search offers.
//
// Each slot filter is rows of terms: a row fits an enchantment when every
// term describes it (one name at most, plus effects it must have), and any
// one row fitting is enough. So slot 1 = "Attack Bonus III or (+HP and
// -Speed)" is
//   { any: [ { all: [ench Attack Bonus III] }, { all: [+HP, -Speed] } ] }.
// No rows means any enchantment. An item fits when its enchantments can be
// handed out to the slot filters one each, no enchantment used twice — the
// filters are unordered, "Enchantment 1" is just a label.

export const MAX_GROUPS = 6;
export const MAX_TERMS_PER_GROUP = 4;
/**
 * Enchantment slots a line may ask for. An item with more than this many
 * enchantments can't be traded in game, so it can never reach the pool or
 * leave a vault; asking for one would never be served.
 */
export const MAX_SLOTS = 2;

export type MatchTerm = { kind: "ench"; name: string } | { kind: "effect"; key: string };
/** One slot's filter. Empty `any` accepts any enchantment. */
export type SlotSpec = { any: { all: MatchTerm[] }[] };

// --- Spec parsing -----------------------------------------------------------

const EFFECT_KEY = /^[+-][A-Za-z ]{1,32}$/;

function parseSlotSpec(raw: unknown): { ok: true; spec: SlotSpec } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, spec: { any: [] } };
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { any?: unknown }).any)) return { ok: false, error: "Each slot filter must be { any: [{ all: [...] }] }" };
  const rows = (raw as { any: unknown[] }).any;
  if (rows.length > MAX_GROUPS) return { ok: false, error: `At most ${MAX_GROUPS} "or" rows per slot` };
  const any: { all: MatchTerm[] }[] = [];
  for (const g of rows) {
    if (!g || typeof g !== "object" || !Array.isArray((g as { all?: unknown }).all)) return { ok: false, error: "Each row must be { all: [...] }" };
    const terms = (g as { all: unknown[] }).all;
    if (terms.length > MAX_TERMS_PER_GROUP) return { ok: false, error: `At most ${MAX_TERMS_PER_GROUP} conditions per row` };
    const all: MatchTerm[] = [];
    const seen = new Set<string>();
    let names = 0;
    for (const t of terms) {
      if (!t || typeof t !== "object") return { ok: false, error: "Bad condition" };
      const { kind } = t as { kind?: unknown };
      let term: MatchTerm;
      if (kind === "ench") {
        const name = (t as { name?: unknown }).name;
        if (typeof name !== "string" || !name.trim() || name.length > 64) return { ok: false, error: "Enchantment condition needs a name" };
        term = { kind: "ench", name: name.trim() };
      } else if (kind === "effect") {
        const key = (t as { key?: unknown }).key;
        if (typeof key !== "string" || !EFFECT_KEY.test(key)) return { ok: false, error: "Effect condition needs a key like \"+HP\"" };
        term = { kind: "effect", key };
      } else {
        return { ok: false, error: "Condition kind must be ench or effect" };
      }
      const k = term.kind === "ench" ? `ench:${term.name}` : `effect:${term.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (term.kind === "ench" && ++names > 1) return { ok: false, error: "A row describes one enchantment — one name per row; add an \"or\" row for another." };
      all.push(term);
    }
    // An empty row would accept any enchantment, which is never what a row
    // of chips meant; drop it rather than let it swallow the other rows.
    if (all.length) any.push({ all });
  }
  return { ok: true, spec: { any } };
}

/**
 * The per-slot filters of a rule. Trailing filters with no rows say nothing
 * the slot count doesn't already, so they are trimmed.
 */
export function parseSlotSpecs(raw: unknown): { ok: true; specs: SlotSpec[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, specs: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "enchants must be a list of slot filters" };
  if (raw.length > 16) return { ok: false, error: "Too many slot filters" };
  const specs: SlotSpec[] = [];
  for (const r of raw) {
    const p = parseSlotSpec(r);
    if (!p.ok) return p;
    specs.push(p.spec);
  }
  while (specs.length && !specs[specs.length - 1].any.length) specs.pop();
  if (specs.length > MAX_SLOTS) return { ok: false, error: `At most ${MAX_SLOTS} enchantment slots — items with more can't be traded.` };
  return { ok: true, specs };
}

// --- Matching ---------------------------------------------------------------

export type RuleShape = { itemId: string; slotsMin: number; slotsExact: number | null; enchants: SlotSpec[] };

/** Does one enchantment satisfy a term? */
export function termMatches(term: MatchTerm, enchantId: number): boolean {
  if (term.kind === "ench") return (enchantName(enchantId) ?? `Enchant #${enchantId}`) === term.name;
  return effectsOfEnchant(enchantId).includes(term.key);
}

/** Does one enchantment pass a slot filter? */
export function enchantFits(spec: SlotSpec, enchantId: number): boolean {
  return !spec.any.length || spec.any.some((row) => row.all.every((t) => termMatches(t, enchantId)));
}

/** Does an item of `itemId` carrying `enchantIds` satisfy the rule? */
export function matchesRule(rule: RuleShape, itemId: string, enchantIds: number[]): boolean {
  if (rule.itemId !== itemId) return false;
  const n = enchantIds.length;
  // Never an untradable item, however open the line.
  if (n > MAX_SLOTS) return false;
  if (rule.slotsExact !== null ? n !== rule.slotsExact : n < rule.slotsMin) return false;
  const specs = rule.enchants;
  if (specs.length > n) return false;
  // Hand the item's enchantments to the filters one each, no enchantment
  // twice. At most four of either, so a plain search is fine.
  const fits = specs.map((spec) => enchantIds.map((id) => enchantFits(spec, id)));
  const used: boolean[] = new Array(n).fill(false);
  const assign = (i: number): boolean => {
    if (i === specs.length) return true;
    for (let j = 0; j < n; j++) {
      if (used[j] || !fits[i][j]) continue;
      used[j] = true;
      if (assign(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return assign(0);
}
