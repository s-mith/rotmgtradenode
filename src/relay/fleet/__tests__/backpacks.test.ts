// The pure parts of the backpack routines: clocks, state folding, policy.
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { applyCalendar, applyCharList, BackpackStore, decide, deriveClocks, isDisposable, monthKey, monthResetAt, gainPerDay, needsLoginToday, noteLogin, orderCandidate, planClaims, type AccountBackpackState, type PlanRow, type StockSample } from "../backpacks";
import { parseCalendar, parseCharListDetail } from "../../realm/api";
import type { BotAccount } from "../botPool";

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
  it("claims every reached backpack day; equips only when allowed and something is banked", () => {
    const st = fresh();
    expect(decide(st, { equip: false })).toMatchObject({ claim: [expect.objectContaining({ day: 2 })], equip: false });
    expect(decide(st, { equip: true }, null).equip).toBe(false);
    expect(decide(st, { equip: true }, 0).equip).toBe(true); // the 3 about to be claimed count
    st.backpackDays = [];
    expect(decide(st, { equip: true }, 0).equip).toBe(false);
    expect(decide(st, { equip: true }, 2).equip).toBe(true);
    st.hasBackpack = true;
    expect(decide(st, { equip: true }, 2)).toMatchObject({ equip: false, reasons: ["character already has a backpack"] });
  });
  it("applies the owner's disposability rule", () => {
    const st = fresh(); // seasonal, no backpack
    expect(isDisposable(st, 0)).toBe(true);
    expect(isDisposable(st, 1)).toBe(false);
    st.hasBackpack = true;
    expect(isDisposable(st, 0)).toBe(false);
    st.seasonal = false;
    expect(isDisposable(st, 0)).toBe(false);
    st.banked = 1;
    expect(isDisposable(st, 0)).toBe(true);
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
  it("persists and summarises", () => {
    const file = path.join(os.tmpdir(), `bp-${process.pid}-${Date.now()}-${Math.random()}.json`);
    const store = new BackpackStore(file);
    const st = store.for(acc);
    applyCharList(st, parseCharListDetail(CHARS), 1000);
    applyCalendar(st, parseCalendar(CAL), 1000);
    st.banked = 2;
    store.noteServerTime(1788754461);
    store.save();
    const again = new BackpackStore(file);
    expect(again.for(acc)).toEqual(st);
    expect(again.summary(1_000_000)).toEqual({ accounts: 1, audited: 1, withBackpack: 0, seasonal: 1, dead: 0, claimableDays: 1, claimableBackpacks: 3, banked: 2, vaultVisited: 1, loggedToday: 0 });
    expect(again.clocks().monthResetsAt).toBe(1790812800);
  });
});

describe("demand-driven claim plan", () => {
  const row = (alias: string, held: number, capacity: 8 | 16, claimable = true, seasonal = false): PlanRow => ({ botGuid: `g-${alias}`, alias, seasonal, held, capacity, claimable, banked: 0, vaultBot: false, eligible: true });
  it("claims on just enough of the biggest holders for the pool's stock to fit, with the buffer", () => {
    // 40 items on the non-seasonal side, one backpack bot already: 40*1.2/16 -> 3 bots, so 2 more.
    const rows = [row("bp", 10, 16), row("big", 8, 8), row("mid", 7, 8), row("small", 5, 8), row("empty", 0, 8), row("noday", 10, 8, false)];
    const p = planClaims(rows, { buffer: 0.2 });
    expect(p.nonseasonal).toMatchObject({ bots: 6, stock: 40, backpackBots: 1, needBots: 3, deficit: 2, candidates: 4 });
    expect(p.nonseasonal.picks.map((x) => x.alias)).toEqual(["big", "mid"]);
    expect(p.seasonal).toMatchObject({ bots: 0, stock: 0, needBots: 0, deficit: 0, picks: [] });
  });
  it("claims nothing when the stock already fits, and only on the pool that needs it", () => {
    const rows = [row("a", 6, 16), row("b", 6, 8), row("s1", 20, 8, true, true), row("s2", 12, 8, true, true)];
    const p = planClaims(rows, { buffer: 0 });
    expect(p.nonseasonal.deficit).toBe(0);
    expect(p.nonseasonal.picks).toEqual([]);
    expect(p.seasonal).toMatchObject({ stock: 32, needBots: 2, deficit: 2 });
    expect(p.seasonal.picks.map((x) => x.alias)).toEqual(["s1", "s2"]);
  });
  it("cannot pick more accounts than have a claimable day", () => {
    const p = planClaims([row("a", 16, 8, false), row("b", 16, 8, true), row("c", 16, 8, false)], { buffer: 0 });
    expect(p.nonseasonal).toMatchObject({ needBots: 3, deficit: 3, candidates: 1 });
    expect(p.nonseasonal.picks.map((x) => x.alias)).toEqual(["b"]);
  });
});

describe("growth-based headroom", () => {
  const S = (day: string, nonseasonal: number, seasonal = 0): StockSample => ({ day, seasonal, nonseasonal });
  it("averages the net gain per day over the window and needs two days of samples", () => {
    expect(gainPerDay([S("2026-09-07", 100)], "nonseasonal", "2026-09-07")).toBeNull();
    const samples = [S("2026-09-01", 100), S("2026-09-04", 130), S("2026-09-07", 160)];
    expect(gainPerDay(samples, "nonseasonal", "2026-09-07")).toBe(10);
    // Only the last 7 days count: the 09-01 sample falls out on the 9th.
    expect(gainPerDay([...samples, S("2026-09-09", 200)], "nonseasonal", "2026-09-09")).toBe((200 - 130) / 5);
    expect(gainPerDay(samples, "seasonal", "2026-09-07")).toBe(0);
  });
  it("plans for the measured growth over the horizon instead of a fixed fraction", () => {
    const row = (alias: string, held: number, capacity: 8 | 16): PlanRow => ({ botGuid: alias, alias, seasonal: false, held, capacity, claimable: true, banked: 0, vaultBot: false, eligible: true });
    const rows = [row("a", 16, 16), row("b", 8, 8), row("c", 8, 8), row("d", 0, 8)];
    // 32 items, gaining 10/day, 5 days to the reset -> 82 items -> 6 bots, 1 already: 5 needed but 3 candidates.
    const p = planClaims(rows, { gainPerDay: { seasonal: null, nonseasonal: 10 }, horizonDays: 5 }).nonseasonal;
    expect(p).toMatchObject({ stock: 32, bufferItems: 50, bufferMode: "growth", gainPerDay: 10, horizonDays: 5, needBots: 6, deficit: 5, candidates: 3 });
    expect(p.picks.map((x) => x.alias)).toEqual(["b", "c", "d"]);
    // Shrinking stock plans no headroom; unknown growth falls back to the fraction.
    expect(planClaims(rows, { gainPerDay: { seasonal: null, nonseasonal: -4 }, horizonDays: 5 }).nonseasonal).toMatchObject({ bufferItems: 0, needBots: 2, deficit: 1 });
    expect(planClaims(rows, { buffer: 0.5 }).nonseasonal).toMatchObject({ bufferItems: 16, bufferMode: "fraction", needBots: 3 });
  });
});

describe("activity labels for the console", () => {
  it("the chore labels the account while it drives it and clears the label after", async () => {
    const { BackpackService } = await import("../backpacks");
    const { BotPool } = await import("../botPool");
    const { InventoryTracker } = await import("../inventoryTracker");
    const dir = path.join(os.tmpdir(), `bp-act-${process.pid}-${Date.now()}`);
    const store = new BackpackStore(path.join(dir, "state.json"));
    const pool = { every: () => [acc] } as unknown as InstanceType<typeof BotPool>;
    const tracker = new InventoryTracker(path.join(dir, "inv.json"));
    const seen: (string | null)[] = [];
    let svc: InstanceType<typeof BackpackService>;
    const deps = {
      pool, clients: new Map(), log: () => {}, proxies: { configured: false, release: () => {} }, gate: { lockoutRemainingMs: () => 0, pausedRemainingMs: () => 0, noteCooldown: () => {} },
      bringUp: async () => {
        seen.push(svc.activityOf(acc.guid));
        // A dead client: the trip fails at its first wait, which is enough to see the label lifecycle.
        return { active: false, playerData: { name: "", hasBackpack: false, inv: [], enchantments: {} }, charSeasonal: null, stop: () => {}, world: { entities: new Map() } } as never;
      },
    };
    svc = new BackpackService({ sd: { deps, pool, tracker, settings: {} } as never, store, holds: new Set() });
    const a = { ...acc, info: { guid: acc.guid, password: "x", server: "USSouth3" }, client: null, suspended: false, assignedRequestId: null, inUse: false } as unknown as typeof acc;
    (pool as unknown as { every: () => unknown[] }).every = () => [a];
    svc.startChore({ mode: "dry", guids: [a.guid] });
    while (svc.chore.running) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["backpack chore (dry): logging in"]);
    expect(svc.activityOf(a.guid)).toBeNull();
    expect(svc.chore.failed).toBe(1);
    expect(store.for(a).lastError).toMatch(/inactive/);
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

describe("plan lanes for the scheduler", () => {
  const row = (alias: string, held: number, capacity: 8 | 16, extra: Partial<PlanRow> = {}): PlanRow => ({ botGuid: `g-${alias}`, alias, seasonal: false, held, capacity, claimable: true, banked: 0, vaultBot: false, eligible: true, ...extra });
  it("vault bots are their own lane and never count as pool stock", () => {
    const rows = [row("v1", 8, 8, { vaultBot: true }), row("v2", 3, 16, { vaultBot: true }), row("a", 8, 8), row("b", 8, 8)];
    const p = planClaims(rows, { buffer: 0 });
    expect(p.vaults).toMatchObject({ bots: 2, backpackBots: 1, deficit: 1, picks: [{ alias: "v1", held: 8 }] });
    expect(p.nonseasonal.stock).toBe(16);
  });
  it("spares already banked are picked before claims, and ineligible accounts never", () => {
    const rows = [row("claim", 8, 8), row("spare", 2, 8, { claimable: false, banked: 2 }), row("cooling", 8, 8, { eligible: false }), row("nothing", 8, 8, { claimable: false })];
    const p = planClaims(rows, { buffer: 0 });
    expect(p.nonseasonal.candidates).toBe(2);
    expect(p.nonseasonal.picks.map((x) => x.alias)).toEqual(["spare", "claim"]);
  });
});

describe("retry accounting", () => {
  it("transient failures cost nothing; three structural ones put the account on the manual list", async () => {
    const { noteChoreOutcome, eligibleForTrip, isTransientError } = await import("../backpacks");
    const st = fresh();
    const t0 = Date.UTC(2026, 8, 10);
    expect(isTransientError("timed out after 30s waiting for the Nexus")).toBe(true);
    expect(isTransientError("the backpack was not applied (the server refused the USEITEM)")).toBe(false);
    noteChoreOutcome(st, false, "client went inactive while waiting for the Nexus", t0);
    expect(st.choreAttempts).toBe(0);
    expect(eligibleForTrip(st, t0 + 1000)).toBe(true);
    noteChoreOutcome(st, false, "the backpack was not applied (the server refused the USEITEM)", t0);
    expect(st.choreAttempts).toBe(1);
    expect(eligibleForTrip(st, t0 + 3_600_000)).toBe(false);
    expect(eligibleForTrip(st, t0 + 25 * 3_600_000)).toBe(true);
    noteChoreOutcome(st, false, "USEPORTAL did not lead to the Vault after 4 attempts", t0 + 2 * 86_400_000); // transient wording
    noteChoreOutcome(st, false, "no VAULTINFO after entering the vault", t0 + 3 * 86_400_000);
    noteChoreOutcome(st, false, "no VAULTINFO after entering the vault", t0 + 5 * 86_400_000);
    expect(st.choreAttempts).toBe(3);
    expect(st.manual).toBe(true);
    // A new month starts the count over.
    noteChoreOutcome(st, true, null, Date.UTC(2026, 9, 2));
    expect(st.manual).toBe(false);
    expect(st.choreAttempts).toBe(0);
  });
  function fresh(): AccountBackpackState {
    const store = new BackpackStore(path.join(os.tmpdir(), `bp-r-${process.pid}-${Date.now()}-${Math.random()}.json`));
    return store.for(acc);
  }
});

describe("login lane targets", () => {
  it("picks accounts that can still reach the backpack day, tightest slack first", async () => {
    const { loginTargets } = await import("../backpacks");
    const mk = (alias: string, day: number, held: number, over: Partial<AccountBackpackState> = {}): AccountBackpackState => ({
      ...new BackpackStore(path.join(os.tmpdir(), `bp-l-${Math.random()}.json`)).for({ alias, guid: `${alias}@x`, botGuid: `g-${alias}` } as BotAccount),
      hasBackpack: false, nonconCurDay: day, backpackDays: [{ track: "nonconsecutive", day: 2, quantity: 3, claimable: false }], ...over,
    });
    const now = Date.UTC(2026, 8, 28, 12); // 2.5 days to the reset -> 3 usable days
    const clocks = { serverTime: now / 1000, monthResetsAt: Date.UTC(2026, 9, 1) / 1000, season: null, seasonEndsBeforeMonth: null };
    const rows = [
      { st: mk("a", 1, 5), held: 5, poolDeficit: 4, vaultBot: false },      // needs 1 more day: slack 2
      { st: mk("b", 0, 9), held: 9, poolDeficit: 4, vaultBot: false },      // needs 2: slack 1 -> first
      { st: mk("c", 1, 1, { loginDays: ["2026-09-28"] }), held: 1, poolDeficit: 4, vaultBot: false }, // already counted today
      { st: mk("d", 2, 9), held: 9, poolDeficit: 4, vaultBot: false },      // day reached: not a login target
      { st: mk("e", 0, 9), held: 9, poolDeficit: 0, vaultBot: false },      // pool needs nothing
      { st: mk("f", 0, 0), held: 0, poolDeficit: 0, vaultBot: true },       // vault bots always qualify
      { st: mk("g", 1, 3, { hasBackpack: true }), held: 3, poolDeficit: 4, vaultBot: false },
    ];
    expect(loginTargets(rows, clocks, now, 10).map((s) => s.alias)).toEqual(["b", "f", "a"]);
    expect(loginTargets(rows, clocks, now, 1).map((s) => s.alias)).toEqual(["b"]);
    // Half a day left: one login is still possible today, so only the accounts one day short qualify.
    expect(loginTargets(rows, clocks, Date.UTC(2026, 8, 30, 12), 10).map((s) => s.alias)).toEqual(["a", "c"]);
    // After the reset moment nobody can.
    expect(loginTargets(rows, clocks, Date.UTC(2026, 9, 1, 0, 1), 10)).toEqual([]);
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

describe("recycle picks and audit backoff", () => {
  async function service(states: Partial<AccountBackpackState>[], held: Record<string, number> = {}, seasonalDeficitRows: PlanRow[] = []) {
    const { BackpackService } = await import("../backpacks");
    const { InventoryTracker } = await import("../inventoryTracker");
    const dir = path.join(os.tmpdir(), `bp-rc-${process.pid}-${Date.now()}-${Math.random()}`);
    const store = new BackpackStore(path.join(dir, "state.json"));
    const accs = states.map((s, i) => ({ alias: `a${i}`, guid: `a${i}@x`, botGuid: `g-a${i}`, seasonalOrDefault: s.seasonal ?? false, suspended: false, client: null, assignedRequestId: null, inUse: false, info: { guid: `a${i}@x`, password: "p" } }));
    const tracker = new InventoryTracker(path.join(dir, "inv.json"));
    for (const [g, n] of Object.entries(held)) tracker.updateFromSlots(g, Object.fromEntries(Array.from({ length: n }, (_, i) => [4 + i, { itemId: "pdef", enchantments: [] }])), 8);
    const pool = { every: () => accs };
    const svc = new BackpackService({ sd: { deps: { pool, clients: new Map(), log: () => {}, proxies: { configured: false }, gate: { lockoutRemainingMs: () => 0, pausedRemainingMs: () => 0 } }, pool, tracker, settings: {} } as never, store, holds: new Set() });
    accs.forEach((a, i) => Object.assign(store.for(a as never), { lastAuditAt: 1000, hasBackpack: false, seasonal: false, charId: 1, dead: false, ...states[i] }));
    void seasonalDeficitRows;
    return { svc, store, accs };
  }
  it("the audit skips accounts it tried within a day and failed", async () => {
    const { svc, store, accs } = await service([{ lastAuditAt: null }, { lastAuditAt: null }, { lastAuditAt: null }]);
    const now = Date.UTC(2026, 8, 10, 12);
    store.for(accs[1] as never).lastAuditTriedAt = (now - 3_600_000) / 1000;      // tried an hour ago, still unaudited
    store.for(accs[2] as never).lastAuditTriedAt = (now - 30 * 3_600_000) / 1000; // tried yesterday
    expect(svc.auditPicks({ auditStaleDays: 3 }, now, 10)).toEqual(["a0@x", "a2@x"]);
  });
});

describe("an order for a 16-slot bot", () => {
  const row = (alias: string, o: Partial<PlanRow> = {}): PlanRow => ({ botGuid: `g-${alias}`, alias, seasonal: false, held: 0, capacity: 8, claimable: false, banked: 0, vaultBot: false, eligible: true, ...o });
  it("picks an empty, free account of the right half with a spare banked, else one with a claimable day", () => {
    const rows = [
      row("holds", { held: 3, banked: 1 }), // not empty: fitting it makes no 16-free bot
      row("vault", { banked: 1, vaultBot: true }),
      row("busy", { banked: 1, eligible: false }),
      row("done", { banked: 1, capacity: 16 }),
      row("seasonal", { banked: 1, seasonal: true }),
      row("bare"), // nothing banked, nothing claimable
      row("claim", { claimable: true }),
      row("spare-b", { banked: 2 }),
      row("spare-a", { banked: 1 }),
    ];
    expect(orderCandidate(rows, false)?.alias).toBe("spare-a");
    expect(orderCandidate(rows, true)?.alias).toBe("seasonal");
    expect(orderCandidate(rows.filter((r) => !r.alias.startsWith("spare")), false)?.alias).toBe("claim");
    expect(orderCandidate(rows.filter((r) => !r.alias.startsWith("spare") && r.alias !== "claim"), false)).toBeNull();
    expect(orderCandidate([], false)).toBeNull();
  });
});
