// Enchantment filters for offer want-lines: slot-spec parsing and the matcher.
import { describe, expect, it } from "vitest";
import { matchesRule, parseSlotSpecs } from "../enchantMatch";
import { effectsOfEnchant } from "../enchantEffects";
import { allEnchants, enchantName } from "../enchants";

// A real enchant that grants HP and one that grants Attack, looked up from
// the catalog so the names used in "ench" terms are the ones the UI offers.
function enchantWith(effect: string, not?: string): number {
  const hit = allEnchants().map((e) => Number(e.realmId)).find((id) => effectsOfEnchant(id).includes(effect) && (!not || !effectsOfEnchant(id).includes(not)));
  if (hit === undefined) throw new Error(`no enchant grants ${effect}`);
  return hit;
}
const HP = enchantWith("+HP");
const ATT = enchantWith("+Attack", "+HP");
const SPD_DOWN = enchantWith("-Speed");

type Term = { kind: "ench"; name: string } | { kind: "effect"; key: string };
/** One slot filter from its "or" rows. */
const slot = (...rows: Term[][]) => ({ any: rows.map((all) => ({ all })) });
const ANY = slot();


describe("slot filters", () => {
  it("parses rows, dedupes terms, drops empty rows and trailing open slots, and rejects junk", () => {
    expect(parseSlotSpecs(undefined)).toEqual({ ok: true, specs: [] });
    const r = parseSlotSpecs([
      { any: [{ all: [{ kind: "effect", key: "+HP" }, { kind: "effect", key: "+HP" }] }, { all: [] }, { all: [{ kind: "ench", name: " Attack Bonus III " }] }] },
      { any: [] },
      { any: [] },
    ]);
    expect(r).toEqual({ ok: true, specs: [slot([{ kind: "effect", key: "+HP" }], [{ kind: "ench", name: "Attack Bonus III" }])] });
    // An open slot before a filtered one stays, since it holds a position.
    expect(parseSlotSpecs([{ any: [] }, slot([{ kind: "effect", key: "+HP" }])])).toMatchObject({ ok: true, specs: [ANY, slot([{ kind: "effect", key: "+HP" }])] });
    expect(parseSlotSpecs("no").ok).toBe(false);
    expect(parseSlotSpecs([{ any: "no" }]).ok).toBe(false);
    expect(parseSlotSpecs([slot([{ kind: "effect", key: "HP" }])]).ok).toBe(false);
    expect(parseSlotSpecs([{ any: [{ all: [{ kind: "other" }] }] }]).ok).toBe(false);
    // Two names in one row can't both describe one enchantment.
    expect(parseSlotSpecs([slot([{ kind: "ench", name: "A" }, { kind: "ench", name: "B" }])]).ok).toBe(false);
    expect(parseSlotSpecs([slot(...Array.from({ length: 7 }, () => [{ kind: "effect", key: "+HP" } as Term]))]).ok).toBe(false);
    expect(parseSlotSpecs([ANY, ANY, slot([{ kind: "effect", key: "+HP" }])]).ok).toBe(false);
  });
});

describe("matcher", () => {
  const base = { itemId: "ubatk", slotsMin: 0, slotsExact: null, enchants: [] as ReturnType<typeof slot>[] };
  const hp = { kind: "effect", key: "+HP" } as const;
  const spd = { kind: "effect", key: "-Speed" } as const;
  it("checks the item and the slot count", () => {
    expect(matchesRule(base, "ubatk", [])).toBe(true);
    expect(matchesRule(base, "other", [])).toBe(false);
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP])).toBe(false);
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP, ATT])).toBe(true);
    // Three enchantments can't be traded, so no line ever fits such an item.
    expect(matchesRule({ ...base, slotsMin: 2 }, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false);
    expect(matchesRule(base, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false);
    expect(matchesRule({ ...base, slotsExact: 1 }, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule({ ...base, slotsExact: 1 }, "ubatk", [HP])).toBe(true);
    expect(matchesRule({ ...base, slotsExact: 0 }, "ubatk", [])).toBe(true);
  });
  it("filters each slot on its own, never reusing an enchantment", () => {
    // Slot 1 wants +HP, slot 2 wants -Speed: two different enchantments.
    const two = { ...base, slotsMin: 2, enchants: [slot([hp]), slot([spd])] };
    expect(matchesRule(two, "ubatk", [HP, SPD_DOWN])).toBe(true);
    expect(matchesRule(two, "ubatk", [SPD_DOWN, HP])).toBe(true); // order is not a slot
    expect(matchesRule(two, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule(two, "ubatk", [HP, ATT, SPD_DOWN])).toBe(false); // a third enchantment makes it untradable
    // Two slots asking for +HP need two +HP enchantments.
    const twice = { ...base, slotsMin: 2, enchants: [slot([hp]), slot([hp])] };
    expect(matchesRule(twice, "ubatk", [HP, ATT])).toBe(false);
    expect(matchesRule(twice, "ubatk", [HP, HP])).toBe(true);
    // An open slot takes whatever is left.
    const open = { ...base, slotsMin: 2, enchants: [ANY, slot([spd])] };
    expect(matchesRule(open, "ubatk", [SPD_DOWN, HP])).toBe(true);
    expect(matchesRule(open, "ubatk", [HP, ATT])).toBe(false);
  });
  it("ors the rows of one slot, ands the chips of one row, by name or effect", () => {
    const either = { ...base, slotsMin: 1, enchants: [slot([{ kind: "ench", name: enchantName(ATT)! }], [hp])] };
    expect(matchesRule(either, "ubatk", [ATT])).toBe(true);
    expect(matchesRule(either, "ubatk", [HP])).toBe(true);
    expect(matchesRule(either, "ubatk", [SPD_DOWN])).toBe(false);
    expect(matchesRule(either, "ubatk", [])).toBe(false);
    // Both effects on the same enchantment: two separate enchantments don't do.
    const both = { ...base, slotsMin: 1, enchants: [slot([hp, spd])] };
    expect(matchesRule(both, "ubatk", [HP, SPD_DOWN])).toBe(false);
    const tradeoff = allEnchants().map((e) => Number(e.realmId)).find((id) => effectsOfEnchant(id).includes("+HP") && effectsOfEnchant(id).includes("-Speed"));
    if (tradeoff !== undefined) expect(matchesRule(both, "ubatk", [tradeoff])).toBe(true);
  });
});
