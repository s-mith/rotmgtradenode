import { describe, expect, it } from "vitest";
import { fragmentWithdraw } from "../fragmentWithdraw";
import { parseDeclaredItems, parseDepositRequest } from "../validation";
import { planPotionFill, planPotionWithdraw } from "../potionPlan";
import { epochIndex, pointsAt, roundPoints, NEW_RULES_AT, ENCHANT_RULES_AT, MASK_RULES_AT } from "../leaderboard";

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
    // The trade size is one of the two bot shapes: 8 unless the declared
    // list needs a backpack bot; `slots` says so outright; the old
    // `itemCount` upper bound maps onto the smallest shape that fits.
    const req = parseDepositRequest({ ign: "Someone", server: "USEast", items: [{ itemId: "pdef", qty: 5 }] });
    expect(req).toMatchObject({ ok: true, slots: 8, items: [{ itemId: "pdef", qty: 5 }] });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", items: [{ itemId: "pdef", qty: 12 }] })).toMatchObject({ ok: true, slots: 16 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 16, items: [{ itemId: "pdef", qty: 5 }] })).toMatchObject({ ok: true, slots: 16 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 3 })).toMatchObject({ ok: true, slots: 8 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast" })).toMatchObject({ ok: true, slots: 8 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 16 })).toMatchObject({ ok: true, slots: 16 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: "8" })).toMatchObject({ ok: true, slots: 8 });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", slots: 12 })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ ign: "Someone", server: "USEast", itemCount: 65 })).toMatchObject({ ok: false });
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
});

describe("epoch scoring", () => {
  it("buckets by cutoff", () => {
    expect(epochIndex(NEW_RULES_AT - 1)).toBe(0);
    expect(epochIndex(NEW_RULES_AT)).toBe(1);
    expect(epochIndex(ENCHANT_RULES_AT)).toBe(2);
    expect(epochIndex(MASK_RULES_AT + 1)).toBe(4);
  });
  it("prices potions and specials per epoch, with the enchant multiplier from epoch 3", () => {
    expect(pointsAt("patk", 0)).toBe(0.25);
    expect(pointsAt("patk", NEW_RULES_AT)).toBe(0.15);
    expect(pointsAt("sep", NEW_RULES_AT)).toBe(3);
    expect(pointsAt("ubatk", NEW_RULES_AT, 1)).toBe(1); // no multiplier in epoch 2
    expect(pointsAt("ubatk", ENCHANT_RULES_AT, 1)).toBe(1.25);
    expect(pointsAt("superior_mask_of_anubis", MASK_RULES_AT)).toBe(3);
  });
  it("rounds on a ten-thousandths grid", () => {
    expect(roundPoints(0.1 + 0.2)).toBe(0.3);
  });
});
