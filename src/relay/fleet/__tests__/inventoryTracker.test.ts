// Instance identity: a slot keeps its id while it holds the same physical
// item; a different enchant record in that slot is another copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InventoryTracker } from "../inventoryTracker";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("InventoryTracker identity", () => {
  it("keeps an id across refreshes, mints a new one when the slot's enchantments change, and honours an expected arrival", () => {
    const t = new InventoryTracker(path.join(dir, "inventory_state.json"));
    t.updateFromSlots("bot", { 4: { itemId: "patk", enchantments: [] }, 5: { itemId: "pdef", enchantments: [3] } }, 8);
    const plain = t.instancesFor("bot")[4].instanceId;
    const ench = t.instancesFor("bot")[5].instanceId;
    expect(t.updateFromSlots("bot", { 4: { itemId: "patk", enchantments: [] }, 5: { itemId: "pdef", enchantments: [3] } }, 8)).toBe(false);
    expect(t.instancesFor("bot")[4].instanceId).toBe(plain);
    // A swap of the plain attack potion for an enchanted one lands in the same slot: a new physical item, a new id.
    t.updateFromSlots("bot", { 4: { itemId: "patk", enchantments: [5] }, 5: { itemId: "pdef", enchantments: [3] } }, 8);
    expect(t.instancesFor("bot")[4].instanceId).not.toBe(plain);
    expect(t.instancesFor("bot")[5].instanceId).toBe(ench);
    expect(t.holderOf(plain)).toBeUndefined();
    // An arrival the fleet announced keeps the id it travelled with.
    t.expectArrival("bot", { instanceId: "moved-1", itemId: "ubatk", enchantments: [9], capturedAt: 1 });
    t.updateFromSlots("bot", { 4: { itemId: "patk", enchantments: [5] }, 5: { itemId: "pdef", enchantments: [3] }, 6: { itemId: "ubatk", enchantments: [9] } }, 8);
    expect(t.instancesFor("bot")[6].instanceId).toBe("moved-1");
    t.close();
  });
});
