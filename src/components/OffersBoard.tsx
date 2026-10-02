import { useMemo, useState } from "react";
import itemIndex from "@/lib/item-index.json";
import itemTooltips from "@/lib/item-tooltips.json";
import { ItemSprite } from "./ItemSprite";
import { Slot, ago } from "./TradeBits";
import type { Offer } from "./TradePanel";

// One half's open offers on the hub. The items the offers name sit on top as
// tiles, each saying how many offers give it and how many ask for it (an
// item nobody trades is not shown); the offers are listed underneath, each
// saying straight away whether this node could take it and with what. A
// tile, the search box and the category chips narrow the list.

type CatalogLike = { itemId: string; itemName: string; category?: string; subtype?: string | null };
export type OfferPick = { instanceId: string; itemId: string; name: string; enchantIds: number[]; botIgn: string; stored?: boolean; offers?: number[] };
export type OfferPreview = { ok: boolean; text?: string; picks?: OfferPick[] };

type ItemMeta = { slot: string | null; dismantle?: unknown };
const ITEM_INDEX = itemIndex as unknown as Record<string, ItemMeta>;
const ITEM_KIND = itemTooltips as unknown as Record<string, { t: string | null; k: string }>;
const norm = (n: string) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

const GROUPS = [
  { key: "consumables", label: "Consumables" },
  { key: "weapons", label: "Weapons" },
  { key: "abilities", label: "Abilities" },
  { key: "armors", label: "Armors" },
  { key: "rings", label: "Rings" },
  { key: "eggs", label: "Pet eggs" },
  { key: "skins", label: "Skins" },
  { key: "misc", label: "Other" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

type ItemInfo = { itemId: string; name: string; group: GroupKey };

/** Which chip an item falls under, by its catalog category and its equipment slot. */
function classify(c: CatalogLike): ItemInfo {
  const n = norm(c.itemName);
  const slot = ITEM_INDEX[n]?.slot;
  const cat = c.category ?? "";
  const base = { itemId: c.itemId, name: c.itemName };
  if (cat === "Potion" || cat === "Consumable" || ITEM_KIND[n]?.k === "Stat Potion") return { ...base, group: "consumables" };
  if (cat === "Egg") return { ...base, group: "eggs" };
  if (cat === "Skin") return { ...base, group: "skins" };
  if (slot === "weapon") return { ...base, group: "weapons" };
  if (slot === "ability") return { ...base, group: "abilities" };
  if (slot === "armor") return { ...base, group: "armors" };
  if (slot === "ring") return { ...base, group: "rings" };
  if (slot === "consumable") return { ...base, group: "consumables" };
  return { ...base, group: "misc" };
}

type Dir = "give" | "want" | "any";
const DIR_WORD: Record<Dir, string> = { give: "giving", want: "asking for", any: "with" };
const SORTS = [
  { key: "new", label: "Newest first" },
  { key: "take", label: "Ones I can take first" },
  { key: "old", label: "Oldest first" },
  { key: "trader", label: "By trader" },
  { key: "server", label: "By server" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function OffersBoard({ offers, seasonal, catalog, previews, busy, onPreview, onAccept, onPostOwn, onManageMine }: {
  /** This half's open offers, the node's own included. */
  offers: Offer[];
  seasonal: boolean;
  catalog: CatalogLike[];
  /** Per offer: whether this node could take it now, and with what. */
  previews: Record<number, OfferPreview>;
  busy: boolean;
  onPreview: (o: Offer) => void;
  onAccept: (o: Offer) => void;
  /** Open the trade desk on this half, to post an offer. */
  onPostOwn?: () => void;
  /** Open My offers, where the node's own are managed. */
  onManageMine?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupKey | "all">("all");
  const [pick, setPick] = useState<{ itemId: string; dir: Dir } | null>(null);
  const [takeOnly, setTakeOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("new");
  const half = seasonal ? "seasonal" : "non-seasonal";

  const info = useMemo(() => {
    const m = new Map<string, ItemInfo>();
    for (const c of catalog) if (!m.has(c.itemId)) m.set(c.itemId, classify(c));
    for (const o of offers) for (const it of [...o.give, ...o.want]) if (!m.has(it.itemId)) m.set(it.itemId, classify({ itemId: it.itemId, itemName: it.name }));
    return m;
  }, [catalog, offers]);
  const nameOf = (id: string) => info.get(id)?.name ?? id;

  const canTake = (o: Offer) => !o.mine && previews[o.id]?.ok === true;
  const idsOf = (o: Offer, dir: Dir) => (dir === "give" ? o.give.map((g) => g.itemId) : dir === "want" ? o.want.map((w) => w.itemId) : [...o.give.map((g) => g.itemId), ...o.want.map((w) => w.itemId)]);
  const q = query.trim().toLowerCase();
  const matchesQuery = (id: string) => !q || nameOf(id).toLowerCase().includes(q);
  const inGroup = (id: string) => group === "all" || info.get(id)?.group === group;

  // What the tiles count: the offers in view once "only ones I can take" is applied.
  const base = takeOnly ? offers.filter(canTake) : offers;
  const counts = { give: new Map<string, number>(), want: new Map<string, number>() };
  for (const o of base) {
    for (const id of new Set(idsOf(o, "give"))) counts.give.set(id, (counts.give.get(id) ?? 0) + 1);
    for (const id of new Set(idsOf(o, "want"))) counts.want.set(id, (counts.want.get(id) ?? 0) + 1);
  }
  const traded = [...new Set([...counts.give.keys(), ...counts.want.keys()])].filter(matchesQuery);
  const groupsHere = GROUPS.map((g) => ({ ...g, n: traded.filter((id) => info.get(id)?.group === g.key).length })).filter((g) => g.n > 0);
  const total = (id: string) => (counts.give.get(id) ?? 0) + (counts.want.get(id) ?? 0);
  const tiles = traded.filter(inGroup).sort((a, b) => total(b) - total(a) || nameOf(a).localeCompare(nameOf(b)));

  // The offers themselves, narrowed by the search, the chip and the picked tile.
  const rows = base.filter((o) => {
    const ids = idsOf(o, "any");
    if (q && !ids.some(matchesQuery)) return false;
    if (group !== "all" && !ids.some(inGroup)) return false;
    return !pick || idsOf(o, pick.dir).includes(pick.itemId);
  });
  rows.sort((a, b) => {
    switch (sort) {
      case "old": return a.createdAt - b.createdAt;
      case "take": return Number(canTake(b)) - Number(canTake(a)) || b.createdAt - a.createdAt;
      case "trader": return (a.mine ? "" : a.poster).localeCompare(b.mine ? "" : b.poster) || b.createdAt - a.createdAt;
      case "server": return a.server.localeCompare(b.server) || b.createdAt - a.createdAt;
      default: return b.createdAt - a.createdAt;
    }
  });

  const traders = new Set(offers.map((o) => (o.mine ? "\u0000me" : o.poster))).size;
  const takeable = offers.filter(canTake).length;
  const filtered = !!q || group !== "all" || !!pick || takeOnly;
  const clear = () => {
    setQuery("");
    setGroup("all");
    setPick(null);
    setTakeOnly(false);
  };
  const choose = (itemId: string, dir: Dir) => setPick((p) => (p && p.itemId === itemId && p.dir === dir ? null : { itemId, dir }));

  if (!offers.length) {
    return (
      <div className="offers-board">
        <div className="offers-empty">
          <p>No {half} offers on the hub right now.</p>
          {onPostOwn && <button className="tx-submit" type="button" onClick={onPostOwn}>Post an offer</button>}
        </div>
      </div>
    );
  }

  const slotButton = (key: string, itemId: string, dir: "give" | "want", slot: React.ReactNode) => (
    <button key={key} type="button" className={"offer-slot-btn" + (pick?.itemId === itemId ? " picked" : "")} title={`Only offers ${DIR_WORD[dir]} ${nameOf(itemId)}`} onClick={() => choose(itemId, dir)}>
      {slot}
    </button>
  );

  return (
    <div className="offers-board">
      <div className="offers-top">
        <p className="offers-summary">
          <b>{plural(offers.length, `${half} offer`)}</b> from {plural(traders, "trader")}
          {takeable > 0 && <> · <b className="offers-takeable">{takeable}</b> you can take</>}
        </p>
        <div className="offers-tools">
          <input className="pool-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the items on offer…" aria-label="Search the items on offer" />
          <label title="Offers this node holds the asked-for items for, on one account with room for what comes back">
            <input type="checkbox" checked={takeOnly} onChange={(e) => setTakeOnly(e.target.checked)} /> only ones I can take
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Order">
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {groupsHere.length > 1 && (
        <div className="offers-chips">
          <button type="button" className={"offers-chip" + (group === "all" ? " active" : "")} onClick={() => setGroup("all")}>All<span className="n">{traded.length}</span></button>
          {groupsHere.map((g) => (
            <button key={g.key} type="button" className={"offers-chip" + (group === g.key ? " active" : "")} onClick={() => setGroup(g.key)}>{g.label}<span className="n">{g.n}</span></button>
          ))}
        </div>
      )}

      <div className="offers-items">
        <div className="offers-items-head">
          <span>Items on offer</span>
          <span className="offers-legend"><span className="give">■</span> offers giving it <span className="want">■</span> offers asking for it · click one to narrow the list</span>
        </div>
        {tiles.length ? (
          <div className="offers-tiles">
            {tiles.map((id) => {
              const give = counts.give.get(id) ?? 0;
              const want = counts.want.get(id) ?? 0;
              return (
                <span key={id} className={"offer-tile" + (pick?.itemId === id ? " picked" : "")}>
                  <button type="button" className="offer-tile-main" title={`${nameOf(id)}: ${give} giving, ${want} asking`} onClick={() => choose(id, "any")}>
                    <ItemSprite name={nameOf(id)} className="offer-tile-img" fallbackClassName="offer-tile-fallback" />
                  </button>
                  {give > 0 && <button type="button" className="offer-badge give" title={`${plural(give, "offer")} giving ${nameOf(id)}`} onClick={() => choose(id, "give")}>{give}</button>}
                  {want > 0 && <button type="button" className="offer-badge want" title={`${plural(want, "offer")} asking for ${nameOf(id)}`} onClick={() => choose(id, "want")}>{want}</button>}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="hint">No item on offer matches.</p>
        )}
      </div>

      {pick && (
        <div className="offers-pick">
          <span>Offers</span>
          <span className="offers-seg" role="group">
            {(["give", "want", "any"] as const).map((d) => (
              <button key={d} type="button" className={pick.dir === d ? "active" : ""} onClick={() => setPick({ itemId: pick.itemId, dir: d })}>{DIR_WORD[d]}</button>
            ))}
          </span>
          <span className="offers-pick-item"><ItemSprite name={nameOf(pick.itemId)} className="offer-pick-img" fallbackClassName="offer-tile-fallback" />{nameOf(pick.itemId)}</span>
          <button type="button" className="nav-link" onClick={() => setPick(null)}>✕ show all</button>
        </div>
      )}

      <div className="offers-list">
        {rows.length === 0 && (
          <p className="hint">No offer matches{filtered && <>. <button type="button" className="nav-link" onClick={clear}>Clear the filters</button></>}</p>
        )}
        {rows.map((o) => {
          const pv = previews[o.id];
          return (
            <article key={o.id} className={"offer-row" + (o.mine ? " mine" : pv?.ok ? " takeable" : "")}>
              <div className="offer-row-trade">
                <div className="offer-row-side">
                  <span className="offer-row-label">{o.mine ? "you give" : "gives"}</span>
                  <div className="trade-slots">
                    {o.give.map((g) => slotButton(g.ref, g.itemId, "give", <Slot name={g.name} count={g.count} title={`${g.name}${g.count ? ` · ${plural(g.count, "enchantment")}` : ""}`} />))}
                  </div>
                </div>
                <span className="offer-row-arrow" aria-hidden="true">⇄</span>
                <div className="offer-row-side">
                  <span className="offer-row-label">{o.mine ? "you want" : "wants"}</span>
                  <div className="trade-slots">
                    {o.want.map((w, i) => slotButton(`w${i}`, w.itemId, "want", <Slot name={w.name} qty={w.qty} filter={w.slotsExact !== null ? `=${w.slotsExact}` : w.slotsMin ? `${w.slotsMin}+` : (w.enchants?.length ?? 0) ? "f" : undefined} title={`${w.qty}× ${w.name}${w.slotsExact !== null ? ` with exactly ${w.slotsExact} enchantments` : w.slotsMin ? ` with ${w.slotsMin}+ enchantments` : ""}${(w.enchants?.length ?? 0) ? " · enchantment filter" : ""}`} />))}
                  </div>
                </div>
              </div>
              <div className="offer-row-meta">
                <span className="offer-row-who">{o.mine ? "Your offer" : o.poster}</span>
                <span className="muted">{o.server} · <span title={new Date(o.createdAt).toLocaleString()}>{ago(o.createdAt)}</span></span>
              </div>
              <div className="offer-row-act">
                {o.mine ? (
                  <>
                    {o.heldBy !== undefined && <span className="offer-row-why">on hold: meeting #{o.heldBy} has one of its items</span>}
                    {onManageMine && <button type="button" className="nav-link" onClick={onManageMine}>manage in My offers</button>}
                  </>
                ) : pv?.ok && pv.picks ? (
                  <>
                    <span className="offer-row-picks">
                      you give from {pv.picks[0].botIgn}
                      <span className="trade-slots small">{pv.picks.map((p) => <Slot key={p.instanceId} name={p.name} count={p.enchantIds.length} title={`${p.name}${p.stored ? " · in storage, fetched before the meeting" : ""}${p.offers?.length ? ` · also in your offer${p.offers.length === 1 ? "" : "s"} ${p.offers.map((id) => `#${id}`).join(", ")}` : ""}`} />)}</span>
                    </span>
                    <button type="button" className="tx-submit" disabled={busy} onClick={() => onAccept(o)}>Accept</button>
                  </>
                ) : pv ? (
                  <span className="offer-row-why" title={pv.text}>{pv.text}</span>
                ) : (
                  <button type="button" className="nav-link" disabled={busy} onClick={() => onPreview(o)}>what would I give?</button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
