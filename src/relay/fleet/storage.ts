// Account storage (docs/relay/STORAGE.md): the vault chests, the potion
// rack, the Gift Chest and the seasonal spoils chest an account has beyond
// its character's trade slots. The operator queues moves per account in
// the console; a run logs each account in, walks it into the Vault, does
// the moves as INVSWAPs against the containers VAULTINFO names, and
// records what every container holds. Nothing here runs by itself, and
// the dispatcher leaves an account alone while its trip lasts.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GameClient } from "../client/gameClient";
import type { Packet } from "../protocol/packets";
import { getCharListDetail, type CharDetail } from "../realm/api";
import { ITEM_BY_ID } from "../../lib/catalog";
import { realmItemNameByType } from "../../lib/sprites";
import { isPoolItem, toCatalogId, toObjType } from "../trade/itemMap";
import type { BotAccount } from "./botPool";
import { bringUp, BringUpRefused, takeDown } from "./bringUp";
import { borrowAccount } from "./borrow";
import type { Instance } from "./inventoryTracker";
import { snapshotInventory, type SweepDeps } from "./sweeps";
import { dist, enterVault, inWorld, NEXUS_MAP, nextPacket, sleep, waitFor, walkTo, type VaultView } from "./vaultTrip";

export type ContainerKind = "vault" | "rack" | "gift" | "spoils";
export const CONTAINER_KINDS: ContainerKind[] = ["vault", "rack", "gift", "spoils"];
export const CONTAINER_LABEL: Record<ContainerKind, string> = { vault: "vault chest", rack: "potion rack", gift: "gift chest", spoils: "spoils chest" };
/** Which way a move goes and where. */
export type MoveKind = "bank" | "unbank" | "rackIn" | "rackOut" | "giftOut" | "spoilsOut";
export const MOVE_CONTAINER: Record<MoveKind, ContainerKind> = { bank: "vault", unbank: "vault", rackIn: "rack", rackOut: "rack", giftOut: "gift", spoilsOut: "spoils" };
const TO_CONTAINER: Record<MoveKind, boolean> = { bank: true, unbank: false, rackIn: true, rackOut: false, giftOut: false, spoilsOut: false };

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
  queuedAt: number;
  /** Why the last run could not do it; the move stays queued for the operator to see. */
  error?: string;
}
export type MoveInput = { kind: MoveKind; instanceId?: string; slot?: number };
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
  /** What this node put in a slot itself (bank / rack in): the instance keeps its identity on the way back. */
  placed: Record<number, Instance>;
}
export type Containers = Record<ContainerKind, ContainerSnapshot>;

export interface AccountStorageState {
  alias: string;
  guid: string;
  botGuid: string;
  lastVisitAt: number | null;
  containers: Containers | null;
  /** Non-catalog items on the character at the last visit (the tracker only knows catalog items). */
  untracked?: UntrackedSlot[];
  chars: CharDetail[] | null;
  charsAt: number | null;
  moves: Move[];
  lastRun: { at: number; ok: boolean; error: string | null; summary: string } | null;
  lastError: string | null;
}
const emptyState = (acc: BotAccount): AccountStorageState => ({ alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, lastVisitAt: null, containers: null, chars: null, charsAt: null, moves: [], lastRun: null, lastError: null });

/** Player classes by object type, for the character list. */
export const CLASS_NAMES: Record<number, string> = {
  768: "Rogue", 775: "Archer", 782: "Wizard", 784: "Priest", 797: "Warrior", 771: "Knight", 779: "Paladin", 803: "Assassin",
  804: "Necromancer", 805: "Huntress", 807: "Mystic", 808: "Trickster", 809: "Sorcerer", 810: "Ninja", 811: "Samurai", 812: "Bard", 813: "Summoner", 814: "Kensei",
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
  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: Record<string, AccountStorageState> };
        // Moves from before a move carried its type and name are dropped; they are cheap to queue again.
        for (const [g, st] of Object.entries(raw.accounts ?? {})) this.accounts.set(g, { ...st, moves: Array.isArray(st.moves) ? st.moves.filter((m) => Number.isInteger(m.objectType) && typeof m.name === "string") : [] });
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
  get(botGuid: string): AccountStorageState | undefined {
    return this.accounts.get(botGuid);
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
  requestSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 2_000);
    this.saveTimer.unref?.();
  }
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
}
export type Plan = { ok: true; from: SlotRef; to: SlotRef; container: ContainerKind; objectType: number } | { ok: false; error: string };

/**
 * Where a move's INVSWAP goes. Character -> container: the instance's slot
 * (the tracker's, checked against the live inventory, else any slot holding
 * that item) to the container's first free slot. Container -> character:
 * the named slot, checked to still hold the item, to the first free trade
 * slot. Mutates nothing; the trip applies each swap to its own mirror.
 */
export function planMove(move: Move, st: PlanInput): Plan {
  const kind = MOVE_CONTAINER[move.kind];
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
  const slot = move.slot ?? -1;
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
  vaultInfoMs: 10_000,
  /** INVRESULT answered every INVSWAP within 120 ms live (2026-09-17); this is generous. */
  swapAckMs: 5_000,
  /** Between swaps; the player's client paced them at 0.5-1 s. */
  swapPaceMs: 700,
  /** How close to a container before swapping with it. */
  chestReach: 1.0,
};
export interface MoveOutcome {
  move: Move;
  ok: boolean;
  detail: string;
  /** The container slot the item went to or came from. */
  slot: number | null;
}
export interface StorageTripResult {
  ok: boolean;
  error: string | null;
  summary: string;
  view: VaultView | null;
  outcomes: MoveOutcome[];
  chars: CharDetail[] | null;
  /** Items on the character the node does not trade, as of the end of the trip. */
  untracked: UntrackedSlot[];
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
  log: (line: string) => void;
  now: () => number;
  timeouts?: Partial<typeof STORAGE_TIMEOUTS>;
  onStep?: (label: string) => void;
}

/**
 * One account's storage trip on an already-connected client headed for the
 * Nexus: read the character list, enter the Vault, do the moves in order,
 * each an INVSWAP confirmed by its INVRESULT. Never throws for game-side
 * failures: the result says how far it got and how each move went.
 */
export async function runStorageTrip(client: GameClient, o: StorageTripOptions): Promise<StorageTripResult> {
  const T = { ...STORAGE_TIMEOUTS, ...o.timeouts };
  const res: StorageTripResult = { ok: false, error: null, summary: "", view: null, outcomes: [], chars: null, untracked: [] };
  const steps: string[] = [];
  const step = (label: string) => o.onStep?.(label);
  try {
    step("waiting for the Nexus");
    await waitFor(client, () => inWorld(client, NEXUS_MAP), T.inWorldMs, "the Nexus");
    await sleep(T.settleMs);
    steps.push(`in the Nexus as ${client.playerData.name} (${client.playerData.tradeSlots} trade slots)`);
    step("reading the character list");
    const cl = await getCharListDetail(client.token, client.proxy);
    if (cl.ok) {
      res.chars = cl.value.chars;
      steps.push(`${cl.value.chars.length} character(s) of ${cl.value.maxNumChars}`);
    } else steps.push(`char/list ${cl.error.kind}`);

    step("walking to the Vault Portal");
    const view = await enterVault(client, T, o.log);
    res.view = view;
    const used = (k: ContainerKind) => view[VIEW_KEY[k]].slots.filter((t) => t > 0).length;
    steps.push(`vault: ${used("vault")}/${view.vault.slots.length} · rack ${used("rack")}/${view.potion.slots.length} · gift ${used("gift")} · spoils ${used("spoils")}`);
    await sleep(1_000);

    // A mirror of what the server holds, moved along as each swap is confirmed.
    const inv = [...client.playerData.inv];
    const containers: PlanInput["containers"] = { vault: { objectId: view.vault.objectId, slots: [...view.vault.slots] }, rack: { objectId: view.potion.objectId, slots: [...view.potion.slots] }, gift: { objectId: view.gift.objectId, slots: [...view.gift.slots] }, spoils: { objectId: view.spoils.objectId, slots: [...view.spoils.slots] } };
    let n = 0;
    for (const move of o.moves) {
      n++;
      const label = `${move.kind} ${move.name}`;
      step(`move ${n}/${o.moves.length}: ${label}`);
      const plan = planMove(move, { playerObjectId: client.objectId, inv, tradeSlots: client.playerData.tradeSlots, containers, tracked: o.tracked });
      if (!plan.ok) {
        res.outcomes.push({ move, ok: false, detail: plan.error, slot: null });
        steps.push(`${label}: ${plan.error}`);
        continue;
      }
      // Near the container first; the server refuses swaps from too far (the player's client walked up to each).
      const chest = client.world.entities.get(containers[plan.container].objectId);
      if (chest) {
        const me = client.pos;
        if (!me || dist(me, chest.pos) > T.chestReach) await walkTo(client, chest.pos, T.chestReach, T.walkMs, `the ${CONTAINER_LABEL[plan.container]}`);
        await sleep(300);
      }
      const answer = nextPacket(client, "INVRESULT", T.swapAckMs, (p) => sameSlot(p.fromSlot, plan.from) && sameSlot(p.toSlot, plan.to));
      client.send("INVSWAP", { time: client.getTime(), pos: { ...(client.pos ?? { x: 0, y: 0 }) }, slotObject1: plan.from, slotObject2: plan.to });
      const r = (await answer) as Packet<"INVRESULT"> | null;
      const contSlot = TO_CONTAINER[move.kind] ? plan.to.slotId : plan.from.slotId;
      if (r && r.unknownBool) {
        inv[TO_CONTAINER[move.kind] ? plan.from.slotId : plan.to.slotId] = TO_CONTAINER[move.kind] ? -1 : plan.objectType;
        containers[plan.container].slots[contSlot] = TO_CONTAINER[move.kind] ? plan.objectType : -1;
        res.outcomes.push({ move, ok: true, detail: `${CONTAINER_LABEL[plan.container]} slot ${contSlot}`, slot: contSlot });
        steps.push(`${label}: ok (${CONTAINER_LABEL[plan.container]} slot ${contSlot})`);
      } else {
        const detail = r ? "the server refused the swap" : "no answer to the swap";
        res.outcomes.push({ move, ok: false, detail, slot: contSlot });
        steps.push(`${label}: ${detail}`);
      }
      await sleep(T.swapPaceMs);
    }
    res.view = { ...view, vault: { ...view.vault, slots: containers.vault.slots }, potion: { ...view.potion, slots: containers.rack.slots }, gift: { ...view.gift, slots: containers.gift.slots }, spoils: { ...view.spoils, slots: containers.spoils.slots } };
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
const freshRun = (): RunState => ({ running: false, startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, skipped: 0, current: [], stoppedReason: null, lastErrors: [], moved: 0 });

export interface StorageServiceOptions {
  sd: SweepDeps;
  store: StorageStore;
  /** Guids the dispatcher must leave alone while a trip drives them. */
  holds: Set<string>;
  /** Ask the dispatcher to let go of an idle online bot (it disconnects it); false when the bot is busy. */
  release?: (acc: BotAccount) => boolean;
  now?: () => number;
}


export interface CharRow extends CharDetail {
  className: string;
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
  moves: Move[];
  lastRun: AccountStorageState["lastRun"];
  lastError: string | null;
  counts: {
    character: { held: number; capacity: number };
    vault: { used: number; slots: number };
    rack: { used: number; slots: number };
    gift: { items: number; tradeable: number };
    spoils: { items: number; tradeable: number };
  };
}
export interface SlotRow {
  slot: number;
  objectType: number;
  itemId: string | null;
  name: string;
  tradeable: boolean;
  placedInstanceId: string | null;
}
export interface AccountDetail extends AccountSummary {
  character: { slot: number; instanceId: string; itemId: string; name: string; enchantments: number[]; potion: boolean }[];
  /** On the character but not traded by the node; they take slots and can be put away. */
  untracked: UntrackedSlot[];
  vault: SlotRow[];
  rack: SlotRow[];
  gift: SlotRow[];
  spoils: SlotRow[];
}

const STAGGER_MS = Number(process.env.STORAGE_STAGGER_MS ?? 3000);

export class StorageService {
  readonly run: RunState = freshRun();
  private readonly activity = new Map<string, string>();
  private cancelled = false;
  private readonly now: () => number;
  constructor(private readonly o: StorageServiceOptions) {
    this.now = o.now ?? Date.now;
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
  private setActivity(guid: string, label: string | null): void {
    if (label === null) this.activity.delete(guid);
    else this.activity.set(guid, label);
  }

  private counts(acc: BotAccount, st: AccountStorageState): AccountSummary["counts"] {
    const { tracker } = this.o.sd;
    const c = st.containers;
    const used = (s: number[]) => s.filter((t) => t > 0).length;
    const tradeable = (s: number[]) => s.filter((t) => t > 0 && isPoolItem(t)).length;
    return {
      character: { held: tracker.heldCount(acc.botGuid) + (st.untracked?.length ?? 0), capacity: tracker.capacityFor(acc.botGuid) },
      vault: { used: c ? used(c.vault.slots) : 0, slots: c ? c.vault.slots.length : 0 },
      rack: { used: c ? used(c.rack.slots) : 0, slots: c ? c.rack.slots.length : 0 },
      gift: { items: c ? used(c.gift.slots) : 0, tradeable: c ? tradeable(c.gift.slots) : 0 },
      spoils: { items: c ? used(c.spoils.slots) : 0, tradeable: c ? tradeable(c.spoils.slots) : 0 },
    };
  }
  private summary(acc: BotAccount): AccountSummary {
    const st = this.o.store.for(acc);
    const busy = !!(acc.client && acc.client.active) || acc.assignedRequestId !== null || acc.inUse || this.activity.has(acc.guid);
    return {
      alias: acc.alias, guid: acc.guid, botGuid: acc.botGuid, ign: this.o.sd.tracker.ignFor(acc.botGuid) ?? "", seasonal: acc.seasonalOrDefault, suspended: !!acc.suspended, busy,
      lastVisitAt: st.lastVisitAt, charsAt: st.charsAt, chars: st.chars ? st.chars.map((ch) => ({ ...ch, className: CLASS_NAMES[ch.objectType] ?? `class ${ch.objectType}` })) : null,
      preferredCharId: acc.info.charId ?? null, moves: st.moves, lastRun: st.lastRun, lastError: st.lastError, counts: this.counts(acc, st),
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
        out.push({ slot, objectType: t, itemId: n.itemId, name: n.name, tradeable: n.tradeable, placedInstanceId: c.placed[slot]?.instanceId ?? null });
      });
      return out;
    };
    const character = Object.entries(this.o.sd.tracker.instancesFor(acc.botGuid)).map(([slot, i]) => ({ slot: Number(slot), instanceId: i.instanceId, itemId: i.itemId, name: ITEM_BY_ID.get(i.itemId)?.name ?? i.itemId, enchantments: i.enchantments, potion: isPotion(i.itemId) })).sort((a, b) => a.slot - b.slot);
    return { ...this.summary(acc), character, untracked: st.untracked ?? [], vault: rows(st.containers?.vault), rack: rows(st.containers?.rack), gift: rows(st.containers?.gift), spoils: rows(st.containers?.spoils) };
  }

  /** Queue moves for an account. Each is checked against what the node knows now; the trip checks again against the live vault. */
  queue(botGuid: string, adds: MoveInput[]): { ok: true; moves: Move[] } | { ok: false; error: string } {
    const acc = this.findAccount(botGuid);
    if (!acc) return { ok: false, error: "no such account" };
    const st = this.o.store.for(acc);
    const tracked = this.o.sd.tracker.instancesFor(acc.botGuid);
    const out: Move[] = [];
    for (const a of adds) {
      if (!(a.kind in MOVE_CONTAINER)) return { ok: false, error: `unknown move ${String(a.kind)}` };
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
      } else {
        const c = st.containers?.[kind];
        const slot = Number(a.slot);
        if (!c || !Number.isInteger(slot) || slot < 0 || slot >= c.slots.length || c.slots[slot] <= 0) return { ok: false, error: `nothing known in that ${CONTAINER_LABEL[kind]} slot; refresh first` };
        const n = nameOfType(c.slots[slot]);
        if (!n.itemId) return { ok: false, error: `${n.name} is not an item the node trades` };
        if ((a.kind === "giftOut" || a.kind === "spoilsOut") && !n.tradeable) return { ok: false, error: `${n.name} is not tradeable` };
        if (st.moves.some((m) => m.kind === a.kind && m.slot === slot)) return { ok: false, error: `${n.name} is already queued` };
        out.push({ id: randomUUID().slice(0, 8), kind: a.kind, itemId: n.itemId, objectType: c.slots[slot], name: n.name, slot, queuedAt: this.now() });
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
        }
        await sleep(STAGGER_MS);
      }
    } finally {
      this.o.store.save();
      this.run.running = false;
      this.run.finishedAt = this.now() / 1000;
      this.log(`storage: done — ${this.run.ok} ok, ${this.run.failed} failed, ${this.run.skipped} skipped, ${this.run.moved} move(s)${this.run.stoppedReason ? ` (${this.run.stoppedReason})` : ""}`);
    }
  }
  private async one(acc: BotAccount, refresh: boolean): Promise<"ok" | "failed" | "skipped"> {
    const { sd, store, holds } = this.o;
    const st = store.for(acc);
    if (acc.assignedRequestId !== null || acc.inUse) {
      st.lastError = "busy with a trade";
      return "skipped";
    }
    const moves = refresh ? [] : [...st.moves];
    const lent = await borrowAccount(acc, { sd, holds, release: this.o.release, activity: (l) => this.setActivity(acc.guid, l && `storage: ${l}`), cancelled: () => this.cancelled, now: this.now });
    if (!lent.ok) {
      st.lastError = lent.why;
      return "skipped";
    }
    this.setActivity(acc.guid, "storage: logging in");
    let client: GameClient;
    try {
      client = await (sd.deps.bringUp ?? bringUp)(sd.deps, acc, acc.info.server ?? "USSouth3");
    } catch (e) {
      lent.giveBack();
      const verdict = e instanceof BringUpRefused ? e.verdict : "failed";
      st.lastError = `bring-up ${verdict}: ${(e as Error).message}`;
      this.log(`storage: ${acc.alias}: ${st.lastError}`);
      return verdict === "failed" ? "failed" : "skipped";
    }
    try {
      const tracked = sd.tracker.instancesFor(acc.botGuid);
      const r = await runStorageTrip(client, { moves, tracked, log: (l) => this.log(`storage: ${acc.alias}: ${l}`), now: this.now, onStep: (label) => this.setActivity(acc.guid, `storage: ${label}`) });
      if (client.charSeasonal !== null) sd.pool.setSeasonal(acc, client.charSeasonal);
      if (r.chars) {
        st.chars = r.chars;
        st.charsAt = this.now();
      }
      // What was placed where, as of before this trip: an item taken back out is looked up there.
      const before = st.containers;
      if (r.view) {
        this.applyView(st, r.view);
        st.untracked = r.untracked;
      }
      for (const oc of r.outcomes) {
        const kind = MOVE_CONTAINER[oc.move.kind];
        const c = st.containers?.[kind];
        if (oc.ok && c && oc.slot !== null) {
          if (TO_CONTAINER[oc.move.kind]) {
            const inst = Object.values(tracked).find((i) => i.instanceId === oc.move.instanceId);
            if (inst) c.placed[oc.slot] = inst;
          } else {
            const placed = before?.[kind]?.placed[oc.slot];
            delete c.placed[oc.slot];
            if (placed) sd.tracker.expectArrival(acc.botGuid, placed);
            else if (oc.move.itemId) sd.tracker.expectArrival(acc.botGuid, { instanceId: randomUUID().replace(/-/g, ""), itemId: oc.move.itemId, enchantments: [], capturedAt: this.now() / 1000 });
          }
          st.moves = st.moves.filter((m) => m.id !== oc.move.id);
          this.run.moved++;
        } else {
          const m = st.moves.find((x) => x.id === oc.move.id);
          if (m) m.error = oc.detail;
        }
      }
      const snap = snapshotInventory(client);
      sd.tracker.updateFromSlots(acc.botGuid, snap.slots, snap.hasBp ? Math.max(16, snap.capacity) : 8);
      if (client.playerData.name) sd.tracker.recordIgn(acc.botGuid, client.playerData.name);
      st.lastRun = { at: this.now(), ok: r.ok, error: r.error, summary: r.summary };
      st.lastError = r.ok ? null : r.error;
      this.log(`storage: ${acc.alias}: ${r.summary}`);
      return r.ok ? "ok" : "failed";
    } finally {
      takeDown(sd.deps, acc, "storage trip done");
      lent.giveBack();
      store.requestSave();
    }
  }
  /** Record a fresh view: object ids and slot lists as the vault gave them; what this node placed stays where the slots still agree. */
  private applyView(st: AccountStorageState, view: VaultView): void {
    const next: Containers = { vault: { objectId: view.vault.objectId, slots: [...view.vault.slots], placed: {} }, rack: { objectId: view.potion.objectId, slots: [...view.potion.slots], placed: {} }, gift: { objectId: view.gift.objectId, slots: [...view.gift.slots], placed: {} }, spoils: { objectId: view.spoils.objectId, slots: [...view.spoils.slots], placed: {} } };
    for (const k of CONTAINER_KINDS) {
      const prev = st.containers?.[k];
      if (!prev) continue;
      for (const [s, inst] of Object.entries(prev.placed)) {
        const slot = Number(s);
        if (next[k].slots[slot] === toObjType(inst.itemId)) next[k].placed[slot] = inst;
      }
    }
    st.containers = next;
    st.lastVisitAt = this.now();
  }
}
