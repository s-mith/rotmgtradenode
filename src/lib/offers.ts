// Offer matching for cross-node swaps (design doc §6.2), ported from the
// old between-vaults trade branch. An offer says what its poster GIVES
// (specific physical items) for what they WANT: catalog items, each with a
// quantity and the wishlist's enchantment filters. The node that accepts
// picks the plainest of its own items that fit each line.
import type { WantLineWire } from "@/shared/hubWire";
import { ITEM_BY_ID } from "./catalog";
import { nodeTakes } from "./itemPolicy";
import { matchesRule, parseSlotSpecs, MAX_SLOTS, type SlotSpec } from "./wishlist";

export const MAX_GIVE_ITEMS = 24;
export const MAX_WANT_LINES = 8;
export const MAX_WANT_ITEMS = 24;

export interface WantLine {
  itemId: string;
  qty: number;
  slotsMin: number;
  slotsExact: number | null;
  enchants: SlotSpec[];
}

/** A physical item this node holds, as the matcher sees it. */
export interface HeldItem {
  instanceId: string;
  itemId: string;
  enchantIds: number[];
  createdAt: number;
}

/** Does one held item satisfy a wanted line? The wishlist matcher decides. */
export function fitsLine(line: WantLine, item: HeldItem): boolean {
  if (item.itemId !== line.itemId) return false;
  return matchesRule({ itemId: line.itemId, slotsMin: line.slotsMin, slotsExact: line.slotsExact, enchants: line.enchants }, item.itemId, item.enchantIds);
}

/**
 * Hand out `items` to the wanted lines, `qty` each, no item twice. Prefers
 * the plainest copies (fewest enchantments, then oldest) so the acceptor
 * keeps their better ones. Returns the picks in want-line order, or null
 * when the items can't cover every line.
 */
export function pickForLines(lines: WantLine[], items: HeldItem[]): HeldItem[] | null {
  const sorted = [...items].sort((a, b) => a.enchantIds.length - b.enchantIds.length || a.createdAt - b.createdAt || a.instanceId.localeCompare(b.instanceId));
  const needs: { line: number; cands: number[] }[] = [];
  lines.forEach((line, li) => {
    const cands: number[] = [];
    sorted.forEach((it, i) => {
      if (fitsLine(line, it)) cands.push(i);
    });
    for (let k = 0; k < line.qty; k++) needs.push({ line: li, cands });
  });
  needs.sort((a, b) => a.cands.length - b.cands.length);
  const used = new Set<number>();
  const chosen: { line: number; item: number }[] = [];
  const go = (i: number): boolean => {
    if (i === needs.length) return true;
    for (const c of needs[i].cands) {
      if (used.has(c)) continue;
      used.add(c);
      chosen.push({ line: needs[i].line, item: c });
      if (go(i + 1)) return true;
      used.delete(c);
      chosen.pop();
    }
    return false;
  };
  if (!go(0)) return null;
  return chosen.sort((a, b) => a.line - b.line || a.item - b.item).map((c) => sorted[c.item]);
}

/** Why a set of items can't cover an offer: the first line they fall short on. */
export function shortfall(lines: WantLine[], items: HeldItem[]): string {
  for (const line of lines) {
    const have = items.filter((it) => fitsLine(line, it)).length;
    if (have >= line.qty) continue;
    const name = ITEM_BY_ID.get(line.itemId)?.name ?? line.itemId;
    const cond = line.slotsExact !== null ? ` with exactly ${line.slotsExact} enchantment${line.slotsExact === 1 ? "" : "s"}` : line.slotsMin > 0 ? ` with ${line.slotsMin}+ enchantment${line.slotsMin === 1 ? "" : "s"}` : "";
    return `You need ${line.qty}× ${name}${cond}${line.enchants.length ? " (matching the offer's enchantment filter)" : ""} — you have ${have} that fit${have === 1 ? "s" : ""}.`;
  }
  return "Your items don't cover that offer.";
}

/** Validate what a user typed into the offer form into want lines. */
export function parseWantInput(raw: unknown): { ok: true; want: WantLine[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "Say what you want in return: at least one item." };
  if (raw.length > MAX_WANT_LINES) return { ok: false, error: `At most ${MAX_WANT_LINES} different items in one offer.` };
  const want: WantLine[] = [];
  let total = 0;
  for (const line of raw) {
    if (!line || typeof line !== "object") return { ok: false, error: "Bad wanted item." };
    const { itemId, qty, slotsMin, slotsExact, enchants } = line as { itemId?: unknown; qty?: unknown; slotsMin?: unknown; slotsExact?: unknown; enchants?: unknown };
    if (typeof itemId !== "string" || !ITEM_BY_ID.has(itemId)) return { ok: false, error: "Pick items the catalog knows." };
    if (!nodeTakes(itemId)) return { ok: false, error: `${ITEM_BY_ID.get(itemId)!.name} is not taken on this node (Control panel → Trading → Accepted items).` };
    const q = qty === undefined ? 1 : Number(qty);
    if (!Number.isInteger(q) || q < 1 || q > MAX_WANT_ITEMS) return { ok: false, error: `Quantity must be 1-${MAX_WANT_ITEMS}.` };
    total += q;
    if (total > MAX_WANT_ITEMS) return { ok: false, error: `An offer can ask for at most ${MAX_WANT_ITEMS} items in all.` };
    const slots = (v: unknown): number | null | undefined => (v === undefined || v === null || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= MAX_SLOTS ? Number(v) : undefined);
    const min = slots(slotsMin);
    const exact = slots(slotsExact);
    if (min === undefined || exact === undefined) return { ok: false, error: `Enchantment slots must be 0-${MAX_SLOTS}.` };
    const specs = parseSlotSpecs(enchants ?? []);
    if (!specs.ok) return specs;
    const need = specs.specs.length;
    if (exact !== null && need > exact) return { ok: false, error: `${need} enchantments are described but exactly ${exact} slot${exact === 1 ? "" : "s"} are allowed.` };
    want.push({ itemId, qty: q, slotsMin: exact !== null ? exact : Math.max(min ?? 0, need), slotsExact: exact, enchants: specs.specs });
  }
  return { ok: true, want };
}

/** Want lines as the hub carries them (the SlotSpec[] rides opaque) and back. */
export function wantToWire(want: WantLine[]): WantLineWire[] {
  return want.map((w) => ({ itemId: w.itemId, qty: w.qty, slotsMin: w.slotsMin, slotsExact: w.slotsExact, enchants: w.enchants as unknown[] }));
}
export function wantFromWire(wire: WantLineWire[]): WantLine[] {
  return wire.map((w) => {
    const specs = parseSlotSpecs(w.enchants);
    return { itemId: w.itemId, qty: w.qty, slotsMin: w.slotsMin, slotsExact: w.slotsExact, enchants: specs.ok ? specs.specs : [] };
  });
}
