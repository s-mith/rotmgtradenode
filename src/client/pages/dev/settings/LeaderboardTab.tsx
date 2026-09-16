
import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Operator console for leaderboard disqualifications.
//
// What this does and doesn't do, because the distinction is the whole feature:
// a disqualified player stops appearing on the boards and stops holding a
// rank, and everyone below them moves up. Nothing about their ledger changes —
// their points are still counted, their profile still shows their history, and
// putting them back restores the exact position they would have had. It is a
// moderation switch, not a scoring one.

type Dq = {
  ign: string;
  ignLower: string;
  reason: string;
  createdAt: number;
  /** What they'd score if requalified — context for "should this stay?". */
  points: number;
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: 6,
  color: "#000",
  fontWeight: 600,
  cursor: "pointer",
};

function when(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export default function LeaderboardTab({ password }: { password: string }) {
  const [rows, setRows] = useState<Dq[] | null>(null);
  const [error, setError] = useState<string>("");
  const [newIgn, setNewIgn] = useState("");
  const [newReason, setNewReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/leaderboard-dq", {
        headers: { "x-dev-password": password },
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setRows((data?.disqualified ?? []) as Dq[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ign = newIgn.trim();
    if (!ign) return;
    // Confirmed because it changes what every visitor sees on the front page,
    // and because re-submitting an IGN already on the list silently rewrites
    // its reason.
    if (
      !confirm(
        `Disqualify ${ign} from the leaderboard?\n\n` +
          "They stop appearing on both boards and hold no rank; everyone " +
          "below them moves up. Their points, profile and history are " +
          "unchanged — requalifying puts them straight back.",
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/dev/leaderboard-dq", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ign, reason: newReason.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setNewIgn("");
      setNewReason("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function requalify(ign: string) {
    setSaving(true);
    try {
      const r = await fetch("/api/dev/leaderboard-dq", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ign }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 640 }}>
        Hide a player from the leaderboards. They keep their points, their
        profile and their history — they just stop being ranked, and everyone
        below them moves up. Nothing here edits the ledger, so requalifying
        restores the position they would have had.
      </p>

      <form
        onSubmit={submit}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}
      >
        <input
          placeholder="IGN"
          value={newIgn}
          onChange={(e) => setNewIgn(e.target.value)}
          style={{ ...inputStyle, width: 160 }}
        />
        <input
          placeholder="reason (optional, for your own records)"
          value={newReason}
          onChange={(e) => setNewReason(e.target.value)}
          maxLength={200}
          style={{ ...inputStyle, width: 320 }}
        />
        <button type="submit" disabled={saving || !newIgn.trim()} style={buttonStyle}>
          {saving ? "…" : "Disqualify"}
        </button>
      </form>

      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}

      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--muted, #999)" }}>
          Nobody is disqualified — every scored player is on the boards.
        </p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 720 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
              <th style={{ padding: "6px 10px 6px 0" }}>IGN</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Points if restored</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Reason</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Since</th>
              <th style={{ padding: "6px 0" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.ignLower} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px 8px 0", fontWeight: 600 }}>
                  <PlayerName ign={d.ign} readable />
                </td>
                <td style={{ padding: "8px 10px 8px 0" }}>{d.points}</td>
                <td style={{ padding: "8px 10px 8px 0", color: "var(--muted, #999)" }}>
                  {d.reason || "—"}
                </td>
                <td style={{ padding: "8px 10px 8px 0", color: "var(--muted, #999)" }}>
                  {when(d.createdAt)}
                </td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>
                  <button
                    type="button"
                    onClick={() => void requalify(d.ign)}
                    disabled={saving}
                    className="nav-link"
                  >
                    requalify
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
