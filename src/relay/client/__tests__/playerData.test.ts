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
