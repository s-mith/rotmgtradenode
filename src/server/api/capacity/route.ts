import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sweepStaleRequests } from "@/lib/timeouts";
import {
  acrossRoomFor,
  committedDepositSlots,
  effectiveBotCount,
  filterBotsByPool,
  largestFreeSlots,
  totalPoolSlots,
  type PoolFilter,
} from "@/lib/capacity";
import { pyrelay } from "@/lib/devauth";
import { isCommunismBot } from "@/lib/communismPool";
import { advancedForPool } from "@/lib/advanced";

// GET /api/capacity[?pool=seasonal|nonseasonal]
// Public, no auth. The vault page polls this to render "X / Y" usage and
// to gate the deposit button. With ?pool= the numbers cover only that
// pool's bots and deposit queue — the two pools can't trade each
// other's players, so mixing them here made the non-seasonal tab show
// seasonal storage. Without the param the whole pool is summed (legacy).
//
// Inventory truth lives on pyrelay now (inventory_tracker.py). We pull a
// snapshot per request, sum it for used-slot count, and combine with the
// committed-slot count from the local deposit queue (committedDepositSlots,
// the deposit route's own count).
export async function GET(req: Request) {
  const poolParam = new URL(req.url).searchParams.get("pool");
  const pool: PoolFilter =
    poolParam === "seasonal" || poolParam === "nonseasonal" ? poolParam : null;

  const db = getDb();
  // Make sure stale requests aren't artificially eating capacity.
  sweepStaleRequests(db);

  // Fetch live inventory from pyrelay. If pyrelay is unreachable, fall
  // back to "0 used slots" so the deposit gate doesn't lock everyone out
  // — the dispatcher will recover capacity within seconds of coming back.
  const poolResp = await pyrelay.pool();
  const tracker = poolResp.ok ? poolResp.data.bots : {};
  const capacities = poolResp.ok ? poolResp.data.capacities : undefined;
  const botMeta = poolResp.ok ? poolResp.data.botMeta : undefined;

  // Bot universe = tracker ∪ botMeta. The inventory tracker only lists
  // bots that have connected at least once, but pyrelay registers every
  // pool account in botMeta up front — a freshly-provisioned pool half
  // (e.g. the first non-seasonal batch) exists ONLY in botMeta, and
  // counting just the tracker showed its vault as 0 / 0. Meta-only bots
  // hold nothing (0 used) and default to 8 slots below.
  // A communism account is not pool capacity, whatever it holds.
  const allGuids = [...new Set([...Object.keys(tracker), ...Object.keys(botMeta ?? {})])].filter((g) => !isCommunismBot(botMeta?.[g]));
  const trackerBotGuids = filterBotsByPool(allGuids, botMeta, pool);
  // Bot count: max of (tracker entries) and (register_pool report). The
  // register_pool readyCount is fleet-wide and can't be attributed to one
  // pool half, so the Ready-but-untracked bonus only applies to the
  // unfiltered view — per-pool numbers under-report rather than guess.
  const botCount = pool
    ? trackerBotGuids.length
    : effectiveBotCount(db, trackerBotGuids.length);
  // Per-bot capacity: backpack bots count as 16, everyone else 8. Ready
  // accounts not yet in the tracker contribute the conservative 8.
  // With a side asked for, pool accounts playing the other side that have
  // characters on this one count too: they log in as one to take a deposit.
  const across = pool ? acrossRoomFor(poolResp.ok ? poolResp.data.acrossRoom : undefined, pool, (g) => !!botMeta?.[g]?.suspended) : { bots: 0, slots: 0, used: 0 };
  const totalSlots = totalPoolSlots(trackerBotGuids, capacities, botCount) + across.slots;

  // Used slots = sum of all items held across the selected bots.
  let usedSlots = across.used;
  for (const guid of trackerBotGuids) {
    for (const qty of Object.values(tracker[guid] ?? {})) usedSlots += qty;
  }

  // What the open pool deposits have promised, counted as the deposit route counts it (communism's room is its own).
  const committedSlots = committedDepositSlots(db, { seasonal: pool ? (pool === "seasonal" ? 1 : 0) : null, communism: false });

  const freeSlots = Math.max(0, totalSlots - usedSlots);
  const availableSlots = Math.max(0, freeSlots - committedSlots);

  // The biggest one-bot trade possible right now: the fleet's own per-half
  // answer wins over the snapshot sum. Never more than the pool's
  // unpromised room, the deposit route's other gate, so the form offers no
  // size the route would refuse.
  const fleetLargest =
    poolResp.ok && poolResp.data.room && pool
      ? poolResp.data.room[pool].largestFree
      : poolResp.ok && poolResp.data.room
        ? Math.max(poolResp.data.room.seasonal.largestFree, poolResp.data.room.nonseasonal.largestFree)
        : largestFreeSlots(trackerBotGuids, tracker, capacities);
  const largestFree = Math.min(fleetLargest, availableSlots);

  return json({
    botCount: botCount + across.bots,
    totalSlots,
    usedSlots,
    availableSlots,
    full: totalSlots > 0 && availableSlots <= 0,
    largestFree,
    // The fleet could fit an empty account with a backpack for a 16-slot
    // deposit even though none is ready: the form keeps 16 on offer and says so.
    canMake16:
      poolResp.ok && poolResp.data.room
        ? pool
          ? poolResp.data.room[pool].canMake
          : poolResp.data.room.seasonal.canMake || poolResp.data.room.nonseasonal.canMake
        : false,
    // Advanced management (docs/relay/ADVANCED.md): a deposit goes to an
    // empty bot, and one bigger than that bot holds continues with the next.
    // `largestFree` is then the whole deposit, not one bot's room.
    // Only while the side has an empty character: with none left it takes deposits the old way (one trade each).
    continues: advancedForPool(false) && (poolResp.ok && poolResp.data.room?.continues ? (pool ? poolResp.data.room.continues[pool] : poolResp.data.room.continues.seasonal || poolResp.data.room.continues.nonseasonal) : true),
    communismContinues: advancedForPool(true) && (poolResp.ok && poolResp.data.room?.continues ? (pool ? poolResp.data.room.continues.communism[pool] : poolResp.data.room.continues.communism.seasonal || poolResp.data.room.continues.communism.nonseasonal) : true),
  });
}
