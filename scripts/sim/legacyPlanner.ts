// The planner as it was before scoring, swaps and demand: the pyrelay port,
// kept verbatim so the simulator can measure the new one against it.
export const POTION_INFO: Record<string, [stat: string, points: number]> = {
  patk: ["atk", 1], gpatk: ["atk", 2], pdef: ["def", 1], gpdef: ["def", 2],
  pspd: ["spd", 1], gpspd: ["spd", 2], pvit: ["vit", 1], gpvit: ["vit", 2],
  pwis: ["wis", 1], gpwis: ["wis", 2], pdex: ["dex", 1], gpdex: ["dex", 2],
  plife: ["life", 1], gplife: ["life", 2], pmana: ["mana", 1], gpmana: ["mana", 2],
};
export const STATS = ["atk", "def", "spd", "vit", "wis", "dex", "life", "mana"] as const;
export const MAX_ITEMS_PER_TRADE = 8;
export const MIN_ITEMS_PER_MOVE = 1;

export type Inventory = Record<string, number>;
export type Inventories = Record<string, Inventory>;

export interface Move {
  giver: string;
  taker: string;
  items: Record<string, number>;
  stat: string;
}
export function moveItemCount(m: Move): number {
  return Object.values(m.items).reduce((a, b) => a + b, 0);
}

export function potionsOnly(inv: Inventory): Inventory {
  const out: Inventory = {};
  for (const [k, v] of Object.entries(inv)) if (k in POTION_INFO && v > 0) out[k] = v;
  return out;
}

export function statCounts(inv: Inventory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, qty] of Object.entries(potionsOnly(inv))) {
    const stat = POTION_INFO[id][0];
    out[stat] = (out[stat] ?? 0) + qty;
  }
  return out;
}

/** bot -> the stat it collects (the one it holds most of). */
export function electRoles(inventories: Inventories): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const guid of Object.keys(inventories).sort()) {
    const counts = statCounts(inventories[guid]);
    const entries = Object.entries(counts);
    if (!entries.length) continue;
    entries.sort((a, b) => b[1] - a[1] || STATS.indexOf(a[0] as never) - STATS.indexOf(b[0] as never));
    roles[guid] = entries[0][0];
  }
  return roles;
}

function holdsStat(inv: Inventory, stat: string): boolean {
  return Object.keys(potionsOnly(inv)).some((i) => POTION_INFO[i][0] === stat);
}

/** stat -> the bot everything of that stat is gathered onto. */
export function collectionTargets(inventories: Inventories, eligible?: Set<string>): Record<string, string> {
  const pool: Inventories = {};
  for (const [g, inv] of Object.entries(inventories)) if (!eligible || eligible.has(g)) pool[g] = inv;
  const roles = electRoles(pool);
  const out: Record<string, string> = {};
  for (const stat of STATS) {
    const holders = Object.keys(pool).filter((g) => holdsStat(pool[g], stat));
    if (holders.length < 2) continue;
    holders.sort((a, b) => {
      const ra = roles[a] !== stat ? 1 : 0;
      const rb = roles[b] !== stat ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const ca = statCounts(pool[a])[stat] ?? 0;
      const cb = statCounts(pool[b])[stat] ?? 0;
      if (ca !== cb) return cb - ca;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    out[stat] = holders[0];
  }
  return out;
}

/** Items a collector holds that packing will never move off it. */
export function offloadItems(inv: Inventory, targetStats: Set<string>, statsWithCollector: Set<string>): Inventory {
  const out: Inventory = {};
  for (const [id, qty] of Object.entries(inv)) {
    if (qty <= 0) continue;
    const info = POTION_INFO[id];
    if (!info) {
      out[id] = qty;
      continue;
    }
    if (targetStats.has(info[0]) || statsWithCollector.has(info[0])) continue;
    out[id] = qty;
  }
  return out;
}

export function freeSlots(inv: Inventory, capacity: number): number {
  const used = Object.values(inv).reduce((a, v) => a + (v > 0 ? v : 0), 0);
  return Math.max(0, capacity - used);
}

export function planMoves(
  inventories: Inventories,
  capacities: Record<string, number>,
  opts: { eligible?: Set<string>; defaultCapacity?: number; maxMoves?: number; statOffset?: number } = {},
): Move[] {
  const eligible = opts.eligible ?? new Set(Object.keys(inventories));
  const defaultCapacity = opts.defaultCapacity ?? 8;
  const bots: Inventories = {};
  for (const [g, inv] of Object.entries(inventories)) if (eligible.has(g)) bots[g] = inv;
  if (Object.keys(bots).length < 2) return [];

  const roles = electRoles(bots);
  const remaining: Inventories = {};
  const room: Record<string, number> = {};
  for (const [g, inv] of Object.entries(bots)) {
    remaining[g] = { ...potionsOnly(inv) };
    room[g] = freeSlots(inv, capacities[g] ?? defaultCapacity);
  }
  const moves: Move[] = [];
  const busy = new Set<string>();

  const planOne = (stat: string): Move | null => {
    const ranked = Object.keys(remaining)
      .filter((g) => !busy.has(g) && Object.keys(remaining[g]).some((i) => POTION_INFO[i][0] === stat))
      .sort((a, b) => {
        const ra = roles[a] !== stat ? 1 : 0;
        const rb = roles[b] !== stat ? 1 : 0;
        if (ra !== rb) return ra - rb;
        const ca = statCounts(bots[a])[stat] ?? 0;
        const cb = statCounts(bots[b])[stat] ?? 0;
        if (ca !== cb) return cb - ca;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (ranked.length < 2) return null;
    const rankOf = new Map(ranked.map((g, i) => [g, i]));
    for (const giver of [...ranked].reverse()) {
      if (busy.has(giver) || rankOf.get(giver) === 0) continue;
      const offer: Inventory = {};
      for (const id of Object.keys(remaining[giver]).sort()) {
        if (POTION_INFO[id][0] !== stat) continue;
        if (remaining[giver][id] > 0) offer[id] = remaining[giver][id];
      }
      if (!Object.keys(offer).length) continue;
      for (const taker of ranked) {
        if ((rankOf.get(taker) ?? 0) >= (rankOf.get(giver) ?? 0)) break;
        if (busy.has(taker)) continue;
        const capacityLeft = Math.min(room[taker] ?? 0, MAX_ITEMS_PER_TRADE);
        if (capacityLeft <= 0) continue;
        const trimmed: Inventory = {};
        let budget = capacityLeft;
        // Greaters first: worth double per slot.
        for (const id of Object.keys(offer).sort((a, b) => POTION_INFO[b][1] - POTION_INFO[a][1] || (a < b ? -1 : 1))) {
          if (budget <= 0) break;
          const take = Math.min(offer[id], budget);
          if (take > 0) {
            trimmed[id] = take;
            budget -= take;
          }
        }
        const moved = Object.values(trimmed).reduce((a, b) => a + b, 0);
        if (moved < MIN_ITEMS_PER_MOVE) continue;
        busy.add(giver);
        busy.add(taker);
        room[taker] -= moved;
        for (const [id, qty] of Object.entries(trimmed)) {
          remaining[giver][id] -= qty;
          if (remaining[giver][id] <= 0) delete remaining[giver][id];
        }
        return { giver, taker, items: trimmed, stat };
      }
    }
    return null;
  };

  const off = (opts.statOffset ?? 0) % STATS.length;
  const order = [...STATS.slice(off), ...STATS.slice(0, off)];
  const max = opts.maxMoves;
  while (max === undefined || moves.length < max) {
    let progressed = false;
    for (const stat of order) {
      if (max !== undefined && moves.length >= max) break;
      const m = planOne(stat);
      if (m) {
        moves.push(m);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return moves;
}
