// The probe's reading of char/list: the character that would log in decides
// the season and backpack, not the first one listed.
import { describe, expect, it } from "vitest";
import { fromCharList } from "../accountProbe";
import type { CharList } from "../../realm/api";

const cl: CharList = {
  nextCharId: 20, maxNumChars: 5, charIds: [12, 14], seasonal: true, tutorialDone: true, hasBackpack: true, backpackSlots: 8,
  chars: [
    { id: 12, objectType: 782, level: 1, seasonal: true, dead: false, backpackSlots: 8, hasBackpack: true },
    { id: 14, objectType: 782, level: 20, seasonal: false, dead: false, backpackSlots: 16, hasBackpack: true },
  ],
};

describe("fromCharList", () => {
  it("describes the first character by default and the preferred one when the account still has it", () => {
    expect(fromCharList(cl, null).loaded).toMatchObject({ id: 12, seasonal: true, backpackSlots: 8 });
    expect(fromCharList(cl, 14).loaded).toMatchObject({ id: 14, seasonal: false, backpackSlots: 16 });
    expect(fromCharList(cl, 99).loaded).toMatchObject({ id: 12 });
    expect(fromCharList({ ...cl, charIds: [], chars: [] }, null).loaded).toBeNull();
    expect(fromCharList(cl, null).tutorialDone).toBe(true);
  });
});
