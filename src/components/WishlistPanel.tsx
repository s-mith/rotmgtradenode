import { useCallback, useEffect, useMemo, useState } from "react";
import { ItemSprite } from "./ItemSprite";
import { TagSearch, effectLabel, effectsOfEnchant, type SearchTag, type Suggestions } from "./TagSearch";

// My Wishlist — standing claims. A wish is a pool half, an item, a slot
// requirement, and one filter per enchantment slot: rows of chips where a
// row describes one enchantment (a name, or effects it must have) and any
// one row fitting is enough (rows are "or"). The server matches every pool
// arrival against the wishes and claims what fits; a wish is spent by its
// claim, and wishes are capped by the free slots of the vault for their
// half (lib/wishlist.ts).

type MatchTerm = { kind: "ench"; name: string } | { kind: "effect"; key: string };
type SlotSpec = { any: { all: MatchTerm[] }[] };
type Rule = {
  id: number;
  seasonal: boolean;
  itemId: string;
  itemName: string;
  slotsMin: number;
  slotsExact: number | null;
  enchants: SlotSpec[];
  enabled: boolean;
  createdAt: number;
};
type Limits = { rules: number; groups: number; terms: number; slots: number };
type Room = { seasonal: boolean; slots: number; used: number; wishes: number; free: number };
type Rooms = { seasonal: Room; nonseasonal: Room };

type SlotMode = "min" | "exact";

const NO_ITEMS: Suggestions["items"] = [];

function termToTag(t: MatchTerm): SearchTag {
  return t.kind === "ench" ? { kind: "ench", name: t.name, label: t.name } : { kind: "effect", key: t.key, label: effectLabel(t.key) };
}

function tagToTerm(t: SearchTag): MatchTerm | null {
  if (t.kind === "ench") return { kind: "ench", name: t.name };
  if (t.kind === "effect") return { kind: "effect", key: t.key };
  return null;
}

function slotsText(r: Rule): string {
  if (r.slotsExact !== null) return `exactly ${r.slotsExact} slot${r.slotsExact === 1 ? "" : "s"}`;
  return `${r.slotsMin}+ slot${r.slotsMin === 1 ? "" : "s"}`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function WishlistPanel({
  ign,
  catalog,
  refreshKey,
}: {
  ign: string | null;
  /** The pool's accepted items, for the item picker. */
  catalog: { itemId: string; itemName: string }[];
  /** Bumps on live pool/vault changes so hit counts stay current. */
  refreshKey: number;
}) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [access, setAccess] = useState<boolean | null>(null);
  const [limits, setLimits] = useState<Limits>({ rules: 24, groups: 6, terms: 4, slots: 2 });
  const [rooms, setRooms] = useState<Rooms | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Builder state. The pool half has no default: a wish must say which.
  const [seasonal, setSeasonal] = useState<boolean | null>(null);
  const [itemTags, setItemTags] = useState<SearchTag[]>([]);
  const [itemText, setItemText] = useState("");
  // "At least 0" is the open default: it accepts a bare item and every
  // enchanted one alike.
  const [slotMode, setSlotMode] = useState<SlotMode>("min");
  const [slotN, setSlotN] = useState(0);
  // One filter per enchantment slot: rows of chips, plus the text being
  // typed into each row. Sized to the slot count below.
  const [slots, setSlots] = useState<SearchTag[][][]>([]);
  const [slotText, setSlotText] = useState<string[][]>([]);
  useEffect(() => {
    setSlots((cur) => (cur.length === slotN ? cur : cur.length > slotN ? cur.slice(0, slotN) : [...cur, ...Array.from({ length: slotN - cur.length }, () => [[]] as SearchTag[][])]));
    setSlotText((cur) => (cur.length === slotN ? cur : cur.length > slotN ? cur.slice(0, slotN) : [...cur, ...Array.from({ length: slotN - cur.length }, () => [""])]));
  }, [slotN]);

  // The full enchant catalog: every name, and every effect flag any enchant
  // grants. Fetched here rather than threaded down — only this tab needs
  // the names.
  const [enchantNames, setEnchantNames] = useState<string[]>([]);
  const [effectKeys, setEffectKeys] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/enchant-catalog")
      .then((r) => r.json())
      .then((d: { enchants: { realmId: string; name: string }[] }) => {
        if (cancelled) return;
        const names = new Set<string>();
        const effects = new Set<string>();
        for (const e of d.enchants ?? []) {
          names.add(e.name);
          const id = Number(e.realmId);
          if (Number.isFinite(id)) for (const k of effectsOfEnchant(id)) effects.add(k);
        }
        setEnchantNames([...names].sort((a, b) => a.localeCompare(b)));
        setEffectKeys([...effects].sort());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!ign) {
      setRules(null);
      setAccess(null);
      return;
    }
    try {
      const r = await fetch("/api/wishlist", { cache: "no-store" });
      const d = (await r.json()) as { access?: boolean; rules?: Rule[]; room?: Rooms; limits?: Limits; error?: string };
      if (!r.ok) {
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setError("");
      setAccess(d.access ?? false);
      setRules(d.rules ?? []);
      if (d.room) setRooms(d.room);
      if (d.limits) setLimits(d.limits);
    } catch (e) {
      setError(String(e));
    }
  }, [ign]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const itemSuggestions = useMemo<Suggestions>(
    () => ({ items: itemTags.length ? NO_ITEMS : catalog.map((c) => ({ id: c.itemId, name: c.itemName })), enchants: [], effects: [] }),
    [catalog, itemTags.length],
  );
  // A row describes one enchantment, so once it holds a name only effects
  // are offered; effects already in the row drop out too.
  const rowSuggestions = useMemo<Suggestions[][]>(
    () =>
      slots.map((rows) =>
        rows.map((row) => {
          const used = new Set(row.map((t) => (t.kind === "ench" ? `ench:${t.name}` : t.kind === "effect" ? `effect:${t.key}` : "")));
          const named = row.some((t) => t.kind === "ench");
          return {
            items: NO_ITEMS,
            enchants: named ? [] : enchantNames.filter((n) => !used.has(`ench:${n}`)),
            effects: effectKeys.filter((k) => !used.has(`effect:${k}`)),
          };
        }),
      ),
    [slots, enchantNames, effectKeys],
  );

  const setRowTags = (si: number, ri: number, tags: SearchTag[]) =>
    setSlots((ss) => ss.map((rows, i) => (i === si ? rows.map((r, j) => (j === ri ? tags.slice(0, limits.terms) : r)) : rows)));
  const setRowInput = (si: number, ri: number, text: string) =>
    setSlotText((ss) => ss.map((rows, i) => (i === si ? rows.map((t, j) => (j === ri ? text : t)) : rows)));
  const addRow = (si: number) => {
    if ((slots[si]?.length ?? 0) >= limits.groups) return;
    setSlots((ss) => ss.map((rows, i) => (i === si ? [...rows, []] : rows)));
    setSlotText((ss) => ss.map((rows, i) => (i === si ? [...rows, ""] : rows)));
  };
  const removeRow = (si: number, ri: number) => {
    setSlots((ss) => ss.map((rows, i) => (i === si ? (rows.length === 1 ? [[]] : rows.filter((_, j) => j !== ri)) : rows)));
    setSlotText((ss) => ss.map((rows, i) => (i === si ? (rows.length === 1 ? [""] : rows.filter((_, j) => j !== ri)) : rows)));
  };

  const item = itemTags.find((t) => t.kind === "item");
  const room = rooms === null || seasonal === null ? null : seasonal ? rooms.seasonal : rooms.nonseasonal;
  const unallocated = room !== null && room.slots <= 0;
  const full = room !== null && room.free <= 0;
  const canSave = seasonal !== null && !!item && !busy && !full && slotN >= 0 && slotN <= limits.slots;

  async function save() {
    if (!item || item.kind !== "item" || seasonal === null) return;
    setBusy(true);
    try {
      const enchants: SlotSpec[] = slots.map((rows) => ({ any: rows.map((r) => ({ all: r.map(tagToTerm).filter((t): t is MatchTerm => t !== null) })).filter((g) => g.all.length) }));
      const body: Record<string, unknown> = { seasonal, itemId: item.id, enchants };
      if (slotMode === "min") body.slotsMin = slotN;
      if (slotMode === "exact") body.slotsExact = slotN;
      const r = await fetch("/api/wishlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = (await r.json()) as { error?: string; rule?: Rule; check?: { checked: boolean; claimed: { itemId: string } | null; why: string | null } };
      if (!r.ok) {
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setError("");
      // The wish looked the pool over on its way in.
      const c = d.check;
      const name = d.rule?.itemName ?? item.label;
      setNote(
        !c || !c.checked
          ? "Couldn't check the pool just now; new arrivals will still be matched."
          : c.claimed
            ? `A ${name} that fits was already in the pool — it's in your vault now.`
            : c.why
              ? `A ${name} that fits is in the pool but couldn't be claimed: ${c.why}`
              : "",
      );
      setItemTags([]);
      setItemText("");
      setSlotMode("min");
      setSlotN(0);
      setSlots([]);
      setSlotText([]);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: Rule) {
    setBusy(true);
    try {
      const r = await fetch("/api/wishlist", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }) });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) setError(d.error ?? `HTTP ${r.status}`);
      else setError("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: Rule) {
    setBusy(true);
    try {
      const r = await fetch("/api/wishlist", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: rule.id }) });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) setError(d.error ?? `HTTP ${r.status}`);
      else setError("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!ign) return <p className="wish-empty">Log in to keep a wishlist.</p>;
  if (access === false) return <p className="wish-empty">Your account doesn&apos;t have wishlist access.</p>;

  return (
    <div className="wish">
      <p className="wish-intro">
        A wish watches one pool — seasonal or non-seasonal — and is checked the moment you make it and on every change after. An item that fits goes straight into your vault for that pool, priced like a claim, and the wish is spent. Older wishes are served first, across all players. Each wish holds a slot in that vault, so items and wishes together can&apos;t exceed it.
      </p>

      <form
        className="wish-builder"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="wish-row">
          <label className="wish-label">Pool</label>
          <div className="wish-pool">
            <button type="button" className={"login-char-btn" + (seasonal === true ? " wish-pool-active" : "")} onClick={() => setSeasonal(true)}>
              Seasonal
            </button>
            <button type="button" className={"login-char-btn" + (seasonal === false ? " wish-pool-active" : "")} onClick={() => setSeasonal(false)}>
              Non-seasonal
            </button>
            {seasonal === null && <span className="wish-hint">pick which pool the wish watches</span>}
          </div>
        </div>
        <div className="wish-row">
          <label className="wish-label">Item</label>
          <TagSearch tags={itemTags} onTagsChange={(t) => setItemTags(t.filter((x) => x.kind === "item").slice(-1))} text={itemText} onTextChange={setItemText} suggestions={itemSuggestions} placeholder="Type an item name…" />
        </div>
        <div className="wish-row">
          <label className="wish-label">Slots</label>
          <div className="wish-slots">
            <select value={slotMode} onChange={(e) => setSlotMode(e.target.value as SlotMode)}>
              <option value="min">at least</option>
              <option value="exact">exactly</option>
            </select>
            <select value={slotN} onChange={(e) => setSlotN(Math.max(0, Math.min(limits.slots, Number(e.target.value) || 0)))}>
              {Array.from({ length: limits.slots + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="wish-hint">enchantment slots on the item (at most {limits.slots} — more can&apos;t be traded)</span>
          </div>
        </div>
        {slots.map((rows, si) => (
          <div key={si} className="wish-row">
            <label className="wish-label">Enchantment {si + 1}</label>
            <div className="wish-groups">
              {rows.map((row, ri) => (
                <div key={ri} className="wish-group">
                  {ri > 0 && <div className="wish-or">or</div>}
                  <div className="wish-group-row">
                    <TagSearch
                      tags={row}
                      onTagsChange={(t) => setRowTags(si, ri, t)}
                      text={slotText[si]?.[ri] ?? ""}
                      onTextChange={(t) => setRowInput(si, ri, t)}
                      suggestions={rowSuggestions[si]?.[ri] ?? { items: NO_ITEMS, enchants: [], effects: [] }}
                      placeholder={ri === 0 ? "Any enchantment — or a name, or effects it must have…" : "Or one that is…"}
                    />
                    {(rows.length > 1 || row.length > 0) && (
                      <button type="button" className="nav-link wish-group-x" onClick={() => removeRow(si, ri)} aria-label="Remove this row">
                        ×
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {rows.length < limits.groups && (
                <button type="button" className="nav-link wish-add-or" onClick={() => addRow(si)}>
                  + or…
                </button>
              )}
            </div>
          </div>
        ))}
        {slotN > 0 && (
          <div className="wish-row">
            <span />
            <div className="wish-hint">Each slot filters on its own. A row describes one enchantment — a name, or effects it must have; add an &ldquo;or&rdquo; row for alternatives. Leave a slot empty to accept any enchantment there.</div>
          </div>
        )}
        <div className="wish-actions">
          <button type="submit" className="btn" disabled={!canSave}>
            {busy ? "…" : "Add wish"}
          </button>
          {room ? (
            <span className="wish-hint">
              {unallocated
                ? `No vault slots allocated to the ${room.seasonal ? "seasonal" : "non-seasonal"} pool — open My Vault and give that tab some slots first.`
                : `${room.free} of ${room.slots} ${room.seasonal ? "seasonal" : "non-seasonal"} slot${room.slots === 1 ? "" : "s"} free · ${room.used} item${room.used === 1 ? "" : "s"} in that vault, ${room.wishes} wish${room.wishes === 1 ? "" : "es"}${full ? " — remove a wish or donate an item to add another" : ""}`}
            </span>
          ) : rooms ? (
            <span className="wish-hint">
              seasonal: {rooms.seasonal.free} of {rooms.seasonal.slots} free · non-seasonal: {rooms.nonseasonal.free} of {rooms.nonseasonal.slots} free
            </span>
          ) : null}
        </div>
      </form>

      {error && <p className="wish-error">{error}</p>}
      {note && <p className="wish-intro">{note}</p>}

      {rules === null ? (
        <p className="wish-empty">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="wish-empty">No wishes yet.</p>
      ) : (
        <ul className="wish-list">
          {rules.map((r) => (
            <li key={r.id} className={"wish-rule" + (r.enabled ? "" : " off")}>
              <div className="wish-rule-item">
                <ItemSprite name={r.itemName} size={28} />
                <div className="wish-rule-text">
                  <div className="wish-rule-name">{r.itemName}</div>
                  <div className="wish-rule-meta">
                    <span className="wish-rule-pool">{r.seasonal ? "seasonal" : "non-seasonal"}</span>
                    {" · "}
                    {slotsText(r)}
                    {" · waiting since "}
                    {ago(r.createdAt)}
                    {!r.enabled && " · paused"}
                  </div>
                </div>
              </div>
              <div className="wish-rule-match">
                {r.enchants.length === 0 ? (
                  <span className="wish-hint">any enchantments</span>
                ) : (
                  r.enchants.map((spec, si) => (
                    <span key={si} className="wish-rule-slot">
                      <span className="wish-rule-slot-n">{si + 1}</span>
                      {spec.any.length === 0 ? (
                        <span className="wish-hint">any</span>
                      ) : (
                        spec.any.map((g, i) => (
                          <span key={i} className="wish-rule-group">
                            {i > 0 && <span className="wish-or-inline">or</span>}
                            {g.all.map((t) => {
                              const tag = termToTag(t);
                              return (
                                <span key={tag.kind + tag.label} className={"tag-chip tag-" + tag.kind}>
                                  <span className="tag-chip-label">{tag.label}</span>
                                </span>
                              );
                            })}
                          </span>
                        ))
                      )}
                    </span>
                  ))
                )}
              </div>
              <div className="wish-rule-actions">
                <button type="button" className="nav-link" disabled={busy} onClick={() => void toggle(r)}>
                  {r.enabled ? "pause" : "resume"}
                </button>
                <button type="button" className="nav-link" disabled={busy} onClick={() => void remove(r)}>
                  remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
