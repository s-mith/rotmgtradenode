// A communism deposit and the account's characters, the old way (advanced
// management off): an account whose played character is short of a full trade
// of the deposit comes as a roomier character of its side that takes one,
// rather than split the trade; with none that does, it takes what it can where
// it is and the rest continues (lib/queue.ts).
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Fleet } from "../fleet";
import { deriveBotGuid } from "../botPool";
import type { BotAccount } from "../botPool";
import type { ApiResult, Assignment, ItemQty, PendingDeposit, PendingWithdraw, SiteApi } from "../siteApi";
import { ApiStats } from "../siteApi";
import { dataDirWith as dataDirWithIn, waitFor, writeStorage } from "./fleetHarness";

/** In-memory site with the deposits as given; nothing is ever claimed. */
class Site implements SiteApi {
  readonly timeoutMs = 1000;
  readonly stats = new ApiStats();
  constructor(public deposits: PendingDeposit[]) {}
  async heartbeat(): Promise<ApiResult> {
    return { ok: true };
  }
  async claimDeposit(): Promise<ApiResult<{ assignment: Assignment | null }>> {
    return { ok: true, assignment: null };
  }
  async claimWithdraw(): Promise<ApiResult<{ assignment: Assignment | null }>> {
    return { ok: true, assignment: null };
  }
  async fulfillDeposit(): Promise<ApiResult> {
    return { ok: true };
  }
  async fulfillWithdraw(): Promise<ApiResult> {
    return { ok: true };
  }
  async reportServerUsage(): Promise<ApiResult> {
    return { ok: true };
  }
  async registerPool(): Promise<ApiResult> {
    return { ok: true };
  }
  async unclaim(): Promise<ApiResult<{ unclaimed?: boolean }>> {
    return { ok: true, unclaimed: true };
  }
  async giveUp(): Promise<ApiResult<{ cancelled?: boolean }>> {
    return { ok: true, cancelled: true };
  }
  async cancel(): Promise<ApiResult<{ cancelled?: boolean }>> {
    return { ok: true, cancelled: true };
  }
  async listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>> {
    return { ok: true, withdraws: [], deposits: this.deposits };
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

const EMAIL = "comm@example.com";
const communismDeposit = (id: number, itemCount: number): PendingDeposit => ({ id, server: "USSouth3", itemCount, declaredCount: itemCount, seasonal: true, communism: true });
type Routed = { requestId: number; itemCount: number; seasonal: boolean; communism: boolean };
type Private = {
  accountCanFulfill(acc: BotAccount, r: { count: number; withdraws: never[]; deposits: Routed[] }, botStates: Map<string, { freeSlots: number; itemsHeld: number }>): boolean;
  rotateFor(acc: BotAccount, deposits: Routed[], free: number): { id: number; free: number } | null;
};

/**
 * One communism account: its played character (1) holds five items, three of
 * its eight slots free; its second character (2) holds `second` items.
 */
async function setup(deposits: PendingDeposit[], second: number) {
  const dataDir = dataDirWithIn([{ alias: "CommA", guid: EMAIL, password: "pw", server: "USSouth3", seasonal: true, communism: true }], cleanup);
  const items = (n: number, tag: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${tag}${i}`, "ubatk"]));
  writeStorage(dataDir, [{ email: EMAIL, chars: [{ id: 1, seasonal: true, items: items(5, "a") }, { id: 2, seasonal: true, items: items(second, "b") }] }]);
  const logs: string[] = [];
  const logins: { alias: string; charId: number | null }[] = [];
  const fleet = new Fleet({
    dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new Site(deposits), log: (l) => logs.push(l),
    bringUp: async (_d, acc) => {
      logins.push({ alias: acc.alias, charId: acc.info.charId ?? null });
      throw new Error("the test ends the login here");
    },
  });
  cleanup.push(() => fleet.stop());
  const botGuid = deriveBotGuid(EMAIL);
  fleet.tracker.updateFromSlots(botGuid, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [4 + i, { itemId: "ubatk", enchantments: [] }])), 8);
  await fleet.start({ sweep: false });
  return { fleet, logs, logins, acc: fleet.pool.byBotGuid(botGuid)!, priv: fleet.dispatcher as unknown as Private };
}

describe("communism deposits and an account's characters", () => {
  it("wakes the account as its empty character when its played one can't take the whole trade", async () => {
    const { logs, logins } = await setup([communismDeposit(201, 8)], 0);
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toEqual({ alias: "CommA", charId: 2 });
    expect(logs.some((l) => l.includes("chose CommA for communism deposit #201 on USSouth3 — a communism account with 8 free slot(s)"))).toBe(true);
  }, 15_000);

  it("wakes it as the character it plays when no other takes a full trade: it takes what fits and the rest continues", async () => {
    const { logs, logins } = await setup([communismDeposit(202, 8)], 3);
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toEqual({ alias: "CommA", charId: null });
    expect(logs.some((l) => l.includes("chose CommA for communism deposit #202 on USSouth3 — a communism account with 3 free slot(s)"))).toBe(true);
  }, 15_000);

  it("online, it gives the trade up for a roomier character only when that one takes a full trade", async () => {
    const roomy = await setup([], 0);
    const d = { requestId: 203, itemCount: 8, seasonal: true, communism: true };
    const routing = { count: 1, withdraws: [] as never[], deposits: [d] };
    const states = new Map([[roomy.acc.botGuid, { freeSlots: 3, itemsHeld: 5 }]]);
    expect(roomy.priv.accountCanFulfill(roomy.acc, routing, states)).toBe(false);
    expect(roomy.priv.rotateFor(roomy.acc, [d], 3)).toMatchObject({ id: 2, free: 8 });
    expect(roomy.acc.info.charId).toBe(2);
    // A small deposit fits the played character: it stays.
    expect(roomy.priv.accountCanFulfill(roomy.acc, { ...routing, deposits: [{ ...d, itemCount: 3 }] }, states)).toBe(true);

    const tight = await setup([], 3);
    const tightStates = new Map([[tight.acc.botGuid, { freeSlots: 3, itemsHeld: 5 }]]);
    expect(tight.priv.accountCanFulfill(tight.acc, routing, tightStates)).toBe(true);
    // Its character full: any other with room.
    expect(tight.priv.rotateFor(tight.acc, [d], 0)).toMatchObject({ id: 2, free: 5 });
  }, 15_000);
});
