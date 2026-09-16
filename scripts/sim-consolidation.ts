// Replay a random stream of deposits and withdraws against the potion planner
// and measure what players pay (trades per withdraw) and what the fleet pays
// (bot-to-bot trades). Compares the legacy planner with the scoring one, with
// and without swaps and deposit hints.
//
//   npx tsx scripts/sim-consolidation.ts [--bots 30] [--steps 600] [--seed 1] [--seeds 1] [--pairs 3] [--backpack 0.3]
//       [--online 0.5] [--minScore 2] [--wake 2] [--hop 3] [--pack 0.05] [--fills 2] [--empties 4] [--clears 2]
//       [--hysteresis 2] [--split auto|always|never] [--order count|role] [--json]
// --seeds N averages N runs from --seed upwards.
import { planPotionWithdraw, POTION_IDS, POTION_STATS, type PotionStat } from "../src/lib/potionPlan";
import { fragmentWithdraw } from "../src/lib/fragmentWithdraw";
import * as legacy from "./sim/legacyPlanner";
import { bucketOf, collectionTargets, electRoles, fragmentation, planMoves, splitStats, type Inventories, type Move } from "../src/relay/fleet/potionConsolidation";

type Args = { bots: number; steps: number; seed: number; seeds: number; pairs: number; backpack: number; online: number; minScore: number; wake: number; hop: number; pack: number; fills: number; empties: number; clears: number; hysteresis: number; split: "auto" | "always" | "never"; order: "count" | "role"; json: boolean };
function parseArgs(): Args {
  const a: Args = { bots: 30, steps: 600, seed: 1, seeds: 1, pairs: 3, backpack: 0.3, online: 0.5, minScore: 2, wake: 2, hop: 3, pack: 0.05, fills: 2, empties: 4, clears: 2, hysteresis: 2, split: "auto", order: "count", json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "json") a.json = true;
    else if (k === "split") a.split = argv[++i] as Args["split"];
    else if (k === "order") a.order = argv[++i] as Args["order"];
    else if (k in a) (a as unknown as Record<string, number>)[k] = Number(argv[++i]);
  }
  return a;
}

/** mulberry32 */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Variant = { name: string; planner: "none" | "legacy" | "scored"; swaps: boolean; hints: boolean };
const VARIANTS: Variant[] = [
  { name: "no consolidation", planner: "none", swaps: false, hints: false },
  { name: "legacy planner", planner: "legacy", swaps: false, hints: false },
  { name: "scored", planner: "scored", swaps: false, hints: false },
  { name: "scored + swaps", planner: "scored", swaps: true, hints: false },
  { name: "scored + swaps + deposit hints", planner: "scored", swaps: true, hints: true },
];

interface World {
  inv: Inventories;
  caps: Record<string, number>;
  servers: Record<string, string>;
  roles: Record<string, string>;
}
const count = (inv: Record<string, number>) => Object.values(inv).reduce((a, b) => a + b, 0);
const free = (w: World, g: string) => w.caps[g] - count(w.inv[g]);

function makeWorld(args: Args, rand: () => number): World {
  const w: World = { inv: {}, caps: {}, servers: {}, roles: {} };
  const servers = ["USEast", "USWest4", "EUWest"];
  for (let i = 0; i < args.bots; i++) {
    const g = `bot${String(i).padStart(2, "0")}`;
    w.inv[g] = {};
    w.caps[g] = rand() < args.backpack ? 16 : 8;
    w.servers[g] = servers[Math.floor(rand() * servers.length)];
  }
  return w;
}

const GEAR = ["ubatk", "ubdef", "ubspd", "ubdex", "ubvit", "ubwis"];
/** What a player brings: mostly one stat, sometimes two; a few greaters; now and then gear. */
function depositItems(rand: () => number): Record<string, number> {
  const n = 1 + Math.floor(rand() * 8);
  if (rand() < 0.2) {
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const id = GEAR[Math.floor(rand() * GEAR.length)];
      out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  }
  const stats = [POTION_STATS[Math.floor(rand() * POTION_STATS.length)]];
  if (rand() < 0.3) stats.push(POTION_STATS[Math.floor(rand() * POTION_STATS.length)]);
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const st = stats[Math.floor(rand() * stats.length)];
    const id = rand() < 0.25 ? POTION_IDS[st].greater : POTION_IDS[st].normal;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** Where the dispatcher would put a deposit: the bucket's home when hinted, else the emptiest bot. */
function routeDeposit(w: World, items: Record<string, number>, hints: boolean, split: Set<string>): string | null {
  const n = count(items);
  const withRoom = Object.keys(w.inv).filter((g) => free(w, g) >= 1);
  if (!withRoom.length) return null;
  if (hints) {
    const weight: Record<string, number> = {};
    for (const [id, q] of Object.entries(items)) {
      const b = bucketOf(id, split);
      if (b) weight[b] = (weight[b] ?? 0) + q;
    }
    const main = Object.entries(weight).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (main) {
      const targets = collectionTargets(w.inv, { capacities: w.caps, split, roles: w.roles, order: args.order })[main] ?? [];
      const holders = Object.keys(w.inv).filter((g) => Object.entries(w.inv[g]).some(([id, q]) => q > 0 && bucketOf(id, split) === main)).sort((a, b) => count(w.inv[b]) - count(w.inv[a]));
      for (const g of [...targets, ...holders]) if (free(w, g) >= Math.min(n, 1)) return g;
    }
  }
  withRoom.sort((a, b) => free(w, b) - free(w, a) || (a < b ? -1 : 1));
  return withRoom[0];
}

function applyMove(w: World, m: { giver: string; taker: string; items: Record<string, number>; swapItems?: Record<string, number> }): void {
  const transfer = (from: string, to: string, items: Record<string, number>) => {
    for (const [id, q] of Object.entries(items)) {
      w.inv[from][id] -= q;
      if (w.inv[from][id] <= 0) delete w.inv[from][id];
      w.inv[to][id] = (w.inv[to][id] ?? 0) + q;
    }
  };
  transfer(m.giver, m.taker, m.items);
  if (m.swapItems) transfer(m.taker, m.giver, m.swapItems);
  for (const g of [m.giver, m.taker]) if (count(w.inv[g]) > w.caps[g]) throw new Error(`${g} over capacity after ${JSON.stringify(m)}`);
}

interface Result {
  variant: string;
  withdraws: number;
  playerTrades: number;
  tradesPerWithdraw: number;
  botTrades: number;
  botTradesPerWithdraw: number;
  /** Logins the moves needed (bots that were asleep when planned). */
  wakes: number;
  swaps: number;
  potionsMoved: number;
  spreadFinal: number;
  spreadMean: number;
  potions: number;
  emptyMean: number;
  emptyFinal: number;
  couldBeEmptyFinal: number;
}

function run(v: Variant, args: Args, seed: number): Result {
  const rand = rng(seed);
  const w = makeWorld(args, rand);
  let withdraws = 0;
  let playerTrades = 0;
  let botTrades = 0;
  let swaps = 0;
  let wakes = 0;
  let potionsMoved = 0;
  let spreadSum = 0;
  let spreadN = 0;
  let emptySum = 0;
  let statOffset = 0;
  for (let step = 0; step < args.steps; step++) {
    const split = splitStats(w.inv, { mode: args.split });
    w.roles = electRoles(w.inv, { split, previous: w.roles, hysteresis: args.hysteresis });
    const r = rand();
    if (r < 0.55) {
      const items = depositItems(rand);
      const to = routeDeposit(w, items, v.hints, split);
      if (to) {
        let room = free(w, to);
        for (const [id, q] of Object.entries(items)) {
          const take = Math.min(q, room);
          if (take <= 0) break;
          w.inv[to][id] = (w.inv[to][id] ?? 0) + take;
          room -= take;
        }
      }
    } else if (rand() < 0.2) {
      // Gear goes out the way the site does it: an aggregate withdraw split across holders.
      const id = GEAR[Math.floor(rand() * GEAR.length)];
      const stock = Object.values(w.inv).reduce((a, inv) => a + (inv[id] ?? 0), 0);
      const qty = Math.min(1 + Math.floor(rand() * 3), stock);
      if (qty >= 1) {
        const plan = fragmentWithdraw([{ itemId: id, qty }], Object.entries(w.inv).map(([botGuid, inv]) => ({ botGuid, inventory: new Map(Object.entries(inv)) })));
        if (plan.ok) {
          withdraws++;
          playerTrades += plan.fragments.length;
          for (const f of plan.fragments) for (const it of f.items) {
            w.inv[f.botGuid][it.itemId] -= it.qty;
            if (w.inv[f.botGuid][it.itemId] <= 0) delete w.inv[f.botGuid][it.itemId];
          }
        }
      }
    } else {
      const stat = POTION_STATS[Math.floor(rand() * POTION_STATS.length)] as PotionStat;
      const ids = POTION_IDS[stat];
      const stock = Object.entries(w.inv).map(([botGuid, inv]) => ({ botGuid, normal: inv[ids.normal] ?? 0, greater: inv[ids.greater] ?? 0 }));
      const avail = stock.reduce((a, b) => a + b.normal + b.greater * 2, 0);
      const want = Math.min(4 + Math.floor(rand() * 13), avail);
      if (want >= 2) {
        const plan = planPotionWithdraw(want, stock, ids);
        withdraws++;
        playerTrades += plan.fragments.length;
        for (const f of plan.fragments) {
          for (const [id, q] of Object.entries(f.items)) {
            w.inv[f.botGuid][id] -= q;
            if (w.inv[f.botGuid][id] <= 0) delete w.inv[f.botGuid][id];
          }
        }
      }
    }
    // Some bots are asleep, so wakes cost; the rest are wherever they were.
    const online = new Set(Object.keys(w.inv).filter(() => rand() < args.online));
    let moves: { giver: string; taker: string; items: Record<string, number>; swapItems?: Record<string, number>; kind?: string }[] = [];
    if (v.planner === "legacy") {
      moves = legacy.planMoves(w.inv, w.caps, { maxMoves: args.pairs, statOffset });
      statOffset += Math.max(1, moves.length);
    } else if (v.planner === "scored") {
      moves = planMoves(w.inv, w.caps, {
        online, servers: w.servers, roles: w.roles, maxMoves: args.pairs, allowSwaps: v.swaps, splitGreaters: args.split,
        order: args.order, minScore: args.minScore, hysteresis: args.hysteresis, weights: { wake: args.wake, hop: args.hop, pack: args.pack, fillsCollector: args.fills, emptiesGiver: args.empties, clearsBucket: args.clears },
      }) as Move[];
    }
    for (const m of moves) {
      applyMove(w, m);
      botTrades++;
      wakes += Number(!online.has(m.giver)) + Number(!online.has(m.taker));
      if (m.swapItems) swaps++;
      potionsMoved += count(m.items) + (m.swapItems ? count(m.swapItems) : 0);
    }
    if (step >= args.steps / 4) {
      const f = fragmentation(w.inv, { capacities: w.caps });
      spreadSum += f.score;
      emptySum += f.emptyBots;
      spreadN++;
    }
  }
  const final = fragmentation(w.inv, { capacities: w.caps });
  return {
    variant: v.name, withdraws, playerTrades, tradesPerWithdraw: withdraws ? playerTrades / withdraws : 0,
    botTrades, botTradesPerWithdraw: withdraws ? botTrades / withdraws : 0, wakes, swaps, potionsMoved,
    spreadFinal: final.score, spreadMean: spreadN ? spreadSum / spreadN : 1, potions: final.potions,
    emptyMean: spreadN ? emptySum / spreadN : 0, emptyFinal: final.emptyBots, couldBeEmptyFinal: final.couldBeEmpty,
  };
}

const args = parseArgs();
const results = VARIANTS.map((v) => {
  const runs = Array.from({ length: Math.max(1, args.seeds) }, (_, i) => run(v, args, args.seed + i));
  const mean = (f: (r: Result) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const out: Result = { ...runs[0] };
  for (const k of Object.keys(out) as (keyof Result)[]) if (k !== "variant") (out as unknown as Record<string, number>)[k] = mean((r) => r[k] as number);
  return out;
});
if (args.json) {
  console.log(JSON.stringify({ args, results }, null, 1));
} else {
  console.log(`bots=${args.bots} steps=${args.steps} seed=${args.seed}${args.seeds > 1 ? ` (x${args.seeds})` : ""} pairs=${args.pairs} backpack=${args.backpack} online=${args.online} minScore=${args.minScore} wake=${args.wake} hop=${args.hop} hysteresis=${args.hysteresis} split=${args.split}`);
  const cols: [string, (r: Result) => string][] = [
    ["variant", (r) => r.variant],
    ["withdraws", (r) => r.withdraws.toFixed(0)],
    ["trades/withdraw", (r) => r.tradesPerWithdraw.toFixed(2)],
    ["bot trades", (r) => r.botTrades.toFixed(0)],
    ["wakes", (r) => r.wakes.toFixed(0)],
    ["swaps", (r) => r.swaps.toFixed(0)],
    ["potions moved", (r) => r.potionsMoved.toFixed(0)],
    ["spread (mean)", (r) => r.spreadMean.toFixed(2)],
    ["spread (final)", (r) => r.spreadFinal.toFixed(2)],
    ["empty bots (mean)", (r) => r.emptyMean.toFixed(1)],
    ["empty (final/possible)", (r) => `${r.emptyFinal.toFixed(0)}/${r.couldBeEmptyFinal.toFixed(0)}`],
  ];
  const widths = cols.map(([h, f]) => Math.max(h.length, ...results.map((r) => f(r).length)));
  console.log(cols.map(([h], i) => h.padEnd(widths[i])).join("  "));
  for (const r of results) console.log(cols.map(([, f], i) => f(r).padEnd(widths[i])).join("  "));
}
