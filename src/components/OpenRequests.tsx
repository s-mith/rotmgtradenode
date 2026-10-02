import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveUpdates } from "@/lib/useLive";
import { TradeStepperBox, type TradeStep } from "./TradeStepper";

// Every open deposit and withdraw of the logged-in character, from the
// server, so a request stays visible (and cancellable) after a reload, a tab
// switch, or a second browser. The live stream announces every change to
// these groups; a slow poll is the safety net for a dropped stream.
type OpenRequest = {
  groupId: string;
  kind: "deposit" | "withdraw";
  server: string;
  communism: boolean;
  seasonal: boolean;
  createdAt: number;
  itemCount: number;
  items: { itemId: string; itemName: string; qty: number }[];
  groupStatus: "in-flight" | "fulfilled" | "partial" | "cancelled";
  tradeCount: number;
  trades: TradeStep[];
  endReason: string | null;
};

const POLL_MS = 20_000;

export default function OpenRequests({
  ign,
  refreshKey,
  onChanged,
}: {
  ign: string | null;
  /** Bumped by the page when a trade of ours changed something. */
  refreshKey: number;
  /** A request was cancelled here: the pool and feeds may have moved. */
  onChanged: () => void;
}) {
  const [requests, setRequests] = useState<OpenRequest[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ign) {
      setRequests([]);
      return;
    }
    try {
      const r = await fetch("/api/requests/mine", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setErr(null);
      setRequests(d.requests ?? []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [ign]);

  useEffect(() => {
    void load();
    // The poll is a safety net behind the live request events; a hidden tab
    // skips it and catches up when it is looked at again.
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, refreshKey]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useLiveUpdates({ onRequest: () => void loadRef.current(), groups: requests.map((r) => r.groupId) });

  async function cancel(groupId: string) {
    setCancelling(groupId);
    try {
      const r = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error ?? `HTTP ${r.status}`);
      else setErr(null);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCancelling(null);
    }
  }

  if (!ign || (!requests.length && !err)) return null;
  const rel = (ts: number) => {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  };
  return (
    <div className="panel">
      <h2>In Flight</h2>
      {err && <p className="login-err">{err}</p>}
      <ul className="inflight-list">
        {requests.map((r) => (
          <li key={r.groupId} className="inflight-item">
            <div className="inflight-head">
              <span className="inflight-title">
                <strong>{r.communism ? "Communism " : ""}{r.kind === "deposit" ? "deposit" : "withdraw"}</strong>
                {" "}· {r.server} · {r.seasonal ? "seasonal" : "non-seasonal"}
                <span className="inflight-time"> · {rel(r.createdAt)}</span>
              </span>
              {r.groupStatus === "in-flight" && (
                <button
                  type="button"
                  className="login-char-btn login-char-btn-danger"
                  disabled={cancelling === r.groupId}
                  onClick={() => cancel(r.groupId)}
                >
                  {cancelling === r.groupId ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </div>
            {r.kind === "withdraw" && r.items.length > 0 && (
              <div className="inflight-items">
                {r.items.map((it) => `${it.qty > 1 ? `${it.qty}× ` : ""}${it.itemName}`).join(", ")}
              </div>
            )}
            {r.kind === "deposit" && (
              <div className="inflight-items">{r.itemCount}-slot trade</div>
            )}
            <TradeStepperBox
              kind={r.kind}
              trades={r.trades}
              tradeCount={r.tradeCount}
              status={r.groupStatus === "in-flight" ? "polling" : r.groupStatus}
              endReason={r.endReason}
              communism={r.communism}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
