import { useCallback, useEffect, useMemo, useState } from "react";
import type { PoolInstance } from "@/lib/poolWire";
import { WITHDRAW_SERVERS } from "@/lib/servers";
import { ItemSprite } from "./ItemSprite";
import { Slot, Ticket, ago, left } from "./TradeBits";
import { TagSearch, type SearchTag, type Suggestions } from "./TagSearch";

// Trades (design doc §6.2) as a bookmark on the vault page. Every trade is
// drawn the same way, mirroring the in-game window: a row of slots for what
// one side hands over, a swap arrow, a row of slots for what comes back.
// The pool grid on the left is the picker for the "you give" side; the
// "you want" side is picked from the catalog.

type OfferItem = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number };
type WantLine = { itemId: string; name: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: unknown[] };
export type Offer = { id: number; poster: string; mine: boolean; botIgn: string; seasonal: boolean; server: string; give: OfferItem[]; want: WantLine[]; status: string; createdAt: number; expiresAt: number };
type Limits = { maxOpenOffers: number; maxItemsPerSide: number; completedSwaps: number; frozen: boolean } | null;
type Rendezvous = { id: number; kind: "swap" | "commons"; offerId: number | null; server: string; state: string; deadlineAt: number; me: { role: string; botIgn: string; gives: OfferItem[]; gets: { itemId: string; qty: number }[] }; partner: { botIgn: string; poster: string }; reported: { mine: boolean; partner: boolean }; requestId: number | null; localState: string | null };
type Status = { linked: boolean; lastPollAt: number | null; lastError: string | null; rendezvous: Rendezvous[] };
type Pick = { instanceId: string; itemId: string; name: string; enchantIds: number[]; botIgn: string };
type Catalog = { itemId: string; itemName: string }[];

const HEADERS = { "Content-Type": "application/json" };
const NO_SUGGEST: Suggestions = { items: [], enchants: [], effects: [] };
const filterBadge = (w: { slotsMin: number; slotsExact: number | null; enchants?: unknown[] }) =>
  w.slotsExact !== null ? `=${w.slotsExact}` : w.slotsMin > 0 ? `${w.slotsMin}+` : (w.enchants?.length ?? 0) > 0 ? "f" : undefined;

export default function TradePanel({ tray, onRemove, onClear, seasonal, onPosted, maxTray, catalog }: {
  tray: (PoolInstance | null)[];
  onRemove: (index: number) => void;
  onClear: () => void;
  seasonal: boolean;
  onPosted: () => void;
  maxTray: number;
  catalog: Catalog;
}) {
  const [section, setSection] = useState<"open" | "mine" | "meetings">("open");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [limits, setLimits] = useState<Limits>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [want, setWant] = useState<{ itemId: string; name: string; qty: number; slotsMin: number; slotsExact: number | null }[]>([]);
  const [wantTags, setWantTags] = useState<SearchTag[]>([]);
  const [wantText, setWantText] = useState("");
  const [server, setServer] = useState(WITHDRAW_SERVERS.includes("USSouth3") ? "USSouth3" : WITHDRAW_SERVERS[0] ?? "USSouth3");
  const [previews, setPreviews] = useState<Record<number, { ok: boolean; text?: string; picks?: Pick[] }>>({});
  const [, setTick] = useState(0);

  const nameOf = useMemo(() => new Map(catalog.map((c) => [c.itemId, c.itemName])), [catalog]);
  const suggestions = useMemo<Suggestions>(() => ({ items: catalog.map((c) => ({ id: c.itemId, name: c.itemName })), enchants: [], effects: [] }), [catalog]);

  // A picked catalog item becomes a want slot; the search box clears for the next one.
  useEffect(() => {
    const item = wantTags.find((t) => t.kind === "item");
    if (!item || item.kind !== "item") return;
    setWant((w) => (w.some((x) => x.itemId === item.id) ? w.map((x) => (x.itemId === item.id ? { ...x, qty: Math.min(24, x.qty + 1) } : x)) : w.length >= 8 ? w : [...w, { itemId: item.id, name: item.label, qty: 1, slotsMin: 0, slotsExact: null }]));
    setWantTags([]);
    setWantText("");
  }, [wantTags]);

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
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => { clearInterval(id); clearInterval(t); };
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
  const canPost = items.length > 0 && bots.size === 1 && want.length > 0 && !!server && !busy && !(limits?.frozen);

  async function create() {
    const b = await post({ action: "create", instanceIds: items.map((i) => i.instanceId), want: want.map((w) => ({ itemId: w.itemId, qty: w.qty, slotsMin: w.slotsMin || "", slotsExact: w.slotsExact ?? "" })), server });
    if (b) {
      setNotice(`Offer #${(b.offer as Offer).id} posted. Your bot ${items[0].botIgn} will meet the taker on ${server}.`);
      onClear();
      setWant([]);
      onPosted();
      setSection("mine");
    }
  }
  async function preview(o: Offer) {
    const b = await post({ action: "preview", offer: o });
    if (!b) return;
    setPreviews((p) => ({ ...p, [o.id]: b.ok ? { ok: true, picks: b.picks as Pick[] } : { ok: false, text: String(b.error) } }));
  }
  async function accept(o: Offer) {
    const pv = previews[o.id];
    if (!pv?.ok || !pv.picks) return;
    if (!confirm(`Accept offer #${o.id}?\n\nYour bot ${pv.picks[0].botIgn} meets ${o.botIgn} on ${o.server} and hands over ${pv.picks.map((p) => p.name).join(", ")} for ${o.give.map((g) => g.name).join(", ")}.`)) return;
    const b = await post({ action: "accept", offer: o });
    if (b) {
      setNotice(`Accepted. Meeting #${(b.rendezvous as Rendezvous).id} on ${o.server}.`);
      setSection("meetings");
    }
  }

  const stateLabel = (r: Rendezvous) => {
    if (r.state === "done") return { text: "done", cls: "ok" };
    if (r.state === "meet") return r.localState === "receipt-pending" ? { text: "traded, sending receipt", cls: "warn" } : r.reported.mine ? { text: "traded, waiting for the other side's receipt", cls: "warn" } : { text: `meeting on ${r.server} · ${left(r.deadlineAt)}`, cls: "" };
    return { text: r.state, cls: r.state === "disputed" ? "bad" : "" };
  };

  return (
    <div className="trade-desk">
      {status && !status.linked && <p className="hint" style={{ color: "var(--warn, #d2a24c)" }}>Trades need the hub. Link this node under Control panel → Fleet → Node.</p>}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p className="hint" style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}

      {/* ---- composer ---- */}
      <section className="trade-compose">
        <Ticket
          min={12}
          leftTitle={<>You give <span className="muted">{items.length}/{maxTray}{items.length ? ` · from ${items[0].botIgn}` : ` · click items in the ${seasonal ? "seasonal" : "non-seasonal"} pool`}</span></>}
          rightTitle={<>You want <span className="muted">{want.reduce((n, w) => n + w.qty, 0) || "pick from the catalog below"}</span></>}
          left={items.map((it) => <Slot key={it.instanceId} name={it.itemName} sprite={it.sprite} count={it.enchantments.length} title={`${it.itemName}${it.enchantments.length ? ` · ${it.enchantments.map((e) => e.name ?? e.id).join(", ")}` : ""} · on ${it.botIgn}`} onRemove={() => onRemove(tray.indexOf(it))} dim={bots.size > 1 && it.botGuid !== items[0].botGuid} />)}
          right={want.map((w) => <Slot key={w.itemId} name={w.name} qty={w.qty} filter={filterBadge(w)} title={`${w.qty}× ${w.name}${w.slotsExact !== null ? ` with exactly ${w.slotsExact} enchantments` : w.slotsMin ? ` with ${w.slotsMin}+ enchantments` : ""}`} onRemove={() => setWant((ws) => ws.filter((x) => x.itemId !== w.itemId))} />)}
        />
        {bots.size > 1 && <p className="hint" style={{ color: "var(--bad)" }}>One offer trades from one account. The dimmed items sit on another bot; remove them or start from that bot.</p>}
        <div className="trade-want-picker">
          <TagSearch tags={wantTags} onTagsChange={setWantTags} text={wantText} onTextChange={setWantText} suggestions={wantText.length >= 2 ? suggestions : NO_SUGGEST} placeholder="Add a wanted item by name…" />
        </div>
        {want.length > 0 && (
          <table className="trade-want-table">
            <tbody>
              {want.map((w) => (
                <tr key={w.itemId}>
                  <td><ItemSprite name={w.name} size={18} /> {w.name}</td>
                  <td><label>qty <input type="number" min={1} max={24} value={w.qty} onChange={(e) => setWant((ws) => ws.map((x) => (x.itemId === w.itemId ? { ...x, qty: Math.max(1, Math.min(24, Number(e.target.value) || 1)) } : x)))} /></label></td>
                  <td><label>min ench <input type="number" min={0} max={8} value={w.slotsMin} onChange={(e) => setWant((ws) => ws.map((x) => (x.itemId === w.itemId ? { ...x, slotsMin: Math.max(0, Number(e.target.value) || 0) } : x)))} /></label></td>
                  <td><label>exact <input type="number" min={0} max={8} value={w.slotsExact ?? ""} placeholder="any" onChange={(e) => setWant((ws) => ws.map((x) => (x.itemId === w.itemId ? { ...x, slotsExact: e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0) } : x)))} /></label></td>
                  <td><button className="nav-link" type="button" onClick={() => setWant((ws) => ws.filter((x) => x.itemId !== w.itemId))}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="trade-compose-foot">
          <label>meet on <select value={server} onChange={(e) => setServer(e.target.value)}>{WITHDRAW_SERVERS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          {(items.length > 0 || want.length > 0) && <button className="nav-link" type="button" onClick={() => { onClear(); setWant([]); }}>clear</button>}
          <button className="tx-submit" disabled={!canPost} onClick={() => void create()}>Post offer</button>
          {limits && <span className="hint">{limits.frozen ? "frozen after a disputed swap" : `${limits.maxOpenOffers} open · ${limits.maxItemsPerSide} per side · ${limits.completedSwaps} done`}</span>}
        </div>
      </section>

      {/* ---- lists ---- */}
      <div className="pool-tabs" style={{ marginTop: 16 }}>
        {(["open", "mine", "meetings"] as const).map((s) => (
          <button key={s} className={"nav-link" + (section === s ? " active" : "")} onClick={() => setSection(s)}>
            {s === "open" ? "Open offers" : s === "mine" ? "My offers" : "Meetings"}{s === "meetings" && status?.rendezvous.some((r) => r.state === "meet") ? <span className="tab-badge">{status.rendezvous.filter((r) => r.state === "meet").length}</span> : null}
          </button>
        ))}
        <button className="nav-link" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void load()}>refresh</button>
      </div>

      {section !== "meetings" && (offers.length === 0 ? <p className="hint">{section === "open" ? "No open offers right now." : "You have no offers."}</p> : (
        <div className="trade-cards">
          {offers.map((o) => {
            const pv = previews[o.id];
            return (
              <article key={o.id} className={"trade-card" + (o.mine ? " mine" : "")}>
                <header className="trade-card-head">
                  <b>#{o.id}</b>
                  <span>{o.mine ? "your offer" : o.poster}</span>
                  <span className="muted">· {o.botIgn} · {o.seasonal ? "seasonal" : "non-seasonal"} · meets on {o.server} · {ago(o.createdAt)}{o.status !== "open" ? ` · ${o.status}` : ""}</span>
                </header>
                <Ticket
                  leftTitle={o.mine ? "You give" : `${o.poster} gives`}
                  rightTitle={o.mine ? "You want" : "They want"}
                  left={o.give.map((g) => <Slot key={g.ref} name={g.name} count={g.count} title={`${g.name}${g.count ? ` · ${g.count} enchantment${g.count === 1 ? "" : "s"}` : ""}`} />)}
                  right={o.want.map((w, i) => <Slot key={i} name={w.name} qty={w.qty} filter={filterBadge(w)} title={`${w.qty}× ${w.name}${w.slotsExact !== null ? ` with exactly ${w.slotsExact} enchantments` : w.slotsMin ? ` with ${w.slotsMin}+ enchantments` : ""}${(w.enchants?.length ?? 0) ? " · enchantment filter" : ""}`} />)}
                />
                {!o.mine && o.status === "open" && (
                  <footer className="trade-card-foot">
                    {!pv && <button className="nav-link" disabled={busy} onClick={() => void preview(o)}>what would I give?</button>}
                    {pv && !pv.ok && <span className="hint" style={{ color: "var(--bad)" }}>{pv.text}</span>}
                    {pv?.ok && pv.picks && (
                      <>
                        <span className="hint">You would hand over from {pv.picks[0].botIgn}:</span>
                        <span className="trade-slots inline">{pv.picks.map((p) => <Slot key={p.instanceId} name={p.name} count={p.enchantIds.length} title={p.name} />)}</span>
                        <button className="tx-submit" disabled={busy} onClick={() => void accept(o)}>Accept</button>
                      </>
                    )}
                  </footer>
                )}
                {o.mine && o.status === "open" && <footer className="trade-card-foot"><button className="nav-link" disabled={busy} onClick={() => void post({ action: "cancel", offerId: o.id }).then(() => load())}>cancel offer</button></footer>}
              </article>
            );
          })}
        </div>
      ))}

      {section === "meetings" && status && (status.rendezvous.length === 0 ? <p className="hint">No meetings. Hub polled {status.lastPollAt ? ago(status.lastPollAt) : "never"}.</p> : (
        <div className="trade-cards">
          {status.rendezvous.map((r) => {
            const st = stateLabel(r);
            return (
              <article key={r.id} className="trade-card">
                <header className="trade-card-head">
                  <b>meeting #{r.id}</b>
                  <span className="muted">· {r.kind === "commons" ? "commons hand-over" : `offer #${r.offerId}`} · {r.server}{r.requestId !== null ? ` · job #${r.requestId}` : ""}</span>
                  <span className={"trade-state " + st.cls}>{st.text}</span>
                </header>
                <Ticket
                  arrow={r.kind === "commons" ? (r.me.role === "give" ? "→" : "←") : "⇄"}
                  leftTitle={<>{r.me.botIgn} <span className="muted">(you, {r.me.role === "give" ? "invites" : "accepts first"})</span> gives</>}
                  rightTitle={<>{r.partner.botIgn} <span className="muted">({r.partner.poster})</span> gives</>}
                  left={r.me.gives.map((g) => <Slot key={g.ref} name={g.name ?? nameOf.get(g.itemId) ?? g.itemId} count={g.count} />)}
                  right={r.me.gets.map((g, i) => <Slot key={i} name={nameOf.get(g.itemId) ?? g.itemId} qty={g.qty} />)}
                />
              </article>
            );
          })}
        </div>
      ))}
    </div>
  );
}
