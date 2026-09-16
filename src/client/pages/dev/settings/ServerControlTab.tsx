
import { useCallback, useEffect, useState } from "react";

type Control = {
  server: string;
  depositsDisabled: boolean;
  withdrawsDisabled: boolean;
  /** Realm's load (0..1) from the fleet's last fresh reading; null without one. */
  usage: number | null;
  /** Closed by the load gate — trades only run on empty servers. */
  busy: boolean;
};

export default function ServerControlTab({ password }: { password: string }) {
  const [controls, setControls] = useState<Control[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/server-controls", {
        headers: { "x-dev-password": password },
        cache: "no-store",
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setControls(data.controls as Control[]);
    } catch (e) {
      setError(String(e));
    }
  }, [password]);

  // The load column moves by the minute; keep it current while the tab is open.
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const anyReading = controls?.some((c) => c.usage !== null) ?? false;

  async function toggle(server: string, field: "depositsDisabled" | "withdrawsDisabled") {
    if (!controls) return;
    const current = controls.find((c) => c.server === server);
    if (!current) return;

    const patch = {
      server,
      depositsDisabled: current.depositsDisabled,
      withdrawsDisabled: current.withdrawsDisabled,
      [field]: !current[field],
    };

    setSaving(server);
    setError("");
    try {
      const r = await fetch("/api/dev/server-controls", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setControls(data.controls as Control[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12 }}>
        Disable deposits and/or withdraws per server. Players on a disabled
        server see an error and must pick another. Independently of these
        toggles, a server Realm reports as loaded (the Load column, from
        account/servers via an online bot) is closed to both until it reads
        empty again.
        {controls !== null && !anyReading && " No fresh load reading right now — the load gate is standing down and only the toggles apply."}
      </p>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {controls === null ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 520 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
              <th style={{ padding: "6px 10px 6px 0" }}>Server</th>
              <th style={{ padding: "6px 10px 6px 0", textAlign: "right" }}>Load</th>
              <th style={{ padding: "6px 10px 6px 0", textAlign: "center" }}>Deposits</th>
              <th style={{ padding: "6px 10px 6px 0", textAlign: "center" }}>Withdraws</th>
            </tr>
          </thead>
          <tbody>
            {controls.map((c) => (
              <tr key={c.server} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 10px 6px 0", fontWeight: 600 }}>{c.server}</td>
                <td style={{ padding: "6px 10px 6px 0", textAlign: "right", color: c.busy ? "var(--bad, #e44)" : "var(--muted, #999)", fontVariantNumeric: "tabular-nums" }}>
                  {c.usage === null ? "—" : `${Math.round(c.usage * 100)}%${c.busy ? " · closed" : ""}`}
                </td>
                <td style={{ padding: "6px 10px 6px 0", textAlign: "center" }}>
                  <button
                    onClick={() => toggle(c.server, "depositsDisabled")}
                    disabled={saving === c.server}
                    style={{
                      padding: "4px 12px",
                      border: 0,
                      borderRadius: 4,
                      cursor: saving === c.server ? "wait" : "pointer",
                      fontWeight: 600,
                      fontSize: 12,
                      background: c.depositsDisabled ? "var(--bad, #e44)" : "var(--good, #4a4)",
                      color: "#fff",
                    }}
                  >
                    {c.depositsDisabled ? "OFF" : "ON"}
                  </button>
                </td>
                <td style={{ padding: "6px 10px 6px 0", textAlign: "center" }}>
                  <button
                    onClick={() => toggle(c.server, "withdrawsDisabled")}
                    disabled={saving === c.server}
                    style={{
                      padding: "4px 12px",
                      border: 0,
                      borderRadius: 4,
                      cursor: saving === c.server ? "wait" : "pointer",
                      fontWeight: 600,
                      fontSize: 12,
                      background: c.withdrawsDisabled ? "var(--bad, #e44)" : "var(--good, #4a4)",
                      color: "#fff",
                    }}
                  >
                    {c.withdrawsDisabled ? "OFF" : "ON"}
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
