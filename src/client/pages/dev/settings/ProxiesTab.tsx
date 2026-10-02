import { useCallback, useEffect, useState } from "react";
import OwnInternet from "@/client/shared/OwnInternet";
import ProxyEditor from "@/client/shared/ProxyEditor";

// Proxies: the addresses your accounts log in through, one account per host
// at a time. Paste a list (the shared editor checks it line by line and
// tests it), save, done. Unless the owner allows their own internet (a
// confirmed choice), nothing logs in from this computer's own connection:
// no proxies listed means no logins, which is the point.

type ProxyRow = { host: string; port: number; type: 4 | 5; username: string; password: string; enabled: boolean; ok: number; fail: number; benched: boolean; benchedUntil: number | null; inUse: boolean; usedBy: string | null };
type Payload = {
  capacity: number | null;
  inUse: number;
  required: boolean;
  text: string;
  proxies: ProxyRow[];
  saved?: { count: number; error: string | null };
};

const POLL_MS = 5000;

export default function ProxiesTab({ password }: { password: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { "Content-Type": "application/json", "x-dev-password": password };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/proxies", { headers, cache: "no-store" });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setData(body as Payload);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/dev/proxies", { method: "POST", headers, body: JSON.stringify(body) });
      const res = await r.json();
      if (!r.ok) {
        setError(res.error || `HTTP ${r.status}`);
        return;
      }
      setData(res as Payload);
      if (res.saved) setNotice(res.saved.error ? `Saved ${res.saved.count} proxies (${res.saved.error})` : `Saved ${res.saved.count} proxies.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.proxies ?? [];
  const enabled = rows.filter((p) => p.enabled).length;
  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 720 }}>
        Your bots log in to the game through these, one bot per proxy at a time. Paste the list your proxy seller gave you; most formats
        work, and each line shows whether the node understood it. The list stays on this computer.
      </p>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p style={{ color: "var(--good, #5aa86a)", fontSize: 13 }}>{notice}</p>}

      <ProxyEditor onSaved={() => void load()} />

      {data && (
        <div className="ui-card" style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>Your own internet</h3>
          <p className="ui-note" style={{ marginTop: 0 }}>Used only when no proxy is listed, and then for one bot at a time.</p>
          <OwnInternet allowed={!data.required} onChange={() => void load()} />
        </div>
      )}
      {data && data.required && rows.length === 0 && (
        <p style={{ color: "var(--bad)", fontSize: 13, marginTop: 8 }}>No proxies yet, and your own internet is not allowed: no bot can log in until you add proxies or allow your own internet.</p>
      )}
      {data && !data.required && rows.length === 0 && (
        <p style={{ color: "var(--warn, #d2a24c)", fontSize: 13, marginTop: 8 }}>No proxies listed: bots log in from this computer&apos;s own internet, one at a time.</p>
      )}

      {data && rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "16px 0 8px", fontSize: 13 }}>
            <span><strong>{enabled}</strong> of {rows.length} enabled · {data.inUse} in use{data.capacity !== null && <> · up to {data.capacity} accounts online</>}</span>
            <button className="nav-link" disabled={busy} onClick={() => void post({ host: null, enabled: true })}>enable all</button>
            <button className="nav-link" disabled={busy} onClick={() => void post({ host: null, enabled: false })}>disable all</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>host</th><th>port</th><th>type</th><th>ok</th><th>fail</th><th>state</th><th>used by</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.host} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                    <td style={{ fontFamily: "monospace" }}>{p.host}</td><td>{p.port}</td><td>socks{p.type}</td><td>{p.ok}</td><td>{p.fail}</td>
                    <td>{!p.enabled ? "off" : p.benched ? `benched until ${p.benchedUntil ? new Date(p.benchedUntil).toLocaleTimeString() : "?"}` : p.inUse ? "in use" : "free"}</td>
                    <td>{p.usedBy ?? ""}</td>
                    <td><button className="nav-link" disabled={busy} onClick={() => void post({ host: p.host, enabled: !p.enabled })}>{p.enabled ? "disable" : "enable"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
