
import { useEffect, useState } from "react";
import { ItemSprite } from "./ItemSprite";
import PlayerName from "./PlayerName";

// One row of the ledger, straight from /api/recent. The route resolves the
// catalog code to `itemName`, which ItemSprite normalizes into a sprite.
type Event = {
  id: number;
  kind: "deposit" | "withdraw";
  ign: string;
  itemName: string;
  qty: number;
  server: string | null;
  createdAt: number;
};

// Relative "3m ago" stamp, same style as the comrade profile feed.
// `ts` is a millisecond epoch (what the ledger stores via Date.now()).
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Live feed of the newest deposits/withdrawals across the pool. Re-fetches
// whenever `refreshKey` bumps (a trade just landed), same as Leaderboard, so
// the panels in the aside stay in sync.
export default function RecentActivity({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<Event[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/recent", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setEvents(d.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (events === null) {
    return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  }
  if (events.length === 0) {
    return <p style={{ color: "var(--muted)" }}>No activity yet — the pool is quiet.</p>;
  }

  return (
    <ul className="tx-feed">
      {events.map((e) => (
        <li key={e.id}>
          <span className="profile-feed-main">
            <strong className={`tx-kind ${e.kind}`}>
              {e.kind === "deposit" ? "+" : "−"}
              {e.qty}
            </strong>{" "}
            <ItemSprite name={e.itemName} className="profile-feed-sprite" />
            <span title={e.itemName}>{e.itemName}</span>{" "}

          </span>
          
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <span className="tx-time">
              {e.server ? `${e.server} · ` : ""}
              {relTime(e.createdAt)}
            </span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              <PlayerName ign={e.ign} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
