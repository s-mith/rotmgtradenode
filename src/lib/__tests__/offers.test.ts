import { describe, expect, it } from "vitest";
import { coverLines, fitsLine, parseWantInput, pickForLines, shortfall, wantFromWire, wantToWire, type HeldItem, type WantLine } from "../offers";
import { ITEM_BY_ID } from "../catalog";
import { conditionWords, wantLineWords } from "../../shared/wantWords";

const held = (instanceId: string, itemId: string, enchantIds: number[] = [], createdAt = 1): HeldItem => ({ instanceId, itemId, enchantIds, createdAt });

describe("offer matching", () => {
  it("parses want lines and rejects unknown items, bad slots, and too many", () => {
    const ok = parseWantInput([{ itemId: "pdef", qty: 2 }, { itemId: "patk", slotsExact: 1 }]);
    expect(ok).toMatchObject({ ok: true, want: [{ itemId: "pdef", qty: 2, slotsMin: 0, slotsExact: null }, { itemId: "patk", qty: 1, slotsMin: 1, slotsExact: 1 }] });
    expect(parseWantInput([{ itemId: "nope" }])).toMatchObject({ ok: false });
    expect(parseWantInput([{ itemId: "pdef", slotsMin: 9 }])).toMatchObject({ ok: false });
    expect(parseWantInput([])).toMatchObject({ ok: false });
    expect(parseWantInput([{ itemId: "pdef", qty: 25 }])).toMatchObject({ ok: false });
  });
  it("hands out the plainest copies first and never the same item twice", () => {
    const p = parseWantInput([{ itemId: "pdef", qty: 2 }]);
    if (!p.ok) throw new Error(p.error);
    const items = [held("a", "pdef", [1, 2]), held("b", "pdef", [], 5), held("c", "pdef", [], 2), held("d", "patk")];
    const picks = pickForLines(p.want, items);
    expect(picks?.map((i) => i.instanceId)).toEqual(["c", "b"]);
    expect(pickForLines(p.want, [held("a", "pdef")])).toBeNull();
    expect(shortfall(p.want, [held("a", "pdef")])).toMatch(/need 2×/);
  });
  it("an exact-slot line only takes items with that many enchantments", () => {
    const p = parseWantInput([{ itemId: "pdef", slotsExact: 0 }]);
    if (!p.ok) throw new Error(p.error);
    expect(fitsLine(p.want[0], held("a", "pdef", [3]))).toBe(false);
    expect(fitsLine(p.want[0], held("b", "pdef"))).toBe(true);
  });
  it("round-trips through the wire shape", () => {
    const p = parseWantInput([{ itemId: "pdef", qty: 1, slotsMin: 1 }]);
    if (!p.ok) throw new Error(p.error);
    expect(wantFromWire(wantToWire(p.want))).toEqual(p.want);
  });
});

describe("what a player puts up against an offer's want lines", () => {
  const lines = (raw: unknown): WantLine[] => {
    const p = parseWantInput(raw);
    if (!p.ok) throw new Error(p.error);
    return p.want;
  };
  const up = (itemId: string, enchantIds: number[] | null = []) => ({ itemId, enchantIds });
  const name = (id: string) => ITEM_BY_ID.get(id)!.name;
  // Attack Bonus I is Realm enchantment 263 (realm-enchants.json).
  const ATK1 = 263;
  const withAtk1 = [{ any: [{ all: [{ kind: "ench", name: "Attack Bonus I" }] }] }];

  it("an exact cover needs every line's quantity and nothing else; a side still being filled only has to fit", () => {
    const l = lines([{ itemId: "pdef", qty: 2 }, { itemId: "patk" }]);
    expect(coverLines(l, [up("pdef"), up("patk"), up("pdef")], true)).toEqual({ ok: true });
    expect(coverLines(l, [up("pdef"), up("patk")], false)).toEqual({ ok: true });
    expect(coverLines(l, [up("pdef"), up("patk")], true)).toEqual({ ok: false, why: `still missing 1× ${name("pdef")}` });
    expect(coverLines(l, [], true)).toEqual({ ok: false, why: `still missing 2× ${name("pdef")}` });
  });

  it("names what does not belong: another item, one copy too many, the wrong enchantments", () => {
    const l = lines([{ itemId: "pdef", qty: 2 }]);
    expect(coverLines(l, [up("pdef"), up("patk")], false)).toEqual({ ok: false, why: `${name("patk")} is not part of this trade; take it out` });
    expect(coverLines(l, [up("pdef"), up("pdef"), up("pdef")], false)).toEqual({ ok: false, why: `the trade takes 2× ${name("pdef")} and you put up 3; take 1 out` });
    const plain = lines([{ itemId: "pdef", slotsExact: 0 }]);
    expect(coverLines(plain, [up("pdef", [ATK1])], true)).toEqual({ ok: false, why: `your ${name("pdef")} does not fit: the trade asks for ${name("pdef")} with no enchantments` });
  });

  it("enchantment filters are checked per copy, and an unreadable record only passes a line that asks nothing of enchantments", () => {
    const l = lines([{ itemId: "pdef", slotsMin: 1, enchants: withAtk1 }]);
    expect(coverLines(l, [up("pdef", [ATK1])], true)).toEqual({ ok: true });
    expect(coverLines(l, [up("pdef", [ATK1 + 1])], true)).toMatchObject({ ok: false, why: expect.stringContaining("one of them Attack Bonus I") });
    expect(coverLines(l, [up("pdef", null)], true)).toEqual({ ok: false, why: `the bot cannot read the enchantments on your ${name("pdef")}; put up another copy` });
    expect(coverLines(lines([{ itemId: "pdef" }]), [up("pdef", null)], true)).toEqual({ ok: true });
  });

  it("a mixed side goes to the most particular line first", () => {
    // One copy must carry Attack Bonus I, the other may be anything: the enchanted copy has to go to the filtered line.
    const l = lines([{ itemId: "pdef", slotsMin: 1, enchants: withAtk1 }, { itemId: "pdef" }]);
    expect(coverLines(l, [up("pdef"), up("pdef", [ATK1])], true)).toEqual({ ok: true });
    expect(coverLines(l, [up("pdef"), up("pdef")], true)).toMatchObject({ ok: false });
  });

  it("says a line's conditions in words", () => {
    const [l] = lines([{ itemId: "pdef", qty: 2, slotsMin: 1, enchants: withAtk1 }]);
    expect(conditionWords(l)).toBe("with 1+ enchantment, one of them Attack Bonus I");
    expect(wantLineWords(l, name)).toBe(`2× ${name("pdef")} with 1+ enchantment, one of them Attack Bonus I`);
    expect(wantLineWords(lines([{ itemId: "patk" }])[0], name)).toBe(name("patk"));
  });
});
