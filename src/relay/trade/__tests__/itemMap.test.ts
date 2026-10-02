import { describe, expect, it } from "vitest";
import { isPoolItem, isSkinType, toCatalogId, toObjType } from "../itemMap";

describe("item map", () => {
  it("tradeable skins are catalog items like any other; the old skin:<type> ids still resolve to their type", () => {
    expect(toCatalogId(2592)).toBe("pdef");
    expect(toObjType("pdef")).toBe(2592);
    expect(toCatalogId(8827)).toBe("agent_skin");
    expect(toObjType("agent_skin")).toBe(8827);
    expect(toObjType("skin:8827")).toBe(8827);
    // A skin the catalog lists is a pool item, not a "skin type" held back for operator deposits.
    expect(isSkinType(8827)).toBe(false);
    expect(isSkinType(2592)).toBe(false);
    expect(isPoolItem(8827)).toBe(true);
    expect(isPoolItem(2592)).toBe(true);
    expect(toCatalogId(999999)).toBeUndefined();
  });
});
