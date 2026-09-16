import { describe, expect, it } from "vitest";
import { fitsLine, parseWantInput, pickForLines, shortfall, wantFromWire, wantToWire, type HeldItem } from "../offers";

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
