// Account storage: the VAULTINFO merge, the move planner, the state file
// and the character picker. The trip itself is verified against the live
// game (docs/relay/STORAGE.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyVaultView, mergeVaultInfo } from "../vaultTrip";
import { planMove, StorageStore, nameOfType, type Move, type PlanInput } from "../storage";
import { pickCharId } from "../../client/gameClient";
import { toObjType } from "../../trade/itemMap";
import type { Packet } from "../../protocol/packets";

const PDEF = toObjType("pdef")!;
const PATK = toObjType("patk")!;
const RING = toObjType("ubatk")!;
const SOULBOUND = 0x0aaa; // some type the pool does not trade

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
    st.containers = { vault: { objectId: 1, slots: [RING], placed: { 0: { instanceId: "i", itemId: "ubatk", enchantments: [], capturedAt: 1 } } }, rack: { objectId: 2, slots: [], placed: {} }, gift: { objectId: 3, slots: [], placed: {} }, spoils: { objectId: 4, slots: [], placed: {} } };
    st.moves.push(move({ kind: "unbank", itemId: "ubatk", slot: 0 }));
    store.save();
    const again = StorageStore.at(dir).for(acc);
    expect(again.containers?.vault).toEqual(st.containers.vault);
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
