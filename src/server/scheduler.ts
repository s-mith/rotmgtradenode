// Background maintenance that used to piggyback on whichever request
// happened to arrive. With a real process we can just run it on a timer.
//
// The request handlers still call sweepStaleRequests inline where they need
// a consistent view of the queue (a deposit submit must not count a row the
// sweep was about to cancel), so this is belt-and-braces: it keeps the queue
// clean while the site is idle.
import { getDb } from "@/lib/db";
import { sweepStaleRequests } from "@/lib/timeouts";

const SWEEP_INTERVAL_MS = 30_000;

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
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  return () => {
    clearInterval(sweep);
  };
}
