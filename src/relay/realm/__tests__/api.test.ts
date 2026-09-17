// Parsers for the read-only account calls, against bodies shaped like the
// live ones captured 2026-09-07 (docs/relay/BACKPACKS.md §0).
import { describe, expect, it } from "vitest";
import { backpackDays, isBadCredentials, parseCalendar, parseCharListDetail, parseSeasonInfo, parseServers } from "../api";

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
      { id: 1, objectType: 782, level: 7, seasonal: false, dead: false, backpackSlots: 8, hasBackpack: true },
      { id: 3, objectType: 804, level: 1, seasonal: true, dead: true, backpackSlots: 0, hasBackpack: false },
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
