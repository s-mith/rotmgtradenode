import { ItemSprite } from "./ItemSprite";

// The pieces every trade on the vault page is drawn with (TradePanel,
// CommonsPanel): an item slot like the in-game window's, a padded row of
// them, and the two-sided ticket.

/** One item slot: a sprite with optional badges. `sprite` is a data URL from the pool; otherwise the atlas by name. */
export function Slot({ name, sprite, count, qty, filter, title, onRemove, dim }: { name?: string; sprite?: string | null; count?: number; qty?: number; filter?: string; title?: string; onRemove?: () => void; dim?: boolean }) {
  if (!name) return <span className="trade-slot empty" />;
  return (
    <span className={"trade-slot" + (dim ? " dim" : "")} title={title ?? name}>
      {sprite ? <img src={sprite} alt="" className="trade-slot-img" /> : <ItemSprite name={name} className="trade-slot-img" fallbackClassName="trade-slot-fallback" />}
      {count ? <span className="trade-badge ench">{count}</span> : null}
      {qty && qty > 1 ? <span className="trade-badge qty">×{qty}</span> : null}
      {filter ? <span className="trade-badge filter">{filter}</span> : null}
      {onRemove && <button className="trade-slot-x" type="button" onClick={onRemove} aria-label={`remove ${name}`}>×</button>}
    </span>
  );
}

/** A row of slots, padded to `min` empties so both sides of a ticket line up. */
export function Slots({ children, min = 8, count }: { children: React.ReactNode[]; min?: number; count: number }) {
  const pad = Math.max(0, min - count);
  return (
    <div className="trade-slots">
      {children}
      {Array.from({ length: pad }, (_, i) => <Slot key={`e${i}`} />)}
    </div>
  );
}

/** The two-sided ticket every trade is drawn as. */
export function Ticket({ leftTitle, rightTitle, left, right, min = 8, arrow = "⇄" }: { leftTitle: React.ReactNode; rightTitle: React.ReactNode; left: React.ReactNode[]; right: React.ReactNode[]; min?: number; arrow?: string }) {
  return (
    <div className="trade-ticket">
      <div className="trade-side">
        <div className="trade-side-title">{leftTitle}</div>
        <Slots min={min} count={left.length}>{left}</Slots>
      </div>
      <div className="trade-arrow" aria-hidden="true">{arrow}</div>
      <div className="trade-side">
        <div className="trade-side-title">{rightTitle}</div>
        <Slots min={min} count={right.length}>{right}</Slots>
      </div>
    </div>
  );
}

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
export const left = (ms: number) => {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return "expired";
  return s < 3600 ? `${Math.ceil(s / 60)} min left` : `${Math.round(s / 3600)} h left`;
};
