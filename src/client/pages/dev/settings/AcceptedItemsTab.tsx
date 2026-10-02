import { useCallback, useEffect, useMemo, useState } from "react";
import { acceptedIds, COMMUNISM_ITEM_POLICY } from "@/lib/itemPolicy";
const COMMUNISM_ACCEPTED = acceptedIds(COMMUNISM_ITEM_POLICY).size;
import { ItemSprite } from "@/components/ItemSprite";
// Which catalog items this node takes in (src/lib/itemPolicy.ts). The
// catalog is every item the game lets players trade; the rules below set
// what the bots accept by default, and a pin per item beats the rules.
// Saved into the node's settings; the bots and the site's forms follow at
// once. Items already in the pool stay withdrawable whatever the policy.
//
// The whole catalog is on screen, grouped (stat potions, eggs, consumables,
// UT/ST gear, one section per tier) as small tiles: green is taken, red
// refused. Clicking a tile flips it; a section's buttons flip every item in
// it; the bulk switches above set whole groups. Underneath, the policy is
// still rules plus per-item exceptions (src/lib/itemPolicy.ts) — a click
// records an exception, a bulk switch clears the exceptions it covers, so
// what you see is always what the bots do. ~1000 tiles are cheap to draw:
// the sprite is a background on a span, not an image, and nothing polls.

type Group = "Weapon" | "Armor" | "Ring" | "Ability";
type Policy = { potions: boolean; eggs: boolean; consumables: boolean; lore: boolean; treasures: boolean; skins: boolean; untiered: boolean; minTier: Record<Group, number | null>; overrides: Record<string, boolean> };
type Entry = { id: string; name: string; category: string; subtype?: string | null };
type State = { policy: Policy; accepted: number; total: number; everything: boolean; catalog: Entry[] };

const GROUPS: { id: Group; label: string; maxTier: number }[] = [
  { id: "Weapon", label: "Weapons", maxTier: 13 }, { id: "Armor", label: "Armor", maxTier: 13 }, { id: "Ring", label: "Rings", maxTier: 6 }, { id: "Ability", label: "Abilities", maxTier: 6 },
];
const tierOf = (category: string): { group: Group; tier: number } | null => {
  const m = /^T(\d+) (Weapon|Armor|Ring|Ability)$/.exec(category);
  return m ? { group: m[2] as Group, tier: Number(m[1]) } : null;
};
function ruleAccepts(p: Policy, e: Entry): boolean {
  const t = tierOf(e.category);
  if (t) { const min = p.minTier[t.group]; return min !== null && t.tier >= min; }
  if (e.category === "Potion") return p.potions;
  if (e.category === "Egg") return p.eggs;
  if (e.category === "Consumable") return p.consumables;
  if (e.category === "Lore") return p.lore;
  if (e.category === "Treasure") return p.treasures;
  if (e.category === "Skin") return p.skins;
  return p.untiered;
}
const accepts = (p: Policy, e: Entry): boolean => p.overrides[e.id] ?? ruleAccepts(p, e);

/** The sections the catalog is shown in, in order. Tiered gear is one section per tier, highest first. */
type Section = { id: string; label: string; entries: Entry[]; note?: string };
function sectionsOf(catalog: Entry[]): Section[] {
  const by = (pred: (e: Entry) => boolean) => catalog.filter(pred);
  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  const out: Section[] = [
    { id: "potions", label: "Stat potions", entries: by((e) => e.category === "Potion").sort(byName) },
    { id: "eggs", label: "Eggs", entries: by((e) => e.category === "Egg").sort(byName) },
    { id: "consumables", label: "Other consumables", entries: by((e) => e.category === "Consumable").sort(byName) },
    { id: "lore", label: "Lore", entries: by((e) => e.category === "Lore").sort(byName), note: "books, letters and journals" },
    { id: "treasures", label: "Dungeon treasures", entries: by((e) => e.category === "Treasure").sort(byName), note: "the old dungeon treasure sets" },
    // Skins by class, then name, so a class's skins sit together.
    { id: "skins", label: "Skins", entries: by((e) => e.category === "Skin").sort((a, b) => (a.subtype ?? "zz").localeCompare(b.subtype ?? "zz") || a.name.localeCompare(b.name)), note: "every tradeable character skin" },
  ];
  // UT/ST as one section, sorted by slot so a staff is next to the other staves.
  const ut = by((e) => e.category === "UT/ST").sort((a, b) => (a.subtype ?? "zz").localeCompare(b.subtype ?? "zz") || a.name.localeCompare(b.name));
  out.push({ id: "ut", label: "UT and ST gear", entries: ut });
  // Tiered gear: one section per tier, highest first; inside it weapons, armor, rings, abilities, each by name.
  const tiered = by((e) => tierOf(e.category) !== null);
  const tiers = [...new Set(tiered.map((e) => tierOf(e.category)!.tier))].sort((a, b) => b - a);
  const groupOrder = (e: Entry) => GROUPS.findIndex((g) => g.id === tierOf(e.category)!.group);
  for (const t of tiers) {
    const entries = tiered.filter((e) => tierOf(e.category)!.tier === t).sort((a, b) => groupOrder(a) - groupOrder(b) || a.name.localeCompare(b.name));
    out.push({ id: `tier-${t}`, label: `T${t} gear`, entries });
  }
  const placed = new Set(out.flatMap((s) => s.entries.map((e) => e.id)));
  const rest = catalog.filter((e) => !placed.has(e.id)).sort(byName);
  if (rest.length) out.push({ id: "other", label: "Everything else", entries: rest });
  return out.filter((s) => s.entries.length);
}

export default function AcceptedItemsTab({ password }: { password: string }) {
  const [state, setState] = useState<State | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "taken" | "refused">("all");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const headers = { "X-Dev-Password": password, "Content-Type": "application/json" };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/items", { headers, cache: "no-store" });
      const d = await r.json();
      if (!r.ok) setError(d.error || `HTTP ${r.status}`);
      else { setState(d as State); setPolicy((d as State).policy); setError(""); }
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);
  useEffect(() => { void load(); }, [load]);

  async function save(next: Policy) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/dev/items", { method: "POST", headers, body: JSON.stringify({ policy: next }) });
      const d = await r.json();
      if (!r.ok) setError(d.error || `HTTP ${r.status}`);
      else {
        setState((s) => (s ? { ...s, policy: d.policy, accepted: d.accepted, total: d.total, everything: d.everything } : s));
        setPolicy(d.policy);
        setNotice(`Saved: the node takes ${d.accepted} of ${d.total} items.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const dirty = !!state && !!policy && JSON.stringify(policy) !== JSON.stringify(state.policy);
  const sections = useMemo(() => (state ? sectionsOf(state.catalog) : []), [state]);
  const counts = useMemo(() => {
    if (!state || !policy) return { taken: 0, total: 0 };
    return { taken: state.catalog.filter((e) => accepts(policy, e)).length, total: state.catalog.length };
  }, [state, policy]);
  // The filter narrows every section; a section with nothing left is skipped.
  const visible = useMemo(() => {
    if (!policy) return [];
    const q = query.trim().toLowerCase();
    return sections.map((s) => ({
      ...s,
      entries: s.entries.filter((e) => {
        if (q && !e.name.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q) && !(e.subtype ?? "").toLowerCase().includes(q)) return false;
        const a = accepts(policy, e);
        if (only === "taken") return a;
        if (only === "refused") return !a;
        return true;
      }),
    })).filter((s) => s.entries.length);
  }, [sections, policy, query, only]);
  /** Set these items to taken or refused: an exception where the rule says otherwise, none where it agrees. */
  const setItems = (items: Entry[], v: boolean) => setPolicy((p) => {
    if (!p) return p;
    const overrides = { ...p.overrides };
    for (const e of items) { if (ruleAccepts(p, e) === v) delete overrides[e.id]; else overrides[e.id] = v; }
    return { ...p, overrides };
  });
  const toggle = (e: Entry) => { if (policy) setItems([e], !accepts(policy, e)); };
  /** A bulk switch changes the rule and drops the exceptions it covers, so it visibly takes effect. */
  const setRule = (patch: Partial<Policy>, covers: (e: Entry) => boolean) => setPolicy((p) => {
    if (!p || !state) return p;
    const overrides = { ...p.overrides };
    for (const e of state.catalog) if (covers(e)) delete overrides[e.id];
    return { ...p, ...patch, overrides };
  });

  if (!state || !policy) return <section>{error ? <p style={{ color: "var(--bad)" }}>{error}</p> : <p className="hint">loading…</p>}</section>;
  const everything: Policy = { potions: true, eggs: true, consumables: true, lore: true, treasures: true, skins: true, untiered: true, minTier: { Weapon: 0, Armor: 0, Ring: 0, Ability: 0 }, overrides: {} };
  const shown = visible.reduce((n, s) => n + s.entries.length, 0);
  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 760, marginTop: 0 }}>
        The catalog is every item the game lets players trade ({state.total}). Choose what this node&apos;s bots take in: a deposit that offers
        anything else is held until the player takes it back out of the window, and offers, hand-overs and declared deposits are refused up front.
        Items already in the pool stay withdrawable. The switches set whole groups; click any item to flip it on its own.
      </p>
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 760, marginTop: 0 }}>
        <b>Communism accounts are not affected.</b> They accept by a list fixed in the node ({COMMUNISM_ACCEPTED} of {state.total} items, taken from this
        node&apos;s selection on 2026-09-22), whatever is set here.
      </p>

      <div className="items-rules">
        <div className="items-rules-col">
          {([["potions", "Stat potions", "Potion"], ["eggs", "Eggs", "Egg"], ["consumables", "Other consumables (wines, tinctures, keys, event items)", "Consumable"], ["lore", "Lore (books, letters, journals)", "Lore"], ["treasures", "Dungeon treasures", "Treasure"], ["skins", "Skins", "Skin"], ["untiered", "UT and ST gear", "UT/ST"]] as const).map(([k, label, cat]) => (
            <label key={k}><input type="checkbox" checked={policy[k]} onChange={(e) => setRule({ [k]: e.target.checked }, (it) => it.category === cat)} /> {label}</label>
          ))}
        </div>
        <div className="items-rules-col">
          {GROUPS.map((g) => (
            <label key={g.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 80 }}>{g.label}</span>
              <select value={policy.minTier[g.id] === null ? "none" : String(policy.minTier[g.id])} onChange={(e) => setRule({ minTier: { ...policy.minTier, [g.id]: e.target.value === "none" ? null : Number(e.target.value) } }, (it) => tierOf(it.category)?.group === g.id)}>
                <option value="none">none</option>
                {Array.from({ length: g.maxTier + 1 }, (_, t) => <option key={t} value={t}>{t === 0 ? "every tier" : `T${t} and up`}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>
      <div className="items-bar">
        <b>Taking {counts.taken} of {counts.total} items.</b>{dirty && <span className="warn"> unsaved changes</span>}
        <button disabled={busy || !dirty} onClick={() => void save(policy)}>Save</button>
        <button className="login-char-btn" disabled={busy || !dirty} onClick={() => setPolicy(state.policy)}>discard</button>
        <button className="login-char-btn" disabled={busy} onClick={() => setPolicy(everything)}>take everything</button>
        <button className="login-char-btn" disabled={busy} onClick={() => setPolicy({ ...everything, eggs: false, consumables: false, untiered: false, minTier: { Weapon: null, Armor: null, Ring: null, Ability: null } })}>only stat potions</button>
      </div>

      <div className="items-bar" style={{ marginTop: 8 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter by name, category or slot…" style={{ width: 260 }} />
        <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
          <option value="all">all</option><option value="taken">taken</option><option value="refused">refused</option>
        </select>
        <span className="hint" style={{ margin: 0, padding: 0, border: 0, background: "none" }}>{shown} of {counts.total} shown · click an item to flip it</span>
        <button className="login-char-btn" onClick={() => setClosed(new Set())} disabled={!closed.size}>expand all</button>
        <button className="login-char-btn" onClick={() => setClosed(new Set(sections.map((s) => s.id)))}>collapse all</button>
      </div>

      {visible.map((s) => {
        const taken = s.entries.filter((e) => accepts(policy, e)).length;
        const open = !closed.has(s.id);
        return (
          <section key={s.id} className="items-section">
            <header className="items-head">
              <button className="nav-link items-toggle" onClick={() => setClosed((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} aria-expanded={open}>
                {open ? "▾" : "▸"} {s.label}
              </button>
              <span className="muted">{taken}/{s.entries.length} taken</span>
              <span className="items-head-actions">
                <button className="login-char-btn" title="Take every item in this section" onClick={() => setItems(s.entries, true)}>take all</button>
                <button className="login-char-btn" title="Refuse every item in this section" onClick={() => setItems(s.entries, false)}>refuse all</button>
                <button className={"login-char-btn" + (dirty ? " active" : "")} disabled={busy || !dirty} title={dirty ? "Save every change on this tab" : "Nothing to save"} onClick={() => void save(policy)}>{busy ? "…" : dirty ? "save" : "saved"}</button>
              </span>
            </header>
            {open && (
              <div className="items-grid">
                {s.entries.map((e) => {
                  const a = accepts(policy, e);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      className={"item-chip" + (a ? " taken" : " refused")}
                      title={`${e.name} · ${e.category}${e.subtype ? ` · ${e.subtype}` : ""} · ${a ? "taken" : "refused"} · click to flip`}
                      aria-pressed={a}
                      onClick={() => toggle(e)}
                    >
                      <ItemSprite name={e.name} size={22} className="item-chip-spr" fallbackClassName="item-chip-fallback" />
                      <span className="item-chip-name">{e.name}</span>
                      <span className="item-chip-state" aria-hidden="true">{a ? "✓" : "✕"}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      {visible.length === 0 && <p className="muted">Nothing matches.</p>}
    </section>
  );
}
