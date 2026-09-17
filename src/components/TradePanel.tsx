import { useCallback, useEffect, useState } from "react";
import type { PoolInstance } from "@/lib/poolWire";
import { WITHDRAW_SERVERS } from "@/lib/servers";

// Trades (design doc §6.2), as a bookmark on the vault page. The pool grid
// on the left is the picker: clicking an item puts it in the offer tray
// here. Below the composer: open offers to accept, your own offers, and the
// meetings the hub has scheduled.

type OfferItem = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number };
type WantLine = { itemId: string; name: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: unknown[] };
export type Offer = { id: number; poster: string; mine: boolean; botIgn: string; seasonal: boolean; server: string; give: OfferItem[]; want: WantLine[]; status: string; createdAt: number; expiresAt: number };
type Limits = { maxOpenOffers: number; maxItemsPerSide: number; completedSwaps: number; frozen: boolean } | null;
type Rendezvous = { id: number; offerId: number; server: string; state: string; deadlineAt: number; me: { role: string; botIgn: string; gives: OfferItem[]; gets: { itemId: string; qty: number }[] }; partner: { botIgn: string; poster: string }; reported: { mine: boolean; partner: boolean }; requestId: number | null; localState: string | null };
type Status = { linked: boolean; lastPollAt: number | null; lastError: string | null; rendezvous: Rendezvous[] };

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const list = (items: { name?: string; itemId: string; qty?: number; count?: number }[]) => items.map((i) => `${i.qty && i.qty > 1 ? `${i.qty}× ` : ""}${i.name ?? i.itemId}${i.count ? ` (${i.count})` : ""}`).join(", ");
const HEADERS = { "Content-Type": "application/json" };

export default function TradePanel({ tray, onRemove, onClear, seasonal, onPosted, maxTray }: {
  tray: (PoolInstance | null)[];
  onRemove: (index: number) => void;
  onClear: () => void;
  seasonal: boolean;
  onPosted: () => void;
  maxTray: number;
}) {
  const [section, setSection] = useState<"open" | "mine" | "meetings">("open");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [limits, setLimits] = useState<Limits>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [want, setWant] = useState<{ itemId: string; qty: string; slotsMin: string; slotsExact: string }[]>([{ itemId: "", qty: "1", slotsMin: "", slotsExact: "" }]);
  const [server, setServer] = useState(WITHDRAW_SERVERS.includes("USSouth3") ? "USSouth3" : WITHDRAW_SERVERS[0] ?? "USSouth3");
  const [previews, setPreviews] = useState<Record<number, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    try {
      const st = await fetch("/api/dev/offers?view=status", { cache: "no-store" });
      const stb = await st.json();
      if (!st.ok) throw new Error(stb.error || `HTTP ${st.status}`);
      setStatus(stb);
      if (section !== "meetings") {
        const r = await fetch(`/api/dev/offers?view=${section === "open" ? "browse" : "mine"}`, { cache: "no-store" });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        setOffers(b.offers);
        setLimits(b.limits);
      }
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [section]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/dev/offers", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
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
  const bots = new Set(items.map((i) => i.botGuid));
  const canPost = items.length > 0 && bots.size === 1 && want.some((w) => w.itemId) && !!server && !busy;

  async function create() {
    const b = await post({ action: "create", instanceIds: items.map((i) => i.instanceId), want: want.filter((w) => w.itemId).map((w) => ({ itemId: w.itemId.trim(), qty: Number(w.qty) || 1, slotsMin: w.slotsMin, slotsExact: w.slotsExact })), server });
    if (b) {
      setNotice(`Offer #${(b.offer as Offer).id} posted. Your bot will meet the taker on ${server}.`);
      onClear();
      onPosted();
      setSection("mine");
    }
  }
  async function preview(o: Offer) {
    const b = await post({ action: "preview", offer: o });
    if (!b) return;
    setPreviews((p) => ({ ...p, [o.id]: b.ok ? { ok: true, text: `You would give: ${list(b.picks as { itemId: string; name?: string }[])}` } : { ok: false, text: String(b.error) } }));
  }
  async function accept(o: Offer) {
    if (!confirm(`Accept offer #${o.id}? Your bot meets ${o.botIgn} on ${o.server} and swaps your items for: ${list(o.give)}.`)) return;
    const b = await post({ action: "accept", offer: o });
    if (b) {
      setNotice(`Accepted. Meeting #${(b.rendezvous as Rendezvous).id} on ${o.server}.`);
      setSection("meetings");
    }
  }

  return (
    <div className="trade-panel">
      {status && !status.linked && <p className="hint" style={{ color: "var(--warn, #d2a24c)" }}>Trades need the hub. Link this node under Control panel → Fleet → Node.</p>}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p className="hint" style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}

      <div className="trade-compose">
        <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>You give <span className="muted" style={{ color: "var(--muted)", fontWeight: 400 }}>({items.length}/{maxTray}, click items in the {seasonal ? "seasonal" : "non-seasonal"} pool)</span></h3>
        {items.length === 0 ? (
          <p className="hint">Nothing picked yet.</p>
        ) : (
          <ul className="trade-tray">
            {items.map((it, i) => (
              <li key={it.instanceId}>
                {it.sprite && <img src={it.sprite} alt="" className="pool-tile-sprite" style={{ width: 20, height: 20 }} />}
                <span>{it.itemName}{it.enchantments.length ? ` (${it.enchantments.length})` : ""}</span>
                <span className="muted" style={{ color: "var(--muted)", fontSize: 11 }}>{it.botIgn}</span>
                <button className="nav-link" onClick={() => onRemove(tray.indexOf(it))}>×</button>
              </li>
            ))}
          </ul>
        )}
        {bots.size > 1 && <p className="hint" style={{ color: "var(--bad)" }}>All items of one offer must sit on the same account. Remove the ones from another bot.</p>}
        <h3 style={{ fontSize: 13, margin: "10px 0 6px" }}>You want</h3>
        {want.map((w, i) => (
          <div key={i} style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
            <input value={w.itemId} placeholder="item id (e.g. pdef)" style={{ width: 120 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))} />
            <input value={w.qty} type="number" min={1} max={24} style={{ width: 50 }} title="quantity" onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <input value={w.slotsMin} placeholder="min ench" style={{ width: 66 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, slotsMin: e.target.value } : x)))} />
            <input value={w.slotsExact} placeholder="exact" style={{ width: 52 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, slotsExact: e.target.value } : x)))} />
            {want.length > 1 && <button className="nav-link" onClick={() => setWant((ws) => ws.filter((_, j) => j !== i))}>×</button>}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <button className="nav-link" disabled={want.length >= 8} onClick={() => setWant((ws) => [...ws, { itemId: "", qty: "1", slotsMin: "", slotsExact: "" }])}>+ line</button>
          <label style={{ fontSize: 12 }}>meet on <select value={server} onChange={(e) => setServer(e.target.value)}>{WITHDRAW_SERVERS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          {items.length > 0 && <button className="nav-link" onClick={onClear}>clear</button>}
          <button className="tx-submit" disabled={!canPost} onClick={() => void create()}>Post offer</button>
        </div>
        {limits && <p className="hint" style={{ marginTop: 6 }}>{limits.frozen ? "This node is frozen after a disputed swap." : `${limits.maxOpenOffers} open offer(s), ${limits.maxItemsPerSide} items per side · ${limits.completedSwaps} completed`}</p>}
      </div>

      <div className="pool-tabs" style={{ marginTop: 14 }}>
        {(["open", "mine", "meetings"] as const).map((s) => (
          <button key={s} className={"nav-link" + (section === s ? " active" : "")} onClick={() => setSection(s)}>{s === "open" ? "Open offers" : s === "mine" ? "My offers" : "Meetings"}</button>
        ))}
        <button className="nav-link" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void load()}>refresh</button>
      </div>

      {section !== "meetings" && (offers.length === 0 ? <p className="hint">{section === "open" ? "No open offers right now." : "You have no offers."}</p> : (
        <div style={{ display: "grid", gap: 8 }}>
          {offers.map((o) => (
            <div key={o.id} className="trade-offer">
              <div style={{ fontSize: 12, color: "var(--muted)" }}>#{o.id} · {o.mine ? "yours" : o.poster} · {o.seasonal ? "seasonal" : "non-seasonal"} · {o.server} · {o.status}</div>
              <div><b>Gives</b> {list(o.give)}</div>
              <div><b>Wants</b> {list(o.want)}</div>
              {!o.mine && o.status === "open" && (
                <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button className="nav-link" disabled={busy} onClick={() => void preview(o)}>what would I give?</button>
                  {previews[o.id] && <span style={{ fontSize: 12, color: previews[o.id].ok ? "var(--good, #5aa86a)" : "var(--bad)" }}>{previews[o.id].text}</span>}
                  {previews[o.id]?.ok && <button className="nav-link" style={{ color: "var(--accent-hot)" }} disabled={busy} onClick={() => void accept(o)}>accept</button>}
                </div>
              )}
              {o.mine && o.status === "open" && <button className="nav-link" disabled={busy} onClick={() => void post({ action: "cancel", offerId: o.id }).then(() => load())}>cancel</button>}
            </div>
          ))}
        </div>
      ))}
      {section === "meetings" && status && (status.rendezvous.length === 0 ? <p className="hint">No meetings. Polled {when(status.lastPollAt)}.</p> : (
        <div style={{ display: "grid", gap: 8 }}>
          {status.rendezvous.map((r) => (
            <div key={r.id} className="trade-offer">
              <div style={{ fontSize: 12, color: "var(--muted)" }}>meeting #{r.id} · offer #{r.offerId} · {r.server} · {r.state}{r.localState ? ` · ${r.localState}` : ""} · until {when(r.deadlineAt)}</div>
              <div>{r.me.botIgn} ({r.me.role}) ↔ {r.partner.botIgn} ({r.partner.poster})</div>
              <div><b>I give</b> {list(r.me.gives)} · <b>I get</b> {list(r.me.gets)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
