import { useCallback, useEffect, useState } from "react";
// Shared vaults (design doc §6.5): give a hub user space on this node. Each
// guest gets a personal vault here with a slot quota per half, a role, and
// optionally the right to trade with their items. Guests use the hub
// website; this node does the trades.

type Guest = { grantId: number; hubUserId: number; localUserId: number; ign: string; displayName: string; slotsSeasonal: number; slotsNonseasonal: number; role: string; trade: boolean; paused: boolean; usedSeasonal: number; usedNonseasonal: number };
type Status = { linked: boolean; lastGrantsAt: number | null; lastRequestsAt: number | null; lastError: string | null; guests: Guest[]; recent: { id: number; kind: string; guest: string; ok: boolean; detail: string; at: number }[] };
const ROLES = [["deposit", "deposit only"], ["withdraw-own", "withdraw own"], ["withdraw-any", "withdraw any"], ["co-owner", "co-owner"]] as const;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "never");

export default function SharesTab({ password }: { password: string }) {
  const headers = { "Content-Type": "application/json", "x-dev-password": password };
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", ign: "", slotsSeasonal: "8", slotsNonseasonal: "0", role: "withdraw-own", trade: false });

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/shares", { headers, cache: "no-store" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      setSt(b);
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/dev/shares", { method: "POST", headers, body: JSON.stringify(body) });
      const b = await r.json();
      if (!r.ok) setError(b.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 720 }}>
        Give a hub user their own vault on this node: a slot quota per half, a role, and optionally the right to trade with those items. They
        deposit, withdraw and trade from the hub website; your bots do the physical trades, so their meetings count against this node&apos;s limits.
        Lowering a quota below what is used blocks new deposits but never evicts.
      </p>
      {st && !st.linked && <p style={{ color: "var(--warn, #d2a24c)" }}>Shared vaults need the hub: link this node under Fleet → Node first.</p>}
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}

      <form onSubmit={(e) => { e.preventDefault(); void post({ action: "grant", ...form }); }} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="guest's hub email" style={{ width: 200 }} />
        <input value={form.ign} onChange={(e) => setForm({ ...form, ign: e.target.value })} placeholder="their IGN" style={{ width: 130 }} />
        <label style={{ fontSize: 12 }}>seasonal <input type="number" min={0} max={200} value={form.slotsSeasonal} onChange={(e) => setForm({ ...form, slotsSeasonal: e.target.value })} style={{ width: 56 }} /></label>
        <label style={{ fontSize: 12 }}>non-seasonal <input type="number" min={0} max={200} value={form.slotsNonseasonal} onChange={(e) => setForm({ ...form, slotsNonseasonal: e.target.value })} style={{ width: 56 }} /></label>
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={form.trade} onChange={(e) => setForm({ ...form, trade: e.target.checked })} /> may trade</label>
        <button type="submit" disabled={busy || !form.email || !form.ign}>Grant</button>
      </form>

      {st && (st.guests.length === 0 ? <p style={{ color: "var(--muted, #999)" }}>No guests yet.</p> : (
        <table style={{ fontSize: 13, width: "100%" }}>
          <thead><tr><th>guest</th><th>IGN</th><th>seasonal</th><th>non-seasonal</th><th>role</th><th>trade</th><th></th></tr></thead>
          <tbody>
            {st.guests.map((g) => (
              <tr key={g.grantId} style={{ opacity: g.paused ? 0.6 : 1 }}>
                <td>{g.displayName}{g.paused ? " (paused)" : ""}</td>
                <td>{g.ign}</td>
                <td>{g.usedSeasonal} / <input type="number" min={0} max={200} defaultValue={g.slotsSeasonal} style={{ width: 52 }} onBlur={(e) => Number(e.target.value) !== g.slotsSeasonal && void post({ action: "update", id: g.grantId, slotsSeasonal: e.target.value })} /></td>
                <td>{g.usedNonseasonal} / <input type="number" min={0} max={200} defaultValue={g.slotsNonseasonal} style={{ width: 52 }} onBlur={(e) => Number(e.target.value) !== g.slotsNonseasonal && void post({ action: "update", id: g.grantId, slotsNonseasonal: e.target.value })} /></td>
                <td><select value={g.role} onChange={(e) => void post({ action: "update", id: g.grantId, role: e.target.value })}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                <td><input type="checkbox" checked={g.trade} onChange={(e) => void post({ action: "update", id: g.grantId, trade: e.target.checked })} /></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="nav-link" disabled={busy} onClick={() => void post({ action: "update", id: g.grantId, paused: !g.paused })}>{g.paused ? "resume" : "pause"}</button>{" "}
                  <button className="nav-link" disabled={busy} onClick={() => confirm(`Revoke ${g.displayName}'s access? Their items stay until withdrawn; their quota drops to 0.`) && void post({ action: "revoke", id: g.grantId })}>revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      {st && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--muted, #999)" }}>
            <b>Guest requests</b> grants refreshed {when(st.lastGrantsAt)} · requests polled {when(st.lastRequestsAt)}{st.lastError ? ` · ${st.lastError}` : ""}
            <button className="nav-link" disabled={busy} onClick={() => void post({ action: "refresh" })}>poll now</button>
          </div>
          {st.recent.length === 0 ? <p style={{ color: "var(--muted, #999)", fontSize: 13 }}>None handled yet.</p> : (
            <table style={{ fontSize: 12, marginTop: 6 }}>
              <tbody>{st.recent.map((r) => <tr key={r.id}><td>#{r.id}</td><td>{r.guest}</td><td>{r.kind}</td><td style={{ color: r.ok ? "var(--good, #5aa86a)" : "var(--bad)" }}>{r.ok ? "ok" : "failed"}</td><td>{r.detail}</td><td>{when(r.at)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
