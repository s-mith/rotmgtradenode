import { useCallback, useEffect, useState } from "react";
import { relTime } from "@/lib/relTime";
import StatusCard from "@/client/shared/StatusCard";
import NodeTab from "./NodeTab";

// The landing tab and the status strip: what is happening now and what
// needs a hand, drawn from /api/dev/overview every 10 s while the panel is
// open. Every number links to the tab that owns it. The node's own controls
// (the Realm build gate and its canary, the hub link, ban telemetry: NodeTab)
// sit at the bottom of this tab since 2026-09-22.

export type Overview = {
  gate: { build: string; known: boolean; held: boolean; reason: string | null };
  hub: { linked: boolean; url: string | null; lastHeartbeatAt: number | null; lastError: string | null; outdated: boolean; frozen: boolean };
  proxies: { listed: number | null; enabled: number; inUse: number; required: boolean };
  servers: { known: number; fetchedAt: number | null; stale: boolean; lastError: string | null };
  accounts: { total: number; online: number; suspended: number; attention: { alias: string; ign: string; message: string; at: number }[]; communism: number };
  requests: { deposits: number; withdraws: number; claimed: number };
  meetings: { open: number };
  communism: { accounts: number; items: number; free: { seasonal: number; nonseasonal: number }; hubRequests: number; lastError: string | null };
  attention: { text: string; tab: string }[];
};

export function useOverview(password: string, everyMs = 10_000): { data: Overview | null; error: string | null } {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/overview", { headers: { "x-dev-password": password }, cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d as Overview);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [password]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), everyMs);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, everyMs]);
  return { data, error };
}

/** One line under the category bar: the facts an operator otherwise collects from five tabs. */
export function StatusStrip({ o, go }: { o: Overview | null; go: (tab: string) => void }) {
  if (!o) return <div className="dev-strip" aria-busy="true"><span className="dev-strip-item muted">…</span></div>;
  const dot = (tone: "good" | "bad" | "warn" | "muted") => <span className={`dot ${tone}`} />;
  const gateTone = o.gate.held ? "bad" : o.gate.known ? "good" : "warn";
  const proxTone = o.proxies.required && o.proxies.enabled === 0 ? "bad" : "good";
  return (
    <div className="dev-strip" role="status">
      <button className="dev-strip-item" onClick={() => go("overview")} title={o.gate.reason ?? `Realm build ${o.gate.build}`}>{dot(gateTone)} logins {o.gate.held ? "held" : "open"}</button>
      <button className="dev-strip-item" onClick={() => go("overview")} title={o.hub.lastError ?? (o.hub.lastHeartbeatAt ? `heartbeat ${relTime(o.hub.lastHeartbeatAt)}` : "")}>{dot(o.hub.linked ? (o.hub.lastError ? "warn" : "good") : "muted")} hub {o.hub.linked ? "linked" : "not linked"}</button>
      <button className="dev-strip-item" onClick={() => go("proxies")}>{dot(proxTone)} {o.proxies.enabled} prox{o.proxies.enabled === 1 ? "y" : "ies"}{o.proxies.inUse ? ` · ${o.proxies.inUse} in use` : ""}</button>
      <button className="dev-strip-item" onClick={() => go("accounts")}>{dot(o.accounts.online ? "good" : "muted")} {o.accounts.online}/{o.accounts.total} online{o.accounts.suspended ? <span className="bad"> · {o.accounts.suspended} suspended</span> : null}</button>
      <button className="dev-strip-item" onClick={() => go("deposits")}>{dot(o.requests.deposits + o.requests.withdraws ? "warn" : "muted")} {o.requests.deposits} dep · {o.requests.withdraws} wd{o.requests.claimed ? ` · ${o.requests.claimed} trading` : ""}</button>
      <button className="dev-strip-item" onClick={() => go("overview")}>{dot(o.meetings.open ? "warn" : "muted")} {o.meetings.open} meeting{o.meetings.open === 1 ? "" : "s"}</button>
      <button className="dev-strip-item" onClick={() => go("accounts")}>{dot(o.communism.accounts ? "good" : "muted")} communism {o.communism.accounts} acct · {o.communism.items} items</button>
      {o.attention.length > 0 && <button className="dev-strip-item attention" onClick={() => go("overview")}>{o.attention.length} need{o.attention.length === 1 ? "s" : ""} attention</button>}
    </div>
  );
}

export default function OverviewTab({ password, go }: { password: string; go: (tab: string) => void }) {
  const { data: o, error } = useOverview(password, 5_000);
  if (error && !o) return <p style={{ color: "var(--bad)" }}>{error}</p>;
  if (!o) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  const Fact = ({ label, value, tab, tone }: { label: string; value: React.ReactNode; tab: string; tone?: "good" | "bad" | "warn" }) => (
    <button className={"dev-fact" + (tone ? ` ${tone}` : "")} onClick={() => go(tab)}>
      <b>{value}</b>
      <span>{label}</span>
    </button>
  );
  return (
    <div className="dev-overview">
      {/* The status card says what the node is doing and lists what needs a hand (the attention items among them), each with its fix. */}
      <StatusCard go={go} />
      <div className="dev-facts">
        <Fact label={`proxies enabled${o.proxies.required ? " · proxy only" : ""}`} value={o.proxies.enabled} tab="proxies" tone={o.proxies.required && !o.proxies.enabled ? "bad" : undefined} />
        <Fact label={`servers · refreshed ${relTime(o.servers.fetchedAt, "never")}${o.servers.stale ? " · stale" : ""}${o.servers.lastError ? " · error" : ""}`} value={o.servers.known} tab="servercontrols" tone={o.servers.lastError ? "warn" : undefined} />
        <Fact label={`of ${o.accounts.total} accounts online`} value={o.accounts.online} tab="accounts" />
        <Fact label="suspended" value={o.accounts.suspended} tab="accounts" tone={o.accounts.suspended ? "warn" : undefined} />
        <Fact label="deposits waiting" value={o.requests.deposits} tab="deposits" />
        <Fact label="withdraws waiting" value={o.requests.withdraws} tab="deposits" />
        <Fact label="meetings under way" value={o.meetings.open} tab="overview" />
        <Fact label={`communism accounts · ${o.communism.items} items`} value={o.communism.accounts} tab="accounts" />
        <Fact label="communism slots free (s / ns)" value={`${o.communism.free.seasonal} / ${o.communism.free.nonseasonal}`} tab="accounts" />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>Refreshes every few seconds. Click a number for its tab.</p>
      <NodeTab password={password} />
    </div>
  );
}
