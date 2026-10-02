// Account storage (docs/relay/STORAGE.md): the vault chests, the potion
// rack, the Gift Chest and the seasonal spoils chest an account has beyond
// its character's trade slots, and the trade slots of the characters the
// fleet is not playing. Everything tradeable in them is listed in the pool
// under an identity of its own (storedInstances); a withdraw that names one
// has the dispatcher order a fetch (StorageService.fetch): the account logs
// in as the character that can reach the item, walks into the Vault for
// whatever sits in a container, and the tracker then holds it like any
// other. The operator can also queue moves by hand from the console; a run
// logs each account in and does them as INVSWAPs against the containers
// VAULTINFO names. The dispatcher leaves an account alone while a trip
// drives it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pickCharId, type GameClient } from "../client/gameClient";
import type { Packet } from "../protocol/packets";
import { BACKPACK_ITEM_TYPE, clientTokenFor, deleteChar, getAccessToken, getAccountDump, getCharListDetail, parseAccountDump, type AccountDump, type CharDetail, type DumpSlot } from "../realm/api";
import type { Proxy } from "../net/proxy";
import { ITEM_BY_ID } from "../../lib/catalog";
import { whereLabel } from "../../lib/poolWire";
import { realmItemNameByType } from "../../lib/sprites";
import { isPoolItem, toCatalogId, toObjType } from "../trade/itemMap";
import { equipSlotOf, quickslotStack, wearableBy } from "../../lib/itemTraits";
import { communismTakes, tradeableOn } from "../../lib/itemPolicy";
import type { BotAccount } from "./botPool";
import { bringUp, BringUpRefused, refusalPasses, takeDown, type BringUpVerdict } from "./bringUp";
import { onlineCapFor } from "./constants";
import { borrowAccount, BUSY_RETRY_MS, LOCKOUT_WAIT_MS } from "./borrow";
import type { Instance } from "./inventoryTracker";
import { snapshotInventory, type SweepDeps } from "./sweeps";
import { dist, enterVault, inWorld, NEXUS_MAP, nextPacket, sleep, VAULT_MAP, waitFor, walkTo, type VaultView } from "./vaultTrip";
import { POTION_INFO } from "./potionConsolidation";

export type ContainerKind = "vault" | "rack" | "gift" | "spoils";
export const CONTAINER_KINDS: ContainerKind[] = ["vault", "rack", "gift", "spoils"];
/**
 * The gift and spoils chests are lists, not grids: VAULTINFO lists only what
 * they hold, so an item taken out (or one expiring) leaves no gap on the next
 * visit, every later item one slot lower (live 2026-09-24: spoils 20 -> 19
 * after one spoilsOut, the next two items each a slot down). Within a visit
 * the slot just empties. A slot read on an earlier visit is a hint there,
 * not an address.
 */
export const LIST_KINDS: ReadonlySet<ContainerKind> = new Set<ContainerKind>(["gift", "spoils"]);
/**
 * A list container's identities carried onto its new slots: same order, same
 * item, an item that left skipped. Items only move down (what leaves closes
 * the gap, what arrives is added at the end), so one read at slot s is now at
 * s or lower; an item that seems to have moved up is taken for a new one.
 */
export function carryListIdentities(prev: Record<number, Instance>, slots: number[]): Record<number, Instance> {
  const out: Record<number, Instance> = {};
  let next = 0;
  for (const s of Object.keys(prev).map(Number).sort((a, b) => a - b)) {
    const inst = prev[s];
    const type = toObjType(inst.itemId);
    const last = Math.min(s, slots.length - 1);
    let k = next;
    while (k <= last && slots[k] !== type) k++;
    if (k <= last) {
      out[k] = inst;
      next = k + 1;
    }
  }
  return out;
}
export const CONTAINER_LABEL: Record<ContainerKind, string> = { vault: "vault chest", rack: "potion rack", gift: "gift chest", spoils: "spoils chest" };
/**
 * Which way a move goes and where. The container moves need the Vault;
 * `unequip` (an equipment slot to the inventory) and `unstack` (one unit out
 * of a quickslot) are swaps on the character itself, done in the Nexus.
 */
export type MoveKind = "bank" | "unbank" | "rackIn" | "rackOut" | "giftOut" | "spoilsOut" | "unequip" | "unstack" | "equip" | "stack" | "drop";
export const MOVE_CONTAINER: Partial<Record<MoveKind, ContainerKind>> = { bank: "vault", unbank: "vault", rackIn: "rack", rackOut: "rack", giftOut: "gift", spoilsOut: "spoils" };
const TO_CONTAINER: Partial<Record<MoveKind, boolean>> = { bank: true, unbank: false, rackIn: true, rackOut: false, giftOut: false, spoilsOut: false };
/** A move that never leaves the character (no Vault walk): out of or into an equipment slot or a quickslot. */
export const isCharMove = (kind: MoveKind): boolean => kind === "unequip" || kind === "unstack" || kind === "equip" || kind === "stack";
/** Thrown on the ground, gone: done last in a trip, wherever the character stands, once the item is in its inventory. */
export const isDrop = (kind: MoveKind): boolean => kind === "drop";
/** Into an equipment slot or a quickslot (a tuck), as opposed to out of one. */
export const isTuckIn = (kind: MoveKind): boolean => kind === "equip" || kind === "stack";
/** Stack size of a potion in a quickslot when the account's MaxStackablePotions is not known (Realm's default). */
export const DEFAULT_POTION_STACK = 6;
/** INVSWAP / USEITEM slot id of the first quickslot; the rest follow (seen live 2026-09-05, rotmgproxy autoheal). */
export const QUICK_SLOT_FIRST = 1_000_000;

export interface Move {
  id: string;
  kind: MoveKind;
  /** Catalog id of the item when the node trades it; untracked items on the character have none. */
  itemId: string | null;
  /** The in-game type, for the swap and a check that the slot still holds it. */
  objectType: number;
  name: string;
  /** Character -> container: the tracked instance that goes, or (untracked) the character slot. */
  instanceId?: string;
  /** Container -> character: the container slot as last seen. Character -> container without an instance: the character slot. */
  slot?: number;
  /** unequip / equip: the equipment slot (0-3); unstack / stack: the quickslot index (0-2). */
  charSlot?: number;
  queuedAt: number;
  /** Why the last run could not do it; the move stays queued for the operator to see. */
  error?: string;
}
export type MoveInput = { kind: MoveKind; instanceId?: string; slot?: number; charSlot?: number };
/** An item the character carries that the node does not trade: it still takes a slot, and can be put away. */
export interface UntrackedSlot {
  slot: number;
  objectType: number;
  name: string;
}

export interface ContainerSnapshot {
  objectId: number;
  /** Object type per slot, -1 for empty: VAULTINFO's list, kept current through this node's own moves. */
  slots: number[];
  /**
   * The identity of what each tradeable slot holds. What this node put there
   * itself (bank / rack in) keeps its instance, enchants included; anything
   * else is given an id the first time it is seen and keeps it while the
   * slot's type holds, so the pool can name it and a withdraw picked before
   * the trip still means the same item afterwards.
   */
  instances: Record<number, Instance>;
}
export type Containers = Record<ContainerKind, ContainerSnapshot>;

/** One character job as the card shows it: a delete, or a new character (its id once made). */
export type CharacterJob =
  | { kind: "delete"; charId: number; at: number; ok: boolean; summary: string }
  | { kind: "create"; charId: number | null; seasonal: boolean; at: number; ok: boolean; summary: string };
/** How many finished character jobs an account remembers for the card. */
const RECENT_CHARACTER_JOBS = 12;

export interface AccountStorageState {
  alias: string;
  guid: string;
  botGuid: string;
  lastVisitAt: number | null;
  containers: Containers | null;
  /** Which side's character read `containers`: a seasonal character sees the seasonal vault, potion rack and gift chest, a non-seasonal one the regular ones and the spoils chest. null before a visit. */
  viewSeasonal?: boolean | null;
  /**
   * The containers the account's other side sees, read by a character of
   * that side during a read (visitLoop): an account with characters on both
   * sides has a vault, potion rack and gift chest per side. Shown on the
   * roster and counted; not in the pool until a fetch can log in as that
   * side's character. null until read.
   */
  otherSide?: { seasonal: boolean; at: number; containers: Containers } | null;
  /** Character slots the account has (char/list's maxNumChars), once read. */
  maxNumChars?: number | null;
  /** Characters the console asked to delete, in order; a worker takes them in one visit when the account is free (one login for all of them). */
  deleteQueue?: number[];
  /** New characters the console asked for, in order, each by side (true: seasonal); a worker makes them one at a time when the account is free, a cooldown apart. */
  createQueue?: boolean[];
  /** When this account last reached the game to make a character: Realm lets an account make one only every 30 seconds. */
  lastCreatedAt?: number | null;
  /** How the last character job (a delete, a new character) went, for the card. */
  lastCharacterJob?: CharacterJob | null;
  /** The last few character jobs, newest first: several deletes queued together each say how they went. */
  recentCharacterJobs?: CharacterJob[];
  /** Item instances the console asked to drop (thrown away in game); a worker takes them in one go when the account is free. */
  dropQueue?: string[];
  /** How the last drop job went, for the card. */
  lastDropJob?: { at: number; ok: boolean; dropped: number; planned: number; summary: string } | null;
  /** Non-catalog items on the character at the last visit (the tracker only knows catalog items). */
  untracked?: UntrackedSlot[];
  chars: CharDetail[] | null;
  charsAt: number | null;
  /** The character the tracker's snapshot describes (its LOAD id), once a login said. */
  loginCharId?: number | null;
  /**
   * Trade-slot items of the characters the fleet is not playing, by
   * character id then slot (from char/list's Equipment). Ids are kept while
   * the slot's type holds, and an item the tracker knew keeps its id when
   * the fleet switches away from its character.
   */
  charItems?: Record<string, Record<number, Instance>>;
  /**
   * When each other character's items were last read with their
   * enchantments, and its trade slots: from the account snapshot
   * (`applySnapshot`, source "snapshot") or from a visit that logged in as
   * it (charsToVisit, source "session"). An item known only from the plain
   * char list is listed without enchantments.
   */
  charVisits?: Record<string, { at: number; capacity: number; source?: "session" | "snapshot" }>;
  /**
   * What each living character wears (equipment slots 0-3) and keeps in its
   * quickslots, as pool items: one swap in the Nexus brings them into the
   * inventory (unequip / unstack). Ids are kept while the slot's type holds;
   * a quickslot stack has one id per unit.
   */
  wornItems?: Record<string, Record<number, Instance>>;
  quickItems?: Record<string, Record<number, { itemId: string; ids: string[] }>>;
  /** What the last account snapshot filed (applySnapshot), for the Storage tab: the sections Realm sent say whether the containers came. */
  lastSnapshot?: (SnapshotNote & { at: number }) | null;
  moves: Move[];
  lastRun: { at: number; ok: boolean; error: string | null; summary: string } | null;
  lastError: string | null;
}
const emptyState = (acc: BotAccount): AccountStorageState => ({ alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, lastVisitAt: null, containers: null, viewSeasonal: null, chars: null, charsAt: null, loginCharId: null, charItems: {}, charVisits: {}, moves: [], lastRun: null, lastError: null });

/** Where a stored item is: a container slot, or a trade slot of a character the fleet is not playing. */
export type StoredWhere =
  | { kind: ContainerKind; slot: number; /** The side whose character sees this container (the vault, rack and gift chest are one per side); undefined when no login said. */ seasonal?: boolean }
  | { kind: "char"; charId: number; slot: number; className: string; level: number; /** Its trade slots, once visited; 8 until then. */ capacity: number; seasonal: boolean }
  /** Worn by a character: one swap in the Nexus into its inventory. */
  | { kind: "worn"; charId: number; slot: number; className: string; level: number; seasonal: boolean }
  /** One unit of a quickslot stack: one swap in the Nexus into the inventory. */
  | { kind: "quickslot"; charId: number; slot: number; count: number; className: string; level: number; seasonal: boolean };
/** Which pool halves a character of the account could carry a stored item to. */
export interface PoolSides {
  seasonal: boolean;
  nonseasonal: boolean;
}
/** An item the account holds beyond the played character's trade slots, as the pool lists it. */
export interface StoredInstance extends Instance {
  where: StoredWhere;
  pools: PoolSides;
}

/**
 * Player classes by object type (objects.xml: Rogue 0x300 ... Kensei 0x332),
 * for the character list. 801 = Necromancer and 784 = Priest were checked
 * against a live account's characters (2026-09-17).
 */
export const CLASS_NAMES: Record<number, string> = {
  768: "Rogue", 775: "Archer", 782: "Wizard", 784: "Priest", 785: "Samurai", 796: "Bard", 797: "Warrior", 798: "Knight", 799: "Paladin",
  800: "Assassin", 801: "Necromancer", 802: "Huntress", 803: "Mystic", 804: "Trickster", 805: "Sorcerer", 806: "Ninja", 817: "Summoner", 818: "Kensei",
};

const isPotion = (itemId: string): boolean => ITEM_BY_ID.get(itemId)?.category === "Potion";
/** What the node calls an object type: the catalog's name, else realm-items.json's, else the number. */
export function nameOfType(objectType: number): { itemId: string | null; name: string; tradeable: boolean } {
  const itemId = toCatalogId(objectType) ?? null;
  const name = (itemId && ITEM_BY_ID.get(itemId)?.name) || realmItemNameByType(objectType) || `#${objectType}`;
  return { itemId, name, tradeable: itemId !== null && isPoolItem(objectType) };
}

// --- the state file ----------------------------------------------------------------

export class StorageStore {
  private readonly accounts = new Map<string, AccountStorageState>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever a state changes: the pool payload is rebuilt when it moves. */
  private rev = 0;
  /** Fired after any change (the site re-serves the pool). */
  onChange: (() => void) | null = null;
  /** Where the raw account snapshots go (`snapshots/<botGuid>.xml` beside the state file): the last body Realm sent per account, for looking at what it carries. */
  get snapshotDir(): string {
    return path.join(path.dirname(this.file), "snapshots");
  }
  /** Keep the last raw snapshot of an account. Private data on the operator's disk, like the state file. */
  /** The character slots the saved snapshot named, for a state written before the count was kept; null without a snapshot. */
  snapshotMaxNumChars(botGuid: string): number | null {
    if (this.slotCounts.has(botGuid)) return this.slotCounts.get(botGuid)!;
    let n: number | null = null;
    try {
      const fd = fs.openSync(path.join(this.snapshotDir, `${botGuid}.xml`), "r");
      try {
        const buf = Buffer.alloc(256);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = /maxNumChars="(\d+)"/.exec(buf.toString("utf8", 0, read));
        if (m) n = Number(m[1]);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // no snapshot kept
    }
    this.slotCounts.set(botGuid, n);
    return n;
  }
  private readonly slotCounts = new Map<string, number | null>();
  keepSnapshot(botGuid: string, xml: string): void {
    this.slotCounts.delete(botGuid);
    try {
      fs.mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.snapshotDir, `${botGuid}.xml`), xml, { mode: 0o600 });
    } catch {
      // Not worth failing a read over.
    }
  }
  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: Record<string, AccountStorageState> };
        // Moves from before a move carried its type and name are dropped; they are cheap to queue again.
        for (const [g, st] of Object.entries(raw.accounts ?? {})) {
          const moves = Array.isArray(st.moves) ? st.moves.filter((m) => Number.isInteger(m.objectType) && typeof m.name === "string") : [];
          // A file from before every slot had an identity named only what this
          // node placed: the rest of what the containers hold gets one now, so
          // it is in the pool without another trip.
          if (st.containers) {
            for (const k of CONTAINER_KINDS) {
              const c = st.containers[k] as ContainerSnapshot & { placed?: Record<number, Instance> };
              if (!c) continue;
              c.instances ??= c.placed ?? {};
              delete c.placed;
              c.slots.forEach((type, slot) => {
                if (c.instances[slot] || type <= 0 || !isPoolItem(type)) return;
                const itemId = toCatalogId(type);
                if (itemId) c.instances[slot] = { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [], capturedAt: Date.now() / 1000 };
              });
            }
          }
          this.accounts.set(g, { ...st, moves, charItems: st.charItems ?? {} });
        }
      }
    } catch (e) {
      console.log(`storage: failed to load ${file}: ${String(e)}`);
    }
  }
  static at(dataDir: string): StorageStore {
    return new StorageStore(path.join(dataDir, "storage_state.json"));
  }
  for(acc: BotAccount): AccountStorageState {
    let st = this.accounts.get(acc.botGuid);
    if (!st) this.accounts.set(acc.botGuid, (st = emptyState(acc)));
    st.alias = acc.alias;
    return st;
  }
  /** Every account's state, loaded or created so far. */
  all(): AccountStorageState[] {
    return [...this.accounts.values()];
  }
  get(botGuid: string): AccountStorageState | undefined {
    return this.accounts.get(botGuid);
  }
  revision(): number {
    return this.rev;
  }
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ accounts: Object.fromEntries(this.accounts) }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.log(`storage: failed to save ${this.file}: ${String(e)}`);
    }
  }
  /** Something changed: write it soon, and tell the pool. */
  requestSave(): void {
    this.rev++;
    this.onChange?.();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 2_000);
    this.saveTimer.unref?.();
  }
}

// --- what the account holds beyond its trade slots (pure) ----------------------------

/** Only a character that exists and lives can carry an item to a pool; without a char list the account's own flag stands in. */
function sidesOf(st: AccountStorageState, accSeasonal: boolean): PoolSides {
  const live = (st.chars ?? []).filter((c) => !c.dead);
  if (!st.chars) return { seasonal: accSeasonal, nonseasonal: !accSeasonal };
  return { seasonal: live.some((c) => c.seasonal), nonseasonal: live.some((c) => !c.seasonal) };
}

/**
 * Every tradeable item in the account's containers and on its other
 * characters, with the pool halves it can be handed out in. The vault, the
 * potion rack and the gift chest are one per side, reachable only by a
 * character of that side, so what the login character read serves its side
 * and the other side's containers (read by a character of that side) serve
 * the other side: a fetch for that half logs in as a character of it
 * (planFetch's charId), as it does for items on another character. The
 * spoils chest serves non-seasonal only; a character's own items its side.
 * `loginCharId` is the character the tracker describes, whose trade slots
 * are the pool proper.
 */
export function storedInstances(st: AccountStorageState, loginCharId: number | null, accSeasonal: boolean): StoredInstance[] {
  const out: StoredInstance[] = [];
  const has = sidesOf(st, accSeasonal);
  const none = (p: PoolSides) => !p.seasonal && !p.nonseasonal;
  const list = (c: Containers, side: boolean | null, poolsFor: Record<ContainerKind, PoolSides>, listEmptyPools: boolean) => {
    for (const kind of CONTAINER_KINDS) {
      const pools = poolsFor[kind];
      if (none(pools) && !listEmptyPools) continue;
      const cont = c[kind];
      if (!cont) continue;
      for (const [s, inst] of Object.entries(cont.instances)) {
        const slot = Number(s);
        if (cont.slots[slot] !== toObjType(inst.itemId)) continue;
        out.push({ ...inst, enchantments: [...inst.enchantments], where: { kind, slot, ...(side === null ? {} : { seasonal: kind === "spoils" ? false : side }) }, pools });
      }
    }
  };
  const c = st.containers;
  if (c) {
    const side = st.viewSeasonal ?? accSeasonal;
    const own: PoolSides = { seasonal: side && has.seasonal, nonseasonal: !side && has.nonseasonal };
    list(c, st.viewSeasonal ?? null, { vault: own, rack: own, gift: own, spoils: { seasonal: false, nonseasonal: has.nonseasonal } }, false);
  }
  if (st.otherSide && (st.viewSeasonal ?? accSeasonal) !== st.otherSide.seasonal) {
    const o = st.otherSide.seasonal;
    const theirs: PoolSides = { seasonal: o && has.seasonal, nonseasonal: !o && has.nonseasonal };
    list(st.otherSide.containers, o, { vault: theirs, rack: theirs, gift: theirs, spoils: { seasonal: false, nonseasonal: !o && has.nonseasonal } }, true);
  }
  for (const ch of st.chars ?? []) {
    if (ch.dead) continue;
    const pools: PoolSides = { seasonal: ch.seasonal, nonseasonal: !ch.seasonal };
    const className = CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}`;
    if (ch.id !== loginCharId) {
      const items = st.charItems?.[String(ch.id)] ?? {};
      for (const [s, inst] of Object.entries(items)) {
        out.push({ ...inst, enchantments: [...inst.enchantments], where: { kind: "char", charId: ch.id, slot: Number(s), className, level: ch.level, capacity: st.charVisits?.[String(ch.id)]?.capacity ?? 8, seasonal: ch.seasonal }, pools });
      }
    }
    // Worn and quickslot items sit on every character, the played one included: one Nexus swap away.
    for (const [s, inst] of Object.entries(st.wornItems?.[String(ch.id)] ?? {})) {
      out.push({ ...inst, enchantments: [...inst.enchantments], where: { kind: "worn", charId: ch.id, slot: Number(s), className, level: ch.level, seasonal: ch.seasonal }, pools });
    }
    for (const [s, stack] of Object.entries(st.quickItems?.[String(ch.id)] ?? {})) {
      for (const id of stack.ids) out.push({ instanceId: id, itemId: stack.itemId, enchantments: [], capturedAt: 0, where: { kind: "quickslot", charId: ch.id, slot: Number(s), count: stack.ids.length, className, level: ch.level, seasonal: ch.seasonal }, pools });
    }
  }
  return out;
}

/**
 * Bring `wornItems` and `quickItems` in line with the char list: every
 * pool item in an equipment slot, and every unit of a pool item stacked in a
 * quickslot, of every living character. Ids are kept while the slot's type
 * holds; a stack keeps the ids it had and grows or shrinks at the end.
 */
export function reconcileTucked(st: AccountStorageState, now: number): void {
  const worn: Record<string, Record<number, Instance>> = {};
  const quick: Record<string, Record<number, { itemId: string; ids: string[] }>> = {};
  for (const ch of st.chars ?? []) {
    if (ch.dead) continue;
    const prevW = st.wornItems?.[String(ch.id)] ?? {};
    const w: Record<number, Instance> = {};
    (ch.equipment ?? []).slice(0, TRADE_SLOT_FIRST).forEach((type, slot) => {
      if (type <= 0 || !isPoolItem(type)) return;
      const itemId = toCatalogId(type);
      if (!itemId) return;
      const kept = prevW[slot];
      w[slot] = kept && kept.itemId === itemId ? kept : { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [], capturedAt: now / 1000 };
    });
    if (Object.keys(w).length) worn[String(ch.id)] = w;
    const prevQ = st.quickItems?.[String(ch.id)] ?? {};
    const q: Record<number, { itemId: string; ids: string[] }> = {};
    (ch.quickslots ?? []).forEach((qs, slot) => {
      if (qs.type <= 0 || qs.count <= 0 || !isPoolItem(qs.type)) return;
      const itemId = toCatalogId(qs.type);
      if (!itemId) return;
      const kept = prevQ[slot]?.itemId === itemId ? prevQ[slot].ids : [];
      const ids = kept.slice(0, qs.count);
      while (ids.length < qs.count) ids.push(randomUUID().replace(/-/g, ""));
      q[slot] = { itemId, ids };
    });
    if (Object.keys(q).length) quick[String(ch.id)] = q;
  }
  st.wornItems = worn;
  st.quickItems = quick;
}

/**
 * A living character of the side the played character is not on, for a
 * read to log in as and look at that side's vault, potion rack and gift
 * chest: one already worth a visit for its items when there is one, else
 * the lowest id. null when the account has no such character, or no login
 * has said which side the played one is on.
 */
export function otherSideChar(st: AccountStorageState, loginCharId: number | null, loginSeasonal: boolean | null, preferred: CharDetail[] = []): CharDetail | null {
  if (loginSeasonal === null) return null;
  const pick = (list: CharDetail[]) => list.filter((c) => !c.dead && c.id !== loginCharId && c.seasonal !== loginSeasonal).sort((a, b) => a.id - b.id)[0] ?? null;
  return pick(preferred) ?? pick(st.chars ?? []);
}

/** The trade slots of a char/list Equipment list: past the 4 equipment slots, as many as it lists. */
const TRADE_SLOT_FIRST = 4;

/**
 * Bring `charItems` in line with the char list: every tradeable item in a
 * trade slot of a character other than `loginCharId` gets an identity, kept
 * from before while the slot's type holds. The played character's entry
 * goes (the tracker describes it), and so do characters no longer listed.
 */
export function reconcileCharItems(st: AccountStorageState, loginCharId: number | null, now: number): void {
  const next: Record<string, Record<number, Instance>> = {};
  for (const ch of st.chars ?? []) {
    if (ch.id === loginCharId || ch.dead) continue;
    const prev = st.charItems?.[String(ch.id)] ?? {};
    const items: Record<number, Instance> = {};
    (ch.equipment ?? []).forEach((type, slot) => {
      if (slot < TRADE_SLOT_FIRST || type <= 0 || !isPoolItem(type)) return;
      const itemId = toCatalogId(type);
      if (!itemId) return;
      const kept = prev[slot];
      items[slot] = kept && kept.itemId === itemId ? kept : { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [], capturedAt: now / 1000 };
    });
    if (Object.keys(items).length) next[String(ch.id)] = items;
  }
  st.charItems = next;
  reconcileTucked(st, now);
}

/** What one account snapshot (char/list with muleDump; realm/api.ts parseAccountDump) filed. */
export interface SnapshotNote {
  /** Other characters filed (living, not the played one). */
  chars: number;
  charItems: number;
  /** Of those, with enchantments. */
  enchanted: number;
  containerEnchanted: number;
  /** Container slots the Vault trip did not see, filled in from the snapshot. */
  extended: number;
  /** The regular side's containers came from this snapshot alone (no Vault trip had described them). */
  created: boolean;
  records: number;
  sections: string[];
  /** Realm sent enchantment data (records, or the blocks that would hold them): the characters need no visit. */
  authoritative: boolean;
}

/**
 * File an account snapshot: the char list it carries, every other
 * character's trade-slot items with their enchantments (one `charVisits`
 * entry each, as a visit would leave), and the enchantments of what the
 * containers hold where the snapshot's slot matches the vault's. The played
 * character is the tracker's; nothing here touches it.
 */
/**
 * `listsFresh`: the snapshot was read in a login with no Vault moves of its own (the account saved at the last
 * logout), so it describes the gift and spoils chests as they are; one read beside a Vault trip lags the trip.
 */
export function applySnapshot(st: AccountStorageState, dump: AccountDump, loginCharId: number | null, now: number, listsFresh = false): SnapshotNote {
  st.chars = dump.chars.map(({ slots: _slots, ...ch }) => ch);
  st.charsAt = now;
  st.maxNumChars = dump.maxNumChars;
  const note: SnapshotNote = { chars: 0, charItems: 0, enchanted: 0, containerEnchanted: 0, extended: 0, created: false, records: dump.records, sections: dump.sections, authoritative: dump.records > 0 || dump.sections.some((s) => s.endsWith("UniqueItemInfo")) };
  for (const ch of dump.chars) {
    if (ch.dead || ch.id === loginCharId) continue;
    const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
    ch.slots.forEach((sl, slot) => {
      if (slot < TRADE_SLOT_FIRST || sl.type <= 0) return;
      const itemId = toCatalogId(sl.type);
      if (itemId) slots[slot] = { itemId, enchantments: sl.enchantments ?? [] };
    });
    const r = recordCharVisit(st, ch.id, { slots, capacity: 8 + ch.backpackSlots }, now);
    st.charVisits![String(ch.id)].source = "snapshot";
    note.chars++;
    note.charItems += r.items;
    note.enchanted += r.enchanted;
  }
  // Worn and quickslot items of every living character, with the records' enchantments on the worn ones.
  reconcileTucked(st, now);
  for (const ch of dump.chars) {
    const w = st.wornItems?.[String(ch.id)];
    if (!w) continue;
    ch.slots.slice(0, TRADE_SLOT_FIRST).forEach((sl, slot) => {
      const inst = w[slot];
      if (inst && sl.enchantments !== null && toCatalogId(sl.type) === inst.itemId) inst.enchantments = [...sl.enchantments];
    });
  }
  // The containers. The snapshot describes the regular side (a seasonal character's vault, rack and gift chest are not
  // in it, live 2026-09-22): that is `containers` when the played character is non-seasonal, else the other side's.
  // Where no Vault trip has described them yet, the snapshot is the view (object ids come with the first trip); a
  // slot whose type matches gets the record's enchantments; slots the trip never saw (VAULTINFO stops at 4096 vault
  // slots; a 566-chest vault has 4528) are taken from the snapshot outright, same order, same login.
  const hasAccount = dump.sections.some((s) => s.startsWith("Account/"));
  const playedSeasonal = dump.chars.find((c) => c.id === loginCharId)?.seasonal ?? st.viewSeasonal ?? null;
  const fromDump = (prev: Containers | null): Containers => {
    const build = (kind: ContainerKind, slots: DumpSlot[]): ContainerSnapshot => {
      const out: ContainerSnapshot = { objectId: prev?.[kind]?.objectId ?? -1, slots: slots.map((s) => s.type), instances: {} };
      const carried = LIST_KINDS.has(kind) ? carryListIdentities(prev?.[kind]?.instances ?? {}, out.slots) : null;
      slots.forEach((sl, i) => {
        const kept = carried ? carried[i] : prev?.[kind]?.instances[i];
        if (kept && kept.itemId === toCatalogId(sl.type)) {
          out.instances[i] = kept;
          return;
        }
        const itemId = sl.type > 0 && isPoolItem(sl.type) ? toCatalogId(sl.type) : undefined;
        if (itemId) out.instances[i] = { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [...(sl.enchantments ?? [])], capturedAt: now / 1000 };
      });
      return out;
    };
    return { vault: build("vault", dump.vault.flat()), rack: build("rack", dump.potions), gift: build("gift", dump.gifts), spoils: build("spoils", dump.temporaryGifts) };
  };
  let regular: Containers | null = null;
  if (hasAccount && playedSeasonal === true) {
    // The played character is seasonal: what the snapshot lists is the other side's.
    const prev = st.otherSide && !st.otherSide.seasonal ? st.otherSide.containers : null;
    if (!prev) note.created = true;
    st.otherSide = { seasonal: false, at: now, containers: prev ?? fromDump(null) };
    regular = st.otherSide.containers;
  } else if (hasAccount && st.viewSeasonal !== true) {
    if (!st.containers) {
      st.containers = fromDump(null);
      st.viewSeasonal = false;
      st.lastVisitAt = now;
      note.created = true;
    }
    regular = st.containers;
  }
  const enrich = (kind: ContainerKind, slots: DumpSlot[]): void => {
    const c = regular?.[kind];
    if (!c) return;
    // A list container (gift, spoils) comes whole with VAULTINFO; the snapshot lags this node's own moves (live
    // 2026-09-24: a spoils item taken out came back listed from it), so a list a trip described is not extended.
    const listSeen = LIST_KINDS.has(kind) && c.objectId >= 0;
    if (listSeen && listsFresh) {
      const types = slots.map((sl) => sl.type);
      if (types.length !== c.slots.length || types.some((t, i) => t !== c.slots[i])) {
        const carried = carryListIdentities(c.instances, types);
        types.forEach((type, i) => {
          if (carried[i] || type <= 0 || !isPoolItem(type)) return;
          const itemId = toCatalogId(type);
          if (itemId) carried[i] = { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [], capturedAt: now / 1000 };
        });
        c.slots = types;
        c.instances = carried;
      }
    }
    if (slots.length > c.slots.length && !listSeen) {
      const from = c.slots.length;
      for (let i = from; i < slots.length; i++) {
        c.slots[i] = slots[i].type;
        const itemId = slots[i].type > 0 && isPoolItem(slots[i].type) ? toCatalogId(slots[i].type) : undefined;
        if (itemId) c.instances[i] = { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [...(slots[i].enchantments ?? [])], capturedAt: now / 1000 };
      }
      note.extended += slots.length - from;
    }
    slots.forEach((sl, i) => {
      const inst = c.instances[i];
      if (sl.enchantments === null || !inst || c.slots[i] !== sl.type) return;
      inst.enchantments = [...sl.enchantments];
      if (sl.enchantments.length) note.containerEnchanted++;
    });
  };
  enrich("vault", dump.vault.flat());
  enrich("rack", dump.potions);
  enrich("gift", dump.gifts);
  enrich("spoils", dump.temporaryGifts);
  return note;
}
const snapshotWords = (n: SnapshotNote): string => `account snapshot: ${n.chars} other character(s), ${n.charItems} item(s) of which ${n.enchanted} enchanted, ${n.containerEnchanted} enchanted in storage${n.created ? ", the containers listed from it" : ""}${n.extended ? `, ${n.extended} storage slot(s) the Vault trip did not see filled in` : ""}, ${n.records} record(s)${n.sections.length ? ` [${n.sections.join(" ")}]` : " [no sections]"}`;

/** Whether char/list lists something tradeable in one of the character's trade slots. */
const carriesTradeables = (ch: CharDetail): boolean => (ch.equipment ?? []).some((type, slot) => slot >= TRADE_SLOT_FIRST && type > 0 && isPoolItem(type));

/**
 * The characters a read logs in as, just to look (docs/relay/STORAGE.md,
 * "Reading the other characters"): living, not the played one, carrying
 * something tradeable per char/list. Never visited first, then the longest
 * ago, so a capped read works through them over several reads.
 */
export function charsToVisit(st: AccountStorageState, playedCharId: number | null, max = 0): CharDetail[] {
  const at = (ch: CharDetail) => st.charVisits?.[String(ch.id)]?.at ?? 0;
  const out = (st.chars ?? []).filter((ch) => !ch.dead && ch.id !== playedCharId && carriesTradeables(ch)).sort((a, b) => at(a) - at(b) || a.id - b.id);
  return max > 0 ? out.slice(0, max) : out;
}

/**
 * File what a visit saw on a character: every tradeable item in its trade
 * slots with the enchantments the session showed, under the identity the
 * slot already had while its type holds. `charVisits` remembers when, and
 * how many trade slots the character has.
 */
export function recordCharVisit(st: AccountStorageState, charId: number, snap: { slots: Record<number, { itemId: string; enchantments: number[] }>; capacity: number }, now: number): { items: number; enchanted: number } {
  const prev = st.charItems?.[String(charId)] ?? {};
  const items: Record<number, Instance> = {};
  let enchanted = 0;
  for (const [s, { itemId, enchantments }] of Object.entries(snap.slots)) {
    const slot = Number(s);
    const type = toObjType(itemId);
    if (slot < TRADE_SLOT_FIRST || type === undefined || !isPoolItem(type)) continue;
    const kept = prev[slot];
    items[slot] = { instanceId: kept && kept.itemId === itemId ? kept.instanceId : randomUUID().replace(/-/g, ""), itemId, enchantments: [...enchantments], capturedAt: now / 1000 };
    if (enchantments.length) enchanted++;
  }
  st.charItems ??= {};
  if (Object.keys(items).length) st.charItems[String(charId)] = items;
  else delete st.charItems[String(charId)];
  st.charVisits ??= {};
  st.charVisits[String(charId)] = { at: now, capacity: snap.capacity };
  return { items: Object.keys(items).length, enchanted };
}

export const VISIT_TIMEOUTS = {
  /** From the socket opening to the character standing in world. */
  inWorldMs: 30_000,
  /** After arrival, for the stats (inventory, enchantments) to finish arriving. */
  settleMs: 4_000,
  /** The inventory must then hold still for this long, within `stableMaxMs`. */
  stableForMs: 1_500,
  stableMaxMs: 10_000,
};
/** A character standing in world with its inventory settled, for a look at it; false when the session ended or it never got there. */
export async function waitForCharacter(client: GameClient, T = VISIT_TIMEOUTS): Promise<boolean> {
  const inWorld = () => client.active && client.objectId !== -1 && !!client.playerData.name;
  const until = Date.now() + T.inWorldMs;
  while (!inWorld() && client.active && Date.now() < until) await sleep(250);
  if (!inWorld()) return false;
  await sleep(T.settleMs);
  const key = () => JSON.stringify([client.hasBackpack, client.playerData.inv.slice(4, 28), client.playerData.enchantments]);
  let last = key();
  let since = Date.now();
  const deadline = Date.now() + T.stableMaxMs;
  while (Date.now() < deadline) {
    if (!client.active) return false;
    const k = key();
    if (k !== last) {
      last = k;
      since = Date.now();
    } else if (Date.now() - since >= T.stableForMs) break;
    await sleep(250);
  }
  return client.active;
}

/** What a withdraw needs on the character that is not there: named items, or so many of a type. */
export interface FetchNeed {
  instanceIds: string[];
  items: { itemId: string; qty: number }[];
}
export interface FetchPlan {
  ok: boolean;
  error: string | null;
  /** Log in as this character first (its items are wanted); null = the played one. */
  charId: number | null;
  /** Container -> character moves, each naming the stored instance it brings. */
  moves: Move[];
  /** Refused with `playedOnly`: another character (or one of the other side) has to log in for it. */
  needsLogin?: boolean;
}

/**
 * How to get `need` onto a character of the account, for the `seasonal`
 * pool: named items are found in storage (a container, or one other
 * character — never two, and never mixed with the played character's own
 * items, which one trade could not carry together); a count of a type is
 * filled from the containers only. Pure; the trip checks slots live.
 * `playedOnly`: a live session of the played character does it (fetchOnline):
 * whatever needs another character is refused (`needsLogin`), and a short
 * character banks to make room rather than handing the trip to a porter.
 */
export function planFetch(st: AccountStorageState, need: FetchNeed, o: { loginCharId: number | null; accSeasonal: boolean; seasonal: boolean; tracked: Record<number, Instance>; playedOnly?: boolean }): FetchPlan {
  const side = o.seasonal ? "seasonal" : "nonseasonal";
  const all = storedInstances(st, o.loginCharId, o.accSeasonal);
  const stored = all.filter((s) => s.pools[side]);
  const byId = new Map(stored.map((s) => [s.instanceId, s]));
  const elsewhere = new Map(all.map((s) => [s.instanceId, s]));
  const onChar = new Set(Object.values(o.tracked).map((i) => i.instanceId));
  const picks: StoredInstance[] = [];
  let charId: number | null = null;
  let playedNamed = false;
  for (const id of need.instanceIds) {
    if (onChar.has(id)) {
      playedNamed = true;
      continue;
    }
    const s = byId.get(id);
    if (!s) {
      const e = elsewhere.get(id);
      return { ok: false, error: e ? `${ITEM_BY_ID.get(e.itemId)?.name ?? e.itemId} is in the ${e.where.kind === "char" ? `${e.where.seasonal ? "seasonal" : "non-seasonal"} character's slots` : whereLabel(e.where)}, which no ${o.seasonal ? "seasonal" : "non-seasonal"} character can reach` : `${id.slice(0, 8)} is not in this account's storage`, charId: null, moves: [] };
    }
    if (s.where.kind === "char" || s.where.kind === "worn" || s.where.kind === "quickslot") {
      if (charId !== null && charId !== s.where.charId) return { ok: false, error: "the items are on two different characters", charId: null, moves: [] };
      charId = s.where.charId;
    }
    picks.push(s);
  }
  if (charId !== null && playedNamed) return { ok: false, error: "the items are on two different characters", charId: null, moves: [] };
  // The played character must be of the wanted side to hand the items over; otherwise one that is logs in.
  const played = (st.chars ?? []).find((c) => c.id === o.loginCharId);
  const playedSide = played ? played.seasonal : o.accSeasonal;
  if (o.playedOnly && charId !== null && charId !== o.loginCharId) return { ok: false, error: `the items are on character #${charId}, which has to log in for them`, charId, moves: [], needsLogin: true };
  if (o.playedOnly && playedSide !== o.seasonal) return { ok: false, error: `the played character is ${playedSide ? "seasonal" : "non-seasonal"}; a ${o.seasonal ? "seasonal" : "non-seasonal"} one has to log in`, charId: null, moves: [], needsLogin: true };
  const freeOf = (c: CharDetail) => (st.charVisits?.[String(c.id)]?.capacity ?? 8 + c.backpackSlots) - Object.keys(st.charItems?.[String(c.id)] ?? {}).length;
  if (charId === null && playedSide !== o.seasonal) {
    const other = (st.chars ?? []).filter((c) => !c.dead && c.seasonal === o.seasonal).sort((a, b) => freeOf(b) - freeOf(a))[0];
    if (!other) return { ok: false, error: `no ${o.seasonal ? "seasonal" : "non-seasonal"} character on the account`, charId: null, moves: [] };
    charId = other.id;
  }
  // The porter rule: container picks need free slots on the character that fetches them; when the played one is short
  // of them, a same-side character with the room does the trip (and then the trade) instead of banking first.
  const containerPicks = picks.filter((p) => p.where.kind !== "char" && p.where.kind !== "worn" && p.where.kind !== "quickslot").length;
  if (charId === null && containerPicks > 0 && !playedNamed && !o.playedOnly) {
    const playedFree = (played ? 8 + played.backpackSlots : 8) - Object.keys(o.tracked).length;
    if (playedFree < containerPicks) {
      const porter = (st.chars ?? []).filter((c) => !c.dead && c.id !== o.loginCharId && c.seasonal === o.seasonal && freeOf(c) >= containerPicks).sort((a, b) => freeOf(b) - freeOf(a))[0];
      if (porter) charId = porter.id;
    }
  }
  const taken = new Set(picks.map((p) => p.instanceId));
  for (const it of need.items) {
    let left = it.qty;
    // Containers first, the rack before the vault for potions (that is where they live), the gift and spoils chests last.
    const order: Record<string, number> = { rack: 0, vault: 1, gift: 2, spoils: 3 };
    const cands = stored.filter((s) => s.itemId === it.itemId && (s.where.kind === "vault" || s.where.kind === "rack" || s.where.kind === "gift" || s.where.kind === "spoils") && !taken.has(s.instanceId)).sort((a, b) => order[a.where.kind] - order[b.where.kind]);
    for (const s of cands) {
      if (left <= 0) break;
      picks.push(s);
      taken.add(s.instanceId);
      left--;
    }
    if (left > 0) return { ok: false, error: `only ${it.qty - left} of ${it.qty} ${ITEM_BY_ID.get(it.itemId)?.name ?? it.itemId} in storage`, charId: null, moves: [] };
  }
  const moves: Move[] = [];
  const OUT: Record<ContainerKind, MoveKind> = { vault: "unbank", rack: "rackOut", gift: "giftOut", spoils: "spoilsOut" };
  for (const p of picks) {
    if (p.where.kind === "char") continue;
    const type = toObjType(p.itemId);
    if (type === undefined) continue;
    const name = ITEM_BY_ID.get(p.itemId)?.name ?? p.itemId;
    if (p.where.kind === "worn") moves.push({ id: randomUUID().slice(0, 8), kind: "unequip", itemId: p.itemId, objectType: type, name, charSlot: p.where.slot, instanceId: p.instanceId, queuedAt: Date.now() });
    else if (p.where.kind === "quickslot") moves.push({ id: randomUUID().slice(0, 8), kind: "unstack", itemId: p.itemId, objectType: type, name, charSlot: p.where.slot, instanceId: p.instanceId, queuedAt: Date.now() });
    else moves.push({ id: randomUUID().slice(0, 8), kind: OUT[p.where.kind], itemId: p.itemId, objectType: type, name, slot: p.where.slot, instanceId: p.instanceId, queuedAt: Date.now() });
  }
  return { ok: true, error: null, charId, moves };
}

/**
 * The tuck: moves that put the played character's inventory items where a
 * swap gets them back, freeing zero-swap slots for what comes in next. Gear
 * the class can wear goes into an empty equipment slot of its kind (one
 * each); quickslot-allowed consumables go into a quickslot holding the same
 * item with room in its stack, else an empty one. Pure; the trip checks
 * slots live. Nothing is tucked that a withdraw counts on (`keep`).
 *
 * `putAway` names items the account must not hold in its trade slots at all
 * (a communism account's items communism does not take): those go into the
 * vault first, as far as it has room; what the vault cannot take falls
 * through to the tuck like anything else.
 */
export function planTuck(st: AccountStorageState, loginCharId: number | null, tracked: Record<number, Instance>, keep: ReadonlySet<string> = new Set(), putAway?: (itemId: string) => boolean): Move[] {
  const ch = (st.chars ?? []).find((c) => c.id === loginCharId);
  if (!ch) return [];
  const className = CLASS_NAMES[ch.objectType] ?? "";
  const equipment = [...(ch.equipment ?? []).slice(0, TRADE_SLOT_FIRST)];
  while (equipment.length < TRADE_SLOT_FIRST) equipment.push(-1);
  const quick = (ch.quickslots ?? []).map((q) => ({ ...q }));
  while (quick.length < 2) quick.push({ type: -1, count: 0 });
  const moves: Move[] = [];
  const bySlot = Object.entries(tracked).sort((a, b) => Number(a[0]) - Number(b[0]));
  const banked = new Set<string>();
  if (putAway) {
    let room = (st.containers?.vault.slots ?? []).filter((t) => t === -1).length;
    for (const [, inst] of bySlot) {
      if (room <= 0) break;
      if (keep.has(inst.instanceId) || !putAway(inst.itemId)) continue;
      const type = toObjType(inst.itemId);
      if (type === undefined) continue;
      moves.push({ id: randomUUID().slice(0, 8), kind: "bank", itemId: inst.itemId, objectType: type, name: ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId, instanceId: inst.instanceId, queuedAt: Date.now() });
      banked.add(inst.instanceId);
      room--;
    }
  }
  for (const [slotStr, inst] of bySlot) {
    if (keep.has(inst.instanceId) || banked.has(inst.instanceId)) continue;
    const type = toObjType(inst.itemId);
    if (type === undefined) continue;
    const name = ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId;
    const eq = equipSlotOf(inst.itemId);
    if (eq !== null && equipment[eq] === -1 && wearableBy(inst.itemId, className)) {
      equipment[eq] = type;
      moves.push({ id: randomUUID().slice(0, 8), kind: "equip", itemId: inst.itemId, objectType: type, name, charSlot: eq, instanceId: inst.instanceId, slot: Number(slotStr), queuedAt: Date.now() });
      continue;
    }
    const stackSize = quickslotStack(inst.itemId);
    if (stackSize === null) continue;
    let q = quick.findIndex((x) => x.type === type && x.count < stackSize);
    if (q < 0) q = quick.findIndex((x) => x.type <= 0 || x.count === 0);
    if (q < 0) continue;
    quick[q] = { type, count: quick[q].count + 1 };
    moves.push({ id: randomUUID().slice(0, 8), kind: "stack", itemId: inst.itemId, objectType: type, name, charSlot: q, instanceId: inst.instanceId, slot: Number(slotStr), queuedAt: Date.now() });
  }
  return moves;
}

/** One thing in a character's trade slots, as compaction moves it: a listed instance, or (none) an item the node does not trade, by its slot. */
export interface CharThing {
  slot: number;
  objectType: number;
  instanceId: string | null;
  itemId: string | null;
}
/** A living character of one side as compaction sees it. */
export interface CompactChar {
  id: number;
  capacity: number;
  things: CharThing[];
}
export interface CompactionPlan {
  ok: boolean;
  error: string | null;
  /** The character emptied. */
  from: number | null;
  /** What it holds: banked first, all of it. */
  things: CharThing[];
  /** Then taken out onto these characters, by index into `things`. */
  to: { charId: number; things: number[] }[];
}

/**
 * Compaction (docs/relay/ADVANCED.md, "Keep an empty character"): which
 * character to empty and where its things go. The emptiest character holding
 * something goes, never one holding a `reserved` id; its potions go to the
 * character already holding the most of that potion, the rest onto as few
 * characters as possible (the fullest one that takes all that is left, else
 * the roomiest). Everything passes through the vault, which must have room
 * for all of it at once. Nothing to do while a character is empty. Pure.
 */
export function planCompaction(chars: CompactChar[], o: { vaultFree: number; reserved: ReadonlySet<string> }): CompactionPlan {
  const fail = (error: string, from: number | null = null): CompactionPlan => ({ ok: false, error, from, things: [], to: [] });
  const empty = chars.find((c) => !c.things.length);
  if (empty) return fail(`character #${empty.id} is empty already`);
  const from = chars.filter((c) => !c.things.some((t) => t.instanceId !== null && o.reserved.has(t.instanceId))).sort((a, b) => a.things.length - b.things.length || a.id - b.id)[0];
  if (!from) return fail("every character holds something spoken for");
  const n = from.things.length;
  if (n > o.vaultFree) return fail(`character #${from.id}'s ${n} item(s) pass through the vault, which has ${o.vaultFree} free slot(s)`, from.id);
  const others = chars.filter((c) => c.id !== from.id).map((c) => {
    const potions: Record<string, number> = {};
    for (const t of c.things) if (t.itemId && t.itemId in POTION_INFO) potions[t.itemId] = (potions[t.itemId] ?? 0) + 1;
    return { id: c.id, free: c.capacity - c.things.length, potions };
  });
  const room = others.reduce((a, c) => a + Math.max(0, c.free), 0);
  if (room < n) return fail(`the other characters have ${room} free slot(s) for character #${from.id}'s ${n} item(s)`, from.id);
  const to = new Map<number, number[]>();
  const put = (c: (typeof others)[number], i: number) => {
    c.free--;
    to.set(c.id, [...(to.get(c.id) ?? []), i]);
  };
  const rest: number[] = [];
  from.things.forEach((t, i) => {
    const potion = t.itemId && t.itemId in POTION_INFO ? t.itemId : null;
    const home = potion ? others.filter((c) => c.free > 0 && (c.potions[potion] ?? 0) > 0).sort((a, b) => b.potions[potion] - a.potions[potion] || a.id - b.id)[0] : undefined;
    if (home && potion) {
      put(home, i);
      home.potions[potion]++;
    } else rest.push(i);
  });
  while (rest.length) {
    const open = others.filter((c) => c.free > 0);
    const c = open.filter((x) => x.free >= rest.length).sort((a, b) => a.free - b.free || a.id - b.id)[0] ?? open.sort((a, b) => b.free - a.free || a.id - b.id)[0];
    for (const i of rest.splice(0, Math.min(c.free, rest.length))) put(c, i);
  }
  return { ok: true, error: null, from: from.id, things: [...from.things], to: [...to].map(([charId, things]) => ({ charId, things })) };
}

// --- planning one move (pure) ---------------------------------------------------------

export interface SlotRef {
  objectId: number;
  slotId: number;
  objectType: number;
}
export interface PlanInput {
  playerObjectId: number;
  /** Object type per character slot (0-3 equipment, 4-11 main, 12-27 backpack). */
  inv: number[];
  tradeSlots: number;
  containers: Record<ContainerKind, { objectId: number; slots: number[] }>;
  /** The tracker's slot -> instance for this bot, as of its last capture. */
  tracked: Record<number, Instance>;
  /** The quickslots as char/list listed them, for an unstack's check; absent = unchecked. */
  quickslots?: { type: number; count: number }[];
  /** Where instances brought into the inventory earlier in this trip landed (instance id -> slot), so a drop finds that copy. */
  landed?: Record<string, number>;
}
export type Plan = { ok: true; from: SlotRef; to: SlotRef; /** null for a move on the character itself. */ container: ContainerKind | null; objectType: number; /** An INVDROP rather than a swap. */ drop?: boolean } | { ok: false; error: string };

/**
 * Where a move's INVSWAP goes. Character -> container: the instance's slot
 * (the tracker's, checked against the live inventory, else any slot holding
 * that item) to the container's first free slot. Container -> character:
 * the named slot, checked to still hold the item, to the first free trade
 * slot. Mutates nothing; the trip applies each swap to its own mirror.
 */
export function planMove(move: Move, st: PlanInput): Plan {
  if (isDrop(move.kind)) {
    // The copy named: where it landed earlier in the trip, else the tracker's slot for it, else any inventory slot holding the type.
    let slot = -1;
    const landed = move.instanceId ? st.landed?.[move.instanceId] : undefined;
    if (landed !== undefined && st.inv[landed] === move.objectType) slot = landed;
    const tracked = slot < 0 && move.instanceId ? Object.entries(st.tracked).find(([, i]) => i.instanceId === move.instanceId) : undefined;
    if (slot < 0 && tracked && st.inv[Number(tracked[0])] === move.objectType) slot = Number(tracked[0]);
    if (slot < 0) for (let i = 4; i < 4 + st.tradeSlots; i++) if (st.inv[i] === move.objectType) { slot = i; break; }
    if (slot < 0) return { ok: false, error: `${move.name} is not in the inventory` };
    const from = { objectId: st.playerObjectId, slotId: slot, objectType: move.objectType };
    return { ok: true, container: null, objectType: move.objectType, from, to: from, drop: true };
  }
  if (isTuckIn(move.kind)) {
    // From the inventory into an equipment slot (must be empty) or a quickslot (empty, or the same item with room in its stack).
    let slot = -1;
    const tracked = move.instanceId ? Object.entries(st.tracked).find(([, i]) => i.instanceId === move.instanceId) : undefined;
    if (tracked && st.inv[Number(tracked[0])] === move.objectType) slot = Number(tracked[0]);
    else for (let i = 4; i < 4 + st.tradeSlots; i++) if (st.inv[i] === move.objectType) { slot = i; break; }
    if (slot < 0) return { ok: false, error: `${move.name} is not on the character` };
    if (move.kind === "equip") {
      const eq = move.charSlot ?? -1;
      if (eq < 0 || eq >= TRADE_SLOT_FIRST) return { ok: false, error: "no equipment slot named" };
      if (st.inv[eq] !== -1) return { ok: false, error: `equipment slot ${eq} is taken` };
      return { ok: true, container: null, objectType: move.objectType, from: { objectId: st.playerObjectId, slotId: slot, objectType: move.objectType }, to: { objectId: st.playerObjectId, slotId: eq, objectType: -1 } };
    }
    const q = move.charSlot ?? -1;
    if (q < 0 || q >= 3) return { ok: false, error: "no quickslot named" };
    const held = st.quickslots?.[q];
    if (held && held.type > 0 && held.type !== move.objectType) return { ok: false, error: `quickslot ${q + 1} holds something else` };
    return { ok: true, container: null, objectType: move.objectType, from: { objectId: st.playerObjectId, slotId: slot, objectType: move.objectType }, to: { objectId: st.playerObjectId, slotId: QUICK_SLOT_FIRST + q, objectType: held && held.type > 0 ? held.type : -1 } };
  }
  if (isCharMove(move.kind)) {
    // Out of an equipment slot or a quickslot into the first free trade slot; both live on the player object.
    const from = move.kind === "unequip" ? move.charSlot ?? -1 : QUICK_SLOT_FIRST + (move.charSlot ?? -1);
    if (move.kind === "unequip" && !(move.charSlot !== undefined && move.charSlot >= 0 && move.charSlot < TRADE_SLOT_FIRST)) return { ok: false, error: "no equipment slot named" };
    if (move.kind === "unstack" && !(move.charSlot !== undefined && move.charSlot >= 0 && move.charSlot < 3)) return { ok: false, error: "no quickslot named" };
    if (move.kind === "unequip" && st.inv[from] !== move.objectType) return { ok: false, error: `equipment slot ${from} no longer holds ${move.name}` };
    if (move.kind === "unstack" && st.quickslots && st.quickslots[move.charSlot!]?.type !== move.objectType) return { ok: false, error: `quickslot ${move.charSlot! + 1} no longer holds ${move.name}` };
    let free = -1;
    for (let i = 4; i < 4 + st.tradeSlots; i++) if (st.inv[i] === -1) { free = i; break; }
    if (free < 0) return { ok: false, error: "no free slot on the character" };
    return { ok: true, container: null, objectType: move.objectType, from: { objectId: st.playerObjectId, slotId: from, objectType: move.objectType }, to: { objectId: st.playerObjectId, slotId: free, objectType: -1 } };
  }
  const kind = MOVE_CONTAINER[move.kind]!;
  const cont = st.containers[kind];
  if (cont.objectId < 0) return { ok: false, error: `the ${CONTAINER_LABEL[kind]} was not announced by the vault` };
  const type = move.objectType;
  if (TO_CONTAINER[move.kind]) {
    if (move.kind === "rackIn" && !(move.itemId && isPotion(move.itemId))) return { ok: false, error: "only potions go in the potion rack" };
    let slot = -1;
    const tracked = move.instanceId ? Object.entries(st.tracked).find(([, i]) => i.instanceId === move.instanceId) : undefined;
    if (tracked && st.inv[Number(tracked[0])] === type) slot = Number(tracked[0]);
    else if (!move.instanceId && move.slot !== undefined && st.inv[move.slot] === type) slot = move.slot;
    else for (let i = 4; i < 4 + st.tradeSlots; i++) if (st.inv[i] === type) { slot = i; break; }
    if (slot < 0) return { ok: false, error: `${move.name} is not on the character` };
    const free = cont.slots.indexOf(-1);
    if (free < 0) return { ok: false, error: `the ${CONTAINER_LABEL[kind]} is full` };
    return { ok: true, container: kind, objectType: type, from: { objectId: st.playerObjectId, slotId: slot, objectType: type }, to: { objectId: cont.objectId, slotId: free, objectType: -1 } };
  }
  let slot = move.slot ?? -1;
  if (LIST_KINDS.has(kind) && cont.slots[slot] !== type) {
    // The list closed up since the slot was read: the item sits lower now, else wherever a copy is.
    let found = -1;
    for (let i = Math.min(slot, cont.slots.length - 1); i >= 0; i--) if (cont.slots[i] === type) { found = i; break; }
    if (found < 0) found = cont.slots.indexOf(type);
    if (found >= 0) slot = found;
  }
  if (slot < 0 || slot >= cont.slots.length) return { ok: false, error: `slot ${slot} is beyond the ${CONTAINER_LABEL[kind]}` };
  if (cont.slots[slot] !== type) return { ok: false, error: `${CONTAINER_LABEL[kind]} slot ${slot} no longer holds ${move.name}` };
  if ((move.kind === "giftOut" || move.kind === "spoilsOut") && !isPoolItem(type)) return { ok: false, error: "not an item the pool trades" };
  let free = -1;
  for (let i = 4; i < 4 + st.tradeSlots; i++) if (st.inv[i] === -1) { free = i; break; }
  if (free < 0) return { ok: false, error: "no free slot on the character" };
  return { ok: true, container: kind, objectType: type, from: { objectId: cont.objectId, slotId: slot, objectType: type }, to: { objectId: st.playerObjectId, slotId: free, objectType: -1 } };
}

/** A container kind's VAULTINFO field. */
const VIEW_KEY: Record<ContainerKind, keyof VaultView> = { vault: "vault", rack: "potion", gift: "gift", spoils: "spoils" };

// --- the trip -----------------------------------------------------------------------

export const STORAGE_TIMEOUTS = {
  inWorldMs: 30_000,
  settleMs: 2_000,
  findObjectMs: 8_000,
  walkMs: 30_000,
  portalWaitMs: 6_000,
  portalAttempts: 4,
  /** A big vault (hundreds of chests, seen live 2026-09-22) takes the server a while to describe. */
  vaultInfoMs: 30_000,
  /** INVRESULT answered every INVSWAP within 120 ms live (2026-09-17); this is generous. */
  swapAckMs: 5_000,
  /** Between swaps; the player's client paced them at 0.5-1 s. */
  swapPaceMs: 700,
  /** How close to a container before swapping with it. */
  chestReach: 1.0,
  /** After VAULTINFO, before the first swap. */
  vaultSettleMs: 1_000,
};
export interface MoveOutcome {
  move: Move;
  ok: boolean;
  detail: string;
  /** The container slot the item went to or came from. */
  slot: number | null;
  /** A container move: the character's inventory slot the item left or landed in. */
  charSlot?: number;
}
export interface StorageTripResult {
  ok: boolean;
  error: string | null;
  summary: string;
  view: VaultView | null;
  outcomes: MoveOutcome[];
  chars: CharDetail[] | null;
  /** Character slots the account has, when the char list came. */
  maxNumChars: number | null;
  /** Items on the character the node does not trade, as of the end of the trip. */
  untracked: UntrackedSlot[];
  /** The character's slots as the trip's own swaps left them (the session's stats may lag the last one by a tick). */
  inv: number[];
}
/** Character slots holding something the catalog does not know. */
export function untrackedSlots(inv: number[], tradeSlots: number): UntrackedSlot[] {
  const out: UntrackedSlot[] = [];
  for (let i = 4; i < 4 + tradeSlots; i++) if (inv[i] > 0 && toCatalogId(inv[i]) === undefined) out.push({ slot: i, objectType: inv[i], name: nameOfType(inv[i]).name });
  return out;
}
export interface StorageTripOptions {
  moves: Move[];
  tracked: Record<number, Instance>;
  /**
   * Items on the character that may be banked to make room when the moves
   * bring in more than the free trade slots hold (a fetch for a withdraw
   * onto a full character). Taken in order, only as many as needed.
   */
  bankable?: Instance[];
  log: (line: string) => void;
  now: () => number;
  timeouts?: Partial<typeof STORAGE_TIMEOUTS>;
  onStep?: (label: string) => void;
  /** The played character's quickslots as char/list listed them, for stack / unstack checks. */
  quickslots?: { type: number; count: number }[];
  /**
   * A session that has stood in the game a while (the dispatcher's bot between trades, docs/relay/ADVANCED.md): its
   * stats are in, so no settle wait, and it counts as arrived only once its CREATE_SUCCESS came (GameClient.inNexus).
   */
  settled?: boolean;
  /** Skip the character list read: the session's own inventory is what the trip works from, and the call costs a second. */
  skipCharList?: boolean;
  /** The bot already stands in the Vault: the view it read on entry, kept current by its trips since. No walk, no portal. */
  vault?: VaultView | null;
  /** Bank moves stop once the vault has no more than this many free slots (the transit reserve compaction moves items through). */
  vaultReserve?: number;
  /**
   * Around each swap that brings an item into the inventory: `null` just before it goes out, then whether it landed.
   * A live session promises the item's identity to the tracker before the dispatcher's next look at the inventory.
   */
  onInbound?: (move: Move, landed: boolean | null) => void;
}
/**
 * Whether a live session stands in the Nexus or the Vault: arrived, its CREATE_SUCCESS in since the map's MAPINFO
 * (`inWorld` trusts an objectId that a map change does not reset, so it reads true too early).
 */
export function standsIn(client: GameClient, map: typeof NEXUS_MAP | typeof VAULT_MAP): boolean {
  return map === VAULT_MAP ? client.inVault() : client.inNexus();
}

/** The order items leave a character to make room: what the account cannot trade away first (a communism account's items communism does not take), then the rest as given. */
export function storeFirst(list: Instance[], communism: boolean): Instance[] {
  return [...list].sort((x, y) => Number(tradeableOn(communism, x.itemId)) - Number(tradeableOn(communism, y.itemId)));
}
/** Bank moves for as many of `bankable` as the inbound moves lack free slots for; [] when they fit. */
export function roomMoves(inv: number[], tradeSlots: number, inbound: number, bankable: Instance[], now: number): Move[] {
  let free = 0;
  for (let i = 4; i < 4 + tradeSlots && i < inv.length; i++) if (inv[i] === -1) free++;
  const short = inbound - free;
  if (short <= 0) return [];
  const out: Move[] = [];
  for (const inst of bankable) {
    if (out.length >= short) break;
    const type = toObjType(inst.itemId);
    if (type === undefined) continue;
    out.push({ id: randomUUID().slice(0, 8), kind: "bank", itemId: inst.itemId, objectType: type, name: ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId, instanceId: inst.instanceId, queuedAt: now });
  }
  return out;
}

/**
 * One account's storage trip on an already-connected client headed for the
 * Nexus: read the character list, enter the Vault, do the moves in order,
 * each an INVSWAP confirmed by its INVRESULT. Never throws for game-side
 * failures: the result says how far it got and how each move went.
 */
export async function runStorageTrip(client: GameClient, o: StorageTripOptions): Promise<StorageTripResult> {
  const T = { ...STORAGE_TIMEOUTS, ...o.timeouts };
  const res: StorageTripResult = { ok: false, error: null, summary: "", view: null, outcomes: [], chars: null, maxNumChars: null, untracked: [], inv: [] };
  const steps: string[] = [];
  const step = (label: string) => o.onStep?.(label);
  // A mirror of what the server holds, moved along as each swap is confirmed; taken once the character stands in the Nexus with its stats in.
  let inv: number[] = [];
  const containers: PlanInput["containers"] = { vault: { objectId: -1, slots: [] }, rack: { objectId: -1, slots: [] }, gift: { objectId: -1, slots: [] }, spoils: { objectId: -1, slots: [] } };
  let n = 0;
  const total = o.moves.length;
  // Where each instance brought into the inventory landed, so a drop later in the trip finds that copy.
  const landed: Record<string, number> = {};
  // The quickslots as char/list last listed them, moved along with each stack / unstack.
  const quick: { type: number; count: number }[] = (o.quickslots ?? []).map((q) => ({ ...q }));
  const quickMirror = (move: Move, delta: number) => {
    if (move.charSlot === undefined || !(move.kind === "stack" || move.kind === "unstack")) return;
    const q = (quick[move.charSlot] ??= { type: -1, count: 0 });
    q.count = Math.max(0, q.count + delta);
    q.type = q.count > 0 ? move.objectType : -1;
  };
  /** One move: plan it against the mirrors, walk up to its container when it has one, swap, record. */
  const doMove = async (move: Move): Promise<void> => {
    n++;
    const label = `${move.kind} ${move.name}`;
    step(`move ${n}/${Math.max(total, n)}: ${label}`);
    if (move.kind === "bank" && o.vaultReserve !== undefined && containers.vault.objectId >= 0 && containers.vault.slots.filter((t) => t === -1).length <= o.vaultReserve) {
      res.outcomes.push({ move, ok: false, detail: "the vault is down to its transit reserve", slot: null });
      steps.push(`${label}: the vault is down to its transit reserve`);
      return;
    }
    const plan = planMove(move, { playerObjectId: client.objectId, inv, tradeSlots: client.playerData.tradeSlots, containers, tracked: o.tracked, landed, ...(o.quickslots ? { quickslots: quick } : {}) });
    if (!plan.ok) {
      res.outcomes.push({ move, ok: false, detail: plan.error, slot: null });
      steps.push(`${label}: ${plan.error}`);
      return;
    }
    if (plan.drop) {
      // INVDROP: the server answers by emptying the slot in the next stats; no INVRESULT is counted on.
      client.send("INVDROP", { slotObject: plan.from, quickSlot: false });
      const deadline = Date.now() + T.swapAckMs;
      while (Date.now() < deadline && client.playerData.inv[plan.from.slotId] === plan.objectType) await sleep(150);
      if (client.playerData.inv[plan.from.slotId] !== plan.objectType) {
        inv[plan.from.slotId] = -1;
        res.outcomes.push({ move, ok: true, detail: `dropped from inventory slot ${plan.from.slotId}`, slot: plan.from.slotId });
        steps.push(`${label}: ok (dropped from inventory slot ${plan.from.slotId})`);
      } else {
        res.outcomes.push({ move, ok: false, detail: "the item stayed in the inventory", slot: plan.from.slotId });
        steps.push(`${label}: the item stayed in the inventory`);
      }
      await sleep(T.swapPaceMs);
      return;
    }
    if (plan.container !== null) {
      // Near the container first; the server refuses swaps from too far (the player's client walked up to each).
      const chest = client.world.entities.get(containers[plan.container].objectId);
      if (chest) {
        const me = client.pos;
        if (!me || dist(me, chest.pos) > T.chestReach) await walkTo(client, chest.pos, T.chestReach, T.walkMs, `the ${CONTAINER_LABEL[plan.container]}`);
        await sleep(300);
      }
    }
    // Into the inventory: out of a container, an equipment slot or a quickslot.
    const inbound = plan.container !== null ? !TO_CONTAINER[move.kind] : move.kind === "unequip" || move.kind === "unstack";
    if (inbound) o.onInbound?.(move, null);
    const answer = nextPacket(client, "INVRESULT", T.swapAckMs, (p) => sameSlot(p.fromSlot, plan.from) && sameSlot(p.toSlot, plan.to));
    client.send("INVSWAP", { time: client.getTime(), pos: { ...(client.pos ?? { x: 0, y: 0 }) }, slotObject1: plan.from, slotObject2: plan.to });
    const r = (await answer) as Packet<"INVRESULT"> | null;
    if (inbound) o.onInbound?.(move, !!(r && r.unknownBool));
    if (plan.container === null) {
      const tuckIn = isTuckIn(move.kind);
      const side = tuckIn ? plan.to : plan.from;
      const where = side.slotId >= QUICK_SLOT_FIRST ? `quickslot ${side.slotId - QUICK_SLOT_FIRST + 1}` : `equipment slot ${side.slotId}`;
      if (r && r.unknownBool) {
        if (tuckIn) {
          // Into an equipment slot or a quickslot: the inventory slot empties; an equipment slot fills.
          inv[plan.from.slotId] = -1;
          if (move.kind === "equip") inv[plan.to.slotId] = plan.objectType;
          quickMirror(move, +1);
          res.outcomes.push({ move, ok: true, detail: `from inventory slot ${plan.from.slotId} to ${where}`, slot: plan.from.slotId });
          steps.push(`${label}: ok (inventory slot ${plan.from.slotId} → ${where})`);
        } else {
          // Out of an equipment slot or a quickslot into the inventory: the inventory mirror gains it; an equipment slot empties, a quickslot loses one unit.
          inv[plan.to.slotId] = plan.objectType;
          if (move.kind === "unequip") inv[plan.from.slotId] = -1;
          if (move.instanceId) landed[move.instanceId] = plan.to.slotId;
          quickMirror(move, -1);
          res.outcomes.push({ move, ok: true, detail: `from ${where} to inventory slot ${plan.to.slotId}`, slot: plan.to.slotId });
          steps.push(`${label}: ok (${where} → inventory slot ${plan.to.slotId})`);
        }
      } else {
        const detail = r ? "the server refused the swap" : "no answer to the swap";
        res.outcomes.push({ move, ok: false, detail, slot: null });
        steps.push(`${label}: ${detail}`);
      }
    } else {
      const contSlot = TO_CONTAINER[move.kind] ? plan.to.slotId : plan.from.slotId;
      const charSlot = TO_CONTAINER[move.kind] ? plan.from.slotId : plan.to.slotId;
      if (r && r.unknownBool) {
        inv[charSlot] = TO_CONTAINER[move.kind] ? -1 : plan.objectType;
        // A list container (gift, spoils) closes the gap only from the next visit on (live 2026-09-24: the next item
        // out of the same visit was refused at its closed-up slot, and taken at it on the next visit).
        containers[plan.container].slots[contSlot] = TO_CONTAINER[move.kind] ? plan.objectType : -1;
        if (!TO_CONTAINER[move.kind] && move.instanceId) landed[move.instanceId] = plan.to.slotId;
        res.outcomes.push({ move, ok: true, detail: `${CONTAINER_LABEL[plan.container]} slot ${contSlot}`, slot: contSlot, charSlot });
        steps.push(`${label}: ok (${CONTAINER_LABEL[plan.container]} slot ${contSlot})`);
      } else {
        const detail = r ? "the server refused the swap" : "no answer to the swap";
        res.outcomes.push({ move, ok: false, detail, slot: contSlot, charSlot });
        steps.push(`${label}: ${detail}`);
      }
    }
    await sleep(T.swapPaceMs);
  };
  try {
    if (o.vault) {
      step("in the Vault");
      await waitFor(client, () => standsIn(client, VAULT_MAP), T.inWorldMs, "the Vault");
    } else {
      step("waiting for the Nexus");
      await waitFor(client, () => (o.settled ? standsIn(client, NEXUS_MAP) : inWorld(client, NEXUS_MAP)), T.inWorldMs, "the Nexus");
      if (!o.settled) await sleep(T.settleMs);
    }
    inv = [...client.playerData.inv];
    steps.push(`in the ${o.vault ? "Vault" : "Nexus"} as ${client.playerData.name} (${client.playerData.tradeSlots} trade slots)`);
    if (!o.skipCharList) {
      step("reading the character list");
      const cl = await getCharListDetail(client.token, client.proxy);
      if (cl.ok) {
        res.chars = cl.value.chars;
        res.maxNumChars = cl.value.maxNumChars;
        steps.push(`${cl.value.chars.length} character(s) of ${cl.value.maxNumChars}`);
      } else steps.push(`char/list ${cl.error.kind}`);
    }

    // 1. Moves on the character itself, right here in the Nexus: worn items and quickslot units into the inventory.
    const charMoves = o.moves.filter((m) => isCharMove(m.kind));
    const contMoves = o.moves.filter((m) => !isCharMove(m.kind) && !isDrop(m.kind));
    const dropMoves = o.moves.filter((m) => isDrop(m.kind));
    for (const move of charMoves) await doMove(move);

    // 2. The Vault, when a move needs a container or when the trip is a plain look at it.
    if (contMoves.length || o.moves.length === 0) {
      let view: VaultView;
      if (o.vault) view = o.vault;
      else {
        step("walking to the Vault Portal");
        view = await enterVault(client, T, o.log);
        // A live session's objectId is the Nexus one until the Vault's CREATE_SUCCESS: the swaps name the player by it.
        if (o.settled) await waitFor(client, () => standsIn(client, VAULT_MAP), T.inWorldMs, "the Vault");
      }
      res.view = view;
      const used = (k: ContainerKind) => view[VIEW_KEY[k]].slots.filter((t) => t > 0).length;
      steps.push(`vault: ${used("vault")}/${view.vault.slots.length} · rack ${used("rack")}/${view.potion.slots.length} · gift ${used("gift")} · spoils ${used("spoils")}`);
      if (!o.vault) await sleep(T.vaultSettleMs);
      containers.vault = { objectId: view.vault.objectId, slots: [...view.vault.slots] };
      containers.rack = { objectId: view.potion.objectId, slots: [...view.potion.slots] };
      containers.gift = { objectId: view.gift.objectId, slots: [...view.gift.slots] };
      containers.spoils = { objectId: view.spoils.objectId, slots: [...view.spoils.slots] };
      // A fetch onto a full character banks what it may first, so the items it brings have slots to land in.
      const inbound = contMoves.filter((m) => !TO_CONTAINER[m.kind]).length;
      const room = o.bankable?.length ? roomMoves(inv, client.playerData.tradeSlots, inbound, o.bankable, o.now()) : [];
      if (room.length) steps.push(`banking ${room.length} item(s) to make room`);
      for (const move of [...room, ...contMoves]) await doMove(move);
      res.view = { ...view, vault: { ...view.vault, slots: containers.vault.slots }, potion: { ...view.potion, slots: containers.rack.slots }, gift: { ...view.gift, slots: containers.gift.slots }, spoils: { ...view.spoils, slots: containers.spoils.slots } };
    }
    // 3. Drops last, wherever the character stands, once everything named is in its inventory.
    for (const move of dropMoves) await doMove(move);
    res.inv = [...inv];
    res.untracked = untrackedSlots(inv, client.playerData.tradeSlots);
    const extra = res.untracked.length;
    if (extra) steps.push(`${extra} item(s) on the character the node does not trade`);
    res.ok = true;
    step("done, logging out");
  } catch (e) {
    res.error = (e as Error).message;
    steps.push(`FAILED: ${res.error}`);
    step("failed, logging out");
  }
  res.summary = steps.join(" | ");
  return res;
}
const sameSlot = (a: { objectId: number; slotId: number }, b: SlotRef): boolean => a.objectId === b.objectId && a.slotId === b.slotId;

/** One living character as the roster lists it: its side, and its trade slots in use and in all. */
export interface CharSlotRow {
  id: number;
  className: string;
  level: number;
  seasonal: boolean;
  /** The character the account logs in as (the tracker describes its slots). */
  login: boolean;
  held: number;
  capacity: number;
}
/**
 * The living characters with their trade slots: the played one as the
 * tracker counts it, every other one as char/list lists it (items past the
 * four equipment slots, 8 slots plus its backpack). The played one first,
 * then by id.
 */
export function charRows(st: AccountStorageState, played: { held: number; capacity: number }): CharSlotRow[] {
  const login = st.loginCharId ?? null;
  const rows: CharSlotRow[] = [];
  for (const ch of st.chars ?? []) {
    if (ch.dead) continue;
    const isLogin = ch.id === login;
    const eq = ch.equipment ?? [];
    const held = isLogin ? played.held : eq.slice(TRADE_SLOT_FIRST).filter((t) => t > 0).length;
    const capacity = isLogin ? played.capacity : st.charVisits?.[String(ch.id)]?.capacity ?? 8 + ch.backpackSlots;
    rows.push({ id: ch.id, className: CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}`, level: ch.level, seasonal: ch.seasonal, login: isLogin, held, capacity });
  }
  return rows.sort((a, b) => Number(b.login) - Number(a.login) || a.id - b.id);
}

// --- the service -----------------------------------------------------------------------

export interface RunState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  current: string[];
  stoppedReason: string | null;
  lastErrors: { alias: string; error: string }[];
  moved: number;
}
/** What one trip came to; `captured`: the tracker was updated from a character in world. */
interface TripOutcome {
  verdict: "ok" | "failed" | "skipped";
  error: string | null;
  outcomes: MoveOutcome[];
  captured: boolean;
  bringUpVerdict?: BringUpVerdict;
  /** The account snapshot read beside the session, when it was. */
  snapshot?: SnapshotNote;
}
const freshRun = (): RunState => ({ running: false, startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, skipped: 0, current: [], stoppedReason: null, lastErrors: [], moved: 0 });

export interface StorageServiceOptions {
  sd: SweepDeps;
  store: StorageStore;
  /** Guids the dispatcher must leave alone while a trip drives them. */
  holds: Set<string>;
  /** Ask the dispatcher to let go of an idle online bot (it disconnects it); false when the bot is busy. */
  release?: (acc: BotAccount) => boolean;
  now?: () => number;
  /** For tests: how long a visit waits for a character's inventory. */
  visitTimeouts?: Partial<typeof VISIT_TIMEOUTS>;
  /** An HTTP read got a token: other services' reads with it (the backpack calendar) before it is dropped. */
  onToken?: (acc: BotAccount, token: string, proxy: Proxy | null) => Promise<void>;
  /** Instances the site has spoken for (a pick, a posted offer, a hand-over): never tucked away, never banked to make room. */
  keep?: () => Set<string>;
  /** For tests: the wait between two new characters on one account (CHARACTER_CREATE_COOLDOWN_S otherwise). */
  createCooldownMs?: number;
  /** For tests: the trip timings of the advanced management chores (bankOnline, fetchOnline, compact, gatherPotions). */
  tripTimeouts?: Partial<typeof STORAGE_TIMEOUTS>;
}

/** How a read's look at the other characters went. */
export interface VisitSummary {
  /** Characters worth a look (charsToVisit). */
  total: number;
  visited: number;
  failed: number;
  /** Why the round ended early, when it did. */
  stopped: string | null;
}
const visitNote = (v: VisitSummary): string => `${v.visited} of ${v.total} other character(s) read${v.failed ? `, ${v.failed} failed` : ""}${v.stopped ? ` (${v.stopped})` : ""}`;

export interface CharRow extends CharDetail {
  className: string;
  /** Tradeable items in its trade slots, when it is not the character being played. */
  items: number;
  /** When a read last logged in as this character to look (null: never, so its items are listed without enchantments). */
  visitedAt: number | null;
  /** Trade slots the session showed at that visit. */
  capacity: number | null;
}
export interface AccountSummary {
  alias: string;
  guid: string;
  botGuid: string;
  ign: string;
  seasonal: boolean;
  suspended: boolean;
  busy: boolean;
  lastVisitAt: number | null;
  charsAt: number | null;
  chars: CharRow[] | null;
  /** The character the account logs in with, when set. */
  preferredCharId: number | null;
  /** The character the tracker's snapshot describes, once a login said. */
  loginCharId: number | null;
  moves: Move[];
  lastRun: AccountStorageState["lastRun"];
  lastSnapshot: AccountStorageState["lastSnapshot"];
  lastError: string | null;
  counts: AccountCounts;
}
/** One side's characters: how many, and their trade slots in use and in all (char/list's Equipment and BackpackSlots; the played character from the tracker). */
export interface SideCount {
  chars: number;
  held: number;
  capacity: number;
}
export interface AccountCounts {
  character: { held: number; capacity: number };
  /** The played character's side's containers. */
  vault: { used: number; slots: number };
  rack: { used: number; slots: number };
  gift: { items: number; tradeable: number };
  spoils: { items: number; tradeable: number };
  /** Which side's character read vault/rack/gift; null before any login said. */
  containersSide: boolean | null;
  /** The other side's vault, rack and gift chest, once a character of that side read them. */
  otherSide: { seasonal: boolean; at: number; vault: { used: number; slots: number }; rack: { used: number; slots: number }; gift: { items: number; tradeable: number } } | null;
  /** Tradeable items on the characters the fleet is not playing. */
  otherChars: number;
  /** Character slots: how many the account has (null until read) and how many living characters fill them. */
  chars: { slots: number | null; created: number };
  sides: { seasonal: SideCount; nonseasonal: SideCount };
}
export interface SlotRow {
  slot: number;
  objectType: number;
  itemId: string | null;
  name: string;
  tradeable: boolean;
  /** The identity the pool lists it under; null for an item the node does not trade. */
  instanceId: string | null;
}
export interface CharItemRow {
  slot: number;
  instanceId: string;
  itemId: string;
  name: string;
  enchantments: number[];
}
export interface AccountDetail extends AccountSummary {
  character: { slot: number; instanceId: string; itemId: string; name: string; enchantments: number[]; potion: boolean }[];
  /** On the character but not traded by the node; they take slots and can be put away. */
  untracked: UntrackedSlot[];
  vault: SlotRow[];
  rack: SlotRow[];
  gift: SlotRow[];
  spoils: SlotRow[];
  /** Tradeable items on the characters the fleet is not playing, by character id. */
  charItems: Record<string, CharItemRow[]>;
}

const STAGGER_MS = Number(process.env.STORAGE_STAGGER_MS ?? 3000);
/** A played character with fewer free slots than this gets its items tucked away (equipment slots, quickslots) by the pass. */
const TUCK_BELOW_FREE = Number(process.env.TUCK_BELOW_FREE ?? 4);
const TUCK_EVERY_MS = Number(process.env.TUCK_EVERY_S ?? 1800) * 1000;
const TUCK_FIRST_MS = Number(process.env.TUCK_FIRST_S ?? 600) * 1000;
/** New characters per account per fill pass, the pause between them, and how often a pass runs (first one soon after start). */
const CHARACTER_FILL_PER_PASS = Number(process.env.CHARACTER_FILL_PER_PASS ?? 2);
const CHARACTER_FILL_STAGGER_MS = Number(process.env.CHARACTER_FILL_STAGGER_S ?? 20) * 1000;
const CHARACTER_FILL_EVERY_MS = Number(process.env.CHARACTER_FILL_EVERY_S ?? 1800) * 1000;
const CHARACTER_FILL_FIRST_MS = Number(process.env.CHARACTER_FILL_FIRST_S ?? 300) * 1000;
/** Realm lets an account make a new character only every 30 seconds: the node waits a second more than that after the last one before it makes the next. */
const CHARACTER_CREATE_COOLDOWN_MS = Number(process.env.CHARACTER_CREATE_COOLDOWN_S ?? 31) * 1000;
/**
 * Fetches for withdraws that may drive accounts at once (each is one login on
 * one exit): as many as the node can have bots online (one per enabled proxy)
 * unless STORAGE_FETCH_MAX_CONCURRENT says fewer.
 */
const FETCH_MAX_CONCURRENT = process.env.STORAGE_FETCH_MAX_CONCURRENT ? Number(process.env.STORAGE_FETCH_MAX_CONCURRENT) : null;
/** Other characters one read logs in as at most (0: all of them; the rest wait for the next read). */
const VISIT_MAX_CHARS = Number(process.env.STORAGE_VISIT_MAX_CHARS ?? 0);

export interface FetchOptions {
  /** The pool half the withdraw is for: decides which side's character may carry the items. */
  seasonal: boolean;
  /** Items on the character that must stay there (named by other open withdraws, personal property). */
  keep?: Set<string>;
  /** Item types other open withdraws draw on this bot for: not banked to make room. */
  keepItems?: Set<string>;
  /** For the log. */
  why?: string;
}
export type FetchResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** Nothing to retry: the items are not in storage as the request names them. */
      permanent?: boolean;
      /** No trip was made: the account was not free (a trade, a run, too many fetches). Ask again soon. */
      busy?: boolean;
      /** fetchOnline only: the live session cannot reach it (another character has it, or it is the other side's); the ordinary fetch logs in as the one that can. */
      needsLogin?: boolean;
    };
/** How a trip on a bot's live session went (bankOnline). */
export interface OnlineTrip {
  ok: boolean;
  /** Items banked. */
  moved: number;
  /** Items still on the character afterwards, the ones the node does not trade included. */
  left: number;
  /** The vault took all it could: it is down to the reserve, or full. */
  vaultFull?: boolean;
  /** No trip was made: the account or the session was not free. Ask again soon. */
  busy?: boolean;
  error?: string;
}
/** How an advanced management chore that logs the account in went (compact, gatherPotions). */
export interface RunResult {
  ok: boolean;
  /** Items moved where they were meant to go. */
  moved: number;
  /** Nothing was tried, and why: nothing to do, no room for it, a character switch still pending. */
  skipped?: string;
  /** No trip was made: the account was not free (a trade, a trip, a login). Ask again later. */
  busy?: boolean;
  error?: string;
}

export class StorageService {
  readonly run: RunState = freshRun();
  private readonly activity = new Map<string, string>();
  /** Accounts a withdraw fetch is driving right now. */
  private readonly fetching = new Set<string>();
  /** Accounts a trip (a run, a fetch, a read and its visits) is driving right now: one trip per account. */
  private readonly tripping = new Set<string>();
  /** Accounts the operator's storage run has still to take (the one under way included). */
  private readonly runPending = new Set<string>();
  /**
   * Live sessions standing in the Vault after a trip of theirs (bankOnline, fetchOnline): the view each read on
   * entry, kept current by its trips since, so the next one swaps where it stands. Dropped at the session's next map
   * (it left the Vault, or reconnected), when its socket drops, or when it stops.
   */
  private readonly liveVaults = new Map<string, { client: GameClient; view: VaultView; off: () => void }>();
  private cancelled = false;
  private readonly now: () => number;
  private readonly visitTimeouts: typeof VISIT_TIMEOUTS;
  private readonly createCooldownMs: number;
  constructor(private readonly o: StorageServiceOptions) {
    this.now = o.now ?? Date.now;
    this.createCooldownMs = o.createCooldownMs ?? CHARACTER_CREATE_COOLDOWN_MS;
    this.visitTimeouts = { ...VISIT_TIMEOUTS, ...o.visitTimeouts };
    // States saved before worn and quickslot items were pool items (2026-09-23) learn them from the char list they already hold.
    for (const st of this.o.store.all()) if (st.chars && (!st.wornItems || !st.quickItems)) reconcileTucked(st, this.now());
  }
  private log(line: string): void {
    this.o.sd.deps.log(line);
  }
  flush(): void {
    this.o.store.save();
  }
  activityOf(guid: string): string | null {
    return this.activity.get(guid) ?? null;
  }
  /** Moves whenever what any account stores changes (the pool payload keys on it). */
  revision(): number {
    return this.o.store.revision();
  }
  private setActivity(guid: string, label: string | null): void {
    if (label === null) this.activity.delete(guid);
    else this.activity.set(guid, label);
  }

  /**
   * Every login: remember which character the tracker is about to describe,
   * and refresh what the others carry from the char list just read. When the
   * character changed since the last login, the previous one's tracked items
   * become its stored items (ids kept), and the new one's known items are
   * promised to the tracker so they keep theirs.
   */
  onLogin(acc: BotAccount, client: GameClient): void {
    const st = this.o.store.for(acc);
    const cl = client.lastCharList;
    if (cl) {
      st.chars = cl.chars;
      st.charsAt = this.now();
    }
    const charId = client.charId;
    if (charId < 0) return;
    const prev = st.loginCharId ?? null;
    if (prev !== null && prev !== charId) {
      const tracked = this.o.sd.tracker.instancesFor(acc.botGuid);
      st.charItems ??= {};
      if (Object.keys(tracked).length) st.charItems[String(prev)] = tracked;
      for (const inst of Object.values(st.charItems[String(charId)] ?? {})) this.o.sd.tracker.expectArrival(acc.botGuid, inst);
      this.log(`storage: ${acc.alias} logs in as character ${charId} (was ${prev}) — ${Object.keys(tracked).length} item(s) stay listed on the other one`);
    }
    st.loginCharId = charId;
    reconcileCharItems(st, charId, this.now());
    this.o.store.requestSave();
  }

  /** When the account's containers were last read (ms), or null: never, so nothing of its storage is listed yet. */
  visitedAt(acc: BotAccount): number | null {
    return this.o.store.get(acc.botGuid)?.lastVisitAt ?? null;
  }
  /** What the account holds beyond the played character's trade slots, for the pool. */
  storedFor(acc: BotAccount): StoredInstance[] {
    const st = this.o.store.get(acc.botGuid);
    if (!st) return [];
    // What the tracker holds is the played character's, whatever loginCharId says: when the two
    // disagree (the account was last read as one character, last played as another) the same
    // instance would be listed as held and as stored, and the hub refuses a publish with a
    // duplicate ref (live 2026-10-01: a communism egg on TipSticky blocked every publish).
    const held = new Set(Object.values(this.o.sd.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId));
    const stored = storedInstances(st, st.loginCharId ?? null, acc.seasonalOrDefault);
    return held.size ? stored.filter((s) => !held.has(s.instanceId)) : stored;
  }

  /** What each character wears (char/list's first four Equipment slots), catalog or not: shown on the roster, never in the pool — an equipped item must be moved to the inventory before it can trade. */
  equippedFor(acc: BotAccount): { charId: number; className: string; level: number; seasonal: boolean; slots: { slot: number; type: number; itemId: string | null; name: string; tradeable: boolean }[] }[] {
    const st = this.o.store.get(acc.botGuid);
    const out: ReturnType<StorageService["equippedFor"]> = [];
    for (const ch of st?.chars ?? []) {
      if (ch.dead) continue;
      const slots = (ch.equipment ?? []).slice(0, TRADE_SLOT_FIRST).map((type, slot) => ({ slot, type, ...nameOfType(type) })).filter((s) => s.type > 0);
      if (slots.length) out.push({ charId: ch.id, className: CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}`, level: ch.level, seasonal: ch.seasonal, slots });
    }
    return out;
  }
  /** The character the account logs in as, as the char list describes it; null before any login. Its side is the account's trading side. */
  loginCharFor(acc: BotAccount): { id: number; className: string; level: number; seasonal: boolean | null } | null {
    const st = this.o.store.get(acc.botGuid);
    if (!st || st.loginCharId == null) return null;
    const ch = st.chars?.find((c) => c.id === st.loginCharId);
    return { id: st.loginCharId, className: ch ? CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}` : "?", level: ch?.level ?? 0, seasonal: ch ? ch.seasonal : st.viewSeasonal ?? acc.seasonal };
  }
  /** Backpacks (the calendar's item) sitting in the account's chests, per side; `unknown` when no login has said which side the containers are. */
  backpacksInChests(acc: BotAccount): { seasonal: number; nonseasonal: number; unknown: number } {
    const st = this.o.store.get(acc.botGuid);
    const out = { seasonal: 0, nonseasonal: 0, unknown: 0 };
    if (!st) return out;
    const count = (c: Containers | null | undefined) => (c ? (["gift", "vault", "spoils"] as const).reduce((n, k) => n + (c[k]?.slots ?? []).filter((t) => t === BACKPACK_ITEM_TYPE).length, 0) : 0);
    const own = count(st.containers);
    if (st.viewSeasonal === true) out.seasonal += own;
    else if (st.viewSeasonal === false) out.nonseasonal += own;
    else out.unknown += own;
    if (st.otherSide) out[st.otherSide.seasonal ? "seasonal" : "nonseasonal"] += count(st.otherSide.containers);
    return out;
  }
  /** A Vault view somebody else read as a character of `seenBy`'s side (a backpack job): the containers of that side follow it. */
  noteVaultView(acc: BotAccount, view: VaultView, seenBy: boolean | null): void {
    const st = this.o.store.for(acc);
    this.applyView(st, view, seenBy);
    this.o.store.requestSave();
  }
  /** A backpack was applied to `charId`: its trade slots are 16 from now on (char/list lags until the character saves). */
  noteBackpackApplied(acc: BotAccount, charId: number): void {
    const st = this.o.store.for(acc);
    const ch = st.chars?.find((c) => c.id === charId);
    if (ch) {
      ch.backpackSlots = Math.max(8, ch.backpackSlots);
      ch.hasBackpack = true;
    }
    const v = st.charVisits?.[String(charId)];
    if (v) v.capacity = Math.max(16, v.capacity);
    if (charId === (st.loginCharId ?? null)) this.o.sd.tracker.noteCapacity(acc.botGuid, Math.max(16, this.o.sd.tracker.capacityFor(acc.botGuid)));
    this.o.store.requestSave();
  }
  /** What an account keeps, counted per container: for the roster's account lines. */
  countsFor(acc: BotAccount): AccountSummary["counts"] {
    return this.counts(acc, this.o.store.for(acc));
  }
  private counts(acc: BotAccount, st: AccountStorageState): AccountCounts {
    const { tracker } = this.o.sd;
    const c = st.containers;
    const o = st.otherSide ?? null;
    const used = (s: number[]) => s.filter((t) => t > 0).length;
    const tradeable = (s: number[]) => s.filter((t) => t > 0 && isPoolItem(t)).length;
    const character = { held: tracker.heldCount(acc.botGuid) + (st.untracked?.length ?? 0), capacity: tracker.capacityFor(acc.botGuid) };
    const sides = { seasonal: { chars: 0, held: 0, capacity: 0 }, nonseasonal: { chars: 0, held: 0, capacity: 0 } };
    for (const ch of charRows(st, character)) {
      const side = ch.seasonal ? sides.seasonal : sides.nonseasonal;
      side.chars++;
      side.held += ch.held;
      side.capacity += ch.capacity;
    }
    return {
      character,
      vault: { used: c ? used(c.vault.slots) : 0, slots: c ? c.vault.slots.length : 0 },
      rack: { used: c ? used(c.rack.slots) : 0, slots: c ? c.rack.slots.length : 0 },
      gift: { items: c ? used(c.gift.slots) : 0, tradeable: c ? tradeable(c.gift.slots) : 0 },
      spoils: { items: c ? used(c.spoils.slots) : 0, tradeable: c ? tradeable(c.spoils.slots) : 0 },
      containersSide: st.viewSeasonal ?? null,
      otherSide: o ? { seasonal: o.seasonal, at: o.at, vault: { used: used(o.containers.vault.slots), slots: o.containers.vault.slots.length }, rack: { used: used(o.containers.rack.slots), slots: o.containers.rack.slots.length }, gift: { items: used(o.containers.gift.slots), tradeable: tradeable(o.containers.gift.slots) } } : null,
      otherChars: Object.values(st.charItems ?? {}).reduce((a, items) => a + Object.keys(items).length, 0),
      chars: { slots: st.maxNumChars ?? this.o.store.snapshotMaxNumChars(acc.botGuid), created: (st.chars ?? []).filter((ch) => !ch.dead).length },
      sides,
    };
  }
  /** Every living character with its side and trade slots, the played one first: for the roster's per-character lines. */
  charsFor(acc: BotAccount): CharSlotRow[] {
    const st = this.o.store.get(acc.botGuid);
    if (!st) return [];
    const { tracker } = this.o.sd;
    return charRows(st, { held: tracker.heldCount(acc.botGuid) + (st.untracked?.length ?? 0), capacity: tracker.capacityFor(acc.botGuid) });
  }
  private summary(acc: BotAccount): AccountSummary {
    const st = this.o.store.for(acc);
    const busy = !!(acc.client && acc.client.active) || acc.assignedRequestId !== null || acc.inUse || this.activity.has(acc.guid);
    return {
      alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, ign: this.o.sd.tracker.ignFor(acc.botGuid) ?? "", seasonal: acc.seasonalOrDefault, suspended: !!acc.suspended, busy,
      lastVisitAt: st.lastVisitAt, charsAt: st.charsAt, chars: st.chars ? st.chars.map((ch) => ({ ...ch, className: CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}`, items: Object.keys(st.charItems?.[String(ch.id)] ?? {}).length, visitedAt: st.charVisits?.[String(ch.id)]?.at ?? null, capacity: st.charVisits?.[String(ch.id)]?.capacity ?? null })) : null,
      preferredCharId: acc.info.charId ?? null, loginCharId: st.loginCharId ?? null, moves: st.moves, lastRun: st.lastRun, lastSnapshot: st.lastSnapshot ?? null, lastError: st.lastError, counts: this.counts(acc, st),
    };
  }
  status(): { run: RunState; accounts: AccountSummary[] } {
    const accounts = this.o.sd.pool.every().map((acc) => this.summary(acc)).sort((a, b) => a.alias.localeCompare(b.alias));
    return { run: { ...this.run, current: [...this.run.current], lastErrors: [...this.run.lastErrors] }, accounts };
  }
  private findAccount(botGuid: string): BotAccount | undefined {
    return this.o.sd.pool.every().find((a) => a.botGuid === botGuid || a.guid === botGuid);
  }
  account(botGuid: string): AccountDetail | null {
    const acc = this.findAccount(botGuid);
    if (!acc) return null;
    const st = this.o.store.for(acc);
    const rows = (c: ContainerSnapshot | undefined): SlotRow[] => {
      if (!c) return [];
      const out: SlotRow[] = [];
      c.slots.forEach((t, slot) => {
        if (t <= 0) return;
        const n = nameOfType(t);
        out.push({ slot, objectType: t, itemId: n.itemId, name: n.name, tradeable: n.tradeable, instanceId: c.instances[slot]?.instanceId ?? null });
      });
      return out;
    };
    const character = Object.entries(this.o.sd.tracker.instancesFor(acc.botGuid)).map(([slot, i]) => ({ slot: Number(slot), instanceId: i.instanceId, itemId: i.itemId, name: ITEM_BY_ID.get(i.itemId)?.name ?? i.itemId, enchantments: i.enchantments, potion: isPotion(i.itemId) })).sort((a, b) => a.slot - b.slot);
    const charItems: Record<string, CharItemRow[]> = {};
    for (const [id, items] of Object.entries(st.charItems ?? {})) {
      charItems[id] = Object.entries(items).map(([slot, i]) => ({ slot: Number(slot), instanceId: i.instanceId, itemId: i.itemId, name: ITEM_BY_ID.get(i.itemId)?.name ?? i.itemId, enchantments: [...i.enchantments] })).sort((a, b) => a.slot - b.slot);
    }
    return { ...this.summary(acc), character, untracked: st.untracked ?? [], vault: rows(st.containers?.vault), rack: rows(st.containers?.rack), gift: rows(st.containers?.gift), spoils: rows(st.containers?.spoils), charItems };
  }

  /** Queue moves for an account. Each is checked against what the node knows now; the trip checks again against the live vault. */
  queue(botGuid: string, adds: MoveInput[]): { ok: true; moves: Move[] } | { ok: false; error: string } {
    const acc = this.findAccount(botGuid);
    if (!acc) return { ok: false, error: "no such account" };
    const st = this.o.store.for(acc);
    const tracked = this.o.sd.tracker.instancesFor(acc.botGuid);
    const out: Move[] = [];
    for (const a of adds) {
      if (!(a.kind in MOVE_CONTAINER) && !isCharMove(a.kind)) return { ok: false, error: `unknown move ${String(a.kind)}` };
      const kind = MOVE_CONTAINER[a.kind];
      if (TO_CONTAINER[a.kind]) {
        if (a.instanceId === undefined && a.slot !== undefined) {
          // An untracked item, by the slot the last visit saw it in.
          const u = (st.untracked ?? []).find((x) => x.slot === Number(a.slot));
          if (!u) return { ok: false, error: "nothing untracked known in that slot; refresh first" };
          if (a.kind === "rackIn") return { ok: false, error: "only potions go in the potion rack" };
          if (st.moves.some((m) => m.instanceId === undefined && m.slot === u.slot && TO_CONTAINER[m.kind])) return { ok: false, error: `${u.name} is already queued` };
          out.push({ id: randomUUID().slice(0, 8), kind: a.kind, itemId: null, objectType: u.objectType, name: u.name, slot: u.slot, queuedAt: this.now() });
          continue;
        }
        const inst = Object.values(tracked).find((i) => i.instanceId === a.instanceId);
        if (!inst) return { ok: false, error: "that item is not on this account's character" };
        const type = toObjType(inst.itemId);
        if (type === undefined) return { ok: false, error: `${inst.itemId} is not an item the node knows` };
        const name = ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId;
        if (st.moves.some((m) => m.instanceId === inst.instanceId)) return { ok: false, error: `${name} is already queued` };
        if (a.kind === "rackIn" && !isPotion(inst.itemId)) return { ok: false, error: "only potions go in the potion rack" };
        out.push({ id: randomUUID().slice(0, 8), kind: a.kind, itemId: inst.itemId, objectType: type, name, instanceId: inst.instanceId, queuedAt: this.now() });
      } else if (isCharMove(a.kind)) {
        // Out of the played character's equipment slot or quickslot; the trip checks the slot live.
        const charSlot = Number(a.charSlot);
        const key = String(st.loginCharId ?? "");
        const inst = a.kind === "unequip" ? st.wornItems?.[key]?.[charSlot] : (() => { const q = st.quickItems?.[key]?.[charSlot]; return q ? { instanceId: q.ids[0], itemId: q.itemId, enchantments: [], capturedAt: 0 } : undefined; })();
        if (!inst) return { ok: false, error: `nothing the node trades in that ${a.kind === "unequip" ? "equipment slot" : "quickslot"} of the played character; refresh first` };
        const type = toObjType(inst.itemId);
        if (type === undefined) return { ok: false, error: `${inst.itemId} is not an item the node knows` };
        if (st.moves.some((m) => m.instanceId === inst.instanceId)) return { ok: false, error: `${ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId} is already queued` };
        out.push({ id: randomUUID().slice(0, 8), kind: a.kind, itemId: inst.itemId, objectType: type, name: ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId, charSlot, instanceId: inst.instanceId, queuedAt: this.now() });
      } else {
        const c = st.containers?.[kind!];
        const slot = Number(a.slot);
        if (!c || !Number.isInteger(slot) || slot < 0 || slot >= c.slots.length || c.slots[slot] <= 0) return { ok: false, error: `nothing known in that ${CONTAINER_LABEL[kind!]} slot; refresh first` };
        const n = nameOfType(c.slots[slot]);
        if (!n.itemId) return { ok: false, error: `${n.name} is not an item the node trades` };
        if ((a.kind === "giftOut" || a.kind === "spoilsOut") && !n.tradeable) return { ok: false, error: `${n.name} is not tradeable` };
        if (st.moves.some((m) => m.kind === a.kind && m.slot === slot)) return { ok: false, error: `${n.name} is already queued` };
        out.push({ id: randomUUID().slice(0, 8), kind: a.kind, itemId: n.itemId, objectType: c.slots[slot], name: n.name, slot, instanceId: c.instances[slot]?.instanceId, queuedAt: this.now() });
      }
    }
    st.moves.push(...out);
    this.o.store.requestSave();
    return { ok: true, moves: st.moves };
  }
  unqueue(botGuid: string, ids?: string[]): number {
    const acc = this.findAccount(botGuid);
    if (!acc) return 0;
    const st = this.o.store.for(acc);
    const before = st.moves.length;
    st.moves = ids ? st.moves.filter((m) => !ids.includes(m.id)) : [];
    this.o.store.requestSave();
    return before - st.moves.length;
  }

  /** Run the queued moves (or, `refresh`, only look) on `guids`, or on every account with moves queued. One account at a time. */
  startRun(opts: { guids?: string[]; refresh?: boolean }): RunState {
    if (this.run.running) throw new Error("a storage run is already going");
    const all = this.o.sd.pool.every().filter((a) => !a.suspended);
    const wanted = opts.guids?.length ? all.filter((a) => opts.guids!.includes(a.guid) || opts.guids!.includes(a.botGuid)) : all.filter((a) => this.o.store.for(a).moves.length > 0);
    if (!wanted.length) throw new Error(opts.guids?.length ? "no such accounts" : "no account has moves queued");
    Object.assign(this.run, freshRun(), { running: true, startedAt: this.now() / 1000, total: wanted.length });
    this.cancelled = false;
    for (const acc of wanted) this.runPending.add(acc.guid);
    void this.runAll(wanted, !!opts.refresh);
    return this.run;
  }
  cancelRun(): boolean {
    if (!this.run.running) return false;
    this.cancelled = true;
    return true;
  }
  private async runAll(accounts: BotAccount[], refresh: boolean): Promise<void> {
    this.log(`storage: ${refresh ? "refresh" : "run"} over ${accounts.length} account(s)`);
    try {
      for (const acc of accounts) {
        if (this.cancelled) {
          this.run.stoppedReason = "cancelled by operator";
          break;
        }
        this.run.current = [acc.alias];
        try {
          const v = await this.one(acc, refresh);
          this.run[v]++;
        } catch (e) {
          this.run.failed++;
          this.run.lastErrors.push({ alias: acc.alias, error: String(e) });
        } finally {
          this.run.done++;
          this.run.current = [];
          this.runPending.delete(acc.guid);
        }
        await sleep(STAGGER_MS);
      }
    } finally {
      this.runPending.clear();
      this.o.store.save();
      this.run.running = false;
      this.run.finishedAt = this.now() / 1000;
      this.log(`storage: done — ${this.run.ok} ok, ${this.run.failed} failed, ${this.run.skipped} skipped, ${this.run.moved} move(s)${this.run.stoppedReason ? ` (${this.run.stoppedReason})` : ""}`);
    }
  }
  private async one(acc: BotAccount, refresh: boolean): Promise<"ok" | "failed" | "skipped"> {
    const st = this.o.store.for(acc);
    if (this.fetching.has(acc.guid)) {
      st.lastError = "fetching for a withdraw";
      return "skipped";
    }
    // A refresh is the account snapshot over HTTP (and one login for the seasonal side when there is one); a run of moves is a trip.
    if (refresh) return (await this.snapshotRefresh(acc, "storage")).verdict;
    const r = await this.trip(acc, [...st.moves], { label: "storage", visitChars: false });
    return r.verdict;
  }

  // The tuck -------------------------------------------------------------------------------
  // A nearly full played character puts what it can into its equipment slots
  // and quickslots (one swap back), so its zero-swap slots take the next
  // deposit; the pass looks every so often, the owner can ask from the console.

  private tuckTimer: ReturnType<typeof setInterval> | null = null;
  private tuckBusy = false;
  /** What a tuck would move on the account's played character right now. A communism account's items communism does not take are banked first. */
  tuckPlanFor(acc: BotAccount): Move[] {
    const st = this.o.store.for(acc);
    return planTuck(st, st.loginCharId ?? null, this.o.sd.tracker.instancesFor(acc.botGuid), this.o.keep?.() ?? new Set(), acc.communism ? (itemId) => !communismTakes(itemId) : undefined);
  }
  /** Tuck the played character's items away: one login, the swaps in the Nexus, log out. */
  async tuck(acc: BotAccount, why = "asked from the console"): Promise<{ ok: boolean; moved: number; planned: number; error: string | null }> {
    const moves = this.tuckPlanFor(acc);
    if (!moves.length) return { ok: true, moved: 0, planned: 0, error: null };
    const r = await this.trip(acc, moves, { label: `tuck (${why})` });
    const moved = r.outcomes.filter((oc) => oc.ok).length;
    return { ok: r.verdict === "ok", moved, planned: moves.length, error: r.error };
  }
  /** One pass: every account whose played character has fewer than TUCK_BELOW_FREE free slots and something to tuck; a communism account with items to bank (communism does not take them) whatever its free count. */
  async tuckPass(): Promise<{ accounts: number; moved: number }> {
    const out = { accounts: 0, moved: 0 };
    if (this.tuckBusy) return out;
    this.tuckBusy = true;
    try {
      for (const acc of this.o.sd.pool.every()) {
        if (acc.suspended || acc.assignedRequestId !== null || acc.inUse) continue;
        const free = this.o.sd.tracker.capacityFor(acc.botGuid) - this.o.sd.tracker.heldCount(acc.botGuid);
        const plan = this.tuckPlanFor(acc);
        const toBank = plan.filter((m) => m.kind === "bank").length;
        if (!plan.length || (free >= TUCK_BELOW_FREE && !toBank)) continue;
        if (this.cancelled) break;
        const r = await this.tuck(acc, toBank ? `${toBank} item(s) communism does not take${free < TUCK_BELOW_FREE ? `, ${free} free slot(s) left` : ""}` : `${free} free slot(s) left`);
        out.accounts++;
        out.moved += r.moved;
      }
      if (out.accounts) this.log(`storage: tuck pass done — ${out.moved} item(s) put away on ${out.accounts} account(s)`);
      return out;
    } finally {
      this.tuckBusy = false;
    }
  }
  startTuck(everyMs = TUCK_EVERY_MS, firstMs = TUCK_FIRST_MS): void {
    if (this.tuckTimer) return;
    const tick = () => void this.tuckPass();
    setTimeout(tick, firstMs).unref?.();
    this.tuckTimer = setInterval(tick, everyMs);
    this.tuckTimer.unref?.();
  }
  stopTuck(): void {
    if (this.tuckTimer) clearInterval(this.tuckTimer);
    this.tuckTimer = null;
  }

  // Character slots -----------------------------------------------------------------------
  // Every character slot is 8 zero-swap item slots, and a new character on an
  // existing account needs no tutorial. The fill pass makes a character in
  // every empty slot, a few per account per pass so the login limit is never
  // met; the owner can also ask for one from the Accounts tab.

  private fillTimer: ReturnType<typeof setInterval> | null = null;
  private fillBusy = false;
  /** Accounts a new character is being made on right now, the cooldown wait included: one at a time per account. */
  private readonly creating = new Set<string>();
  /** How long before Realm lets this account make its next character (0: now). */
  createCooldownLeft(acc: BotAccount): number {
    const last = this.o.store.get(acc.botGuid)?.lastCreatedAt ?? null;
    return last === null ? 0 : Math.max(0, last + this.createCooldownMs - this.now());
  }
  /**
   * Make one new character on the account (a Wizard, of `seasonal`'s side):
   * one login that CREATEs instead of loading, then straight out. Realm lets
   * an account make one only every 30 seconds, so this first waits out what
   * is left of that since the account's last one. `retry`: the failure was
   * the account being busy or its logins held, and another try later may work.
   */
  async createCharacter(acc: BotAccount, seasonal: boolean, why = "asked from the console"): Promise<{ ok: true; charId: number; created: number; slots: number | null } | { ok: false; error: string; retry: boolean }> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `new character (${why})`;
    if (this.creating.has(acc.guid)) return { ok: false, error: "a new character is already being made on this account", retry: true };
    this.creating.add(acc.guid);
    try {
      // Not tied to a storage run's cancel: the queue has its own way back (unqueueCreates).
      for (let left = this.createCooldownLeft(acc); left > 0; left = this.createCooldownLeft(acc)) {
        this.setActivity(acc.guid, `${tag}: next one in ${Math.ceil(left / 1000)} s (Realm allows one new character per ${Math.round(this.createCooldownMs / 1000)} s)`);
        await sleep(Math.min(left, 1000));
      }
      if (acc.assignedRequestId !== null || acc.inUse || this.tripping.has(acc.guid)) return { ok: false, error: "the account is busy", retry: true };
      const slots = st.maxNumChars ?? store.snapshotMaxNumChars(acc.botGuid);
      const living = (st.chars ?? []).filter((c) => !c.dead).length;
      if (slots !== null && living >= slots) return { ok: false, error: `every character slot is taken (${living} of ${slots})`, retry: false };
      const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
      if (!lent.ok) return { ok: false, error: lent.why, retry: true };
      this.tripping.add(acc.guid);
      this.setActivity(acc.guid, `${tag}: logging in`);
      let client: GameClient | null = null;
      try {
        client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3", { createSeasonal: seasonal, createForce: true });
        // The CREATE goes out as the session reaches the Nexus: from here Realm counts it, whether or not the rest goes well.
        st.lastCreatedAt = this.now();
        await waitFor(client, () => inWorld(client!, NEXUS_MAP), STORAGE_TIMEOUTS.inWorldMs, "the Nexus");
        const charId = client.charId;
        const cl = await getCharListDetail(client.token, client.proxy);
        if (cl.ok) {
          st.chars = cl.value.chars;
          st.charsAt = this.now();
          st.maxNumChars = cl.value.maxNumChars;
          reconcileCharItems(st, st.loginCharId ?? null, this.now());
        }
        st.lastCreatedAt = this.now();
        const created = (st.chars ?? []).filter((c) => !c.dead).length;
        this.log(`${tag}: ${acc.alias}: character #${charId} made (${seasonal ? "seasonal" : "non-seasonal"} Wizard); ${created} of ${st.maxNumChars ?? "?"} slots now hold one`);
        return { ok: true, charId, created, slots: st.maxNumChars ?? null };
      } catch (e) {
        const verdict = e instanceof BringUpRefused ? `bring-up ${e.verdict}: ` : "";
        const error = `${verdict}${(e as Error).message}`;
        this.log(`${tag}: ${acc.alias}: failed: ${error}`);
        // Logins held for the account (a rate limit, "account in use", the gate paused) or every proxy host in use: worth another try once that passes.
        const held = refusalPasses(e) || sd.deps.gate.lockoutRemainingMs(acc.guid) > 0;
        return { ok: false, error, retry: held };
      } finally {
        if (client) takeDown(sd.deps, acc, "new character made");
        this.tripping.delete(acc.guid);
        lent.giveBack();
        this.setActivity(acc.guid, null);
        store.requestSave();
      }
    } finally {
      this.creating.delete(acc.guid);
    }
  }
  /** Accounts with an empty character slot: those with a slot count known and fewer living characters than it. */
  fillCandidates(): { acc: BotAccount; living: number; slots: number }[] {
    const out: { acc: BotAccount; living: number; slots: number }[] = [];
    for (const acc of this.o.sd.pool.every()) {
      if (acc.suspended) continue;
      const st = this.o.store.for(acc);
      const slots = st.maxNumChars ?? this.o.store.snapshotMaxNumChars(acc.botGuid);
      if (slots === null) continue;
      const living = (st.chars ?? []).filter((c) => !c.dead).length;
      if (living < slots) out.push({ acc, living, slots });
    }
    return out;
  }
  /** One pass: up to CHARACTER_FILL_PER_PASS new characters per account with empty slots, on the played character's side. */
  async fillPass(): Promise<{ made: number; failed: number }> {
    const out = { made: 0, failed: 0 };
    if (this.fillBusy) return out;
    this.fillBusy = true;
    try {
      const cands = this.fillCandidates();
      if (!cands.length) return out;
      this.log(`storage: filling character slots on ${cands.length} account(s) (${cands.map((c) => `${c.acc.alias} ${c.living}/${c.slots}`).join(", ")}), up to ${CHARACTER_FILL_PER_PASS} each this pass`);
      for (const c of cands) {
        const st = this.o.store.for(c.acc);
        const side = st.chars?.find((ch) => ch.id === st.loginCharId)?.seasonal ?? c.acc.seasonalOrDefault;
        for (let i = 0; i < CHARACTER_FILL_PER_PASS && c.living + i < c.slots; i++) {
          if (this.cancelled) return out;
          const r = await this.createCharacter(c.acc, side, "filling character slots");
          if (r.ok) out.made++;
          else {
            out.failed++;
            break;
          }
          await sleep(CHARACTER_FILL_STAGGER_MS);
        }
      }
      if (out.made || out.failed) this.log(`storage: character fill pass done — ${out.made} made, ${out.failed} failed`);
      return out;
    } finally {
      this.fillBusy = false;
    }
  }
  startCharacterFill(everyMs = CHARACTER_FILL_EVERY_MS, firstMs = CHARACTER_FILL_FIRST_MS): void {
    if (this.fillTimer) return;
    const tick = () => void this.fillPass();
    setTimeout(tick, firstMs).unref?.();
    this.fillTimer = setInterval(tick, everyMs);
    this.fillTimer.unref?.();
  }
  stopCharacterFill(): void {
    if (this.fillTimer) clearInterval(this.fillTimer);
    this.fillTimer = null;
  }

  /**
   * A refresh without entering the game: the account snapshot over HTTP
   * (httpRead) describes the played character, every other character and
   * the regular side's containers in one call. Only the seasonal side's
   * vault, rack and gift chest are not in it; an account with a character
   * of the side the played one is not on gets one login as that character
   * to read them (visitLoop). Borrowed for the duration like a trip.
   */
  private async snapshotRefresh(acc: BotAccount, label: string): Promise<TripOutcome> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = label;
    if (acc.assignedRequestId !== null || acc.inUse) {
      st.lastError = "busy with a trade";
      return { verdict: "skipped", error: st.lastError, outcomes: [], captured: false };
    }
    if (this.tripping.has(acc.guid)) {
      st.lastError = "another trip is driving the account";
      return { verdict: "skipped", error: st.lastError, outcomes: [], captured: false };
    }
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) {
      st.lastError = lent.why;
      return { verdict: "skipped", error: lent.why, outcomes: [], captured: false };
    }
    this.tripping.add(acc.guid);
    try {
      const r = await this.httpRead(acc, st, tag);
      if (!r.ok) return { verdict: r.locked ? "skipped" : "failed", error: r.error, outcomes: [], captured: false, bringUpVerdict: r.locked ? "locked" : "failed" };
      const v = await this.visitLoop(acc, st, tag, { items: false, containers: true });
      if (v.total) {
        const note = visitNote(v);
        if (st.lastRun) st.lastRun.summary = `${st.lastRun.summary} | ${note}`;
        if ((v.failed || v.stopped) && st.lastError === null) st.lastError = note;
        this.log(`${tag}: ${acc.alias}: ${note}`);
      }
      return { verdict: "ok", error: null, outcomes: [], captured: true, snapshot: r.snapshot };
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /**
   * The account snapshot with a token from account/verify, no game session:
   * the played character's trade slots go to the tracker (its identity is
   * the character char/list would load, acc.info.charId first), the rest
   * to applySnapshot. Realm's login gate applies to the token as to a
   * login; a refusal is filed the way bring-up files it.
   */
  /**
   * A token from account/verify for an HTTP-only job, through the probe
   * proxy, with the login gate respected and a refusal filed the way bring-up
   * files it. With a proxy list loaded the call never goes out from this
   * computer's own address: while every host carries a bot, the job waits
   * for one to come free until `proxyUntil` (the gate's patience, from when
   * it asked), and then gives up saying so, `busy` (a queued job tries again
   * later: the account itself is fine).
   */
  private async httpToken(acc: BotAccount, tag: string, proxyUntil = this.now() + LOCKOUT_WAIT_MS): Promise<{ ok: true; token: string; proxy: Proxy | null } | { ok: false; error: string; locked: boolean; busy?: boolean }> {
    const { sd } = this.o;
    const { proxies, gate } = sd.deps;
    if (!acc.info.guid || (!acc.info.password && !acc.info.secret)) return { ok: false, error: "empty guid or password", locked: false };
    if (gate.pausedRemainingMs() > 0) return { ok: false, error: "logins paused", locked: true };
    this.setActivity(acc.guid, `${tag}: waiting for the login cooldown`);
    if (!(await this.waitForGate(acc))) return { ok: false, error: "login-locked", locked: true };
    let proxy: Proxy | null = null;
    if (proxies.configured) {
      if (!proxies.probeFor(acc.guid)) this.setActivity(acc.guid, `${tag}: waiting for a free proxy`);
      proxy = await proxies.probeWhenFree(acc.guid, proxyUntil, { cancelled: () => this.cancelled, now: this.now });
      if (!proxy) return { ok: false, error: `no free proxy: ${proxies.noFreeHostReason()}`, locked: false, busy: proxies.hasEnabledHost() };
    } else if (acc.info.proxy?.host) {
      const p = acc.info.proxy;
      proxy = { host: String(p.host), port: Number(p.port), type: p.type === 4 ? 4 : 5, username: p.username ?? "", password: p.password ?? "" };
    }
    if (!proxy && sd.deps.requireProxy?.()) return { ok: false, error: "no proxy: proxies are required", locked: false };
    const tok = await getAccessToken({ guid: acc.info.guid, password: acc.info.password ?? "", secret: acc.info.secret }, clientTokenFor(acc.info.guid, acc.info.password ?? ""), proxy);
    if (!tok.ok) {
      const e = tok.error;
      if (proxy && e.kind === "network") proxies.noteResult(proxies.keyOf(proxy), false);
      if (e.kind === "attempt-limit") gate.noteAttemptLimit(acc.guid, e.lockoutSeconds);
      if (e.kind === "account-in-use") gate.noteCooldown(acc.guid, e.seconds, "account in use at account/verify");
      if (e.kind === "bad-credentials") gate.noteBadCredentials(acc.guid);
      acc.lastLoginError = { at: Date.now(), kind: e.kind, message: e.kind === "bad-credentials" ? "Realm did not accept these credentials" : e.kind === "suspended" ? "Realm says the account is suspended" : e.kind === "attempt-limit" ? "Realm's login attempt limit" : e.kind === "account-in-use" ? `account in use elsewhere (${e.seconds}s)` : e.kind === "network" ? `network error via ${proxy?.host ?? "direct"}: ${e.detail}` : `Realm answered: ${e.body.replace(/\s+/g, " ").slice(0, 120)}` };
      return { ok: false, error: `account/verify: ${acc.lastLoginError.message}`, locked: e.kind === "attempt-limit" || e.kind === "account-in-use" };
    }
    return { ok: true, token: tok.value, proxy };
  }

  private readonly deleting = new Set<string>();
  /** guid -> the character being deleted right now: the rest of the account's queue waits behind it, and it can no longer be taken back. */
  private readonly deletingNow = new Map<string, number>();
  /** Queue a character for deletion; the console is free at once. The worker runs the queue when the account is free, retrying a busy account for a while. Several may be queued: they go in one visit. */
  queueDelete(acc: BotAccount, charId: number): { ok: true; queue: number[] } | { ok: false; error: string } {
    const st = this.o.store.for(acc);
    if (!(st.chars ?? []).some((c) => c.id === charId)) return { ok: false, error: `no character #${charId} on this account` };
    st.deleteQueue ??= [];
    if (!st.deleteQueue.includes(charId)) st.deleteQueue.push(charId);
    this.o.store.requestSave();
    if (!this.deleting.has(acc.guid)) void this.drainDeletes(acc);
    return { ok: true, queue: [...st.deleteQueue] };
  }
  /** Take a queued delete back before it runs; the one under way cannot be. */
  unqueueDelete(acc: BotAccount, charId: number): { ok: true; queue: number[] } | { ok: false; error: string } {
    const st = this.o.store.for(acc);
    if (this.deletingNow.get(acc.guid) === charId) return { ok: false, error: `character #${charId} is being deleted right now` };
    if (!(st.deleteQueue ?? []).includes(charId)) return { ok: false, error: `character #${charId} is not queued for deletion` };
    st.deleteQueue = (st.deleteQueue ?? []).filter((id) => id !== charId);
    this.o.store.requestSave();
    this.log(`delete character #${charId}: ${acc.alias}: taken back from the queue before it ran`);
    return { ok: true, queue: [...st.deleteQueue] };
  }
  private noteCharacterJob(st: AccountStorageState, job: CharacterJob): void {
    st.lastCharacterJob = job;
    st.recentCharacterJobs = [job, ...(st.recentCharacterJobs ?? [])].slice(0, RECENT_CHARACTER_JOBS);
  }
  /** guid -> why a queued job waits for the account right now (for the console); gone while it runs. */
  private readonly deleteWaiting = new Map<string, string>();
  private readonly createWaiting = new Map<string, string>();
  private readonly dropWaiting = new Map<string, string>();
  private async drainDeletes(acc: BotAccount): Promise<void> {
    const st = this.o.store.for(acc);
    this.deleting.add(acc.guid);
    try {
      // Not tied to a storage run's cancel: the queue has its own way back (unqueueDelete).
      while (st.deleteQueue?.length) {
        const r = await this.deleteQueued(acc, "queued from the console");
        if (r.ok) continue;
        // A busy account (a trade, a trip, a login under way, a cooldown, every proxy host carrying a bot): wait for it, however long that takes.
        if (r.retry) {
          this.deleteWaiting.set(acc.guid, r.error);
          await sleep(BUSY_RETRY_MS);
          this.deleteWaiting.delete(acc.guid);
          continue;
        }
        // The account cannot log in (its credentials, a suspension, Realm's answer): what is still queued fails, saying why.
        for (const charId of st.deleteQueue ?? []) this.noteCharacterJob(st, { kind: "delete", charId, at: this.now(), ok: false, summary: `character #${charId} not deleted: ${r.error}` });
        st.deleteQueue = [];
        this.o.store.requestSave();
      }
    } finally {
      this.deleteWaiting.delete(acc.guid);
      this.deleting.delete(acc.guid);
    }
  }
  /**
   * Work through the account's delete queue in one visit: borrow it once and
   * take one HTTP token (one login at account/verify) for every delete, the
   * queue read again after each, so what the console adds meanwhile rides
   * along and what it takes back is skipped. Refused with `retry` while the
   * account is busy or locked out, or every proxy host carries a bot.
   */
  private async deleteQueued(acc: BotAccount, why: string): Promise<{ ok: true } | { ok: false; error: string; retry: boolean }> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const n = st.deleteQueue?.length ?? 0;
    if (!n) return { ok: true };
    const tag = `delete ${n === 1 ? `character #${st.deleteQueue![0]}` : `${n} characters`} (${why})`;
    if (acc.assignedRequestId !== null || acc.inUse || this.tripping.has(acc.guid)) return { ok: false, error: "the account is busy", retry: true };
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return { ok: false, error: lent.why, retry: true };
    this.tripping.add(acc.guid);
    try {
      const got = await this.httpToken(acc, tag);
      if (!got.ok) return { ok: false, error: got.error, retry: got.locked || !!got.busy };
      while (st.deleteQueue?.length) {
        const charId = st.deleteQueue[0];
        this.deletingNow.set(acc.guid, charId);
        const more = st.deleteQueue.length - 1;
        this.setActivity(acc.guid, `delete character #${charId} (${why}): deleting${more ? ` · ${more} more queued` : ""}`);
        const r = await this.deleteWithToken(acc, charId, got, `delete character #${charId} (${why})`);
        st.deleteQueue = (st.deleteQueue ?? []).filter((id) => id !== charId);
        this.noteCharacterJob(st, { kind: "delete", charId, at: this.now(), ok: r.ok, summary: r.ok ? `character #${charId} deleted; ${r.remaining} of ${r.slots ?? "?"} slots hold one` : `character #${charId} not deleted: ${r.error}` });
        store.requestSave();
      }
      return { ok: true };
    } finally {
      this.deletingNow.delete(acc.guid);
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }
  // New characters, queued ---------------------------------------------------------------
  // The console asks for several at once; a worker per account makes them one
  // at a time, each a login, waiting out Realm's cooldown between two and a
  // busy account for as long as it stays busy (as a queued delete does).

  private readonly createDraining = new Set<string>();
  /** guid -> the side of the new character being made right now (it has left the queue: it cannot be taken back). */
  private readonly creatingNow = new Map<string, boolean>();
  /** Queue `count` new characters of `seasonal`'s side; the console is free at once. No more than the account's empty slots, less what is already queued. */
  queueCreate(acc: BotAccount, seasonal: boolean, count: number): { ok: true; queue: boolean[] } | { ok: false; error: string } {
    if (!Number.isInteger(count) || count < 1) return { ok: false, error: "how many: at least 1" };
    const st = this.o.store.for(acc);
    const slots = st.maxNumChars ?? this.o.store.snapshotMaxNumChars(acc.botGuid);
    if (slots === null) return { ok: false, error: "the account's character slots are not known yet: refresh the account first" };
    const living = (st.chars ?? []).filter((c) => !c.dead).length;
    const waiting = (st.createQueue?.length ?? 0) + (this.creatingNow.has(acc.guid) ? 1 : 0);
    const room = slots - living - waiting;
    if (room <= 0) return { ok: false, error: waiting ? `every empty slot already has a new character on the way (${waiting})` : `every character slot is taken (${living} of ${slots})` };
    if (count > room) return { ok: false, error: `only ${room} empty slot${room === 1 ? "" : "s"} left for new characters` };
    st.createQueue = [...(st.createQueue ?? []), ...Array<boolean>(count).fill(seasonal)];
    this.o.store.requestSave();
    this.log(`new characters: ${acc.alias}: ${count} ${seasonal ? "seasonal" : "non-seasonal"} queued (${st.createQueue.length} waiting)`);
    if (!this.createDraining.has(acc.guid)) void this.drainCreates(acc);
    return { ok: true, queue: [...st.createQueue] };
  }
  /** Take back the new characters still waiting, the one off the queue too while it waits for a busy account; one on its way (the cooldown, the login) goes on. */
  unqueueCreates(acc: BotAccount): { ok: true; dropped: number } {
    const st = this.o.store.for(acc);
    const dropped = (st.createQueue?.length ?? 0) + (this.createWaiting.delete(acc.guid) ? 1 : 0);
    st.createQueue = [];
    this.o.store.requestSave();
    if (dropped) this.log(`new characters: ${acc.alias}: ${dropped} taken back from the queue before they were made`);
    return { ok: true, dropped };
  }
  private async drainCreates(acc: BotAccount): Promise<void> {
    const st = this.o.store.for(acc);
    this.createDraining.add(acc.guid);
    try {
      while (st.createQueue?.length) {
        // Off the queue before it runs: taking the queue back meanwhile never takes back this one, and a restart never makes it twice.
        const seasonal = st.createQueue[0];
        st.createQueue = st.createQueue.slice(1);
        this.creatingNow.set(acc.guid, seasonal);
        this.o.store.requestSave();
        let r = await this.createCharacter(acc, seasonal, "queued from the console");
        // A busy account (a trade, a trip, a login under way, a cooldown, every proxy host carrying a bot): wait for it, however
        // long that takes. Taking the queue back meanwhile takes this one back too (unqueueCreates clears its waiting mark).
        let takenBack = false;
        while (!r.ok && r.retry) {
          this.createWaiting.set(acc.guid, r.error);
          await sleep(BUSY_RETRY_MS);
          if (!this.createWaiting.delete(acc.guid)) {
            takenBack = true;
            break;
          }
          r = await this.createCharacter(acc, seasonal, "queued from the console");
        }
        this.creatingNow.delete(acc.guid);
        const side = seasonal ? "seasonal" : "non-seasonal";
        if (takenBack) {
          this.log(`new characters: ${acc.alias}: the ${side} one waiting for the account was taken back before it was made`);
          this.o.store.requestSave();
          continue;
        }
        this.noteCharacterJob(st, r.ok
          ? { kind: "create", charId: r.charId, seasonal, at: this.now(), ok: true, summary: `new ${side} character #${r.charId} made; ${r.created} of ${r.slots ?? "?"} slots hold one` }
          : { kind: "create", charId: null, seasonal, at: this.now(), ok: false, summary: `new ${side} character not made: ${r.error}` });
        if (!r.ok && st.createQueue?.length) {
          // The rest would fail the same way: they go, saying why.
          const n = st.createQueue.length;
          this.noteCharacterJob(st, { kind: "create", charId: null, seasonal, at: this.now(), ok: false, summary: `${n} more new character${n === 1 ? "" : "s"} not made: ${r.error}` });
          st.createQueue = [];
        }
        this.o.store.requestSave();
      }
    } finally {
      this.createWaiting.delete(acc.guid);
      this.creatingNow.delete(acc.guid);
      this.createDraining.delete(acc.guid);
    }
  }

  /** After a restart: deletes, drops and new characters the console queued before it are still in the saved state; pick them up again. */
  resumeQueuedJobs(accounts: BotAccount[]): number {
    let n = 0;
    for (const acc of accounts) {
      // A suspended account's queue stays saved for when it is cleared; it is not a login to try now.
      if (acc.suspended) continue;
      const st = this.o.store.get(acc.botGuid);
      if (st?.createQueue?.length && !this.createDraining.has(acc.guid)) {
        n++;
        this.log(`new characters: ${acc.alias}: ${st.createQueue.length} still queued from before the restart; picking them up`);
        void this.drainCreates(acc);
      }
      if (st?.deleteQueue?.length && !this.deleting.has(acc.guid)) {
        n++;
        this.log(`delete queue: ${acc.alias}: ${st.deleteQueue.length} character(s) still queued from before the restart; picking them up`);
        void this.drainDeletes(acc);
      }
      if (st?.dropQueue?.length && !this.dropping.has(acc.guid)) {
        n++;
        this.log(`drop queue: ${acc.alias}: ${st.dropQueue.length} item(s) still queued from before the restart; picking them up`);
        void this.drainDrops(acc);
      }
    }
    return n;
  }
  /**
   * The console's view of the character and drop jobs: what is queued, which
   * delete runs now, the new characters waiting (by side), the one being made
   * now and when Realm lets the account make the next, and how the last ones went.
   */
  characterJobsFor(acc: BotAccount): { deleteQueue: number[]; deleting: number | null; deleteWaiting: string | null; createQueue: boolean[]; creating: boolean | null; createWaiting: string | null; nextCreateAt: number | null; createCooldownS: number; last: AccountStorageState["lastCharacterJob"]; recent: CharacterJob[]; dropQueue: string[]; dropWaiting: string | null; lastDrop: AccountStorageState["lastDropJob"] } {
    const st = this.o.store.get(acc.botGuid);
    const left = this.createCooldownLeft(acc);
    return {
      deleteQueue: [...(st?.deleteQueue ?? [])], deleting: this.deletingNow.get(acc.guid) ?? null, deleteWaiting: this.deleteWaiting.get(acc.guid) ?? null,
      createQueue: [...(st?.createQueue ?? [])], creating: this.creatingNow.get(acc.guid) ?? null, createWaiting: this.createWaiting.get(acc.guid) ?? null, nextCreateAt: left > 0 ? this.now() + left : null, createCooldownS: Math.round(this.createCooldownMs / 1000),
      last: st?.lastCharacterJob ?? null, recent: [...(st?.recentCharacterJobs ?? [])], dropQueue: [...(st?.dropQueue ?? [])], dropWaiting: this.dropWaiting.get(acc.guid) ?? null, lastDrop: st?.lastDropJob ?? null,
    };
  }

  // Drops ------------------------------------------------------------------------------------
  // Throwing items away, from the console: named by instance, gathered by the
  // character that has to log in for them (its own inventory, worn or
  // quickslot items after the swap that brings them in, a container's after
  // the fetch), dropped last in that character's trip.

  private readonly dropping = new Set<string>();
  /** Queue instances to drop; the console is free at once. Unknown ids are refused. */
  queueDrop(acc: BotAccount, instanceIds: string[]): { ok: true; queued: number } | { ok: false; error: string } {
    const st = this.o.store.for(acc);
    const known = new Set<string>([...Object.values(this.o.sd.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId), ...storedInstances(st, st.loginCharId ?? null, acc.seasonalOrDefault).map((i) => i.instanceId)]);
    const ids = [...new Set(instanceIds)];
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) return { ok: false, error: `${unknown.length} of those items ${unknown.length === 1 ? "is" : "are"} not on this account any more` };
    if (!ids.length) return { ok: false, error: "nothing to drop" };
    st.dropQueue ??= [];
    for (const id of ids) if (!st.dropQueue.includes(id)) st.dropQueue.push(id);
    this.o.store.requestSave();
    if (!this.dropping.has(acc.guid)) void this.drainDrops(acc);
    return { ok: true, queued: st.dropQueue.length };
  }
  /** Take back the drops still queued; a trip already dropping goes on. */
  unqueueDrops(acc: BotAccount): { ok: true; dropped: number } {
    const st = this.o.store.for(acc);
    const dropped = st.dropQueue?.length ?? 0;
    st.dropQueue = [];
    this.o.store.requestSave();
    if (dropped) this.log(`drop queue: ${acc.alias}: ${dropped} item(s) taken back before they were dropped`);
    return { ok: true, dropped };
  }
  private async drainDrops(acc: BotAccount): Promise<void> {
    const st = this.o.store.for(acc);
    this.dropping.add(acc.guid);
    try {
      // Not tied to a storage run's cancel: the queue has its own way back (unqueueDrops).
      while (st.dropQueue?.length) {
        const ids = [...st.dropQueue];
        const r = await this.dropItems(acc, ids);
        // What a busy account kept from its trip (a trade, a trip, a login under way, a cooldown, every proxy host carrying
        // a bot) stays queued and is tried again, however long that takes; the rest is done, and the queue read afresh.
        st.dropQueue = (st.dropQueue ?? []).filter((id) => !ids.includes(id) || r.waiting.includes(id));
        if (r.waiting.length < ids.length) st.lastDropJob = { at: this.now(), ok: r.ok, dropped: r.dropped, planned: r.planned, summary: r.summary };
        this.o.store.requestSave();
        if (r.waiting.length && st.dropQueue.length) {
          this.dropWaiting.set(acc.guid, r.summary);
          await sleep(BUSY_RETRY_MS);
          this.dropWaiting.delete(acc.guid);
        }
      }
    } finally {
      this.dropWaiting.delete(acc.guid);
      this.dropping.delete(acc.guid);
    }
  }
  /**
   * Drop the named instances: one trip per character that has to log in for
   * them, then a fresh read of the account. `waiting` names the ones whose
   * trip a busy account turned away, for another try.
   */
  async dropItems(acc: BotAccount, instanceIds: string[]): Promise<{ ok: boolean; busy: boolean; dropped: number; planned: number; summary: string; waiting: string[] }> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    const login = st.loginCharId ?? null;
    const tracked = sd.tracker.instancesFor(acc.botGuid);
    const all = storedInstances(st, login, acc.seasonalOrDefault);
    const OUT: Record<ContainerKind, MoveKind> = { vault: "unbank", rack: "rackOut", gift: "giftOut", spoils: "spoilsOut" };
    const mk = (kind: MoveKind, inst: { instanceId: string; itemId: string }, extra: Partial<Move> = {}): Move | null => {
      const type = toObjType(inst.itemId);
      if (type === undefined) return null;
      return { id: randomUUID().slice(0, 8), kind, itemId: inst.itemId, objectType: type, name: ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId, instanceId: inst.instanceId, queuedAt: this.now(), ...extra };
    };
    const groups = new Map<number, Move[]>();
    const add = (charId: number, ...moves: (Move | null)[]) => {
      const list = groups.get(charId) ?? [];
      for (const m of moves) if (m) list.push(m);
      groups.set(charId, list);
    };
    const freeOf = (c: CharDetail) => (c.id === login ? sd.tracker.capacityFor(acc.botGuid) - Object.keys(tracked).length : (st.charVisits?.[String(c.id)]?.capacity ?? 8 + c.backpackSlots) - Object.keys(st.charItems?.[String(c.id)] ?? {}).length);
    const porterFor = (seasonal: boolean): number | null => {
      const cands = (st.chars ?? []).filter((c) => !c.dead && c.seasonal === seasonal && freeOf(c) >= 1).sort((a, b) => (a.id === login ? -1 : b.id === login ? 1 : freeOf(b) - freeOf(a)));
      return cands[0]?.id ?? null;
    };
    const missing: string[] = [];
    for (const id of instanceIds) {
      const onPlayed = Object.values(tracked).find((i) => i.instanceId === id);
      if (onPlayed && login !== null) {
        add(login, mk("drop", onPlayed));
        continue;
      }
      const s = all.find((i) => i.instanceId === id);
      if (!s) {
        missing.push(id);
        continue;
      }
      const w = s.where;
      if (w.kind === "char") add(w.charId, mk("drop", s));
      else if (w.kind === "worn") add(w.charId, mk("unequip", s, { charSlot: w.slot }), mk("drop", s));
      else if (w.kind === "quickslot") add(w.charId, mk("unstack", s, { charSlot: w.slot }), mk("drop", s));
      else {
        const side = w.seasonal ?? st.viewSeasonal ?? acc.seasonalOrDefault;
        const porter = porterFor(side);
        if (porter === null) {
          missing.push(id);
          continue;
        }
        add(porter, mk(OUT[w.kind], s, { slot: w.slot }), mk("drop", s));
      }
    }
    const planned = instanceIds.length - missing.length;
    if (!groups.size) return { ok: false, busy: false, dropped: 0, planned: 0, summary: "nothing of that is on the account any more", waiting: [] };
    let dropped = 0;
    const notes: string[] = [];
    let tripped = false;
    const waiting: string[] = [];
    for (const [charId, moves] of groups) {
      const r = charId === login ? await this.trip(acc, moves, { label: "drop" }) : await this.visitTrip(acc, charId, moves, "drop");
      if (r.verdict === "skipped") {
        for (const m of moves) if (m.instanceId && isDrop(m.kind) && !waiting.includes(m.instanceId)) waiting.push(m.instanceId);
        notes.push(`character #${charId}: ${r.error ?? "skipped"}`);
        continue;
      }
      tripped = true;
      const ok = r.outcomes.filter((oc) => oc.ok && isDrop(oc.move.kind)).length;
      dropped += ok;
      notes.push(`character #${charId}: ${ok} dropped${r.error ? ` (${r.error})` : ""}`);
    }
    if (!tripped) return { ok: false, busy: true, dropped: 0, planned, summary: notes.join("; "), waiting };
    // The account as it stands now.
    await this.snapshotRefresh(acc, "after drops");
    const tried = planned - waiting.length;
    const summary = `${dropped} of ${tried} item(s) dropped${missing.length ? `, ${missing.length} not found` : ""}${waiting.length ? `, ${waiting.length} waiting for the account` : ""} — ${notes.join("; ")}`;
    this.log(`drop: ${acc.alias}: ${summary}`);
    return { ok: dropped === tried && !missing.length, busy: false, dropped, planned: tried, summary, waiting };
  }
  /**
   * A trip as one of the account's other characters (a visit: the played
   * character stays the account's), for moves on that character: its worn and
   * quickslot items, its own inventory, and its side's containers.
   */
  private async visitTrip(acc: BotAccount, charId: number, moves: Move[], label: string): Promise<TripOutcome> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `${label} (character #${charId})`;
    if (acc.assignedRequestId !== null || acc.inUse || this.tripping.has(acc.guid)) return { verdict: "skipped", error: "the account is busy", outcomes: [], captured: false };
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return { verdict: "skipped", error: lent.why, outcomes: [], captured: false };
    this.tripping.add(acc.guid);
    try {
      return await this.charSession(acc, st, charId, moves, tag);
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /**
   * One login as `charId` on an account already borrowed (a visit: bringUp's charId, so the account's character of
   * record and its login hooks are left alone), its moves run and filed, then logged out. The played character's
   * moves are filed through the tracker as a trip's are (applyTrip); any other character's against its listed items
   * (fileVisit).
   */
  private async charSession(acc: BotAccount, st: AccountStorageState, charId: number, moves: Move[], tag: string, o: { skipCharList?: boolean; vaultReserve?: number; timeouts?: Partial<typeof STORAGE_TIMEOUTS> } = {}): Promise<TripOutcome> {
    const { sd } = this.o;
    let client: GameClient | null = null;
    try {
      this.setActivity(acc.guid, `${tag}: logging in`);
      try {
        client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3", { charId });
      } catch (e) {
        const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
        // Every proxy host carrying a bot is a busy account's kind of refusal: skipped, for another try.
        return { verdict: verdict === "failed" && !refusalPasses(e) ? "failed" : "skipped", error: `bring-up ${verdict}: ${(e as Error).message}`, outcomes: [], captured: false };
      }
      if (client.charId !== charId) return { verdict: "failed", error: `the game loaded character #${client.charId} instead of #${charId}`, outcomes: [], captured: false };
      const played = charId === (st.loginCharId ?? null);
      const mine: Record<number, Instance> = played ? sd.tracker.instancesFor(acc.botGuid) : { ...(st.charItems?.[String(charId)] ?? {}) };
      const quickslots = client.lastCharList?.chars.find((c) => c.id === charId)?.quickslots;
      const r = await runStorageTrip(client, { moves, tracked: mine, log: (l) => this.log(`${tag}: ${acc.alias}: ${l}`), now: this.now, onStep: (l) => this.setActivity(acc.guid, `${tag}: ${l}`), ...(quickslots ? { quickslots } : {}), ...(o.skipCharList ? { skipCharList: true } : {}), ...(o.vaultReserve !== undefined ? { vaultReserve: o.vaultReserve } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}) });
      if (played) {
        const filed = await this.applyTrip(acc, st, client, r, mine, { tag, snapshot: false, run: false });
        return { verdict: r.ok ? "ok" : "failed", error: r.error, outcomes: r.outcomes, captured: filed.captured };
      }
      this.fileVisit(acc, st, charId, client, r, mine);
      this.log(`${tag}: ${acc.alias}: ${r.summary}`);
      return { verdict: r.ok ? "ok" : "failed", error: r.error, outcomes: r.outcomes, captured: false };
    } finally {
      if (client) takeDown(sd.deps, acc, `${tag} done`);
      this.o.store.requestSave();
    }
  }

  /**
   * File what a visit to another character did. The containers follow the view it saw. What it banked keeps the
   * identity it had on the character and leaves the character's list; what it took out is listed on the character
   * under the identity the container had for it; a drop leaves the list. The character's slots in the char list
   * follow every swap, so its room is right before the next list comes. Worn and quickslot moves as noteTuckedOut.
   */
  private fileVisit(acc: BotAccount, st: AccountStorageState, charId: number, client: GameClient, r: StorageTripResult, mine: Record<number, Instance>): void {
    const key = String(charId);
    const ch = st.chars?.find((c) => c.id === charId);
    // What was where before the trip, on the side this character sees: what comes out arrives under that identity.
    const otherSideTrip = client.charSeasonal !== null && st.viewSeasonal != null && client.charSeasonal !== st.viewSeasonal;
    const before = otherSideTrip ? st.otherSide?.containers ?? null : st.containers;
    const takenFromList = this.takeFromLists(before, r.outcomes);
    if (r.view) this.applyView(st, r.view, client.charSeasonal);
    const setSlot = (slot: number | undefined, type: number) => {
      if (!ch || slot === undefined || slot < TRADE_SLOT_FIRST) return;
      ch.equipment ??= [];
      while (ch.equipment.length <= slot) ch.equipment.push(-1);
      ch.equipment[slot] = type;
    };
    const unlist = (instanceId: string | undefined) => {
      const items = st.charItems?.[key];
      if (items && instanceId) for (const [slot, inst] of Object.entries(items)) if (inst.instanceId === instanceId) delete items[Number(slot)];
    };
    for (const oc of r.outcomes) {
      if (!oc.ok) continue;
      if (isCharMove(oc.move.kind)) {
        this.noteTuckedOut(st, charId, oc.move, acc.botGuid);
        continue;
      }
      if (isDrop(oc.move.kind)) {
        unlist(oc.move.instanceId);
        setSlot(oc.slot ?? undefined, -1);
        continue;
      }
      const kind = MOVE_CONTAINER[oc.move.kind];
      const c = kind ? st.containers?.[kind] : undefined;
      if (!kind || oc.slot === null) continue;
      if (TO_CONTAINER[oc.move.kind]) {
        // Banked from this character: the item keeps the identity it was listed under there.
        const inst = oc.move.instanceId ? Object.values(mine).find((i) => i.instanceId === oc.move.instanceId) : undefined;
        if (inst && c) c.instances[oc.slot] = inst;
        unlist(oc.move.instanceId);
        setSlot(oc.charSlot, -1);
      } else {
        const listed = LIST_KINDS.has(kind) ? takenFromList.get(oc.move.id) : before?.[kind]?.instances[oc.slot];
        if (c && !LIST_KINDS.has(kind)) delete c.instances[oc.slot];
        setSlot(oc.charSlot, oc.move.objectType);
        if (oc.charSlot === undefined || !oc.move.itemId) continue;
        const inst = listed ?? { instanceId: oc.move.instanceId ?? randomUUID().replace(/-/g, ""), itemId: oc.move.itemId, enchantments: [], capturedAt: this.now() / 1000 };
        st.charItems ??= {};
        (st.charItems[key] ??= {})[oc.charSlot] = { ...inst, enchantments: [...inst.enchantments] };
      }
    }
    if (st.charItems?.[key] && !Object.keys(st.charItems[key]).length) delete st.charItems[key];
  }

  /**
   * Out of a list container (gift, spoils): each item's identity leaves the list before the view closes it up, so the
   * rest keep theirs in order (the view is as of the end of the trip). Returns what each move took, by move id.
   */
  private takeFromLists(before: Containers | null, outcomes: MoveOutcome[]): Map<string, Instance> {
    const taken = new Map<string, Instance>();
    for (const oc of outcomes) {
      const kind = MOVE_CONTAINER[oc.move.kind];
      if (!oc.ok || !kind || !LIST_KINDS.has(kind) || TO_CONTAINER[oc.move.kind]) continue;
      const b = before?.[kind];
      if (!b) continue;
      const named = oc.move.instanceId ? Object.entries(b.instances).find(([, i]) => i.instanceId === oc.move.instanceId) : undefined;
      const at = named ? Number(named[0]) : oc.move.slot;
      if (at === undefined || !b.instances[at]) continue;
      taken.set(oc.move.id, b.instances[at]);
      delete b.instances[at];
    }
    return taken;
  }

  /**
   * Delete one of the account's characters (char/delete, HTTP only, no game
   * login): everything on it goes with it, which the console's confirm shows
   * first. The character list is re-read; a deleted played character leaves
   * the account with no preferred one until its next login.
   */
  async deleteCharacter(acc: BotAccount, charId: number, why = "asked from the console"): Promise<{ ok: true; remaining: number; slots: number | null } | { ok: false; error: string }> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `delete character #${charId} (${why})`;
    if (!(st.chars ?? []).some((c) => c.id === charId)) return { ok: false, error: `no character #${charId} on this account` };
    if (acc.assignedRequestId !== null || acc.inUse || this.tripping.has(acc.guid)) return { ok: false, error: "the account is busy" };
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return { ok: false, error: lent.why };
    this.tripping.add(acc.guid);
    try {
      const got = await this.httpToken(acc, tag);
      if (!got.ok) return { ok: false, error: got.error };
      this.setActivity(acc.guid, `${tag}: deleting`);
      return await this.deleteWithToken(acc, charId, got, tag);
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }
  /** One char/delete with a token already in hand, then the character list read again (the account's slots, the played character). */
  private async deleteWithToken(acc: BotAccount, charId: number, got: { token: string; proxy: Proxy | null }, tag: string): Promise<{ ok: true; remaining: number; slots: number | null } | { ok: false; error: string }> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    if (!(st.chars ?? []).some((c) => c.id === charId)) return { ok: false, error: `no character #${charId} on this account` };
    const r = await deleteChar(got.token, charId, got.proxy);
    if (!r.ok) return { ok: false, error: `char/delete: ${r.error.kind}${"detail" in r.error ? ` (${r.error.detail})` : ""}` };
    const wasPlayed = charId === (st.loginCharId ?? null);
    const cl = await getCharListDetail(got.token, got.proxy);
    if (cl.ok) {
      st.chars = cl.value.chars;
      st.charsAt = this.now();
      st.maxNumChars = cl.value.maxNumChars;
    } else st.chars = (st.chars ?? []).filter((c) => c.id !== charId);
    if (st.charVisits) delete st.charVisits[String(charId)];
    if (wasPlayed) {
      st.loginCharId = null;
      sd.tracker.updateFromSlots(acc.botGuid, {}, 8);
    }
    if ((acc.info.charId ?? null) === charId) sd.pool.setPreferredChar(acc, null);
    reconcileCharItems(st, st.loginCharId ?? null, this.now());
    const remaining = (st.chars ?? []).filter((c) => !c.dead).length;
    this.log(`${tag}: ${acc.alias}: deleted${wasPlayed ? " (it was the played character; the next login picks another)" : ""}; ${remaining} of ${st.maxNumChars ?? "?"} slots hold one now`);
    return { ok: true, remaining, slots: st.maxNumChars ?? null };
  }

  private async httpRead(acc: BotAccount, st: AccountStorageState, tag: string): Promise<{ ok: true; snapshot: SnapshotNote } | { ok: false; error: string; locked: boolean }> {
    const { sd, store } = this.o;
    const { proxies, gate } = sd.deps;
    const fail = (error: string, locked = false): { ok: false; error: string; locked: boolean } => {
      st.lastError = error;
      st.lastRun = { at: this.now(), ok: false, error, summary: `snapshot: ${error}` };
      this.log(`${tag}: ${acc.alias}: ${error}`);
      return { ok: false, error, locked };
    };
    const got = await this.httpToken(acc, tag);
    if (!got.ok) return fail(got.error, got.locked);
    const { token, proxy } = got;
    const tok = { value: token };
    this.setActivity(acc.guid, `${tag}: reading the account snapshot`);
    const dumpR = await getAccountDump(tok.value, proxy);
    if (!dumpR.ok) {
      if (proxy && dumpR.error.kind === "network") proxies.noteResult(proxies.keyOf(proxy), false);
      return fail(`account snapshot not read: ${dumpR.error.kind}`);
    }
    if (proxy) proxies.noteResult(proxies.keyOf(proxy), true);
    acc.lastLoginError = null;
    store.keepSnapshot(acc.botGuid, dumpR.value);
    if (this.o.onToken) {
      this.setActivity(acc.guid, `${tag}: reading the login calendar`);
      await this.o.onToken(acc, tok.value, proxy).catch((e) => this.log(`${tag}: ${acc.alias}: calendar read failed: ${String(e)}`));
    }
    let dump: AccountDump;
    try {
      dump = parseAccountDump(dumpR.value);
    } catch (e) {
      return fail(`account snapshot unreadable: ${(e as Error).message}`);
    }
    const living = dump.chars.filter((c) => !c.dead);
    const loginCharId = living.length ? pickCharId(acc.info.charId ?? st.loginCharId ?? null, living.map((c) => c.id)) : null;
    const played = living.find((c) => c.id === loginCharId) ?? null;
    if (played) {
      // The played character as the game would show it: its trade slots to the tracker, what the catalog does not know aside.
      const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
      const untracked: UntrackedSlot[] = [];
      const capacity = 8 + played.backpackSlots;
      played.slots.forEach((sl, slot) => {
        if (slot < TRADE_SLOT_FIRST || slot >= TRADE_SLOT_FIRST + capacity || sl.type <= 0) return;
        const itemId = toCatalogId(sl.type);
        if (itemId) slots[slot] = { itemId, enchantments: sl.enchantments ?? [] };
        else untracked.push({ slot, objectType: sl.type, name: nameOfType(sl.type).name });
      });
      sd.tracker.updateFromSlots(acc.botGuid, slots, capacity);
      st.untracked = untracked;
      st.loginCharId = played.id;
      sd.pool.setSeasonal(acc, played.seasonal);
    }
    if (dump.name) sd.tracker.recordIgn(acc.botGuid, dump.name);
    const snapshot = applySnapshot(st, dump, loginCharId, this.now(), true);
    st.lastSnapshot = { ...snapshot, at: this.now() };
    const summary = `snapshot over HTTP: ${played ? `character #${played.id} (${played.seasonal ? "seasonal" : "non-seasonal"}, ${Object.keys(sd.tracker.instancesFor(acc.botGuid)).length}/${8 + played.backpackSlots} trade slots)` : "no living character"} | ${living.length} character(s) of ${dump.maxNumChars} | ${snapshotWords(snapshot)}`;
    st.lastRun = { at: this.now(), ok: true, error: null, summary };
    st.lastError = null;
    this.log(`${tag}: ${acc.alias}: ${summary}`);
    store.requestSave();
    return { ok: true, snapshot };
  }

  /**
   * Bring what a withdraw needs onto a character of the account: log in as
   * the character that has the items (the played one unless they are on
   * another), walk into the Vault for whatever is in a container, and leave
   * the tracker describing the result. The dispatcher then routes the
   * withdraw to the bot as usual. One fetch per account at a time, a few
   * at once fleet-wide; an account busy with a trade or a storage run is
   * refused and tried again later.
   */
  async fetch(acc: BotAccount, need: FetchNeed, o: FetchOptions): Promise<FetchResult> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    if (this.fetching.has(acc.guid)) return { ok: false, error: "a fetch is already on its way", busy: true };
    if (this.fetching.size >= (FETCH_MAX_CONCURRENT ?? Math.max(1, onlineCapFor(sd.deps.proxies.exclusiveCapacity?.() ?? null)))) return { ok: false, error: "too many fetches at once", busy: true };
    if (this.run.running && this.run.current.includes(acc.alias)) return { ok: false, error: "a storage run has the account", busy: true };
    const plan = planFetch(st, need, { loginCharId: st.loginCharId ?? null, accSeasonal: acc.seasonalOrDefault, seasonal: o.seasonal, tracked: sd.tracker.instancesFor(acc.botGuid) });
    if (!plan.ok) return { ok: false, error: plan.error ?? "cannot plan the fetch", permanent: true };
    if (plan.charId !== null && plan.charId !== (st.loginCharId ?? null)) {
      this.log(`storage: ${acc.alias}: switching to character ${plan.charId} for ${o.why ?? "a withdraw"}`);
      sd.pool.setPreferredChar(acc, plan.charId);
    }
    // What may be banked to make room: the character's own items, minus what is spoken for (by this withdraw's neighbours, or by the site at large).
    const keep = new Set<string>([...(o.keep ?? []), ...(this.o.keep?.() ?? [])]);
    const keepItems = o.keepItems ?? new Set<string>();
    const named = new Set(need.instanceIds);
    const bankable = storeFirst(Object.values(sd.tracker.instancesFor(acc.botGuid)).filter((i) => !keep.has(i.instanceId) && !named.has(i.instanceId) && !keepItems.has(i.itemId)), acc.communism);
    this.fetching.add(acc.guid);
    try {
      this.log(`storage: ${acc.alias}: fetching ${plan.moves.length} item(s) from storage${plan.charId !== null ? ` on character ${plan.charId}` : ""} for ${o.why ?? "a withdraw"}`);
      const r = await this.trip(acc, plan.moves, { label: "fetch", bankable });
      if (r.verdict === "ok") {
        const failed = r.outcomes.filter((oc) => !oc.ok && !TO_CONTAINER[oc.move.kind]);
        if (failed.length) return { ok: false, error: `${failed.length} move(s) failed: ${failed.map((f) => `${f.move.name}: ${f.detail}`).join("; ")}` };
        return { ok: true };
      }
      if (r.verdict === "skipped") return { ok: false, error: r.error ?? "the account was not free", busy: true };
      return { ok: false, error: r.error ?? r.verdict };
    } finally {
      this.fetching.delete(acc.guid);
    }
  }

  // Advanced management -------------------------------------------------------------------------
  // (docs/relay/ADVANCED.md) Trips on the dispatcher's own live session between trades: a haul banked, a fetch made,
  // without the logout and login a borrowed trip costs. And the chores that keep an empty character (compact) and
  // gather potions into the vault, which log the account in like any trip. The dispatcher calls them for accounts
  // whose pool follows the advanced rules, and decides when; nothing else does.

  /** Whether a trip is driving the account right now (a live session's included): the dispatcher leaves its inventory alone meanwhile. */
  isTripping(guid: string): boolean {
    return this.tripping.has(guid);
  }

  /** The vault of `seasonal`'s side as last seen (a trip, a snapshot): its free slots and slots in all; null when nothing has described it. */
  vaultRoom(acc: BotAccount, seasonal = acc.seasonalOrDefault): { free: number; slots: number } | null {
    const st = this.o.store.get(acc.botGuid);
    const c = st ? containersOfSide(st, seasonal, acc.seasonalOrDefault) : null;
    if (!c) return null;
    return { free: c.vault.slots.filter((t) => t === -1).length, slots: c.vault.slots.length };
  }

  /**
   * Bank the played character's items on the bot's live session (docs/relay/ADVANCED.md, "Keep an empty
   * character"): into its side's vault, as many as leave `reserveSlots` free (the transit reserve), never `keep` ids
   * or what the site has spoken for; the items the node does not trade go too, so the character can come out empty.
   * The bot walks into the Vault, or banks where it stands when a trip of this session left it there, and stays: the
   * dispatcher sends it back to the Nexus, lets it linger or logs it out. `park` with nothing to bank still walks in,
   * so the bot idles in the Vault. The caller holds the account (maintenanceHolds) and must not mark it in use: the
   * trip does, so no other job borrows it meanwhile.
   */
  async bankOnline(acc: BotAccount, client: GameClient, o: { keep: Set<string>; reserveSlots: number; park?: boolean; why: string }): Promise<OnlineTrip> {
    const tag = `bank (${o.why})`;
    const slots = tradeSlotsOf(client);
    const busy = this.liveBusy(acc, client);
    if (busy) return { ok: false, moved: 0, left: countHeld(client.playerData.inv, slots), busy: true, error: busy };
    const side = client.charSeasonal ?? acc.seasonalOrDefault;
    const keep = new Set<string>([...o.keep, ...(this.o.keep?.() ?? [])]);
    const tracked = this.o.sd.tracker.instancesFor(acc.botGuid);
    const now = this.now();
    // What the tracker knows by its identity (the account's untradeable-on-its-side items first), then whatever else fills a slot, by the slot.
    const moves: Move[] = [];
    const named = new Set<number>();
    for (const [s, inst] of Object.entries(tracked)) {
      if (client.playerData.inv[Number(s)] === toObjType(inst.itemId)) named.add(Number(s));
    }
    for (const inst of storeFirst(Object.entries(tracked).filter(([s]) => named.has(Number(s))).map(([, i]) => i), acc.communism)) {
      if (keep.has(inst.instanceId)) continue;
      moves.push({ id: randomUUID().slice(0, 8), kind: "bank", itemId: inst.itemId, objectType: toObjType(inst.itemId)!, name: ITEM_BY_ID.get(inst.itemId)?.name ?? inst.itemId, instanceId: inst.instanceId, queuedAt: now });
    }
    const inv = client.playerData.inv;
    for (let i = TRADE_SLOT_FIRST; i < TRADE_SLOT_FIRST + slots && i < inv.length; i++) {
      if (inv[i] <= 0 || named.has(i)) continue;
      moves.push({ id: randomUUID().slice(0, 8), kind: "bank", itemId: toCatalogId(inv[i]) ?? null, objectType: inv[i], name: nameOfType(inv[i]).name, slot: i, queuedAt: now });
    }
    const kept = this.liveVaultFor(acc, client);
    const known = kept ? kept.vault.slots.filter((t) => t === -1).length : this.vaultRoom(acc, side)?.free ?? null;
    const room = known === null ? moves.length : Math.max(0, known - o.reserveSlots);
    const go = moves.slice(0, room);
    const capped = go.length < moves.length;
    if (!go.length && (!o.park || kept || standsIn(client, VAULT_MAP))) return { ok: true, moved: 0, left: countHeld(inv, slots), ...(moves.length ? { vaultFull: true } : {}) };
    this.log(`${tag}: ${acc.alias}: ${go.length ? `banking ${go.length} of ${moves.length} item(s)` : "walking into the Vault to wait there"} on the live session${capped ? ` (the vault keeps ${o.reserveSlots} slot(s) free)` : ""}`);
    const r = await this.liveTrip(acc, client, go, { tag, side, vaultReserve: o.reserveSlots });
    const moved = r.outcomes.filter((oc) => oc.ok && oc.move.kind === "bank").length;
    const full = capped || r.outcomes.some((oc) => !oc.ok && oc.move.kind === "bank" && /reserve|full/.test(oc.detail));
    const left = r.inv.length ? countHeld(r.inv, slots) : countHeld(client.playerData.inv, slots);
    return { ok: r.ok, moved, left, ...(full ? { vaultFull: true } : {}), ...(r.ok ? {} : { error: r.error ?? "the trip failed" }) };
  }

  /**
   * Bring what a withdraw needs onto the bot's live session (docs/relay/ADVANCED.md, "Withdraws"): `fetch` without
   * the logout and login. Out of its side's containers (worn and quickslot items too) onto the played character,
   * banking what may go when the character lacks the room. What only another character, or one of the other side,
   * can reach is refused with `needsLogin`: the ordinary fetch logs in as that one. Leaves the bot in the Vault, like
   * bankOnline, and marks the account in use while it runs.
   */
  async fetchOnline(acc: BotAccount, client: GameClient, need: FetchNeed, o: FetchOptions): Promise<FetchResult> {
    const tag = `fetch (${o.why ?? "a withdraw"})`;
    const busy = this.liveBusy(acc, client);
    if (busy) return { ok: false, error: busy, busy: true };
    const st = this.o.store.for(acc);
    const tracked = this.o.sd.tracker.instancesFor(acc.botGuid);
    const plan = planFetch(st, need, { loginCharId: client.charId, accSeasonal: acc.seasonalOrDefault, seasonal: o.seasonal, tracked, playedOnly: true });
    if (!plan.ok) return { ok: false, error: plan.error ?? "cannot plan the fetch", permanent: true, ...(plan.needsLogin ? { needsLogin: true } : {}) };
    if (!plan.moves.length) return { ok: true };
    // What may be banked to make room: the character's own items, minus what is spoken for (as `fetch` does).
    const keep = new Set<string>([...(o.keep ?? []), ...(this.o.keep?.() ?? [])]);
    const keepItems = o.keepItems ?? new Set<string>();
    const named = new Set(need.instanceIds);
    const bankable = storeFirst(Object.values(tracked).filter((i) => !keep.has(i.instanceId) && !named.has(i.instanceId) && !keepItems.has(i.itemId)), acc.communism);
    this.log(`${tag}: ${acc.alias}: fetching ${plan.moves.length} item(s) on the live session`);
    const r = await this.liveTrip(acc, client, plan.moves, { tag, side: client.charSeasonal ?? acc.seasonalOrDefault, bankable });
    if (!r.ok) return { ok: false, error: r.error ?? "the trip failed" };
    const failed = r.outcomes.filter((oc) => !oc.ok && !TO_CONTAINER[oc.move.kind]);
    if (failed.length) return { ok: false, error: `${failed.length} move(s) failed: ${failed.map((f) => `${f.move.name}: ${f.detail}`).join("; ")}` };
    return { ok: true };
  }

  /** Why a trip on the account's live session would be refused now (the same answer bankOnline and fetchOnline give as `busy`), or null: the dispatcher asks before it takes its holds. */
  liveTripBlocked(acc: BotAccount, client: GameClient): string | null {
    return this.liveBusy(acc, client);
  }
  /** Why a trip on the account's live session cannot run now, or null. */
  private liveBusy(acc: BotAccount, client: GameClient): string | null {
    if (acc.assignedRequestId !== null) return "busy with a trade";
    if (acc.inUse) return "another job has the account";
    if (this.tripping.has(acc.guid)) return "another trip is driving the account";
    if (this.fetching.has(acc.guid)) return "a fetch is on its way";
    if (this.creating.has(acc.guid)) return "a new character is being made";
    if (this.runPending.has(acc.guid)) return "the storage run has the account";
    if (acc.client !== client || !client.active) return "that session is not the account's";
    if (!standsIn(client, NEXUS_MAP) && !standsIn(client, VAULT_MAP)) return "the bot is between maps";
    return null;
  }

  /**
   * Run `moves` on the account's live session from where it stands: in the Nexus it walks into the Vault; in the
   * Vault with a view this session kept, it swaps where it stands; in the Vault without one it goes back to the
   * Nexus first (VAULTINFO comes only on the way in). What comes into the inventory is promised to the tracker as it
   * goes, since the dispatcher reads the session every tick. Filed like any trip (applyTrip); the session's view is
   * kept for its next trip.
   */
  private async liveTrip(acc: BotAccount, client: GameClient, moves: Move[], o: { tag: string; side: boolean; bankable?: Instance[]; vaultReserve?: number }): Promise<StorageTripResult> {
    const { sd, store } = this.o;
    const st = store.for(acc);
    const tracked = sd.tracker.instancesFor(acc.botGuid);
    const kept = this.liveVaultFor(acc, client);
    if (!kept && standsIn(client, VAULT_MAP)) {
      this.log(`${o.tag}: ${acc.alias}: in the Vault without the view it read there; back to the Nexus to walk in again`);
      client.escapeToNexus();
    }
    const before = containersOfSide(st, o.side, acc.seasonalOrDefault);
    const promised = new Map<string, string>();
    const onInbound = (move: Move, landed: boolean | null) => {
      if (landed === null) {
        const inst = inboundIdentity(st, before, move, this.now());
        if (inst) {
          sd.tracker.expectArrival(acc.botGuid, inst);
          promised.set(move.id, inst.instanceId);
        }
        return;
      }
      const id = promised.get(move.id);
      if (!landed && id) {
        sd.tracker.cancelTransfer(acc.botGuid, [id]);
        promised.delete(move.id);
      }
    };
    this.tripping.add(acc.guid);
    acc.inUse = true;
    try {
      const r = await runStorageTrip(client, {
        moves, tracked, bankable: o.bankable, settled: true, skipCharList: true, vault: kept, vaultReserve: o.vaultReserve, onInbound,
        log: (l) => this.log(`${o.tag}: ${acc.alias}: ${l}`), now: this.now, onStep: (l) => this.setActivity(acc.guid, `${o.tag}: ${l}`), ...(this.o.tripTimeouts ? { timeouts: this.o.tripTimeouts } : {}),
      });
      await this.applyTrip(acc, st, client, r, tracked, { tag: o.tag, snapshot: false, run: false, promised: new Set(promised.keys()) });
      if (r.view && standsIn(client, VAULT_MAP)) this.keepLiveVault(acc, client, r.view);
      return r;
    } finally {
      this.tripping.delete(acc.guid);
      acc.inUse = false;
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }
  private keepLiveVault(acc: BotAccount, client: GameClient, view: VaultView): void {
    this.dropLiveVault(acc.guid);
    const drop = () => this.dropLiveVault(acc.guid);
    client.on("mapInfo", drop);
    client.on("disconnected", drop);
    client.on("stopped", drop);
    this.liveVaults.set(acc.guid, {
      client, view,
      off: () => {
        client.off("mapInfo", drop);
        client.off("disconnected", drop);
        client.off("stopped", drop);
      },
    });
  }
  private dropLiveVault(guid: string): void {
    const kept = this.liveVaults.get(guid);
    if (!kept) return;
    this.liveVaults.delete(guid);
    kept.off();
  }
  /** The view this live session kept from its way into the Vault, while it still stands there. */
  private liveVaultFor(acc: BotAccount, client: GameClient): VaultView | null {
    const kept = this.liveVaults.get(acc.guid);
    if (!kept) return null;
    if (kept.client !== client || !standsIn(client, VAULT_MAP)) {
      this.dropLiveVault(acc.guid);
      return null;
    }
    return kept.view;
  }

  /** Why a chore that logs the account in cannot run now, or null (an idle bot in game is let go by borrowAccount). */
  private choreBusy(acc: BotAccount): string | null {
    if (acc.assignedRequestId !== null) return "busy with a trade";
    if (acc.inUse) return "another job has the account";
    if (this.tripping.has(acc.guid)) return "another trip is driving the account";
    if (this.fetching.has(acc.guid)) return "a fetch is on its way";
    if (this.creating.has(acc.guid)) return "a new character is being made";
    if (this.runPending.has(acc.guid)) return "the storage run has the account";
    return null;
  }
  /** The side the account plays and that side's vault, for a chore; or why there is nothing to go on. */
  private choreSide(acc: BotAccount, st: AccountStorageState): { side: boolean; vault: { free: number; slots: number } } | string {
    const login = st.loginCharId ?? null;
    const played = (st.chars ?? []).find((c) => c.id === login && !c.dead);
    if (!played) return "no login has said which character the account plays";
    // A preference for a character that is gone (dead, deleted) is no login: the account plays its first one.
    const next = acc.info.charId;
    if (next != null && next !== login && (st.chars ?? []).some((c) => c.id === next && !c.dead)) return `the account logs in as character #${next} next`;
    const vault = this.vaultRoom(acc, played.seasonal);
    if (!vault) return `its ${played.seasonal ? "seasonal" : "non-seasonal"} vault has not been seen`;
    return { side: played.seasonal, vault };
  }

  /**
   * Compaction (docs/relay/ADVANCED.md, "Keep an empty character"): empty the emptiest character of the side the
   * account plays onto its other characters, through the vault — one login to bank its items, then one per
   * character taking some out (planCompaction says which). The vault ends as it was; the transit uses its free
   * slots, which the caller keeps at least `reserveSlots` of by banking no further. Refused (`skipped`) when a
   * character is empty already, or the vault or the other characters lack the room.
   */
  async compact(acc: BotAccount, o: { reserveSlots: number; why: string }): Promise<RunResult> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `compact (${o.why})`;
    const busy = this.choreBusy(acc);
    if (busy) return { ok: false, moved: 0, busy: true, error: busy };
    const at = this.choreSide(acc, st);
    if (typeof at === "string") return { ok: false, moved: 0, skipped: at };
    const plan = planCompaction(this.compactChars(acc, st, at.side), { vaultFree: at.vault.free, reserved: this.o.keep?.() ?? new Set<string>() });
    if (!plan.ok || plan.from === null) return { ok: false, moved: 0, skipped: plan.error ?? "nothing to compact" };
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return { ok: false, moved: 0, busy: true, error: lent.why };
    this.tripping.add(acc.guid);
    try {
      this.log(`${tag}: ${acc.alias}: emptying character #${plan.from} (${plan.things.length} item(s)) onto ${plan.to.map((t) => `#${t.charId} (${t.things.length})`).join(", ")} through the vault`);
      const bankMoves = plan.things.map((t) => thingMove("bank", t, t.instanceId ? {} : { slot: t.slot }, this.now()));
      const banked = await this.charSession(acc, st, plan.from, bankMoves, `${tag} (character #${plan.from})`, { skipCharList: true, timeouts: this.o.tripTimeouts });
      if (banked.verdict === "skipped") return { ok: false, moved: 0, busy: true, error: banked.error ?? "the account was not free" };
      // Where each of its things went in the vault.
      const inVault = new Map<number, number>();
      for (const oc of banked.outcomes) {
        const i = bankMoves.indexOf(oc.move);
        if (oc.ok && i >= 0 && oc.slot !== null) inVault.set(i, oc.slot);
      }
      const errors: string[] = inVault.size < plan.things.length ? [`${plan.things.length - inVault.size} item(s) stayed on character #${plan.from}${banked.error ? ` (${banked.error})` : ""}`] : [];
      let moved = 0;
      for (const target of plan.to) {
        const mine = target.things.filter((i) => inVault.has(i));
        if (!mine.length) continue;
        if (!(await this.waitForGate(acc))) {
          errors.push(`character #${target.charId}: login-locked; ${mine.length} item(s) left in the vault`);
          break;
        }
        const listed = containersOfSide(st, at.side, acc.seasonalOrDefault)?.vault.instances ?? {};
        const outMoves = mine.map((i) => thingMove("unbank", plan.things[i], { slot: inVault.get(i)!, instanceId: listed[inVault.get(i)!]?.instanceId }, this.now()));
        const r = await this.charSession(acc, st, target.charId, outMoves, `${tag} (character #${target.charId})`, { skipCharList: true, timeouts: this.o.tripTimeouts });
        const done = r.outcomes.filter((oc) => oc.ok).length;
        moved += done;
        if (done < mine.length) errors.push(`character #${target.charId}: ${mine.length - done} item(s) left in the vault${r.error ? ` (${r.error})` : ""}`);
      }
      const ok = moved === plan.things.length;
      this.log(`${tag}: ${acc.alias}: ${ok ? `character #${plan.from} is empty` : `${moved} of ${plan.things.length} item(s) moved`}${errors.length ? ` — ${errors.join("; ")}` : ""}`);
      return { ok, moved, ...(errors.length ? { error: errors.join("; ") } : {}) };
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /**
   * Gather potions into the vault (docs/relay/ADVANCED.md, "Potions by kind"): bank the potions the account's other
   * characters of its side hold, the biggest holders first, one login each, while the vault has more than
   * `reserveSlots` free; so one session reaches the account's whole stack of a kind. Never what the site has spoken for.
   */
  /**
   * `maxChars`: characters visited in one run at most (a run holds the account; the rest waits for the next run).
   * `stop`: asked before each further character; true ends the run there (a player's request came in).
   */
  async gatherPotions(acc: BotAccount, o: { reserveSlots: number; why: string; maxChars?: number; stop?: () => boolean }): Promise<RunResult> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `gather potions (${o.why})`;
    const busy = this.choreBusy(acc);
    if (busy) return { ok: false, moved: 0, busy: true, error: busy };
    const at = this.choreSide(acc, st);
    if (typeof at === "string") return { ok: false, moved: 0, skipped: at };
    let room = at.vault.free - o.reserveSlots;
    if (room <= 0) return { ok: false, moved: 0, skipped: `the vault has ${at.vault.free} free slot(s) and keeps ${o.reserveSlots} free` };
    const reserved = this.o.keep?.() ?? new Set<string>();
    const login = st.loginCharId ?? null;
    const holders = (st.chars ?? [])
      .filter((c) => !c.dead && c.seasonal === at.side && c.id !== login)
      .map((c) => ({ id: c.id, potions: Object.values(st.charItems?.[String(c.id)] ?? {}).filter((i) => i.itemId in POTION_INFO && !reserved.has(i.instanceId)) }))
      .filter((h) => h.potions.length)
      .sort((a, b) => b.potions.length - a.potions.length || a.id - b.id);
    if (!holders.length) return { ok: false, moved: 0, skipped: "no other character holds potions" };
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return { ok: false, moved: 0, busy: true, error: lent.why };
    this.tripping.add(acc.guid);
    try {
      let moved = 0;
      const errors: string[] = [];
      for (const [n, h] of holders.entries()) {
        if (room <= 0 || (o.maxChars !== undefined && n >= o.maxChars) || (n > 0 && o.stop?.())) break;
        if (n > 0 && !(await this.waitForGate(acc))) {
          errors.push("login-locked");
          break;
        }
        const moves = h.potions.slice(0, room).map((inst) => thingMove("bank", { slot: -1, objectType: toObjType(inst.itemId)!, instanceId: inst.instanceId, itemId: inst.itemId }, {}, this.now()));
        const r = await this.charSession(acc, st, h.id, moves, `${tag} (character #${h.id})`, { skipCharList: true, vaultReserve: o.reserveSlots, timeouts: this.o.tripTimeouts });
        const done = r.outcomes.filter((oc) => oc.ok).length;
        moved += done;
        room -= done;
        if (done < moves.length) errors.push(`character #${h.id}: ${moves.length - done} potion(s) stayed${r.error ? ` (${r.error})` : ""}`);
      }
      this.log(`${tag}: ${acc.alias}: ${moved} potion(s) banked${errors.length ? ` — ${errors.join("; ")}` : ""}`);
      return { ok: !errors.length, moved, ...(errors.length ? { error: errors.join("; ") } : {}) };
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /** The living characters of one side as compaction sees them: the played one from the tracker, the others from the char list's slots and their listed items. */
  private compactChars(acc: BotAccount, st: AccountStorageState, side: boolean): CompactChar[] {
    const { tracker } = this.o.sd;
    const login = st.loginCharId ?? null;
    const out: CompactChar[] = [];
    for (const ch of st.chars ?? []) {
      if (ch.dead || ch.seasonal !== side) continue;
      if (ch.id === login) {
        const things: CharThing[] = [];
        for (const [s, i] of Object.entries(tracker.instancesFor(acc.botGuid))) {
          const type = toObjType(i.itemId);
          if (type !== undefined) things.push({ slot: Number(s), objectType: type, instanceId: i.instanceId, itemId: i.itemId });
        }
        for (const u of st.untracked ?? []) things.push({ slot: u.slot, objectType: u.objectType, instanceId: null, itemId: null });
        out.push({ id: ch.id, capacity: tracker.capacityFor(acc.botGuid), things });
        continue;
      }
      const listed = st.charItems?.[String(ch.id)] ?? {};
      const things: CharThing[] = [];
      (ch.equipment ?? []).forEach((type, slot) => {
        if (slot < TRADE_SLOT_FIRST || type <= 0) return;
        const inst = listed[slot];
        things.push({ slot, objectType: type, instanceId: inst && toObjType(inst.itemId) === type ? inst.instanceId : null, itemId: toCatalogId(type) ?? null });
      });
      out.push({ id: ch.id, capacity: st.charVisits?.[String(ch.id)]?.capacity ?? 8 + ch.backpackSlots, things });
    }
    return out;
  }

  /**
   * Read an account: log in, look at everything it holds (the character,
   * the containers, the character list), log out; then log in as each
   * other character that carries something tradeable, just to look, so
   * their items are listed with the enchantments the game shows. What
   * "Read now" and a new account's first look do, so every item is in the
   * pool from the start. An account that cannot reach the Nexus (a
   * character still in the tutorial) is still captured as far as it got.
   */
  async read(acc: BotAccount, why: string): Promise<BringUpVerdict | "busy" | "login-locked"> {
    const r = await this.snapshotRefresh(acc, `read (${why})`);
    if (r.captured) return "captured";
    if (r.bringUpVerdict) return r.bringUpVerdict;
    if (r.verdict === "skipped") return r.error === "login-locked" ? "login-locked" : "busy";
    return "failed";
  }

  /**
   * Look at the account's other characters only, no Vault and no moves:
   * log in as each one that carries something tradeable and file what the
   * session shows (visitLoop). What a read does after its trip; on its own
   * for a test, or when only the enchantments want refreshing.
   */
  async visit(acc: BotAccount, why: string): Promise<VisitSummary | "busy" | "login-locked"> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = `visit (${why})`;
    if (acc.assignedRequestId !== null || acc.inUse || this.tripping.has(acc.guid)) return "busy";
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) return lent.why === "login-locked" ? "login-locked" : "busy";
    this.tripping.add(acc.guid);
    try {
      return await this.visitLoop(acc, st, tag);
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /** Until the account may log in again (the post-session grace, a pause); false when it stays locked past LOCKOUT_WAIT_MS. */
  private async waitForGate(acc: BotAccount): Promise<boolean> {
    const { gate } = this.o.sd.deps;
    const until = this.now() + LOCKOUT_WAIT_MS;
    while ((gate.lockoutRemainingMs(acc.guid) > 0 || gate.pausedRemainingMs() > 0) && this.now() < until && !this.cancelled) await sleep(500);
    return gate.lockoutRemainingMs(acc.guid) <= 0 && gate.pausedRemainingMs() <= 0;
  }

  /**
   * One login per other character worth a look (charsToVisit), on an
   * account already borrowed: wait out the gate, log in as it (bringUp's
   * charId: nothing about the account's character of record changes and
   * the tracker keeps describing the played one), wait for the inventory,
   * file it (recordCharVisit), log out. A refusal that would refuse every
   * login (suspended, locked, paused) ends the round.
   */
  private async visitLoop(acc: BotAccount, st: AccountStorageState, tag: string, what: { items: boolean; containers: boolean } = { items: true, containers: false }): Promise<VisitSummary> {
    const { sd } = this.o;
    const forItems = what.items ? charsToVisit(st, st.loginCharId ?? null, VISIT_MAX_CHARS) : [];
    // The other side's vault, rack and gift chest: one login as a character of that side, on top of its items.
    const loginSeasonal = (st.chars ?? []).find((c) => c.id === st.loginCharId)?.seasonal ?? st.viewSeasonal ?? null;
    const sideChar = what.containers ? otherSideChar(st, st.loginCharId ?? null, loginSeasonal, forItems) : null;
    const targets = sideChar && !forItems.some((c) => c.id === sideChar.id) ? [...forItems, sideChar] : forItems;
    const out: VisitSummary = { total: targets.length, visited: 0, failed: 0, stopped: null };
    if (!targets.length) return out;
    this.log(`${tag}: ${acc.alias}: looking at ${targets.length} other character(s)${forItems.length ? " for their items' enchantments" : ""}${sideChar ? `; #${sideChar.id} reads the ${sideChar.seasonal ? "seasonal" : "non-seasonal"} side's containers` : ""}`);
    for (const [i, ch] of targets.entries()) {
      const label = `character #${ch.id} (${CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}`}, ${i + 1}/${targets.length})`;
      if (this.cancelled) {
        out.stopped = "cancelled by operator";
        break;
      }
      this.setActivity(acc.guid, `${tag}: ${label}: waiting for the login cooldown`);
      if (!(await this.waitForGate(acc))) {
        out.stopped = "login-locked";
        break;
      }
      this.setActivity(acc.guid, `${tag}: ${label}: logging in`);
      let client: GameClient;
      try {
        client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3", { charId: ch.id });
      } catch (e) {
        const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
        this.log(`${tag}: ${acc.alias}: ${label}: bring-up ${verdict}: ${(e as Error).message}`);
        out.failed++;
        if (verdict !== "failed") {
          out.stopped = verdict;
          break;
        }
        continue;
      }
      try {
        if (client.lastCharList) {
          st.chars = client.lastCharList.chars;
          st.charsAt = this.now();
        }
        if (client.charId !== ch.id) {
          this.log(`${tag}: ${acc.alias}: ${label}: the game loaded character #${client.charId} instead — skipped`);
          out.failed++;
          continue;
        }
        this.setActivity(acc.guid, `${tag}: ${label}: reading`);
        if (!(await waitForCharacter(client, this.visitTimeouts))) {
          this.log(`${tag}: ${acc.alias}: ${label}: never stood in world — skipped`);
          out.failed++;
          continue;
        }
        const snap = snapshotInventory(client);
        const r = recordCharVisit(st, ch.id, snap, this.now());
        out.visited++;
        this.log(`${tag}: ${acc.alias}: ${label}: ${r.items} tradeable item(s), ${r.enchanted} enchanted, ${snap.capacity} trade slots`);
        if (sideChar && ch.id === sideChar.id) {
          this.setActivity(acc.guid, `${tag}: ${label}: reading its side's vault`);
          try {
            const T = STORAGE_TIMEOUTS;
            await waitFor(client, () => inWorld(client, NEXUS_MAP), T.inWorldMs, "the Nexus");
            await sleep(T.settleMs);
            const view = await enterVault(client, T, (l) => this.log(`${tag}: ${acc.alias}: ${label}: ${l}`));
            const seasonal = client.charSeasonal ?? ch.seasonal;
            st.otherSide = { seasonal, at: this.now(), containers: containersFromView(view, st.otherSide?.seasonal === seasonal ? st.otherSide.containers : null, this.now() / 1000) };
            const used = (k: ContainerKind) => view[VIEW_KEY[k]].slots.filter((t) => t > 0).length;
            this.log(`${tag}: ${acc.alias}: ${label}: ${seasonal ? "seasonal" : "non-seasonal"} side: vault ${used("vault")}/${view.vault.slots.length} · rack ${used("rack")}/${view.potion.slots.length} · gift ${used("gift")}`);
          } catch (e) {
            this.log(`${tag}: ${acc.alias}: ${label}: could not read its side's vault: ${(e as Error).message}`);
            out.failed++;
          }
        }
      } finally {
        takeDown(sd.deps, acc, `${tag}: ${label} read`);
        this.o.store.requestSave();
      }
    }
    return out;
  }

  /**
   * One trip: borrow the account, log in, run the moves, record everything,
   * log out; then, when asked, look at the other characters (visitLoop),
   * one login each, before the account is given back.
   */
  private async trip(acc: BotAccount, moves: Move[], o: { label: string; bankable?: Instance[]; visitChars?: boolean }): Promise<TripOutcome> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    const tag = o.label;
    if (acc.assignedRequestId !== null || acc.inUse) {
      st.lastError = "busy with a trade";
      return { verdict: "skipped", error: st.lastError, outcomes: [], captured: false };
    }
    if (this.tripping.has(acc.guid)) {
      st.lastError = "another trip is driving the account";
      return { verdict: "skipped", error: st.lastError, outcomes: [], captured: false };
    }
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `${tag}: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) {
      st.lastError = lent.why;
      return { verdict: "skipped", error: lent.why, outcomes: [], captured: false };
    }
    this.tripping.add(acc.guid);
    try {
      const r = await this.oneLogin(acc, st, moves, o);
      if (o.visitChars && r.loggedIn) {
        const authoritative = !!r.snapshot?.authoritative;
        if (authoritative) this.log(`${tag}: ${acc.alias}: the account snapshot carried the other characters' enchantments; no visits needed for them`);
        const v = await this.visitLoop(acc, st, tag, { items: !authoritative, containers: true });
        if (v.total) {
          const note = visitNote(v);
          if (st.lastRun) st.lastRun.summary = `${st.lastRun.summary} | ${note}`;
          if ((v.failed || v.stopped) && st.lastError === null) st.lastError = note;
          this.log(`${tag}: ${acc.alias}: ${note}`);
        }
      }
      return r;
    } finally {
      this.tripping.delete(acc.guid);
      this.o.sd.deps.proxies.releaseProbe(acc.guid);
      lent.giveBack();
      this.setActivity(acc.guid, null);
      store.requestSave();
    }
  }

  /** The trip's one login as the played character: bring up, run the moves, record everything, log out. */
  private async oneLogin(acc: BotAccount, st: AccountStorageState, moves: Move[], o: { label: string; bankable?: Instance[] }): Promise<TripOutcome & { loggedIn: boolean }> {
    const { sd, store } = this.o;
    const tag = o.label;
    this.setActivity(acc.guid, `${tag}: logging in`);
    let client: GameClient;
    try {
      client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3");
    } catch (e) {
      const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
      st.lastError = `bring-up ${verdict}: ${(e as Error).message}`;
      this.log(`${tag}: ${acc.alias}: ${st.lastError}`);
      return { verdict: verdict === "failed" && !refusalPasses(e) ? "failed" : "skipped", error: st.lastError, outcomes: [], captured: false, bringUpVerdict: verdict, loggedIn: false };
    }
    try {
      const tracked = sd.tracker.instancesFor(acc.botGuid);
      const quickslots = client.lastCharList?.chars.find((c) => c.id === client.charId)?.quickslots;
      const r = await runStorageTrip(client, { moves, tracked, bankable: o.bankable, log: (l) => this.log(`${tag}: ${acc.alias}: ${l}`), now: this.now, onStep: (label) => this.setActivity(acc.guid, `${tag}: ${label}`), ...(quickslots ? { quickslots } : {}) });
      const filed = await this.applyTrip(acc, st, client, r, tracked, { tag, snapshot: true });
      return { verdict: r.ok ? "ok" : "failed", error: r.error, outcomes: r.outcomes, captured: filed.captured, loggedIn: true, snapshot: filed.snapshot };
    } finally {
      takeDown(sd.deps, acc, `${tag} trip done`);
      store.requestSave();
    }
  }
  /**
   * File what a trip as the played character did: the char list it read, the containers it saw with every identity
   * carried (what went in keeps the tracked instance's, what came out arrives under the one it was listed with), the
   * tracker from the session's inventory, the other characters from the list; with `snapshot`, the account snapshot
   * read with the session's token. A fresh login's trip (oneLogin) and a live session's (bankOnline, fetchOnline)
   * share it; nobody logs out here. `run: false`: not the operator's run, which counts what its trips moved.
   * `promised`: moves whose item was promised to the tracker while the trip ran (a live session's).
   */
  private async applyTrip(acc: BotAccount, st: AccountStorageState, client: GameClient, r: StorageTripResult, tracked: Record<number, Instance>, o: { tag: string; snapshot: boolean; run?: boolean; promised?: ReadonlySet<string> }): Promise<{ captured: boolean; snapshot?: SnapshotNote }> {
    const { sd, store } = this.o;
    const tag = o.tag;
    const promised = o.promised ?? new Set<string>();
    let captured = false;
    if (client.charSeasonal !== null) sd.pool.setSeasonal(acc, client.charSeasonal);
    if (r.chars) {
      st.chars = r.chars;
      st.charsAt = this.now();
      if (r.maxNumChars !== null) st.maxNumChars = r.maxNumChars;
    }
    // What was where, as of before this trip: an item taken out keeps the identity it was listed under. A trip as a
    // character of the other side (a fetch from the seasonal vault) saw the other side's containers.
    const otherSideTrip = client.charSeasonal !== null && st.viewSeasonal != null && client.charSeasonal !== st.viewSeasonal;
    const before = otherSideTrip ? st.otherSide?.containers ?? null : st.containers;
    const takenFromList = this.takeFromLists(before, r.outcomes);
    if (r.view) {
      this.applyView(st, r.view, client.charSeasonal);
      st.untracked = r.untracked;
    }
    // Moves on the character itself are applied after the snapshot below: char/list lags a live swap until the character saves, so the snapshot would list the item where it was.
    const charDone: Move[] = [];
    for (const oc of r.outcomes) {
      if (isDrop(oc.move.kind)) {
        if (oc.ok) {
          st.moves = st.moves.filter((m) => m.id !== oc.move.id);
          if (o.run !== false) this.run.moved++;
        } else {
          const m = st.moves.find((x) => x.id === oc.move.id);
          if (m) m.error = oc.detail;
        }
        continue;
      }
      if (isCharMove(oc.move.kind)) {
        if (oc.ok) {
          charDone.push(oc.move);
          st.moves = st.moves.filter((m) => m.id !== oc.move.id);
          if (o.run !== false) this.run.moved++;
        } else {
          const m = st.moves.find((x) => x.id === oc.move.id);
          if (m) m.error = oc.detail;
        }
        continue;
      }
      const kind = MOVE_CONTAINER[oc.move.kind]!;
      const c = st.containers?.[kind];
      if (oc.ok && c && oc.slot !== null) {
        if (TO_CONTAINER[oc.move.kind]) {
          const inst = Object.values(tracked).find((i) => i.instanceId === oc.move.instanceId);
          if (inst) c.instances[oc.slot] = inst;
        } else {
          // The item arrives under the identity it was listed under (a list already closed up in the view above);
          // a live session's trip promised it to the tracker as it went.
          const listed = LIST_KINDS.has(kind) ? takenFromList.get(oc.move.id) : before?.[kind]?.instances[oc.slot];
          if (!LIST_KINDS.has(kind)) delete c.instances[oc.slot];
          if (!promised.has(oc.move.id)) {
            if (listed) sd.tracker.expectArrival(acc.botGuid, listed);
            else if (oc.move.itemId) sd.tracker.expectArrival(acc.botGuid, { instanceId: oc.move.instanceId ?? randomUUID().replace(/-/g, ""), itemId: oc.move.itemId, enchantments: [], capturedAt: this.now() / 1000 });
          }
        }
        st.moves = st.moves.filter((m) => m.id !== oc.move.id);
        if (o.run !== false) this.run.moved++;
      } else {
        const m = st.moves.find((x) => x.id === oc.move.id);
        if (m) m.error = oc.detail;
      }
    }
    // The character is described only once it was in world; a login that never got there keeps the last snapshot.
    if (client.objectId !== -1 && client.playerData.name) {
      const snap = snapshotInventory(client);
      // char/list's BackpackSlots is exact (8, 16 or 24 slots); the session's own guess only sees a backpack through the items in it.
      const listedBp = client.lastCharList?.chars.find((c) => c.id === client.charId)?.backpackSlots;
      sd.tracker.updateFromSlots(acc.botGuid, snap.slots, listedBp !== undefined ? 8 + listedBp : snap.hasBp ? Math.max(16, snap.capacity) : 8);
      sd.tracker.recordIgn(acc.botGuid, client.playerData.name);
      captured = true;
    }
    // The character list just read may name items the tracker now holds, or no longer does.
    reconcileCharItems(st, client.charId, this.now());
    // The account snapshot, with the session's token: every other character's items with their enchantments, and the containers'.
    let snapshot: SnapshotNote | undefined;
    const dumpR = o.snapshot ? await getAccountDump(client.token, client.proxy) : null;
    if (dumpR?.ok) {
      store.keepSnapshot(acc.botGuid, dumpR.value);
      try {
        snapshot = applySnapshot(st, parseAccountDump(dumpR.value), client.charId, this.now());
        st.lastSnapshot = { ...snapshot, at: this.now() };
        this.log(`${tag}: ${acc.alias}: ${snapshotWords(snapshot)}`);
      } catch (e) {
        this.log(`${tag}: ${acc.alias}: account snapshot unreadable: ${(e as Error).message}`);
      }
    } else if (dumpR) {
      st.lastSnapshot = null;
      this.log(`${tag}: ${acc.alias}: account snapshot not read: ${dumpR.error.kind}`);
    }
    for (const m of charDone) this.noteTuckedOut(st, client.charId, m, acc.botGuid, promised.has(m.id));
    st.lastRun = { at: this.now(), ok: r.ok, error: r.error, summary: r.summary };
    st.lastError = r.ok ? null : r.error;
    this.log(`${tag}: ${acc.alias}: ${r.summary}`);
    return { captured, snapshot };
  }
  /**
   * Record a fresh view: object ids and slot lists as the vault gave them.
   * Identities carry over where the slot still holds the same type; every
   * other tradeable item gets one now, so the pool can list it.
   */
  /**
   * A move on the character went through on `charId`. Out (unequip /
   * unstack): the item is in its inventory now, under the identity it was
   * listed with. In (equip / stack): it left the inventory for the slot, and
   * is listed there from now on. The char-list mirrors follow either way.
   */
  private noteTuckedOut(st: AccountStorageState, charId: number, move: Move, botGuid: string, promised = false): void {
    const key = String(charId);
    const ch = st.chars?.find((c) => c.id === charId);
    let listed: Instance | undefined;
    if (isTuckIn(move.kind) && move.charSlot !== undefined && move.itemId) {
      const tracked = this.o.sd.tracker.instancesFor(botGuid);
      const gone = Object.entries(tracked).find(([, i]) => i.instanceId === move.instanceId) ?? Object.entries(tracked).find(([, i]) => i.itemId === move.itemId);
      const inst: Instance = gone ? { ...gone[1] } : { instanceId: move.instanceId ?? randomUUID().replace(/-/g, ""), itemId: move.itemId, enchantments: [], capturedAt: this.now() / 1000 };
      if (move.kind === "equip") {
        st.wornItems ??= {};
        (st.wornItems[key] ??= {})[move.charSlot] = inst;
        if (ch && ch.equipment.length > move.charSlot) ch.equipment[move.charSlot] = move.objectType;
      } else {
        st.quickItems ??= {};
        const q = ((st.quickItems[key] ??= {})[move.charSlot] ??= { itemId: move.itemId, ids: [] });
        q.ids.push(inst.instanceId);
        if (ch) {
          ch.quickslots ??= [];
          const qs = (ch.quickslots[move.charSlot] ??= { type: -1, count: 0 });
          qs.type = move.objectType;
          qs.count += 1;
        }
      }
      // The tracker sees the inventory slot empty at its next capture; the identity moved with the item into wornItems / quickItems.
      return;
    }
    if (move.kind === "unequip" && move.charSlot !== undefined) {
      listed = st.wornItems?.[key]?.[move.charSlot];
      if (st.wornItems?.[key]) delete st.wornItems[key][move.charSlot];
      if (ch && ch.equipment[move.charSlot] !== undefined) ch.equipment[move.charSlot] = -1;
    } else if (move.kind === "unstack" && move.charSlot !== undefined) {
      const q = st.quickItems?.[key]?.[move.charSlot];
      if (q) {
        const i = move.instanceId ? q.ids.indexOf(move.instanceId) : -1;
        const id = i >= 0 ? q.ids.splice(i, 1)[0] : q.ids.pop();
        if (id) listed = { instanceId: id, itemId: q.itemId, enchantments: [], capturedAt: this.now() / 1000 };
        if (!q.ids.length) delete st.quickItems![key][move.charSlot];
      }
      const qs = ch?.quickslots?.[move.charSlot];
      if (qs) {
        qs.count = Math.max(0, qs.count - 1);
        if (!qs.count) qs.type = -1;
      }
    }
    // Only the played character's inventory is the tracker's; another character's own items are read on its next visit.
    // A live session's trip promised the item to the tracker as it went.
    if (!promised && charId === (st.loginCharId ?? null) && (listed || move.itemId)) this.o.sd.tracker.expectArrival(botGuid, listed ?? { instanceId: move.instanceId ?? randomUUID().replace(/-/g, ""), itemId: move.itemId!, enchantments: [], capturedAt: this.now() / 1000 });
  }
  private applyView(st: AccountStorageState, view: VaultView, seenBy: boolean | null): void {
    // The played character changed side: what it read before was the other side's, and what the other side read is now this one's.
    if (seenBy !== null && st.viewSeasonal != null && st.viewSeasonal !== seenBy && st.containers) {
      const swapped = st.otherSide?.seasonal === seenBy ? st.otherSide.containers : null;
      st.otherSide = { seasonal: st.viewSeasonal, at: st.lastVisitAt ?? this.now(), containers: st.containers };
      st.containers = swapped;
    }
    st.containers = containersFromView(view, st.containers, this.now() / 1000);
    st.viewSeasonal = seenBy;
    st.lastVisitAt = this.now();
    if (st.otherSide && seenBy !== null && st.otherSide.seasonal === seenBy) st.otherSide = null;
  }
}

/** The containers a character of `seasonal`'s side sees, as last read; null when nothing has described that side's. */
function containersOfSide(st: AccountStorageState, seasonal: boolean, accSeasonal: boolean): Containers | null {
  if (st.containers && (st.viewSeasonal ?? accSeasonal) === seasonal) return st.containers;
  if (st.otherSide?.seasonal === seasonal) return st.otherSide.containers;
  return null;
}
/** The identity a move brings into the played character's inventory: what the container listed it as, or the worn or quickslot item's. */
function inboundIdentity(st: AccountStorageState, containers: Containers | null, move: Move, now: number): Instance | null {
  const kind = MOVE_CONTAINER[move.kind];
  if (kind) {
    const c = containers?.[kind];
    if (!c) return null;
    const named = move.instanceId ? Object.values(c.instances).find((i) => i.instanceId === move.instanceId) : undefined;
    return named ?? (move.slot !== undefined ? c.instances[move.slot] ?? null : null);
  }
  const key = String(st.loginCharId ?? "");
  if (move.kind === "unequip" && move.charSlot !== undefined) return st.wornItems?.[key]?.[move.charSlot] ?? null;
  if (move.kind === "unstack" && move.charSlot !== undefined) {
    const q = st.quickItems?.[key]?.[move.charSlot];
    if (!q?.ids.length) return null;
    // The unit noteTuckedOut takes off the stack: the one named, else the last.
    const id = move.instanceId && q.ids.includes(move.instanceId) ? move.instanceId : q.ids[q.ids.length - 1];
    return { instanceId: id, itemId: q.itemId, enchantments: [], capturedAt: now / 1000 };
  }
  return null;
}
/** A live session's trade slots: 8, 16 with a backpack, 24 with the upgraded one (as snapshotInventory reads them). */
function tradeSlotsOf(client: GameClient): number {
  const seen = client.playerData.tradeSlots;
  return Math.max(Number.isFinite(seen) ? seen : 8, client.hasBackpack ? 16 : 8);
}
/** Trade slots holding something, of the first `slots`. */
function countHeld(inv: number[], slots: number): number {
  let n = 0;
  for (let i = TRADE_SLOT_FIRST; i < TRADE_SLOT_FIRST + slots && i < inv.length; i++) if (inv[i] > 0) n++;
  return n;
}
/** A move for one thing compaction or a gather carries. */
function thingMove(kind: MoveKind, t: CharThing, extra: Partial<Move>, now: number): Move {
  return { id: randomUUID().slice(0, 8), kind, itemId: t.itemId, objectType: t.objectType, name: nameOfType(t.objectType).name, ...(t.instanceId ? { instanceId: t.instanceId } : {}), ...extra, queuedAt: now };
}

/** The containers a VAULTINFO view shows, each tradeable slot under the identity `prev` had for it while its type holds, else a new one. */
export function containersFromView(view: VaultView, prev: Containers | null, nowSeconds: number): Containers {
  const next: Containers = { vault: { objectId: view.vault.objectId, slots: [...view.vault.slots], instances: {} }, rack: { objectId: view.potion.objectId, slots: [...view.potion.slots], instances: {} }, gift: { objectId: view.gift.objectId, slots: [...view.gift.slots], instances: {} }, spoils: { objectId: view.spoils.objectId, slots: [...view.spoils.slots], instances: {} } };
  for (const k of CONTAINER_KINDS) {
    if (LIST_KINDS.has(k)) next[k].instances = carryListIdentities(prev?.[k]?.instances ?? {}, next[k].slots);
    else for (const [s, inst] of Object.entries(prev?.[k]?.instances ?? {})) {
      const slot = Number(s);
      if (next[k].slots[slot] === toObjType(inst.itemId)) next[k].instances[slot] = inst;
    }
    next[k].slots.forEach((type, slot) => {
      if (next[k].instances[slot] || type <= 0 || !isPoolItem(type)) return;
      const itemId = toCatalogId(type);
      if (itemId) next[k].instances[slot] = { instanceId: randomUUID().replace(/-/g, ""), itemId, enchantments: [], capturedAt: nowSeconds };
    });
  }
  return next;
}
