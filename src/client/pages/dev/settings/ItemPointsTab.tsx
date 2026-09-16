
import { useCallback, useEffect, useMemo, useState } from "react";

// Item points — what each item is worth to deposit, and whether the pool still
// takes it.
//
// Edits are STAGED, not saved as you type. The whole point of the tab is that
// one publish mints one cutoff: everything you change in a sitting shares a
// single effective-at, and every deposit and withdraw made before it keeps the
// value it earned. Saving per row would scatter a dozen near-identical epochs
// across a minute of clicking and make the history below unreadable — so the
// draft lives here until you press publish.
//
// Delisting rides along in the same publish but is not part of the epoch: it
// is present-tense state ("do we take this today"), so it takes effect at once
// and doesn't touch anyone's score. A delisted item vanishes from the deposit
// grid; copies already in the pool stay withdrawable, or they'd be stranded on
// a bot with nothing able to take them off it.

type Item = {
  itemId: string;
  itemName: string;
  category: string;
  subtype: string | null;
  points: number;
  listed: boolean;
};

type Epoch = {
  id: number;
  effectiveAt: number;
  note: string;
  createdAt: number;
  prices: Record<string, number>;
};

type Delisting = {
  itemId: string;
  itemName: string;
  delistedAt: number;
  note: string;
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: 6,
  color: "#000",
  fontWeight: 600,
  cursor: "pointer",
};

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Trim float noise for display without lying about the value. */
function fmtPoints(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

export default function ItemPointsTab({ password }: { password: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [epochs, setEpochs] = useState<Epoch[]>([]);
  const [delisted, setDelisted] = useState<Delisting[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Staged edits, keyed by itemId. Price drafts are kept as the raw STRING the
  // operator typed: parsing on every keystroke turns "0." into 0 and fights
  // the cursor, and an empty field has to stay empty rather than becoming NaN.
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [listDraft, setListDraft] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [onlyChanged, setOnlyChanged] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/dev/item-pricing", {
        headers: { "x-dev-password": password },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setItems(data.items as Item[]);
      setEpochs((data.epochs ?? []) as Epoch[]);
      setDelisted((data.delisted ?? []) as Delisting[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load item pricing");
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set((items ?? []).map((i) => i.category));
    return ["all", ...[...set].sort()];
  }, [items]);

  // What would actually be published. Computed from the drafts rather than
  // tracked as the operator types, so re-typing the original value correctly
  // un-stages the row instead of publishing a no-op price.
  const pending = useMemo(() => {
    const prices: { itemId: string; points: number }[] = [];
    const listings: { itemId: string; listed: boolean }[] = [];
    for (const it of items ?? []) {
      const draft = priceDraft[it.itemId];
      if (draft !== undefined && draft.trim() !== "") {
        const n = Number(draft);
        if (Number.isFinite(n) && n !== it.points) prices.push({ itemId: it.itemId, points: n });
      }
      const listing = listDraft[it.itemId];
      if (listing !== undefined && listing !== it.listed)
        listings.push({ itemId: it.itemId, listed: listing });
    }
    return { prices, listings };
  }, [items, priceDraft, listDraft]);

  const pendingCount = pending.prices.length + pending.listings.length;

  // Rows whose draft is present but unparseable. Reported before publish
  // rather than dropped silently — a typo'd price that just doesn't publish
  // looks exactly like a save that didn't work.
  const badDrafts = useMemo(() => {
    const bad: string[] = [];
    for (const it of items ?? []) {
      const d = priceDraft[it.itemId];
      if (d === undefined || d.trim() === "") continue;
      const n = Number(d);
      if (!Number.isFinite(n) || n < 0) bad.push(it.itemName);
    }
    return bad;
  }, [items, priceDraft]);

  const changedIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of pending.prices) s.add(p.itemId);
    for (const l of pending.listings) s.add(l.itemId);
    return s;
  }, [pending]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (category !== "all" && i.category !== category) return false;
      if (onlyChanged && !changedIds.has(i.itemId)) return false;
      if (!q) return true;
      return i.itemName.toLowerCase().includes(q) || i.itemId.toLowerCase().includes(q);
    });
  }, [items, query, category, onlyChanged, changedIds]);

  const discard = useCallback(() => {
    setPriceDraft({});
    setListDraft({});
    setNote("");
  }, []);

  const publish = useCallback(async () => {
    if (pendingCount === 0) return;
    const priceLines = pending.prices.length
      ? `${pending.prices.length} price change(s)`
      : "";
    const listLines = pending.listings.length
      ? `${pending.listings.length} listing change(s)`
      : "";
    if (
      !confirm(
        `Publish ${[priceLines, listLines].filter(Boolean).join(" and ")}?\n\n` +
          (pending.prices.length
            ? "This starts a NEW cutoff at right now. Every deposit and " +
              "withdraw already in the ledger keeps the points it earned — " +
              "only trades from this moment on use the new values. It cannot " +
              "be edited afterwards, only superseded by a later publish.\n\n"
            : "") +
          (pending.listings.length
            ? "Delisted items disappear from the deposit grid immediately. " +
              "Copies already in the pool stay withdrawable.\n\n"
            : "") +
          "Continue?",
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const r = await fetch("/api/dev/item-pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ ...pending, note }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setItems(data.items as Item[]);
      setEpochs((data.epochs ?? []) as Epoch[]);
      setDelisted((data.delisted ?? []) as Delisting[]);
      discard();
      const parts: string[] = [];
      if (data.epoch) {
        const n = Object.keys((data.epoch as Epoch).prices).length;
        parts.push(`new cutoff at ${when((data.epoch as Epoch).effectiveAt)} — ${n} price(s)`);
      }
      const off = (data.justDelisted ?? []) as string[];
      const on = (data.justRelisted ?? []) as string[];
      if (off.length) parts.push(`${off.length} no longer accepted`);
      if (on.length) parts.push(`${on.length} accepted again`);
      setSaved(
        parts.length > 0
          ? `Published: ${parts.join("; ")}`
          // A publish that mints nothing is the honest outcome when every
          // edited value already matched — say so rather than implying a
          // cutoff was created.
          : "Nothing to publish — those values were already in force",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not publish");
    } finally {
      setBusy(false);
    }
  }, [pending, pendingCount, note, password, discard]);

  if (items === null) {
    return (
      <section>
        {err ? <p style={{ color: "var(--bad)" }}>{err}</p> : <p>Loading…</p>}
      </section>
    );
  }

  return (
    <section>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 720, marginBottom: 16 }}>
        What each item earns when deposited (and costs when withdrawn). Edit as
        many as you like, then publish once — that starts a new cutoff, so
        everything already traded keeps the points it earned and only trades
        from the publish onward use the new values. Untick <em>accepted</em> to
        drop an item from the deposit grid; copies already in the pool stay
        withdrawable.
      </p>

      {/* --- staged batch bar. Sticky because the table is long and the
          publish button is the only thing that commits anything. --- */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: "var(--bg, #111)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            style={{ ...buttonStyle, opacity: pendingCount === 0 || busy ? 0.5 : 1 }}
            disabled={pendingCount === 0 || busy || badDrafts.length > 0}
            onClick={() => void publish()}
          >
            {busy ? "…" : `Publish ${pendingCount || ""} change${pendingCount === 1 ? "" : "s"}`}
          </button>
          {pendingCount > 0 && (
            <button className="nav-link" onClick={discard} disabled={busy}>
              discard
            </button>
          )}
          <input
            placeholder="note for the history (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
        </div>
        {pendingCount > 0 && (
          <p style={{ color: "var(--warn, #d2a24c)", fontSize: 12, margin: "8px 0 0" }}>
            {pending.prices.length > 0 &&
              `${pending.prices.length} price change(s) staged — not live until you publish. `}
            {pending.listings.length > 0 &&
              `${pending.listings.length} listing change(s) staged.`}
          </p>
        )}
        {badDrafts.length > 0 && (
          <p style={{ color: "var(--bad)", fontSize: 12, margin: "8px 0 0" }}>
            Fix these before publishing: {badDrafts.join(", ")}
          </p>
        )}
        {err && <p style={{ color: "var(--bad)", fontSize: 12, margin: "8px 0 0" }}>{err}</p>}
        {saved && (
          <p style={{ color: "var(--good, #5aa86a)", fontSize: 12, margin: "8px 0 0" }}>{saved}</p>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input
          placeholder="search name or id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...inputStyle, width: 220 }}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={inputStyle}
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All categories" : c}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          only staged
        </label>
        <span style={{ color: "var(--muted, #999)", fontSize: 12 }}>
          {visible.length} of {items.length}
        </span>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 860 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted, #999)", fontSize: 12 }}>
            <th style={{ padding: "6px 10px 6px 0" }}>Item</th>
            <th style={{ padding: "6px 10px 6px 0" }}>Category</th>
            <th style={{ padding: "6px 10px 6px 0" }}>Points now</th>
            <th style={{ padding: "6px 10px 6px 0" }}>New points</th>
            <th style={{ padding: "6px 0" }}>Accepted</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((it) => {
            const staged = changedIds.has(it.itemId);
            const listed = listDraft[it.itemId] ?? it.listed;
            return (
              <tr
                key={it.itemId}
                style={{
                  borderTop: "1px solid var(--border)",
                  // A delisted item is still priced (its withdraws still cost
                  // points), so it stays fully editable — just dimmed, the
                  // same way the Accounts tab dims a retired bot.
                  opacity: listed ? 1 : 0.6,
                  background: staged ? "color-mix(in srgb, var(--accent) 12%, transparent)" : undefined,
                }}
              >
                <td style={{ padding: "6px 10px 6px 0" }}>
                  <span title={it.itemId}>{it.itemName}</span>
                  {!listed && (
                    <span style={{ color: "var(--muted, #999)", fontSize: 11 }}> · not accepted</span>
                  )}
                </td>
                <td style={{ padding: "6px 10px 6px 0", color: "var(--muted, #999)", fontSize: 12 }}>
                  {it.category}
                  {it.subtype ? ` · ${it.subtype}` : ""}
                </td>
                <td style={{ padding: "6px 10px 6px 0" }}>{fmtPoints(it.points)}</td>
                <td style={{ padding: "6px 10px 6px 0" }}>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step="0.05"
                    placeholder={fmtPoints(it.points)}
                    value={priceDraft[it.itemId] ?? ""}
                    onChange={(e) =>
                      setPriceDraft((d) => ({ ...d, [it.itemId]: e.target.value }))
                    }
                    style={{ ...inputStyle, width: 90 }}
                  />
                </td>
                <td style={{ padding: "6px 0" }}>
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={(e) =>
                      setListDraft((d) => ({ ...d, [it.itemId]: e.target.checked }))
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {delisted.length > 0 && (
        <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
          <h3 style={{ fontSize: 15, marginBottom: 8 }}>Not accepted ({delisted.length})</h3>
          <p style={{ color: "var(--muted, #999)", fontSize: 12, marginBottom: 8, maxWidth: 720 }}>
            Hidden from the deposit grid. Anything already in the pool is still
            listed there and still withdrawable — re-tick <em>accepted</em>{" "}
            above and publish to start taking them again.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted, #999)", fontSize: 13 }}>
            {delisted.map((d) => (
              <li key={d.itemId}>
                {d.itemName}{" "}
                <span style={{ fontSize: 11 }}>
                  — since {when(d.delistedAt)}
                  {d.note ? ` · ${d.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Published cutoffs</h3>
        <p style={{ color: "var(--muted, #999)", fontSize: 12, marginBottom: 10, maxWidth: 720 }}>
          Each row is one publish. A trade scores by the last cutoff at or
          before it, so these are append-only — a mistake is corrected by
          publishing again, never by editing one of these.
        </p>
        {epochs.length === 0 ? (
          <p style={{ color: "var(--muted, #999)", fontSize: 13 }}>
            None yet — every item is still on its built-in price.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {epochs.map((e) => (
              <li
                key={e.id}
                style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: 13 }}
              >
                <strong>{when(e.effectiveAt)}</strong>
                {e.note && <span style={{ color: "var(--muted, #999)" }}> — {e.note}</span>}
                <div style={{ color: "var(--muted, #999)", fontSize: 12, marginTop: 4 }}>
                  {Object.entries(e.prices)
                    .map(([id, pts]) => `${id} → ${fmtPoints(pts)}`)
                    .join(", ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
