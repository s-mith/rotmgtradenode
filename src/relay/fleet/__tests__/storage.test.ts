// Account storage: the VAULTINFO merge, the move planner, the state file
// and the character picker. The trip itself is verified against the live
// game (docs/relay/STORAGE.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyVaultView, mergeVaultInfo } from "../vaultTrip";
import { planFetch, planMove, reconcileCharItems, roomMoves, storedInstances, StorageStore, nameOfType, type AccountStorageState, type Move, type PlanInput } from "../storage";
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
const char = (id: number, seasonal: boolean, over: Partial<CharDetail> = {}): CharDetail => ({ id, objectType: 782, level: 20, seasonal, dead: false, backpackSlots: 0, hasBackpack: false, equipment: [], ...over });
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
    // The vault and the rack: any character of the account; it has one of each side.
    expect(by["v-ring"]).toMatchObject({ itemId: "ubatk", enchantments: [283], where: { kind: "vault", slot: 0 }, pools: { seasonal: true, nonseasonal: true } });
    expect(by["r-patk"]).toMatchObject({ where: { kind: "rack", slot: 0 }, pools: { seasonal: true, nonseasonal: true } });
    // The gift chest: the side that read it (non-seasonal here); the spoils chest: non-seasonal only.
    expect(by["g-patk"]).toMatchObject({ where: { kind: "gift", slot: 1 }, pools: { seasonal: false, nonseasonal: true } });
    expect(by["s-ring"]).toMatchObject({ where: { kind: "spoils", slot: 0 }, pools: { seasonal: false, nonseasonal: true } });
    // The seasonal character's own items: the seasonal half; the played character's are the tracker's, not here.
    expect(by["c2-pdef"]).toMatchObject({ where: { kind: "char", charId: 2, slot: 4, className: "Wizard", level: 20 }, pools: { seasonal: true, nonseasonal: false } });
    expect(out).toHaveLength(6);
  });
  it("offers a vault item to one side only when the account has no living character of the other", () => {
    const st = state({ chars: [char(1, false), char(2, true, { dead: true })], charItems: {} });
    const out = storedInstances(st, 1, false);
    expect(out.find((s) => s.instanceId === "v-ring")!.pools).toEqual({ seasonal: false, nonseasonal: true });
    expect(out.find((s) => s.instanceId === "c2-pdef")).toBeUndefined();
    // Without a char list the account's own flag stands in.
    const bare = storedInstances(state({ chars: null, charItems: {} }), null, true);
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
    const p = planFetch(state(), { instanceIds: ["c2-pdef", "v-pdef"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked });
    expect(p).toMatchObject({ ok: true, charId: 2 });
    expect(p.moves.map((m) => m.instanceId)).toEqual(["v-pdef"]);
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
    // A seasonal withdraw for a vault item while the non-seasonal character is played: the seasonal one logs in.
    expect(planFetch(state(), { instanceIds: ["v-ring"], items: [] }, { loginCharId: 1, accSeasonal: false, seasonal: true, tracked })).toMatchObject({ ok: true, charId: 2 });
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
