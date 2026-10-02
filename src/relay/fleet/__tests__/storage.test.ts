// Account storage: the VAULTINFO merge, the move planner, the state file
// and the character picker. The trip itself is verified against the live
// game (docs/relay/STORAGE.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyVaultView, mergeVaultInfo } from "../vaultTrip";
import { applySnapshot, carryListIdentities, containersFromView, charRows, charsToVisit, otherSideChar, planFetch, planMove, planTuck, reconcileCharItems, reconcileTucked, recordCharVisit, roomMoves, storedInstances, storeFirst, StorageService, StorageStore, nameOfType, QUICK_SLOT_FIRST, type AccountStorageState, type Move, type PlanInput } from "../storage";
import { whereLabel } from "../../../lib/poolWire";
import type { AccountDump, DumpSlot } from "../../realm/api";
import { LoginGate } from "../loginGate";
import type { SweepDeps } from "../sweeps";
import type { BotAccount } from "../botPool";
import type { GameClient } from "../../client/gameClient";
import type { CharDetail } from "../../realm/api";
import { pickCharId } from "../../client/gameClient";
import { toObjType } from "../../trade/itemMap";
import type { Packet } from "../../protocol/packets";

const PDEF = toObjType("pdef")!;
const PATK = toObjType("patk")!;
const RING = toObjType("ubatk")!;
const SOULBOUND = 999_999; // a type the pool does not trade (the catalog now lists every tradeable item, so a real type would not do)

const packet = (p: Partial<Packet<"VAULTINFO">>): Packet<"VAULTINFO"> => ({
  type: "VAULTINFO", last: true, vaultObjectId: -1, materialObjectId: -1, giftObjectId: -1, potionObjectId: -1, spoilsObjectId: -1,
  vaultContents: [], materialContents: [], giftContents: [], potionContents: [], spoilsContents: [], tail: Buffer.alloc(0), ...p,
} as Packet<"VAULTINFO">);

describe("mergeVaultInfo", () => {
  it("concatenates each container's list across the sequence and keeps the object ids", () => {
    let v = emptyVaultView();
    v = mergeVaultInfo(v, packet({ last: false, vaultObjectId: 587, giftObjectId: 588, potionObjectId: 589, spoilsObjectId: 282, vaultContents: [1, 2], giftContents: [3], potionContents: [-1, 4], spoilsContents: [5] }));
    v = mergeVaultInfo(v, packet({ last: true, vaultObjectId: 587, giftObjectId: 588, potionObjectId: 589, spoilsObjectId: 282, vaultContents: [-1, 6], giftContents: [7, 8] }));
    expect(v.vault).toEqual({ objectId: 587, slots: [1, 2, -1, 6] });
    expect(v.gift).toEqual({ objectId: 588, slots: [3, 7, 8] });
    expect(v.potion).toEqual({ objectId: 589, slots: [-1, 4] });
    expect(v.spoils).toEqual({ objectId: 282, slots: [5] });
    expect(v.material.objectId).toBe(-1);
  });
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  const inv = Array(28).fill(-1);
  inv[4] = PDEF; inv[5] = RING; inv[12] = PATK;
  return {
    playerObjectId: 585, inv, tradeSlots: 16,
    containers: { vault: { objectId: 587, slots: [RING, -1, -1] }, rack: { objectId: 589, slots: [-1, PDEF] }, gift: { objectId: 588, slots: [SOULBOUND, PATK] }, spoils: { objectId: 282, slots: [RING] } },
    tracked: { 4: { instanceId: "i-pdef", itemId: "pdef", enchantments: [], capturedAt: 1 }, 5: { instanceId: "i-ring", itemId: "ubatk", enchantments: [], capturedAt: 1 }, 12: { instanceId: "i-patk", itemId: "patk", enchantments: [], capturedAt: 1 } },
    ...over,
  };
}
const move = (m: Partial<Move> & { kind: Move["kind"]; itemId: string }): Move => ({ id: "m", queuedAt: 0, objectType: toObjType(m.itemId)!, name: m.itemId, ...m });

describe("planMove", () => {
  it("banks from the tracked slot into the vault's first free slot", () => {
    const p = planMove(move({ kind: "bank", itemId: "ubatk", instanceId: "i-ring" }), input());
    expect(p).toMatchObject({ ok: true, container: "vault", from: { objectId: 585, slotId: 5, objectType: RING }, to: { objectId: 587, slotId: 1, objectType: -1 } });
  });
  it("finds the item elsewhere when the tracked slot moved, and refuses when it is gone", () => {
    const st = input();
    st.inv[5] = -1; st.inv[9] = RING;
    expect(planMove(move({ kind: "bank", itemId: "ubatk", instanceId: "i-ring" }), st)).toMatchObject({ ok: true, from: { slotId: 9 } });
    st.inv[9] = -1;
    expect(planMove(move({ kind: "bank", itemId: "ubatk", instanceId: "i-ring" }), st)).toMatchObject({ ok: false, error: expect.stringContaining("not on the character") });
  });
  it("refuses a full container, a non-potion for the rack, and a container the vault never announced", () => {
    const st = input();
    st.containers.vault.slots = [RING, PDEF, PATK];
    expect(planMove(move({ kind: "bank", itemId: "pdef", instanceId: "i-pdef" }), st)).toMatchObject({ ok: false, error: expect.stringContaining("full") });
    expect(planMove(move({ kind: "rackIn", itemId: "ubatk", instanceId: "i-ring" }), input())).toMatchObject({ ok: false, error: expect.stringContaining("only potions") });
    expect(planMove(move({ kind: "rackIn", itemId: "pdef", instanceId: "i-pdef" }), input())).toMatchObject({ ok: true, container: "rack", to: { objectId: 589, slotId: 0 } });
    const none = input(); none.containers.spoils.objectId = -1;
    expect(planMove(move({ kind: "spoilsOut", itemId: "ubatk", slot: 0 }), none)).toMatchObject({ ok: false, error: expect.stringContaining("not announced") });
  });
  it("takes out of a container into the first free trade slot, within the character's slot count", () => {
    const st = input();
    expect(planMove(move({ kind: "unbank", itemId: "ubatk", slot: 0 }), st)).toMatchObject({ ok: true, from: { objectId: 587, slotId: 0, objectType: RING }, to: { objectId: 585, slotId: 6, objectType: -1 } });
    // A 24-slot character with only slots 20-27 free lands it there; a 16-slot one has no room.
    const wide = input({ tradeSlots: 24 });
    for (let i = 4; i < 20; i++) wide.inv[i] = PDEF;
    expect(planMove(move({ kind: "rackOut", itemId: "pdef", slot: 1 }), wide)).toMatchObject({ ok: true, to: { slotId: 20 } });
    const narrow = input({ tradeSlots: 16 });
    for (let i = 4; i < 20; i++) narrow.inv[i] = PDEF;
    expect(planMove(move({ kind: "rackOut", itemId: "pdef", slot: 1 }), narrow)).toMatchObject({ ok: false, error: expect.stringContaining("no free slot") });
  });
  it("banks an untracked item by its character slot", () => {
    const st = input();
    st.inv[10] = SOULBOUND;
    const m: Move = { id: "u", kind: "bank", itemId: null, objectType: SOULBOUND, name: "#2730", slot: 10, queuedAt: 0 };
    expect(planMove(m, st)).toMatchObject({ ok: true, from: { slotId: 10, objectType: SOULBOUND }, to: { objectId: 587, slotId: 1 } });
    st.inv[10] = -1;
    expect(planMove(m, st)).toMatchObject({ ok: false, error: expect.stringContaining("not on the character") });
  });
  it("checks the container slot still holds the item, and only tradeable items leave the gift and spoils chests", () => {
    expect(planMove(move({ kind: "unbank", itemId: "pdef", slot: 0 }), input())).toMatchObject({ ok: false, error: expect.stringContaining("no longer holds") });
    expect(planMove(move({ kind: "giftOut", itemId: "patk", slot: 1 }), input())).toMatchObject({ ok: true, from: { objectId: 588, slotId: 1 } });
    expect(planMove(move({ kind: "giftOut", itemId: "ubatk", slot: 0 }), input())).toMatchObject({ ok: false });
    expect(nameOfType(SOULBOUND).tradeable).toBe(false);
    expect(nameOfType(PATK)).toMatchObject({ itemId: "patk", name: "Potion of Attack", tradeable: true });
  });
});

describe("the gift and spoils chests are lists that close up", () => {
  const inst = (id: string, itemId: string) => ({ instanceId: id, itemId, enchantments: [], capturedAt: 1 });
  it("finds a taken-out item lower in the list when an item before it left, and anywhere else as a last resort", () => {
    const st = input();
    // Read as [PATK, RING, PDEF, RING]; the PATK left since, so everything moved down one slot.
    st.containers.spoils.slots = [RING, PDEF, RING];
    expect(planMove(move({ kind: "spoilsOut", itemId: "pdef", slot: 2 }), st)).toMatchObject({ ok: true, from: { objectId: 282, slotId: 1 } });
    expect(planMove(move({ kind: "spoilsOut", itemId: "ubatk", slot: 3 }), st)).toMatchObject({ ok: true, from: { slotId: 2 } });
    st.containers.spoils.slots = [PDEF, RING];
    expect(planMove(move({ kind: "spoilsOut", itemId: "ubatk", slot: 0 }), st)).toMatchObject({ ok: true, from: { slotId: 1 } });
    expect(planMove(move({ kind: "spoilsOut", itemId: "patk", slot: 0 }), st)).toMatchObject({ ok: false, error: expect.stringContaining("no longer holds") });
    // The vault is a grid: a slot that changed is not looked for elsewhere.
    expect(planMove(move({ kind: "unbank", itemId: "ubatk", slot: 1 }), input())).toMatchObject({ ok: false });
  });
  it("carries identities onto the closed-up list in order, skipping what left", () => {
    const prev = { 0: inst("a", "patk"), 1: inst("b", "ubatk"), 2: inst("c", "pdef"), 3: inst("d", "ubatk") };
    expect(carryListIdentities(prev, [RING, PDEF, RING])).toEqual({ 0: prev[1], 1: prev[2], 2: prev[3] });
    expect(carryListIdentities(prev, [PATK, PDEF, RING, PDEF])).toEqual({ 0: prev[0], 1: prev[2], 2: prev[3] });
  });
  it("a new look at the Vault keeps the spoils items' ids after one before them left, and the vault's by slot", () => {
    const view = { ...emptyVaultView(), vault: { objectId: 1, slots: [-1, RING] }, gift: { objectId: 3, slots: [PDEF] }, spoils: { objectId: 4, slots: [RING, PDEF] } };
    const prev = {
      vault: { objectId: 1, slots: [RING, RING], instances: { 0: inst("v0", "ubatk"), 1: inst("v1", "ubatk") } },
      rack: { objectId: 2, slots: [], instances: {} },
      gift: { objectId: 3, slots: [PATK, PDEF], instances: { 0: inst("g0", "patk"), 1: inst("g1", "pdef") } },
      spoils: { objectId: 4, slots: [PATK, RING, PDEF], instances: { 0: inst("s0", "patk"), 1: inst("s1", "ubatk"), 2: inst("s2", "pdef") } },
    };
    const next = containersFromView(view, prev, 2);
    expect(next.spoils.instances).toEqual({ 0: prev.spoils.instances[1], 1: prev.spoils.instances[2] });
    expect(next.gift.instances).toEqual({ 0: prev.gift.instances[1] });
    expect(next.vault.instances).toEqual({ 1: prev.vault.instances[1] });
  });
});

describe("StorageStore", () => {
  it("round-trips an account's containers and queued moves through the state file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
    const acc = { alias: "A", guid: "a@x", botGuid: "bot-a" } as never;
    const store = StorageStore.at(dir);
    const st = store.for(acc);
    st.containers = { vault: { objectId: 1, slots: [RING], instances: { 0: { instanceId: "i", itemId: "ubatk", enchantments: [], capturedAt: 1 } } }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [], instances: {} }, spoils: { objectId: 4, slots: [], instances: {} } };
    st.moves.push(move({ kind: "unbank", itemId: "ubatk", slot: 0 }));
    store.save();
    const again = StorageStore.at(dir).for(acc);
    expect(again.containers?.vault).toEqual(st.containers?.vault);
    expect(again.moves).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("pickCharId", () => {
  it("uses the preferred character while the account still has it, else the first listed", () => {
    expect(pickCharId(373, [26, 373, 786])).toBe(373);
    expect(pickCharId(999, [26, 373])).toBe(26);
    expect(pickCharId(null, [26, 373])).toBe(26);
  });
});

// --- the account's storage as pool stock, and fetching it for a withdraw ------------------

const inst = (id: string, itemId: string, enchantments: number[] = []) => ({ instanceId: id, itemId, enchantments, capturedAt: 1 });
const char = (id: number, seasonal: boolean, over: Partial<CharDetail> = {}): CharDetail => ({ id, objectType: 782, level: 20, seasonal, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [], ...over });
function state(over: Partial<AccountStorageState> = {}): AccountStorageState {
  return {
    alias: "A", guid: "a@x", botGuid: "bot-a", lastVisitAt: 1, viewSeasonal: false, untracked: [],
    containers: {
      vault: { objectId: 1, slots: [RING, PDEF, -1], instances: { 0: inst("v-ring", "ubatk", [283]), 1: inst("v-pdef", "pdef") } },
      rack: { objectId: 2, slots: [PATK], instances: { 0: inst("r-patk", "patk") } },
      gift: { objectId: 3, slots: [SOULBOUND, PATK], instances: { 1: inst("g-patk", "patk") } },
      spoils: { objectId: 4, slots: [RING], instances: { 0: inst("s-ring", "ubatk") } },
    },
    chars: [char(1, false), char(2, true)], charsAt: 1, loginCharId: 1,
    charItems: { "2": { 4: inst("c2-pdef", "pdef") } },
    moves: [], lastRun: null, lastError: null, ...over,
  };
}

describe("storedInstances", () => {
  it("lists every tradeable item in the containers and on the other characters, with the halves that can reach it", () => {
    const out = storedInstances(state(), 1, false);
    const by = Object.fromEntries(out.map((s) => [s.instanceId, s]));
    // The vault and the rack are the side's that read them (non-seasonal here): one vault, rack and gift chest per side.
    expect(by["v-ring"]).toMatchObject({ itemId: "ubatk", enchantments: [283], where: { kind: "vault", slot: 0, seasonal: false }, pools: { seasonal: false, nonseasonal: true } });
    expect(by["r-patk"]).toMatchObject({ where: { kind: "rack", slot: 0, seasonal: false }, pools: { seasonal: false, nonseasonal: true } });
    // The gift chest: the side that read it (non-seasonal here); the spoils chest: non-seasonal only.
    expect(by["g-patk"]).toMatchObject({ where: { kind: "gift", slot: 1 }, pools: { seasonal: false, nonseasonal: true } });
    expect(by["s-ring"]).toMatchObject({ where: { kind: "spoils", slot: 0 }, pools: { seasonal: false, nonseasonal: true } });
    // The seasonal character's own items: the seasonal half; the played character's are the tracker's, not here.
    expect(by["c2-pdef"]).toMatchObject({ where: { kind: "char", charId: 2, slot: 4, className: "Wizard", level: 20, seasonal: true }, pools: { seasonal: true, nonseasonal: false } });
    expect(out).toHaveLength(6);
  });
  it("lists the other side's containers in that side's pool, under that side's name", () => {
    const st = state({ otherSide: { seasonal: true, at: 2, containers: { vault: { objectId: 9, slots: [PDEF], instances: { 0: inst("sv-pdef", "pdef") } }, rack: { objectId: 10, slots: [], instances: {} }, gift: { objectId: 11, slots: [PATK], instances: { 0: inst("sg-patk", "patk") } }, spoils: { objectId: 12, slots: [], instances: {} } } } });
    const out = storedInstances(st, 1, false);
    const by = Object.fromEntries(out.map((s) => [s.instanceId, s]));
    expect(by["sv-pdef"]).toMatchObject({ where: { kind: "vault", slot: 0, seasonal: true }, pools: { seasonal: true, nonseasonal: false } });
    expect(by["sg-patk"]).toMatchObject({ where: { kind: "gift", slot: 0, seasonal: true }, pools: { seasonal: true, nonseasonal: false } });
    // No living seasonal character: the seasonal side's containers serve nobody.
    expect(storedInstances(state({ otherSide: st.otherSide, chars: [char(1, false), char(2, true, { dead: true })], charItems: {} }), 1, false).find((s) => s.instanceId === "sv-pdef")!.pools).toEqual({ seasonal: false, nonseasonal: false });
    expect(whereLabel(by["sv-pdef"].where)).toBe("seasonal vault chest");
    expect(whereLabel(by["v-ring"].where)).toBe("non-seasonal vault chest");
    // A stale other-side read of the played side's own side is ignored.
    expect(storedInstances(state({ otherSide: { ...st.otherSide!, seasonal: false } }), 1, false).find((s) => s.instanceId === "sv-pdef")).toBeUndefined();
  });
  it("names a character of the other side for a read to look at that side's containers", () => {
    expect(otherSideChar(state(), 1, false)?.id).toBe(2);
    expect(otherSideChar(state(), 1, true)).toBeNull();
    expect(otherSideChar(state(), 1, null)).toBeNull();
    expect(otherSideChar(state({ chars: [char(1, false), char(2, true, { dead: true }), char(3, true), char(4, true)] }), 1, false, [char(4, true)])?.id).toBe(4);
  });
  it("lists every living character with its side and trade slots, the played one first", () => {
    const st = state({ chars: [char(2, true, { equipment: [1, 2, 3, 4, PDEF, -1, -1, -1, -1, -1, -1, -1], backpackSlots: 8 }), char(1, false), char(3, false, { dead: true })], maxNumChars: 5 });
    expect(charRows(st, { held: 3, capacity: 16 })).toEqual([
      { id: 1, className: "Wizard", level: 20, seasonal: false, login: true, held: 3, capacity: 16 },
      { id: 2, className: "Wizard", level: 20, seasonal: true, login: false, held: 1, capacity: 16 },
    ]);
  });
  it("offers a vault item to one side only when the account has no living character of the other", () => {
    const st = state({ chars: [char(1, false), char(2, true, { dead: true })], charItems: {} });
    const out = storedInstances(st, 1, false);
    expect(out.find((s) => s.instanceId === "v-ring")!.pools).toEqual({ seasonal: false, nonseasonal: true });
    expect(out.find((s) => s.instanceId === "c2-pdef")).toBeUndefined();
    // Without a char list (and no login yet) the account's own flag stands in.
    const bare = storedInstances(state({ chars: null, charItems: {}, viewSeasonal: null }), null, true);
    expect(bare.find((s) => s.instanceId === "v-ring")!.pools).toEqual({ seasonal: true, nonseasonal: false });
    expect(bare.find((s) => s.instanceId === "s-ring")).toBeUndefined();
  });
  it("drops a listed identity whose slot no longer holds that item", () => {
    const st = state();
    st.containers!.vault.slots[0] = PDEF;
    expect(storedInstances(st, 1, false).map((s) => s.instanceId)).not.toContain("v-ring");
  });
});

describe("reconcileCharItems", () => {
  it("gives the other characters' tradeable trade-slot items identities that survive a refresh, and drops the played one", () => {
    const st = state({ charItems: {} });
    st.chars = [char(1, false, { equipment: [RING, -1, -1, -1, PDEF, -1, -1, -1, -1, -1, -1, -1] }), char(2, true, { equipment: [-1, -1, -1, -1, PATK, SOULBOUND, RING, -1, -1, -1, -1, -1] })];
    reconcileCharItems(st, 1, 1000);
    expect(Object.keys(st.charItems!)).toEqual(["2"]);
    const first = st.charItems!["2"];
    expect(Object.keys(first).map(Number)).toEqual([4, 6]);
    expect(first[4].itemId).toBe("patk");
    // The same list again keeps the ids; a changed slot gets a new one; a dead character is dropped.
    reconcileCharItems(st, 1, 2000);
    expect(st.charItems!["2"][4].instanceId).toBe(first[4].instanceId);
    st.chars![1].equipment[4] = PDEF;
    reconcileCharItems(st, 1, 3000);
    expect(st.charItems!["2"][4].instanceId).not.toBe(first[4].instanceId);
    expect(st.charItems!["2"][6].instanceId).toBe(first[6].instanceId);
    st.chars![1].dead = true;
    reconcileCharItems(st, 1, 4000);
    expect(st.charItems).toEqual({});
  });
});

describe("planFetch", () => {
  const tracked = { 4: inst("t-ring", "ubatk") };
  it("turns named container items into take-out moves that carry the listed identity", () => {
    const p = planFetch(state(), { instanceIds: ["v-ring", "r-patk", "t-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked });
    expect(p.ok).toBe(true);
    expect(p.charId).toBeNull();
    expect(p.moves.map((m) => [m.kind, m.slot, m.instanceId, m.itemId])).toEqual([["unbank", 0, "v-ring", "ubatk"], ["rackOut", 0, "r-patk", "patk"]]);
  });
  it("logs in as the character that has a named item, and refuses items spread over two characters", () => {
    const p = planFetch(state(), { instanceIds: ["c2-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked });
    expect(p).toMatchObject({ ok: true, charId: 2 });
    expect(p.moves).toEqual([]);
    // The non-seasonal vault is out of a seasonal character's reach.
    expect(planFetch(state(), { instanceIds: ["c2-pdef", "v-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked })).toMatchObject({ ok: false, error: expect.stringContaining("non-seasonal vault chest") });
    expect(planFetch(state(), { instanceIds: ["c2-pdef", "t-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked })).toMatchObject({ ok: false, error: expect.stringContaining("two different characters") });
  });
  it("fills a count of a type from the containers, the rack first, and never from another character", () => {
    const p = planFetch(state(), { instanceIds: [], items: [{ itemId: "patk", qty: 2 }, { itemId: "pdef", qty: 1 }] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked });
    expect(p.ok).toBe(true);
    expect(p.moves.map((m) => [m.kind, m.instanceId])).toEqual([["rackOut", "r-patk"], ["giftOut", "g-patk"], ["unbank", "v-pdef"]]);
    expect(planFetch(state(), { instanceIds: [], items: [{ itemId: "pdef", qty: 2 }] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked })).toMatchObject({ ok: false, error: expect.stringContaining("only 1 of 2") });
  });
  it("refuses what the wanted half cannot reach, and picks a character of that side when the played one is of the other", () => {
    // The spoils chest is non-seasonal only.
    expect(planFetch(state(), { instanceIds: ["s-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked })).toMatchObject({ ok: false });
    // A seasonal withdraw for an item in the non-seasonal vault: no seasonal character can reach it.
    expect(planFetch(state(), { instanceIds: ["v-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked })).toMatchObject({ ok: false, error: expect.stringContaining("no seasonal character can reach") });
  });
  it("fetches from the seasonal vault by logging in as the seasonal character", () => {
    const st = state({ otherSide: { seasonal: true, at: 2, containers: { vault: { objectId: 9, slots: [PDEF, RING], instances: { 0: inst("sv-pdef", "pdef"), 1: inst("sv-ring", "ubatk", [283]) } }, rack: { objectId: 10, slots: [PATK], instances: { 0: inst("sr-patk", "patk") } }, gift: { objectId: 11, slots: [], instances: {} }, spoils: { objectId: 12, slots: [], instances: {} } } } });
    const p = planFetch(st, { instanceIds: ["sv-ring", "c2-pdef"], items: [{ itemId: "patk", qty: 1 }] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked });
    expect(p).toMatchObject({ ok: true, charId: 2 });
    expect(p.moves.map((m) => [m.kind, m.slot, m.instanceId])).toEqual([["unbank", 1, "sv-ring"], ["rackOut", 0, "sr-patk"]]);
    // The non-seasonal half cannot have them.
    expect(planFetch(st, { instanceIds: ["sv-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked })).toMatchObject({ ok: false, error: expect.stringContaining("seasonal vault chest") });
  });
});

describe("roomMoves", () => {
  it("banks just enough of what may go to make room for the inbound moves", () => {
    const inv = Array(28).fill(-1);
    inv[4] = RING; inv[5] = PDEF; inv[6] = PATK; inv[7] = RING;
    const bankable = [inst("b1", "pdef"), inst("b2", "patk"), inst("b3", "ubatk")];
    // 8 slots, 4 used: 4 free. 6 inbound needs 2 banked.
    const moves = roomMoves(inv, 8, 6, bankable, 5);
    expect(moves.map((m) => [m.kind, m.instanceId])).toEqual([["bank", "b1"], ["bank", "b2"]]);
    expect(roomMoves(inv, 8, 3, bankable, 5)).toEqual([]);
    expect(roomMoves(inv, 16, 12, bankable, 5)).toEqual([]);
  });
});

describe("StorageStore migration", () => {
  it("gives every tradeable container slot of an older file an identity on load, keeping what the node placed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-"));
    const file = path.join(dir, "storage_state.json");
    const old = {
      accounts: {
        "bot-a": {
          alias: "A", guid: "a@x", botGuid: "bot-a", lastVisitAt: 1, chars: null, charsAt: null, moves: [], lastRun: null, lastError: null,
          containers: {
            vault: { objectId: 1, slots: [RING, PDEF, SOULBOUND, -1], placed: { 0: { instanceId: "kept", itemId: "ubatk", enchantments: [283], capturedAt: 1 } } },
            rack: { objectId: 2, slots: [PATK], placed: {} }, gift: { objectId: 3, slots: [], placed: {} }, spoils: { objectId: 4, slots: [], placed: {} },
          },
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(old));
    const st = new StorageStore(file).get("bot-a")!;
    const vault = st.containers!.vault as { instances: Record<number, { instanceId: string; itemId: string }>; placed?: unknown };
    expect(vault.placed).toBeUndefined();
    expect(vault.instances[0]).toMatchObject({ instanceId: "kept", enchantments: [283] });
    expect(vault.instances[1]).toMatchObject({ itemId: "pdef" });
    expect(vault.instances[2]).toBeUndefined(); // not an item the pool trades
    expect(vault.instances[3]).toBeUndefined();
    expect(st.containers!.rack.instances[0]).toMatchObject({ itemId: "patk" });
    expect(storedInstances(st, null, true).map((s) => s.where)).toEqual([{ kind: "vault", slot: 0 }, { kind: "vault", slot: 1 }, { kind: "rack", slot: 0 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("charsToVisit", () => {
  it("names the living characters other than the played one that carry something tradeable, never visited first", () => {
    const st = state({ charVisits: { "3": { at: 500, capacity: 8 } } });
    st.chars = [
      char(1, false, { equipment: [RING, -1, -1, -1, PDEF] }), // the played one
      char(2, true, { equipment: [-1, -1, -1, -1, -1, PATK] }),
      char(3, false, { equipment: [-1, -1, -1, -1, RING] }), // looked at before: after the never-visited
      char(4, false, { equipment: [RING, PDEF, -1, -1, -1, -1] }), // equipment slots only
      char(5, false, { equipment: [-1, -1, -1, -1, SOULBOUND] }), // nothing the pool trades
      char(6, true, { equipment: [-1, -1, -1, -1, PATK], dead: true }),
    ];
    expect(charsToVisit(st, 1).map((c) => c.id)).toEqual([2, 3]);
    expect(charsToVisit(st, 1, 1).map((c) => c.id)).toEqual([2]);
    expect(charsToVisit(st, null).map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

describe("recordCharVisit", () => {
  it("files the character's tradeable items with their enchantments, keeps ids while a slot's type holds, and survives a reconcile", () => {
    const st = state();
    st.chars = [char(1, false), char(2, true, { equipment: [-1, -1, -1, -1, PDEF, RING, SOULBOUND, -1, -1, -1, -1, -1] })];
    reconcileCharItems(st, 1, 1000);
    const before = st.charItems!["2"][4].instanceId;
    const r = recordCharVisit(st, 2, { slots: { 3: { itemId: "ubatk", enchantments: [] }, 4: { itemId: "pdef", enchantments: [7] }, 5: { itemId: "ubatk", enchantments: [] } }, capacity: 16 }, 5000);
    expect(r).toEqual({ items: 2, enchanted: 1 });
    expect(st.charItems!["2"][4]).toMatchObject({ instanceId: before, itemId: "pdef", enchantments: [7], capturedAt: 5 });
    expect(st.charItems!["2"][5].itemId).toBe("ubatk");
    expect(st.charItems!["2"][3]).toBeUndefined(); // an equipment slot is not a trade slot
    expect(st.charVisits).toEqual({ "2": { at: 5000, capacity: 16 } });
    // The next ordinary login reconciles against char/list, which names the same types: ids and enchantments stay.
    reconcileCharItems(st, 1, 6000);
    expect(st.charItems!["2"][4]).toMatchObject({ instanceId: before, enchantments: [7] });
    // A character emptied since drops out.
    recordCharVisit(st, 2, { slots: {}, capacity: 8 }, 7000);
    expect(st.charItems!["2"]).toBeUndefined();
    expect(st.charVisits!["2"]).toEqual({ at: 7000, capacity: 8 });
  });
});

describe("StorageService.visit", () => {
  it("logs in as each character worth a look, files what the session shows, and takes the account down between logins", async () => {
    const file = path.join(os.tmpdir(), `storage-visit-${process.pid}-${Date.now()}.json`);
    const store = new StorageStore(file);
    const acc = { alias: "A", guid: "a@x", botGuid: "bot-a", info: { guid: "a@x", server: "USSouth3" }, seasonal: false, seasonalOrDefault: false, suspended: false, assignedRequestId: null, inUse: false, client: null } as unknown as BotAccount;
    const st = store.for(acc);
    st.loginCharId = 1;
    st.chars = [char(1, false, { equipment: [-1, -1, -1, -1, PATK] }), char(2, true, { equipment: [-1, -1, -1, -1, PDEF, RING] }), char(3, false, { equipment: [-1, -1, -1, -1, RING] })];
    reconcileCharItems(st, 1, 1000);
    const before = st.charItems!["2"][4].instanceId;
    // A clock that jumps half a minute per look, so the gate's post-session grace is over by the next login.
    let t = 1_000_000;
    const now = () => (t += 30_000);
    const clients = new Map<string, GameClient>();
    const asked: number[] = [];
    const logs: string[] = [];
    const inv = (types: Record<number, number>) => {
      const a = Array(28).fill(-1);
      for (const [s, v] of Object.entries(types)) a[Number(s)] = v;
      return a;
    };
    const fake = (charId: number, types: Record<number, number>, ench: Record<number, number[]>) =>
      ({ active: true, charId, lastCharList: null, objectId: 5, hasBackpack: true, playerData: { name: "Ign", inv: inv(types), enchantments: ench, tradeSlots: 16 }, stop(this: { active: boolean }) { this.active = false; }, on() {} }) as unknown as GameClient;
    const deps = {
      pool: {}, proxies: { release() {}, releaseProbe() {} }, gate: new LoginGate(now), buildVersion: "7", clients, log: (l: string) => logs.push(l),
      bringUp: async (_d: unknown, a: BotAccount, _s: string, opts?: { charId?: number }) => {
        asked.push(opts?.charId ?? -1);
        // Character 3 is gone by now: the game loads the first one instead, which is not what was asked for.
        const c = opts?.charId === 2 ? fake(2, { 4: PDEF, 5: RING }, { 4: [7] }) : fake(1, { 4: PATK }, {});
        clients.set(a.guid, c);
        return c;
      },
    };
    const sd = { deps, pool: {}, tracker: {}, settings: {} } as unknown as SweepDeps;
    const holds = new Set<string>();
    const svc = new StorageService({ sd, store, holds, now, visitTimeouts: { inWorldMs: 200, settleMs: 5, stableForMs: 5, stableMaxMs: 100 } });
    acc.inUse = true;
    expect(await svc.visit(acc, "test")).toBe("busy");
    acc.inUse = false;
    const r = await svc.visit(acc, "test");
    expect(asked).toEqual([2, 3]);
    expect(r).toEqual({ total: 2, visited: 1, failed: 1, stopped: null });
    expect(st.charItems!["2"][4]).toMatchObject({ instanceId: before, itemId: "pdef", enchantments: [7] });
    expect(st.charItems!["2"][5].itemId).toBe("ubatk");
    expect(st.charVisits!["2"]).toMatchObject({ capacity: 16 });
    expect(st.charVisits!["3"]).toBeUndefined();
    expect(st.loginCharId).toBe(1); // the tracker still describes the played character
    expect(clients.size).toBe(0); // every look was taken down
    expect(holds.size).toBe(0); // and the account given back
    expect(logs.some((l) => l.includes("loaded character #1 instead"))).toBe(true);
    store.save();
    fs.rmSync(file, { force: true });
  });
});

describe("applySnapshot", () => {
  const slot = (type: number, enchantments: number[] | null = null, copyId: string | null = null): DumpSlot => ({ type, copyId, enchantments });
  const dump = (): AccountDump => ({
    nextCharId: 4, maxNumChars: 3, name: null, records: 3, sections: ["Char/UniqueItemInfo", "Account/Vault"],
    chars: [
      { id: 1, objectType: 782, level: 20, seasonal: false, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [RING, -1, -1, -1, PDEF, -1, -1, -1, -1, -1, -1, -1], slots: [slot(RING, [7]), slot(-1), slot(-1), slot(-1), slot(PDEF, [9]), ...Array(7).fill(slot(-1))] },
      { id: 2, objectType: 804, level: 1, seasonal: true, dead: false, backpackSlots: 8, hasBackpack: true, quickslots: [], equipment: [-1, -1, -1, -1, PATK, RING, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1], slots: [slot(-1), slot(-1), slot(-1), slot(-1), slot(PATK), slot(RING, [7, 8], "c-2"), ...Array(14).fill(slot(-1))] },
      { id: 3, objectType: 800, level: 1, seasonal: true, dead: true, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [], slots: [] },
    ],
    vault: [[slot(RING, [11]), slot(PDEF), ...Array(6).fill(slot(-1))], [slot(PATK, [12]), ...Array(7).fill(slot(-1))]],
    materialStorage: [], gifts: [slot(PDEF, [13])], temporaryGifts: [], potions: [slot(PDEF, [14]), slot(-1)],
  });
  const state = (): AccountStorageState => ({
    alias: "a", guid: "g", botGuid: "b", lastVisitAt: 1, viewSeasonal: false, chars: null, charsAt: null, loginCharId: 1, charItems: {}, charVisits: {}, moves: [], lastRun: null, lastError: null,
    containers: {
      vault: { objectId: 5, slots: [RING, PDEF, -1, -1, -1, -1, -1, -1, PATK, -1, -1, -1, -1, -1, -1, -1], instances: { 0: { instanceId: "v0", itemId: "ubatk", enchantments: [], capturedAt: 1 }, 1: { instanceId: "v1", itemId: "pdef", enchantments: [99], capturedAt: 1 }, 8: { instanceId: "v8", itemId: "patk", enchantments: [], capturedAt: 1 } } },
      rack: { objectId: 6, slots: [PDEF, -1], instances: { 0: { instanceId: "r0", itemId: "pdef", enchantments: [], capturedAt: 1 } } },
      gift: { objectId: 7, slots: [RING], instances: { 0: { instanceId: "g0", itemId: "ubatk", enchantments: [], capturedAt: 1 } } },
      spoils: { objectId: 8, slots: [], instances: {} },
    },
  });
  it("files every other living character's trade-slot items with their enchantments as a visit would, and the containers' where the slot matches", () => {
    const st = state();
    const note = applySnapshot(st, dump(), 1, 5000);
    expect(note).toMatchObject({ chars: 1, charItems: 2, enchanted: 1, containerEnchanted: 3, records: 3, authoritative: true });
    // The played character (1) is the tracker's; the dead one (3) is skipped; character 2's slots 4 and 5 are filed, the ring with its enchantments.
    expect(Object.keys(st.charItems ?? {})).toEqual(["2"]);
    expect(st.charItems?.["2"]?.[4]).toMatchObject({ itemId: "patk", enchantments: [] });
    expect(st.charItems?.["2"]?.[5]).toMatchObject({ itemId: "ubatk", enchantments: [7, 8] });
    expect(st.charVisits?.["2"]).toEqual({ at: 5000, capacity: 16, source: "snapshot" });
    expect(st.charVisits?.["1"]).toBeUndefined();
    expect(st.chars?.map((c) => c.id)).toEqual([1, 2, 3]);
    // Vault: slot 0 matches and gets [11]; slot 1 had no record and keeps [99]; chest 2 slot 0 is flat slot 8.
    expect(st.containers?.vault.instances[0].enchantments).toEqual([11]);
    expect(st.containers?.vault.instances[1].enchantments).toEqual([99]);
    expect(st.containers?.vault.instances[8].enchantments).toEqual([12]);
    expect(st.containers?.rack.instances[0].enchantments).toEqual([14]);
    // The gift chest's slot holds a ring per the vault but a potion per the snapshot: left alone.
    expect(st.containers?.gift.instances[0].enchantments).toEqual([]);
    // A snapshot without any enchantment data is not authoritative: the visits still run.
    expect(applySnapshot(state(), { ...dump(), records: 0, sections: ["Account/Vault"] }, 1, 5000).authoritative).toBe(false);
    expect(applySnapshot(state(), { ...dump(), records: 0, sections: ["Char/UniqueItemInfo"] }, 1, 5000).authoritative).toBe(true);
  });
  it("fills in vault slots the trip never saw from the snapshot, in the same order", () => {
    // Two chests seen in the Vault; the snapshot lists three (VAULTINFO stops short on a huge vault).
    const st: AccountStorageState = { ...state(), containers: { vault: { objectId: 1, slots: Array(16).fill(-1), instances: {} }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [], instances: {} }, spoils: { objectId: 4, slots: [], instances: {} } } };
    const slot = (type: number, enchantments: number[] | null = null): DumpSlot => ({ type, copyId: null, enchantments });
    const empty = () => Array.from({ length: 8 }, () => slot(-1));
    const dump: AccountDump = { nextCharId: 3, maxNumChars: 5, name: null, chars: [], vault: [empty(), empty(), [slot(RING, [283]), slot(SOULBOUND), ...Array.from({ length: 6 }, () => slot(-1))]], materialStorage: [], gifts: [], temporaryGifts: [], potions: [], records: 1, sections: ["Account/Vault"] };
    const note = applySnapshot(st, dump, 1, 5_000);
    expect(note.extended).toBe(8);
    expect(st.containers!.vault.slots).toHaveLength(24);
    expect(st.containers!.vault.slots[16]).toBe(RING);
    expect(st.containers!.vault.instances[16]).toMatchObject({ itemId: "ubatk", enchantments: [283] });
    expect(st.containers!.vault.instances[17]).toBeUndefined();
    // Read again: nothing to add, the identity stays.
    const id = st.containers!.vault.instances[16].instanceId;
    expect(applySnapshot(st, dump, 1, 6_000).extended).toBe(0);
    expect(st.containers!.vault.instances[16].instanceId).toBe(id);
  });
  it("never fills the spoils or gift chest in from a snapshot that lags the trip that emptied a slot", () => {
    // The trip took the potion out of spoils slot 1 (now empty); the snapshot, a step behind, still lists it and one more.
    const st = { ...state(), containers: { vault: { objectId: 1, slots: [], instances: {} }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [], instances: {} }, spoils: { objectId: 4, slots: [RING, -1], instances: { 0: { instanceId: "s-ring", itemId: "ubatk", enchantments: [], capturedAt: 1 } } } } };
    const slot = (type: number): DumpSlot => ({ type, copyId: null, enchantments: null });
    const dump: AccountDump = { nextCharId: 3, maxNumChars: 5, name: null, chars: [], vault: [], materialStorage: [], gifts: [], temporaryGifts: [slot(RING), slot(PDEF), slot(PDEF)], potions: [], records: 1, sections: ["Account/TemporaryGifts"] };
    expect(applySnapshot(st, dump, 1, 5_000).extended).toBe(0);
    expect(st.containers!.spoils.slots).toEqual([RING, -1]);
    expect(Object.keys(st.containers!.spoils.instances)).toEqual(["0"]);
  });
  it("a snapshot read in a login of its own sets the spoils list right, keeping the ids of what is still there", () => {
    const st = { ...state(), containers: { vault: { objectId: 1, slots: [], instances: {} }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [], instances: {} }, spoils: { objectId: 4, slots: [PATK, RING, PDEF], instances: { 0: { instanceId: "s-patk", itemId: "patk", enchantments: [], capturedAt: 1 }, 1: { instanceId: "s-ring", itemId: "ubatk", enchantments: [], capturedAt: 1 }, 2: { instanceId: "s-ghost", itemId: "pdef", enchantments: [], capturedAt: 1 } } } } };
    const slot = (type: number): DumpSlot => ({ type, copyId: null, enchantments: null });
    const dump: AccountDump = { nextCharId: 3, maxNumChars: 5, name: null, chars: [], vault: [], materialStorage: [], gifts: [], temporaryGifts: [slot(PATK), slot(RING)], potions: [], records: 1, sections: ["Account/TemporaryGifts"] };
    applySnapshot(st, dump, 1, 5_000, true);
    expect(st.containers!.spoils.slots).toEqual([PATK, RING]);
    expect(Object.values(st.containers!.spoils.instances).map((i) => i.instanceId)).toEqual(["s-patk", "s-ring"]);
  });
  it("lists the regular side's containers from the snapshot when no Vault trip has described them, and under the other side for a seasonal login", () => {
    const slot = (type: number, enchantments: number[] | null = null): DumpSlot => ({ type, copyId: null, enchantments });
    const pad = (xs: DumpSlot[]) => [...xs, ...Array.from({ length: 8 - xs.length }, () => slot(-1))];
    const dump: AccountDump = { nextCharId: 3, maxNumChars: 5, name: "Bob", chars: [{ ...char(1, false), slots: [] }, { ...char(2, true), slots: [] }], vault: [pad([slot(RING, [283])])], materialStorage: [], gifts: [slot(PATK)], temporaryGifts: [slot(RING)], potions: [slot(PDEF), slot(-1)], records: 1, sections: ["Account/Vault", "Account/Gifts", "Account/TemporaryGifts", "Account/Potions"] };
    // Non-seasonal login, nothing read yet: the snapshot is the view, object ids unknown until a trip.
    const st: AccountStorageState = { ...state(), containers: null, viewSeasonal: null, lastVisitAt: null };
    const note = applySnapshot(st, dump, 1, 5_000);
    expect(note.created).toBe(true);
    expect(st.viewSeasonal).toBe(false);
    expect(st.containers!.vault).toMatchObject({ objectId: -1, slots: [RING, -1, -1, -1, -1, -1, -1, -1] });
    expect(st.containers!.vault.instances[0]).toMatchObject({ itemId: "ubatk", enchantments: [283] });
    expect(st.containers!.rack.slots).toEqual([PDEF, -1]);
    expect(st.containers!.gift.instances[0]).toMatchObject({ itemId: "patk" });
    expect(storedInstances(st, 1, false).map((s) => [s.itemId, whereLabel(s.where)])).toEqual(expect.arrayContaining([["ubatk", "non-seasonal vault chest"], ["patk", "non-seasonal gift chest"], ["pdef", "non-seasonal potion rack"], ["ubatk", "spoils chest"]]));
    // Seasonal login: the same snapshot is the other side's; the played side's containers wait for a trip.
    const st2: AccountStorageState = { ...state(), containers: null, viewSeasonal: null, lastVisitAt: null };
    const note2 = applySnapshot(st2, dump, 2, 5_000);
    expect(note2.created).toBe(true);
    expect(st2.containers).toBeNull();
    expect(st2.otherSide).toMatchObject({ seasonal: false });
    expect(st2.otherSide!.containers.vault.slots[0]).toBe(RING);
    expect(storedInstances(st2, 2, true).find((s) => s.where.kind === "vault")).toMatchObject({ where: { seasonal: false }, pools: { seasonal: false, nonseasonal: true } });
  });
});

describe("backpacks in the chests, and one applied to a character", () => {
  it("counts the calendar's backpack item per side and marks the character's slots when one is used", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-bp-"));
    const store = new StorageStore(path.join(dir, "storage_state.json"));
    const acc = { alias: "a", guid: "a@x", botGuid: "bot-a", seasonalOrDefault: false, info: {} } as unknown as BotAccount;
    const caps: Record<string, number> = { "bot-a": 8 };
    const sd = { deps: { log() {} }, pool: {}, tracker: { noteCapacity: (g: string, n: number) => { caps[g] = n; }, capacityFor: (g: string) => caps[g] ?? 8, heldCount: () => 0 }, settings: {} } as unknown as SweepDeps;
    const svc = new StorageService({ sd, store, holds: new Set(), now: () => 1_000 });
    const st = store.for(acc);
    const BP = 3180;
    st.containers = { vault: { objectId: 1, slots: [BP, -1], instances: {} }, rack: { objectId: 2, slots: [], instances: {} }, gift: { objectId: 3, slots: [BP, BP], instances: {} }, spoils: { objectId: 4, slots: [], instances: {} } };
    st.viewSeasonal = false;
    st.otherSide = { seasonal: true, at: 1, containers: { vault: { objectId: 5, slots: [], instances: {} }, rack: { objectId: 6, slots: [], instances: {} }, gift: { objectId: 7, slots: [BP], instances: {} }, spoils: { objectId: 8, slots: [BP], instances: {} } } };
    expect(svc.backpacksInChests(acc)).toEqual({ seasonal: 2, nonseasonal: 3, unknown: 0 });
    st.chars = [char(1, false), char(2, true, { backpackSlots: 0 })];
    st.loginCharId = 1;
    st.charVisits = { "2": { at: 1, capacity: 8 } };
    svc.noteBackpackApplied(acc, 2);
    expect(st.chars[1].backpackSlots).toBe(8);
    expect(st.charVisits["2"].capacity).toBe(16);
    expect(caps["bot-a"]).toBe(8);
    svc.noteBackpackApplied(acc, 1);
    expect(caps["bot-a"]).toBe(16);
    store.save();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("worn and quickslot items", () => {
  const HP = toObjType("health_potion")!;
  it("lists what a character wears and stacks in its quickslots as stored items of its side, one Nexus swap away", () => {
    const st = state({ chars: [char(1, false, { equipment: [-1, -1, -1, RING, -1, -1, -1, -1, -1, -1, -1, -1], quickslots: [{ type: HP, count: 3 }, { type: -1, count: 0 }] }), char(2, true)], charItems: {} });
    reconcileTucked(st, 5_000);
    const out = storedInstances(st, 1, false);
    const worn = out.filter((s) => s.where.kind === "worn");
    expect(worn).toHaveLength(1);
    expect(worn[0]).toMatchObject({ itemId: "ubatk", where: { kind: "worn", charId: 1, slot: 3, seasonal: false }, pools: { seasonal: false, nonseasonal: true } });
    const units = out.filter((s) => s.where.kind === "quickslot");
    expect(units).toHaveLength(3);
    expect(units[0]).toMatchObject({ itemId: "health_potion", where: { kind: "quickslot", charId: 1, slot: 0, count: 3 } });
    // Identities hold while the slot holds the type; a stack that shrinks keeps its first ids.
    const ids = units.map((u) => u.instanceId);
    st.chars![0].quickslots[0].count = 2;
    reconcileTucked(st, 6_000);
    expect(storedInstances(st, 1, false).filter((s) => s.where.kind === "quickslot").map((u) => u.instanceId)).toEqual(ids.slice(0, 2));
    expect(storedInstances(st, 1, false).find((s) => s.where.kind === "worn")!.instanceId).toBe(worn[0].instanceId);
  });
  it("plans an unequip and an unstack as swaps on the player into the first free trade slot", () => {
    const inv = [-1, -1, -1, RING, PDEF, -1, -1, -1, -1, -1, -1, -1];
    const base = { playerObjectId: 77, inv, tradeSlots: 8, containers: { vault: { objectId: -1, slots: [] }, rack: { objectId: -1, slots: [] }, gift: { objectId: -1, slots: [] }, spoils: { objectId: -1, slots: [] } }, tracked: {} } as PlanInput;
    const un: Move = { id: "m1", kind: "unequip", itemId: "ubatk", objectType: RING, name: "Ring", charSlot: 3, queuedAt: 1 };
    expect(planMove(un, base)).toEqual({ ok: true, container: null, objectType: RING, from: { objectId: 77, slotId: 3, objectType: RING }, to: { objectId: 77, slotId: 5, objectType: -1 } });
    const us: Move = { id: "m2", kind: "unstack", itemId: "health_potion", objectType: HP, name: "Health Potion", charSlot: 1, queuedAt: 1 };
    expect(planMove(us, { ...base, quickslots: [{ type: -1, count: 0 }, { type: HP, count: 2 }] })).toMatchObject({ ok: true, from: { slotId: QUICK_SLOT_FIRST + 1 }, to: { slotId: 5 } });
    expect(planMove(us, { ...base, quickslots: [{ type: -1, count: 0 }, { type: -1, count: 0 }] })).toMatchObject({ ok: false, error: expect.stringContaining("no longer holds") });
    expect(planMove(un, { ...base, inv: inv.map((t, i) => (i >= 4 ? RING : t)) })).toMatchObject({ ok: false, error: "no free slot on the character" });
  });
  it("a fetch of a worn item logs in as that character and unequips it there", () => {
    const st = state({ chars: [char(1, false), char(2, true, { equipment: [-1, -1, -1, RING] })], charItems: {} });
    reconcileTucked(st, 5_000);
    const worn = storedInstances(st, 1, false).find((s) => s.where.kind === "worn")!;
    const p = planFetch(st, { instanceIds: [worn.instanceId], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked: {} });
    expect(p).toMatchObject({ ok: true, charId: 2 });
    expect(p.moves.map((m) => [m.kind, m.charSlot, m.instanceId])).toEqual([["unequip", 3, worn.instanceId]]);
  });
});

describe("the porter rule", () => {
  const tracked = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [4 + i, inst(`t${i}`, "pdef")]));
  it("a fetch of container items runs as a same-side character with the room when the played one is full", () => {
    // Played #1 (non-seasonal, 8 slots, all full); #3 non-seasonal and empty with a backpack.
    const st = state({ chars: [char(1, false), char(2, true), char(3, false, { backpackSlots: 8, hasBackpack: true })], charItems: {} });
    const p = planFetch(st, { instanceIds: ["v-ring", "r-patk"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked });
    expect(p).toMatchObject({ ok: true, charId: 3 });
    // With room on the played character, it fetches itself.
    expect(planFetch(st, { instanceIds: ["v-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: false, tracked: {} })).toMatchObject({ ok: true, charId: null });
  });
});

describe("the tuck", () => {
  const HP = toObjType("health_potion")!;
  it("plans gear into empty equipment slots the class can use and consumables into quickslots with room, nothing else", () => {
    const st = state({ chars: [char(1, false, { objectType: 782, equipment: [-1, -1, -1, -1, RING, HP, HP, PDEF], quickslots: [{ type: HP, count: 5 }, { type: -1, count: 0 }] })], charItems: {} });
    const tracked = { 4: inst("a", "ubatk"), 5: inst("b", "health_potion"), 6: inst("c", "health_potion"), 7: inst("d", "pdef") };
    const moves = planTuck(st, 1, tracked);
    expect(moves.map((m) => [m.kind, m.charSlot, m.instanceId])).toEqual([["equip", 3, "a"], ["stack", 0, "b"], ["stack", 1, "c"]]);
    // A ring already worn: the second ring stays; a pinned item is never tucked.
    st.chars![0].equipment[3] = RING;
    expect(planTuck(st, 1, tracked, new Set(["b"])).map((m) => m.instanceId)).toEqual(["c"]);
  });
  it("banks what the account must not hold first, as far as the vault has room, then tucks the rest", () => {
    // Vault [RING, PDEF, -1]: one free slot. "Not taken" here: pdef and patk.
    const st = state({ chars: [char(1, false, { objectType: 782, equipment: [-1, -1, -1, -1, RING, HP, PDEF, PATK], quickslots: [] })], charItems: {} });
    const tracked = { 4: inst("a", "ubatk"), 5: inst("b", "health_potion"), 6: inst("c", "pdef"), 7: inst("d", "patk") };
    const notTaken = (id: string) => id === "pdef" || id === "patk";
    const moves = planTuck(st, 1, tracked, new Set(), notTaken);
    // c goes to the vault's one free slot; d has nowhere to go (no room, not wearable, not a quickslot item); the ring and the potion tuck as before.
    expect(moves.map((m) => [m.kind, m.instanceId])).toEqual([["bank", "c"], ["equip", "a"], ["stack", "b"]]);
    // A pinned item is never banked: the room goes to the next one.
    expect(planTuck(st, 1, tracked, new Set(["c"]), notTaken).map((m) => [m.kind, m.instanceId])).toEqual([["bank", "d"], ["equip", "a"], ["stack", "b"]]);
    // No room in the vault: nothing is banked, the tuck is the plain one.
    st.containers!.vault.slots = [RING, PDEF];
    expect(planTuck(st, 1, tracked, new Set(), notTaken).map((m) => m.kind)).toEqual(["equip", "stack"]);
    // Without the predicate nothing is banked at all.
    expect(planTuck(st, 1, tracked).map((m) => m.kind)).toEqual(["equip", "stack"]);
  });
  it("orders what leaves a communism character to make room: the items communism does not take first", () => {
    const list = [inst("x", "pdef"), inst("y", "magic_mushroom"), inst("z", "patk"), inst("w", "2_bit_archer_skin")];
    expect(storeFirst(list, true).map((i) => i.instanceId)).toEqual(["y", "w", "x", "z"]);
    expect(storeFirst(list, false).map((i) => i.instanceId)).toEqual(["x", "y", "z", "w"]);
  });
  it("plans an equip into an empty slot and a stack onto a matching quickslot, and refuses a taken slot", () => {
    const inv = [-1, -1, -1, -1, RING, HP, -1, -1, -1, -1, -1, -1];
    const base = { playerObjectId: 77, inv, tradeSlots: 8, containers: { vault: { objectId: -1, slots: [] }, rack: { objectId: -1, slots: [] }, gift: { objectId: -1, slots: [] }, spoils: { objectId: -1, slots: [] } }, tracked: { 4: inst("a", "ubatk"), 5: inst("b", "health_potion") }, quickslots: [{ type: HP, count: 2 }, { type: -1, count: 0 }] } as PlanInput;
    expect(planMove({ id: "1", kind: "equip", itemId: "ubatk", objectType: RING, name: "Ring", charSlot: 3, instanceId: "a", queuedAt: 1 }, base)).toMatchObject({ ok: true, container: null, from: { slotId: 4 }, to: { slotId: 3, objectType: -1 } });
    expect(planMove({ id: "2", kind: "stack", itemId: "health_potion", objectType: HP, name: "Health Potion", charSlot: 0, instanceId: "b", queuedAt: 1 }, base)).toMatchObject({ ok: true, from: { slotId: 5 }, to: { slotId: QUICK_SLOT_FIRST, objectType: HP } });
    expect(planMove({ id: "3", kind: "equip", itemId: "ubatk", objectType: RING, name: "Ring", charSlot: 3, instanceId: "a", queuedAt: 1 }, { ...base, inv: inv.map((t, i) => (i === 3 ? PDEF : t)) })).toMatchObject({ ok: false, error: "equipment slot 3 is taken" });
  });
});
