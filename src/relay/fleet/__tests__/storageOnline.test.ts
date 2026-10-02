// Advanced management's storage trips (docs/relay/ADVANCED.md): banking and
// fetching on a bot's live session, compaction and the potion gather, against
// a fake game client that walks into the Vault and answers every INVSWAP.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containersFromView, planCompaction, planFetch, StorageService, StorageStore, type AccountStorageState, type CompactChar } from "../storage";
import { emptyVaultView, VAULT_PORTAL_TYPE, type VaultView } from "../vaultTrip";
import { InventoryTracker, type Instance } from "../inventoryTracker";
import { LoginGate } from "../loginGate";
import type { SweepDeps } from "../sweeps";
import type { BotAccount } from "../botPool";
import type { GameClient } from "../../client/gameClient";
import type { CharDetail } from "../../realm/api";
import { toObjType } from "../../trade/itemMap";

// The trips here never read the char list or the account snapshot over HTTP; a stray call must not reach Realm.
vi.mock("../../realm/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../realm/api")>()),
  getCharListDetail: vi.fn(async () => ({ ok: false, error: { kind: "network", detail: "test" } })),
  getAccountDump: vi.fn(async () => ({ ok: false, error: { kind: "network", detail: "test" } })),
}));

const PDEF = toObjType("pdef")!;
const PATK = toObjType("patk")!;
const RING = toObjType("ubatk")!;
const SOULBOUND = 999_999; // a type the pool does not trade

/** The account's containers, as the server holds them: every session of the account sees the same. */
class Chests {
  readonly vaultId = 501;
  readonly rackId = 502;
  readonly giftId = 503;
  readonly spoilsId = 504;
  rack: number[] = [];
  gift: number[] = [];
  spoils: number[] = [];
  constructor(public vault: number[]) {}
  byId(id: number): number[] | null {
    return id === this.vaultId ? this.vault : id === this.rackId ? this.rack : id === this.giftId ? this.gift : id === this.spoilsId ? this.spoils : null;
  }
  view(): VaultView {
    return { ...emptyVaultView(), vault: { objectId: this.vaultId, slots: [...this.vault] }, potion: { objectId: this.rackId, slots: [...this.rack] }, gift: { objectId: this.giftId, slots: [...this.gift] }, spoils: { objectId: this.spoilsId, slots: [...this.spoils] } };
  }
}

type Slot = { objectId: number; slotId: number; objectType: number };
/** A session in the game: the Nexus with a Vault Portal under its feet, the Vault behind it, every swap answered. */
class FakeSession extends EventEmitter {
  active = true;
  connected = true;
  isReady = true;
  objectId = 100;
  pos = { x: 10, y: 10 };
  mapName = "Nexus";
  arrived = true;
  charSeasonal: boolean | null = false;
  hasBackpack = false;
  lastCharList = null;
  token = "tok";
  proxy = null;
  pathLength = 0;
  world = { entities: new Map<number, { type: number; pos: { x: number; y: number } }>() };
  playerData: { name: string; inv: number[]; enchantments: Record<number, number[]>; tradeSlots: number; enchantmentsSeen: boolean };
  sent: string[] = [];
  /** Refuse the next swap (the server said no). */
  refuseNext = false;
  /** After each swap that went through, as the dispatcher's tick would read the inventory. */
  onSwap: (() => void) | null = null;
  constructor(readonly chests: Chests, readonly charId: number, inv: number[], tradeSlots = 8) {
    super();
    this.playerData = { name: "Bot", inv, enchantments: {}, tradeSlots, enchantmentsSeen: true };
    this.world.entities.set(7, { type: VAULT_PORTAL_TYPE, pos: { ...this.pos } });
  }
  inNexus(): boolean {
    return this.active && this.connected && this.arrived && this.mapName === "Nexus";
  }
  inVault(): boolean {
    return this.active && this.connected && this.arrived && this.mapName === "Vault";
  }
  escapeToNexus(): void {
    this.nexus();
  }
  nexus(): void {
    this.sent.push("ESCAPE");
    setTimeout(() => this.goTo("Nexus"), 2);
  }
  getTime(): number {
    return 0;
  }
  setPath(): void {}
  recentPackets() {
    return { recv: [], sent: [] };
  }
  stop(): void {
    this.active = false;
    this.emit("stopped");
  }
  send(type: string, f: { slotObject1?: Slot; slotObject2?: Slot }): void {
    this.sent.push(type);
    if (type === "USEPORTAL") {
      setTimeout(() => {
        this.goTo("Vault");
        const v = this.chests.view();
        this.emit("packet", { type: "VAULTINFO", last: true, vaultObjectId: v.vault.objectId, materialObjectId: -1, giftObjectId: v.gift.objectId, potionObjectId: v.potion.objectId, spoilsObjectId: v.spoils.objectId, vaultContents: v.vault.slots, materialContents: [], giftContents: v.gift.slots, potionContents: v.potion.slots, spoilsContents: v.spoils.slots, tail: Buffer.alloc(0) });
      }, 5);
    }
    if (type === "INVSWAP") setTimeout(() => this.swap(f.slotObject1!, f.slotObject2!), 2);
  }
  private goTo(map: string): void {
    this.mapName = map;
    this.arrived = false;
    this.world.entities.clear();
    if (map === "Nexus") this.world.entities.set(7, { type: VAULT_PORTAL_TYPE, pos: { ...this.pos } });
    const mi = { type: "MAPINFO", name: map };
    this.emit("packet", mi);
    this.emit("mapInfo", mi);
    this.arrived = true;
  }
  private swap(a: Slot, b: Slot): void {
    const of = (s: Slot) => (s.objectId === this.objectId ? this.playerData.inv : this.mapName === "Vault" ? this.chests.byId(s.objectId) : null);
    const A = of(a);
    const B = of(b);
    const ok = !this.refuseNext && !!A && !!B && A[a.slotId] === a.objectType && B[b.slotId] === b.objectType;
    this.refuseNext = false;
    if (ok) {
      [A![a.slotId], B![b.slotId]] = [B![b.slotId], A![a.slotId]];
      this.onSwap?.();
    }
    this.emit("packet", { type: "INVRESULT", unknownBool: ok, unknownByte: 0, fromSlot: a, toSlot: b, unknownInt1: 0, unknownInt2: 0 });
  }
}

const inv = (types: Record<number, number> = {}, size = 28): number[] => {
  const a = Array(size).fill(-1);
  for (const [s, t] of Object.entries(types)) a[Number(s)] = t;
  return a;
};
const char = (id: number, seasonal: boolean, over: Partial<CharDetail> = {}): CharDetail => ({ id, objectType: 782, level: 20, seasonal, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [], ...over });
const inst = (instanceId: string, itemId: string): Instance => ({ instanceId, itemId, enchantments: [], capturedAt: 1 });
const FAST = { settleMs: 5, swapPaceMs: 5, swapAckMs: 1_000, inWorldMs: 3_000, portalWaitMs: 1_000, vaultInfoMs: 1_000, vaultSettleMs: 5 };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(o: { vault: number[]; known?: boolean; chars?: CharDetail[] } = { vault: Array(8).fill(-1) }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-online-"));
  dirs.push(dir);
  const store = new StorageStore(path.join(dir, "storage.json"));
  const tracker = new InventoryTracker(path.join(dir, "inventory_state.json"));
  const acc = { alias: "A", guid: "a@x", botGuid: "bot-a", info: { guid: "a@x", server: "USSouth3" }, seasonal: false, seasonalOrDefault: false, communism: false, suspended: false, assignedRequestId: null, inUse: false, client: null } as unknown as BotAccount;
  const chests = new Chests(o.vault);
  const st = store.for(acc);
  st.loginCharId = 1;
  st.chars = o.chars ?? [char(1, false)];
  if (o.known !== false) {
    st.containers = containersFromView(chests.view(), null, 1);
    st.viewSeasonal = false;
  }
  // A clock that jumps half a minute per look, so every login's post-session grace is over by the next one.
  let t = 1_000_000;
  const now = () => (t += 30_000);
  const logs: string[] = [];
  const clients = new Map<string, GameClient>();
  const sessions: FakeSession[] = [];
  /** What each character holds, as the server keeps it between sessions. */
  const charInv = new Map<number, number[]>();
  const deps = {
    pool: {}, proxies: { release() {}, releaseProbe() {} }, gate: new LoginGate(now), buildVersion: "7", clients, log: (l: string) => logs.push(l),
    bringUp: async (_d: unknown, a: BotAccount, _s: string, opts?: { charId?: number }) => {
      const id = opts?.charId ?? 1;
      const c = new FakeSession(chests, id, charInv.get(id) ?? inv());
      charInv.set(id, c.playerData.inv);
      sessions.push(c);
      clients.set(a.guid, c as unknown as GameClient);
      return c as unknown as GameClient;
    },
  };
  const pool = { setSeasonal() {}, setPreferredChar() {}, every: () => [acc] };
  const sd = { deps, pool, tracker, settings: {} } as unknown as SweepDeps;
  const holds = new Set<string>();
  const svc = new StorageService({ sd, store, holds, now, tripTimeouts: FAST });
  /** The bot in game as the dispatcher has it: its live session, the tracker reading what it carries. */
  const live = (types: Record<number, number>, tradeSlots = 8) => {
    const c = new FakeSession(chests, 1, inv(types), tradeSlots);
    (acc as { client: unknown }).client = c;
    refresh(c);
    return c;
  };
  const refresh = (c: FakeSession) => {
    const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
    c.playerData.inv.forEach((type, i) => {
      if (i < 4 || i >= 4 + c.playerData.tradeSlots || type <= 0 || type === SOULBOUND) return;
      const itemId = type === PDEF ? "pdef" : type === PATK ? "patk" : type === RING ? "ubatk" : null;
      if (itemId) slots[i] = { itemId, enchantments: [] };
    });
    tracker.updateFromSlots(acc.botGuid, slots, c.playerData.tradeSlots);
  };
  const asClient = (c: FakeSession) => c as unknown as GameClient;
  return { store, tracker, acc, chests, st, svc, logs, live, refresh, asClient, charInv, sessions, holds, clients };
}

describe("bankOnline", () => {
  it("banks the haul on the live session, identities carried, and leaves the bot in the Vault to bank again where it stands", async () => {
    const { svc, live, tracker, acc, chests, st, refresh, asClient } = setup({ vault: Array(8).fill(-1) });
    const c = live({ 4: PDEF, 5: RING, 6: SOULBOUND });
    const before = tracker.instancesFor(acc.botGuid);
    const r = await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 2, why: "test" });
    expect(r).toEqual({ ok: true, moved: 3, left: 0 });
    expect(c.inVault()).toBe(true);
    expect(chests.vault.filter((t) => t > 0).sort()).toEqual([PDEF, RING, SOULBOUND].sort());
    // What went in keeps the tracked identity; the tracker no longer lists it on the character.
    const listed = Object.values(st.containers!.vault.instances).map((i) => i.instanceId).sort();
    expect(listed).toEqual([before[4].instanceId, before[5].instanceId].sort());
    expect(tracker.heldCount(acc.botGuid)).toBe(0);
    expect(acc.inUse).toBe(false);
    expect(svc.isTripping(acc.guid)).toBe(false);
    expect(svc.vaultRoom(acc)).toEqual({ free: 5, slots: 8 });
    // A new item comes in while it waits there: banked where it stands, no second walk through the portal.
    c.playerData.inv[4] = PATK;
    refresh(c);
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 2, why: "test" })).toMatchObject({ ok: true, moved: 1, left: 0 });
    expect(c.sent.filter((s) => s === "USEPORTAL")).toHaveLength(1);
    // Once it leaves the Vault the view it kept is gone: the next bank walks in again.
    c.escapeToNexus();
    await vi.waitFor(() => expect(c.inNexus()).toBe(true));
    c.playerData.inv[4] = PDEF;
    refresh(c);
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 2, why: "test" })).toMatchObject({ ok: true, moved: 1 });
    expect(c.sent.filter((s) => s === "USEPORTAL")).toHaveLength(2);
  });

  it("keeps the transit reserve free, leaves what is kept, and says the vault is full", async () => {
    const { svc, live, tracker, acc, chests, asClient } = setup({ vault: [RING, -1, -1, -1] });
    const c = live({ 4: PDEF, 5: PATK, 6: RING });
    const keepId = tracker.instancesFor(acc.botGuid)[6].instanceId;
    const r = await svc.bankOnline(acc, asClient(c), { keep: new Set([keepId]), reserveSlots: 2, why: "test" });
    // Three free, two kept free: one goes, the kept ring and one more stay.
    expect(r).toEqual({ ok: true, moved: 1, left: 2, vaultFull: true });
    expect(chests.vault.filter((t) => t === -1)).toHaveLength(2);
    expect(c.playerData.inv[6]).toBe(RING);
    // Down to the reserve already: no trip at all.
    const sent = c.sent.length;
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 2, why: "test" })).toEqual({ ok: true, moved: 0, left: 2, vaultFull: true });
    expect(c.sent.length).toBe(sent);
  });

  it("caps by the live vault when it was never seen", async () => {
    const { svc, live, acc, chests, asClient } = setup({ vault: [RING, -1, -1], known: false });
    const c = live({ 4: PDEF, 5: PATK });
    const r = await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 1, why: "test" });
    expect(r).toMatchObject({ ok: true, moved: 1, left: 1, vaultFull: true });
    expect(chests.vault.filter((t) => t === -1)).toHaveLength(1);
  });

  it("parks an empty bot in the Vault, once", async () => {
    const { svc, live, acc, asClient } = setup();
    const c = live({});
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, park: true, why: "linger" })).toEqual({ ok: true, moved: 0, left: 0 });
    expect(c.inVault()).toBe(true);
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, park: true, why: "linger" })).toEqual({ ok: true, moved: 0, left: 0 });
    expect(c.sent.filter((s) => s === "USEPORTAL")).toHaveLength(1);
    // Without `park` an empty bot goes nowhere.
    const d = live({});
    expect(await svc.bankOnline(acc, asClient(d), { keep: new Set(), reserveSlots: 0, why: "test" })).toEqual({ ok: true, moved: 0, left: 0 });
    expect(d.sent).toEqual([]);
  });

  it("refuses an account another job has, a trade, a second trip, and a session that is not the account's", async () => {
    const { svc, live, acc, asClient } = setup();
    const c = live({ 4: PDEF });
    acc.inUse = true;
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, why: "test" })).toMatchObject({ ok: false, busy: true, left: 1 });
    acc.inUse = false;
    acc.assignedRequestId = 7;
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, why: "test" })).toMatchObject({ ok: false, busy: true });
    acc.assignedRequestId = null;
    const first = svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, why: "test" });
    expect(acc.inUse).toBe(true);
    expect(await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, why: "test" })).toMatchObject({ ok: false, busy: true, error: expect.stringContaining("another job") });
    expect(await first).toMatchObject({ ok: true, moved: 1 });
    const stranger = new FakeSession(new Chests([]), 1, inv({ 4: PDEF }));
    expect(await svc.bankOnline(acc, asClient(stranger), { keep: new Set(), reserveSlots: 0, why: "test" })).toMatchObject({ ok: false, busy: true });
  });
});

describe("fetchOnline", () => {
  it("takes an item out of the vault under its listed identity, even when the dispatcher reads the inventory mid-trip", async () => {
    const { svc, live, tracker, acc, chests, st, refresh, asClient } = setup({ vault: [-1, PDEF, -1, -1] });
    st.containers!.vault.instances[1] = inst("v-pdef", "pdef");
    const c = live({ 4: RING });
    c.onSwap = () => refresh(c);
    const r = await svc.fetchOnline(acc, asClient(c), { instanceIds: ["v-pdef"], items: [] }, { seasonal: false, why: "test" });
    expect(r).toEqual({ ok: true });
    expect(Object.values(tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId)).toContain("v-pdef");
    expect(tracker.expected().get(acc.botGuid)).toBeUndefined();
    expect(st.containers!.vault.instances[1]).toBeUndefined();
    expect(chests.vault[1]).toBe(-1);
    expect(c.inVault()).toBe(true);
  });

  it("forgets the promise when the server refuses the swap", async () => {
    const { svc, live, tracker, acc, st, asClient } = setup({ vault: [PDEF, -1] });
    st.containers!.vault.instances[0] = inst("v-pdef", "pdef");
    const c = live({});
    c.refuseNext = true;
    const r = await svc.fetchOnline(acc, asClient(c), { instanceIds: ["v-pdef"], items: [] }, { seasonal: false, why: "test" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("refused") });
    expect(tracker.expected().get(acc.botGuid)).toBeUndefined();
    expect(st.containers!.vault.instances[0].instanceId).toBe("v-pdef");
  });

  it("swaps where it stands when a trip of this session left it in the Vault", async () => {
    const { svc, live, acc, st, asClient } = setup({ vault: [-1, -1, PATK, -1] });
    st.containers!.vault.instances[2] = inst("v-patk", "patk");
    const c = live({ 4: PDEF });
    await svc.bankOnline(acc, asClient(c), { keep: new Set(), reserveSlots: 0, why: "test" });
    expect(await svc.fetchOnline(acc, asClient(c), { instanceIds: [], items: [{ itemId: "patk", qty: 1 }] }, { seasonal: false, why: "test" })).toEqual({ ok: true });
    expect(c.sent.filter((s) => s === "USEPORTAL")).toHaveLength(1);
    expect(c.playerData.inv.slice(4, 12)).toContain(PATK);
  });

  it("refuses what only another character can reach, without a trip", async () => {
    const { svc, live, acc, st, asClient } = setup({ vault: [-1], chars: [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, RING] })] });
    st.charItems = { "2": { 4: inst("c-ring", "ubatk") } };
    const c = live({});
    const r = await svc.fetchOnline(acc, asClient(c), { instanceIds: ["c-ring"], items: [] }, { seasonal: false, why: "test" });
    expect(r).toMatchObject({ ok: false, permanent: true, needsLogin: true });
    expect(c.sent).toEqual([]);
  });
});

describe("planFetch for a live session", () => {
  const st = (): AccountStorageState => ({
    alias: "A", guid: "a@x", botGuid: "bot-a", lastVisitAt: 1, viewSeasonal: false, untracked: [], chars: [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, RING] })], charsAt: 1, loginCharId: 1,
    charItems: { "2": { 4: inst("c-ring", "ubatk") } }, charVisits: {}, moves: [], lastRun: null, lastError: null,
    containers: { vault: { objectId: 1, slots: [PDEF], instances: { 0: inst("v-pdef", "pdef") } }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [], instances: {} }, spoils: { objectId: 4, slots: [], instances: {} } },
  });
  it("never hands a container fetch to a porter, and sends another character's items to a login", () => {
    // The played character is full: the ordinary fetch has character 2 do the trip, the live session banks instead.
    const full: Record<number, Instance> = Object.fromEntries([4, 5, 6, 7, 8, 9, 10, 11].map((s) => [s, inst(`t${s}`, "patk")]));
    expect(planFetch(st(), { instanceIds: ["v-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked: full }).charId).toBe(2);
    expect(planFetch(st(), { instanceIds: ["v-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked: full, playedOnly: true })).toMatchObject({ ok: true, charId: null });
    expect(planFetch(st(), { instanceIds: ["c-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked: {}, playedOnly: true })).toMatchObject({ ok: false, needsLogin: true });
    expect(planFetch(st(), { instanceIds: ["v-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked: {}, playedOnly: true })).toMatchObject({ ok: false });
  });
});

describe("vaultRoom", () => {
  it("answers for each side's vault as last seen", () => {
    const { svc, acc, st } = setup({ vault: [RING, -1, -1] });
    st.otherSide = { seasonal: true, at: 1, containers: containersFromView({ ...emptyVaultView(), vault: { objectId: 9, slots: [-1, -1, -1, -1, PDEF] } }, null, 1) };
    expect(svc.vaultRoom(acc)).toEqual({ free: 2, slots: 3 });
    expect(svc.vaultRoom(acc, false)).toEqual({ free: 2, slots: 3 });
    expect(svc.vaultRoom(acc, true)).toEqual({ free: 4, slots: 5 });
    st.otherSide = null;
    expect(svc.vaultRoom(acc, true)).toBeNull();
  });
});

describe("planCompaction", () => {
  const thing = (slot: number, objectType: number, instanceId: string | null, itemId: string | null) => ({ slot, objectType, instanceId, itemId });
  const chars = (): CompactChar[] => [
    { id: 1, capacity: 8, things: [4, 5, 6, 7, 8, 9].map((s) => thing(s, PATK, `p${s}`, "patk")) },
    { id: 2, capacity: 8, things: [thing(4, PDEF, "e-pdef", "pdef"), thing(5, RING, "e-ring", "ubatk")] },
    { id: 3, capacity: 8, things: [thing(4, PDEF, "x1", "pdef"), thing(5, PDEF, "x2", "pdef"), thing(6, RING, "x3", "ubatk")] },
    { id: 4, capacity: 16, things: [thing(4, RING, "y1", "ubatk"), thing(5, RING, "y2", "ubatk"), thing(6, RING, "y3", "ubatk")] },
  ];
  it("empties the emptiest character: potions to their holder, the rest onto the fullest character that takes it all", () => {
    const p = planCompaction(chars(), { vaultFree: 8, reserved: new Set() });
    expect(p).toMatchObject({ ok: true, from: 2 });
    expect(p.things.map((t) => t.instanceId)).toEqual(["e-pdef", "e-ring"]);
    // The potion joins character 3's; the ring goes to character 1 (two free: the fullest that takes what is left).
    expect(p.to).toEqual([{ charId: 3, things: [0] }, { charId: 1, things: [1] }]);
  });
  it("spreads over the roomiest characters when none takes it all", () => {
    const cs = chars();
    cs[1].things = [4, 5, 6, 7, 8].map((s) => thing(s, RING, `e${s}`, "ubatk"));
    cs[2].things = [4, 5, 6, 7, 8, 9].map((s) => thing(s, PATK, `x${s}`, "patk"));
    cs[3] = { id: 4, capacity: 8, things: [4, 5, 6, 7, 8].map((s) => thing(s, PATK, `y${s}`, "patk")) };
    // Character 2 (5 items) goes: 3 free on character 4, then 2 on character 1 (character 3 has 2 too; 1 is lower).
    const p = planCompaction(cs, { vaultFree: 8, reserved: new Set() });
    expect(p).toMatchObject({ ok: true, from: 2 });
    expect(p.to).toEqual([{ charId: 4, things: [0, 1, 2] }, { charId: 1, things: [3, 4] }]);
  });
  it("does nothing while a character is empty, skips one holding something spoken for, and refuses without the room", () => {
    const cs = chars();
    expect(planCompaction([...cs, { id: 5, capacity: 8, things: [] }], { vaultFree: 8, reserved: new Set() })).toMatchObject({ ok: false, error: expect.stringContaining("#5 is empty") });
    expect(planCompaction(cs, { vaultFree: 8, reserved: new Set(["e-ring"]) })).toMatchObject({ ok: true, from: 3 });
    expect(planCompaction(cs, { vaultFree: 1, reserved: new Set() })).toMatchObject({ ok: false, from: 2, error: expect.stringContaining("vault") });
    const tight: CompactChar[] = [{ id: 1, capacity: 2, things: [thing(4, PATK, "a", "patk")] }, { id: 2, capacity: 2, things: [thing(4, PATK, "b", "patk"), thing(5, PATK, "c", "patk")] }];
    expect(planCompaction(tight, { vaultFree: 8, reserved: new Set() })).toMatchObject({ ok: false, from: 1, error: expect.stringContaining("0 free slot") });
  });
});

describe("compact", () => {
  it("empties a character through the vault, one login each, every identity carried to where it lands", async () => {
    const chars = [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, PDEF, RING, -1, -1, -1, -1, -1, -1] }), char(3, false, { equipment: [-1, -1, -1, -1, PDEF, PDEF, PATK, -1, -1, -1, -1, -1] })];
    const { svc, tracker, acc, chests, st, charInv, holds, clients, logs } = setup({ vault: Array(8).fill(-1), chars });
    // The played character carries four (four free); character 2 two, character 3 three (five free).
    charInv.set(1, inv({ 4: PATK, 5: PATK, 6: PATK, 7: PATK }));
    tracker.updateFromSlots(acc.botGuid, { 4: { itemId: "patk", enchantments: [] }, 5: { itemId: "patk", enchantments: [] }, 6: { itemId: "patk", enchantments: [] }, 7: { itemId: "patk", enchantments: [] } }, 8);
    charInv.set(2, inv({ 4: PDEF, 5: RING }));
    charInv.set(3, inv({ 4: PDEF, 5: PDEF, 6: PATK }));
    st.charItems = { "2": { 4: inst("e-pdef", "pdef"), 5: inst("e-ring", "ubatk") }, "3": { 4: inst("x1", "pdef"), 5: inst("x2", "pdef"), 6: inst("x3", "patk") } };
    const r = await svc.compact(acc, { reserveSlots: 8, why: "test" });
    expect(r).toEqual({ ok: true, moved: 2 });
    expect(logs.some((l) => l.includes("character #2 is empty"))).toBe(true);
    // Character 2 is empty, in its list and its slots.
    expect(st.charItems!["2"]).toBeUndefined();
    expect(st.chars!.find((c) => c.id === 2)!.equipment.slice(4).every((t) => t === -1)).toBe(true);
    expect(svc.charsFor(acc).find((c) => c.id === 2)!.held).toBe(0);
    // The potion joined character 3's under the identity it had; the ring landed on the played character, the tracker's now.
    expect(Object.values(st.charItems!["3"]).map((i) => i.instanceId).sort()).toEqual(["e-pdef", "x1", "x2", "x3"]);
    expect(Object.values(tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId)).toContain("e-ring");
    expect(charInv.get(1)!.slice(4, 12)).toContain(RING);
    // The vault is as it was; the account is given back and nobody is left logged in.
    expect(chests.vault.every((t) => t === -1)).toBe(true);
    expect(Object.keys(st.containers!.vault.instances)).toEqual([]);
    expect(holds.size).toBe(0);
    expect(clients.size).toBe(0);
    expect(svc.isTripping(acc.guid)).toBe(false);
  });

  it("refuses without a login to go on, without room, and while a character is empty", async () => {
    const chars = [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, PDEF] })];
    const { svc, acc, st, tracker, sessions } = setup({ vault: [-1], chars });
    // The played character is empty: nothing to do.
    expect(await svc.compact(acc, { reserveSlots: 8, why: "test" })).toMatchObject({ ok: false, skipped: expect.stringContaining("#1 is empty") });
    tracker.updateFromSlots(acc.botGuid, Object.fromEntries([4, 5, 6, 7, 8, 9, 10, 11].map((s) => [s, { itemId: "patk", enchantments: [] }])), 8);
    // Full played character, one item on character 2, nowhere to put it.
    expect(await svc.compact(acc, { reserveSlots: 8, why: "test" })).toMatchObject({ ok: false, skipped: expect.stringContaining("free slot") });
    st.loginCharId = null;
    expect(await svc.compact(acc, { reserveSlots: 8, why: "test" })).toMatchObject({ ok: false, skipped: expect.stringContaining("no login") });
    expect(sessions).toEqual([]);
  });
});

describe("gatherPotions", () => {
  it("banks the other characters' potions while the vault keeps its reserve, identities carried", async () => {
    const chars = [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, PDEF, RING, PATK, -1, -1, -1, -1, -1] })];
    const { svc, acc, chests, st, charInv } = setup({ vault: [-1, -1, -1, -1], chars });
    charInv.set(2, inv({ 4: PDEF, 5: RING, 6: PATK }));
    st.charItems = { "2": { 4: inst("g-pdef", "pdef"), 5: inst("g-ring", "ubatk"), 6: inst("g-patk", "patk") } };
    const r = await svc.gatherPotions(acc, { reserveSlots: 3, why: "test" });
    // Four free, three kept: one potion goes.
    expect(r).toEqual({ ok: true, moved: 1 });
    expect(chests.vault.filter((t) => t > 0)).toHaveLength(1);
    expect(Object.values(st.containers!.vault.instances).map((i) => i.instanceId)).toEqual(["g-pdef"]);
    expect(Object.values(st.charItems!["2"]).map((i) => i.instanceId).sort()).toEqual(["g-patk", "g-ring"]);
    // With room for more, the other potion follows and the ring stays.
    expect(await svc.gatherPotions(acc, { reserveSlots: 0, why: "test" })).toEqual({ ok: true, moved: 1 });
    expect(Object.values(st.charItems!["2"]).map((i) => i.instanceId)).toEqual(["g-ring"]);
    expect(await svc.gatherPotions(acc, { reserveSlots: 0, why: "test" })).toMatchObject({ ok: false, skipped: expect.stringContaining("no other character") });
  });

  it("visits at most `maxChars` characters in one run, and stops before the next one when asked", async () => {
    const chars = [char(1, false), char(2, false, { equipment: [-1, -1, -1, -1, PDEF, -1, -1, -1, -1, -1, -1, -1] }), char(3, false, { equipment: [-1, -1, -1, -1, PATK, -1, -1, -1, -1, -1, -1, -1] }), char(4, false, { equipment: [-1, -1, -1, -1, PDEF, -1, -1, -1, -1, -1, -1, -1] })];
    const { svc, acc, chests, st, charInv } = setup({ vault: [-1, -1, -1, -1, -1, -1, -1, -1], chars });
    charInv.set(2, inv({ 4: PDEF }));
    charInv.set(3, inv({ 4: PATK }));
    charInv.set(4, inv({ 4: PDEF }));
    st.charItems = { "2": { 4: inst("p2", "pdef") }, "3": { 4: inst("p3", "patk") }, "4": { 4: inst("p4", "pdef") } };
    // One character at most this run: the other two wait.
    expect(await svc.gatherPotions(acc, { reserveSlots: 0, why: "test", maxChars: 1 })).toEqual({ ok: true, moved: 1 });
    expect(chests.vault.filter((t) => t > 0)).toHaveLength(1);
    // A player's request in the meantime: the run ends after the character it is on.
    let asked = 0;
    expect(await svc.gatherPotions(acc, { reserveSlots: 0, why: "test", stop: () => ++asked > 0 })).toEqual({ ok: true, moved: 1 });
    expect(asked).toBe(1);
    expect(chests.vault.filter((t) => t > 0)).toHaveLength(2);
    // The next run takes the last one.
    expect(await svc.gatherPotions(acc, { reserveSlots: 0, why: "test" })).toEqual({ ok: true, moved: 1 });
    expect(Object.values(st.charItems ?? {}).flatMap((c) => Object.values(c))).toEqual([]);
  });
});
