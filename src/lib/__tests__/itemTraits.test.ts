import { describe, expect, it } from "vitest";
import { equipSlotOf, quickslotStack, wearableBy } from "../itemTraits";

describe("item traits", () => {
  it("knows which items a quickslot takes and how many make a stack", () => {
    expect(quickslotStack("health_potion")).toBe(6);
    expect(quickslotStack("fire_water")).toBe(3);
    expect(quickslotStack("pdef")).toBeNull();
    expect(quickslotStack("ubatk")).toBeNull();
  });
  it("puts gear in its equipment slot and knows who can wear it", () => {
    expect(equipSlotOf("ubatk")).toBe(3);
    expect(equipSlotOf("rod")).toBe(3);
    expect(equipSlotOf("pdef")).toBeNull();
    expect(wearableBy("ubatk", "Wizard")).toBe(true);
    expect(wearableBy("pdef", "Wizard")).toBe(false);
  });
});
