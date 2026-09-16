// In-process pub/sub behind the live-update stream (/api/live).
//
// Two kinds of change reach a browser, and they arrive by very different
// routes:
//
//   tx   — a deposit or withdrawal landed in the ledger. Both writers
//          (/api/bot/fulfill, /api/bot/withdraw-fulfill) run in THIS process,
//          so they just call emitTx() after their transaction commits and the
//          feeds repaint immediately. No polling involved.
//
//   pool — the fleet's inventory changed. The embedded fleet announces it
//          (notifyPoolChanged), and a watcher re-checks on a timer as well:
//          for the changes nothing announces (a bot with items logging in)
//          and for a relay reached over HTTP. Either way the check goes
//          through lib/poolSnapshot.ts, which rebuilds the served pool only
//          when its content moved and hands back the revision. A browser
//          hearing a new revision fetches just the delta since the one it
//          holds, so twenty viewers cost twenty small requests, not twenty
//          copies of the whole pool.
//
// The watcher only runs while at least one browser is listening, and stops
// when the last one leaves, so an idle site makes no pyrelay traffic at all.
//
// Single-process by design: the ledger is a local better-sqlite3 file, so the
// site already can't run more than one instance. If that ever changes, this
// bus needs a real broker (Redis pub/sub) behind the same two functions.
import { markPoolDirty, refreshPoolSnapshot } from "./poolSnapshot";

export type LiveEvent =
  | { kind: "tx"; at: number }
  | { kind: "pool"; at: number; rev: string }
  | { kind: "request"; at: number; groupId: string }
  | { kind: "raids"; at: number }
  | { kind: "realmhunts"; at: number };
type Listener = (ev: LiveEvent) => void;

// How often the watcher re-checks the fleet for the pool. A trade takes many
// seconds of in-game animation and the tracker only refreshes on a dispatcher
// tick, so checking faster than this would just re-read the same state.
const POOL_POLL_MS = 5_000;

// Module state lives on globalThis so Next's dev-mode module reloading can't
// strand a running timer with no way to reach it — same pattern as
// lib/ratelimit.ts.
type BusState = {
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  rev: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __live_bus__: BusState | undefined;
}

function state(): BusState {
  if (!globalThis.__live_bus__) {
    globalThis.__live_bus__ = { listeners: new Set(), timer: null, rev: null };
  }
  return globalThis.__live_bus__;
}

/** Fan an event out to every open stream. One bad listener can't stop the rest. */
function publish(ev: LiveEvent): void {
  for (const fn of state().listeners) {
    try {
      fn(ev);
    } catch {
      // A closed-but-not-yet-unsubscribed stream throws on enqueue. Its own
      // cancel handler will drop it; nothing to do here.
    }
  }
}

/**
 * A request group changed (claimed, fulfilled, cancelled, expired). The
 * browser that submitted it refetches its status instead of polling.
 * Null/undefined group is a no-op (legacy rows without one).
 */
export function emitRequest(groupId: string | null | undefined): void {
  if (!groupId) return;
  publish({ kind: "request", at: Date.now(), groupId });
}

/** The fleet's tracked inventory changed (called by the embedded relay). */
// Server-side listeners for the same signal, independent of any browser
// stream: the wishlist scanner registers here so a deposit landing on a bot
// is matched even when nobody has the site open.
const poolHooks = new Set<() => void>();
export function onPoolChanged(fn: () => void): () => void {
  poolHooks.add(fn);
  return () => {
    poolHooks.delete(fn);
  };
}

// A pool poll re-checks the fleet and may rebuild the served snapshot, so
// change signals are coalesced: one poll in flight, at most one queued. A
// burst of thousands of signals (a bulk tracker update) used to start
// thousands of concurrent polls and exhaust the heap (2026-09-07).
let pollBusy = false;
let pollQueued = false;
function schedulePoll(): void {
  if (pollBusy) {
    pollQueued = true;
    return;
  }
  pollBusy = true;
  void (async () => {
    try {
      do {
        pollQueued = false;
        await pollPool();
      } while (pollQueued);
    } catch {
      // pollPool swallows its own failures; nothing to do here.
    } finally {
      pollBusy = false;
    }
  })();
}
export function notifyPoolChanged(): void {
  markPoolDirty();
  for (const fn of poolHooks) fn();
  const s = state();
  if (s.listeners.size === 0) return;
  schedulePoll();
}

/** Raids events within this window become one: the browsers refetch a list, so one refetch covers a burst. */
export const RAIDS_COALESCE_MS = 300;
let raidsTimer: ReturnType<typeof setTimeout> | null = null;

/** A raid was posted, joined, left, or moved on (lib/raids.ts). Browsers refetch the list. */
export function emitRaids(): void {
  if (raidsTimer !== null) return;
  raidsTimer = setTimeout(() => {
    raidsTimer = null;
    publish({ kind: "raids", at: Date.now() });
  }, RAIDS_COALESCE_MS);
  raidsTimer.unref?.();
}

let realmhuntsTimer: ReturnType<typeof setTimeout> | null = null;
/** A realm hunt was posted, ended, or its hunter reported (lib/realmhunts.ts). Browsers refetch the list. */
export function emitRealmhunts(): void {
  if (realmhuntsTimer !== null) return;
  realmhuntsTimer = setTimeout(() => {
    realmhuntsTimer = null;
    publish({ kind: "realmhunts", at: Date.now() });
  }, RAIDS_COALESCE_MS);
  realmhuntsTimer.unref?.();
}

/** A ledger row was just committed. Called by the fulfill routes. */
export function emitTx(): void {
  // Deliberately does NOT emit "pool" as well. The pool has changed in the
  // game, but pyrelay's tracker won't know it until the post-trade dispatcher
  // tick re-reads the bot's character — emitting now would just make every
  // client refetch the pre-trade inventory. The watcher picks the change up on
  // its next tick, which is what the grid should be showing anyway.
  publish({ kind: "tx", at: Date.now() });
}

async function pollPool(): Promise<void> {
  const s = state();
  const snap = await refreshPoolSnapshot({ force: true });
  if (!snap) return; // fleet down and nothing known yet: keep the baseline so recovery isn't a false change
  // First tick only establishes the baseline — the client just loaded the pool
  // itself, so announcing a "change" here would be a pointless refetch.
  if (s.rev !== null && s.rev !== snap.rev) publish({ kind: "pool", at: Date.now(), rev: snap.rev });
  s.rev = snap.rev;
}

function startWatch(): void {
  const s = state();
  if (s.timer !== null) return;
  // POOL_MOCK serves a fixed fixture that never changes, so watching it would
  // burn a timer to prove nothing happened.
  if (process.env.POOL_MOCK === "1") return;
  s.timer = setInterval(() => {
    void pollPool();
  }, POOL_POLL_MS);
  // Don't hold the process open on this timer alone.
  s.timer.unref?.();
  void pollPool(); // establish the baseline now rather than POOL_POLL_MS from now
}

function stopWatch(): void {
  const s = state();
  if (s.timer === null) return;
  clearInterval(s.timer);
  s.timer = null;
  // Drop the baseline: by the time somebody connects again the pool may have
  // moved, and comparing against a stale rev would fire a change event for an
  // update the newly-arrived client already has in its first /api/pool load.
  s.rev = null;
}

/** Current number of open streams. /api/live uses it to cap connections. */
export function listenerCount(): number {
  return state().listeners.size;
}

/**
 * Attach a stream. Starts the pool watcher on the first listener; the returned
 * unsubscribe stops it again when the last one goes away.
 */
export function subscribe(fn: Listener): () => void {
  const s = state();
  s.listeners.add(fn);
  if (s.listeners.size === 1) startWatch();
  return () => {
    s.listeners.delete(fn);
    if (s.listeners.size === 0) stopWatch();
  };
}
