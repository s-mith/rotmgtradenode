
import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";
import { isPlainStyle, type NameStyle } from "@/lib/cosmetics";

// Operator console for donator name effects. Granting an IGN here is what
// makes the "Customize name" menu appear in that player's login card; the
// operator doesn't pick the effect, the player does.
//
// Two ways off the list, and they differ:
//   Revoke — keeps the row and the player's chosen style, just stops it
//            rendering. Re-granting restores exactly what they had.
//   Remove — drops the row and the style pick with it.

type Grant = {
  ign: string;
  ignLower: string;
  enabled: boolean;
  style: NameStyle;
  grantedAt: number;
  updatedAt: number;
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

// "Gradient gold→red, bold" — what the player currently has picked, for the
// operator's benefit; the Name column already shows it rendered.
function describe(s: NameStyle): string {
  if (isPlainStyle(s)) return "plain";
  const parts: string[] = [];
  if (s.effect === "solid") parts.push(s.color.replace(/_/g, " "));
  else if (s.effect === "gradient")
    parts.push(`gradient ${s.from.replace(/_/g, " ")}→${s.to.replace(/_/g, " ")}`);
  else if (s.effect === "rainbow") parts.push("rainbow");
  if (s.animated && s.effect !== "solid" && s.effect !== "plain") parts.push("animated");
  for (const k of ["bold", "italic", "underline", "strike", "obfuscated"] as const) {
    if (s[k]) parts.push(k);
  }
  return parts.join(", ") || "plain";
}

export default function CosmeticsTab({ password }: { password: string }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string>("");
  const [newIgn, setNewIgn] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/cosmetics", {
        headers: { "x-dev-password": password },
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setGrants((data?.grants ?? []) as Grant[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  useEffect(() => {
    load();
  }, [load]);

  async function setEnabled(ign: string, enabled: boolean) {
    setSaving(true);
    try {
      const r = await fetch("/api/dev/cosmetics", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ign, enabled }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setNewIgn("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(ign: string) {
    if (!confirm(`Remove ${ign}'s cosmetics row?\n\nThis also discards the effect they picked. To pause them without losing it, use revoke instead.`))
      return;
    setSaving(true);
    try {
      const r = await fetch("/api/dev/cosmetics", {
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
        Grant a player Minecraft-style name effects. They pick the effect
        themselves from the “Customize name” menu in their login card; this
        list only controls who gets that menu. Revoking hides the effect but
        keeps their pick for a later re-grant.
      </p>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ign = newIgn.trim();
          if (ign) setEnabled(ign, true);
        }}
        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 20 }}
      >
        <input
          placeholder="IGN"
          value={newIgn}
          onChange={(e) => setNewIgn(e.target.value)}
          style={{ ...inputStyle, width: 160 }}
        />
        <button type="submit" disabled={saving || !newIgn.trim()} style={buttonStyle}>
          {saving ? "…" : "Grant effects"}
        </button>
      </form>

      {grants === null ? (
        <p>Loading…</p>
      ) : grants.length === 0 ? (
        <p style={{ color: "var(--muted, #999)" }}>Nobody has name effects yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 780 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
              <th style={{ padding: "6px 10px 6px 0" }}>Name</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Status</th>
              <th style={{ padding: "6px 10px 6px 0" }}>Their pick</th>
              <th style={{ padding: "6px 0" }}></th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.ignLower} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 10px 8px 0", fontWeight: 600 }}>
                  {/* The real component, so the colour and formatting are
                      an accurate preview — but `readable`, because this column
                      is how you identify the row. A §k name that scrambled
                      here would make the list unusable; the "Their pick"
                      column is what tells you obfuscated is on. */}
                  <PlayerName ign={g.ign} style={g.enabled ? g.style : null} readable />
                </td>
                <td
                  style={{
                    padding: "8px 10px 8px 0",
                    color: g.enabled ? "var(--good)" : "var(--muted)",
                  }}
                >
                  {g.enabled ? "granted" : "revoked"}
                </td>
                <td style={{ padding: "8px 10px 8px 0", color: "var(--muted)", fontSize: 12 }}>
                  {describe(g.style)}
                </td>
                <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                  <button
                    className="nav-link"
                    disabled={saving}
                    onClick={() => setEnabled(g.ign, !g.enabled)}
                  >
                    {g.enabled ? "revoke" : "re-grant"}
                  </button>{" "}
                  <button className="nav-link" disabled={saving} onClick={() => remove(g.ign)}>
                    remove
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
