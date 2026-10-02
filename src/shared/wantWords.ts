// Want lines in words, the same on the node (why a bot is holding off in a
// trade window) and on the hub (what a player has to put up). A line's
// enchantment filters are the node's SlotSpec shape (lib/enchantMatch.ts):
// per slot, "or" rows of "and" terms, each term an enchantment name or an
// effect flag such as "+HP". Kept free of node-only imports: the hub loads it.

type Term = { kind?: unknown; name?: unknown; key?: unknown };

function termWords(t: Term): string | null {
  if (t && t.kind === "ench" && typeof t.name === "string") return t.name;
  if (t && t.kind === "effect" && typeof t.key === "string") return t.key;
  return null;
}

/** One slot's filter, "Attack Bonus III or +HP and -Speed"; null when it takes any enchantment. */
export function slotWords(spec: unknown): string | null {
  const rows = (spec as { any?: unknown } | null)?.any;
  if (!Array.isArray(rows)) return null;
  const parts = rows
    .map((r) => {
      const all = (r as { all?: unknown } | null)?.all;
      return Array.isArray(all) ? all.map((t) => termWords(t as Term)).filter((w): w is string => !!w) : [];
    })
    .filter((p) => p.length)
    .map((p) => p.join(" and "));
  return parts.length ? parts.join(" or ") : null;
}

/** What a line asks of a copy's enchantments, "with 2+ enchantments, one of them Attack Bonus III"; "" when any copy does. */
export function conditionWords(line: { slotsMin: number; slotsExact: number | null; enchants: readonly unknown[] }): string {
  const out: string[] = [];
  if (line.slotsExact !== null && line.slotsExact !== undefined) out.push(line.slotsExact === 0 ? "with no enchantments" : `with exactly ${line.slotsExact} enchantment${line.slotsExact === 1 ? "" : "s"}`);
  else if (line.slotsMin > 0) out.push(`with ${line.slotsMin}+ enchantment${line.slotsMin === 1 ? "" : "s"}`);
  const slots = (Array.isArray(line.enchants) ? line.enchants : []).map(slotWords).filter((s): s is string => !!s);
  if (slots.length === 1) out.push(`one of them ${slots[0]}`);
  else if (slots.length > 1) out.push(`enchantments matching ${slots.map((s) => `(${s})`).join(" and ")}`);
  return out.join(", ");
}

/** "2× Doom Bow with 2+ enchantments" */
export function wantLineWords(line: { itemId: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: readonly unknown[] }, itemName: (itemId: string) => string): string {
  const cond = conditionWords(line);
  return `${line.qty > 1 ? `${line.qty}× ` : ""}${itemName(line.itemId)}${cond ? ` ${cond}` : ""}`;
}
