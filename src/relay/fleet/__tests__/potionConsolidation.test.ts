// The planner with a fleet where only some bots carry backpacks: capacity is
// a per-bot fact, and it alone decides who collects and who empties out.
import { describe, expect, it } from "vitest";
import { collectionTargets, fragmentation, planMoves, type Inventories } from "../potionConsolidation";

describe("mixed 8/16-slot fleets", () => {
  const caps = { big: 16, a: 8, b: 8, c: 8 };

  /** Apply planned moves to the inventories (one pass = one move per bot). */
  function apply(inv: Inventories, moves: ReturnType<typeof planMoves>): void {
    for (const m of moves) {
      for (const [id, n] of Object.entries(m.items)) {
        inv[m.giver][id] -= n;
        if (!inv[m.giver][id]) delete inv[m.giver][id];
        inv[m.taker][id] = (inv[m.taker][id] ?? 0) + n;
      }
    }
  }

  it("gathers the bucket onto the backpack bot and drains the 8-slot holders", () => {
    const inv: Inventories = { big: { pdef: 6 }, a: { pdef: 3 }, b: { pdef: 3 }, c: { pdef: 2 } };
    expect(collectionTargets(inv, { capacities: caps }).def[0]).toBe("big");
    const givers = new Set<string>();
    for (let pass = 0; pass < 10; pass++) {
      const moves = planMoves(inv, caps, { online: new Set(Object.keys(inv)), maxMoves: 10 });
      if (!moves.length) break;
      for (const m of moves) {
        expect(m.taker).toBe("big");
        givers.add(m.giver);
      }
      apply(inv, moves);
    }
    // 16 slots minus the 6 it already held: everything the others had fits, and they end empty.
    expect(inv.big.pdef).toBe(14);
    expect(inv.a).toEqual({});
    expect(inv.b).toEqual({});
    expect(inv.c).toEqual({});
    expect(givers).toEqual(new Set(["a", "b", "c"]));
  });

  it("never plans a move past the taker's own capacity", () => {
    const inv: Inventories = { big: { pdef: 14 }, a: { pdef: 5 }, b: { pdef: 1 } };
    const moves = planMoves(inv, caps, { online: new Set(Object.keys(inv)), maxMoves: 10 });
    let onBig = 14;
    for (const m of moves) if (m.taker === "big") onBig += Object.values(m.items).reduce((x, y) => x + y, 0);
    expect(onBig).toBeLessThanOrEqual(16);
  });

  it("an 8-slot bot with no capacity entry is sized at the default, not 16", () => {
    const inv: Inventories = { x: { pdef: 8 }, y: { pdef: 8 } };
    // Both full at 8: nothing can move without a capacity claim. With a
    // per-bot 16 for x the whole of y flows over.
    expect(planMoves(inv, {}, { online: new Set(["x", "y"]) })).toEqual([]);
    const moves = planMoves(inv, { x: 16 }, { online: new Set(["x", "y"]) });
    expect(moves.map((m) => [m.giver, m.taker, m.items.pdef])).toEqual([["y", "x", 8]]);
  });

  it("fragmentation counts the fewest bots by real capacity", () => {
    const inv: Inventories = { big: { pdef: 4 }, a: { pdef: 4 }, b: { pdef: 4 }, c: { pdef: 4 } };
    const f16 = fragmentation(inv, { capacities: caps });
    const f8 = fragmentation(inv, { capacities: { big: 8, a: 8, b: 8, c: 8 } });
    expect(JSON.stringify(f16)).not.toBe(JSON.stringify(f8));
  });
});
