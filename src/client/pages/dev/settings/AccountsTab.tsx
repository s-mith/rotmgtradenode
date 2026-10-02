
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relTime } from "@/lib/relTime";
import { ItemSprite } from "@/components/ItemSprite";
import { confirmCommunismChange } from "./CommunismTab";
import { accountAdvice } from "@/client/shared/api";

// The roster (the Accounts tab): every account the node runs, one card per
// in-game name with its storage counts. Click a card and it opens into the
// email behind it and everything the account holds, in rows of sixteen,
// grouped by where each item sits. Accounts are added, refreshed, fixed, set
// aside for communism and removed here too.
//
// Search-driven rather than polled: one request per search, none on a timer.

type Item = {
  slot: number;
  instanceId: string;
  itemId: string;
  name: string;
  known: boolean;
  /** False when this account may not trade the item away (a communism account's items communism does not take). */
  tradeable?: boolean;
  category: string | null;
  realmId: number | null;
  enchantments: number[];
  enchantNames: (string | null)[];
  capturedAt: number | null;
};

type Account = {
  alias: string;
  guid: string;
  botGuid: string;
  ign: string;
  server: string;
  online: boolean;
  inWorld: boolean;
  seasonal: boolean | null;
  suspended: boolean;
  /** Set aside for communism: its slots and items are communism's, not the pool's. */
  communism: boolean;
  inUse: boolean;
  assignedKind: string | null;
  assignedRequestId: number | null;
  capacity: number;
  held: number;
  lastSeen: number | null;
  /** Why the last login did not get the account in world, until one does. */
  lastLoginError: { at: number; kind: string; message: string } | null;
  items: Item[];
  /** What the account keeps beyond the character (vault, rack, gift and spoils chests, other characters): in the pool like the rest. */
  stored: StoredRow[];
  /** The character the account logs in as, once storage has seen a login; its side is the side the account trades on. */
  loginChar?: { id: number; className: string; level: number; seasonal: boolean | null } | null;
  /** Every living character with its side and trade slots, the played one first. */
  chars?: { id: number; className: string; level: number; seasonal: boolean; login: boolean; held: number; capacity: number }[];
  /** The backpack calendar (reached days, the next one ahead) and the backpacks sitting in the chests, per side. */
  backpacks?: Backpacks;
  /** What a maintenance job is doing with the account right now (a backpack job, a storage read). */
  activity?: string | null;
  /** Characters queued for deletion, new characters queued (by side, true: seasonal) and the one being made, when Realm lets the account make the next, and how the last character jobs went. */
  characterJobs?: { deleteQueue: number[]; deleting?: number | null; deleteWaiting?: string | null; createQueue?: boolean[]; creating?: boolean | null; createWaiting?: string | null; nextCreateAt?: number | null; createCooldownS?: number; last: CharacterJobView | null; recent?: CharacterJobView[]; dropQueue: string[]; dropWaiting?: string | null; lastDrop: { at: number; ok: boolean; dropped: number; planned: number; summary: string } | null };
  /** The preferred character id (Accounts.json), when one is set. */
  charId?: number | null;
  /** What each character wears: shown, never traded as is (an equipped item is moved to the inventory first). */
  equipped?: { charId: number; className: string; level: number; seasonal: boolean; slots: { slot: number; type: number; itemId: string | null; name: string; tradeable: boolean }[] }[];
  /** What the account keeps, counted: the played side's containers, the other side's once read, the characters per side, the character slots. */
  storage?: {
    character: { held: number; capacity: number };
    vault: { used: number; slots: number };
    rack: { used: number; slots: number };
    gift: { items: number; tradeable: number };
    spoils: { items: number; tradeable: number };
    containersSide: boolean | null;
    otherSide: { seasonal: boolean; at: number; vault: { used: number; slots: number }; rack: { used: number; slots: number }; gift: { items: number; tradeable: number } } | null;
    otherChars: number;
    chars: { slots: number | null; created: number };
    sides: { seasonal: SideCount; nonseasonal: SideCount };
  };
  /** When the containers were last read; null = never, so storage is not listed yet ("Read now" reads it). */
  vaultReadAt: number | null;
};
type SideCount = { chars: number; held: number; capacity: number };
type Backpacks = {
  claimable: number;
  claimableDays: { track: string; day: number; quantity: number }[];
  pending: { track: string; day: number; current: number; quantity: number } | null;
  calendarAt: number | null;
  loginToday: boolean;
  /** The job on the account: `waiting` says why it has not started yet (the account is busy; it runs once it is free). */
  job: { kind: "claim" | "consume"; charId: number | null; since: number; waiting?: string | null } | null;
  lastJob: { kind: "claim" | "consume"; charId: number | null; at: number; ok: boolean; summary: string } | null;
  banked: { seasonal: number; nonseasonal: number; unknown: number };
  canClaimAs: { seasonal: boolean; nonseasonal: boolean };
};
type StoredRow = {
  instanceId: string;
  itemId: string;
  name: string;
  known: boolean;
  /** False when this account may not trade the item away (a communism account's items communism does not take). */
  tradeable?: boolean;
  realmId: number | null;
  enchantments: number[];
  enchantNames: (string | null)[];
  /** Where it is, in words. */
  where: string;
  /** Which container or character slot kind `where` describes. */
  whereKind?: "vault" | "rack" | "gift" | "spoils" | "char" | "worn" | "quickslot";
  pools: { seasonal: boolean; nonseasonal: boolean };
  /** The character it sits on, when it is on one. */
  char?: { id: number; className: string; level: number; seasonal?: boolean } | null;
  /** On a character but not in its inventory: worn, or a unit of a quickslot stack (one Nexus swap away). */
  tucked?: "worn" | "quickslot" | null;
};

const sideWord = (seasonal: boolean | null | undefined): string => (seasonal === null || seasonal === undefined ? "side unknown" : seasonal ? "seasonal" : "non-seasonal");
/** One side's characters, in words: how many, and their trade slots used and free. */
function sideWords(c: SideCount): string {
  if (!c.chars) return "no characters";
  return `${c.chars} character${c.chars === 1 ? "" : "s"}, ${c.held}/${c.capacity} slots (${Math.max(0, c.capacity - c.held)} free)`;
}



/** What an operator wants first: accounts with a failed login, then the ones online, then the rest, suspended last. */
function rank(a: Account): number {
  if (a.suspended) return 4;
  if (a.lastLoginError && !a.online) return 0;
  if (a.online) return 1;
  return 2;
}

// Status line for the card header. Ordered by what an operator needs to know
// first: a suspended account explains a missing item outright, so it outranks
// everything else on the card.
// Sprites are fetched in batches of ids so a big lookup costs a few requests.

function statusOf(a: Account): { text: string; color: string } {
  if (a.suspended) return { text: "SUSPENDED", color: "var(--bad)" };
  if (!a.online) return { text: "offline", color: "var(--muted)" };
  if (!a.inWorld) return { text: "connecting", color: "var(--warn, #d2a24c)" };
  if (a.assignedKind) {
    const req = a.assignedRequestId === null ? "" : ` #${a.assignedRequestId}`;
    return { text: `${a.assignedKind}${req}`, color: "var(--warn, #d2a24c)" };
  }
  if (a.inUse) return { text: "reserved", color: "var(--warn, #d2a24c)" };
  return { text: "idle", color: "var(--good, #5aa86a)" };
}

/** Where a stored row sits, in the order the groups are shown. */
const WHERE_ORDER = ["vault chest", "potion rack", "gift chest", "spoils chest"];
/** Container groups in a fixed order, the played side's first: a label carries its side as a prefix ("seasonal vault chest"). */
const whereRank = (w: string): number => { const base = w.replace(/^(non-)?seasonal /, ""); const i = WHERE_ORDER.indexOf(base); return i === -1 ? WHERE_ORDER.length : i; };

/** Everything on one account, grouped by where it sits, in rows of sixteen: the containers, then each character by id. */
type CharBrief = { id: number; className: string; level: number; seasonal: boolean; login: boolean };
type Carries = { label: string; items: { name: string; units: number }[] }[];

/** The delete confirm: the character, what it carries as sprites, and the two buttons. Escape or the backdrop cancels. */
function DeleteCharacterDialog({ account, ch, carries, onCancel, onConfirm }: { account: string; ch: CharBrief; carries: Carries; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const total = carries.reduce((n, sec) => n + sec.items.reduce((m, it) => m + it.units, 0), 0);
  return (
    <div className="confirm-backdrop" onClick={onCancel} role="presentation">
      <div className="confirm-box" role="dialog" aria-modal="true" aria-labelledby="delete-char-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="delete-char-title">Delete character #{ch.id}?</h3>
        <p className="confirm-sub">{ch.className} lvl {ch.level} · {ch.seasonal ? "seasonal" : "non-seasonal"}{ch.login ? " · the one this account logs in as" : ""} · on {account}</p>
        {total === 0 ? (
          <p className="confirm-empty">It carries nothing.</p>
        ) : (
          <>
            <p className="confirm-sub">It carries {total} item{total === 1 ? "" : "s"}, all lost with it:</p>
            {carries.map((sec) => (
              <div key={sec.label} className="roster-group confirm-group">
                <div className="roster-group-label">{sec.label} · {sec.items.reduce((m, it) => m + it.units, 0)}</div>
                <div className="roster-grid confirm-grid">
                  {sec.items.map((it) => (
                    <div key={it.name} className="roster-item" title={it.units > 1 ? `${it.name} ×${it.units}` : it.name}>
                      <ItemSprite name={it.name} size={26} />
                      {it.units > 1 && <span className="roster-item-ench">×{it.units}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
        <p className="confirm-warn">This cannot be undone.</p>
        <div className="confirm-actions">
          <button className="nav-link" type="button" onClick={onCancel}>cancel</button>
          <button className="login-char-btn login-char-btn-danger confirm-danger" type="button" onClick={onConfirm}>delete character</button>
        </div>
      </div>
    </div>
  );
}

type DropTarget = { instanceId: string; itemId: string; name: string; enchantments: number[]; enchantNames: (string | null)[] };

/** The drop popup: the item, and the three ways to throw away. */
function DropItemDialog({ account, target, identical, same, skipped, onCancel, onDrop }: { account: string; target: DropTarget; identical: number; same: number; skipped: { gift: number; spoils: number }; onCancel: () => void; onDrop: (which: "one" | "identical" | "same") => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const ench = target.enchantNames.filter(Boolean).join(", ");
  const skippedNote = [skipped.gift > 0 ? `the ${skipped.gift} in the gift chest` : "", skipped.spoils > 0 ? `the ${skipped.spoils} in the spoils chest` : ""].filter(Boolean).join(" and ");
  return (
    <div className="confirm-backdrop" onClick={onCancel} role="presentation">
      <div className="confirm-box" role="dialog" aria-modal="true" aria-labelledby="drop-item-title" onClick={(e) => e.stopPropagation()}>
        <div className="drop-head">
          <div className="roster-item"><ItemSprite name={target.name} size={26} />{target.enchantments.length > 0 && <span className="roster-item-ench">+{target.enchantments.length}</span>}</div>
          <div>
            <h3 id="drop-item-title">Drop {target.name}?</h3>
            <p className="confirm-sub">{ench ? `${ench} · ` : ""}on {account}</p>
          </div>
        </div>
        <p className="confirm-sub">A drop throws the item on the ground in game; it is gone. The account logs in as the character that has it, fetching it from a chest or unequipping it first when it has to.</p>
        <div className="drop-choices">
          <button className="login-char-btn login-char-btn-danger confirm-danger" type="button" onClick={() => onDrop("one")}>drop this one</button>
          {identical > 1 && <button className="login-char-btn login-char-btn-danger confirm-danger" type="button" onClick={() => onDrop("identical")} title="The same item with the same enchantments, everywhere on this account">drop all {identical} identical</button>}
          {same > identical && <button className="login-char-btn login-char-btn-danger confirm-danger" type="button" onClick={() => onDrop("same")} title="Every copy of this item on this account, whatever its enchantments">drop all {same} of this item</button>}
        </div>
        {skippedNote && <p className="confirm-sub">"Drop all" leaves {skippedNote} alone: {skipped.gift > 0 && skipped.spoils > 0 ? "those chests have" : "that chest has"} no size limit, so dropping from {skipped.gift > 0 && skipped.spoils > 0 ? "them" : "it"} frees nothing.</p>}
        <p className="confirm-warn">This cannot be undone.</p>
        <div className="confirm-actions">
          <button className="nav-link" type="button" onClick={onCancel}>cancel</button>
        </div>
      </div>
    </div>
  );
}

/** One character job as the card shows it: a delete, or a new character (its id once made). */
type CharacterJobView = { kind: "delete"; charId: number; at: number; ok: boolean; summary: string } | { kind: "create"; charId: number | null; seasonal: boolean; at: number; ok: boolean; summary: string };

function AccountItems({ a, onBackpack, onNewCharacters, onCancelCreates, newCharBusy, onDeleteCharacter, onUnqueueDelete, onDropAsk, onCancelDrops }: { a: Account; onBackpack: (action: "claim" | "consume" | "cancel", o?: { charId?: number; seasonal?: boolean }) => void; onNewCharacters: (seasonal: boolean, count: number) => void; onCancelCreates: () => void; newCharBusy: boolean; onDeleteCharacter: (ch: CharBrief, carries: Carries) => void; onUnqueueDelete: (charId: number) => void; onDropAsk: (target: DropTarget) => void; onCancelDrops: () => void }) {
  type Tile = { key: string; name: string; enchantNames: (string | null)[]; enchants: number; known: boolean; tradeable: boolean; itemId: string; enchantments: number[] };
  const bp = a.backpacks;
  const jobOn = !!bp?.job;
  /** A "use a backpack" button for a character without one, when a backpack sits in a chest of its side. */
  const consumeFor = (ch: { id: number; seasonal: boolean | null; capacity: number }): { label: string; title: string; onClick: () => void } | null => {
    if (!bp || ch.seasonal === null || ch.capacity > 8) return null;
    const side = ch.seasonal ? "seasonal" : "nonseasonal";
    if (bp.banked[side] <= 0) return null;
    return { label: `use a backpack (${bp.banked[side]} in the ${ch.seasonal ? "seasonal" : "non-seasonal"} chests)`, title: `Log in as character #${ch.id}, walk into its Vault and use a backpack from its chest: 16 trade slots from then on. One login; a minute.`, onClick: () => onBackpack("consume", { charId: ch.id }) };
  };
  const tile = (it: { instanceId: string; itemId: string; name: string; enchantNames: (string | null)[]; enchantments: number[]; known: boolean; tradeable?: boolean }): Tile => ({ key: it.instanceId, name: it.name, enchantNames: it.enchantNames, enchants: it.enchantments.length, known: it.known, tradeable: it.tradeable ?? it.known, itemId: it.itemId, enchantments: it.enchantments });
  type Worn = { key: string; name: string; tradeable: boolean; notTaken?: boolean; drop?: DropTarget };
  const groups: { key: string; label: string; items: Tile[]; worn?: Worn[]; quick?: { name: string; units: number; notTaken?: boolean; drop?: DropTarget }[]; action?: { label: string; title: string; onClick: () => void } | null; remove?: () => void; unqueue?: () => void }[] = [];
  /** What a character carries, for the delete popup: inventory, worn, quickslots, each as items with a count. */
  const carriesOf = (charId: number, login: boolean): Carries => {
    const count = (names: string[]) => { const m = new Map<string, number>(); for (const n of names) m.set(n, (m.get(n) ?? 0) + 1); return [...m].map(([name, units]) => ({ name, units })); };
    const inv = login ? a.items.map((i) => i.name) : (a.stored ?? []).filter((s) => s.char?.id === charId && !s.tucked).map((s) => s.name);
    const worn = (a.equipped ?? []).find((e) => e.charId === charId)?.slots.map((s) => s.name) ?? [];
    const qs = (a.stored ?? []).filter((s) => s.char?.id === charId && s.tucked === "quickslot").map((s) => s.name);
    return [{ label: "inventory", items: count(inv) }, { label: "worn", items: count(worn) }, { label: "quickslots", items: count(qs) }].filter((sec) => sec.items.length);
  };
  const asTarget = (s: { instanceId: string; itemId: string; name: string; enchantments: number[]; enchantNames: (string | null)[] }): DropTarget => ({ instanceId: s.instanceId, itemId: s.itemId, name: s.name, enchantments: s.enchantments, enchantNames: s.enchantNames });
  // A quickslot stack's tile drops one unit; the popup's "all identical" covers the rest of the stack.
  const quickOf = (charId: number) => [...(quick.get(charId) ?? [])].map(([name, units]) => { const row = (a.stored ?? []).find((s) => s.char?.id === charId && s.tucked === "quickslot" && s.name === name); return { name, units, notTaken: row?.tradeable === false && row.known, drop: row ? asTarget(row) : undefined }; });
  // Worn slots come from the equipment list (no instance ids); the pool's worn rows for that character supply the id, matched by name.
  const wornOf = (charId: number): Worn[] => {
    const rows = (a.stored ?? []).filter((s) => s.char?.id === charId && s.tucked === "worn");
    return (a.equipped ?? []).find((e) => e.charId === charId)?.slots.map((s) => { const i = rows.findIndex((r) => r.name === s.name); const row = i >= 0 ? rows.splice(i, 1)[0] : undefined; return { key: `w-${charId}-${s.slot}`, name: s.name, tradeable: s.tradeable, notTaken: row?.tradeable === false && row.known, drop: row ? asTarget(row) : undefined }; }) ?? [];
  };
  const containers = new Map<string, Tile[]>();
  const chars = new Map<number, { className: string; level: number; seasonal: boolean | null; items: Tile[] }>();
  /** Quickslot stacks per character: item name -> units. */
  const quick = new Map<number, Map<string, number>>();
  for (const it of a.stored ?? []) {
    if (it.char) {
      let c = chars.get(it.char.id);
      if (!c) chars.set(it.char.id, (c = { className: it.char.className, level: it.char.level, seasonal: it.char.seasonal ?? null, items: [] }));
      if (it.tucked === "worn") continue; // the equipped row shows it
      if (it.tucked === "quickslot") {
        let q = quick.get(it.char.id);
        if (!q) quick.set(it.char.id, (q = new Map()));
        q.set(it.name, (q.get(it.name) ?? 0) + 1);
        continue;
      }
      c.items.push(tile(it));
    } else {
      let list = containers.get(it.where);
      if (!list) containers.set(it.where, (list = []));
      list.push(tile(it));
    }
  }
  // The played side's containers first, then the other side's, each vault → rack → gift → spoils.
  const own = a.storage?.containersSide ?? a.loginChar?.seasonal ?? null;
  const sideRank = (w: string): number => (own === null ? 0 : w.startsWith(own ? "seasonal " : "non-seasonal ") ? 0 : /^(non-)?seasonal /.test(w) ? 1 : 0);
  for (const [where, items] of [...containers].sort((x, y) => sideRank(x[0]) - sideRank(y[0]) || whereRank(x[0]) - whereRank(y[0]) || x[0].localeCompare(y[0]))) groups.push({ key: where, label: `${where} · ${items.length} item${items.length === 1 ? "" : "s"}`, items });
  // The played character first, from the tracker; then the others by id, each with its side (read from Realm's character list).
  const played = a.loginChar ?? (a.charId != null ? { id: a.charId, className: "?", level: 0, seasonal: null } : null);
  const bySlot = [...a.items].sort((x, y) => x.slot - y.slot).map(tile);
  const seen = new Set<number>();
  if (a.chars && a.chars.length) {
    for (const ch of a.chars) {
      seen.add(ch.id);
      const items = ch.login ? bySlot : chars.get(ch.id)?.items ?? [];
      // Several deletes can wait at once: each queued character says where it is in line, and can be taken back until its turn comes.
      const deleteQueue = a.characterJobs?.deleteQueue ?? [];
      const inLine = deleteQueue.indexOf(ch.id);
      const deletingNow = a.characterJobs?.deleting === ch.id;
      const deleteTag = deletingNow ? " · DELETING NOW" : inLine >= 0 ? ` · DELETE QUEUED${deleteQueue.length > 1 ? ` (${inLine + 1} of ${deleteQueue.length})` : ""}${a.characterJobs?.deleteWaiting ? `, waiting for the account: ${a.characterJobs.deleteWaiting}` : ""}` : "";
      groups.push({ key: `char-${ch.id}`, label: `character #${ch.id} · ${ch.className} lvl ${ch.level} · ${sideWord(ch.seasonal)}${ch.login ? " · logs in as this one" : ""} · ${ch.held}/${ch.capacity} slots${!ch.login && ch.held !== items.length ? ` (${items.length} tradeable)` : ""}${deleteTag}`, items, worn: wornOf(ch.id), quick: quickOf(ch.id), action: consumeFor(ch), remove: inLine >= 0 ? undefined : () => onDeleteCharacter(ch, carriesOf(ch.id, ch.login)), unqueue: inLine >= 0 && !deletingNow ? () => onUnqueueDelete(ch.id) : undefined });
    }
  } else {
    groups.push({ key: "played", label: `${played ? `character #${played.id} · ${played.className}${played.level ? ` lvl ${played.level}` : ""} · ${sideWord(played.seasonal)}` : "character"} · logs in as this one · ${bySlot.length}/${a.capacity} slots`, items: bySlot, worn: played ? wornOf(played.id) : [] });
    if (played) seen.add(played.id);
  }
  for (const [id, c] of [...chars].sort((x, y) => x[0] - y[0])) { if (seen.has(id)) continue; seen.add(id); groups.push({ key: `char-${id}`, label: `character #${id} · ${c.className} lvl ${c.level} · ${sideWord(c.seasonal)} · ${c.items.length} item${c.items.length === 1 ? "" : "s"}`, items: c.items, worn: wornOf(id) }); }
  // A character with nothing tradeable in its slots but something on: still a group, for what it wears.
  for (const e of (a.equipped ?? []).filter((e) => !seen.has(e.charId)).sort((x, y) => x.charId - y.charId)) groups.push({ key: `char-${e.charId}`, label: `character #${e.charId} · ${e.className} lvl ${e.level} · ${sideWord(e.seasonal)} · 0 items`, items: [], worn: wornOf(e.charId) });
  const trackWord = (t: string) => (t === "consecutive" ? "consecutive-days" : "login-days");
  const dropQueued = new Set(a.characterJobs?.dropQueue ?? []);
  // A communism account's items communism does not take: untradable here; the storage chore banks the ones in trade slots first.
  const notTaken = a.communism ? { held: a.items.filter((i) => i.known && i.tradeable === false).length, stored: (a.stored ?? []).filter((s) => s.known && s.tradeable === false).length } : { held: 0, stored: 0 };
  const emptySlots = a.storage && a.storage.chars.slots !== null ? Math.max(0, a.storage.chars.slots - a.storage.chars.created) : 0;
  // New characters already on the way take their slots: what is left is how many more can be asked for.
  const queuedNew = a.characterJobs?.createQueue ?? [];
  const makingNow = a.characterJobs?.creating ?? null;
  const makingWaits = a.characterJobs?.createWaiting ?? null;
  const roomForNew = Math.max(0, emptySlots - queuedNew.length - (makingNow !== null ? 1 : 0));
  const cooldownS = a.characterJobs?.createCooldownS ?? 30;
  const [howMany, setHowMany] = useState(1);
  const many = Math.max(1, Math.min(howMany, roomForNew || 1));
  const nextInS = a.characterJobs?.nextCreateAt ? Math.max(0, Math.ceil((a.characterJobs.nextCreateAt - Date.now()) / 1000)) : 0;
  return (
    <div className="roster-items">
      <div className="roster-backpacks">
        {bp ? (
          <>
            {(bp.claimable > 0 || roomForNew > 0) && (
              <div className="bp-claims">
                {bp.claimable > 0 && ([true, false] as const).map((seasonal) => {
                  const can = seasonal ? bp.canClaimAs.seasonal : bp.canClaimAs.nonseasonal;
                  const running = jobOn && bp.job?.kind === "claim";
                  return (
                    <button key={String(seasonal)} className="bp-claim" type="button" disabled={!can || jobOn} onClick={() => onBackpack("claim", { seasonal })} title={`${bp.claimableDays.map((d) => `${trackWord(d.track)} day ${d.day}`).join(", ")} reached: ${bp.claimable} backpack${bp.claimable === 1 ? "" : "s"} to claim. ${can ? `Claim as a ${seasonal ? "seasonal" : "non-seasonal"} character: the backpacks go to the ${seasonal ? "seasonal" : "non-seasonal"} gift chest, where only that side's characters can use them.` : `No ${seasonal ? "seasonal" : "non-seasonal"} character on this account to claim with.`}`}>
                      <span className="bp-icon">
                        <img src="/sprites/backpack.png" alt="" width={40} height={40} />
                        <span className="bp-count">×{bp.claimable}</span>
                      </span>
                      <span className="bp-label">{running ? (bp.job?.waiting ? "claim queued…" : "claiming…") : `claim as ${seasonal ? "seasonal" : "non-seasonal"}`}</span>
                    </button>
                  );
                })}
                {roomForNew > 1 && (
                  <label className="bp-how-many" title={`How many new characters to make: one login each, ${cooldownS} seconds apart (Realm lets an account make one every 30 seconds)`}>
                    how many
                    <input type="number" min={1} max={roomForNew} value={many} onChange={(e) => setHowMany(Math.max(1, Math.min(roomForNew, Math.floor(Number(e.target.value)) || 1)))} />
                  </label>
                )}
                {roomForNew > 0 && ([true, false] as const).map((seasonal) => (
                  <button key={`wiz-${seasonal}`} className="bp-claim" type="button" disabled={newCharBusy} onClick={() => onNewCharacters(seasonal, many)} title={`${roomForNew} empty character slot${roomForNew === 1 ? "" : "s"} free for new characters. ${many === 1 ? "One login" : `${many} logins, ${cooldownS} seconds apart`}: ${many === 1 ? "a new" : `${many} new`} ${seasonal ? "seasonal" : "non-seasonal"} Wizard${many === 1 ? "" : "s"}, 8 more item slots each the pool trades from without a swap. Queued: the account works through them by itself.`}>
                    <span className="bp-icon">
                      <img className="bp-wizard" src="/sprites/wizard.png" alt="" width={40} height={40} />
                      <span className="bp-count">×{roomForNew}</span>
                    </span>
                    <span className="bp-label">{newCharBusy ? "queuing…" : many === 1 ? `new ${seasonal ? "seasonal" : "non-seasonal"} character` : `${many} new ${seasonal ? "seasonal" : "non-seasonal"} characters`}</span>
                  </button>
                ))}
              </div>
            )}
            {bp.claimable > 0 ? null : bp.pending ? (
              <span className="muted" title="The calendar only moves on days the account logs in; the node logs it in once a day by itself while a backpack day is ahead.">
                next backpack: {trackWord(bp.pending.track)} day {bp.pending.day} · counter at {bp.pending.current} · {bp.loginToday ? "logged in today" : "today's login still due (the node does it)"}
              </span>
            ) : bp.calendarAt === null ? (
              <span className="muted">login calendar not read yet · refresh the account</span>
            ) : (
              <span className="muted">no backpack day ahead on this month&apos;s calendar</span>
            )}
            {(bp.banked.seasonal > 0 || bp.banked.nonseasonal > 0 || bp.banked.unknown > 0) && (
              <span className="muted" title="Backpacks sitting in the gift, vault or spoils chests, per side; use one from a character's line below">
                · in chests: {[bp.banked.seasonal ? `${bp.banked.seasonal} seasonal` : "", bp.banked.nonseasonal ? `${bp.banked.nonseasonal} non-seasonal` : "", bp.banked.unknown ? `${bp.banked.unknown} (side unknown)` : ""].filter(Boolean).join(", ")}
              </span>
            )}
            {bp.job?.waiting && (
              <>
                <span className="muted" title="The job runs as soon as the account is free, however long that takes">
                  · {bp.job.kind === "claim" ? "claim" : `backpack on #${bp.job.charId}`} queued: {bp.job.waiting}
                </span>
                <button className="nav-link" type="button" onClick={() => onBackpack("cancel")} title="Take the job back before it runs">cancel</button>
              </>
            )}
            {bp.lastJob && !jobOn && (
              <span className={bp.lastJob.ok ? "muted" : ""} style={bp.lastJob.ok ? undefined : { color: "var(--bad)" }} title={bp.lastJob.summary}>
                · last {bp.lastJob.kind === "claim" ? "claim" : `backpack on #${bp.lastJob.charId}`} {bp.lastJob.ok ? "ok" : "failed"} {relTime(bp.lastJob.at)}{bp.lastJob.ok ? "" : `: ${bp.lastJob.summary.slice(0, 160)}`}
              </span>
            )}
          </>
        ) : (
          <span className="muted">backpacks: unknown</span>
        )}
      </div>
      {(queuedNew.length > 0 || makingNow !== null) && (
        <div className="roster-backpacks">
          <span style={{ color: "var(--warn, #d2a24c)" }}>
            new characters:{" "}
            {makingNow !== null && (makingWaits ? `a ${makingNow ? "seasonal" : "non-seasonal"} one waiting for the account (${makingWaits})` : nextInS > 0 ? `next (${makingNow ? "seasonal" : "non-seasonal"}) in ${nextInS} s` : `making a ${makingNow ? "seasonal" : "non-seasonal"} one now`)}
            {makingNow !== null && queuedNew.length > 0 && " · "}
            {queuedNew.length > 0 && `${queuedNew.length} more queued (${[[true, "seasonal"], [false, "non-seasonal"]].map(([side, word]) => [queuedNew.filter((q) => q === side).length, word] as const).filter(([k]) => k > 0).map(([k, word]) => `${k} ${word}`).join(", ")})`}
            {` · one every ${cooldownS} s`}
          </span>
          {(queuedNew.length > 0 || makingWaits) && <button className="nav-link" type="button" onClick={onCancelCreates} title="Take back the new characters still waiting, the one waiting for the account too; one already logging in goes on">{makingWaits ? "cancel" : "cancel the rest"}</button>}
        </div>
      )}
      {(() => {
        // Every character job of the last ten minutes, newest first: deletes and new characters queued together each say how they went.
        const jobs = (a.characterJobs?.recent?.length ? a.characterJobs.recent : a.characterJobs?.last ? [a.characterJobs.last] : []).filter((j) => Date.now() - j.at < 10 * 60_000);
        return jobs.length > 0 && (
          <div className="roster-backpacks" style={{ flexDirection: "column", alignItems: "flex-start" }}>
            {jobs.map((j) => (
              <span key={`${j.kind}-${j.charId}-${j.at}`} className={j.ok ? "muted" : ""} style={j.ok ? undefined : { color: "var(--bad)" }} title={j.summary}>{j.summary} · {relTime(j.at)}</span>
            ))}
          </div>
        );
      })()}
      {notTaken.held + notTaken.stored > 0 && (
        <div className="roster-backpacks">
          <span className="muted" title="Communism gives only what its accepted list takes. Anything else on a communism account is treated as untradable: never listed, and the storage chore moves it off the trade slots into the vault before it tucks anything else.">{notTaken.held + notTaken.stored} item{notTaken.held + notTaken.stored === 1 ? "" : "s"} not accepted on communism{notTaken.held ? ` · ${notTaken.held} in the trade slots, going to the vault first` : ""}</span>
        </div>
      )}
      {a.characterJobs && (a.characterJobs.dropQueue.length > 0 || (a.characterJobs.lastDrop && Date.now() - a.characterJobs.lastDrop.at < 10 * 60_000)) && (
        <div className="roster-backpacks">
          {a.characterJobs.dropQueue.length > 0 && <span style={{ color: "var(--warn, #d2a24c)" }} title={a.characterJobs.dropWaiting ?? undefined}>drop queued · {a.characterJobs.dropQueue.length} item{a.characterJobs.dropQueue.length === 1 ? "" : "s"}{a.characterJobs.dropWaiting ? " · waiting for the account" : ""}</span>}
          {a.characterJobs.dropQueue.length > 0 && <button className="nav-link" type="button" onClick={onCancelDrops} title="Take back the drops still queued; a trip already dropping goes on">cancel</button>}
          {a.characterJobs.lastDrop && Date.now() - a.characterJobs.lastDrop.at < 10 * 60_000 && <span className={a.characterJobs.lastDrop.ok ? "muted" : ""} style={a.characterJobs.lastDrop.ok ? undefined : { color: "var(--bad)" }} title={a.characterJobs.lastDrop.summary}>{a.characterJobs.dropQueue.length > 0 ? " · " : ""}last drop: {a.characterJobs.lastDrop.summary} · {relTime(a.characterJobs.lastDrop.at)}</span>}
        </div>
      )}
      <div className="roster-email-line">
        <span className="roster-email" title="the email this account logs in with">{a.guid}</span>
        {a.ign && a.ign !== a.alias && !a.alias.includes("@") && <span style={{ color: "var(--muted)", fontSize: 12 }}>· alias {a.alias}</span>}
      </div>
      {groups.map((g) => (
        <div key={g.key} className="roster-group">
          <div className="roster-group-label">
            {g.label}
            {g.action && (
              <button className="login-char-btn" type="button" disabled={jobOn} onClick={g.action.onClick} title={g.action.title} style={{ marginLeft: 10, textTransform: "none", letterSpacing: 0 }}>
                {jobOn && bp?.job?.kind === "consume" && g.key === `char-${bp.job.charId}` ? (bp.job.waiting ? "queued…" : "using…") : g.action.label}
              </button>
            )}
            {g.remove && (
              <button className="login-char-btn login-char-btn-danger" type="button" onClick={g.remove} title="Delete this character and everything on it (you are shown what it carries first). Queue as many as you like: they run one after another in one visit, once the account is free." style={{ marginLeft: 10, textTransform: "none", letterSpacing: 0 }}>
                delete
              </button>
            )}
            {g.unqueue && (
              <button className="login-char-btn" type="button" onClick={g.unqueue} title="Take this delete back: it has not run yet" style={{ marginLeft: 10, textTransform: "none", letterSpacing: 0 }}>
                take back
              </button>
            )}
          </div>
          {g.worn && g.worn.length > 0 && (
            <div className="roster-worn" title="Equipped: moved to the inventory before it can trade">
              <span className="roster-worn-label">equipped</span>
              {g.worn.map((w) => w.drop ? (
                <button key={w.key} type="button" className={"roster-item roster-item-btn worn" + (w.tradeable && !w.notTaken ? "" : " unknown")} disabled={dropQueued.has(w.drop.instanceId)} onClick={() => onDropAsk(w.drop!)} title={`${w.name} · equipped${w.tradeable ? "" : " · not a catalog item"}${w.notTaken ? " · not accepted on communism: untradable here" : ""}${dropQueued.has(w.drop.instanceId) ? " · drop queued" : " · click to drop"}`}>
                  <ItemSprite name={w.name} size={26} />
                </button>
              ) : (
                <div key={w.key} className={"roster-item worn" + (w.tradeable ? "" : " unknown")} title={`${w.name} · equipped${w.tradeable ? "" : " · not a catalog item"}`}>
                  <ItemSprite name={w.name} size={26} />
                </div>
              ))}
            </div>
          )}
          {g.quick && g.quick.length > 0 && (
            <div className="roster-worn" title="Quickslot stacks: one swap in the Nexus brings a unit into the inventory">
              <span className="roster-worn-label">quickslots</span>
              {g.quick.map((q) => q.drop ? (
                <button key={q.name} type="button" className={"roster-item roster-item-btn worn" + (q.notTaken ? " unknown" : "")} disabled={dropQueued.has(q.drop.instanceId)} onClick={() => onDropAsk(q.drop!)} title={`${q.name} ×${q.units} in a quickslot${q.notTaken ? " · not accepted on communism: untradable here" : ""}${dropQueued.has(q.drop.instanceId) ? " · drop queued" : " · click to drop"}`}>
                  <ItemSprite name={q.name} size={26} />
                  <span className="roster-item-ench">×{q.units}</span>
                </button>
              ) : (
                <div key={q.name} className="roster-item worn" title={`${q.name} ×${q.units} in a quickslot`}>
                  <ItemSprite name={q.name} size={26} />
                  <span className="roster-item-ench">×{q.units}</span>
                </div>
              ))}
            </div>
          )}
          {g.items.length === 0 ? (
            <div className="roster-group-empty">{a.lastSeen === null && a.vaultReadAt === null ? "never read" : "empty"}</div>
          ) : (
            <div className="roster-grid">
              {g.items.map((it) => (
                <button key={it.key} type="button" className={"roster-item roster-item-btn" + (it.known && it.tradeable ? "" : " unknown")} disabled={dropQueued.has(it.key)} onClick={() => onDropAsk({ instanceId: it.key, itemId: it.itemId, name: it.name, enchantments: it.enchantments, enchantNames: it.enchantNames })} title={`${it.name}${it.enchants ? ` · ${it.enchantNames.filter(Boolean).join(", ")}` : ""}${it.known ? "" : " · not in the catalog"}${it.known && !it.tradeable ? " · not accepted on communism: untradable here, goes to the vault first" : ""}${dropQueued.has(it.key) ? " · drop queued" : " · click to drop"}`}>
                  <ItemSprite name={it.name} size={26} />
                  {it.enchants > 0 && <span className="roster-item-ench">+{it.enchants}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AccountsTab({ password }: { password: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-account form (design doc §4.1: the roster is the owner's own alts).
  const [addEmail, setAddEmail] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [fixing, setFixing] = useState<{ guid: string; email: string; password: string; busy: boolean } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);


  // A run counter, not an AbortController: the point isn't to cancel the
  // request but to ignore a slow one that lands after a newer search. Without
  // it, typing "kap" then "kappa12" can leave the "kap" results on screen.
  const runId = useRef(0);
  // What the visible cards are a result of — `query` is the input box, which
  // the operator may have edited since. A refresh has to repeat the search
  // that produced what's on screen.
  const lastQuery = useRef("");

  const search = useCallback(
    async (q: string) => {
      const mine = ++runId.current;
      lastQuery.current = q;
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/dev/account-lookup?q=${encodeURIComponent(q)}&limit=10000`,
          { headers: { "X-Dev-Password": password } },
        );
        const body = await res.json();
        if (mine !== runId.current) return;
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setAccounts(body.accounts ?? []);
        setTotal(body.total ?? 0);
      } catch (e) {
        if (mine !== runId.current) return;
        setErr(e instanceof Error ? e.message : "lookup failed");
        setAccounts([]);
        setTotal(0);
      } finally {
        if (mine === runId.current) setBusy(false);
      }
    },
    [password],
  );

  // Open with the head of the fleet so the tab isn't a blank box.
  useEffect(() => {
    void search("");
  }, [search]);


  const addAccount = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setAddBusy(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/dev/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ email: addEmail.trim(), password: addPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const d = body.detected as { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean; backpackSlots: number } | null } | null;
      const facts = d ? ` Realm says: ${d.chars} character${d.chars === 1 ? "" : "s"}, tutorial ${d.tutorialDone ? "done" : "not done"}${d.loaded ? `, logs in as #${d.loaded.id} (${d.loaded.seasonal ? "seasonal" : "non-seasonal"}, ${8 + d.loaded.backpackSlots} trade slots)` : ""}.` : "";
      setAddMsg({ ok: true, text: body.where === "roster" ? `${addEmail.trim()} is on the roster and being read now.${facts}` : `${addEmail.trim()} queued for its tutorial walk — watch the Tutorials tab; it joins the roster when done.${facts}` });
      setAddEmail("");
      setAddPassword("");
      void search(lastQuery.current);
    } catch (err) {
      setAddMsg({ ok: false, text: accountAdvice(err instanceof Error ? err.message : "could not add the account") });
    } finally {
      setAddBusy(false);
    }
  }, [addEmail, addPassword, password, search]);

  const saveCredentials = useCallback(async () => {
    if (!fixing) return;
    setFixing({ ...fixing, busy: true });
    try {
      const res = await fetch("/api/dev/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dev-password": password },
        body: JSON.stringify({ action: "set-credentials", guid: fixing.guid, email: fixing.email.trim(), ...(fixing.password ? { password: fixing.password } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) setAddMsg({ ok: false, text: body.error || `HTTP ${res.status}` });
      else {
        const d = body.detected as { tutorialDone: boolean; chars: number; loaded: { id: number; seasonal: boolean } | null } | null;
        const facts = d ? ` Realm says: ${d.chars} character${d.chars === 1 ? "" : "s"}, tutorial ${d.tutorialDone ? "done" : "not done"}${d.loaded ? `, logs in as #${d.loaded.id} (${d.loaded.seasonal ? "seasonal" : "non-seasonal"})` : ""}.` : "";
        setAddMsg({ ok: true, text: body.note ? `Saved. ${body.note}.` : `Saved; Realm accepts them. The account is being read now.${facts}` });
        setFixing(null);
      }
    } finally {
      setFixing((f) => (f ? { ...f, busy: false } : f));
      void search(lastQuery.current);
    }
  }, [fixing, password, search]);

  const [removeBusy, setRemoveBusy] = useState<string | null>(null);
  const removeAccount = useCallback(async (a: Account) => {
    const name = a.ign || a.alias;
    const items = a.held + (a.stored ?? []).length;
    if (!confirm(`Remove ${name} from the roster?\n\nThe node forgets its login and stops using it. ${items ? `The ${items} item${items === 1 ? "" : "s"} on it stay on the account in the game, but leave the pool${a.communism ? " and communism" : ""} here.` : "Nothing is on it."}${a.online ? " It is online now and will be logged out." : ""}`)) return;
    setRemoveBusy(a.guid);
    setRetryMsg(null);
    try {
      const res = await fetch("/api/dev/accounts", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "remove", guid: a.guid }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setRetryMsg(`${name} removed from the roster.`);
      void search(lastQuery.current);
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : "could not remove the account");
    } finally {
      setRemoveBusy(null);
    }
  }, [password, search]);


  const [communismBusy, setCommunismBusy] = useState<string | null>(null);
  const [itemFilter, setItemFilter] = useState("");
  const setCommunism = useCallback(async (guid: string, communism: boolean) => {
    setCommunismBusy(guid);
    setRetryMsg(null);
    try {
      const res = await fetch("/api/dev/accounts", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "set-communism", guid, communism }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      void search(lastQuery.current);
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : "could not change the account");
    } finally {
      setCommunismBusy(null);
    }
  }, [password, search]);

  // Refreshes run through the storage run (one account at a time, with progress): the same
  // trip a new account gets — log in, read the vault and the chests, fetch the account snapshot, log out.
  type Run = { running: boolean; total: number; done: number; ok: number; failed: number; current: string[]; stoppedReason: string | null; lastErrors: { alias: string; error: string }[] };
  const [run, setRun] = useState<Run | null>(null);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const loadRun = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/storage?view=status", { headers: { "x-dev-password": password }, cache: "no-store" });
      const body = await r.json();
      if (r.ok) setRun(body.run as Run);
    } catch {
      // the next poll tries again
    }
  }, [password]);
  useEffect(() => {
    void loadRun();
  }, [loadRun]);
  // While a run is on, follow it and reload the roster when it ends.
  useEffect(() => {
    if (!run?.running) return;
    const t = setInterval(() => void loadRun(), 3000);
    return () => clearInterval(t);
  }, [run?.running, loadRun]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && run && !run.running) {
      const nameOf = (alias: string) => accounts?.find((a) => a.alias === alias)?.ign || "an account";
      setRefreshMsg(`refresh done: ${run.ok} ok, ${run.failed} failed${run.stoppedReason ? ` (${run.stoppedReason})` : ""}${run.lastErrors.length ? ` — ${run.lastErrors.map((e) => `${nameOf(e.alias)}: ${e.error}`).join("; ")}` : ""}`);
      void search(lastQuery.current);
    }
    wasRunning.current = !!run?.running;
  }, [run, search, accounts]);
  const refresh = useCallback(async (guids: string[]) => {
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "refresh", guids }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setRun(body.run as Run);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "refresh failed");
    }
  }, [password]);
  // The backpack buttons on a card: claim the reached day (one login as the played character) or use a
  // backpack from a chest on one character (one login as it). The node answers at once; the card shows
  // the job's activity and, when it ends, how it went.
  const backpackAct = useCallback(async (action: "claim" | "consume" | "cancel", guid: string, o: { charId?: number; seasonal?: boolean } = {}) => {
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/backpacks", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action, guid, ...(o.charId !== undefined ? { charId: o.charId } : {}), ...(o.seasonal !== undefined ? { seasonal: o.seasonal } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setTimeout(() => void search(lastQuery.current), 800);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : action === "cancel" ? "the backpack job was not taken back" : "the backpack job did not start");
    }
  }, [password, search]);
  // New characters on an account, from its card: queued on the node, which makes them one at a time (one login each, Realm's
  // cooldown apart) while the card shows the queue and how each went.
  const [newCharBusy, setNewCharBusy] = useState<string | null>(null);
  const newCharacters = useCallback(async (guid: string, seasonal: boolean, count: number) => {
    setRefreshMsg(null);
    setNewCharBusy(guid);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "create-character", guid, seasonal, count }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setRefreshMsg(`${count} new ${seasonal ? "seasonal" : "non-seasonal"} character${count === 1 ? "" : "s"} queued; the account makes them one at a time`);
      setTimeout(() => void search(lastQuery.current), 500);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the new characters were not queued");
    } finally {
      setNewCharBusy(null);
    }
  }, [password, search]);
  const cancelCreates = useCallback(async (guid: string) => {
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "create-character", guid, cancel: true }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setRefreshMsg(body.dropped ? `${body.dropped} queued new character${body.dropped === 1 ? "" : "s"} taken back` : "no new character was waiting");
      setTimeout(() => void search(lastQuery.current), 500);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the queue was not taken back");
    }
  }, [password, search]);
  const cancelDrops = useCallback(async (guid: string) => {
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "drop", guid, cancel: true }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setRefreshMsg(body.dropped ? `${body.dropped} queued drop${body.dropped === 1 ? "" : "s"} taken back` : "no drop was waiting");
      setTimeout(() => void search(lastQuery.current), 500);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the drops were not taken back");
    }
  }, [password, search]);
  // Delete a character: a popup shows what it carries, as sprites, since all of it goes with it.
  const [deleting, setDeleting] = useState<{ a: Account; ch: CharBrief; carries: Carries } | null>(null);
  const deleteCharacter = useCallback((a: Account, ch: CharBrief, carries: Carries) => {
    setDeleting({ a, ch, carries });
  }, []);
  // The delete is queued on the node: the popup closes as soon as the node has it, the card shows the queue and then the outcome.
  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const { a, ch } = deleting;
    setDeleting(null);
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "delete-character", guid: a.guid, charId: ch.id }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setTimeout(() => void search(lastQuery.current), 500);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the delete was not queued");
    }
  }, [deleting, password, search]);
  // Take a queued delete back before its turn (the node refuses the one already under way).
  const unqueueDelete = useCallback(async (a: Account, charId: number) => {
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "unqueue-delete", guid: a.guid, charId }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      void search(lastQuery.current);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the delete was not taken back");
    }
  }, [password, search]);
  // Drop an item: the popup offers this copy, every identical copy (same enchantments) or every copy of the item; the node queues them.
  const [dropAsk, setDropAsk] = useState<{ a: Account; target: DropTarget; identical: string[]; same: string[]; skipped: { gift: number; spoils: number } } | null>(null);
  const askDrop = useCallback((a: Account, target: DropTarget) => {
    const key = (e: number[]) => [...e].sort((x, y) => x - y).join(",");
    // "Drop all" never reaches into the gift chest or the spoils chest: they have no size limit, so nothing is gained by emptying them (the clicked item alone can still be dropped from there).
    const unlimited = (k: string | undefined) => k === "gift" || k === "spoils";
    const rows = [...a.items.map((i) => ({ instanceId: i.instanceId, itemId: i.itemId, enchantments: i.enchantments })), ...(a.stored ?? []).filter((s) => !unlimited(s.whereKind)).map((s) => ({ instanceId: s.instanceId, itemId: s.itemId, enchantments: s.enchantments }))];
    const skipped = { gift: (a.stored ?? []).filter((s) => s.whereKind === "gift" && s.itemId === target.itemId).length, spoils: (a.stored ?? []).filter((s) => s.whereKind === "spoils" && s.itemId === target.itemId).length };
    const same = rows.filter((r) => r.itemId === target.itemId).map((r) => r.instanceId);
    const identical = rows.filter((r) => r.itemId === target.itemId && key(r.enchantments) === key(target.enchantments)).map((r) => r.instanceId);
    setDropAsk({ a, target, identical: identical.length ? identical : [target.instanceId], same: same.length ? same : [target.instanceId], skipped });
  }, []);
  const queueDrop = useCallback(async (which: "one" | "identical" | "same") => {
    if (!dropAsk) return;
    const { a, target, identical, same } = dropAsk;
    const ids = which === "one" ? [target.instanceId] : which === "identical" ? identical : same;
    setDropAsk(null);
    setRefreshMsg(null);
    try {
      const r = await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "drop", guid: a.guid, instanceIds: ids }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setTimeout(() => void search(lastQuery.current), 500);
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : "the drop was not queued");
    }
  }, [dropAsk, password, search]);
  // While any account has a job or a read on it, follow it: the header shows the activity, the card the outcome.
  const anyActivity = accounts?.some((a) => a.activity || a.backpacks?.job || a.characterJobs?.deleteQueue.length || a.characterJobs?.dropQueue.length || a.characterJobs?.createQueue?.length || a.characterJobs?.creating != null) ?? false;
  useEffect(() => {
    if (!anyActivity) return;
    const t = setInterval(() => void search(lastQuery.current), 4000);
    return () => clearInterval(t);
  }, [anyActivity, search]);
  const cancelRefresh = useCallback(async () => {
    await fetch("/api/dev/storage", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "cancel" }) }).catch(() => {});
    void loadRun();
  }, [password, loadRun]);

  const retrySuspended = useCallback(async (guids?: string[]) => {
    setRetryBusy(true);
    setRetryMsg(null);
    try {
      const res = await fetch("/api/dev/accounts", { method: "POST", headers: { "Content-Type": "application/json", "x-dev-password": password }, body: JSON.stringify({ action: "retry-suspended", guids }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const results = (body.results ?? []) as { alias: string; verdict: string; detail: string }[];
      setRetryMsg(results.length ? results.map((r) => `${r.alias}: ${r.verdict === "cleared" ? "cleared, back in the roster" : `${r.verdict}${r.detail ? ` (${r.detail})` : ""}`}`).join(" · ") : "No suspended accounts to retry.");
      void search(lastQuery.current);
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : "retry failed");
    } finally {
      setRetryBusy(false);
    }
  }, [password, search]);

  // Attention first, then online, then the rest; the filter box narrows by name.
  const shown = useMemo(() => {
    if (!accounts) return null;
    const q = itemFilter.trim().toLowerCase();
    const has = (a: Account) => !q || a.ign.toLowerCase().includes(q) || a.alias.toLowerCase().includes(q);
    return accounts.filter(has).map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
  }, [accounts, itemFilter]);
  // Cards that are open: the whole card is the button, and open it shows the email and everything on the account.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const toggleReveal = (guid: string) => setRevealed((prev) => { const next = new Set(prev); if (next.has(guid)) next.delete(guid); else next.add(guid); return next; });


  return (
    <div>
      {deleting && <DeleteCharacterDialog account={deleting.a.ign || deleting.a.alias} ch={deleting.ch} carries={deleting.carries} onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />}
      {dropAsk && <DropItemDialog account={dropAsk.a.ign || dropAsk.a.alias} target={dropAsk.target} identical={dropAsk.identical.length} same={dropAsk.same.length} skipped={dropAsk.skipped} onCancel={() => setDropAsk(null)} onDrop={(which) => void queueDrop(which)} />}
      <form onSubmit={(e) => void addAccount(e)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Add one of your accounts</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 6px", maxWidth: 640 }}>
          Use <b>alt accounts made just for this</b> — never your main account. Each one must have <b>finished the tutorial</b> in the game, and
          have a normal email and password (accounts that sign in with Steam, Google or Kongregate do not work).
        </p>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 10px", maxWidth: 640 }}>
          When you press add, the node asks Realm about the account: if the password is wrong, the account is suspended or the tutorial is not done,
          it says so and adds nothing. Otherwise the account is added and the node reads what it holds, which takes a minute. The password stays on
          this computer.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="email" autoComplete="off" style={{ width: 220 }} />
          <input value={addPassword} onChange={(e) => setAddPassword(e.target.value)} placeholder="password" type="password" autoComplete="new-password" style={{ width: 180 }} />
          <button className="nav-link" type="submit" disabled={addBusy || !addEmail.trim() || !addPassword}>
            {addBusy ? "…" : "add"}
          </button>
        </div>
        {addMsg && <p style={{ color: addMsg.ok ? "var(--good, #5aa86a)" : "var(--bad)", fontSize: 12, margin: "8px 0 0" }}>{addMsg.text}</p>}
      </form>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button className="nav-link" type="button" disabled={retryBusy} onClick={() => void retrySuspended()} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>
          {retryBusy ? "checking…" : "Retry suspended accounts"}
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>re-checks every suspended account against Realm over HTTP (no login) and puts back the ones it accepts</span>
      </div>
      {retryMsg && <p style={{ fontSize: 12, marginBottom: 12 }}>{retryMsg}</p>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button className="nav-link" type="button" disabled={!!run?.running || !accounts?.length} onClick={() => void refresh((accounts ?? []).filter((a) => !a.suspended).map((a) => a.botGuid))} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>
          Refresh every account
        </button>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>logs each account in, reads its character, vault and chests, fetches the account snapshot for the other characters&apos; enchantments, logs out; one account at a time</span>
        {run?.running && (
          <span style={{ fontSize: 12 }}>
            refreshing {run.done}/{run.total}{run.current.length ? ` · ${run.current.map((alias) => accounts?.find((a) => a.alias === alias)?.ign || "an account").join(", ")}` : ""}{" "}
            <button className="nav-link" type="button" onClick={() => void cancelRefresh()}>cancel</button>
          </span>
        )}
      </div>
      {refreshMsg && <p style={{ fontSize: 12, marginBottom: 12 }}>{refreshMsg}</p>}


      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}

      {accounts !== null && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <input value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} placeholder="filter by name or alias…" style={{ flex: "1 1 220px", maxWidth: 360, padding: "5px 8px", fontSize: 12 }} autoComplete="off" />
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {total === 0 ? "no accounts on the roster yet" : shown && itemFilter.trim() ? `${shown.length} of ${total}` : `${total} account${total === 1 ? "" : "s"}`}
          </span>
          {busy && <span style={{ color: "var(--muted)", fontSize: 12 }}>…</span>}
        </div>
      )}

      {shown && shown.length > 0 && (
        <ul className="roster-list">
          {shown.map((a) => {
            const st = statusOf(a);
            const open = revealed.has(a.guid);
            return (
              <li
                key={a.botGuid}
                className={"roster-row" + (open ? " open" : "")}
                style={{ opacity: a.suspended ? 0.75 : 1, borderColor: a.communism ? "var(--accent)" : a.lastLoginError && !a.online && !a.suspended ? "var(--warn, #d2a24c)" : "var(--border)" }}
              >
                <div className="roster-line" role="button" tabIndex={0} aria-expanded={open} title={open ? "Click to fold the card" : "Click to see everything on this account"} onClick={() => toggleReveal(a.guid)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleReveal(a.guid); } }}>
                  <span className="roster-caret" aria-hidden="true">▸</span>
                  <span className="roster-name">{a.ign || a.alias}</span>
                  <span style={{ color: st.color, fontWeight: 600 }}>{st.text}</span>
                  {a.communism && <span className="tab-badge" title="A communism account: everything on it is free for anyone on the hub">communism</span>}
                  {a.server && <span style={{ color: "var(--muted)" }}>· {a.server}</span>}
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>· seen {relTime(a.lastSeen, "never")}</span>
                  {a.activity && <span style={{ color: "var(--accent-hot)", fontSize: 12 }} title="what the node is doing with this account right now">· {a.activity}</span>}
                  <span className="card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>

                    {a.suspended && <button className="login-char-btn" type="button" disabled={retryBusy} onClick={() => void retrySuspended([a.guid])}>retry</button>}
                    {!a.suspended && <button className="login-char-btn" type="button" disabled={!!run?.running} onClick={() => void refresh([a.botGuid])} title="Log in, read the character, vault and chests and the account snapshot, log out">{run?.running && run.current.includes(a.alias) ? "refreshing…" : "refresh"}</button>}
                    {!a.suspended && fixing?.guid !== a.guid && <button className="login-char-btn" type="button" onClick={() => setFixing({ guid: a.guid, email: a.guid, password: "", busy: false })} title="Change the stored email or password">credentials</button>}
                    <button className="login-char-btn login-char-btn-danger" type="button" disabled={removeBusy === a.guid || a.assignedKind !== null} title={a.assignedKind ? "Busy with a trade; wait for it to finish" : "Take this account off the roster"} onClick={() => void removeAccount(a)}>{removeBusy === a.guid ? "removing…" : "remove"}</button>
                    {!a.suspended && (
                      <label className={"login-char-btn" + (a.communism ? " active" : "")} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }} title="A communism account: its slots and items are communism's, open to anyone on the hub. Untick to take it back.">
                        <input type="checkbox" checked={!!a.communism} disabled={communismBusy === a.guid} onChange={(e) => { const next = e.target.checked; if (confirmCommunismChange({ ign: a.ign, alias: a.alias, held: a.held, stored: (a.stored ?? []).length, communism: !!a.communism }, next)) void setCommunism(a.guid, next); }} /> communism
                      </label>
                    )}
                  </span>
                </div>
                {a.storage ? (
                  <>
                    <div className="roster-storage">
                      <span title="character slots the account has, and how many hold a living character">characters {a.storage.chars.created}{a.storage.chars.slots !== null ? `/${a.storage.chars.slots} slots` : ""}</span>
                      <span title="seasonal characters: how many, and their trade slots used and free"><b>seasonal</b> {sideWords(a.storage.sides.seasonal)}</span>
                      <span title="non-seasonal characters: how many, and their trade slots used and free"><b>non-seasonal</b> {sideWords(a.storage.sides.nonseasonal)}</span>
                    </div>
                    <div className="roster-storage">
                      {(() => {
                        const side = a.storage.containersSide;
                        const own = side === null ? "" : `${sideWord(side)} `;
                        const other = a.storage.otherSide;
                        return (
                          <>
                            <span title={`vault chests${side === null ? "" : ` of the ${sideWord(side)} side`}`}>{own}vault {a.storage.vault.used}/{a.storage.vault.slots}</span>
                            <span title="potion rack">{own}rack {a.storage.rack.used}/{a.storage.rack.slots}</span>
                            <span title="gift chest: items, and how many of them the pool trades">{own}gift {a.storage.gift.items}{a.storage.gift.items ? ` (${a.storage.gift.tradeable} tradeable)` : ""}</span>
                            <span title="spoils chest (a non-seasonal character's)">spoils {a.storage.spoils.items}{a.storage.spoils.items ? ` (${a.storage.spoils.tradeable} tradeable)` : ""}</span>
                            {other && (
                              <>
                                <span title={`the ${sideWord(other.seasonal)} side's vault chests, read by a character of that side ${relTime(other.at)}`}>{sideWord(other.seasonal)} vault {other.vault.used}/{other.vault.slots}</span>
                                <span title={`the ${sideWord(other.seasonal)} side's potion rack`}>{sideWord(other.seasonal)} rack {other.rack.used}/{other.rack.slots}</span>
                                <span title={`the ${sideWord(other.seasonal)} side's gift chest`}>{sideWord(other.seasonal)} gift {other.gift.items}{other.gift.items ? ` (${other.gift.tradeable} tradeable)` : ""}</span>
                              </>
                            )}
                            {!other && a.storage.sides.seasonal.chars > 0 && a.storage.sides.nonseasonal.chars > 0 && side !== null && <span title="The account has characters on both sides; the next refresh logs in as one of the other side to read its vault, rack and gift chest">{sideWord(!side)} storage not read yet</span>}
                            <span>{a.vaultReadAt === null ? "storage never read" : `storage read ${relTime(a.vaultReadAt)}`}</span>
                          </>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <div className="roster-storage">
                    <span title="the played character's trade slots">character {a.held}/{a.capacity}</span>
                    <span>storage unknown</span>
                  </div>
                )}
                {open && <AccountItems a={a} onBackpack={(action, o) => void backpackAct(action, a.guid, o)} onNewCharacters={(seasonal, count) => void newCharacters(a.guid, seasonal, count)} onCancelCreates={() => void cancelCreates(a.guid)} newCharBusy={newCharBusy === a.guid} onDeleteCharacter={(ch, carries) => void deleteCharacter(a, ch, carries)} onUnqueueDelete={(charId) => void unqueueDelete(a, charId)} onDropAsk={(target) => askDrop(a, target)} onCancelDrops={() => void cancelDrops(a.guid)} />}
                {a.lastLoginError && !a.online && (
                  <div style={{ color: "var(--bad)", fontSize: 12, marginTop: 4 }}>
                    last login failed {relTime(a.lastLoginError.at)}: {a.lastLoginError.message}{a.lastLoginError.kind === "bad-credentials" ? " — fix them with the credentials button" : ""}
                  </div>
                )}
                {fixing?.guid === a.guid && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                    <input type="email" autoComplete="off" placeholder="email" value={fixing.email} onChange={(e) => setFixing({ ...fixing, email: e.target.value })} style={{ width: 240 }} />
                    <input type="password" autoComplete="new-password" placeholder="password (blank keeps the stored one)" value={fixing.password} onChange={(e) => setFixing({ ...fixing, password: e.target.value })} style={{ width: 260 }} />
                    <button className="nav-link" type="button" disabled={fixing.busy || !fixing.email.trim()} onClick={() => void saveCredentials()}>{fixing.busy ? "checking with Realm…" : "save"}</button>
                    <button className="nav-link" type="button" disabled={fixing.busy} onClick={() => setFixing(null)}>cancel</button>
                    <span className="hint">the pair is tried against Realm and only saved if it works</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
