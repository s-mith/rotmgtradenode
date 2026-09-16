// The scheduler's decision, one branch at a time (docs/relay/BACKPACKS.md §4.2, §4.3).
import { describe, expect, it } from "vitest";
import { applySettingsPatch, decide, DEFAULT_SETTINGS, inLoginWindow, isBackstopWindow, isMonthEndWindow, type TickInput } from "../backpackScheduler";

const RESET = Date.UTC(2026, 9, 1) / 1000;
function input(over: Partial<TickInput> = {}, nowMs = Date.UTC(2026, 8, 10, 12)): TickInput {
  return {
    nowMs, settings: { ...DEFAULT_SETTINGS }, liveChoreAllowed: true, banSweepHold: false, runInFlight: null, loginPausedMs: 0, pendingPlayers: 0,
    freeExits: 40, backoffUntilMs: 0, tripsLastHour: 0,
    clocks: { serverTime: nowMs / 1000, monthResetsAt: RESET, season: null, seasonEndsBeforeMonth: null },
    work: { recycle: 0, chore: 0, logins: 0, audit: 0, backstop: 0, orders: 0 }, lastChoreStartMs: 0, lastAuditStartMs: 0, loginsDoneToday: false, lastLane: null,
    ...over,
  };
}

describe("decide", () => {
  it("fits a backpack bot for a waiting deposit ahead of every routine lane, even while yielding to players", () => {
    const work = { recycle: 3, chore: 5, logins: 9, audit: 4, backstop: 0, orders: 1 };
    const d = decide(input({ work, pendingPlayers: 20, lastLane: "chore" }));
    expect(d).toMatchObject({ action: "chore", order: true, batch: 1 });
    expect(d.reason).toMatch(/waiting deposit/);
    // Two halves waiting: one trip each.
    expect(decide(input({ work: { ...work, orders: 2 } })).batch).toBe(2);
    // The safety gates still come first.
    expect(decide(input({ work, runInFlight: "audit 3/9" })).reason).toMatch(/running/);
    expect(decide(input({ work, liveChoreAllowed: false })).reason).toMatch(/live chore is disabled/);
    expect(decide(input({ work, freeExits: 0 })).reason).toMatch(/no exit is free/);
    // Without an order the pending-player yield applies as before.
    expect(decide(input({ work: { ...work, orders: 0 }, pendingPlayers: 20 })).reason).toMatch(/yielding/);
  });

  it("does nothing when disabled, holding, running, paused, backing off, yielding or short of exits", () => {
    expect(decide(input({ settings: { ...DEFAULT_SETTINGS, enabled: false }, work: { recycle: 0, chore: 5, logins: 0, audit: 0, backstop: 0, orders: 0 } })).reason).toBe("disabled");
    expect(decide(input({ banSweepHold: true })).reason).toMatch(/ban sweep/);
    expect(decide(input({ runInFlight: "chore 3/100" })).reason).toMatch(/running: chore/);
    expect(decide(input({ loginPausedMs: 30_000 })).reason).toMatch(/paused by Realm/);
    expect(decide(input({ backoffUntilMs: Date.UTC(2026, 8, 10, 13) })).reason).toMatch(/backing off/);
    expect(decide(input({ pendingPlayers: 6, work: { recycle: 0, chore: 5, logins: 0, audit: 0, backstop: 0, orders: 0 } })).reason).toMatch(/yielding to 6/);
    expect(decide(input({ freeExits: 3, work: { recycle: 0, chore: 5, logins: 0, audit: 0, backstop: 0, orders: 0 } })).reason).toMatch(/only 3 free/);
    expect(decide(input({ freeExits: null, work: { recycle: 0, chore: 5, logins: 0, audit: 0, backstop: 0, orders: 0 } })).action).toBe("chore");
  });
  it("runs the chore on picks in batches, needs the live switch, respects the trip budget and cadence", () => {
    const work = { recycle: 0, chore: 250, logins: 0, audit: 0, backstop: 0, orders: 0 };
    expect(decide(input({ work }))).toMatchObject({ action: "chore", batch: 100 });
    expect(decide(input({ work, liveChoreAllowed: false })).reason).toMatch(/BACKPACK_CHORE_LIVE/);
    expect(decide(input({ work, tripsLastHour: 600 })).reason).toMatch(/budget/);
    expect(decide(input({ work, tripsLastHour: 570 })).batch).toBe(30);
    const now = Date.UTC(2026, 8, 10, 12);
    expect(decide(input({ work, lastChoreStartMs: now - 300_000 }, now)).reason).toMatch(/next chore in 300s/);
  });
  it("doubles the chore batch and runs logins continuously in the last three days of the month", () => {
    const now = Date.UTC(2026, 8, 29, 15);
    expect(isMonthEndWindow({ serverTime: 0, monthResetsAt: RESET, season: null, seasonEndsBeforeMonth: null }, now)).toBe(true);
    expect(decide(input({ work: { recycle: 0, chore: 500, logins: 0, audit: 0, backstop: 0, orders: 0 } }, now))).toMatchObject({ action: "chore", batch: 200 });
    expect(decide(input({ work: { recycle: 0, chore: 0, logins: 40, audit: 0, backstop: 0, orders: 0 } }, now))).toMatchObject({ action: "logins", batch: 40 <= 200 ? 200 : 40 });
  });
  it("runs logins only in the daily window otherwise, once a day", () => {
    const work = { recycle: 0, chore: 0, logins: 40, audit: 0, backstop: 0, orders: 0 };
    const inWin = Date.UTC(2026, 8, 10, 2, 30);
    expect(inLoginWindow(inWin, 2)).toBe(true);
    expect(decide(input({ work }, inWin)).action).toBe("logins");
    expect(decide(input({ work, loginsDoneToday: true }, inWin)).action).toBe("none");
    expect(decide(input({ work }, Date.UTC(2026, 8, 10, 12))).reason).toMatch(/waiting for the 02:00Z window/);
  });
  it("audits hourly when there is a backlog, after the chore and logins", () => {
    const work = { recycle: 0, chore: 0, logins: 0, audit: 700, backstop: 0, orders: 0 };
    expect(decide(input({ work }))).toMatchObject({ action: "audit", batch: 500 });
    const now = Date.UTC(2026, 8, 10, 12);
    expect(decide(input({ work, lastAuditStartMs: now - 60_000 }, now)).action).toBe("none");
    expect(decide(input({ work: { ...work, chore: 3, orders: 0 } })).action).toBe("chore");
  });
  it("the backstop banks claimable days in the last 24 h only when switched on", () => {
    const now = Date.UTC(2026, 8, 30, 12);
    expect(isBackstopWindow({ serverTime: 0, monthResetsAt: RESET, season: null, seasonEndsBeforeMonth: null }, now)).toBe(true);
    const work = { recycle: 0, chore: 0, logins: 0, audit: 0, backstop: 3000, orders: 0 };
    expect(decide(input({ work }, now)).action).toBe("none");
    expect(decide(input({ work, settings: { ...DEFAULT_SETTINGS, backstop: true } }, now))).toMatchObject({ action: "backstop", batch: 200 });
    expect(decide(input({ work, settings: { ...DEFAULT_SETTINGS, backstop: true } }, Date.UTC(2026, 8, 28, 12))).action).toBe("none");
  });
  it("never starts recycling unless switched on, and takes turns with the chore", () => {
    const work = { recycle: 5, chore: 0, logins: 0, audit: 0, backstop: 0, orders: 0 };
    expect(decide(input({ work })).action).toBe("none");
    const on = { ...DEFAULT_SETTINGS, recycle: true };
    expect(decide(input({ work, settings: on })).action).toBe("recycle");
    const both = { recycle: 5, chore: 50, logins: 0, audit: 0, backstop: 0, orders: 0 };
    expect(decide(input({ work: both, settings: on, lastLane: null })).action).toBe("chore");
    expect(decide(input({ work: both, settings: on, lastLane: "chore" })).action).toBe("recycle");
    expect(decide(input({ work: both, settings: on, lastLane: "recycle" })).action).toBe("chore");
  });
});

describe("settings patches", () => {
  it("keep known keys with sane values only", () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { enabled: false, choreBatch: 25, minFreeExits: -1, buffer: "x", bogus: 1 });
    expect(s).toMatchObject({ enabled: false, choreBatch: 25, minFreeExits: 15, buffer: 0.2 });
    expect("bogus" in s).toBe(false);
  });
});
