// The automatic season rollover: once per season, the minute its end passes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { BackpackStore } from "../backpacks";
import { rolloverDue, SeasonWatch } from "../seasonWatch";
import type { GameClient } from "../../client/gameClient";

const END = 1_791_277_200; // 2026-10-06 09:00Z
const season = (id: string, end: number) => ({ id, name: `season ${id}`, start: end - 30 * 86_400, end });

function setup(nowSec: number) {
  const store = new BackpackStore(path.join(os.tmpdir(), `sw-${process.pid}-${Date.now()}-${Math.random()}.json`));
  const rolls: number[] = [];
  const pool = { markAllNonseasonal: () => { rolls.push(Date.now()); return { changed: 3, total: 10 }; } };
  const clients = new Map<string, GameClient>();
  clients.set("bot", { active: true, isReady: true, token: "tok", proxy: null } as unknown as GameClient);
  const fetched: string[] = [];
  let answer = season("A", END);
  const watch = new SeasonWatch({
    store, pool, clients, log: () => {}, now: () => Date.now(),
    fetchSeason: async () => { fetched.push(answer.id); return answer; },
  });
  vi.setSystemTime(nowSec * 1000);
  return { store, rolls, watch, fetched, setAnswer: (s: typeof answer) => { answer = s; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("rolloverDue", () => {
  it("is owed once the end passes and only until rolled", () => {
    expect(rolloverDue(null, null, END)).toBe(false);
    expect(rolloverDue(season("A", END), null, END - 1)).toBe(false);
    expect(rolloverDue(season("A", END), null, END)).toBe(true);
    expect(rolloverDue(season("A", END), "A", END + 5)).toBe(false);
    expect(rolloverDue(season("B", END + 100), "A", END + 200)).toBe(true);
  });
});

describe("SeasonWatch", () => {
  it("marks everyone non-seasonal the minute the season ends, once", async () => {
    const { rolls, watch, store } = setup(END - 90);
    await watch.refresh();
    expect(rolls).toEqual([]);
    vi.setSystemTime((END + 1) * 1000);
    expect(watch.check()).toBe(true);
    expect(rolls.length).toBe(1);
    expect(store.rolledFor()).toBe("A");
    expect(watch.check()).toBe(false);
    expect(rolls.length).toBe(1);
    expect(watch.status().lastRoll).toMatchObject({ seasonId: "A", changed: 3, total: 10 });
  });
  it("rolls the old season when a refresh already returns its successor", async () => {
    const { rolls, watch, setAnswer, store } = setup(END - 3600);
    await watch.refresh();
    // The clock is refreshed only after the boundary, and Realm already answers with the next season.
    vi.setSystemTime((END + 7200) * 1000);
    setAnswer(season("B", END + 40 * 86_400));
    await watch.refresh();
    expect(rolls.length).toBe(1);
    expect(store.rolledFor()).toBe("A");
    expect(store.currentSeason()?.id).toBe("B");
    expect(watch.check()).toBe(false);
  });
  it("rolls at boot after a downtime that spanned the end, and not again after a restart", () => {
    const first = setup(END - 10);
    first.store.noteSeason(season("A", END), Date.now());
    first.store.save();
    vi.setSystemTime((END + 86_400) * 1000);
    expect(first.watch.check()).toBe(true);
    expect(first.rolls.length).toBe(1);
    // A restart re-reads the store: already rolled for A.
    const again = new BackpackStore((first.store as unknown as { file: string }).file);
    expect(again.rolledFor()).toBe("A");
  });
  it("does nothing without an online bot to lend a token", async () => {
    const { watch, fetched } = setup(END - 10);
    expect(await new SeasonWatch({ store: new BackpackStore(path.join(os.tmpdir(), `sw2-${Date.now()}.json`)), pool: { markAllNonseasonal: () => ({ changed: 0, total: 0 }) }, clients: new Map(), log: () => {} }).refresh()).toBe(false);
    expect(await watch.refresh()).toBe(true);
    expect(fetched).toEqual(["A"]);
  });
});

describe("learning the clock", () => {
  it("retries the fetch on the minute check until a season is known", async () => {
    const { watch, fetched, store } = setup(END - 3600);
    // Nothing known yet: the check itself fetches (a bot is online to lend a token).
    expect(store.currentSeason()).toBeNull();
    watch.check();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetched).toEqual(["A"]);
    expect(store.currentSeason()?.id).toBe("A");
    // Known: the check no longer fetches.
    watch.check();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetched).toEqual(["A"]);
  });
});
