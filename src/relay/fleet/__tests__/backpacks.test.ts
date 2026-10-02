// The pure parts of the backpack routines: clocks, state folding, the two halves' helpers, the daily login's picks;
// and how a job or a daily login waits for a busy account.
import { describe, expect, it, vi } from "vitest";
// A busy account is looked at again every 50 ms here, and the daily pass does not pause between accounts.
vi.hoisted(() => {
  process.env.DELETE_RETRY_S = "0.05";
  process.env.BACKPACK_LOGIN_STAGGER_MS = "10";
});
import os from "node:os";
import path from "node:path";
import { applyCalendar, applyCharList, backpacksIn, BackpackStore, calendarDue, findBackpack, pendingBackpackDay, reachedBackpackDays, syncCycle, deriveClocks, monthKey, monthResetAt, needsLoginToday, noteLogin, type AccountBackpackState } from "../backpacks";
import { parseCalendar, parseCharListDetail } from "../../realm/api";
import { BringUpRefused } from "../bringUp";
import { NEXUS_MAP } from "../vaultTrip";
import type { BotAccount } from "../botPool";
import type { GameClient } from "../../client/gameClient";

const acc = { alias: "bot1", guid: "bot1@example.com", botGuid: "guid-1" } as BotAccount;
const CAL = `<LoginRewards serverTime='1788754461.04813' conCurDay = '1' nonconCurDay = '3'>
<NonConsecutive days='3'><Login><Days>1</Days><ItemId quantity='2'>3176</ItemId><Gold>0</Gold><key>k1</key></Login>
<Login><Days>2</Days><ItemId quantity='3'>3180</ItemId><Gold>0</Gold><key>k2</key></Login>
<Login><Days>3</Days><ItemId>3138</ItemId><Gold>0</Gold></Login></NonConsecutive>
<Consecutive days='1'><Login><Days>1</Days><ItemId>3180</ItemId><Gold>0</Gold></Login></Consecutive></LoginRewards>`;
const CHARS = `<Chars nextCharId="2" maxNumChars="1"><Char id="1"><ObjectType>782</ObjectType><Seasonal>True</Seasonal><Level>7</Level><Dead>False</Dead><BackpackSlots>0</BackpackSlots></Char></Chars>`;

describe("clocks", () => {
  it("the calendar rolls over at the next UTC month start", () => {
    expect(monthResetAt(1788754461)).toBe(Date.UTC(2026, 9, 1) / 1000); // 2026-09-07 -> 2026-10-01
    expect(monthResetAt(Date.UTC(2026, 11, 31, 23, 59) / 1000)).toBe(Date.UTC(2027, 0, 1) / 1000);
    expect(monthKey(1788754461)).toBe("2026-09");
  });
  it("knows when the season ends before the month does", () => {
    const season = { id: "x", name: "Retro Winds", start: 1785834001, end: 1791277200, fetchedAt: 0 };
    const c = deriveClocks(1788754461, season);
    expect(c.monthResetsAt).toBe(1790812800);
    expect(c.seasonEndsBeforeMonth).toBe(false);
    expect(deriveClocks(1788754461, { ...season, end: 1790000000 }).seasonEndsBeforeMonth).toBe(true);
    expect(deriveClocks(null, season).seasonEndsBeforeMonth).toBeNull();
  });
});

describe("state and policy", () => {
  function fresh(): AccountBackpackState {
    const store = new BackpackStore(path.join(os.tmpdir(), `bp-${process.pid}-${Date.now()}-${Math.random()}.json`));
    const st = store.for(acc);
    applyCharList(st, parseCharListDetail(CHARS), 1000);
    applyCalendar(st, parseCalendar(CAL), 1000);
    return st;
  }
  it("folds char/list and the calendar into the account row", () => {
    const st = fresh();
    expect(st).toMatchObject({ charId: 1, seasonal: true, dead: false, hasBackpack: false, maxNumChars: 1, nonconCurDay: 3, conCurDay: 1 });
    expect(st.backpackDays).toEqual([
      { track: "nonconsecutive", day: 2, quantity: 3, claimable: true },
      { track: "consecutive", day: 1, quantity: 1, claimable: false },
    ]);
  });
  it("counts one login per UTC day and starts over on a new month", () => {
    const st = fresh();
    const d1 = Date.UTC(2026, 8, 7, 23, 50) ; // 2026-09-07 23:50Z
    expect(needsLoginToday(st, d1)).toBe(true);
    noteLogin(st, d1);
    expect(needsLoginToday(st, d1)).toBe(false);
    noteLogin(st, d1 + 5 * 60_000); // still the 7th
    expect(st.loginDays).toEqual(["2026-09-07"]);
    noteLogin(st, d1 + 15 * 60_000); // 00:05Z on the 8th
    expect(st.loginDays).toEqual(["2026-09-07", "2026-09-08"]);
    noteLogin(st, Date.UTC(2026, 9, 1, 1));
    expect(st.loginDays).toEqual(["2026-10-01"]);
  });
});




describe("a known backpack survives refreshes without the stat", () => {
  it("snapshotInventory records 16 slots from the fleet's knowledge alone", async () => {
    const { snapshotInventory } = await import("../sweeps");
    const inv = Array(20).fill(-1);
    inv[4] = 2591;
    const client = { playerData: { inv, enchantments: {}, hasBackpack: false }, knownBackpack: true, get hasBackpack() { return this.playerData.hasBackpack || this.knownBackpack; } };
    expect(snapshotInventory(client as never)).toMatchObject({ capacity: 16, hasBp: true });
    client.knownBackpack = false;
    expect(snapshotInventory(client as never)).toMatchObject({ capacity: 8, hasBp: false });
  });
});




describe("calibration: does an HTTP audit count as a login day", () => {
  it("collects evidence only across UTC days without a fleet login in between, and settles at ten", async () => {
    const { observeVerifyLogin, emptyObserved } = await import("../backpacks");
    const d1 = Date.UTC(2026, 8, 10, 12), d2 = Date.UTC(2026, 8, 11, 12);
    let obs = emptyObserved();
    // Same day: no evidence.
    obs = observeVerifyLogin(obs, { nonconCurDay: 2, lastAuditAt: d1, lastLoginAt: null }, 3, d1 + 3_600_000);
    expect(obs).toMatchObject({ verifyLoginYes: 0, verifyLoginNo: 0 });
    // A fleet login since the last audit: no evidence.
    obs = observeVerifyLogin(obs, { nonconCurDay: 2, lastAuditAt: d1, lastLoginAt: (d1 + 60_000) / 1000 }, 3, d2);
    expect(obs.verifyLoginYes).toBe(0);
    // Counter moved with only audits in between: yes.
    for (let i = 0; i < 10; i++) obs = observeVerifyLogin(obs, { nonconCurDay: 2, lastAuditAt: d1, lastLoginAt: null }, 3, d2);
    expect(obs).toMatchObject({ verifyLoginYes: 10, verifyLoginNo: 0, verifyCountsAsLogin: true });
    // A month boundary in between is never evidence.
    const obs2 = observeVerifyLogin(emptyObserved(), { nonconCurDay: 5, lastAuditAt: Date.UTC(2026, 8, 30), lastLoginAt: null }, 1, Date.UTC(2026, 9, 1, 12));
    expect(obs2).toMatchObject({ verifyLoginYes: 0, verifyLoginNo: 0 });
    // Ten "no"s settle it the other way.
    let obs3 = emptyObserved();
    for (let i = 0; i < 10; i++) obs3 = observeVerifyLogin(obs3, { nonconCurDay: 2, lastAuditAt: d1, lastLoginAt: null }, 2, d2);
    expect(obs3.verifyCountsAsLogin).toBe(false);
  });
});



describe("the per-account halves: what is ahead, and where a backpack sits", () => {
  const base = (): AccountBackpackState => ({
    alias: "a", guid: "g", botGuid: "b", charId: 1, seasonal: false, dead: false, hasBackpack: false, maxNumChars: 1, nonconCurDay: 3, conCurDay: 1,
    backpackDays: [], banked: null, lastAuditAt: null, lastVaultAt: null, claimed: [], lastLoginAt: null, loginDays: [], lastError: null, lastErrorAt: null, lastAuditTriedAt: null, manual: false,
  });
  it("names the nearest backpack day above a track's counter, never a reached one", () => {
    const st = base();
    st.backpackDays = [
      { track: "nonconsecutive", day: 2, quantity: 3, claimable: true }, // reached, unclaimed
      { track: "nonconsecutive", day: 9, quantity: 1, claimable: false }, // 6 logins away
      { track: "consecutive", day: 5, quantity: 2, claimable: false }, // 4 logins away
    ];
    expect(pendingBackpackDay(st)).toEqual({ track: "consecutive", day: 5, current: 1, quantity: 2 });
    st.backpackDays = [{ track: "nonconsecutive", day: 2, quantity: 3, claimable: false }]; // claimed: below the counter
    expect(pendingBackpackDay(st)).toBeNull();
    st.nonconCurDay = null;
    st.backpackDays = [{ track: "nonconsecutive", day: 9, quantity: 1, claimable: false }];
    expect(pendingBackpackDay(st)).toBeNull();
  });
  it("finds a backpack in the gift chest first, then the vault, then the spoils chest, and counts them all", () => {
    const view = { vault: { objectId: 10, slots: [-1, 3180, -1] }, material: { objectId: 11, slots: [] }, gift: { objectId: 12, slots: [5, -1] }, potion: { objectId: 13, slots: [] }, spoils: { objectId: 14, slots: [3180] } };
    expect(findBackpack(view)).toEqual({ kind: "vault", objectId: 10, slot: 1 });
    expect(backpacksIn(view)).toBe(2);
    view.gift.slots[1] = 3180;
    expect(findBackpack(view)).toEqual({ kind: "gift", objectId: 12, slot: 1 });
    expect(findBackpack({ ...view, gift: { objectId: -1, slots: [3180] }, vault: { objectId: 10, slots: [] }, spoils: { objectId: 14, slots: [] } })).toBeNull();
  });
});

describe("the daily login picks", () => {
  it("picks accounts with a backpack day ahead that have not been in the world today, and leaves the rest alone", async () => {
    const { BackpackService } = await import("../backpacks");
    const dir = path.join(os.tmpdir(), `bp-daily-${process.pid}-${Date.now()}`);
    const store = new BackpackStore(path.join(dir, "state.json"));
    const mk = (i: number) => ({ alias: `a${i}`, guid: `a${i}@x`, botGuid: `g-a${i}`, suspended: false, client: null, assignedRequestId: null, inUse: false, info: {} }) as unknown as BotAccount;
    const accs = [mk(0), mk(1), mk(2), mk(3), mk(4)];
    const pool = { every: () => accs };
    const holds = new Set<string>();
    const now = Date.UTC(2026, 8, 22, 15);
    const svc = new BackpackService({ sd: { deps: { pool, clients: new Map(), log: () => {}, proxies: { configured: false, exclusiveCapacity: () => null, releaseProbe() {} }, gate: { lockoutRemainingMs: () => 0, pausedRemainingMs: () => 0 } }, pool, tracker: {}, settings: {} } as never, store, holds, now: () => now });
    const ahead = { track: "nonconsecutive" as const, day: 9, quantity: 1, claimable: false };
    Object.assign(store.for(accs[0]), { nonconCurDay: 3, backpackDays: [ahead] }); // a day ahead, not in today: picked
    Object.assign(store.for(accs[1]), { nonconCurDay: 3, backpackDays: [ahead], loginDays: ["2026-09-22"] }); // already in today
    Object.assign(store.for(accs[2]), { nonconCurDay: 3, backpackDays: [{ ...ahead, day: 2, claimable: true }] }); // reached, nothing ahead: the owner claims it
    Object.assign(store.for(accs[3]), { nonconCurDay: 3, backpackDays: [] }); // nothing on the calendar
    Object.assign(store.for(accs[4]), { nonconCurDay: 3, backpackDays: [ahead], lastErrorAt: now / 1000 - 3_600 }); // failed an hour ago: backs off a day
    expect(svc.dailyLoginPicks(now).map((a) => a.alias)).toEqual(["a0"]);
    holds.add(accs[0].guid); // held by a trip right now: still picked, its login waits for the trip
    expect(svc.dailyLoginPicks(now).map((a) => a.alias)).toEqual(["a0"]);
    holds.clear();
    expect(svc.viewFor(accs[0], now)).toMatchObject({ claimable: 0, pending: { track: "nonconsecutive", day: 9, current: 3, quantity: 1 }, loginToday: false, job: null });
    expect(svc.viewFor(accs[2], now)).toMatchObject({ claimable: 1, pending: null });
  });
});

describe("one calendar read a cycle, then the logins move the counters", () => {
  it("the first login of a day advances the tracks, a reached day shows, and a new cycle asks for a read", async () => {
    const store = new BackpackStore(path.join(os.tmpdir(), `bp-cycle-${process.pid}-${Date.now()}.json`));
    const st = store.for(acc);
    applyCalendar(st, parseCalendar(CAL), Date.UTC(2026, 8, 10)); // serverTime 1788754461 = 2026-09; noncon 3, con 1; backpack days: noncon 2 (reached), con 1 (not)
    expect(st.calendarMonth).toBe("2026-09");
    st.backpackDays.push({ track: "nonconsecutive", day: 5, quantity: 1, claimable: false });
    const d10 = Date.UTC(2026, 8, 10, 12);
    expect(calendarDue(st, d10)).toBe(false);
    noteLogin(st, d10);
    expect(st.nonconCurDay).toBe(4);
    expect(st.conCurDay).toBe(1); // no login yesterday: the consecutive track starts over
    noteLogin(st, d10 + 3_600_000); // the same day again: nothing moves
    expect(st.nonconCurDay).toBe(4);
    noteLogin(st, d10 + 86_400_000);
    expect(st.nonconCurDay).toBe(5);
    expect(st.conCurDay).toBe(2);
    expect(reachedBackpackDays(st).map((d) => [d.track, d.day])).toEqual([["nonconsecutive", 2], ["nonconsecutive", 5]]);
    expect(pendingBackpackDay(st)).toBeNull();
    st.claimed.push("2026-09:nonconsecutive:5");
    expect(reachedBackpackDays(st).map((d) => d.day)).toEqual([2]);
    // October: the counters are last cycle's; nothing moves until the new read, which is due.
    const oct = Date.UTC(2026, 9, 2, 12);
    expect(calendarDue(st, oct)).toBe(true);
    noteLogin(st, oct);
    expect(st.nonconCurDay).toBe(5);
    expect(st.loginDays).toEqual(["2026-10-02"]);
  });
});

describe("one layout for everyone", () => {
  it("a new cycle takes the node's layout with counters from zero, one each when the account already logged in today", async () => {
    const store = new BackpackStore(path.join(os.tmpdir(), `bp-layout-${process.pid}-${Date.now()}.json`));
    const cal = parseCalendar(CAL.replace("serverTime='1788754461.04813'", "serverTime='1791244800'")); // 2026-10-02
    store.noteCalendar(cal, Date.UTC(2026, 9, 2));
    expect(store.calendarLayout()).toMatchObject({ month: "2026-10", days: [expect.objectContaining({ track: "nonconsecutive", day: 2, claimable: false }), expect.objectContaining({ track: "consecutive", day: 1 })] });
    const st = store.for(acc);
    applyCalendar(st, parseCalendar(CAL), Date.UTC(2026, 8, 10)); // September's read
    const oct3 = Date.UTC(2026, 9, 3, 12);
    expect(syncCycle(st, store.calendarLayout(), oct3)).toBe(true);
    expect(st).toMatchObject({ calendarMonth: "2026-10", nonconCurDay: 0, conCurDay: 0 });
    expect(calendarDue(st, oct3)).toBe(false);
    expect(syncCycle(st, store.calendarLayout(), oct3)).toBe(false); // already this cycle's
    noteLogin(st, oct3);
    expect(st.nonconCurDay).toBe(1);
    // Another account that logged in today before the sync starts at one.
    const other = store.for({ ...acc, botGuid: "guid-2", guid: "b@x" } as BotAccount);
    applyCalendar(other, parseCalendar(CAL), Date.UTC(2026, 8, 10));
    other.loginDays = ["2026-10-03"];
    syncCycle(other, store.calendarLayout(), oct3);
    expect(other).toMatchObject({ nonconCurDay: 1, conCurDay: 1 });
    // No layout for the cycle yet: nothing to hand over, a read is due.
    expect(syncCycle(store.for({ ...acc, botGuid: "guid-3", guid: "c@x" } as BotAccount), null, oct3)).toBe(false);
  });
});

describe("a busy account is waited for, not refused", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !pred() && Date.now() < end; ) await sleep(10);
  };
  async function setup() {
    const { BackpackService } = await import("../backpacks");
    const store = new BackpackStore(path.join(os.tmpdir(), `bp-wait-${process.pid}-${Date.now()}-${Math.random()}.json`));
    const acc = { alias: "a0", guid: "a0@x", botGuid: "g-a0", suspended: false, client: null, assignedRequestId: null, inUse: false, info: { server: "USSouth3" } } as unknown as BotAccount;
    const logins: number[] = [];
    const clients = new Map<string, GameClient>();
    const deps = {
      clients, log: () => {}, proxies: { configured: false, release() {}, exclusiveCapacity: () => null, releaseProbe() {} }, gate: { lockoutRemainingMs: () => 0, pausedRemainingMs: () => 0, noteCooldown() {} },
      // Straight into the Nexus.
      bringUp: async (_d: unknown, a: BotAccount) => {
        logins.push(Date.now());
        const c = { active: true, connected: true, objectId: 5, mapName: NEXUS_MAP, charId: 1, token: "t", proxy: null, playerData: { name: "Ign" }, stop() { this.active = false; }, on() {} };
        clients.set(a.guid, c as unknown as GameClient);
        return c as unknown as GameClient;
      },
    };
    const holds = new Set<string>();
    const svc = new BackpackService({ sd: { deps, pool: { every: () => [acc] }, tracker: {}, settings: {} } as never, store, holds });
    const month = monthKey(Date.now() / 1000);
    Object.assign(store.for(acc), { nonconCurDay: 3, calendarMonth: month, lastAuditAt: Date.now(), backpackDays: [{ track: "nonconsecutive", day: 9, quantity: 1, claimable: false }] });
    return { svc, store, acc, logins, holds, deps };
  }

  it("a claim asked while the account is busy is taken at once and runs when the account is free", async () => {
    const { svc, store, acc, logins, deps } = await setup();
    deps.bringUp = async () => {
      logins.push(Date.now());
      throw new BringUpRefused("failed", "the test ends the trip here");
    };
    store.for(acc).backpackDays = [{ track: "nonconsecutive", day: 2, quantity: 1, claimable: true }];
    (acc as { assignedRequestId: number | null }).assignedRequestId = 7; // in a trade
    expect(svc.startClaim(acc)).toEqual({ ok: true });
    await sleep(120);
    expect(svc.jobOf(acc.guid)).toMatchObject({ kind: "claim", waiting: "the account is busy" });
    expect(svc.activityOf(acc.guid)).toMatch(/queued, waiting for the account/);
    expect(logins).toHaveLength(0);
    expect(svc.startClaim(acc)).toEqual({ ok: false, error: "a backpack job is already on this account" });
    (acc as { assignedRequestId: number | null }).assignedRequestId = null; // the trade is over
    await until(() => svc.jobOf(acc.guid) === null);
    expect(logins).toHaveLength(1);
    expect(store.for(acc).lastJob).toMatchObject({ kind: "claim", ok: false, summary: expect.stringContaining("the test ends the trip here") });
  });

  it("waits out a login held back (every proxy host in use) as it does a busy account, and a waiting job can be taken back", async () => {
    const { svc, store, acc, logins, deps } = await setup();
    let full = 2;
    deps.bringUp = async () => {
      logins.push(Date.now());
      if (full-- > 0) throw new BringUpRefused("failed", "no free proxy", true);
      throw new BringUpRefused("failed", "the test ends the trip here");
    };
    store.for(acc).backpackDays = [{ track: "nonconsecutive", day: 2, quantity: 1, claimable: true }];
    expect(svc.startClaim(acc)).toEqual({ ok: true });
    await until(() => svc.jobOf(acc.guid) === null);
    // Two held-back tries recorded nothing; the third ran the job.
    expect(logins).toHaveLength(3);
    expect(store.for(acc).lastJob).toMatchObject({ kind: "claim", ok: false, summary: expect.stringContaining("the test ends the trip here") });

    // Taken back while it waits: gone at once, never run, and another can be asked for.
    (acc as { assignedRequestId: number | null }).assignedRequestId = 7;
    expect(svc.startConsume(acc, 1)).toEqual({ ok: true });
    await sleep(120);
    expect(svc.jobOf(acc.guid)).toMatchObject({ kind: "consume", waiting: "the account is busy" });
    expect(svc.cancelWaiting(acc)).toEqual({ ok: true });
    expect(svc.jobOf(acc.guid)).toBeNull();
    expect(svc.cancelWaiting(acc)).toEqual({ ok: false, error: "no backpack job on this account" });
    expect(svc.startClaim(acc)).toEqual({ ok: true });
    (acc as { assignedRequestId: number | null }).assignedRequestId = null;
    await until(() => svc.jobOf(acc.guid) === null);
    expect(logins).toHaveLength(4);
    expect(store.for(acc).lastJob).toMatchObject({ kind: "claim" });
  });

  it("the daily login waits for a held account, and is dropped when something else brought the account in meanwhile", async () => {
    const { svc, store, acc, logins, holds } = await setup();
    holds.add(acc.guid); // a storage trip has it
    const pass = svc.dailyLoginPass();
    await sleep(120);
    expect(logins).toHaveLength(0);
    holds.delete(acc.guid);
    expect(await pass).toMatchObject({ picked: 1, ok: 1 });
    expect(logins).toHaveLength(1);
    expect(needsLoginToday(store.for(acc), Date.now())).toBe(false);
    // Tomorrow: held again, and the trip that has it counts as the day's login.
    store.for(acc).loginDays = [];
    holds.add(acc.guid);
    const next = svc.dailyLoginPass();
    await sleep(120);
    noteLogin(store.for(acc), Date.now());
    expect(await next).toMatchObject({ picked: 1, ok: 0, skipped: 1 });
    expect(logins).toHaveLength(1);
  });
});
