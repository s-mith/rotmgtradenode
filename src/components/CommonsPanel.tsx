import { useCallback, useEffect, useState } from "react";
import type { PoolInstance } from "@/lib/poolWire";
import { WITHDRAW_SERVERS } from "@/lib/servers";
import { Slot, Slots, ago } from "./TradeBits";

// The commons (design doc §6.3) as a bookmark on the vault page. No points:
// what other nodes put in is free to take, a few a day. The pool grid on the
// left is the picker for what this node puts in; items stay on its accounts
// until somebody takes one, and nothing comes back.

type Listing = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number; seasonal: boolean; botIgn: string; nodeId: string; contributor: string; mine: boolean; listedAt: number };
type HubStatus = { dailyCap: number; usedToday: number; listed: number } | null;
type Contributed = { instanceId: string; itemId: string; name: string; enchants: number[]; seasonal: boolean; botGuid: string; botIgn: string; contributedAt: number; listed: boolean; why: string | null };
type Withdraw = { rendezvousId: number; nodeId: string; ref: string; itemId: string; name: string; botGuid: string; botIgn: string; server: string; createdAt: number; state: string | null; requestId: number | null };
type Status = { linked: boolean; items: Contributed[]; withdraws: Withdraw[]; lastPublishAt: number | null; lastError: string | null; hub: HubStatus };

const HEADERS = { "Content-Type": "application/json" };

export default function CommonsPanel({ tray, onRemove, onClear, seasonal, onChanged, maxTray }: {
  tray: (PoolInstance | null)[];
  onRemove: (index: number) => void;
  onClear: () => void;
  seasonal: boolean;
  onChanged: () => void;
  maxTray: number;
}) {
  const [section, setSection] = useState<"available" | "mine" | "handovers">("available");
  const [listings, setListings] = useState<Listing[]>([]);
  const [hub, setHub] = useState<HubStatus>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState(WITHDRAW_SERVERS.includes("USSouth3") ? "USSouth3" : WITHDRAW_SERVERS[0] ?? "USSouth3");
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const st = await fetch("/api/dev/commons?view=status", { cache: "no-store" });
      const stb = await st.json();
      if (!st.ok) throw new Error(stb.error || `HTTP ${st.status}`);
      setStatus(stb);
      if (stb.linked) {
        const r = await fetch(`/api/dev/commons?view=browse&seasonal=${seasonal ? 1 : 0}`, { cache: "no-store" });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        setListings(b.items);
        setHub(b.status);
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

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/dev/commons", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
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

  const items = tray.filter((t): t is PoolInstance => !!t);

  async function contribute() {
    const b = await post({ action: "contribute", instanceIds: items.map((i) => i.instanceId) });
    if (b) {
      setNotice(`${b.added} item${b.added === 1 ? "" : "s"} put in the commons. They stay on your accounts until someone takes them.`);
      onClear();
      onChanged();
      await load();
      setSection("mine");
    }
  }
  async function uncontribute(instanceId: string) {
    const b = await post({ action: "uncontribute", instanceIds: [instanceId] });
    if (b) await load();
  }
  async function take(l: Listing) {
    if (!confirm(`Take ${l.name} from ${l.contributor}?\n\nTheir bot ${l.botIgn} hands it to one of your ${l.seasonal ? "seasonal" : "non-seasonal"} accounts on ${server}. Nothing goes back.`)) return;
    const b = await post({ action: "withdraw", nodeId: l.nodeId, ref: l.ref, itemId: l.itemId, seasonal: l.seasonal, server });
    if (b) {
      setNotice(`Meeting #${(b.rendezvous as { id: number }).id}: ${b.botIgn} receives ${l.name} from ${l.botIgn} on ${server}.`);
      await load();
      setSection("handovers");
    }
  }

  const stateLabel = (w: Withdraw) => {
    if (w.state === "done") return { text: "received", cls: "ok" };
    if (w.state === "meet") return { text: `meeting on ${w.server}`, cls: "" };
    if (w.state === "receipt-pending") return { text: "traded, sending receipt", cls: "warn" };
    return { text: w.state ?? "queued", cls: w.state === "disputed" ? "bad" : "" };
  };
  const capLeft = hub ? Math.max(0, hub.dailyCap - hub.usedToday) : null;
  const open = status?.withdraws.filter((w) => w.state === "meet" || w.state === "receipt-pending").length ?? 0;

  return (
    <div className="trade-desk">
      {status && !status.linked && <p className="hint" style={{ color: "var(--warn, #d2a24c)" }}>The commons needs the hub. Link this node under Control panel → Fleet → Node.</p>}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p className="hint" style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}

      {/* ---- put in ---- */}
      <section className="trade-compose">
        <div className="trade-side-title">Put in the commons <span className="muted">{items.length}/{maxTray}{items.length ? "" : ` · click items in the ${seasonal ? "seasonal" : "non-seasonal"} pool`}</span></div>
        <Slots min={12} count={items.length}>
          {items.map((it) => <Slot key={it.instanceId} name={it.itemName} sprite={it.sprite} count={it.enchantments.length} title={`${it.itemName}${it.enchantments.length ? ` · ${it.enchantments.map((e) => e.name ?? e.id).join(", ")}` : ""} · on ${it.botIgn}`} onRemove={() => onRemove(tray.indexOf(it))} />)}
        </Slots>
        <p className="hint" style={{ marginTop: 8 }}>Free for anyone on the hub to take, a few a day each. The items stay on your accounts; when someone takes one, your bot hands it over and nothing comes back.</p>
        <div className="trade-compose-foot">
          {items.length > 0 && <button className="nav-link" type="button" onClick={onClear}>clear</button>}
          <button className="tx-submit" disabled={!items.length || busy || !status?.linked} onClick={() => void contribute()}>Put in {items.length || ""}</button>
          {status?.lastError && <span className="hint" style={{ color: "var(--bad)" }}>{status.lastError}</span>}
        </div>
      </section>

      {/* ---- lists ---- */}
      <div className="pool-tabs" style={{ marginTop: 16 }}>
        {(["available", "mine", "handovers"] as const).map((s) => (
          <button key={s} className={"nav-link" + (section === s ? " active" : "")} onClick={() => setSection(s)}>
            {s === "available" ? "Available" : s === "mine" ? "My contributions" : "Hand-overs"}
            {s === "mine" && status?.items.length ? <span className="tab-badge">{status.items.length}</span> : null}
            {s === "handovers" && open ? <span className="tab-badge">{open}</span> : null}
          </button>
        ))}
        <button className="nav-link" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void load()}>refresh</button>
      </div>

      {section === "available" && (
        <>
          <div className="trade-compose-foot" style={{ marginTop: 0 }}>
            <label>receive on <select value={server} onChange={(e) => setServer(e.target.value)}>{WITHDRAW_SERVERS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            {hub && <span className="hint">{capLeft} of {hub.dailyCap} left today</span>}
          </div>
          {listings.length === 0 ? <p className="hint">Nothing in the {seasonal ? "seasonal" : "non-seasonal"} commons right now.</p> : (
            <div className="commons-grid">
              {listings.map((l) => (
                <article key={`${l.nodeId}/${l.ref}`} className={"commons-card" + (l.mine ? " mine" : "")}>
                  <Slot name={l.name} count={l.count} title={l.name} />
                  <div className="commons-card-body">
                    <b>{l.name}</b>
                    <span className="muted">{l.mine ? "yours" : `from ${l.contributor}`} · {l.botIgn} · {ago(l.listedAt)}</span>
                  </div>
                  {!l.mine && <button className="tx-submit" disabled={busy || capLeft === 0} onClick={() => void take(l)}>Take</button>}
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {section === "mine" && (status?.items.length ? (
        <div className="commons-grid">
          {status.items.map((c) => (
            <article key={c.instanceId} className="commons-card">
              <Slot name={c.name} count={c.enchants.length} title={c.name} />
              <div className="commons-card-body">
                <b>{c.name}</b>
                <span className="muted">on {c.botIgn || "an unnamed account"} · {c.seasonal ? "seasonal" : "non-seasonal"} · {ago(c.contributedAt)}</span>
                {!c.listed && <span className="hint" style={{ color: "var(--warn, #d2a24c)" }}>not listed: {c.why}</span>}
              </div>
              <button className="nav-link" disabled={busy || c.why === "hand-over in progress"} onClick={() => void uncontribute(c.instanceId)}>take back</button>
            </article>
          ))}
        </div>
      ) : <p className="hint">You have nothing in the commons. Click items in the pool and put them in.</p>)}

      {section === "handovers" && (status?.withdraws.length ? (
        <div className="trade-cards">
          {status.withdraws.map((w) => {
            const st = stateLabel(w);
            return (
              <article key={w.rendezvousId} className="trade-card">
                <header className="trade-card-head">
                  <b>hand-over #{w.rendezvousId}</b>
                  <span className="muted">· {w.botIgn || "your bot"} receives on {w.server}{w.requestId !== null ? ` · job #${w.requestId}` : ""} · {ago(w.createdAt)}</span>
                  <span className={"trade-state " + st.cls}>{st.text}</span>
                </header>
                <span className="trade-slots inline"><Slot name={w.name} title={w.name} /></span> {w.name}
              </article>
            );
          })}
        </div>
      ) : <p className="hint">Nothing taken yet.</p>)}
    </div>
  );
}
