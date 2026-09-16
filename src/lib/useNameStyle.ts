"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isPlainStyle, type NameStyle } from "./cosmetics";

// Client-side name-effect lookup for render sites whose own endpoint doesn't
// carry the style. <PlayerName ign={x} /> with no `style` prop routes here;
// passing the prop explicitly (even as null) skips it entirely, so the
// leaderboard and activity feed still cost exactly one request.
//
// Module-level rather than a context so it works in any route tree without
// a provider — the operator console is its own tree and shouldn't need one.
// Every name mounting in the same tick is coalesced into a single query, so
// a 50-row table is one request, not 50.

const cache = new Map<string, NameStyle | null>();
const wanted = new Set<string>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let flushHandle: ReturnType<typeof setTimeout> | null = null;

// Monotonic clock for primes. A fetch that was already in flight when the
// player saved would otherwise land afterwards and overwrite the fresh style
// with the stale one it asked for; each flush captures the epoch it started
// at and skips any key primed since. Per-key, so one save doesn't discard the
// rest of the batch.
let epoch = 0;
const primedAt = new Map<string, number>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function flush(): Promise<void> {
  flushHandle = null;
  const batch = [...wanted];
  wanted.clear();
  if (batch.length === 0) return;
  for (const k of batch) inflight.add(k);
  const startedAt = epoch;

  try {
    const r = await fetch(`/api/name-styles?igns=${encodeURIComponent(batch.join(","))}`, {
      cache: "no-store",
    });
    const d = await r.json();
    const got = (d?.styles ?? {}) as Record<string, NameStyle>;
    // Cache the misses too — most players have no effect, and without this
    // every one of them re-queries on each mount.
    for (const k of batch) {
      const primed = primedAt.get(k);
      if (primed !== undefined && primed > startedAt) continue; // saved mid-flight
      cache.set(k, got[k] ?? null);
    }
  } catch {
    // Network blip: cache nothing, so the next mount retries instead of
    // pinning "no effect" for the rest of the session.
  } finally {
    for (const k of batch) inflight.delete(k);
  }
  for (const l of listeners) l();
}

function request(key: string): void {
  if (cache.has(key) || wanted.has(key) || inflight.has(key)) return;
  wanted.add(key);
  // 30ms: long enough for a whole list to mount and share one request,
  // short enough that nobody sees the unstyled name flash.
  if (flushHandle === null) flushHandle = setTimeout(flush, 30);
}

/**
 * Write a known style straight into the cache and repaint every mounted
 * PlayerName for that IGN. Called after the player saves from the customizer:
 * the POST response already carries the authoritative style, so priming it
 * costs no request and updates the page with no flash of the old value.
 *
 * A plain style is stored as null to match what /api/name-styles returns —
 * it omits players whose style renders identically to bare text.
 */
export function primeNameStyle(ign: string, style: NameStyle | null): void {
  const key = ign.toLowerCase();
  if (!key) return;
  primedAt.set(key, ++epoch);
  cache.set(key, style && !isPlainStyle(style) ? style : null);
  wanted.delete(key);
  for (const l of listeners) l();
}

/**
 * The name effect for an IGN, or null while it's still loading / when the
 * player has none. Pass null to opt out (the caller already has the style).
 */
export function useNameStyle(ign: string | null | undefined): NameStyle | null {
  const key = ign ? ign.toLowerCase() : "";

  useEffect(() => {
    if (key) request(key);
  }, [key]);

  return useSyncExternalStore(
    subscribe,
    useCallback(() => (key ? cache.get(key) ?? null : null), [key]),
    () => null,
  );
}
