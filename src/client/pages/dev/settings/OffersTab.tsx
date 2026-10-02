import { useCallback, useEffect, useState } from "react";
// Offers between vaults (design doc §6.2). Post what you give for what you
// want; accept someone else's with the plainest of your items that fit. The
// hub schedules a meeting on the offer's server; both bots swap in the
// game's trade window; the hub records it when both nodes' receipts match.

type Held = { instanceId: string; itemId: string; name: string; enchantIds: number[]; botGuid: string; botIgn: string; seasonal: boolean };
type OfferItem = { ref: string; itemId: string; name: string; enchants: number[] | null; count: number };
type WantLine = { itemId: string; name: string; qty: number; slotsMin: number; slotsExact: number | null; enchants: unknown[] };
type Offer = { id: number; poster: string; mine: boolean; botIgn: string; seasonal: boolean; server: string; give: OfferItem[]; want: WantLine[]; status: string; createdAt: number; expiresAt: number };
type Limits = { maxOpenOffers: number; maxItemsPerSide: number; completedSwaps: number; frozen: boolean } | null;
type Rendezvous = { id: number; offerId: number; server: string; state: string; deadlineAt: number; me: { role: string; botIgn: string; gives: OfferItem[]; gets: { itemId: string; qty: number }[] }; partner: { botIgn: string; poster: string }; reported: { mine: boolean; partner: boolean }; requestId: number | null; localState: string | null };

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const list = (items: { name?: string; itemId: string; qty?: number; count?: number }[]) => items.map((i) => `${i.qty && i.qty > 1 ? `${i.qty}× ` : ""}${i.name ?? i.itemId}${i.count ? ` (${i.count} ench)` : ""}`).join(", ");

export default function OffersTab({ password }: { password: string }) {
  const headers = { "Content-Type": "application/json", "x-dev-password": password };
  const [view, setView] = useState<"browse" | "mine" | "new" | "meetings">("browse");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [limits, setLimits] = useState<Limits>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [servers, setServers] = useState<string[]>([]);
  const [status, setStatus] = useState<{ linked: boolean; lastPollAt: number | null; lastError: string | null; rendezvous: Rendezvous[]; tradeSlots?: { biggest: number; byBot: Record<string, number> } } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [want, setWant] = useState<{ itemId: string; qty: string; slotsMin: string; slotsExact: string }[]>([{ itemId: "", qty: "1", slotsMin: "", slotsExact: "" }]);
  const [server, setServer] = useState("");
  const [previews, setPreviews] = useState<Record<number, { ok: boolean; text: string }>>({});

  const get = useCallback(async (v: string) => {
    const r = await fetch(`/api/dev/offers?view=${v}`, { headers, cache: "no-store" });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  const load = useCallback(async () => {
    setError("");
    try {
      const st = await get("status");
      setStatus(st);
      if (view === "browse" || view === "mine") {
        const b = await get(view);
        setOffers(b.offers);
        setLimits(b.limits);
      } else if (view === "new") {
        const h = await get("held");
        setHeld(h.items);
        setServers(h.servers);
        setServer((s) => s || h.servers[0] || "");
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [get, view]);

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
      const r = await fetch("/api/dev/offers", { method: "POST", headers, body: JSON.stringify(body) });
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

  async function preview(o: Offer) {
    const b = await post({ action: "preview", offer: o });
    if (!b) return;
    setPreviews((p) => ({ ...p, [o.id]: b.ok ? { ok: true, text: `You would give: ${list(b.picks as Held[])}` } : { ok: false, text: String(b.error) } }));
  }
  async function accept(o: Offer) {
    if (!confirm(`Accept offer #${o.id}? Your bot meets ${o.botIgn || "their bot"} on ${o.server} and swaps ${o.want.length} line(s) of your items for: ${list(o.give)}.`)) return;
    const b = await post({ action: "accept", offer: o });
    if (b) {
      setNotice(`Accepted. Meeting #${(b.rendezvous as Rendezvous).id} on ${o.server}; watch Meetings.`);
      setView("meetings");
    }
  }
  async function create() {
    const b = await post({ action: "create", instanceIds: [...picked], want: want.filter((w) => w.itemId).map((w) => ({ itemId: w.itemId, qty: Number(w.qty) || 1, slotsMin: w.slotsMin, slotsExact: w.slotsExact })), server });
    if (b) {
      setNotice(`Offer #${(b.offer as Offer).id} posted.`);
      setPicked(new Set());
      setView("mine");
    }
  }

  const byBot = new Map<string, Held[]>();
  for (const h of held) byBot.set(h.botIgn || h.botGuid, [...(byBot.get(h.botIgn || h.botGuid) ?? []), h]);
  const pickedBot = held.find((h) => picked.has(h.instanceId))?.botGuid;

  return (
    <section>
      {status && !status.linked && <p style={{ color: "var(--warn, #d2a24c)" }}>Offers need the hub: link this node from Overview first.</p>}
      <div className="pool-tabs">
        {(["browse", "mine", "new", "meetings"] as const).map((v) => (
          <button key={v} className={"nav-link" + (view === v ? " active" : "")} onClick={() => setView(v)}>
            {v === "browse" ? "Open offers" : v === "mine" ? "My offers" : v === "new" ? "New offer" : "Meetings"}
          </button>
        ))}
        <button className="nav-link" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void load()}>refresh</button>
      </div>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}
      {limits && (view === "browse" || view === "mine") && (
        <p style={{ color: limits.frozen ? "var(--bad)" : "var(--muted, #999)", fontSize: 12 }}>
          {limits.frozen ? "The hub operator has frozen this node: no new offers or accepts until they unfreeze it." : `Limits: ${limits.maxOpenOffers} open offer(s), ${limits.maxItemsPerSide} items per side (the biggest trade inventory among your accounts) · ${limits.completedSwaps} completed swap(s).`}
        </p>
      )}

      {(view === "browse" || view === "mine") && (
        offers.length === 0 ? <p className="muted" style={{ color: "var(--muted, #999)" }}>{view === "browse" ? "No open offers right now." : "You have no offers."}</p> : (
          <div style={{ display: "grid", gap: 10 }}>
            {offers.map((o) => (
              <div key={o.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                  <b>#{o.id}</b><span>{o.mine ? "your offer" : `by ${o.poster}`}</span><span>{o.seasonal ? "seasonal" : "non-seasonal"}</span><span>meets on {o.server}</span><span className="muted" style={{ color: "var(--muted, #999)" }}>{o.status} · expires {when(o.expiresAt)}</span>
                </div>
                <div style={{ marginTop: 6 }}><b>Gives:</b> {list(o.give)}</div>
                <div><b>Wants:</b> {list(o.want)}{o.want.some((w) => w.slotsMin || w.slotsExact !== null || (w.enchants?.length ?? 0) > 0) ? " (with enchantment filters)" : ""}</div>
                {!o.mine && o.status === "open" && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="nav-link" disabled={busy} onClick={() => void preview(o)}>what would I give?</button>
                    {previews[o.id] && <span style={{ fontSize: 12, color: previews[o.id].ok ? "var(--good, #5aa86a)" : "var(--bad)" }}>{previews[o.id].text}</span>}
                    {previews[o.id]?.ok && <button disabled={busy} onClick={() => void accept(o)}>Accept</button>}
                  </div>
                )}
                {o.mine && o.status === "open" && (
                  <div style={{ marginTop: 8 }}><button className="nav-link" disabled={busy} onClick={() => void post({ action: "cancel", offerId: o.id }).then(() => load())}>cancel offer</button></div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {view === "new" && (
        <div>
          <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 720 }}>
            Pick the items you give (all from one account), say what you want back, and choose the server your bot will meet the taker on. The items stay on
            your bot until someone accepts; then your bot logs in there and trades.
          </p>
          <h3 style={{ fontSize: 14 }}>You give</h3>
          {held.length === 0 && <p style={{ color: "var(--muted, #999)" }}>Nothing free to offer: your bots hold no unreserved items the node knows the names of.</p>}
          {[...byBot].map(([bot, items]) => (
            <div key={bot} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "var(--muted, #999)" }}>{bot} · {items[0].seasonal ? "seasonal" : "non-seasonal"}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {items.map((h) => {
                  const on = picked.has(h.instanceId);
                  const other = pickedBot && pickedBot !== h.botGuid;
                  // No more than the account trades at once (its character's trade slots).
                  const full = !on && !other && picked.size >= (status?.tradeSlots?.byBot[h.botGuid] ?? 8);
                  return (
                    <button key={h.instanceId} className="nav-link" disabled={busy || (!!other && !on) || full} title={other ? "one account per offer" : full ? `this account trades at most ${status?.tradeSlots?.byBot[h.botGuid] ?? 8} items at once` : ""} style={{ border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`, borderRadius: 6, padding: "4px 8px", color: on ? "var(--accent-hot)" : undefined }}
                      onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(h.instanceId)) n.delete(h.instanceId); else n.add(h.instanceId); return n; })}>
                      {h.name}{h.enchantIds.length ? ` (${h.enchantIds.length})` : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <h3 style={{ fontSize: 14 }}>You want</h3>
          {want.map((w, i) => (
            <div key={i} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
              <input value={w.itemId} placeholder="item id (e.g. pdef)" style={{ width: 160 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, itemId: e.target.value.trim() } : x)))} />
              <input value={w.qty} type="number" min={1} max={status?.tradeSlots?.biggest ?? 24} style={{ width: 60 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <input value={w.slotsMin} placeholder="min ench" style={{ width: 80 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, slotsMin: e.target.value } : x)))} />
              <input value={w.slotsExact} placeholder="exact ench" style={{ width: 80 }} onChange={(e) => setWant((ws) => ws.map((x, j) => (j === i ? { ...x, slotsExact: e.target.value } : x)))} />
              {want.length > 1 && <button className="nav-link" onClick={() => setWant((ws) => ws.filter((_, j) => j !== i))}>remove</button>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <button className="nav-link" disabled={want.length >= 8} onClick={() => setWant((ws) => [...ws, { itemId: "", qty: "1", slotsMin: "", slotsExact: "" }])}>+ line</button>
            <label>meet on <select value={server} onChange={(e) => setServer(e.target.value)}>{servers.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            <button disabled={busy || picked.size === 0 || !want.some((w) => w.itemId) || !server} onClick={() => void create()}>Post offer ({picked.size} item{picked.size === 1 ? "" : "s"})</button>
          </div>
        </div>
      )}

      {view === "meetings" && status && (
        <div>
          <p style={{ color: "var(--muted, #999)", fontSize: 12 }}>hub polled {when(status.lastPollAt)}{status.lastError ? ` · ${status.lastError}` : ""} <button className="nav-link" disabled={busy} onClick={() => void post({ action: "poll" }).then(() => load())}>poll now</button></p>
          {status.rendezvous.length === 0 ? <p style={{ color: "var(--muted, #999)" }}>No meetings.</p> : (
            <table style={{ fontSize: 13 }}>
              <thead><tr><th>#</th><th>offer</th><th>server</th><th>my bot</th><th>role</th><th>with</th><th>I give</th><th>I get</th><th>state</th><th>local</th><th>deadline</th></tr></thead>
              <tbody>
                {status.rendezvous.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td><td>#{r.offerId}</td><td>{r.server}</td><td>{r.me.botIgn}</td><td>{r.me.role}</td><td>{r.partner.botIgn} ({r.partner.poster})</td>
                    <td>{list(r.me.gives)}</td><td>{list(r.me.gets)}</td>
                    <td>{r.state}{r.reported.mine ? " · reported" : ""}{r.reported.partner ? " · partner reported" : ""}</td>
                    <td>{r.localState ?? "—"}{r.requestId !== null ? ` (job #${r.requestId})` : ""}</td><td>{when(r.deadlineAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
