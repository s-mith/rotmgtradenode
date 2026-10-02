import { useCallback, useEffect, useMemo, useState } from "react";

// Per-server switches for deposits and withdraws, grouped by region, with
// Realm's load beside each. A server the load gate has closed (trades only
// run on empty servers) is marked in red whatever the switches say. Rows
// become cards on a phone (globals.css, .dev-table).

type Control = {
  server: string;
  depositsDisabled: boolean;
  withdrawsDisabled: boolean;
  /** Realm's load (0..1) from the fleet's last fresh reading; null without one. */
  usage: number | null;
  /** Closed by the load gate — trades only run on empty servers. */
  busy: boolean;
};

const REGIONS: { id: string; label: string; test: (s: string) => boolean }[] = [
  { id: "us", label: "United States", test: (s) => s.startsWith("US") },
  { id: "eu", label: "Europe", test: (s) => s.startsWith("EU") },
  { id: "asia", label: "Asia", test: (s) => /^(Asia|Australia|Aus)/.test(s) },
  { id: "other", label: "Other", test: () => true },
];

export default function ServerControlTab({ password }: { password: string }) {
  const [controls, setControls] = useState<Control[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);

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
  const changed = (c: Control) => c.depositsDisabled || c.withdrawsDisabled || c.busy;
  const groups = useMemo(() => {
    if (!controls) return [];
    const rest = [...controls];
    return REGIONS.map((r) => {
      const mine = rest.filter((c) => r.test(c.server));
      for (const m of mine) rest.splice(rest.indexOf(m), 1);
      return { ...r, servers: mine.filter((c) => !onlyChanged || changed(c)) };
    }).filter((g) => g.servers.length);
  }, [controls, onlyChanged]);
  const off = controls?.filter(changed).length ?? 0;

  async function toggle(server: string, field: "depositsDisabled" | "withdrawsDisabled") {
    if (!controls) return;
    const current = controls.find((c) => c.server === server);
    if (!current) return;
    const patch = { server, depositsDisabled: current.depositsDisabled, withdrawsDisabled: current.withdrawsDisabled, [field]: !current[field] };
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

  const Switch = ({ c, field }: { c: Control; field: "depositsDisabled" | "withdrawsDisabled" }) => {
    const disabled = c[field];
    return (
      <button
        type="button"
        role="switch"
        aria-checked={!disabled}
        className={"dev-switch" + (disabled ? " off" : " on")}
        onClick={() => toggle(c.server, field)}
        disabled={saving === c.server}
        title={disabled ? `${field === "depositsDisabled" ? "Deposits" : "Withdraws"} are off on ${c.server}; click to allow them` : `Click to stop ${field === "depositsDisabled" ? "deposits" : "withdraws"} on ${c.server}`}
      >
        {disabled ? "off" : "on"}
      </button>
    );
  };

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 720 }}>
        Stop deposits or withdraws on a server. Players on a stopped server see an error and must pick another. Independently, a server Realm reports as loaded is closed to both until it reads empty again; those are marked <span className="bad">closed</span>.
        {controls !== null && !anyReading && " No fresh load reading right now — the load gate is standing down and only the switches apply."}
      </p>
      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}
      {controls !== null && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, fontSize: 13 }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> only servers that are off or closed
          </label>
          <span className="muted">{off === 0 ? "everything is open" : `${off} of ${controls.length} servers are off or closed`}</span>
        </div>
      )}

      {controls === null ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : groups.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>Every server is open with both switches on.</p>
      ) : (
        groups.map((g) => (
          <div key={g.id} style={{ marginBottom: 18 }}>
            <h3 className="dev-h3">{g.label}</h3>
            <table className="dev-table" style={{ maxWidth: 560 }}>
              <thead>
                <tr>
                  <th>Server</th>
                  <th style={{ textAlign: "right" }}>Load</th>
                  <th style={{ textAlign: "center" }}>Deposits</th>
                  <th style={{ textAlign: "center" }}>Withdraws</th>
                </tr>
              </thead>
              <tbody>
                {g.servers.map((c) => (
                  <tr key={c.server} className={c.busy ? "closed" : ""}>
                    <td data-th="server" style={{ fontWeight: 600 }}>{c.server}{c.busy && <span className="tab-badge bad" style={{ marginLeft: 8 }}>closed</span>}</td>
                    <td data-th="load" style={{ textAlign: "right", color: c.busy ? "var(--bad, #e44)" : "var(--muted, #999)", fontVariantNumeric: "tabular-nums" }}>
                      {c.usage === null ? "—" : `${Math.round(c.usage * 100)}%`}
                    </td>
                    <td data-th="deposits" style={{ textAlign: "center" }}><Switch c={c} field="depositsDisabled" /></td>
                    <td data-th="withdraws" style={{ textAlign: "center" }}><Switch c={c} field="withdrawsDisabled" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}
