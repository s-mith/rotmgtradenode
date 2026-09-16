import { useCallback, useEffect, useState } from "react";

// Proxies — the relay's exit-IP pool. Every host the relay loaded (from
// PROXIES_URL, cached to proxies.txt), with an on/off switch per host. Off
// means "don't hand this host out again": a bot already on it keeps its
// session until it disconnects, so a disable is never a mid-trade kick.
// Capacity is the number of enabled hosts, since the fleet runs one bot per
// exit IP; disabling everything parks the whole fleet as bots go offline.

type ProxyRow = {
  host: string;
  port: number;
  type: 4 | 5;
  username: string;
  password: string;
  enabled: boolean;
  ok: number;
  fail: number;
  benched: boolean;
  benchedUntil: number | null;
  inUse: boolean;
  usedBy: string | null;
};

type Payload = {
  source: {
    urlConfigured: boolean;
    file: string | null;
    loadedFrom: "url" | "file" | "none";
    fetchedAt: number | null;
    lastError: string | null;
    refreshing: boolean;
  };
  capacity: number | null;
  inUse: number;
  proxies: ProxyRow[];
  refresh?: { ok: boolean; count: number; error: string | null };
};

const POLL_MS = 5000;

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function ProxiesTab({ password }: { password: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/proxies", { headers: { "x-dev-password": password }, cache: "no-store" });
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
  }, [password]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    try {
      const r = await fetch("/api/dev/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify(body),
      });
      const res = await r.json();
      if (!r.ok) {
        setError(res.error || `HTTP ${r.status}`);
        return;
      }
      setData(res as Payload);
      if (res.refresh) {
        setNotice(res.refresh.ok ? `Refreshed: ${res.refresh.count} exit IP(s) loaded.` : `Refresh failed: ${res.refresh.error}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // host:port:user:pass per line — the same shape Webshare downloads in, so
  // the text pastes straight into another proxies.txt.
  async function copyDisabled() {
    const off = (data?.proxies ?? []).filter((p) => !p.enabled);
    if (!off.length) {
      setNotice("No proxies are turned off.");
      return;
    }
    const text = off.map((p) => [p.host, p.port, p.username, p.password].join(":")).join("\n") + "\n";
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${off.length} disabled proxy line(s) to the clipboard.`);
    } catch (e) {
      setError(`Clipboard write failed: ${String(e)}`);
    }
  }

  function setAll(enabled: boolean) {
    if (!enabled && !confirm("Disable EVERY proxy?\n\nNo new bot can log in until at least one host is enabled again. Bots already online keep their sessions until they disconnect.")) return;
    post({ host: null, enabled }, "all");
  }

  const rows = (data?.proxies ?? []).filter((p) => !filter || p.host.includes(filter) || (p.usedBy ?? "").toLowerCase().includes(filter.toLowerCase()));
  const enabledCount = data?.proxies.filter((p) => p.enabled).length ?? 0;
  const total = data?.proxies.length ?? 0;

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 720 }}>
        Exit IPs the relay hands to bots, one bot per host. Switching a host off
        stops it being handed out; a bot already on it keeps its session until it
        disconnects on its own. The list comes from <code>PROXIES_URL</code> and is
        cached to the relay&apos;s <code>proxies.txt</code>.
      </p>

      {data && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 12, fontSize: 13 }}>
          <span>
            <strong>{enabledCount}</strong> of {total} enabled
            {data.capacity !== null && <> · capacity {data.capacity}</>}
            {" · "}{data.inUse} in use
          </span>
          <span style={{ color: "var(--muted, #999)" }}>
            source: {data.source.loadedFrom}
            {data.source.urlConfigured ? ` · fetched ${ago(data.source.fetchedAt)}` : " · PROXIES_URL not set"}
            {data.source.refreshing && " · refreshing…"}
          </span>
          {data.source.lastError && <span style={{ color: "var(--bad)" }}>last fetch: {data.source.lastError}</span>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <button className="nav-link" disabled={busy !== null || !data?.source.urlConfigured} onClick={() => post({ refresh: true }, "refresh")} title={data?.source.urlConfigured ? "Re-download the list from PROXIES_URL" : "PROXIES_URL is not configured"}>
          {busy === "refresh" ? "refreshing…" : "refresh from Webshare"}
        </button>
        <button className="nav-link" disabled={busy !== null || !total} onClick={() => setAll(true)}>enable all</button>
        <button className="nav-link" disabled={busy !== null || !total} onClick={() => setAll(false)}>disable all</button>
        <button
          className="nav-link"
          disabled={!total || enabledCount === total}
          onClick={copyDisabled}
          title="Copy host:port:user:pass for every host that is turned off"
        >
          copy disabled ({total - enabledCount})
        </button>
        <input
          placeholder="filter host or bot"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginLeft: "auto", padding: "4px 8px", background: "var(--input-bg, transparent)", color: "inherit", border: "1px solid var(--border)", borderRadius: 4, width: 200 }}
        />
      </div>

      {notice && <p style={{ fontSize: 13, marginBottom: 8 }}>{notice}</p>}
      {error && <p style={{ color: "var(--bad)", marginBottom: 8 }}>{error}</p>}

      {!data ? (
        <p>Loading…</p>
      ) : !total ? (
        <p style={{ color: "var(--muted, #999)" }}>No proxies loaded. Every bot connects from this host&apos;s own IP.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted, #999)" }}>
                <th style={{ padding: "6px 10px 6px 0" }}>on</th>
                <th style={{ padding: "6px 10px 6px 0" }}>host</th>
                <th style={{ padding: "6px 10px 6px 0" }}>port</th>
                <th style={{ padding: "6px 10px 6px 0" }}>in use by</th>
                <th style={{ padding: "6px 10px 6px 0" }}>health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.host} style={{ borderTop: "1px solid var(--border)", opacity: p.enabled ? 1 : 0.55 }}>
                  <td style={{ padding: "6px 10px 6px 0" }}>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={busy !== null}
                      onChange={(e) => post({ host: p.host, enabled: e.target.checked }, p.host)}
                      title={p.enabled ? "Enabled — click to stop handing this host out" : "Disabled — click to allow bots on this host again"}
                    />
                  </td>
                  <td style={{ padding: "6px 10px 6px 0", fontFamily: "monospace" }}>{p.host}</td>
                  <td style={{ padding: "6px 10px 6px 0", fontFamily: "monospace" }}>{p.port}{p.type === 4 ? " (socks4)" : ""}</td>
                  <td style={{ padding: "6px 10px 6px 0" }}>
                    {p.usedBy ?? <span style={{ color: "var(--muted, #999)" }}>—</span>}
                    {p.inUse && !p.enabled && <span style={{ color: "var(--muted, #999)" }}> (until it disconnects)</span>}
                  </td>
                  <td style={{ padding: "6px 10px 6px 0", whiteSpace: "nowrap" }}>
                    {p.benched ? (
                      <span style={{ color: "var(--bad)" }} title={p.benchedUntil ? `until ${new Date(p.benchedUntil).toLocaleTimeString()}` : undefined}>benched</span>
                    ) : p.fail > 0 ? (
                      <span style={{ color: "var(--warn, orange)" }}>{p.fail} fail</span>
                    ) : (
                      <span style={{ color: "var(--muted, #999)" }}>ok</span>
                    )}
                    <span style={{ color: "var(--muted, #999)" }}> · {p.ok} ok / {p.fail} fail</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filter && rows.length !== total && <p style={{ fontSize: 12, color: "var(--muted, #999)", marginTop: 6 }}>{rows.length} of {total} shown</p>}
        </div>
      )}
    </section>
  );
}
