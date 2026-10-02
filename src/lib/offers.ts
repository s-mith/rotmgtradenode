// Offer matching for cross-node swaps (design doc §6.2), ported from the
// old between-vaults trade branch. An offer says what its poster GIVES
// (specific physical items) for what they WANT: catalog items, each with a
// quantity and per-slot enchantment filters (lib/enchantMatch.ts). The node that accepts
// picks the plainest of its own items that fit each line.
import type { WantLineWire } from "@/shared/hubWire";
import { conditionWords, wantLineWords } from "@/shared/wantWords";
import { ITEM_BY_ID } from "./catalog";
import { nodeTakes } from "./itemPolicy";
import { matchesRule, parseSlotSpecs, MAX_SLOTS, type SlotSpec } from "./enchantMatch";

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
  /** In the account's storage rather than on the character: a fetch trip before the trade. */
  stored?: boolean;
  /** This node's open offers that already name it: handing it over elsewhere withdraws them. */
  offers?: number[];
}

/** Does one held item satisfy a wanted line? The enchant matcher decides. */
export function fitsLine(line: WantLine, item: HeldItem): boolean {
  if (item.itemId !== line.itemId) return false;
  return matchesRule({ itemId: line.itemId, slotsMin: line.slotsMin, slotsExact: line.slotsExact, enchants: line.enchants }, item.itemId, item.enchantIds);
}

/**
 * Hand out `items` to the wanted lines, `qty` each, no item twice. Prefers
 * the plainest copies (fewest enchantments, then one no other offer of the
 * node names, then a copy on the character over one in storage, then oldest)
 * so the acceptor keeps their better ones, their other offers stand and the
 * meeting needs no fetch trip when it can be helped. Returns the picks in
 * want-line order, or null when the items can't cover every line.
 */
export function pickForLines(lines: WantLine[], items: HeldItem[]): HeldItem[] | null {
  const sorted = [...items].sort((a, b) => a.enchantIds.length - b.enchantIds.length || (a.offers?.length ?? 0) - (b.offers?.length ?? 0) || Number(!!a.stored) - Number(!!b.stored) || a.createdAt - b.createdAt || a.instanceId.localeCompare(b.instanceId));
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

/** One item as a trade window shows it: its catalog id and enchantment ids (null when the record could not be read). */
export interface WindowItem {
  itemId: string;
  enchantIds: number[] | null;
}

/** An item in a trade window fits a line: the right item, with enchantments the line allows. An unreadable record fits only a line that asks nothing of enchantments. */
export function windowItemFits(line: WantLine, item: WindowItem): boolean {
  if (item.itemId !== line.itemId) return false;
  if (item.enchantIds === null) return line.slotsMin === 0 && line.slotsExact === null && line.enchants.length === 0;
  return fitsLine(line, { instanceId: "", itemId: item.itemId, enchantIds: item.enchantIds, createdAt: 0 });
}

const itemName = (itemId: string): string => ITEM_BY_ID.get(itemId)?.name ?? itemId;

/**
 * Does what a player put up in a trade window cover an offer's want lines?
 * `exact`: every line's quantity is met and nothing else is up, the moment
 * the bot may accept. Otherwise each item up so far must fit a line unit of
 * its own (a player still filling their side). `why` is for the player: what
 * to take out, put up, or swap for another copy.
 */
export function coverLines(lines: WantLine[], items: WindowItem[], exact: boolean): { ok: true } | { ok: false; why: string } {
  // One unit per wanted copy, remembering its line.
  const units: number[] = [];
  lines.forEach((l, li) => {
    for (let k = 0; k < l.qty; k++) units.push(li);
  });
  const cands = items.map((it) => units.map((li, u) => (windowItemFits(lines[li], it) ? u : -1)).filter((u) => u >= 0));
  const stray = cands.findIndex((c) => c.length === 0);
  if (stray >= 0) {
    const it = items[stray];
    const line = lines.find((l) => l.itemId === it.itemId);
    if (!line) return { ok: false, why: `${itemName(it.itemId)} is not part of this trade; take it out` };
    if (it.enchantIds === null) return { ok: false, why: `the bot cannot read the enchantments on your ${itemName(it.itemId)}; put up another copy` };
    return { ok: false, why: `your ${itemName(it.itemId)} does not fit: the trade asks for ${wantLineWords({ ...line, qty: 1 }, itemName)}` };
  }
  // More copies of an item than the lines take, however they are enchanted.
  const upOf = new Map<string, number>();
  for (const it of items) upOf.set(it.itemId, (upOf.get(it.itemId) ?? 0) + 1);
  for (const [id, n] of upOf) {
    const takes = lines.filter((l) => l.itemId === id).reduce((s, l) => s + l.qty, 0);
    if (n > takes) return { ok: false, why: `the trade takes ${takes}× ${itemName(id)} and you put up ${n}; take ${n - takes} out` };
  }
  // Items to units one each, the most constrained item first.
  const order = items.map((_, i) => i).sort((a, b) => cands[a].length - cands[b].length);
  const used = new Set<number>();
  const assign = (k: number): boolean => {
    if (k === order.length) return true;
    for (const u of cands[order[k]]) {
      if (used.has(u)) continue;
      used.add(u);
      if (assign(k + 1)) return true;
      used.delete(u);
    }
    return false;
  };
  if (!assign(0)) return { ok: false, why: "those items cannot each fill a different part of the trade; check which copies you put up" };
  if (!exact || items.length === units.length) return { ok: true };
  const filled = new Map<number, number>();
  for (const u of used) filled.set(units[u], (filled.get(units[u]) ?? 0) + 1);
  const li = lines.findIndex((l, i) => (filled.get(i) ?? 0) < l.qty);
  const short = lines[li];
  const missing = short.qty - (filled.get(li) ?? 0);
  const cond = conditionWords(short);
  return { ok: false, why: `still missing ${missing}× ${itemName(short.itemId)}${cond ? ` ${cond}` : ""}` };
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
    if (!nodeTakes(itemId)) return { ok: false, error: `${ITEM_BY_ID.get(itemId)!.name} is not taken on this node (Control panel → Accepted items).` };
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
