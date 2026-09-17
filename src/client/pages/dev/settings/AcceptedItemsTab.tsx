import { useCallback, useEffect, useMemo, useState } from "react";
import { ItemSprite } from "@/components/ItemSprite";
// Which catalog items this node takes in (src/lib/itemPolicy.ts). The
// catalog is every item the game lets players trade; the rules below set
// what the bots accept by default, and a pin per item beats the rules.
// Saved into the node's settings; the bots and the site's forms follow at
// once. Items already in the pool stay withdrawable whatever the policy.

type Group = "Weapon" | "Armor" | "Ring" | "Ability";
type Policy = { potions: boolean; eggs: boolean; consumables: boolean; untiered: boolean; minTier: Record<Group, number | null>; overrides: Record<string, boolean> };
type Entry = { id: string; name: string; category: string };
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
  return p.untiered;
}
const accepts = (p: Policy, e: Entry): boolean => p.overrides[e.id] ?? ruleAccepts(p, e);

export default function AcceptedItemsTab({ password }: { password: string }) {
  const [state, setState] = useState<State | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "taken" | "refused" | "pinned">("all");
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
  const counts = useMemo(() => {
    if (!state || !policy) return { taken: 0, total: 0 };
    return { taken: state.catalog.filter((e) => accepts(policy, e)).length, total: state.catalog.length };
  }, [state, policy]);
  const rows = useMemo(() => {
    if (!state || !policy) return [];
    const q = query.trim().toLowerCase();
    return state.catalog.filter((e) => {
      if (q && !e.name.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) return false;
      const a = accepts(policy, e);
      if (only === "taken") return a;
      if (only === "refused") return !a;
      if (only === "pinned") return policy.overrides[e.id] !== undefined;
      return true;
    });
  }, [state, policy, query, only]);
  const setPin = (id: string, v: boolean | undefined) => setPolicy((p) => {
    if (!p) return p;
    const overrides = { ...p.overrides };
    if (v === undefined) delete overrides[id]; else overrides[id] = v;
    return { ...p, overrides };
  });

  if (!state || !policy) return <section>{error ? <p style={{ color: "var(--bad)" }}>{error}</p> : <p className="hint">loading…</p>}</section>;
  const everything: Policy = { potions: true, eggs: true, consumables: true, untiered: true, minTier: { Weapon: 0, Armor: 0, Ring: 0, Ability: 0 }, overrides: {} };
  return (
    <section>
      {error && <p style={{ color: "var(--bad)" }}>{error}</p>}
      {notice && <p style={{ color: "var(--good, #5aa86a)" }}>{notice}</p>}
      <p style={{ color: "var(--muted, #999)", fontSize: 13, maxWidth: 760 }}>
        The catalog is every item the game lets players trade ({state.total}). Choose what this node's bots take in: a deposit that offers
        anything else is held until the player takes it back out of the window, and offers, hand-overs and declared deposits are refused up front.
        Items already in the pool stay withdrawable. Pins on single items beat the rules.
      </p>
      <p><b>Taking {counts.taken} of {counts.total} items.</b>{dirty ? " (unsaved changes)" : ""}</p>

      <div style={{ display: "grid", gap: 6, maxWidth: 560, margin: "8px 0 12px" }}>
        {([["potions", "Stat potions (Potion of X, Greater Potion of X)"], ["eggs", "Eggs"], ["consumables", "Other consumables (wines, tinctures, keys, event items)"], ["untiered", "UT and ST gear"]] as const).map(([k, label]) => (
          <label key={k}><input type="checkbox" checked={policy[k]} onChange={(e) => setPolicy({ ...policy, [k]: e.target.checked })} /> {label}</label>
        ))}
        {GROUPS.map((g) => (
          <label key={g.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ width: 90 }}>{g.label}</span>
            <select value={policy.minTier[g.id] === null ? "none" : String(policy.minTier[g.id])} onChange={(e) => setPolicy({ ...policy, minTier: { ...policy.minTier, [g.id]: e.target.value === "none" ? null : Number(e.target.value) } })}>
              <option value="none">none</option>
              {Array.from({ length: g.maxTier + 1 }, (_, t) => <option key={t} value={t}>{t === 0 ? "every tier" : `T${t} and up`}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <button disabled={busy || !dirty} onClick={() => void save(policy)}>Save</button>
        <button className="nav-link" disabled={busy || !dirty} onClick={() => setPolicy(state.policy)}>discard changes</button>
        <button className="nav-link" disabled={busy} onClick={() => setPolicy(everything)}>take everything</button>
        <button className="nav-link" disabled={busy} onClick={() => setPolicy({ ...everything, eggs: false, consumables: false, untiered: false, minTier: { Weapon: null, Armor: null, Ring: null, Ability: null } })}>only stat potions</button>
        <button className="nav-link" disabled={busy || !Object.keys(policy.overrides).length} onClick={() => setPolicy({ ...policy, overrides: {} })}>clear all pins</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search items or categories…" style={{ width: 260 }} />
        <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
          <option value="all">all</option><option value="taken">taken</option><option value="refused">refused</option><option value="pinned">pinned</option>
        </select>
        <span className="hint">{rows.length} shown</span>
      </div>
      <ul className="storage-list" style={{ marginTop: 8 }}>
        {rows.slice(0, 300).map((e) => {
          const pin = policy.overrides[e.id];
          const a = accepts(policy, e);
          return (
            <li key={e.id} className={a ? "" : "muted"}>
              <span className="storage-item" style={{ minWidth: 260 }}><ItemSprite name={e.name} size={18} /> {e.name}</span>
              <span className="muted" style={{ minWidth: 110 }}>{e.category}</span>
              <span style={{ minWidth: 70, color: a ? "var(--good, #5aa86a)" : "var(--bad)" }}>{a ? "taken" : "refused"}</span>
              <select value={pin === undefined ? "rules" : pin ? "always" : "never"} onChange={(ev) => setPin(e.id, ev.target.value === "rules" ? undefined : ev.target.value === "always")}>
                <option value="rules">follow rules</option><option value="always">always take</option><option value="never">never take</option>
              </select>
            </li>
          );
        })}
        {rows.length > 300 && <li className="muted">…{rows.length - 300} more; narrow the search</li>}
      </ul>
    </section>
  );
}
