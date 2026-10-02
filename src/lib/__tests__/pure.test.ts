import { describe, expect, it } from "vitest";
import { fragmentWithdraw } from "../fragmentWithdraw";
import { parseDeclaredItems, parseDepositRequest } from "../validation";
import { bestFitBot, planPotionFill, planPotionWithdraw } from "../potionPlan";

const IDS = { normal: "patk", greater: "gpatk" };

describe("fragmentWithdraw", () => {
  const bots = [
    { botGuid: "b", inventory: new Map([["patk", 2], ["dbow", 1]]) },
    { botGuid: "a", inventory: new Map([["patk", 1]]) },
  ];
  it("splits across bots deterministically, guid order", () => {
    const r = fragmentWithdraw([{ itemId: "patk", qty: 3 }, { itemId: "dbow", qty: 1 }], bots);
    expect(r).toEqual({ ok: true, fragments: [
      { botGuid: "a", items: [{ itemId: "patk", qty: 1 }] },
      { botGuid: "b", items: [{ itemId: "dbow", qty: 1 }, { itemId: "patk", qty: 2 }] },
    ] });
  });
  it("reports the shortfall when stock doesn't cover", () => {
    const r = fragmentWithdraw([{ itemId: "patk", qty: 5 }], bots);
    expect(r).toEqual({ ok: false, missing: [{ itemId: "patk", qty: 2 }] });
  });
});

describe("declared deposit items", () => {
  it("accepts a catalog list, merges repeats, and sizes the deposit from it", () => {
    expect(parseDeclaredItems(undefined)).toEqual({ ok: true });
    expect(parseDeclaredItems([])).toEqual({ ok: true });
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 2 }, { itemId: "pdef" }, { itemId: "gpdef", qty: 1 }])).toEqual({ ok: true, items: [{ itemId: "pdef", qty: 3 }, { itemId: "gpdef", qty: 1 }] });
    // The trade size is as many items as the player brings, 1 to 24: `slots`
    // says so outright, the old `itemCount` means the same, and without
    // either the declared list's total does, else 8.
    const req = parseDepositRequest({ ign: "Someone", server: "USEast", items: [{ itemId: "pdef", qty: 5 }] });
    expect(req).toMatchObject({ ok: true, slots: 5, items: [{ itemId: "pdef", qty: 5 }] });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", items: [{ itemId: "pdef", qty: 12 }] })).toMatchObject({ ok: true, slots: 12 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 16, items: [{ itemId: "pdef", qty: 5 }] })).toMatchObject({ ok: true, slots: 16 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 3 })).toMatchObject({ ok: true, slots: 3 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 40 })).toMatchObject({ ok: true, slots: 24 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast" })).toMatchObject({ ok: true, slots: 8 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 16 })).toMatchObject({ ok: true, slots: 16 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: "8" })).toMatchObject({ ok: true, slots: 8 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 12 })).toMatchObject({ ok: true, slots: 12 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 25 })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 0 })).toMatchObject({ ok: false });
    // The legacy count is a trade size: anything past one trade clamps to a full one.
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 65 })).toMatchObject({ ok: true, slots: 24 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 0 })).toMatchObject({ ok: false });
  });
  it("rejects unknown items, bad counts, and oversized lists", () => {
    expect(parseDeclaredItems([{ itemId: "nope", qty: 1 }])).toMatchObject({ ok: false });
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 0 }])).toMatchObject({ ok: false });
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 65 }])).toMatchObject({ ok: false });
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 40 }, { itemId: "gpdef", qty: 40 }])).toMatchObject({ ok: false });
    expect(parseDeclaredItems("pdef")).toMatchObject({ ok: false });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", items: [{ itemId: "nope" }] })).toMatchObject({ ok: false });
  });
});

describe("planPotionFill", () => {
  it("prefers greaters and tops off an odd request with a normal", () => {
    expect(planPotionFill(5, 10, 10, IDS)).toEqual({ items: { gpatk: 2, patk: 1 }, pointsFilled: 5, shortfall: 0, overshoot: 0 });
  });
  it("overshoots by one greater when no normal is left for an odd point", () => {
    expect(planPotionFill(3, 0, 5, IDS)).toEqual({ items: { gpatk: 2 }, pointsFilled: 4, shortfall: 0, overshoot: 1 });
  });
  it("reports a shortfall", () => {
    expect(planPotionFill(6, 1, 1, IDS)).toMatchObject({ pointsFilled: 3, shortfall: 3 });
  });
});

describe("planPotionWithdraw", () => {
  it("packs the richest bot first and splits a big bot into trades", () => {
    const plan = planPotionWithdraw(20, [
      { botGuid: "x", normal: 2, greater: 0 },
      { botGuid: "y", normal: 0, greater: 12 },
    ], IDS, 8);
    expect(plan.pointsFilled).toBe(20);
    expect(plan.fragments[0].botGuid).toBe("y");
    expect(plan.fragments.every((f) => Object.values(f.items).reduce((a, b) => a + b, 0) <= 8)).toBe(true);
  });
  it("gives each bot trades as big as its own trade slots", () => {
    const stock = [
      { botGuid: "big", normal: 0, greater: 12 },
      { botGuid: "small", normal: 0, greater: 12 },
    ];
    const caps: Record<string, number> = { big: 24, small: 8 };
    const plan = planPotionWithdraw(30, stock, IDS, (g) => caps[g]);
    expect(plan.pointsFilled).toBe(30);
    // The 24-slot bot hands over its 12 in one trade, where an 8-slot limit made two.
    expect(plan.fragments).toEqual([{ botGuid: "big", items: { [IDS.greater]: 12 } }, { botGuid: "small", items: { [IDS.greater]: 3 } }]);
    expect(planPotionWithdraw(30, stock, IDS).fragments).toHaveLength(3);
  });
});


describe("planPotionWithdraw, best fit (advanced management)", () => {
  it("takes the request from the one bot whose stock just covers it, keeping the big stacks whole", () => {
    const stock = [
      { botGuid: "big", normal: 0, greater: 40 },
      { botGuid: "fits", normal: 2, greater: 4 },
      { botGuid: "small", normal: 3, greater: 0 },
    ];
    // Without it the biggest stack goes first, and the odd point comes from a second bot.
    expect(planPotionWithdraw(9, stock, IDS, 8).fragments.map((f) => f.botGuid)).toEqual(["big", "fits"]);
    const plan = planPotionWithdraw(9, stock, IDS, 8, { bestFit: true });
    expect(plan).toMatchObject({ pointsFilled: 9, shortfall: 0, overshoot: 0 });
    expect(plan.fragments).toEqual([{ botGuid: "fits", items: { [IDS.greater]: 4, [IDS.normal]: 1 } }]);
  });
  it("puts fewer trades before less left over", () => {
    const stock = [
      // 16 points in 16 normals: two 8-slot trades, nothing left over.
      { botGuid: "a-normals", normal: 16, greater: 0 },
      // 8 greaters: one trade, with plenty left over.
      { botGuid: "b-greaters", normal: 50, greater: 8 },
    ];
    expect(bestFitBot(16, stock, IDS, () => 8)?.botGuid).toBe("b-greaters");
    // With 16-slot trades both are one trade: the closer fit wins.
    expect(bestFitBot(16, stock, IDS, () => 16)?.botGuid).toBe("a-normals");
  });
  it("prefers no wasted point, and lets a bot that covers alone overshoot rather than call in a second", () => {
    const stock = [
      { botGuid: "a", normal: 0, greater: 2 },
      { botGuid: "b", normal: 3, greater: 0 },
    ];
    expect(bestFitBot(3, stock, IDS, () => 8)?.botGuid).toBe("b");
    const onlyGreaters = [
      { botGuid: "a", normal: 0, greater: 5 },
      { botGuid: "b", normal: 1, greater: 0 },
    ];
    const plan = planPotionWithdraw(9, onlyGreaters, IDS, 8, { bestFit: true });
    expect(plan).toMatchObject({ pointsFilled: 10, overshoot: 1 });
    expect(plan.fragments).toEqual([{ botGuid: "a", items: { [IDS.greater]: 5 } }]);
  });
  it("falls back to the biggest stacks first when no one bot covers the request", () => {
    const stock = [
      { botGuid: "x", normal: 4, greater: 0 },
      { botGuid: "y", normal: 0, greater: 6 },
    ];
    expect(bestFitBot(20, stock, IDS, () => 8)).toBeNull();
    expect(planPotionWithdraw(14, stock, IDS, 8, { bestFit: true })).toEqual(planPotionWithdraw(14, stock, IDS, 8));
  });
});
