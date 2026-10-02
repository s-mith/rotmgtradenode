import { useCallback, useEffect, useMemo, useState } from "react";
import { devHeaders } from "./devHeaders";
import type { PoolInstance } from "@/lib/poolWire";
import { WITHDRAW_SERVERS } from "@/lib/servers";
import { ItemSprite } from "./ItemSprite";
import { Slot, Ticket, ago, left } from "./TradeBits";
import { TagSearch, type SearchTag, type Suggestions } from "./TagSearch";
import OffersBoard from "./OffersBoard";

// Trading (design doc §6.2) as a bookmark on the vault page. Every trade is
// drawn the same way, mirroring the in-game window: a row of slots for what
// one side hands over, a swap arrow, a row of slots for what comes back.
// The pool grid on the left is the picker for the "you give" side; the
// "you want" side is picked from the catalog.

type OfferItem = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number };
type WantLine = { itemId: string; name: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: unknown[] };
export type Offer = { id: number; poster: string; mine: boolean; botIgn: string; seasonal: boolean; server: string; give: OfferItem[]; want: WantLine[]; status: string; createdAt: number; expiresAt: number; heldBy?: number; closedReason?: string;
  /** Another node's open offer, as browsed: whether this node could take it now, and with which of its items. */
  take?: { ok: true; picks: Pick[] } | { ok: false; error: string } };
type Limits = { maxOpenOffers: number; maxItemsPerSide: number; completedSwaps: number; frozen: boolean } | null;
type TimelineEvent = { event: string; detail: unknown; at: number };
type Rendezvous = { id: number; kind: "swap" | "communism" | "player"; offerId: number | null; server: string; state: string; deadlineAt: number; me: { role: string; botIgn: string; gives: OfferItem[]; gets: { itemId: string; qty: number }[]; getsLines?: { itemId: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: unknown[] }[] }; partner: { botIgn: string; poster: string; player?: boolean }; reported: { mine: boolean; partner: boolean }; requestId: number | null; localState: string | null; receiptPending?: boolean; events?: TimelineEvent[] };
type Status = { linked: boolean; lastPollAt: number | null; lastError: string | null; rendezvous: Rendezvous[]; localOffers?: { offerId: number; side: string; refs: Record<string, string>; status: string }[]; tradeSlots?: { biggest: number; byBot: Record<string, number> } };
type Pick = { instanceId: string; itemId: string; name: string; enchantIds: number[]; botIgn: string; offers?: number[] };
type Catalog = { itemId: string; itemName: string; category?: string; subtype?: string | null; accepted?: boolean }[];

const NO_SUGGEST: Suggestions = { items: [], enchants: [], effects: [] };
const filterBadge = (w: { slotsMin: number; slotsExact: number | null; enchants?: unknown[] }) =>
  w.slotsExact !== null ? `=${w.slotsExact}` : w.slotsMin > 0 ? `${w.slotsMin}+` : (w.enchants?.length ?? 0) > 0 ? "f" : undefined;
const offerList = (ids: number[]) => `offer${ids.length === 1 ? "" : "s"} ${ids.map((id) => `#${id}`).join(", ")}`;

/** Which part of the desk shows: the composer (picker underneath) or one of the offer lists. */
/** Which part of the desk shows: the composer (picker underneath), one half's offers on the hub (RealmEye's Current Offers and Current Seasonal Offers), or this node's own. */
export type TradeSection = "desk" | "seasonalOffers" | "nonseasonalOffers" | "mine";

export default function TradePanel({ tray, onRemove, onClear, seasonal, onPosted, maxTray, onTradeSlots, catalog, section, onSection, onPostOwn }: {
  tray: (PoolInstance | null)[];
  onRemove: (index: number) => void;
  onClear: () => void;
  seasonal: boolean;
  onPosted: () => void;
  /** Items either side of an offer may hold: the node's biggest trade inventory (onTradeSlots reports it once known). */
  maxTray: number;
  onTradeSlots?: (biggest: number) => void;
  catalog: Catalog;
  section: TradeSection;
  onSection: (s: TradeSection) => void;
  /** Open the composer on one half of the pool, to post an offer there. */
  onPostOwn?: (seasonal: boolean) => void;
}) {
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
  // Only what this node takes in can be asked for.
  const suggestions = useMemo<Suggestions>(() => ({ items: catalog.filter((c) => c.accepted !== false).map((c) => ({ id: c.itemId, name: c.itemName })), enchants: [], effects: [] }), [catalog]);

  // Both sides of an offer hold at most what the biggest character on this node can trade at once.
  const biggest = status?.tradeSlots?.biggest ?? maxTray;
  useEffect(() => {
    if (status?.tradeSlots) onTradeSlots?.(status.tradeSlots.biggest);
  }, [status?.tradeSlots?.biggest, onTradeSlots]);
  const wantTotal = want.reduce((n, w) => n + w.qty, 0);

  // A picked catalog item becomes a want slot; the search box clears for the next one. A full want side takes no more.
  useEffect(() => {
    const item = wantTags.find((t) => t.kind === "item");
    if (!item || item.kind !== "item") return;
    setWant((w) => {
      if (w.reduce((n, x) => n + x.qty, 0) >= biggest) return w;
      return w.some((x) => x.itemId === item.id) ? w.map((x) => (x.itemId === item.id ? { ...x, qty: x.qty + 1 } : x)) : w.length >= 8 ? w : [...w, { itemId: item.id, name: item.label, qty: 1, slotsMin: 0, slotsExact: null }];
    });
    setWantTags([]);
    setWantText("");
  }, [wantTags, biggest]);

  const load = useCallback(async () => {
    try {
      const st = await fetch("/api/dev/offers?view=status", { headers: devHeaders(), cache: "no-store" });
      const stb = await st.json();
      if (!st.ok) throw new Error(stb.error || `HTTP ${st.status}`);
      setStatus(stb);
      // The composer only needs the limits, which ride along with "mine".
      const browsing = section === "seasonalOffers" || section === "nonseasonalOffers";
      const r = await fetch(`/api/dev/offers?view=${browsing ? "browse" : "mine"}`, { headers: devHeaders(), cache: "no-store" });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      setOffers(b.offers);
      // Browsed offers come with this node's answer to each already: what it would hand over, or why it cannot.
      if (browsing) setPreviews(Object.fromEntries((b.offers as Offer[]).flatMap((o) => (o.take ? [[o.id, o.take.ok ? { ok: true, picks: o.take.picks } : { ok: false, text: o.take.error }]] : []))));
      setLimits(b.limits);
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
      const r = await fetch("/api/dev/offers", { method: "POST", headers: devHeaders(true), body: JSON.stringify(body) });
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
  // One item may be in several offers: whichever trade takes it first, the hub withdraws the others.
  const offeredIn = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const o of status?.localOffers ?? []) if (o.side === "poster" && o.status === "open") for (const id of Object.values(o.refs)) m.set(id, [...(m.get(id) ?? []), o.offerId]);
    return m;
  }, [status]);
  const alsoOffered = items.filter((it) => offeredIn.has(it.instanceId));
  // The giving account trades at most its own character's slots at once; the want side, what the biggest character can take.
  const giveCap = items.length ? status?.tradeSlots?.byBot[items[0].botGuid] ?? biggest : biggest;
  const tooMany = items.length > giveCap;
  const canPost = items.length > 0 && bots.size === 1 && !tooMany && want.length > 0 && wantTotal <= biggest && !!server && !busy && !(limits?.frozen);

  async function create() {
    const b = await post({ action: "create", instanceIds: items.map((i) => i.instanceId), want: want.map((w) => ({ itemId: w.itemId, qty: w.qty, slotsMin: w.slotsMin || "", slotsExact: w.slotsExact ?? "" })), server });
    if (b) {
      setNotice(`Offer #${(b.offer as Offer).id} posted. Your bot ${items[0].botIgn} will meet the taker on ${server}.`);
      onClear();
      setWant([]);
      onPosted();
      onSection("mine");
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
    const also = [...new Set(pv.picks.flatMap((p) => p.offers ?? []))];
    if (!confirm(`Accept offer #${o.id}?\n\nYour bot ${pv.picks[0].botIgn} meets ${o.botIgn || "their bot"} on ${o.server} and hands over ${pv.picks.map((p) => p.name).join(", ")} for ${o.give.map((g) => g.name).join(", ")}.${also.length ? `\n\nYour ${offerList(also)} name${also.length === 1 ? "s" : ""} the same item; ${also.length === 1 ? "it is" : "they are"} withdrawn once this trade goes through.` : ""}`)) return;
    const b = await post({ action: "accept", offer: o });
    if (b) {
      setNotice(`Accepted. Meeting #${(b.rendezvous as Rendezvous).id} on ${o.server}.`);
      onSection("mine");
    }
  }

  async function abort(r: Rendezvous) {
    if (!confirm(`Give up meeting #${r.id}?\n\nThe hub drops it; ${r.kind === "communism" ? "the item is listed again" : "the offer goes back to open"} and your bot's job is cancelled.`)) return;
    const b = await post({ action: "abort", rendezvousId: r.id });
    if (b) {
      setNotice(`Meeting #${r.id} aborted.`);
      await load();
    }
  }

  const stateLabel = (r: Rendezvous) => {
    if (r.state === "done") return { text: "done", cls: "ok" };
    if (r.state === "meet") return r.receiptPending ? { text: "traded — receipt kept, the hub will get it", cls: "warn" } : r.reported.mine ? { text: "traded, waiting for the other side's receipt", cls: "warn" } : { text: `${lastStep(r)} · ${left(r.deadlineAt)}`, cls: "" };
    return { text: r.state, cls: r.state === "disputed" ? "bad" : "" };
  };
  /** What the fleet was last doing about a meeting, from the row's timeline. */
  const lastStep = (r: Rendezvous): string => {
    const e = [...(r.events ?? [])].reverse().find((x) => x.event !== "swap-waiting") ?? r.events?.at(-1);
    const waiting = r.events?.at(-1)?.event === "swap-waiting" ? (r.events.at(-1)!.detail as { partnerSeen?: boolean | null } | null) : null;
    switch (e?.event) {
      case undefined: return `meeting on ${r.server}`;
      case "swap-queued": return `waiting for a bot to reach ${r.server}`;
      case "claimed":
      case "swap-assigned": return waiting ? (waiting.partnerSeen ? `bot on ${r.server}, ${r.partner.botIgn} in sight` : `bot on ${r.server}, waiting for ${r.partner.botIgn}`) : `bot on ${r.server}`;
      case "swap-requested": return `trade requested with ${r.partner.botIgn}`;
      case "swap-interrupted": return "bot dropped; the row waits to be picked up again";
      case "swap-orphaned": return "picked up again after a restart";
      // A player meeting: the person trades with their own character, a window at a time.
      case "player-ready":
      case "player-seen": return `bot in the ${r.server} nexus, waiting for ${r.partner.botIgn} to /trade it`;
      case "player-invited": return `invited ${r.partner.botIgn}`;
      case "player-window-open":
      case "player-filling": return `trade window open with ${r.partner.botIgn}`;
      case "player-holding": return `holding: ${String((e.detail as { why?: string } | null)?.why ?? "their side does not fit yet")}`;
      case "player-matches": return "their side fits; waiting for their accept";
      case "player-accepted": return "both accepted; finishing";
      case "player-window-failed": return `window closed: ${String((e.detail as { why?: string } | null)?.why ?? "")}`;
      default: return `meeting on ${r.server}`;
    }
  };
  const [openTimelines, setOpenTimelines] = useState<Set<number>>(new Set());
  const toggleTimeline = (id: number) => setOpenTimelines((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const eventText = (e: TimelineEvent): string => {
    const d = (e.detail ?? {}) as Record<string, unknown>;
    switch (e.event) {
      case "swap-queued": return "queued for the fleet";
      case "claimed": return "a bot took the row";
      case "swap-assigned": return `${String(d.bot ?? "bot")} on it (${String(d.role)}), ${d.inNexus ? "in the nexus" : "heading to the nexus"}`;
      case "swap-waiting": return `waiting for ${String(d.partner ?? "the partner")}${d.partnerSeen ? " (in sight)" : d.partnerSeen === false ? " (not in sight)" : ""}, ${String(d.waitedS ?? 0)}s so far`;
      case "swap-requested": return `trade requested with ${String(d.partner ?? "the partner")}`;
      case "swap-done": return "traded";
      case "swap-failed": return `failed: ${String((d as { error?: string }).error ?? "?")}`;
      case "swap-cancelled": return `cancelled: ${String(d.why ?? "")}`;
      case "swap-interrupted": return `interrupted: ${String(d.why ?? "")}`;
      case "swap-orphaned": return "left over from a previous run, back on the queue";
      case "swap-let-go": return `let go: ${String(d.why ?? "the meeting was called off")}`;
      case "swap-done-late": return "traded after the meeting had been called off (a receipt still went out)";
      case "player-ready": return `in the ${String(d.server ?? "")} nexus, waiting for the player`;
      case "player-seen": return "the player is in sight";
      case "player-invited": return "invited the player";
      case "player-window-open": return `trade window ${String(d.window ?? "")} open`;
      case "player-filling": return `their side so far: ${String(d.why ?? "")}`;
      case "player-holding": return `holding: ${String(d.why ?? "")}`;
      case "player-matches": return "their side fits";
      case "player-accepted": return "accepted after them";
      case "player-window-failed": return `window closed (${String(d.windows ?? "?")}/${String(d.max ?? "?")}): ${String(d.why ?? "")}`;
      case "player-traded": return "traded with the player";
      case "unclaimed": return "the bot let the row go";
      case "expired": return `expired: ${String(d.why ?? "")}`;
      default: return e.event;
    }
  };

  return (
    <div className="trade-desk">
      {status && !status.linked && <p className="hint" style={{ color: "var(--warn, #d2a24c)" }}>Trading needs the hub. Link this node from Control panel → Overview.</p>}
      {error && <p className="hint" style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p className="hint" style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}

      {/* ---- composer ---- */}
      {section === "desk" && <section className="trade-compose">
        <Ticket
          min={12}
          leftTitle={<>You give <span className="muted">{items.length}/{giveCap}{items.length ? ` · from ${items[0].botIgn}` : ` · click items in the ${seasonal ? "seasonal" : "non-seasonal"} pool`}</span></>}
          rightTitle={<>You want <span className="muted">{wantTotal ? `${wantTotal}/${biggest}` : "pick from the catalog below"}</span></>}
          left={items.map((it) => <Slot key={it.instanceId} name={it.itemName} sprite={it.sprite} count={it.enchantments.length} title={`${it.itemName}${it.enchantments.length ? ` · ${it.enchantments.map((e) => e.name ?? e.id).join(", ")}` : ""} · on ${it.botIgn}`} onRemove={() => onRemove(tray.indexOf(it))} dim={bots.size > 1 && it.botGuid !== items[0].botGuid} />)}
          right={want.map((w) => <Slot key={w.itemId} name={w.name} qty={w.qty} filter={filterBadge(w)} title={`${w.qty}× ${w.name}${w.slotsExact !== null ? ` with exactly ${w.slotsExact} enchantments` : w.slotsMin ? ` with ${w.slotsMin}+ enchantments` : ""}`} onRemove={() => setWant((ws) => ws.filter((x) => x.itemId !== w.itemId))} />)}
        />
        {bots.size > 1 && <p className="hint" style={{ color: "var(--bad)" }}>One offer trades from one account. The dimmed items sit on another bot; remove them or start from that bot.</p>}
        {bots.size === 1 && tooMany && <p className="hint" style={{ color: "var(--bad)" }}>{items[0].botIgn} can trade at most {giveCap} items at once (its character&apos;s trade slots). Remove {items.length - giveCap}, or give from a bigger account.</p>}
        {alsoOffered.length > 0 && <p className="hint">{alsoOffered.map((it) => `${it.itemName} is also in your ${offerList(offeredIn.get(it.instanceId)!)}`).join("; ")}. An item can be in several offers: while one of them is being traded the others wait, and once it is traded away they are withdrawn.</p>}
        <div className="trade-want-picker">
          <TagSearch tags={wantTags} onTagsChange={setWantTags} text={wantText} onTextChange={setWantText} suggestions={wantText.length >= 2 ? suggestions : NO_SUGGEST} placeholder="Add a wanted item by name…" />
        </div>
        {want.length > 0 && (
          <table className="trade-want-table">
            <tbody>
              {want.map((w) => (
                <tr key={w.itemId}>
                  <td><ItemSprite name={w.name} size={18} /> {w.name}</td>
                  <td><label>qty <input type="number" min={1} max={Math.max(1, biggest - (wantTotal - w.qty))} value={w.qty} onChange={(e) => setWant((ws) => ws.map((x) => (x.itemId === w.itemId ? { ...x, qty: Math.max(1, Math.min(biggest - (wantTotal - x.qty), Number(e.target.value) || 1)) } : x)))} /></label></td>
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
          {limits && <span className="hint">{limits.frozen ? "frozen by the hub operator" : `${limits.maxOpenOffers} open · ${limits.maxItemsPerSide} per side · ${limits.completedSwaps} done`}</span>}
        </div>
      </section>}

      {/* ---- lists: Seasonal offers / Non-seasonal offers / My offers are tabs on the Trading panel
          (Vault.tsx). A half's offers are RealmEye's board (OffersBoard.tsx); My offers also carries
          this node's meetings, so "give up" stays reachable. ---- */}
      {section !== "desk" && (
        <div className="trade-list-head">
          <span className="hint">{section === "mine" ? "Your offers and meetings." : `Every ${section === "seasonalOffers" ? "seasonal" : "non-seasonal"} offer on the hub, yours included.`} Hub polled {status?.lastPollAt ? ago(status.lastPollAt) : "never"}.</span>
          <button className="nav-link" disabled={busy} onClick={() => void load()}>refresh</button>
        </div>
      )}

      {section === "mine" && status && status.rendezvous.length > 0 && (
        <div className="trade-cards">
          {status.rendezvous.map((r) => {
            const st = stateLabel(r);
            return (
              <article key={r.id} className="trade-card">
                <header className="trade-card-head">
                  <b>meeting #{r.id}</b>
                  <span className="muted">· {r.kind === "communism" ? "communism hand-over" : r.kind === "player" ? `player trade on offer #${r.offerId}` : `offer #${r.offerId}`} · {r.server}{r.requestId !== null ? ` · job #${r.requestId}` : ""}</span>
                  <span className={"trade-state " + st.cls}>{st.text}</span>
                </header>
                <Ticket
                  arrow={r.kind === "communism" ? (r.me.role === "give" ? "→" : "←") : "⇄"}
                  leftTitle={<>{r.me.botIgn} <span className="muted">(you, {r.kind === "player" ? "accepts after them" : r.me.role === "give" ? "invites" : "accepts first"})</span> gives</>}
                  rightTitle={r.kind === "player" ? <>{r.partner.botIgn} <span className="muted">({r.partner.poster}, playing their own character)</span> puts up</> : <>{r.partner.botIgn} <span className="muted">({r.partner.poster})</span> gives</>}
                  left={r.me.gives.map((g) => <Slot key={g.ref} name={g.name ?? nameOf.get(g.itemId) ?? g.itemId} count={g.count} />)}
                  right={r.kind === "player" && r.me.getsLines?.length ? r.me.getsLines.map((w, i) => <Slot key={i} name={nameOf.get(w.itemId) ?? w.itemId} qty={w.qty} filter={filterBadge(w)} />) : r.me.gets.map((g, i) => <Slot key={i} name={nameOf.get(g.itemId) ?? g.itemId} qty={g.qty} />)}
                />
                <footer className="trade-card-foot">
                  {r.state === "meet" && !r.reported.mine && !r.receiptPending && (
                    <>
                      <button className="nav-link" disabled={busy} onClick={() => void abort(r)}>give up this meeting</button>
                      <span className="hint">for a full server or a bot that will not log in; otherwise it ends by itself at the deadline</span>
                    </>
                  )}
                  {(r.events?.length ?? 0) > 0 && <button className="nav-link" style={{ marginLeft: "auto" }} type="button" onClick={() => toggleTimeline(r.id)}>{openTimelines.has(r.id) ? "hide timeline" : `timeline (${r.events!.length})`}</button>}
                </footer>
                {openTimelines.has(r.id) && (
                  <ol className="trade-timeline">
                    {r.events!.map((e, i) => <li key={i}><span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {eventText(e)}</li>)}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      )}

      {(section === "seasonalOffers" || section === "nonseasonalOffers") && (
        <OffersBoard
          key={section}
          offers={offers.filter((o) => o.seasonal === (section === "seasonalOffers"))}
          seasonal={section === "seasonalOffers"}
          catalog={catalog}
          previews={previews}
          busy={busy}
          onPreview={(o) => void preview(o)}
          onAccept={(o) => void accept(o)}
          onPostOwn={onPostOwn ? () => onPostOwn(section === "seasonalOffers") : undefined}
          onManageMine={() => onSection("mine")}
        />
      )}

      {section === "mine" && (offers.length === 0 ? <p className="hint">You have no offers.</p> : (
        <div className="trade-cards">
          {offers.map((o) => {
            const pv = previews[o.id];
            return (
              <article key={o.id} className={"trade-card" + (o.mine ? " mine" : "")}>
                <header className="trade-card-head">
                  <b>#{o.id}</b>
                  <span>{o.mine ? "your offer" : o.poster}</span>
                  <span className="muted">{o.botIgn ? `· ${o.botIgn} ` : ""}· {o.seasonal ? "seasonal" : "non-seasonal"} · meets on {o.server} · {ago(o.createdAt)}{o.status !== "open" ? ` · ${o.status}${o.closedReason ? `: ${o.closedReason}` : ""}` : ""}</span>
                  {o.heldBy !== undefined && <span className="trade-state warn">on hold: meeting #{o.heldBy} has one of its items</span>}
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
                        <span className="trade-slots inline">{pv.picks.map((p) => <Slot key={p.instanceId} name={p.name} count={p.enchantIds.length} title={p.offers?.length ? `${p.name} · also in your ${offerList(p.offers)}` : p.name} />)}</span>
                        <button className="tx-submit" disabled={busy} onClick={() => void accept(o)}>Accept</button>
                        {pv.picks.some((p) => p.offers?.length) && <span className="hint">Also in your {offerList([...new Set(pv.picks.flatMap((p) => p.offers ?? []))])}: withdrawn once this trade goes through.</span>}
                      </>
                    )}
                  </footer>
                )}
                {o.mine && (o.status === "open" || o.status === "expired") && (
                  <footer className="trade-card-foot">
                    {o.status === "open" && <span className="hint">{left(o.expiresAt)}</span>}
                    <button className="nav-link" disabled={busy} title="Another fourteen days on the hub" onClick={() => void post({ action: "renew", offerId: o.id }).then((b) => { if (b) setNotice(`Offer #${o.id} renewed for fourteen days.`); return load(); })}>{o.status === "expired" ? "renew (post it again)" : "renew"}</button>
                    {o.status === "open" && <button className="nav-link" disabled={busy} onClick={() => void post({ action: "cancel", offerId: o.id }).then(() => load())}>cancel offer</button>}
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      ))}
    </div>
  );
}
