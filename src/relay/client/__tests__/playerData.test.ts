import { describe, expect, it } from "vitest";
import { PlayerData } from "../playerData";
import { Stat } from "../../protocol/stats";

const stat = (statType: number, statValue: number) => ({ statType, statValue, strStatValue: "", secondaryValue: 0 });

describe("backpack detection", () => {
  it("does not infer a backpack from empty backpack slot stats", () => {
    const pd = new PlayerData();
    pd.applyStats([stat(Stat.BACKPACK0, -1), stat(Stat.BACKPACK0 + 3, -1)]);
    expect(pd.hasBackpack).toBe(false);
    expect(pd.freeSlots()).toBe(8);
  });
  it("trusts an item sitting in a backpack slot, and keeps it sticky", () => {
    const pd = new PlayerData();
    pd.applyStats([stat(Stat.BACKPACK0 + 2, 2979)]);
    expect(pd.hasBackpack).toBe(true);
    expect(pd.freeSlots()).toBe(15);
    pd.applyStats([stat(Stat.BACKPACK0 + 2, -1)]);
    expect(pd.hasBackpack).toBe(true);
  });
  it("trusts the HAS_BACKPACK stat", () => {
    const pd = new PlayerData();
    pd.applyStats([stat(Stat.HASBACKPACK, 1)]);
    expect(pd.hasBackpack).toBe(true);
    const none = new PlayerData();
    none.applyStats([stat(Stat.HASBACKPACK, 0), stat(Stat.BACKPACK0, -1)]);
    expect(none.hasBackpack).toBe(false);
  });
});

describe("the 16-slot backpack", () => {
  it("is assumed 8 slots until an item is seen past the eighth, which only the upgraded backpack has", async () => {
    const { PlayerData } = await import("../playerData");
    const { Stat } = await import("../../protocol/stats");
    const pd = new PlayerData();
    pd.applyStats([stat(Stat.BACKPACK0 + 2, 2979)]);
    expect(pd.backpackSlots).toBe(8);
    expect(pd.tradeSlots).toBe(16);
    // Backpack slot 13 (stat 144) held an item live on 2026-09-17.
    pd.applyStats([stat(Stat.BACKPACK0 + 13, 1826)]);
    expect(pd.inv[25]).toBe(1826);
    expect(pd.backpackSlots).toBe(16);
    expect(pd.tradeSlots).toBe(24);
    pd.applyStats([stat(Stat.BACKPACK0 + 13, -1)]);
    expect(pd.backpackSlots).toBe(16);
    expect(pd.freeSlots()).toBe(23);
  });
  it("trusts char/list's BackpackSlots=16 before any stat", async () => {
    const { PlayerData } = await import("../playerData");
    const pd = new PlayerData();
    pd.knownBackpackSlots = 16;
    expect(pd.backpackSlots).toBe(16);
    pd.knownBackpackSlots = 8;
    expect(pd.backpackSlots).toBe(0); // no backpack evidence in the stats yet: hasBackpack still needs stat 79 or an item
  });
});
