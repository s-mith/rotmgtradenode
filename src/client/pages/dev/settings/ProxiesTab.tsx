import { useCallback, useEffect, useState } from "react";

// Proxies: the exit IPs your accounts log in through, one account per host
// at a time. Paste a list, save, done. With "proxy only" on (the default),
// nothing logs in from this computer's own connection: no proxies listed
// means no logins, which is the point.

type ProxyRow = { host: string; port: number; type: 4 | 5; username: string; password: string; enabled: boolean; ok: number; fail: number; benched: boolean; benchedUntil: number | null; inUse: boolean; usedBy: string | null };
type Payload = {
  source: { urlConfigured: boolean; file: string | null; loadedFrom: "url" | "file" | "none"; fetchedAt: number | null; lastError: string | null; refreshing: boolean };
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
  const [text, setText] = useState<string | null>(null);
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
      // Seed the paste box once; never overwrite what the owner is typing.
      setText((t) => (t === null ? (body as Payload).text : t));
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
      if (typeof body.text === "string") setText((res as Payload).text);
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
        Every login goes out through one of these, one account per exit IP at a time. Paste one proxy per line as{" "}
        <code>host:port</code> or <code>host:port:user:pass</code> (SOCKS5; prefix <code>socks4://</code> for SOCKS4). The list is saved in the node&apos;s
        data folder and never sent anywhere.
      </p>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p style={{ color: "var(--good, #5aa86a)", fontSize: 13 }}>{notice}</p>}

      <textarea
        value={text ?? ""}
        onChange={(e) => setText(e.target.value)}
        placeholder={"1.2.3.4:1080:user:pass\n5.6.7.8:1080"}
        spellCheck={false}
        style={{ width: "100%", minHeight: 160, fontFamily: "monospace", fontSize: 12, padding: 8, background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 }}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
        <button disabled={busy || text === null} onClick={() => void post({ text: text ?? "" })}>Save list</button>
        <button className="nav-link" disabled={busy || text === (data?.text ?? "")} onClick={() => setText(data?.text ?? "")}>revert</button>
        {data && (
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13, marginLeft: 12 }}>
            <input type="checkbox" checked={data.required} disabled={busy} onChange={(e) => void post({ required: e.target.checked })} />
            proxy only: never log in from this computer&apos;s own connection
          </label>
        )}
      </div>
      {data && data.required && rows.length === 0 && (
        <p style={{ color: "var(--bad)", fontSize: 13, marginTop: 8 }}>No proxies listed and &ldquo;proxy only&rdquo; is on: no account can log in until you paste some.</p>
      )}
      {data && !data.required && rows.length === 0 && (
        <p style={{ color: "var(--warn, #d2a24c)", fontSize: 13, marginTop: 8 }}>No proxies listed: accounts will log in from this computer&apos;s own IP.</p>
      )}

      {data && rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", margin: "16px 0 8px", fontSize: 13 }}>
            <span><strong>{enabled}</strong> of {rows.length} enabled · {data.inUse} in use{data.capacity !== null && <> · up to {data.capacity} accounts online</>}</span>
            <button className="nav-link" disabled={busy} onClick={() => void post({ host: null, enabled: true })}>enable all</button>
            <button className="nav-link" disabled={busy} onClick={() => void post({ host: null, enabled: false })}>disable all</button>
            {data.source.urlConfigured && <button className="nav-link" disabled={busy} onClick={() => void post({ refresh: true })}>re-download from PROXIES_URL</button>}
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
