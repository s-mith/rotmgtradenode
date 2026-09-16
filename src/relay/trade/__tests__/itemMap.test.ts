import { describe, expect, it } from "vitest";
import { isPoolItem, isSkinType, toCatalogId, toObjType } from "../itemMap";

describe("item map", () => {
  it("knows skins as skin:<type> in communism without making them pool items", () => {
    expect(toCatalogId(2592)).toBe("pdef");
    expect(toObjType("pdef")).toBe(2592);
    expect(toCatalogId(8827)).toBe("skin:8827");
    expect(toObjType("skin:8827")).toBe(8827);
    expect(isSkinType(8827)).toBe(true);
    expect(isSkinType(2592)).toBe(false);
    expect(isPoolItem(8827)).toBe(false);
    expect(isPoolItem(2592)).toBe(true);
    expect(toCatalogId(999999)).toBeUndefined();
  });
});
