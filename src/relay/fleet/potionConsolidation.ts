// Plan bot-to-bot moves so each kind of item clusters onto as few bots as
// the pool's capacity allows. Pure: inventories in, moves out.
//
// The site fragments a withdraw across bots and pins each fragment to one of
// them, so what the player pays for is the number of trades. The planner's
// job is therefore to make each "bucket" (a stat, one potion type once there
// is enough of it to fill bots on its own, and everything that isn't a
// potion as one more bucket) live on the fewest bots possible — which is the
// same as keeping the most bots empty — without touching anything a pending
// withdraw already counts on.
//
// Every candidate move gets a score — potions moved, bots emptied, buckets
// cleared off a giver, collectors filled — minus what it costs to set up
// (wakes, a server hop). The best non-overlapping candidates win. Withdraws
// that no bot can serve today arrive as demand and outrank everything else.
// A swap trades items both ways in one window, so two full bots can still
// untangle each other.
import { planPotionWithdraw, POTION_IDS, POTION_STATS, type PotionStat } from "../../lib/potionPlan";

export const POTION_INFO: Record<string, [stat: string, points: number]> = {
  patk: ["atk", 1], gpatk: ["atk", 2], pdef: ["def", 1], gpdef: ["def", 2],
  pspd: ["spd", 1], gpspd: ["spd", 2], pvit: ["vit", 1], gpvit: ["vit", 2],
  pwis: ["wis", 1], gpwis: ["wis", 2], pdex: ["dex", 1], gpdex: ["dex", 2],
  plife: ["life", 1], gplife: ["life", 2], pmana: ["mana", 1], gpmana: ["mana", 2],
};
export const STATS = ["atk", "def", "spd", "vit", "wis", "dex", "life", "mana"] as const;
export const MAX_ITEMS_PER_TRADE = 8;
export const DEFAULT_CAPACITY = 8;
/** Everything that isn't a potion is gathered as one bucket of its own. */
export const MISC_BUCKET = "misc";

export type Inventory = Record<string, number>;
export type Inventories = Record<string, Inventory>;
export type MoveKind = "demand" | "swap" | "give";
export type SplitMode = "auto" | "always" | "never";

export interface Move {
  giver: string;
  taker: string;
  /** giver -> taker */
  items: Inventory;
  /** taker -> giver; only on swaps */
  swapItems?: Inventory;
  /** The bucket being gathered ("def", "gpdef", "misc"), "a<>b" for a swap, or "demand". */
  stat: string;
  kind: MoveKind;
  score: number;
  reason: string;
}
/** A pending withdraw nobody can serve: items wanted, and the bot it is pinned to (if any). */
export interface Demand {
  items: Inventory;
  target: string | null;
}
export interface Weights {
  /** Cost per bot that is offline and would need a login. */
  wake: number;
  /** Cost when both bots are online but on different servers. */
  hop: number;
  /** Bonus when the giver ends up holding nothing at all. */
  emptiesGiver: number;
  /** Graded bonus for how close to empty the giver ends up (full weight at 0 items left). */
  drain: number;
  /** Bonus when the giver ends up holding none of the bucket. */
  clearsBucket: number;
  /** Bonus when the taker reaches a full trade's worth of the bucket, or fills up. */
  fillsCollector: number;
  /** Bonus for a move that makes a pending withdraw servable. */
  demand: number;
  /** Bonus for a swap: two moves' worth of work in one trade. */
  swap: number;
  /** Per potion of the bucket the taker already holds: a tie-breaker that fills the fullest collector first. */
  pack: number;
}
export const DEFAULT_WEIGHTS: Weights = { wake: 2, hop: 3, emptiesGiver: 4, drain: 2, clearsBucket: 2, fillsCollector: 2, demand: 20, swap: 1, pack: 0.05 };

export interface PlanOptions {
  /** Bots allowed to take part; default every bot in `inventories`. */
  eligible?: Set<string>;
  /** Bots currently in world. Unknown = treat everyone as online (no cost). */
  online?: Set<string>;
  /** bot -> server it is on (or its home server); used for the hop cost. */
  servers?: Record<string, string>;
  /** bot -> items pinned by pending withdraws; never moved off that bot. */
  reserved?: Inventories;
  demand?: Demand[];
  /** Roles from the previous pass; a bot keeps its role until clearly outgrown. */
  roles?: Record<string, string>;
  defaultCapacity?: number;
  maxMoves?: number;
  allowSwaps?: boolean;
  /** Candidates scoring below this are not worth a trade. */
  minScore?: number;
  weights?: Partial<Weights>;
  splitGreaters?: SplitMode;
  hysteresis?: number;
  /** Collector ordering; see TargetOptions.order. */
  order?: "count" | "role";
}

export function moveItemCount(m: Move): number {
  return count(m.items) + (m.swapItems ? count(m.swapItems) : 0);
}
export function count(inv: Inventory | undefined): number {
  if (!inv) return 0;
  let n = 0;
  for (const v of Object.values(inv)) if (v > 0) n += v;
  return n;
}
export function potionsOnly(inv: Inventory): Inventory {
  const out: Inventory = {};
  for (const [k, v] of Object.entries(inv)) if (k in POTION_INFO && v > 0) out[k] = v;
  return out;
}
export function freeSlots(inv: Inventory, capacity: number): number {
  return Math.max(0, capacity - count(inv));
}
function heldOnly(inv: Inventory | undefined): Inventory {
  const out: Inventory = {};
  for (const [k, v] of Object.entries(inv ?? {})) if (v > 0) out[k] = v;
  return out;
}
function minus(inv: Inventory, take: Inventory | undefined): Inventory {
  const out: Inventory = { ...inv };
  for (const [k, v] of Object.entries(take ?? {})) {
    if (!(k in out)) continue;
    out[k] -= v;
    if (out[k] <= 0) delete out[k];
  }
  return out;
}

// --- buckets ----------------------------------------------------------------------

/** Rank for deterministic ordering: stat order, then normal before greater, misc last. */
export function bucketRank(bucket: string): number {
  const info = POTION_INFO[bucket];
  if (info) return STATS.indexOf(info[0] as never) * 3 + info[1];
  const i = STATS.indexOf(bucket as never);
  if (i >= 0) return i * 3;
  return bucket === MISC_BUCKET ? 100 : 1000;
}
/** The bucket an item is gathered under: its stat (or itself when the stat is split), or misc. */
export function bucketOf(itemId: string, split: Set<string>): string {
  const info = POTION_INFO[itemId];
  if (!info) return MISC_BUCKET;
  return split.has(info[0]) ? itemId : info[0];
}
/** Stats whose normal and greater potions are gathered separately: each
 *  kind has enough in the pool to fill a bot on its own. */
export function splitStats(inventories: Inventories, opts: { mode?: SplitMode; capacity?: number } = {}): Set<string> {
  const mode = opts.mode ?? "auto";
  if (mode === "never") return new Set();
  if (mode === "always") return new Set(STATS);
  const cap = opts.capacity ?? DEFAULT_CAPACITY;
  const totals: Record<string, number> = {};
  for (const inv of Object.values(inventories)) for (const [id, q] of Object.entries(potionsOnly(inv))) totals[id] = (totals[id] ?? 0) + q;
  const out = new Set<string>();
  for (const stat of STATS) {
    const { normal, greater } = POTION_IDS[stat];
    if ((totals[normal] ?? 0) >= cap && (totals[greater] ?? 0) >= cap) out.add(stat);
  }
  return out;
}
export function bucketCounts(inv: Inventory, split: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, q] of Object.entries(inv)) {
    if (q <= 0) continue;
    const b = bucketOf(id, split);
    out[b] = (out[b] ?? 0) + q;
  }
  return out;
}
function bucketItems(inv: Inventory, bucket: string, split: Set<string>): Inventory {
  const out: Inventory = {};
  for (const [id, q] of Object.entries(inv)) if (q > 0 && bucketOf(id, split) === bucket) out[id] = q;
  return out;
}

// --- roles and collectors ---------------------------------------------------------

/** bot -> the bucket it gathers: the one it holds most of, kept from the
 *  previous pass until another bucket outgrows it by more than `hysteresis`. */
export function electRoles(inventories: Inventories, opts: { split?: Set<string>; previous?: Record<string, string>; hysteresis?: number } = {}): Record<string, string> {
  const split = opts.split ?? new Set();
  const hysteresis = opts.hysteresis ?? 2;
  const roles: Record<string, string> = {};
  for (const guid of Object.keys(inventories).sort()) {
    const counts = bucketCounts(inventories[guid], split);
    const entries = Object.entries(counts);
    if (!entries.length) continue;
    entries.sort((a, b) => b[1] - a[1] || bucketRank(a[0]) - bucketRank(b[0]));
    const [best, bestCount] = entries[0];
    const prev = opts.previous?.[guid];
    if (prev && prev !== best && (counts[prev] ?? 0) > 0 && bestCount - counts[prev] <= hysteresis) roles[guid] = prev;
    else roles[guid] = best;
  }
  return roles;
}

export interface TargetOptions {
  eligible?: Set<string>;
  capacities?: Record<string, number>;
  defaultCapacity?: number;
  split?: Set<string>;
  roles?: Record<string, string>;
  /** "count" (default): the biggest holders collect, role breaks ties. "role": bots in the role first, then by count. */
  order?: "count" | "role";
}
/** bucket -> the bots it is gathered onto, best first. As many as it takes
 *  for their room to hold the pool's whole bucket: the biggest holders
 *  (potions only ever flow uphill, so a stack is never split to seed a
 *  smaller one), then empty bots nobody else claimed. */
export function collectionTargets(inventories: Inventories, opts: TargetOptions = {}): Record<string, string[]> {
  const pool: Inventories = {};
  for (const g of Object.keys(inventories).sort()) if (!opts.eligible || opts.eligible.has(g)) pool[g] = inventories[g];
  const split = opts.split ?? splitStats(pool, { capacity: opts.defaultCapacity });
  const roles = opts.roles ?? electRoles(pool, { split });
  const cap = (g: string) => opts.capacities?.[g] ?? opts.defaultCapacity ?? DEFAULT_CAPACITY;
  const counts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  const holders: Record<string, string[]> = {};
  for (const [g, inv] of Object.entries(pool)) {
    counts[g] = bucketCounts(inv, split);
    for (const [b, n] of Object.entries(counts[g])) {
      totals[b] = (totals[b] ?? 0) + n;
      (holders[b] ??= []).push(g);
    }
  }
  const taken = new Set<string>();
  const out: Record<string, string[]> = {};
  const buckets = Object.keys(totals).filter((b) => holders[b].length >= 2).sort((a, b) => totals[b] - totals[a] || bucketRank(a) - bucketRank(b));
  const roleFirst = opts.order === "role";
  for (const b of buckets) {
    const roomFor = (g: string) => (counts[g][b] ?? 0) + freeSlots(pool[g], cap(g));
    const inRole = (g: string) => (roles[g] === b ? 0 : 1);
    // Empty bots are a shared resource: one bucket each. Holders are not —
    // a bot with the most of two buckets collects both.
    const empty = (g: string) => count(pool[g]) === 0;
    const cands = Object.keys(pool)
      .filter((g) => (counts[g][b] ?? 0) > 0 || (empty(g) && !taken.has(g)))
      .sort((a, c) => {
        const byRole = inRole(a) - inRole(c);
        const byCount = (counts[c][b] ?? 0) - (counts[a][b] ?? 0);
        return (roleFirst ? byRole || byCount : byCount || byRole) || roomFor(c) - roomFor(a) || (a < c ? -1 : 1);
      });
    const chosen: string[] = [];
    let room = 0;
    for (const g of cands) {
      if (chosen.length && room >= totals[b]) break;
      if (roomFor(g) <= 0 && chosen.length) continue;
      chosen.push(g);
      if (empty(g)) taken.add(g);
      room += roomFor(g);
    }
    if (chosen.length) out[b] = chosen;
  }
  return out;
}

// --- planning ----------------------------------------------------------------------

const KIND_RANK: Record<MoveKind, number> = { demand: 0, swap: 1, give: 2 };

/** Greaters first (two points per slot), then by id, up to `limit` items. */
function pick(from: Inventory, limit: number): Inventory {
  const out: Inventory = {};
  let budget = limit;
  const ids = Object.keys(from).sort((a, b) => (POTION_INFO[b]?.[1] ?? 0) - (POTION_INFO[a]?.[1] ?? 0) || (a < b ? -1 : 1));
  for (const id of ids) {
    if (budget <= 0) break;
    const take = Math.min(from[id], budget);
    if (take > 0) {
      out[id] = take;
      budget -= take;
    }
  }
  return out;
}

export function planMoves(inventories: Inventories, capacities: Record<string, number>, opts: PlanOptions = {}): Move[] {
  const W: Weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const eligible = opts.eligible ?? new Set(Object.keys(inventories));
  const defaultCapacity = opts.defaultCapacity ?? DEFAULT_CAPACITY;
  const maxItems = MAX_ITEMS_PER_TRADE;
  const bots: Inventories = {};
  for (const g of Object.keys(inventories).sort()) if (eligible.has(g)) bots[g] = heldOnly(inventories[g]);
  const guids = Object.keys(bots);
  if (guids.length < 2) return [];

  const split = splitStats(bots, { mode: opts.splitGreaters ?? "auto", capacity: defaultCapacity });
  const roles = electRoles(bots, { split, previous: opts.roles, hysteresis: opts.hysteresis });
  const targets = collectionTargets(bots, { capacities, defaultCapacity, split, roles, order: opts.order });
  const collects = new Map<string, Set<string>>();
  for (const [b, gs] of Object.entries(targets)) for (const g of gs) (collects.get(g) ?? collects.set(g, new Set()).get(g)!).add(b);

  const room: Record<string, number> = {};
  const movable: Inventories = {};
  const counts: Record<string, Record<string, number>> = {};
  const movableCounts: Record<string, Record<string, number>> = {};
  const total: Record<string, number> = {};
  for (const g of guids) {
    total[g] = count(bots[g]);
    room[g] = freeSlots(bots[g], capacities[g] ?? defaultCapacity);
    movable[g] = minus(bots[g], opts.reserved?.[g]);
    counts[g] = bucketCounts(bots[g], split);
    movableCounts[g] = bucketCounts(movable[g], split);
  }
  const online = opts.online;
  const servers = opts.servers ?? {};
  const cost = (a: string, b: string): number => {
    if (!online) return 0;
    const oa = online.has(a);
    const ob = online.has(b);
    let c = W.wake * (Number(!oa) + Number(!ob));
    if (oa && ob && servers[a] && servers[b] && servers[a] !== servers[b]) c += W.hop;
    return c;
  };
  /** How much closer to empty the giver gets: full weight when nothing is left. */
  const drainAfter = (g: string, left: number): number => W.drain * (1 - left / Math.max(1, capacities[g] ?? defaultCapacity));
  const describe = (parts: string[]) => parts.filter(Boolean).join(", ");
  const cands: Move[] = [];

  // Demand: a withdraw nobody can serve. Top up the bot it is pinned to
  // (or whoever already covers most of it) with what it lacks.
  for (const d of opts.demand ?? []) {
    const want = heldOnly(d.items);
    if (!count(want)) continue;
    let taker = d.target;
    if (taker && !bots[taker]) continue;
    if (!taker) {
      const covered = (g: string) => Object.entries(want).reduce((a, [id, q]) => a + Math.min(q, bots[g][id] ?? 0), 0);
      taker = [...guids].sort((a, b) => covered(b) - covered(a) || room[b] - room[a] || (a < b ? -1 : 1))[0];
    }
    const missing = minus(want, bots[taker]);
    if (!count(missing)) continue;
    for (const giver of guids) {
      if (giver === taker) continue;
      const have: Inventory = {};
      for (const [id, q] of Object.entries(missing)) if ((movable[giver][id] ?? 0) > 0) have[id] = Math.min(q, movable[giver][id]);
      const offer = pick(have, Math.min(room[taker], maxItems));
      const n = count(offer);
      if (!n) continue;
      const covers = count(minus(missing, offer)) === 0;
      const left = total[giver] - n;
      const empties = left === 0;
      const score = W.demand * (covers ? 1 : 0.5) + n + (empties ? W.emptiesGiver : 0) + drainAfter(giver, left) - cost(giver, taker);
      cands.push({ giver, taker, items: offer, stat: "demand", kind: "demand", score, reason: describe([`${covers ? "completes" : "part of"} a pending withdraw`, empties ? "empties the giver" : ""]) });
    }
  }

  // Gives: a bucket flows onto its collectors, and from a lesser collector
  // up to a bigger one with room, so stacks keep merging. A big pool has
  // hundreds of collectors per bucket, so each giver looks at two takers
  // only: the fullest that fits the whole stack, and the roomiest.
  const perBucket = new Map<string, { rankOf: Map<string, number>; withRoom: string[]; roomiest: string | undefined }>();
  for (const [bucket, collectors] of Object.entries(targets)) {
    const rankOf = new Map(collectors.map((g, i) => [g, i]));
    const withRoom = collectors.filter((g) => room[g] > 0);
    const roomiest = [...withRoom].sort((a, b) => room[b] - room[a] || (rankOf.get(a)! - rankOf.get(b)!))[0];
    perBucket.set(bucket, { rankOf, withRoom, roomiest });
  }
  for (const giver of guids) {
    for (const bucket of Object.keys(movableCounts[giver])) {
      const pb = perBucket.get(bucket);
      if (!pb) continue;
      const { rankOf, withRoom, roomiest } = pb;
      const giverRank = rankOf.get(giver) ?? -1;
      const have = bucketItems(movable[giver], bucket, split);
      const stack = count(have);
      if (!stack) continue;
      const above = (g: string) => giverRank === -1 || rankOf.get(g)! < giverRank;
      const fits = withRoom.find((g) => above(g) && room[g] >= Math.min(stack, maxItems));
      const takers = new Set<string>();
      if (fits) takers.add(fits);
      if (roomiest && above(roomiest)) takers.add(roomiest);
      for (const taker of takers) {
        const limit = Math.min(room[taker], maxItems);
        if (limit <= 0) continue;
        const offer = pick(have, limit);
        const n = count(offer);
        // Uphill only: the collector must end up with at least the stack the
        // giver had, or we have split one stack into two half ones.
        if ((counts[taker][bucket] ?? 0) + n < (counts[giver][bucket] ?? 0)) continue;
        const left = total[giver] - n;
        const empties = left === 0;
        const clears = (counts[giver][bucket] ?? 0) - n === 0;
        const takerBucket = (counts[taker][bucket] ?? 0) + n;
        const fills = takerBucket >= maxItems || room[taker] - n === 0;
        const score = n + (empties ? W.emptiesGiver : 0) + drainAfter(giver, left) + (clears ? W.clearsBucket : 0) + (fills ? W.fillsCollector : 0) + W.pack * (counts[taker][bucket] ?? 0) - cost(giver, taker);
        cands.push({ giver, taker, items: offer, stat: bucket, kind: "give", score, reason: describe([`${n} ${bucket}`, empties ? "empties the giver" : clears ? "clears the giver" : "", fills ? "fills the collector" : ""]) });
      }
    }
  }

  // Swaps: two collectors of different buckets, each holding what the other
  // gathers. Indexed by bucket pair and capped per pair, so a pool with
  // thousands of collectors never turns into millions of comparisons.
  if (opts.allowSwaps ?? true) {
    const SWAP_FANOUT = 6;
    // role bucket -> other bucket -> collectors of the role holding the other, most first
    const holding = new Map<string, Map<string, string[]>>();
    for (const g of guids) {
      const r = roles[g];
      if (!r || !collects.get(g)?.has(r)) continue;
      for (const [b, n] of Object.entries(movableCounts[g])) {
        if (b === r || n <= 0) continue;
        const byOther = holding.get(r) ?? holding.set(r, new Map()).get(r)!;
        (byOther.get(b) ?? byOther.set(b, []).get(b)!).push(g);
      }
    }
    const seen = new Set<string>();
    const pairs: [string, string][] = [];
    for (const [ra, byOther] of holding) {
      for (const [rb, as] of byOther) {
        const bs = holding.get(rb)?.get(ra);
        if (!bs) continue;
        const top = (list: string[], other: string) => [...list].sort((x, y) => (movableCounts[y][other] ?? 0) - (movableCounts[x][other] ?? 0) || (x < y ? -1 : 1)).slice(0, SWAP_FANOUT);
        for (const a of top(as, rb)) for (const b of top(bs, ra)) {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (a !== b && !seen.has(key)) {
            seen.add(key);
            pairs.push(a < b ? [a, b] : [b, a]);
          }
        }
      }
    }
    pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1));
    for (const [a, b] of pairs) {
      {
        const ra = roles[a];
        const rb = roles[b];
        if (ra === rb) continue;
        const aHas = bucketItems(movable[a], rb, split);
        const bHas = bucketItems(movable[b], ra, split);
        let na = Math.min(count(aHas), maxItems);
        let nb = Math.min(count(bHas), maxItems);
        if (!na || !nb) continue;
        // Each side must have room for what it gains net of what it gives.
        while (na > 0 && nb > 0 && (nb - na > room[a] || na - nb > room[b])) {
          if (nb - na > room[a]) nb--;
          else na--;
        }
        if (!na || !nb) continue;
        const offerA = pick(aHas, na);
        const offerB = pick(bHas, nb);
        const clearsA = (counts[a][rb] ?? 0) - na === 0;
        const clearsB = (counts[b][ra] ?? 0) - nb === 0;
        const fillsA = (counts[a][ra] ?? 0) + nb >= maxItems;
        const fillsB = (counts[b][rb] ?? 0) + na >= maxItems;
        const score = na + nb + W.swap + (clearsA ? W.clearsBucket : 0) + (clearsB ? W.clearsBucket : 0) + (fillsA ? W.fillsCollector : 0) + (fillsB ? W.fillsCollector : 0) + W.pack * ((counts[a][ra] ?? 0) + (counts[b][rb] ?? 0)) - cost(a, b);
        cands.push({ giver: a, taker: b, items: offerA, swapItems: offerB, stat: `${ra}<>${rb}`, kind: "swap", score, reason: describe([`${na} ${rb} for ${nb} ${ra}`, clearsA && clearsB ? "clears both" : clearsA || clearsB ? "clears one side" : ""]) });
      }
    }
  }

  cands.sort((x, y) => y.score - x.score || KIND_RANK[x.kind] - KIND_RANK[y.kind] || bucketRank(x.stat) - bucketRank(y.stat) || (x.giver < y.giver ? -1 : x.giver > y.giver ? 1 : x.taker < y.taker ? -1 : 1));
  const minScore = opts.minScore ?? 2;
  const busy = new Set<string>();
  const out: Move[] = [];
  for (const m of cands) {
    if (opts.maxMoves !== undefined && out.length >= opts.maxMoves) break;
    if (m.score < minScore) break;
    if (busy.has(m.giver) || busy.has(m.taker)) continue;
    busy.add(m.giver);
    busy.add(m.taker);
    out.push(m);
  }
  return out;
}

// --- measuring ----------------------------------------------------------------------

export interface BucketStat {
  total: number;
  holders: number;
  /** Fewest bots that could hold the bucket, given their capacities. */
  ideal: number;
  largest: number;
}
export interface Fragmentation {
  buckets: Record<string, BucketStat>;
  /** 1 = every bucket on as few bots as capacity allows; 0 = maximally spread. */
  score: number;
  /** Per stat: trades a 16-point withdraw takes today, or null if the pool can't cover 16. */
  tradesFor16: Record<PotionStat, number | null>;
  /** Items in the pool, potions and otherwise. */
  items: number;
  potions: number;
  bots: number;
  /** Bots holding nothing, and how many could if everything were packed tight. */
  emptyBots: number;
  couldBeEmpty: number;
}
/** How spread out the pool is. Cheap enough to run every pass. */
export function fragmentation(inventories: Inventories, opts: TargetOptions = {}): Fragmentation {
  const pool: Inventories = {};
  for (const g of Object.keys(inventories).sort()) if (!opts.eligible || opts.eligible.has(g)) pool[g] = heldOnly(inventories[g]);
  const split = opts.split ?? splitStats(pool, { capacity: opts.defaultCapacity });
  const cap = (g: string) => opts.capacities?.[g] ?? opts.defaultCapacity ?? DEFAULT_CAPACITY;
  const caps = Object.keys(pool).map(cap).sort((a, b) => b - a);
  const buckets: Record<string, BucketStat> = {};
  for (const [g, inv] of Object.entries(pool)) {
    for (const [b, n] of Object.entries(bucketCounts(inv, split))) {
      const s = (buckets[b] ??= { total: 0, holders: 0, ideal: 0, largest: 0 });
      s.total += n;
      s.holders++;
      s.largest = Math.max(s.largest, n);
    }
  }
  let weighted = 0;
  let items = 0;
  for (const s of Object.values(buckets)) {
    let left = s.total;
    for (const c of caps) {
      if (left <= 0) break;
      s.ideal++;
      left -= c;
    }
    s.ideal = Math.max(1, s.ideal);
    weighted += s.total * (s.ideal / s.holders);
    items += s.total;
  }
  const potions = items - (buckets[MISC_BUCKET]?.total ?? 0);
  const bots = Object.keys(pool).length;
  const emptyBots = Object.values(pool).filter((inv) => count(inv) === 0).length;
  let needed = 0;
  for (let left = items; left > 0 && needed < caps.length; needed++) left -= caps[needed];
  const couldBeEmpty = Math.max(emptyBots, bots - needed);
  const tradesFor16 = {} as Record<PotionStat, number | null>;
  for (const stat of POTION_STATS) {
    const ids = POTION_IDS[stat];
    const stock = Object.entries(pool).map(([botGuid, inv]) => ({ botGuid, normal: inv[ids.normal] ?? 0, greater: inv[ids.greater] ?? 0 }));
    const plan = planPotionWithdraw(16, stock, ids, cap);
    tradesFor16[stat] = plan.pointsFilled >= 16 ? plan.fragments.length : null;
  }
  return { buckets, score: items ? weighted / items : 1, tradesFor16, items, potions, bots, emptyBots, couldBeEmpty };
}
