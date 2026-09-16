import { useCallback, useEffect, useState } from "react";
import PlayerName from "@/components/PlayerName";

// Who is pulling how much off the API (lib/traffic.ts): every visitor of the
// chosen window, busiest first — a logged-in IGN, or an IP for the
// logged-out — with the routes they hit. The ones far above the typical
// visitor are flagged: a tab that never stops refetching, a script polling
// the pool, an account awake around the clock.

type Route = { route: string; requests: number; bytes: number };
type Visitor = {
  who: string;
  kind: "ign" | "ip";
  id: string;
  requests: number;
  bytes: number;
  activeHours: number;
  firstHour: number;
  lastHour: number;
  share: number;
  routes: Route[];
  unusual: boolean;
  why: string | null;
};
type Report = {
  from: number;
  to: number;
  hours: number;
  total: { requests: number; bytes: number; visitors: number };
  typical: { requests: number; bytes: number };
  visitors: Visitor[];
  rules: { minBytes: number; minRequests: number; factor: number; retentionDays: number };
};

const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" },
  { hours: 6, label: "6 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
const fmtN = (n: number) => n.toLocaleString();
const hourLabel = (ts: number) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontSize: 13 };
const num: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

export default function TrafficTab({ password }: { password: string }) {
  const [hours, setHours] = useState(24);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/dev/traffic?hours=${hours}&limit=100`, { headers: { "x-dev-password": password }, cache: "no-store" });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || `HTTP ${r.status}`);
        return;
      }
      setError("");
      setReport(data as Report);
    } catch (e) {
      setError(String(e));
    }
  }, [password, hours]);

  useEffect(() => {
    void load();
  }, [load]);

  const flagged = report?.visitors.filter((v) => v.unusual) ?? [];

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, marginBottom: 12, maxWidth: 680 }}>
        Bytes the API sent to each visitor — a logged-in character, or an IP address for the logged-out — busiest first, with the routes they hit. Nearly all of the site's egress bill is these bytes. A visitor is flagged when it is at least {report ? `${report.rules.factor}×` : "several times"} the typical visitor and above {report ? fmtBytes(report.rules.minBytes) : "a floor"} or {report ? fmtN(report.rules.minRequests) : "a floor of"} requests. History is kept for {report?.rules.retentionDays ?? 14} days.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        {WINDOWS.map((w) => (
          <button key={w.hours} type="button" className={"nav-link" + (hours === w.hours ? " active" : "")} onClick={() => setHours(w.hours)}>
            {w.label}
          </button>
        ))}
        <span style={{ color: "var(--border)" }}>|</span>
        <button type="button" className="nav-link" onClick={() => void load()}>
          refresh
        </button>
      </div>

      {error && <p style={{ color: "var(--bad)", marginBottom: 12 }}>{error}</p>}

      {report && (
        <div style={{ marginBottom: 14, fontSize: 13 }}>
          <div>
            Last {report.hours === 1 ? "hour" : `${report.hours} hours`}: <strong>{fmtBytes(report.total.bytes)}</strong> in {fmtN(report.total.requests)} request{report.total.requests === 1 ? "" : "s"} to {report.total.visitors} visitor{report.total.visitors === 1 ? "" : "s"}
            {report.total.visitors > 0 && (
              <span style={{ color: "var(--muted, #999)" }}>
                {" "}· typical visitor {fmtBytes(report.typical.bytes)} in {fmtN(Math.round(report.typical.requests))} requests
              </span>
            )}
          </div>
          <div style={{ marginTop: 4, color: flagged.length ? "var(--bad)" : "var(--muted, #999)" }}>
            {flagged.length === 0 ? "Nobody stands out." : `${flagged.length} visitor${flagged.length === 1 ? "" : "s"} far above the rest: ${flagged.map((v) => v.id).join(", ")}`}
          </div>
        </div>
      )}

      {report && report.visitors.length > 0 && (
        <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Visitor</th>
                <th style={{ ...th, textAlign: "right" }}>Bytes</th>
                <th style={{ ...th, textAlign: "right" }}>Share</th>
                <th style={{ ...th, textAlign: "right" }}>Requests</th>
                <th style={{ ...th, textAlign: "right" }}>Per hour</th>
                <th style={th}>Active</th>
                <th style={th}>Mostly</th>
              </tr>
            </thead>
            <tbody>
              {report.visitors.map((v) => {
                const top = v.routes[0];
                const showAll = open === v.who;
                return (
                  <tr key={v.who} style={v.unusual ? { background: "rgba(217, 102, 102, 0.12)" } : undefined}>
                    <td style={td}>
                      {v.kind === "ign" ? <PlayerName ign={v.id} readable /> : <code style={{ fontSize: 12 }}>{v.id}</code>}
                      {v.kind === "ip" && <span style={{ color: "var(--muted)", fontSize: 11 }}> · logged out</span>}
                      {v.why && <div style={{ color: "var(--bad)", fontSize: 12, marginTop: 2 }}>{v.why}</div>}
                    </td>
                    <td style={num}>{fmtBytes(v.bytes)}</td>
                    <td style={num}>{(v.share * 100).toFixed(1)}%</td>
                    <td style={num}>{fmtN(v.requests)}</td>
                    <td style={num} title="requests per active hour">
                      {fmtN(Math.round(v.requests / Math.max(1, v.activeHours)))}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--muted)" }} title={`${hourLabel(v.firstHour)} → ${hourLabel(v.lastHour)}`}>
                      {v.activeHours} of {report.hours} h
                    </td>
                    <td style={td}>
                      {top && (
                        <span>
                          <code style={{ fontSize: 12 }}>{top.route}</code> <span style={{ color: "var(--muted)" }}>×{fmtN(top.requests)} · {fmtBytes(top.bytes)}</span>
                        </span>
                      )}
                      {v.routes.length > 1 && (
                        <>
                          {" "}
                          <button type="button" className="nav-link" style={{ fontSize: 12 }} onClick={() => setOpen(showAll ? null : v.who)}>
                            {showAll ? "less" : `+${v.routes.length - 1} more`}
                          </button>
                          {showAll && (
                            <ul style={{ margin: "4px 0 0", paddingLeft: 16, color: "var(--muted)", fontSize: 12 }}>
                              {v.routes.slice(1).map((r) => (
                                <li key={r.route}>
                                  <code>{r.route}</code> ×{fmtN(r.requests)} · {fmtBytes(r.bytes)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {report && report.visitors.length === 0 && <p style={{ color: "var(--muted)" }}>No API traffic recorded in this window yet.</p>}
    </section>
  );
}
