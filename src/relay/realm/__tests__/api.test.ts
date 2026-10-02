// Parsers for the read-only account calls, against bodies shaped like the
// live ones captured 2026-09-07 (docs/relay/BACKPACKS.md §0).
import { describe, expect, it } from "vitest";
import { backpackDays, isBadCredentials, parseAccountDump, parseCalendar, parseCharListDetail, parseQuickslots, parseSeasonInfo, parseServers } from "../api";

const CHAR_LIST = `<Chars nextCharId="2" maxNumChars="1"><Char id="1"><ObjectType>782</ObjectType><Seasonal>False</Seasonal><Level>7</Level><Exp>2167</Exp><CurrentFame>2</CurrentFame><Equipment>2711,2606,2652,-1,-1,-1,-1,-1,-1,-1,-1,-1</Equipment><PCStats>x</PCStats><Dead>False</Dead><BackpackSlots>8</BackpackSlots><Has3Quickslots>0</Has3Quickslots></Char><Char id="3"><ObjectType>804</ObjectType><Seasonal>True</Seasonal><Level>1</Level><Dead>True</Dead><BackpackSlots>0</BackpackSlots></Char><Account><Name>Foo</Name><MaxNumChars>1</MaxNumChars></Account><Servers></Servers></Chars>`;

const CALENDAR = `<LoginRewards serverTime='1788754461.04813' conCurDay = '1' nonconCurDay = '3'>
<NonConsecutive days='3'>
<Login><Days>1</Days><ItemId quantity='2'>3176</ItemId><Gold>0</Gold><key>k-day1</key></Login>
<Login><Days>2</Days><ItemId quantity='3'>3180</ItemId><Gold>0</Gold><key>k-day2</key></Login>
<Login><Days>3</Days><ItemId quantity='1'>3138</ItemId><Gold>0</Gold></Login>
<Login><Days>4</Days><ItemId>-1</ItemId><Gold>100</Gold></Login>
</NonConsecutive>
<Consecutive days='1'>
<Login><Days>1</Days><ItemId>3180</ItemId><Gold>0</Gold></Login>
<Login><Days>2</Days><ItemId>-1</ItemId><Gold>50</Gold></Login>
</Consecutive>
</LoginRewards>`;

describe("parseCharListDetail", () => {
  it("reads per-character backpack, seasonal and death plus the slot count", () => {
    const d = parseCharListDetail(CHAR_LIST);
    expect(d.nextCharId).toBe(2);
    expect(d.maxNumChars).toBe(1);
    expect(d.chars).toEqual([
      { id: 1, objectType: 782, level: 7, seasonal: false, dead: false, backpackSlots: 8, hasBackpack: true, quickslots: [], equipment: [2711, 2606, 2652, -1, -1, -1, -1, -1, -1, -1, -1, -1] },
      { id: 3, objectType: 804, level: 1, seasonal: true, dead: true, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [] },
    ]);
  });
  it("rejects a body that is not a char list", () => {
    expect(() => parseCharListDetail("<Error>Account in use</Error>")).toThrow(/not a char list/);
  });
});

describe("parseCalendar", () => {
  it("reads both tracks, keys only where present, and quantity defaulting to 1", () => {
    const c = parseCalendar(CALENDAR);
    expect(c.serverTime).toBeCloseTo(1788754461.048, 2);
    expect(c.consecutiveDay).toBe(1);
    expect(c.nonconsecutiveDay).toBe(3);
    expect(c.nonconsecutive.map((d) => [d.day, d.itemType, d.quantity, d.gold, d.key])).toEqual([
      [1, 3176, 2, 0, "k-day1"], [2, 3180, 3, 0, "k-day2"], [3, 3138, 1, 0, null], [4, -1, 1, 100, null],
    ]);
    expect(c.consecutive.map((d) => [d.day, d.itemType, d.key])).toEqual([[1, 3180, null], [2, -1, null]]);
  });
  it("lists every backpack day across both tracks with claimability", () => {
    const days = backpackDays(parseCalendar(CALENDAR));
    expect(days.map((d) => [d.track, d.day.day, d.day.quantity, d.claimable])).toEqual([
      ["nonconsecutive", 2, 3, true],
      ["consecutive", 1, 1, false],
    ]);
  });
  it("rejects a body that is not a calendar", () => {
    expect(() => parseCalendar("Access denied")).toThrow(/not a login calendar/);
  });
});

describe("parseSeasonInfo", () => {
  it("reads the season clock", () => {
    const s = parseSeasonInfo('{"id": "5242959262416896", "name": "Retro Winds ", "start": 1785834001, "end": 1791277200, "popupData": "x", "forceShowFlag": "01/09/2026, 11:57:54"}');
    expect(s).toEqual({ id: "5242959262416896", name: "Retro Winds", start: 1785834001, end: 1791277200 });
  });
  it("rejects HTML and bodies without the clock", () => {
    expect(() => parseSeasonInfo("<html>400</html>")).toThrow(/not season info/);
    expect(() => parseSeasonInfo('{"name":"x"}')).toThrow(/without start/);
  });
});

describe("getCharList's backpack answer", () => {
  it("comes from BackpackSlots of the character that will load", async () => {
    const { parseCharListDetail: parse } = await import("../api");
    const withBp = parse(CHAR_LIST);
    expect(withBp.chars[0].hasBackpack).toBe(true);
    expect(withBp.chars[1].hasBackpack).toBe(false);
  });
});

const SERVERS = `<Servers><Server><Name>USEast</Name><DNS>54.234.226.24</DNS><Lat>39.0</Lat><Long>-77.5</Long><Usage>0.3</Usage><AdminOnly>false</AdminOnly></Server><Server><Name>USSouth3</Name><DNS>52.207.206.31</DNS><Lat>0</Lat><Long>0</Long><Usage>0</Usage></Server><Server><Name>Admin</Name><DNS>1.2.3.4</DNS><Usage>0.9</Usage><AdminOnly>true</AdminOnly></Server></Servers>`;

describe("parseServers", () => {
  it("reads every server's name, host and load", () => {
    expect(parseServers(SERVERS)).toEqual([
      { name: "USEast", dns: "54.234.226.24", usage: 0.3, adminOnly: false },
      { name: "USSouth3", dns: "52.207.206.31", usage: 0, adminOnly: false },
      { name: "Admin", dns: "1.2.3.4", usage: 0.9, adminOnly: true },
    ]);
  });
  it("rejects a body that is not a server list", () => {
    expect(() => parseServers("<Error>Account in use</Error>")).toThrow(/not a server list/);
  });
});

describe("isBadCredentials", () => {
  it("knows both of Realm's wrong-password answers", () => {
    expect(isBadCredentials("<Error>Account credentials not valid</Error>")).toBe(true);
    // Build 7's generic refusal: live on 2026-09-17 this same string came back for a
    // wrong password, a right one and an account that does not exist.
    expect(isBadCredentials("<Error>WebChangePasswordDialog.passwordError</Error>")).toBe(true);
    expect(isBadCredentials("<Error>Account in use (5 seconds until timeout)</Error>")).toBe(false);
    expect(isBadCredentials(CHAR_LIST)).toBe(false);
  });
});

// An account snapshot shaped like the one Realm serves account tools (docs/relay/STORAGE.md "The account snapshot"):
// copy ids after `#`, per-character and account-level ItemData records. Records: entries from byte 3, LE uint16, 0xFFFD ends,
// 0xFFFE locked, 0xFFFF empty. rec(17) = 00 5402 1100 feff ffff fdff; rec(17, 3) has two ids; NONE = 00 5402 fdff.
const rec = (...ids: number[]): string => {
  const b = Buffer.alloc(3 + 2 * 4);
  b[0] = 0; b.writeUInt16LE(596, 1);
  const entries = [...ids, 0xfffe, 0xffff, 0xfffd].slice(0, 4);
  entries.forEach((e, i) => b.writeUInt16LE(e, 3 + 2 * i));
  return b.toString("base64url") + "=";
};
const SNAPSHOT = `<Chars nextCharId="5" maxNumChars="3">
<Char id="1"><ObjectType>782</ObjectType><Seasonal>False</Seasonal><Level>20</Level><Equipment>596#c-a,-1,2652,-1,596#c-b,596,596,-1,-1,-1,-1,-1</Equipment><Dead>False</Dead><BackpackSlots>0</BackpackSlots>
<UniqueItemInfo><ItemData type="596" id="c-b">${rec(17, 3)}</ItemData><ItemData type="596">${rec(21)}</ItemData><ItemData type="596" id="c-a">${rec(5)}</ItemData></UniqueItemInfo></Char>
<Char id="2"><ObjectType>804</ObjectType><Seasonal>True</Seasonal><Level>1</Level><Equipment>-1,-1,-1,-1,2652,-1,-1,-1,-1,-1,-1,-1</Equipment><Dead>False</Dead>
<Pet id="7" type="1"><UniqueItemInfo><ItemData type="2652">${rec(99)}</ItemData></UniqueItemInfo><Abilities><Ability/></Abilities></Pet><Account><Name>Foo</Name></Account>
<UniqueItemInfo><ItemData type="2652">${rec(2)}</ItemData></UniqueItemInfo><BackpackSlots>8</BackpackSlots></Char>
<Char id="3"><ObjectType>800</ObjectType><Dead>True</Dead><BackpackSlots>0</BackpackSlots></Char>
<Account><Name>Foo</Name>
<Vault><Chest>2652#v-1,-1,-1,-1,-1,-1,-1,-1</Chest><Chest>596,596,-1,-1,-1,-1,-1,-1</Chest></Vault>
<MaterialStorage><Chest>-1,-1,-1,-1,-1,-1,-1,-1</Chest></MaterialStorage>
<Gifts>596,2652</Gifts><TemporaryGifts>-1</TemporaryGifts><Potions>2652,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1</Potions>
<UniqueItemInfo><ItemData type="2652" id="v-1">${rec(8)}</ItemData><ItemData type="596">${rec(9)}</ItemData><ItemData type="2652">${rec(10)}</ItemData></UniqueItemInfo>
<UniqueGiftItemInfo><ItemData type="596">${rec()}</ItemData></UniqueGiftItemInfo>
</Account></Chars>`;

describe("parseAccountDump", () => {
  it("joins each record to its slot by copy id, else by type in order, once; containers come from the Account block", () => {
    const d = parseAccountDump(SNAPSHOT);
    expect(d).toMatchObject({ nextCharId: 5, maxNumChars: 3, records: 8 });
    expect(d.sections.sort()).toEqual(["Account/Gifts", "Account/MaterialStorage", "Account/Potions", "Account/TemporaryGifts", "Account/UniqueGiftItemInfo", "Account/UniqueItemInfo", "Account/Vault", "Char/UniqueItemInfo"]);
    const c1 = d.chars[0];
    expect(c1).toMatchObject({ id: 1, objectType: 782, backpackSlots: 0, equipment: [596, -1, 2652, -1, 596, 596, 596, -1, -1, -1, -1, -1] });
    // Slot 0 and 4 name copies: exact records. Slot 5 has no copy id: the one loose 596 record. Slot 6: nothing left, so no record.
    expect(c1.slots.map((s) => [s.type, s.copyId, s.enchantments])).toEqual([
      [596, "c-a", [5]], [-1, null, null], [2652, null, null], [-1, null, null], [596, "c-b", [17, 3]], [596, null, [21]], [596, null, null],
      [-1, null, null], [-1, null, null], [-1, null, null], [-1, null, null], [-1, null, null],
    ]);
    // The pet's block inside <Pet> is the pet's, not the character's: slot 4 gets the character's own record.
    expect(d.chars[1].slots.map((s) => s.enchantments)).toEqual([null, null, null, null, [2], null, null, null, null, null, null, null]);
    expect(d.chars[2]).toMatchObject({ dead: true, slots: [] });
    // The account-level pool serves the vault first (exact then loose), then the potions; the gift chest has its own.
    expect(d.vault.map((chest) => chest.map((s) => s.enchantments))).toEqual([[[8], null, null, null, null, null, null, null], [[9], null, null, null, null, null, null, null]]);
    expect(d.potions[0]).toEqual({ type: 2652, copyId: null, enchantments: [10] });
    expect(d.gifts.map((s) => s.enchantments)).toEqual([[], null]);
    expect(d.temporaryGifts).toEqual([{ type: -1, copyId: null, enchantments: null }]);
    expect(d.materialStorage[0].every((s) => s.type === -1)).toBe(true);
  });
  it("reads a plain char list as a snapshot with nothing extra", () => {
    const d = parseAccountDump(CHAR_LIST);
    expect(d.chars.length).toBeGreaterThan(0);
    expect(d).toMatchObject({ records: 0, sections: [], vault: [], gifts: [], potions: [] });
    expect(() => parseAccountDump("<Error>nope</Error>")).toThrow(/not a char list/);
  });
});


describe("parseAccountDump seasonal storage", () => {
  it("notes any seasonal-side storage tag the account block carries, by name, so the first seasonal snapshot shows its shape", () => {
    const xml = `<Chars nextCharId="3" maxNumChars="5"><Char id="1"><ObjectType>782</ObjectType><Seasonal>True</Seasonal><Equipment>-1,-1,-1,-1,2588</Equipment><Account><Name>A</Name></Account></Char><Account><Name>A</Name><Vault><Chest>-1</Chest></Vault><SeasonalVault><Chest>2588</Chest></SeasonalVault><Gifts></Gifts></Account></Chars>`;
    const d = parseAccountDump(xml);
    expect(d.chars[0].seasonal).toBe(true);
    expect(d.maxNumChars).toBe(5);
    expect(d.sections).toEqual(expect.arrayContaining(["Account/Vault", "Account/Gifts", "Account/SeasonalVault"]));
  });
});

describe("quickslots in the character list", () => {
  it("reads type|count per slot, -1|0 for an empty one", () => {
    expect(parseQuickslots("2594|1,-1|0")).toEqual([{ type: 2594, count: 1 }, { type: -1, count: 0 }]);
    expect(parseQuickslots("2594|6,2595|3,-1|0")).toHaveLength(3);
    expect(parseQuickslots(null)).toEqual([]);
  });
});
