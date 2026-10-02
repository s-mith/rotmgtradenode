"use client";

import { useEffect, useRef, useState } from "react";

// Browser end of the live-update stream (/api/live). One EventSource for the
// whole page; the server says only "tx" or "pool" and the callers refetch the
// endpoints they already use.
//
// EventSource rather than a WebSocket or a poll loop: the traffic is one-way,
// and the browser handles reconnection with backoff for free — a dropped
// connection, a laptop waking from sleep, a redeploy all recover on their own
// with no code here.

// Events cluster: a multi-bot deposit chains several fulfills through in a few
// seconds. Coalesce them so the feeds refetch once at the end of the burst
// instead of once per bot.
const DEBOUNCE_MS = 250;

export function useLiveUpdates(handlers: {
  /** A ledger row landed — Recent Activity is stale. */
  onTx?: () => void;
  /** The fleet's inventory changed — the pool grid is stale. */
  onPool?: () => void;
  /** One of `groups` moved (claimed, fulfilled, cancelled, expired). */
  onRequest?: (groupId: string) => void;
  /** Request groups this browser cares about; reopening the stream when
   *  they change is what subscribes it to their events. */
  groups?: string[];
}): void {
  // Held in a ref so a re-render with fresh closures doesn't tear down and
  // reopen the stream. The effect below must run exactly once.
  const ref = useRef(handlers);
  ref.current = handlers;
  // Bumped when a page parked in the back-forward cache shows again: its stream was closed on the way out.
  const [reopen, setReopen] = useState(0);

  const groupKey = (handlers.groups ?? []).join(",");
  useEffect(() => {
    // Guard rather than assume: this runs in the browser, but a stray SSR pass
    // or an ancient client without EventSource should degrade to the old
    // refresh-on-your-own-trade behaviour, not throw.
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;

    const es = new EventSource(groupKey ? `/api/live?group=${encodeURIComponent(groupKey)}` : "/api/live");
    const timers: { tx: ReturnType<typeof setTimeout> | null; pool: ReturnType<typeof setTimeout> | null } = {
      tx: null,
      pool: null,
    };

    // A hidden tab holds tx/pool refreshes until it is looked at again: the
    // page is the same either way, and background tabs were most of the pool
    // traffic. Request events still flow, so a trade in progress is current
    // the moment the player tabs back from the game.
    const deferred = new Set<"tx" | "pool">();
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const fire = (which: "tx" | "pool") => {
      if (hidden()) {
        deferred.add(which);
        return;
      }
      if (timers[which] !== null) clearTimeout(timers[which]!);
      timers[which] = setTimeout(() => {
        timers[which] = null;
        if (which === "tx") ref.current.onTx?.();
        else ref.current.onPool?.();
      }, DEBOUNCE_MS);
    };

    const onTx = () => fire("tx");
    // Pool events carry the fleet's revision; a repeat of the last one seen
    // is a reconnect echo, not a change.
    let lastRev: string | null = null;
    const onPool = (e: Event) => {
      const rev = (() => {
        try {
          return String((JSON.parse((e as MessageEvent).data) as { rev?: string }).rev ?? "");
        } catch {
          return "";
        }
      })();
      if (rev && rev === lastRev) return;
      lastRev = rev || lastRev;
      fire("pool");
    };
    const onRequest = (e: Event) => {
      try {
        const { groupId } = JSON.parse((e as MessageEvent).data) as { groupId: string };
        ref.current.onRequest?.(groupId);
      } catch {
        // malformed — ignore
      }
    };

    // `open` fires on the first connect AND after every automatic reconnect.
    // The first is harmless (the page just loaded its own data). A reconnect
    // is the one that matters: we were disconnected for some unknown stretch
    // and missed whatever happened in it, so refetch both rather than sit on
    // state that may be minutes stale.
    let connectedOnce = false;
    const onOpen = () => {
      if (connectedOnce) {
        fire("tx");
        fire("pool");
      }
      connectedOnce = true;
    };

    const onVisible = () => {
      if (hidden() || !deferred.size) return;
      const due = [...deferred];
      deferred.clear();
      for (const which of due) fire(which);
    };

    // A page navigated away from (or parked in the back-forward cache) must
    // not keep its stream: browsers allow few connections to one host, and a
    // stream left open makes the next page wait for one to free.
    const onPageHide = () => es.close();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setReopen((n) => n + 1);
    };

    es.addEventListener("tx", onTx);
    es.addEventListener("pool", onPool);
    es.addEventListener("request", onRequest);
    es.addEventListener("open", onOpen);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    // No error handler on purpose: EventSource retries by itself, and the
    // reconnect path above is what repairs the missed window. Logging every
    // blip would just fill the console during a deploy.

    return () => {
      es.removeEventListener("tx", onTx);
      es.removeEventListener("pool", onPool);
      es.removeEventListener("request", onRequest);
      es.removeEventListener("open", onOpen);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (timers.tx !== null) clearTimeout(timers.tx);
      if (timers.pool !== null) clearTimeout(timers.pool);
      es.close();
    };
  }, [groupKey, reopen]);
}
