import type Database from "better-sqlite3";
import { presence } from "./fleetPresence";

// Trade-slot capacity for a bot without a backpack. A backpack adds 8 more,
// for 16 total. Used as the default when we don't have a per-bot capacity
// reported by pyrelay yet.
export const SLOTS_PER_BOT = 8;

// Total trade-slot capacity of the pool, accounting for per-bot capacity
// (8 without a backpack, 16 with) reported by pyrelay's tracker.
//
//   trackerBots:  the set of bot_guids pyrelay's /pool currently knows about
//   capacities:   bot_guid -> reported slot count (may be missing entries)
//   effectiveBotCount: includes Ready-but-not-yet-online accounts pyrelay
//                      hasn't woken; those contribute the conservative 8.
//
// Returns: sum over tracked bots of (their reported capacity, default 8),
// plus 8 for each Ready account not yet in the tracker.
export function totalPoolSlots(
  trackerBotGuids: string[],
  capacities: Record<string, number> | undefined,
  effectiveBotCount: number,
): number {
  const caps = capacities ?? {};
  let sum = 0;
  for (const guid of trackerBotGuids) {
    const c = caps[guid];
    sum += Number.isInteger(c) && c! > 0 ? c! : SLOTS_PER_BOT;
  }
  const phantomBots = Math.max(0, effectiveBotCount - trackerBotGuids.length);
  return sum + phantomBots * SLOTS_PER_BOT;
}

/**
 * The most free trade slots any one of these bots has — what the biggest
 * single trade could take right now. 16 needs an empty bot with a backpack.
 * A fallback for a pool read without the fleet's own answer (`room` on the
 * payload), which also knows about holds, the login desk, lockouts and the
 * roomier characters an account would switch to.
 */
export function largestFreeSlots(
  botGuids: string[],
  tracker: Record<string, Record<string, number>>,
  capacities: Record<string, number> | undefined,
): number {
  let best = 0;
  for (const guid of botGuids) {
    const c = capacities?.[guid];
    const cap = Number.isInteger(c) && c! > 0 ? c! : SLOTS_PER_BOT;
    let held = 0;
    for (const qty of Object.values(tracker[guid] ?? {})) held += qty;
    best = Math.max(best, cap - held);
  }
  return best;
}

// True when a single bot may serve a request for `seasonal`'s pool: a
// seasonal player cannot trade a non-seasonal bot, so a withdraw may only be
// filled from, and claimed by, bots of its own type. A missing flag means
// seasonal, the same default /api/pool tags instances with.
export function isPoolBot(meta: { seasonal?: boolean } | undefined, seasonal: boolean): boolean {
  return (meta?.seasonal !== false) === seasonal;
}

// Restrict a tracker bot list to one pool. Seasonal and non-seasonal bots
// can't trade the same players, so capacity ("is there room to deposit?")
// only makes sense per pool. A bot with no reported flag counts as seasonal —
// the same default /api/pool uses for instance tabs, so the vault numbers
// always agree with the grid.
export type PoolFilter = "seasonal" | "nonseasonal" | null;

export function filterBotsByPool(
  trackerBotGuids: string[],
  botMeta: Record<string, { seasonal?: boolean; suspended?: boolean }> | undefined,
  pool: PoolFilter,
): string[] {
  const meta = botMeta ?? {};
  // A suspended account can't log in, so its slots are not room and its
  // items are not stock anyone can draw on.
  trackerBotGuids = trackerBotGuids.filter((g) => !meta[g]?.suspended);
  if (!pool) return trackerBotGuids;
  const wantSeasonal = pool === "seasonal";
  return trackerBotGuids.filter((g) => (meta[g]?.seasonal !== false) === wantSeasonal);
}

// How many more items the pool (or, with `communism`, communism accounts)
// could physically accept for `seasonal` right now. This runs inside the deposit-fulfill transaction, so it is answered
// from memory: the fleet reports its free slots per pool — every account on
// the roster, online or not — each supervise pass (presence.poolRoom), and
// the in-flight reservation comes from the deposit queue.
//
// Only without a fresh report does this fall back to summing the presence of
// the bots online right now. That used to be the only source, and for a
// fleet of thousands with a handful logged in it was simply wrong: the
// moment a player filled the one online bot of their pool it read "no room
// anywhere" and closed the deposit as vault-full, with tens of thousands of
// free slots on bots that were merely offline.
//
// `excludeDepositId` drops one deposit row from the in-flight reservation —
// the row being fulfilled, whose own claim would otherwise reserve slots
// against itself. `justReceived` is what that row's trade just put on a bot:
// the fleet's report predates the trade by up to a supervise pass, so it is
// taken off the reported figure. (Presence already reflects it, via
// tookSlots, on the fallback path.)
export function poolRoomForDeposits(
  db: Database.Database,
  seasonal: 0 | 1,
  excludeDepositId?: number,
  justReceived = 0,
  communism = false,
): number {
  const reported = presence.poolRoom(seasonal === 1, communism);
  const free =
    reported !== null
      ? Math.max(0, reported - justReceived)
      : presence
          .online()
          .filter((b) => (b.seasonal ? 1 : 0) === seasonal && !!b.communism === communism)
          .reduce((a, b) => a + b.freeSlots, 0);
  const committed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(current_cap), 0) AS n FROM deposit_requests
          WHERE status = 'claimed' AND seasonal = ? AND communism = ? AND id IS NOT ?`,
      )
      .get(seasonal, communism ? 1 : 0, excludeDepositId ?? null) as { n: number }
  ).n;
  return Math.max(0, free - committed);
}

/**
 * Slots the open deposits of one pool have promised, as the deposit route
 * counts them before it takes a new one: what each has put on the bots so
 * far (one ledger row per item received, however far its chain across bots
 * ran) and, while one is mid-trade, what that trade can still bring
 * (current_cap). A pending deposit that has not traded yet promises nothing:
 * its declared size is only an upper bound. `seasonal` null counts both
 * halves. The capacity readout counts the same, so the pool page never says
 * "full" while the route would still take a deposit.
 */
export function committedDepositSlots(db: Database.Database, o: { seasonal: 0 | 1 | null; communism: boolean }): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(
           (SELECT COALESCE(SUM(t.qty), 0) FROM transactions t
             WHERE t.kind = 'deposit' AND t.request_id = dr.id)
           + CASE WHEN dr.status = 'claimed' THEN COALESCE(dr.current_cap, 0) ELSE 0 END
         ), 0) AS n
         FROM deposit_requests dr
         WHERE dr.status IN ('pending','claimed') AND dr.communism = ?${o.seasonal === null ? "" : " AND dr.seasonal = ?"}`,
      )
      .get(...(o.seasonal === null ? [o.communism ? 1 : 0] : [o.communism ? 1 : 0, o.seasonal])) as { n: number }
  ).n;
}

// Effective bot count for capacity math: the larger of the live count and
// the fleet's registered pool size (if reported recently), so a Ready
// account that hasn't woken yet still contributes its 8 slots.
export function effectiveBotCount(_db: Database.Database, liveBotCount: number): number {
  const reported = presence.readyCount();
  if (reported === null || reported < 0) return liveBotCount;
  return Math.max(liveBotCount, reported);
}

/**
 * Room on one side of the seasonal split held by pool accounts that play the
 * other side but have living characters on this one (they log in as one to
 * take a deposit here): how many such accounts, their slots, and what fills them.
 */
export function acrossRoomFor(
  acrossRoom: Record<string, { seasonal: boolean; slots: number; used: number }> | undefined,
  side: "seasonal" | "nonseasonal",
  skip: (botGuid: string) => boolean = () => false,
): { bots: number; slots: number; used: number } {
  const out = { bots: 0, slots: 0, used: 0 };
  for (const [g, r] of Object.entries(acrossRoom ?? {})) {
    if (r.seasonal !== (side === "seasonal") || skip(g)) continue;
    out.bots++;
    out.slots += r.slots;
    out.used += r.used;
  }
  return out;
}
