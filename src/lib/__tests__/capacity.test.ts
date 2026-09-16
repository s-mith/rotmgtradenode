// Room maths over the fleet's pool snapshot: which bots count, and how big a
// single trade could be.
import { describe, expect, it } from "vitest";
import { filterBotsByPool, largestFreeSlots, totalPoolSlots } from "../capacity";

const meta = {
  s1: { seasonal: true },
  s2: { seasonal: true, suspended: true },
  n1: { seasonal: false },
  n2: { seasonal: false, suspended: true },
  n3: {}, // no flag: seasonal by default
};

describe("capacity", () => {
  it("drops suspended accounts from every view and splits the rest by pool half", () => {
    const all = ["s1", "s2", "n1", "n2", "n3", "ghost"];
    expect(filterBotsByPool(all, meta, null)).toEqual(["s1", "n1", "n3", "ghost"]);
    expect(filterBotsByPool(all, meta, "seasonal")).toEqual(["s1", "n3", "ghost"]);
    expect(filterBotsByPool(all, meta, "nonseasonal")).toEqual(["n1"]);
    expect(filterBotsByPool(all, undefined, "nonseasonal")).toEqual([]);
  });

  it("sizes the biggest single trade from capacity minus load, 8 when a bot's capacity is unknown", () => {
    const tracker = { s1: { pdef: 3 }, n1: {}, n3: { ubatk: 16 } };
    const capacities = { s1: 16, n3: 16 };
    expect(largestFreeSlots(["s1"], tracker, capacities)).toBe(13);
    expect(largestFreeSlots(["n1"], tracker, capacities)).toBe(8);
    expect(largestFreeSlots(["n3"], tracker, capacities)).toBe(0);
    expect(largestFreeSlots(["s1", "n1", "n3"], tracker, capacities)).toBe(13);
    expect(largestFreeSlots([], tracker, capacities)).toBe(0);
    expect(totalPoolSlots(["s1", "n1"], capacities, 3)).toBe(16 + 8 + 8);
  });
});
