import { useCallback, useEffect, useState } from "react";
import { devHeaders } from "./devHeaders";
import { Slot, ago } from "./TradeBits";
import type { CommunismAccountView } from "./Vault";

// Communism across the hub (design doc §6.3), beside this node's own
// communism view. What other nodes' communism accounts hold is free to take:
// "take" here has one of THIS node's pool accounts meet the holder's account
// and receive the item, nothing going back. Hand-overs this node is part of
// are listed below. The node's own communism accounts are shown for the
// operator's orientation; they are flagged under Control panel → Accounts.

type Listing = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number; seasonal: boolean; botIgn: string; nodeId: string; node: string; contributor: string; mine: boolean; listedAt: number };
type NodeRoom = { nodeId: string; name: string; owner: string; online: boolean; server: string | null; seasonal: { accounts: number; slots: number; free: number }; nonseasonal: { accounts: number; slots: number; free: number }; items: number };
type Meeting = { rendezvousId: number; kind: "take" | "give"; nodeId: string; itemIds: string[]; names: string[]; botGuid: string; botIgn: string; server: string; createdAt: number; state: string | null; requestId: number | null };
type Status = { linked: boolean; meetings: Meeting[]; lastPublishAt: number | null; lastError: string | null; receiveServer?: { server: string; why: string }; requests: { recent: { id: number; kind: string; requester: string; ok: boolean; detail: string; at: number }[] } | null };


export default function CommunismPanel({ seasonal, accounts, onChanged }: { seasonal: boolean; accounts: CommunismAccountView[]; onChanged: () => void }) {
  const [section, setSection] = useState<"board" | "meetings" | "requests">("board");
  const [listings, setListings] = useState<Listing[]>([]);
  const [nodes, setNodes] = useState<NodeRoom[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const st = await fetch("/api/dev/communism?view=status", { headers: devHeaders(), cache: "no-store" });
      const stb = await st.json();
      if (!st.ok) throw new Error(stb.error || `HTTP ${st.status}`);
      setStatus(stb);
      if (stb.linked) {
        const r = await fetch(`/api/dev/communism?view=browse&seasonal=${seasonal ? 1 : 0}`, { headers: devHeaders(), cache: "no-store" });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        setListings(b.items);
        setNodes(b.nodes ?? []);
      }
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [seasonal]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => { clearInterval(id); clearInterval(t); };
  }, [load]);

  async function post(body: Record<string, unknown>, url = "/api/dev/communism"): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(url, { method: "POST", headers: devHeaders(true), body: JSON.stringify(body) });
      const b = await r.json();
      if (!r.ok) {
        setError(b.error || `HTTP ${r.status}`);
        return null;
      }
      return b;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function take(l: Listing) {
    if (!confirm(`Take ${l.name} from ${l.node}?\n\nTheir account ${l.botIgn} hands it to one of your ${l.seasonal ? "seasonal" : "non-seasonal"} pool accounts on a server at 0% load${status?.receiveServer ? ` (${status.receiveServer.server} right now)` : ""}. Nothing goes back.`)) return;
    const b = await post({ action: "take", nodeId: l.nodeId, ref: l.ref, itemId: l.itemId, seasonal: l.seasonal });
    if (b) {
      setNotice(`Meeting #${(b.rendezvous as { id: number }).id}: ${b.botIgn} receives ${l.name} from ${l.botIgn} on ${(b.rendezvous as { server: string }).server}.`);
      onChanged();
      await load();
      setSection("meetings");
    }
  }

  async function abort(m: Meeting) {
    if (!confirm(`Give up meeting #${m.rendezvousId}?\n\nYour bot's job is cancelled and the hub reopens the item.`)) return;
    const b = await post({ action: "abort", rendezvousId: m.rendezvousId }, "/api/dev/offers");
    if (b) setNotice(`Meeting #${m.rendezvousId} aborted.`);
    await load();
  }

  const stateLabel = (m: Meeting) => {
    if (m.state === "done") return { text: m.kind === "take" ? "received" : "handed over", cls: "ok" };
    if (m.state === "meet") return { text: `meeting on ${m.server}`, cls: "" };
    if (m.state === "receipt-pending") return { text: "traded, sending receipt", cls: "warn" };
    return { text: m.state ?? "queued", cls: m.state === "disputed" ? "bad" : "" };
  };
  const open = status?.meetings.filter((m) => m.state === "meet" || m.state === "receipt-pending").length ?? 0;
  const mine = accounts.filter((a) => a.seasonal === seasonal);
  const others = listings.filter((l) => !l.mine);
  const recent = status?.requests?.recent ?? [];

  return (
    <div className="trade-desk">
      {status && !status.linked && <p className="hint" style={{ color: "var(--warn, #d2a24c)" }}>Communism across the hub needs the hub. Link this node from Control panel → Overview; your own communism accounts work without it.</p>}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p className="hint" style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}

      <p className="hint">
        {mine.length === 0
          ? `No ${seasonal ? "seasonal" : "non-seasonal"} account of yours is in communism. Tick "communism" on one under Control panel → Accounts; its slots and everything on it become communism, and you can untick it any time to take them back.`
          : `Your ${seasonal ? "seasonal" : "non-seasonal"} communism accounts: ${mine.map((a) => `${a.ign || a.botGuid.slice(0, 8)} (${a.used}/${a.slots}${a.online ? ", online" : ""})`).join(", ")}. Anyone on the hub can deposit into them and take from them; untick an account under Control panel → Accounts to take it back.`}
      </p>

      <div className="pool-tabs" style={{ marginTop: 12 }}>
        {(["board", "meetings", "requests"] as const).map((s) => (
          <button key={s} className={"nav-link" + (section === s ? " active" : "")} onClick={() => setSection(s)}>
            {s === "board" ? "Other nodes" : s === "meetings" ? "Hand-overs" : "Hub requests"}
            {s === "meetings" && open ? <span className="tab-badge">{open}</span> : null}
          </button>
        ))}
        <button className="nav-link" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void load()}>refresh</button>
      </div>

      {section === "board" && (
        <>
          <div className="trade-compose-foot" style={{ marginTop: 0 }}>
            <span className="hint" title="A take meets on a random server Realm reports at 0% load, as read in the last ten minutes; with none at zero, the least loaded.">receives on a quiet server{status?.receiveServer ? `: ${status.receiveServer.server} right now (${status.receiveServer.why})` : ""}</span>
            {nodes.length > 0 && <span className="hint">{nodes.filter((n) => n.online).length} node{nodes.filter((n) => n.online).length === 1 ? "" : "s"} with a communism online</span>}
          </div>
          {others.length === 0 ? <p className="hint">Nothing in other nodes&apos; {seasonal ? "seasonal" : "non-seasonal"} communism right now.</p> : (
            <div className="communism-grid">
              {others.map((l) => (
                <article key={`${l.nodeId}/${l.ref}`} className="communism-card">
                  <Slot name={l.name} count={l.count} title={l.name} />
                  <div className="communism-card-body">
                    <b>{l.name}</b>
                    <span className="muted">{l.node}{l.contributor ? ` (${l.contributor})` : ""}{l.botIgn ? ` · ${l.botIgn}` : ""} · {ago(l.listedAt)}</span>
                  </div>
                  <button className="tx-submit" disabled={busy} onClick={() => void take(l)}>Take</button>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {section === "meetings" && (status?.meetings.length ? (
        <div className="trade-cards">
          {status.meetings.map((m) => {
            const st = stateLabel(m);
            return (
              <article key={m.rendezvousId} className="trade-card">
                <header className="trade-card-head">
                  <b>{m.kind === "take" ? "take" : "give"} #{m.rendezvousId}</b>
                  <span className="muted">· {m.botIgn || "your bot"} {m.kind === "take" ? "receives" : "gives"} on {m.server}{m.requestId !== null ? ` · job #${m.requestId}` : ""} · {ago(m.createdAt)}</span>
                  <span className={"trade-state " + st.cls}>{st.text}</span>
                </header>
                {m.names.map((n, i) => <span key={i} className="trade-slots inline"><Slot name={n} title={n} /></span>)} {m.names.join(", ")}
                {m.state === "meet" && <footer className="trade-card-foot"><button className="nav-link" disabled={busy} onClick={() => void abort(m)}>give up this meeting</button></footer>}
              </article>
            );
          })}
        </div>
      ) : <p className="hint">No node-to-node hand-overs yet. Take something from another node above, or give from the hub website.</p>)}

      {section === "requests" && (recent.length ? (
        <div className="trade-cards">
          {recent.map((r) => (
            <article key={r.id} className="trade-card">
              <header className="trade-card-head">
                <b>{r.kind} #{r.id}</b>
                <span className="muted">· {r.requester} · {ago(r.at)}</span>
                <span className={"trade-state " + (r.ok ? "ok" : "bad")}>{r.ok ? "queued" : "refused"}</span>
              </header>
              <span className="muted">{r.detail}</span>
            </article>
          ))}
        </div>
      ) : <p className="hint">Nobody on the hub has asked this node for anything yet. Deposits and withdraws people queue on the hub website show up here, and their trades in the pool&apos;s activity.</p>)}
    </div>
  );
}
