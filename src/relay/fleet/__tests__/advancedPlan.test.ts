// Advanced management's planner (docs/relay/ADVANCED.md): potion stacks
// merged by kind, one-character bots evacuated, and when an account wants a
// compaction or a gathering run.
import { describe, expect, it } from "vitest";
import { compactionSource, compactionWanted, emptyBots, gatherWanted, groupKey, hasEmptyChar, kindOf, MERGE_UNDER, planEvacuation, planMerges, potionCount, transitReserve, type AcctView, type Held, type Merge } from "../advancedPlan";
import { POTION_INFO } from "../potionConsolidation";

type Spec = {
  played?: Record<string, number>;
  capacity?: number;
  /** null: the vault was never seen. */
  vault?: Record<string, number> | null;
  vaultSlots?: number;
  vaultFree?: number;
  others?: { charId: number; capacity?: number; items?: Record<string, number>; held?: number }[];
  chars?: number;
  online?: boolean;
  idle?: boolean;
  server?: string | null;
  communism?: boolean;
  seasonal?: boolean;
  reserved?: string[];
};

/** Items by id, as instances named `<prefix>:<itemId>:<n>`. */
function held(prefix: string, inv: Record<string, number>): Held[] {
  const out: Held[] = [];
  for (const [itemId, n] of Object.entries(inv)) for (let i = 0; i < n; i++) out.push({ instanceId: `${prefix}:${itemId}:${i}`, itemId });
  return out;
}
function view(botGuid: string, s: Spec = {}): AcctView {
  const others = (s.others ?? []).map((o) => {
    const items = held(`${botGuid}:c${o.charId}`, o.items ?? {});
    return { charId: o.charId, capacity: o.capacity ?? 8, held: o.held ?? items.length, items };
  });
  const vaultItems = s.vault === null ? null : held(`${botGuid}:v`, s.vault ?? {});
  const slots = s.vaultSlots ?? 40;
  return {
    botGuid,
    communism: s.communism ?? false,
    seasonal: s.seasonal ?? false,
    chars: s.chars ?? 1 + others.length,
    online: s.online ?? true,
    idle: s.idle ?? true,
    server: s.server === undefined ? "USWest" : s.server,
    played: { capacity: s.capacity ?? 16, items: held(`${botGuid}:p`, s.played ?? {}) },
    vault: vaultItems ? { slots, free: s.vaultFree ?? slots - vaultItems.length, items: vaultItems } : null,
    others,
    ...(s.reserved ? { reserved: new Set(s.reserved) } : {}),
  };
}
const offline = { online: false, idle: false };
const quiet = { mode: "quiet" as const, max: 10, busy: new Set<string>(), tradeMax: 8 };
const online = { ...quiet, mode: "online" as const };
const pairs = (plan: { giver: string; taker: string }[]) => plan.map((m) => [m.giver, m.taker]);

/** A deterministic shuffle and random numbers, so a failing case replays. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("kinds, counts and empty characters", () => {
  it("names the 16 potion kinds by their catalog ids, and nothing else", () => {
    expect(Object.keys(POTION_INFO).map(kindOf)).toEqual(Object.keys(POTION_INFO));
    expect(Object.keys(POTION_INFO)).toHaveLength(16);
    expect(kindOf("junk")).toBeNull();
    // Not fooled by what every object inherits.
    expect(kindOf("toString")).toBeNull();
  });

  it("counts potions wherever the account keeps them", () => {
    const a = view("a", { played: { patk: 2, junk: 3 }, vault: { gpdef: 4, junk: 1 }, others: [{ charId: 2, items: { pmana: 1, junk: 2 } }] });
    expect(potionCount(a)).toBe(7);
  });

  it("keeps one character's worth of the vault as transit only on accounts with several characters", () => {
    expect(transitReserve(view("a", { capacity: 16 }))).toBe(0);
    expect(transitReserve(view("a", { capacity: 8, others: [{ charId: 2, capacity: 16 }] }))).toBe(16);
    expect(transitReserve(view("a", { capacity: 24, others: [{ charId: 2, capacity: 8 }] }))).toBe(24);
  });

  it("finds an empty character in the played one or another of its side", () => {
    expect(hasEmptyChar(view("a"))).toBe(true);
    expect(hasEmptyChar(view("a", { played: { junk: 1 }, others: [{ charId: 2 }] }))).toBe(true);
    expect(hasEmptyChar(view("a", { played: { junk: 1 }, others: [{ charId: 2, items: { junk: 1 } }] }))).toBe(false);
    // An item the view could not name still takes the slot.
    expect(hasEmptyChar(view("a", { played: { junk: 1 }, others: [{ charId: 2, held: 1 }] }))).toBe(false);
  });
});

describe("compaction and gathering", () => {
  // Two 8-slot characters, neither empty; the vault's 8 free slots are all transit reserve.
  const full = (s: Spec = {}) => view("a", { capacity: 8, played: { junk: 3 }, others: [{ charId: 2, items: { junk: 2 } }], vaultSlots: 40, vault: { junk: 32 }, ...s });

  it("is wanted when no character is empty and banking cannot make one", () => {
    expect(compactionWanted(full())).toBe(true);
    // The emptiest character goes, onto the other one.
    expect(compactionSource(full())).toEqual({ charId: 2, held: 2 });
  });

  it("is not wanted with one character, an empty character, or room to bank the played one's items", () => {
    expect(compactionWanted(view("a", { capacity: 8, played: { junk: 3 }, vaultSlots: 40, vault: { junk: 40 } }))).toBe(false);
    expect(compactionWanted(full({ others: [{ charId: 2 }] }))).toBe(false);
    // 12 free, 8 of them the reserve: the 3 items bank and the played character is empty again.
    expect(compactionWanted(full({ vault: { junk: 28 } }))).toBe(false);
  });

  it("is not wanted when it cannot work: no room on the others, no vault slot to carry through, a vault never seen", () => {
    expect(compactionWanted(full({ played: { junk: 8 }, others: [{ charId: 2, items: { junk: 8 } }] }))).toBe(false);
    expect(compactionWanted(full({ vault: { junk: 40 } }))).toBe(false);
    expect(compactionWanted(full({ vault: null }))).toBe(false);
  });

  it("works around spoken-for items: they keep the played character from banking, and their character is never the one emptied", () => {
    // Room in the vault, but one of the played character's items is spoken for: banking cannot empty it.
    expect(compactionWanted(full({ vault: { junk: 20 }, reserved: ["a:p:junk:0"] }))).toBe(true);
    expect(compactionSource(full({ reserved: ["a:c2:junk:0"] }))).toEqual({ charId: null, held: 3 });
    // Items the view does not know can't be moved either.
    expect(compactionSource(full({ others: [{ charId: 2, held: 2, items: { junk: 1 } }] }))).toEqual({ charId: null, held: 3 });
  });

  it("gathers potions off other characters while the vault has room beyond the transit reserve", () => {
    const gather = (s: Spec = {}) => view("a", { capacity: 8, others: [{ charId: 2, items: { patk: 3 } }], vaultSlots: 40, vault: { junk: 28 }, ...s });
    expect(gatherWanted(gather())).toBe(true);
    expect(gatherWanted(gather({ vault: { junk: 32 } }))).toBe(false);
    expect(gatherWanted(gather({ others: [{ charId: 2, items: { junk: 3 } }] }))).toBe(false);
    expect(gatherWanted(gather({ reserved: ["a:c2:patk:0", "a:c2:patk:1", "a:c2:patk:2"] }))).toBe(false);
    expect(gatherWanted(gather({ vault: null }))).toBe(false);
  });
});

describe("merging potion stacks by kind", () => {
  it("sends a small stack to the biggest holder with room; the holder takes one merge per pass", () => {
    const plan = planMerges([view("big", { vault: { patk: 20 } }), view("mid", { played: { patk: 10 } }), view("small", { played: { patk: 4 } })], quiet);
    expect(plan).toEqual([{ giver: "small", taker: "big", kind: "patk", qty: 4, onCharacter: ["small:p:patk:0", "small:p:patk:1", "small:p:patk:2", "small:p:patk:3"], fromVault: [], server: "USWest" }]);
    // "mid" waits for "big" rather than seed a smaller holder.
    expect(planMerges([view("big", { vault: { patk: 20 } }), view("mid", { played: { patk: 10 } })], quiet)).toEqual([expect.objectContaining({ giver: "mid", taker: "big" })]);
  });

  it("only ever flows uphill: the biggest holder never gives", () => {
    expect(pairs(planMerges([view("a", { played: { patk: 8 } }), view("b", { played: { patk: 5 } })], quiet))).toEqual([["b", "a"]]);
    expect(planMerges([view("a", { played: { patk: 8 } })], quiet)).toEqual([]);
  });

  it("breaks a tie toward the account holding more potions, then the lower botGuid", () => {
    expect(pairs(planMerges([view("x", { played: { patk: 5 } }), view("y", { played: { patk: 5, pdef: 3 } })], quiet))).toEqual([["x", "y"]]);
    expect(pairs(planMerges([view("b", { played: { patk: 5 } }), view("a", { played: { patk: 5 } })], quiet))).toEqual([["b", "a"]]);
  });

  it("needs room for the whole stack, counting the vault beyond its transit reserve", () => {
    const accts = [
      // Holds the most but has room for 2 more: 2 free on the character, a full vault.
      view("top", { capacity: 8, played: { patk: 6 }, vaultSlots: 24, vault: { patk: 24 } }),
      view("next", { played: { patk: 10 } }),
      view("giver", { played: { patk: 6 } }),
    ];
    expect(pairs(planMerges(accts, quiet))).toEqual([["giver", "next"]]);
    // A second character keeps 16 of the vault's 20 free slots as transit: 4 + 2 is too little for 7.
    const reserve = [view("top", { capacity: 8, played: { patk: 6 }, vaultSlots: 40, vault: { patk: 20 }, others: [{ charId: 2, capacity: 16, items: { junk: 1 } }] }), view("giver", { played: { patk: 7 } })];
    expect(planMerges(reserve, quiet)).toEqual([]);
  });

  it("moves what the taker's character has free slots for, up to a trade's worth", () => {
    expect(planMerges([view("big", { vault: { patk: 20 } }), view("mid", { played: { patk: 12 } })], quiet)).toEqual([expect.objectContaining({ giver: "mid", qty: 8 })]);
    const tight = planMerges([view("big", { played: { junk: 11 }, vault: { patk: 20 } }), view("mid", { played: { patk: 12 } })], quiet);
    expect(tight).toEqual([expect.objectContaining({ giver: "mid", taker: "big", qty: 5 })]);
    expect(tight[0].onCharacter).toHaveLength(5);
    // A taker without a free slot on its character can't trade at all.
    expect(planMerges([view("big", { capacity: 8, played: { junk: 8 }, vault: { patk: 20 } }), view("mid", { played: { patk: 3 } })], quiet)).toEqual([]);
  });

  it("hands over copies on the character first, then what the giver's free slots can fetch from its vault", () => {
    const [m] = planMerges([view("big", { vault: { patk: 30 } }), view("g", { capacity: 8, played: { patk: 2, junk: 3 }, vault: { patk: 6 } })], quiet);
    expect(m.qty).toBe(5);
    expect(m.onCharacter).toEqual(["g:p:patk:0", "g:p:patk:1"]);
    expect(m.fromVault).toEqual(["g:v:patk:0", "g:v:patk:1", "g:v:patk:2"]);
    // A giver with no slot to fetch into and nothing on its character waits.
    expect(planMerges([view("big", { vault: { patk: 30 } }), view("g", { capacity: 8, played: { junk: 8 }, vault: { patk: 6 } })], quiet)).toEqual([]);
  });

  it("never moves spoken-for copies, but counts them in the stack", () => {
    const [m] = planMerges([view("big", { vault: { patk: 30 } }), view("g", { played: { patk: 4 }, reserved: ["g:p:patk:0"] })], quiet);
    expect(m.onCharacter).toEqual(["g:p:patk:1", "g:p:patk:2", "g:p:patk:3"]);
    expect(m.qty).toBe(3);
    expect(planMerges([view("big", { vault: { patk: 30 } }), view("g", { played: { patk: MERGE_UNDER }, reserved: ["g:p:patk:0"] })], quiet)).toEqual([]);
  });

  it("leaves stacks of 16 or more alone", () => {
    expect(planMerges([view("a", { vault: { patk: 30 } }), view("b", { played: { patk: MERGE_UNDER } })], quiet)).toEqual([]);
    expect(planMerges([view("a", { vault: { patk: 30 } }), view("b", { played: { patk: 8 }, vault: { patk: 8 } })], quiet)).toEqual([]);
  });

  it("never merges across communism and standard, or across the seasonal split", () => {
    expect(planMerges([view("pool", { vault: { patk: 30 } }), view("comm", { communism: true, played: { patk: 4 } })], quiet)).toEqual([]);
    expect(planMerges([view("s", { seasonal: true, vault: { patk: 30 } }), view("n", { played: { patk: 4 } })], quiet)).toEqual([]);
    const both = planMerges([view("p1", { vault: { patk: 30 } }), view("p2", { played: { patk: 4 } }), view("c1", { communism: true, vault: { patk: 30 } }), view("c2", { communism: true, played: { patk: 4 } })], quiet);
    expect(pairs(both).sort()).toEqual([["c2", "c1"], ["p2", "p1"]]);
  });

  it("leaves busy accounts and bots doing player work out", () => {
    const accts = [view("top", { vault: { patk: 30 } }), view("mid", { played: { patk: 10 } }), view("g", { played: { patk: 4 } })];
    expect(pairs(planMerges(accts, { ...quiet, busy: new Set(["top"]) }))).toEqual([["g", "mid"]]);
    const working = [view("top", { vault: { patk: 30 }, idle: false }), accts[1], accts[2]];
    expect(pairs(planMerges(working, quiet))).toEqual([["g", "mid"]]);
  });

  it("online, pairs only bots idle together on one server", () => {
    const a = view("a", { vault: { patk: 30 }, server: "USWest" });
    const b = view("b", { played: { patk: 4 }, server: "USEast" });
    expect(planMerges([a, b], online)).toEqual([]);
    expect(planMerges([a, { ...b, server: "USWest" }], online)).toEqual([expect.objectContaining({ giver: "b", taker: "a", server: "USWest" })]);
    expect(planMerges([a, { ...b, server: "USWest", ...offline }], online)).toEqual([]);
    // In a quiet period the offline one is woken to meet the other.
    expect(planMerges([a, { ...b, ...offline }], quiet)).toEqual([expect.objectContaining({ giver: "b", taker: "a", server: "USWest" })]);
  });

  it("in a quiet period prefers pairs with a bot already in world, and meets where one is", () => {
    const accts = [
      view("a1", { ...offline, server: "EUWest", vault: { patk: 30 } }),
      view("a2", { ...offline, server: "EUWest", played: { patk: 4 } }),
      view("b1", { server: "USWest", vault: { pdef: 30 } }),
      view("b2", { ...offline, server: "USEast", played: { pdef: 4 } }),
    ];
    expect(planMerges(accts, { ...quiet, max: 1 })).toEqual([expect.objectContaining({ giver: "b2", taker: "b1", server: "USWest" })]);
    // Nobody in world: the taker's last server.
    expect(planMerges(accts.slice(0, 2), quiet)).toEqual([expect.objectContaining({ server: "EUWest" })]);
  });

  it("clears whole stacks first, then the smallest, and names an account once per plan", () => {
    const accts = [view("big", { vault: { patk: 20, pdef: 20 } }), view("s1", { played: { patk: 3 } }), view("s2", { played: { patk: 5 } }), view("s3", { played: { pdef: 2 } }), view("s4", { played: { pdef: 6 } })];
    expect(planMerges(accts, quiet)).toEqual([expect.objectContaining({ giver: "s3", taker: "big", kind: "pdef", qty: 2 })]);
    // A whole stack of 9 goes before part of a stack of 5, even though it is bigger:
    // "bigA" has 3 free slots on its character, so only 3 of the 5 move this pass.
    const part = [view("bigA", { played: { junk: 13 }, vault: { patk: 30 } }), view("bigB", { vault: { pdef: 30 } }), view("g5", { played: { patk: 5 } }), view("g9", { capacity: 24, played: { pdef: 9 } })];
    const plan = planMerges(part, { ...quiet, tradeMax: 9 });
    expect(plan.map((m) => [m.giver, m.qty])).toEqual([["g9", 9], ["g5", 3]]);
  });

  it("plans at most `max` merges", () => {
    const accts = [view("big1", { vault: { patk: 30 } }), view("big2", { vault: { pdef: 30 } }), view("g1", { played: { patk: 2 } }), view("g2", { played: { pdef: 2 } })];
    expect(planMerges(accts, { ...quiet, max: 1 })).toHaveLength(1);
    expect(planMerges(accts, quiet)).toHaveLength(2);
    expect(planMerges(accts, { ...quiet, max: 0 })).toEqual([]);
  });

  it("gives the same plan whatever order the views come in", () => {
    const r = rng(11);
    const kinds = Object.keys(POTION_INFO).slice(0, 4);
    const accts = Array.from({ length: 40 }, (_, i) => {
      const played: Record<string, number> = {};
      const vault: Record<string, number> = {};
      for (const k of kinds) {
        played[k] = Math.floor(r() * 3);
        vault[k] = Math.floor(r() * 7);
      }
      return view(`acct${i}`, { played, vault, online: i % 3 !== 0, idle: i % 3 !== 0, server: i % 2 ? "USWest" : "USEast", communism: i % 7 === 0 });
    });
    for (const mode of ["quiet", "online"] as const) {
      const base = JSON.stringify(planMerges(accts, { ...quiet, mode }));
      expect(JSON.parse(base).length).toBeGreaterThan(0);
      for (const seed of [1, 2, 3]) expect(JSON.stringify(planMerges(shuffled(accts, seed), { ...quiet, mode }))).toBe(base);
    }
  });
});

describe("evacuating one-character bots", () => {
  /** One 8-slot bot per count, named b00, b01, …, holding that many items. */
  const bots = (counts: number[], s: Spec = {}) => counts.map((n, i) => view(`b${String(i).padStart(2, "0")}`, { capacity: 8, played: n ? { junk: n } : {}, ...s }));

  it("does nothing while enough bots stand empty", () => {
    expect(planEvacuation(bots([0, 3, 4, 5, 6, 7, 7, 7, 8, 8]), quiet)).toEqual([]);
  });

  it("has the least-full bot give to the fullest bot with room, never to an empty one", () => {
    expect(planEvacuation(bots([2, 3, 4, 5, 6, 7, 7, 7, 8, 8]), quiet)).toEqual([{ giver: "b00", taker: "b05", instanceIds: ["b00:p:junk:0"], server: "USWest" }]);
    // One empty bot of twenty is too few, but the only bots with room are the giver and the empty one.
    expect(planEvacuation(bots([0, 1, ...Array(18).fill(8)]), quiet)).toEqual([]);
  });

  it("never fills a bot emptier than the giver", () => {
    // "t" holds less than "g" and none of its items may move, so it is no giver itself: still, "g" does not fill it.
    const accts = [view("g", { capacity: 8, played: { junk: 3 } }), view("t", { capacity: 8, played: { junk: 2 }, reserved: ["t:p:junk:0", "t:p:junk:1"] }), ...bots(Array(8).fill(8))];
    expect(planEvacuation(accts, quiet)).toEqual([]);
    expect(pairs(planEvacuation([...accts, view("u", { capacity: 8, played: { junk: 3 } })], quiet))).toEqual([["g", "u"]]);
  });

  it("moves a trade's worth at most", () => {
    const pair = [view("a", { capacity: 24, played: { junk: 12 } }), view("b", { capacity: 24, played: { junk: 12 } })];
    const [m] = planEvacuation(pair, quiet);
    expect(m).toMatchObject({ giver: "a", taker: "b" });
    expect(m.instanceIds).toHaveLength(8);
  });

  it("leaves spoken-for items and the vault alone", () => {
    const accts = [view("g", { capacity: 8, played: { junk: 3 }, vault: { patk: 5 }, reserved: ["g:p:junk:0"] }), view("t", { capacity: 8, played: { junk: 4 } })];
    expect(planEvacuation(accts, quiet)).toEqual([{ giver: "g", taker: "t", instanceIds: ["g:p:junk:1", "g:p:junk:2"], server: "USWest" }]);
  });

  it("counts slots the view does not know: a bot holding one is never emptied, and a taker's room is what is really free", () => {
    const g = view("g", { capacity: 8, played: { junk: 1 } });
    const t = view("t", { capacity: 8, played: { junk: 4 } });
    // The giver holds an unknown item besides its junk: it would never stand empty.
    expect(planEvacuation([{ ...g, played: { ...g.played, held: 2 } }, t], quiet)).toEqual([]);
    // The taker has only one slot really free.
    const plan = planEvacuation([view("g2", { capacity: 8, played: { junk: 3 } }), { ...t, played: { ...t.played, held: 7 } }], quiet);
    expect(plan).toEqual([expect.objectContaining({ giver: "g2", taker: "t", instanceIds: ["g2:p:junk:0"] })]);
  });

  it("only evacuates one-character accounts", () => {
    expect(planEvacuation(bots([2, 3, 4, 5, 6, 7, 7, 7, 8, 8], { chars: 2 }), quiet)).toEqual([]);
  });

  it("online, needs both bots idle on one server", () => {
    const accts = [view("g", { capacity: 8, played: { junk: 1 }, server: "USEast" }), view("t", { capacity: 8, played: { junk: 4 }, server: "USWest" })];
    expect(planEvacuation(accts, online)).toEqual([]);
    expect(planEvacuation([{ ...accts[0], server: "USWest" }, accts[1]], online)).toEqual([expect.objectContaining({ giver: "g", taker: "t", server: "USWest" })]);
    expect(planEvacuation([{ ...accts[0], ...offline }, accts[1]], quiet)).toEqual([expect.objectContaining({ giver: "g", taker: "t", server: "USWest" })]);
  });

  it("never moves items across communism and standard", () => {
    const accts = [view("g", { capacity: 8, played: { junk: 1 } }), view("t", { capacity: 8, communism: true, played: { junk: 4 } })];
    expect(planEvacuation(accts, quiet)).toEqual([]);
  });

  it("evacuates as many bots as it takes to bring the empty share back, each in one move", () => {
    const plan = planEvacuation(bots(Array.from({ length: 30 }, (_, i) => 1 + (i % 7))), quiet);
    expect(plan).toHaveLength(3);
    const names = plan.flatMap((m) => [m.giver, m.taker]);
    expect(new Set(names).size).toBe(names.length);
    expect(planEvacuation(bots(Array.from({ length: 30 }, (_, i) => 1 + (i % 7))), { ...quiet, max: 2 })).toHaveLength(2);
  });

  it("reports each group's empty bots", () => {
    const counts = emptyBots([...bots([0, 2, 0]), view("c", { communism: true, capacity: 8 }), view("two", { chars: 2 })]);
    expect(counts.get(groupKey({ communism: false, seasonal: false }))).toEqual({ accounts: 3, empty: 2 });
    expect(counts.get(groupKey({ communism: true, seasonal: false }))).toEqual({ accounts: 1, empty: 1 });
    expect(counts.size).toBe(2);
  });
});

describe("a node with thousands of accounts", () => {
  function roster(n: number, seed: number): AcctView[] {
    const r = rng(seed);
    const kinds = Object.keys(POTION_INFO);
    return Array.from({ length: n }, (_, i) => {
      const played: Record<string, number> = {};
      const vault: Record<string, number> = {};
      for (let k = 0; k < 4; k++) {
        const id = kinds[Math.floor(r() * kinds.length)];
        played[id] = (played[id] ?? 0) + Math.floor(r() * 3);
        vault[id] = (vault[id] ?? 0) + Math.floor(r() * 6);
      }
      const on = i % 4 === 0;
      return view(`acct${i}`, { capacity: 16, played, vault, communism: i % 5 === 0, seasonal: i % 2 === 0, server: ["USWest", "USEast", "EUWest"][i % 3], online: on, idle: on });
    });
  }
  const timed = <T>(fn: () => T): [T, number] => {
    const t0 = performance.now();
    const out = fn();
    return [out, performance.now() - t0];
  };

  it("plans 2,000 accounts in well under 100 ms, each account in one move at most", () => {
    const accts = roster(2000, 5);
    const byGuid = new Map(accts.map((a) => [a.botGuid, a]));
    planMerges(accts, { ...quiet, max: 2000 }); // warm up
    for (const mode of ["quiet", "online"] as const) {
      const [plan, ms] = timed(() => planMerges(accts, { ...quiet, mode, max: 2000 }));
      expect(ms).toBeLessThan(100);
      expect(plan.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const m of plan as Merge[]) {
        const g = byGuid.get(m.giver)!;
        const t = byGuid.get(m.taker)!;
        expect(groupKey(g)).toBe(groupKey(t));
        expect(seen.has(m.giver) || seen.has(m.taker)).toBe(false);
        seen.add(m.giver);
        seen.add(m.taker);
        expect(m.qty).toBe(m.onCharacter.length + m.fromVault.length);
        expect(m.qty).toBeLessThanOrEqual(8);
        const mine = new Set([...g.played.items, ...(g.vault?.items ?? [])].filter((i) => i.itemId === m.kind).map((i) => i.instanceId));
        for (const id of [...m.onCharacter, ...m.fromVault]) expect(mine.has(id)).toBe(true);
        if (mode === "online") expect(g.server).toBe(t.server);
      }
    }
    const [evac, ms] = timed(() => planEvacuation(accts, { ...quiet, max: 2000 }));
    expect(ms).toBeLessThan(100);
    for (const m of evac) expect(groupKey(byGuid.get(m.giver)!)).toBe(groupKey(byGuid.get(m.taker)!));
  });

  it("stays fast when almost nobody has room for anybody", () => {
    // 2,000 small stacks of one kind, each holder with exactly one free slot.
    const accts = Array.from({ length: 2000 }, (_, i) => view(`a${i}`, { capacity: 1 + (i % 15), played: { patk: i % 15 }, vault: null }));
    const [plan, ms] = timed(() => planMerges(accts, { ...quiet, max: 2000 }));
    expect(ms).toBeLessThan(100);
    // Only one-potion stacks fit a one-slot taker.
    for (const m of plan) expect(m.qty).toBe(1);
  });
});
