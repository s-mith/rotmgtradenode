import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Operator console for per-player feature access (lib/features.ts). A grant
// names one character; the player's whole account — every linked IGN — gets
// the feature. Revoking drops the grant; anything the player built with the
// feature (wishlist rules, say) stays put but goes dormant.

type Grant = { feature: string; ign: string; ignLower: string; grantedAt: number };

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

export default function FeaturesTab({ password }: { password: string }) {
  const [features, setFeatures] = useState<Record<string, string>>({});
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState("");
  const [newIgn, setNewIgn] = useState("");
  const [newFeature, setNewFeature] = useState("wishlist");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/features", { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setFeatures(data.features ?? {});
      setGrants((data.grants ?? []) as Grant[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(method: "POST" | "DELETE", feature: string, ign: string) {
    setSaving(true);
    try {
      const r = await fetch("/api/dev/features", {
        method,
        headers: { "content-type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ feature, ign }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      if (method === "POST") setNewIgn("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  const names = Object.keys(features);

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 640 }}>
        Switch features on for individual players. A grant names one character and covers every character linked to that account.
      </p>
      <ul style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 16, paddingLeft: 18 }}>
        {names.map((n) => (
          <li key={n}>
            <strong style={{ color: "var(--text)" }}>{n}</strong> — {features[n]}
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (newIgn.trim()) void send("POST", newFeature, newIgn.trim());
        }}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}
      >
        <input placeholder="IGN" value={newIgn} onChange={(e) => setNewIgn(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        <select value={newFeature} onChange={(e) => setNewFeature(e.target.value)} style={inputStyle}>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button type="submit" disabled={saving || !newIgn.trim()} style={buttonStyle}>
          {saving ? "…" : "Grant"}
        </button>
      </form>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {grants === null ? (
        <p>Loading…</p>
      ) : grants.length === 0 ? (
        <p style={{ color: "var(--muted, #999)" }}>No grants yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 640 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
              <th style={{ padding: "6px 10px 6px 0" }}>Feature</th>
              <th style={{ padding: "6px 10px 6px 0" }}>IGN</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Granted</th>
              <th style={{ padding: "6px 0" }}></th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.feature + g.ignLower} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px 8px 0" }}>{g.feature}</td>
                <td style={{ padding: "8px 10px 8px 0", fontWeight: 600 }}>
                  <PlayerName ign={g.ign} readable />
                </td>
                <td style={{ padding: "8px 10px 8px 0" }} title={new Date(g.grantedAt).toLocaleString()}>
                  {new Date(g.grantedAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                  <button className="nav-link" disabled={saving} onClick={() => void send("DELETE", g.feature, g.ign)}>
                    revoke
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
