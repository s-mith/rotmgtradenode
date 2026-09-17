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

describe("BotPool.setEmail", () => {
  it("replaces the record under the new address, keeping the alias and choices, and refuses a collision", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { BotPool, deriveBotGuid } = await import("../botPool");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
    const pool = BotPool.at(dir);
    pool.addPulled({ guid: "typo@hotmail.com", password: "pw", alias: "tipsticky", seasonal: false, charId: 12 });
    pool.addPulled({ guid: "other@hotmail.com", password: "pw2", alias: "other" });
    const acc = pool.byGuid("typo@hotmail.com")!;
    expect(pool.setEmail(acc, "other@hotmail.com")).toEqual({ error: expect.stringContaining("already uses that email") });
    const moved = pool.setEmail(acc, "Right@Hotmail.com");
    expect("error" in moved).toBe(false);
    const next = moved as Exclude<typeof moved, { error: string }>;
    expect(next.guid).toBe("right@hotmail.com");
    expect(next.botGuid).toBe(deriveBotGuid("right@hotmail.com"));
    expect({ alias: next.alias, seasonal: next.seasonal, charId: next.info.charId, password: next.info.password }).toEqual({ alias: "tipsticky", seasonal: false, charId: 12, password: "pw" });
    expect(pool.byGuid("typo@hotmail.com")).toBeUndefined();
    expect(pool.byBotGuid(acc.botGuid)).toBeUndefined();
    expect(pool.every()).toHaveLength(2);
    // Persisted: a fresh pool over the same file reads the new address.
    expect(BotPool.at(dir).byGuid("right@hotmail.com")?.alias).toBe("tipsticky");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
