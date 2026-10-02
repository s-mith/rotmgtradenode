// One way to say "how long ago" across the site and the control panel.

/** "just now", "4m ago", "3h ago", "2d ago"; `never` for a missing time. */
export function relTime(ts: number | null | undefined, never = "never"): string {
  // 0 is "never" too: a clock that was never set, not 1970.
  if (!ts) return never;
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
