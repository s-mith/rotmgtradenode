import { useCallback, useEffect, useState } from "react";
// Node: the build gate, Realm's server list, the version feed and ban
// telemetry (design doc §8). Everything on this tab is about keeping the
// node's own accounts safe: no login on a Realm build that has not been
// seen to work, and a way to tell the hub when an account is suspended.

type Status = {
  version: string;
  feed: { polling: boolean; lastFetchAt: number; lastError: string | null; info: { gameVersion: string; metadataVersion: string; updatedAt: string } | null };
  build: { build: string; known: boolean; held: boolean; reason: string | null; knownBuilds: string[]; canary: { running: boolean; last: { ok: boolean; build: string; ign?: string; seconds?: number; reason?: string } | null } };
  servers: { fetchedAt: number; stale: boolean; lastError: string | null; servers: Record<string, string> };
  telemetry: { enabled: boolean; hubUrl: string; queued: number; sent: number; lastFlushAt: number | null; lastError: string | null };
};

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "never");

export default function NodeTab({ password }: { password: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hubUrl, setHubUrl] = useState("");
  const headers = { "X-Dev-Password": password, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/node", { headers });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setStatus(data as Status);
      setHubUrl((h) => h || (data as Status).telemetry.hubUrl);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/dev/node", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) setError(data.error || (data.canary?.reason ? `canary: ${data.canary.reason}` : `HTTP ${r.status}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const b = status?.build;
  const t = status?.telemetry;
  const last = b?.canary.last;
  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}

      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Realm build</b>{" "}
        {b ? (
          <>
            <span style={{ fontFamily: "monospace" }}>{b.build}</span>{" · "}
            {b.held ? <span style={{ color: "var(--bad)" }}>logins held</span> : <span style={{ color: "var(--good, #5aa86a)" }}>known, logins open</span>}
            {b.reason && <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>{b.reason}</div>}
            <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>
              feed: {status?.feed.polling ? `polled, last ${when(status.feed.lastFetchAt)}` : "off"}{status?.feed.lastError ? ` (${status.feed.lastError})` : ""}
              {status?.feed.info ? ` · feed says ${status.feed.info.gameVersion}, metadata ${status.feed.info.metadataVersion || "?"}` : ""}
              {" · known builds: "}{b.knownBuilds.join(", ")}
            </div>
            {last && (
              <div style={{ fontSize: 12, marginTop: 4, color: last.ok ? "var(--good, #5aa86a)" : "var(--bad)" }}>
                last canary on {last.build}: {last.ok ? `${last.ign} held the world (${last.seconds}s)` : last.reason}
              </div>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={busy || b.canary.running} onClick={() => void act({ action: "canary" }, "Log ONE account in on this build to see whether the node's codecs still work? If Realm kicks it, the hold stays on. Use an account you would not mind losing.")}>
                {b.canary.running ? "canary running…" : "Run a canary login"}
              </button>
              {b.held && (
                <button disabled={busy} onClick={() => void act({ action: "trust" }, "Record this build as known WITHOUT a canary? Every account may then log in on it. Only do this if you know the protocol did not change.")}>
                  Trust this build
                </button>
              )}
            </div>
          </>
        ) : "…"}
      </div>

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Servers</b>{" "}
        {status ? (
          <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>
            {Object.keys(status.servers.servers).length} known · refreshed {when(status.servers.fetchedAt)}{status.servers.stale ? " (stale: refreshed at the next login)" : ""}{status.servers.lastError ? ` · last error ${status.servers.lastError}` : ""}
          </span>
        ) : "…"}
      </div>

      <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6 }}>
        <b>Ban telemetry</b>{" "}
        {t ? (
          <>
            <span style={{ color: t.enabled ? "var(--good, #5aa86a)" : "var(--muted, #999)" }}>{t.enabled ? "on" : "off"}</span>
            <p style={{ color: "var(--muted, #999)", fontSize: 12, margin: "6px 0", maxWidth: 640 }}>
              Off by default. When on, each suspension the node sees is reported to the hub: a salted hash in place of the email (the salt never leaves
              this machine), when it was suspended, what it was last doing, how many items it held, seasonality, and the node and Realm versions. Nothing
              else. The hub joins reports across nodes so a ban wave shows while it is starting.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} placeholder="https://hub…" style={{ width: 260 }} />
              <button disabled={busy} onClick={() => void act({ action: "telemetry", enabled: !t.enabled, hubUrl })}>{t.enabled ? "Turn off" : "Turn on"}</button>
              <button disabled={busy || !t.enabled} onClick={() => void act({ action: "flush" })}>Send now</button>
              <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>queued {t.queued} · sent {t.sent} · last sent {when(t.lastFlushAt)}{t.lastError ? ` · ${t.lastError}` : ""}</span>
            </div>
          </>
        ) : "…"}
      </div>
    </section>
  );
}
