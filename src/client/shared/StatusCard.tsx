import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { call, getStatus, type Fix, type NodeStatus } from "./api";

// What the node is doing, in one sentence, and every problem next to the
// button that fixes it (GET /api/dev/status). It leads the Overview; a node
// too old to answer simply shows nothing here.

const TONE: Record<NodeStatus["state"], "good" | "warn" | "bad"> = { running: "good", ready: "good", paused: "warn", "needs-setup": "warn", problem: "bad" };

export default function StatusCard({ go, everyMs = 5_000 }: { go?: (tab: string) => void; everyMs?: number }) {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const r = await getStatus();
    if (r.ok) {
      setStatus(r.data);
      setMissing(false);
      setError("");
    } else if (r.status === 404) setMissing(true);
    else setError(r.error);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), everyMs);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, everyMs]);

  async function fix(id: string, f: Fix) {
    if (f.kind === "tab") {
      // The setup and help have pages of their own; every other tab is the control panel's.
      if (f.tab === "setup") navigate("/setup");
      else if (go) go(f.tab);
      else navigate(`/control#${f.tab}`);
      return;
    }
    if (f.kind === "link") {
      if (f.href.startsWith("/")) navigate(f.href);
      else window.open(f.href, "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(id);
    setDone(null);
    const r = await call(f.path, { method: "POST", body: f.body ?? {} });
    setBusy(null);
    if (!r.ok) setError(r.error);
    else setDone(id);
    void load();
  }

  if (missing) return null;
  if (!status) return error ? <section className="ui-card status-card bad"><p className="status-sub">{error}</p></section> : null;
  const tone = TONE[status.state] ?? "warn";
  return (
    <section className={`ui-card status-card ${tone}`} aria-live="polite" aria-label="Node status">
      <div className="status-head">
        <span className="status-dot" aria-hidden="true" />
        <p className="status-headline">{status.headline}</p>
      </div>
      {status.sub && <p className="status-sub">{status.sub}</p>}
      {status.problems.length > 0 && (
        <ul className="status-problems">
          {status.problems.map((p) => (
            <li key={p.id} className={p.severity}>
              <span>
                <span className={p.severity === "error" ? "ui-bad" : "ui-warn"} aria-hidden="true">{p.severity === "error" ? "● " : "▲ "}</span>
                {p.text}
                {done === p.id && <span className="ui-ok"> — done</span>}
              </span>
              {p.fix && (
                <button type="button" className="ui-btn small" disabled={busy === p.id} onClick={() => void fix(p.id, p.fix!)}>
                  {busy === p.id ? "…" : p.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="ui-msg bad" role="alert">{error}</p>}
    </section>
  );
}
