
import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Operator-only "Awaiting Bot" view. Formerly a public panel on the Vault; it
// leaked the live IGN + server of whoever was mid-deposit, which let people
// intercept them in game. Now dev-gated and polled here.

type Req = {
  id: number;
  ign: string;
  server: string;
  itemCount: number;
  status: "pending" | "claimed";
  claimedBy: string | null;
  createdAt: number;
};

export default function DepositsTab({ password }: { password: string }) {
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/pending-deposits", {
        headers: { "x-dev-password": password },
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setReqs((data.requests ?? []) as Req[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  // Poll while the tab is mounted; switching away unmounts and stops it.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12 }}>
        Deposits awaiting a bot. Operator-only — the depositor&apos;s IGN and
        server are visible here so they can&apos;t be sniped from a public panel.
      </p>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {reqs === null ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : reqs.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No deposits awaiting a bot.</p>
      ) : (
        <ul className="tx-feed">
          {reqs.map((r) => (
            <li key={r.id}>
              <span>
                <strong style={{ color: "var(--accent-hot)" }}>#{r.id}</strong>{" "}
                <span>
                  <PlayerName ign={r.ign} readable />
                </span>{" "}
                <span style={{ color: "var(--muted)" }}>· {r.server}</span>{" "}
                <span style={{ color: "var(--muted)" }}>
                  · {r.itemCount}-slot trade
                </span>
                <span className={`status status-${r.status}`}> · {r.status}</span>
                {r.claimedBy && (
                  <span style={{ color: "var(--muted)" }}> · by {r.claimedBy}</span>
                )}
              </span>
              <span className="tx-time">{relTime(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
