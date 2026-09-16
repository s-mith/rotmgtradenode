import { json } from "@/server/http";
import { getDb } from "@/lib/db";
import { sweepStaleRequests } from "@/lib/timeouts";
import {
  effectiveBotCount,
  filterBotsByPool,
  largestFreeSlots,
  totalPoolSlots,
  type PoolFilter,
} from "@/lib/capacity";
import { pyrelay } from "@/lib/devauth";
import { vaultBotGuids } from "@/lib/vault";

// GET /api/capacity[?pool=seasonal|nonseasonal]
// Public, no auth. The vault page polls this to render "X / Y" usage and
// to gate the deposit button. With ?pool= the numbers cover only that
// pool's bots and deposit queue — the two pools can't trade each
// other's players, so mixing them here made the non-seasonal tab show
// seasonal storage. Without the param the whole pool is summed (legacy).
//
// Inventory truth lives on pyrelay now (inventory_tracker.py). We pull a
// snapshot per request, sum it for used-slot count, and combine with the
// committed-slot count from the local deposit queue.
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
  // A bot dedicated to somebody's personal storage is not pool capacity,
  // whatever it holds.
  const vaultBots = vaultBotGuids(db);
  const allGuids = [...new Set([...Object.keys(tracker), ...Object.keys(botMeta ?? {})])].filter((g) => !vaultBots.has(g));
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
  const totalSlots = totalPoolSlots(trackerBotGuids, capacities, botCount);

  // Used slots = sum of all items held across the selected bots.
  let usedSlots = 0;
  for (const guid of trackerBotGuids) {
    for (const qty of Object.values(tracker[guid] ?? {})) usedSlots += qty;
  }

  const committedSlots = (
    db
      .prepare(
        "SELECT COALESCE(SUM(item_count), 0) AS n FROM deposit_requests " +
          "WHERE status IN ('pending','claimed')" +
          (pool ? " AND seasonal = ?" : ""),
      )
      .get(...(pool ? [pool === "seasonal" ? 1 : 0] : [])) as { n: number }
  ).n;

  const freeSlots = Math.max(0, totalSlots - usedSlots);
  const availableSlots = Math.max(0, freeSlots - committedSlots);

  return json({
    botCount,
    totalSlots,
    usedSlots,
    availableSlots,
    full: totalSlots > 0 && availableSlots <= 0,
    // The biggest one-bot trade possible right now: 16 only while an empty
    // backpack bot the fleet would send is around. The form greys out sizes
    // above it. The fleet's own per-half answer wins over the snapshot sum.
    largestFree:
      poolResp.ok && poolResp.data.room && pool
        ? poolResp.data.room[pool].largestFree
        : poolResp.ok && poolResp.data.room
          ? Math.max(poolResp.data.room.seasonal.largestFree, poolResp.data.room.nonseasonal.largestFree)
          : largestFreeSlots(trackerBotGuids, tracker, capacities),
    // The fleet could fit an empty account with a backpack for a 16-slot
    // deposit even though none is ready: the form keeps 16 on offer and says so.
    canMake16:
      poolResp.ok && poolResp.data.room
        ? pool
          ? poolResp.data.room[pool].canMake
          : poolResp.data.room.seasonal.canMake || poolResp.data.room.nonseasonal.canMake
        : false,
  });
}
