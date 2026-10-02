// The accepted-items policy: rules by category and tier, pins that beat
// them, normalization of what a form or a settings file hands in, and the
// site's validators following the registered policy.
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG } from "../catalog";
import { acceptedIds, acceptsEverything, acceptsItem, COMMUNISM_ITEM_POLICY, communismTakes, DEFAULT_ITEM_POLICY, normalizeItemPolicy, registerItemPolicy, type ItemPolicy } from "../itemPolicy";
import { parseDeclaredItems } from "../validation";
import { parseWantInput } from "../offers";

const only = (over: Partial<ItemPolicy>): ItemPolicy => ({ ...DEFAULT_ITEM_POLICY, minTier: { ...DEFAULT_ITEM_POLICY.minTier }, overrides: {}, ...over });
afterEach(() => registerItemPolicy(null));

describe("item policy", () => {
  it("takes everything by default", () => {
    expect(acceptsEverything(DEFAULT_ITEM_POLICY)).toBe(true);
    expect(acceptedIds(DEFAULT_ITEM_POLICY).size).toBe(CATALOG.length);
    expect(acceptsItem(DEFAULT_ITEM_POLICY, "no-such-item")).toBe(false);
  });
  it("applies the lowest tier per gear group and the category switches", () => {
    const p = only({ potions: true, eggs: false, consumables: false, untiered: false, minTier: { Weapon: 12, Armor: null, Ring: 6, Ability: 4 } });
    const byCat = (c: string) => CATALOG.find((i) => i.category === c)!.id;
    expect(acceptsItem(p, byCat("T13 Weapon"))).toBe(true);
    expect(acceptsItem(p, byCat("T12 Weapon"))).toBe(true);
    expect(acceptsItem(p, byCat("T11 Weapon"))).toBe(false);
    expect(acceptsItem(p, byCat("T13 Armor"))).toBe(false);
    expect(acceptsItem(p, byCat("T6 Ring"))).toBe(true);
    expect(acceptsItem(p, byCat("T5 Ring"))).toBe(false);
    expect(acceptsItem(p, byCat("T5 Ability"))).toBe(true);
    expect(acceptsItem(p, "pdef")).toBe(true);
    expect(acceptsItem(p, byCat("Egg"))).toBe(false);
    expect(acceptsItem(p, byCat("Consumable"))).toBe(false);
    expect(acceptsItem(p, byCat("UT/ST"))).toBe(false);
    expect(acceptsEverything(p)).toBe(false);
  });
  it("pins beat the rules either way", () => {
    const ut = CATALOG.find((i) => i.category === "UT/ST")!.id;
    const p = only({ untiered: false, overrides: { [ut]: true, pdef: false } });
    expect(acceptsItem(p, ut)).toBe(true);
    expect(acceptsItem(p, "pdef")).toBe(false);
    expect(acceptsItem(p, "patk")).toBe(true);
  });
  it("normalizes a form or file: unknown fields dropped, bad tiers defaulted, pins on unknown items dropped", () => {
    const p = normalizeItemPolicy({ potions: "yes", eggs: false, minTier: { Weapon: "10", Armor: null, Ring: -3, Ability: 2.5, Bogus: 1 }, overrides: { pdef: false, nope: true, patk: "x" }, extra: 1 });
    expect(p).toEqual({ potions: true, eggs: false, consumables: true, lore: true, treasures: true, skins: true, untiered: true, minTier: { Weapon: 10, Armor: null, Ring: 0, Ability: 0 }, overrides: { pdef: false } });
    expect(normalizeItemPolicy(undefined)).toEqual(DEFAULT_ITEM_POLICY);
  });
  it("the site's declared deposits and offer wants follow the registered policy", () => {
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 1 }])).toMatchObject({ ok: true });
    registerItemPolicy(() => only({ overrides: { pdef: false } }));
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 1 }])).toMatchObject({ ok: false, error: expect.stringContaining("not taken on this node") });
    expect(parseDeclaredItems([{ itemId: "patk", qty: 1 }])).toMatchObject({ ok: true });
    expect(parseWantInput([{ itemId: "pdef", qty: 1 }])).toMatchObject({ ok: false, error: expect.stringContaining("not taken") });
    expect(parseWantInput([{ itemId: "patk", qty: 1 }])).toMatchObject({ ok: true });
  });
  it("communism accepts by its own fixed list, whatever the node's setting says", () => {
    // The list taken from the owner's node: every category on, a set of items pinned off.
    expect(acceptedIds(COMMUNISM_ITEM_POLICY).size).toBeGreaterThan(600);
    expect(communismTakes("energy_staff")).toBe(false);
    expect(communismTakes("pdef")).toBe(true);
    registerItemPolicy(() => only({ overrides: { pdef: false } }));
    expect(communismTakes("pdef")).toBe(true);
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 1 }], true)).toMatchObject({ ok: true });
    expect(parseDeclaredItems([{ itemId: "energy_staff", qty: 1 }], true)).toMatchObject({ ok: false, error: expect.stringContaining("not taken into communism") });
    expect(parseDeclaredItems([{ itemId: "pdef", qty: 1 }])).toMatchObject({ ok: false });
  });
});
