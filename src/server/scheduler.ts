// Background maintenance that used to piggyback on whichever request
// happened to arrive. With a real process we can just run it on a timer.
//
// The request handlers still call sweepStaleRequests inline where they need
// a consistent view of the queue (a deposit submit must not count a row the
// sweep was about to cancel), so this is belt-and-braces: it keeps the queue
// clean while the site is idle.
import { getDb } from "@/lib/db";
import { sweepStaleRequests } from "@/lib/timeouts";
import { flushTraffic } from "@/lib/traffic";
import { sweepRaids } from "@/lib/raids";
import { sweepHunts } from "@/lib/realmhunts";

const SWEEP_INTERVAL_MS = 30_000;
// Raids run on a clock the players watch (an AFK check counting down), so
// their sweep is finer. It is one indexed update on a table of a few rows.
const RAID_SWEEP_INTERVAL_MS = 5_000;

export function startScheduler(): () => void {
  const sweep = setInterval(() => {
    try {
      const r = sweepStaleRequests(getDb());
      if (r.pendingTimedOut || r.claimedTimedOut) {
        console.log(
          `[scheduler] swept stale requests: pending=${r.pendingTimedOut} claimed=${r.claimedTimedOut}`,
        );
      }
    } catch (e) {
      console.error("[scheduler] sweep failed:", e);
    }
    // The traffic counters the request path accumulates go to the table here
    // (lib/traffic.ts), so no request ever waits on a write for them.
    try {
      flushTraffic(getDb());
    } catch (e) {
      console.error("[scheduler] traffic flush failed:", e);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const raids = setInterval(() => {
    try {
      const r = sweepRaids(getDb());
      if (r.afkClosed || r.popResolved || r.timedOut || r.deleted) {
        console.log(`[scheduler] raids: afk closed=${r.afkClosed} pop windows resolved=${r.popResolved} timed out=${r.timedOut} deleted=${r.deleted}`);
      }
    } catch (e) {
      console.error("[scheduler] raid sweep failed:", e);
    }
  }, RAID_SWEEP_INTERVAL_MS);
  raids.unref();

  const hunts = setInterval(() => {
    try {
      const r = sweepHunts(getDb());
      if (r.timedOut || r.deleted) console.log(`[scheduler] realm hunts: timed out=${r.timedOut} deleted=${r.deleted}`);
    } catch (e) {
      console.error("[scheduler] realm hunt sweep failed:", e);
    }
  }, RAID_SWEEP_INTERVAL_MS);
  hunts.unref();

  return () => {
    clearInterval(sweep);
    clearInterval(raids);
    clearInterval(hunts);
    // A last flush so a deploy doesn't lose the half minute before it.
    try {
      flushTraffic(getDb());
    } catch (e) {
      console.error("[scheduler] final traffic flush failed:", e);
    }
  };
}
