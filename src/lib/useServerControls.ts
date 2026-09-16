"use client";

import { useEffect, useState } from "react";

// Which servers a trade may not target right now, from /api/server-controls:
// operator toggles and Realm's load (the fleet only trades on empty servers).
// Load moves by the minute, so the pickers poll while mounted rather than
// reading once; a hidden tab skips the poll until it is looked at again.
export type DisabledServer = { deposits: boolean; withdraws: boolean; busy?: boolean; usage?: number };
export type DisabledServers = Record<string, DisabledServer>;

const POLL_MS = 20_000;

export function useServerControls(): DisabledServers {
  const [disabled, setDisabled] = useState<DisabledServers>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      fetch("/api/server-controls", { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) setDisabled((data.disabled ?? {}) as DisabledServers);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return disabled;
}

/** The picker's label suffix for a server that is off, or "" when it is open. */
export function serverOffLabel(d: DisabledServer | undefined, kind: "deposit" | "withdraw"): string {
  if (!d) return "";
  const off = kind === "deposit" ? d.deposits : d.withdraws;
  if (!off) return "";
  if (d.busy) return d.usage !== undefined ? ` (busy · ${Math.round(d.usage * 100)}% full)` : " (busy)";
  return " (disabled)";
}
