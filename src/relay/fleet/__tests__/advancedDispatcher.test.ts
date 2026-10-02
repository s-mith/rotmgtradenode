// Advanced management (docs/relay/ADVANCED.md) in the dispatcher, end to end
// against the fake Realm: a deposit goes to an empty character (the one ready
// soonest, ties to the account holding the most potions), only an empty
// character claims while one exists, the side falls back to the old rule when
// none is left, the room the site is told follows, an idle bot banks before it
// logs out, and the next row's bot is woken while the row before it trades.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Fleet } from "../fleet";
import { NodeSettingsStore } from "../../../node/settings";
import { deriveBotGuid } from "../botPool";
import type { FleetDeps } from "../bringUp";
import type { BotAccount } from "../botPool";
import type { OnlineTrip, StorageDesk } from "../dispatcher";
import type { ApiResult, Assignment, ItemQty, PendingDeposit, PendingWithdraw, SiteApi } from "../siteApi";
import { ApiStats } from "../siteApi";
import { dataDirWith as dataDirWithIn, FakeRealm, loginsTo, sleep, UBATK, waitFor, writeStorage } from "./fleetHarness";
import { noteAccountLogin, resetAccountLogins } from "../tokenCache";

type Beat = { botGuid: string; status: string; freeSlots: number; capacity?: number; emptyOnly?: boolean };

/** In-memory site: pending deposits and withdraws as given, every heartbeat and claim recorded; a claim takes the first deposit. */
class AdvSite implements SiteApi {
  readonly timeoutMs = 1000;
  readonly stats = new ApiStats();
  heartbeats: Beat[] = [];
  depositClaims: { botGuid: string; freeSlots: number | undefined }[] = [];
  fulfills: { requestId: number; items: ItemQty[] }[] = [];
  cancels: { requestId: number; why: string }[] = [];
  claimed = new Set<number>();
  constructor(public deposits: PendingDeposit[], private readonly ign: string, public withdraws: PendingWithdraw[] = [], private readonly grant = true) {}
  async heartbeat(p: Beat): Promise<ApiResult> {
    this.heartbeats.push({ botGuid: p.botGuid, status: p.status, freeSlots: p.freeSlots, capacity: p.capacity, emptyOnly: p.emptyOnly });
    return { ok: true };
  }
  async claimDeposit(botGuid: string, freeSlots?: number): Promise<ApiResult<{ assignment: Assignment | null }>> {
    this.depositClaims.push({ botGuid, freeSlots });
    const d = this.deposits.find((x) => !this.claimed.has(x.id));
    if (!this.grant || !d) return { ok: true, assignment: null };
    this.claimed.add(d.id);
    return { ok: true, assignment: { kind: "deposit", requestId: d.id, ign: this.ign, server: d.server, itemCount: d.itemCount, botIgn: "BotIgn" } };
  }
  async claimWithdraw(): Promise<ApiResult<{ assignment: Assignment | null }>> {
    return { ok: true, assignment: null };
  }
  async fulfillDeposit(_botGuid: string, requestId: number, items: ItemQty[]): Promise<ApiResult> {
    this.fulfills.push({ requestId, items });
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
  async cancel(_botGuid: string | null, requestId: number, _kind: "deposit" | "withdraw", why: string): Promise<ApiResult<{ cancelled?: boolean }>> {
    this.cancels.push({ requestId, why });
    return { ok: true, cancelled: true };
  }
  async listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>> {
    return { ok: true, withdraws: this.withdraws, deposits: this.deposits.filter((d) => !this.claimed.has(d.id) && !this.cancels.some((c) => c.requestId === d.id)) };
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});
const dataDirWith = (accounts: Record<string, unknown>[]): string => dataDirWithIn(accounts, cleanup);
const deposit = (id: number, itemCount: number, o: Partial<PendingDeposit> = {}): PendingDeposit => ({ id, server: "USSouth3", itemCount, declaredCount: itemCount, seasonal: true, ...o });
/** Node settings with advanced management on for standard accounts (and communism when asked). */
function advancedOn(dataDir: string, o: { communism?: boolean; lingerS?: number } = {}): NodeSettingsStore {
  const ns = NodeSettingsStore.at(dataDir);
  ns.update((s) => {
    s.advanced = { ...s.advanced, pool: true, communism: !!o.communism, lingerS: o.lingerS ?? 0 };
  });
  return ns;
}
/** The storage desk fleet.ts wires, with the live trips replaced by `trips` (a fake Vault). */
function deskWith(fleet: Fleet, trips: Partial<StorageDesk>): StorageDesk {
  const acc = (g: string) => fleet.pool.byBotGuid(g);
  return {
    stored: (g) => (acc(g) ? fleet.storage.storedFor(acc(g)!) : []),
    fetch: (a, need, o) => fleet.storage.fetch(a, need, o),
    chars: (g) => (acc(g) ? fleet.storage.charsFor(acc(g)!) : []),
    loginChar: (g) => (acc(g) ? fleet.storage.loginCharFor(acc(g)!)?.id ?? null : null),
    ...trips,
  };
}
const privately = (fleet: Fleet) => fleet.dispatcher as unknown as { rebuildAdvancedState(): void };

describe("advanced management: intake into an empty character", () => {
  it("wakes the account with an empty character, switching to it, rather than one whose only character holds items", async () => {
    const dataDir = dataDirWith([
      { alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotB", guid: "b@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]);
    writeStorage(dataDir, [
      { email: "a@example.com", chars: [{ id: 1, seasonal: true }] },
      { email: "b@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true }] },
    ]);
    const nodeSettings = advancedOn(dataDir);
    const site = new AdvSite([deposit(101, 6)], "Partner");
    const logs: string[] = [];
    const logins: { alias: string; charId: number | null }[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l),
      bringUp: async (_d, acc) => {
        logins.push({ alias: acc.alias, charId: acc.info.charId ?? null });
        throw new Error("the test ends the login here");
      },
    });
    cleanup.push(() => fleet.stop());
    // A's one character and B's first both hold an item; B's second is empty.
    for (const email of ["a@example.com", "b@example.com"]) fleet.tracker.updateFromSlots(deriveBotGuid(email), { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toEqual({ alias: "BotB", charId: 2 });
    expect(logs.some((l) => l.includes("chose BotB for seasonal deposit #101 on USSouth3 — an empty 8-slot character (switching to 2)"))).toBe(true);
    expect(site.cancels).toEqual([]);
  }, 15_000);

  it("between two accounts that log in as an empty character, takes the one holding the most potions", async () => {
    const dataDir = dataDirWith([
      { alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotB", guid: "b@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]);
    // B's played character is empty and its second one keeps three potions; A has nothing anywhere.
    writeStorage(dataDir, [
      { email: "a@example.com", chars: [{ id: 1, seasonal: true }] },
      { email: "b@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true, items: { p1: "plife", p2: "plife", p3: "pmana" } }] },
    ]);
    const nodeSettings = advancedOn(dataDir);
    const site = new AdvSite([deposit(101, 4)], "Partner");
    const logs: string[] = [];
    const logins: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l),
      bringUp: async (_d, acc) => {
        logins.push(acc.alias);
        throw new Error("the test ends the login here");
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toBe("BotB");
    expect(logs.some((l) => l.includes("chose BotB") && l.includes("3 potion(s) held"))).toBe(true);
  }, 15_000);

  it("a bot holding items does not claim while an empty character exists, and tells the site it takes only into an empty one", async () => {
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "DeskOne", guid: "desk1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    // Character 2 is empty: the side has an empty character, so intake waits for it.
    writeStorage(dataDir, [{ email: "desk1@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true }] }]);
    const nodeSettings = advancedOn(dataDir);
    // The login desk keeps this bot in game (and out of the idle rules) whatever it holds.
    nodeSettings.update((s) => { s.loginDesk = { alwaysOn: true }; });
    const site = new AdvSite([], "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    const bot = fleet.pool.all()[0];
    await waitFor(() => site.heartbeats.some((h) => h.botGuid === bot.botGuid && h.status === "idle" && h.emptyOnly === true), 10_000, logs);
    // The deposit arrives once it stands in game holding the item.
    site.deposits.push(deposit(101, 4));
    await sleep(4000);
    const beat = site.heartbeats.filter((h) => h.status === "idle").at(-1)!;
    expect(beat).toMatchObject({ capacity: 8, emptyOnly: true, freeSlots: 7 });
    expect(site.depositClaims).toEqual([]);
  }, 25_000);

  it("with no empty character left on the side, the old rule: a bot with room for the deposit claims it", async () => {
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "bot1@example.com", chars: [{ id: 1, seasonal: true }] }]);
    const nodeSettings = advancedOn(dataDir);
    const site = new AdvSite([deposit(101, 4)], "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    // Its one character holds an item: no character on the side is empty.
    fleet.tracker.updateFromSlots(fleet.pool.all()[0].botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => site.depositClaims.length > 0, 15_000, logs);
    expect(site.depositClaims[0].freeSlots).toBe(7);
    expect(site.heartbeats.find((h) => h.status === "idle")).toMatchObject({ emptyOnly: false, capacity: 8 });
  }, 25_000);
});

describe("advanced management: the room the site is told", () => {
  it("a side with empty characters offers what they hold together (capped at one deposit's most); off, the old figure", () => {
    const dataDir = dataDirWith([
      { alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotB", guid: "b@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotC", guid: "c@example.com", password: "pw", server: "USSouth3", seasonal: false },
    ]);
    writeStorage(dataDir, [
      { email: "a@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true }] },
      { email: "b@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true }] },
      { email: "c@example.com", chars: [{ id: 1, seasonal: false }] },
    ]);
    const nodeSettings = NodeSettingsStore.at(dataDir);
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new AdvSite([], "Partner"), nodeSettings, log: () => {}, bringUp: async () => { throw new Error("no logins here"); } });
    cleanup.push(() => fleet.stop());
    // C's one character holds three items: five free, and no empty character on the non-seasonal side.
    fleet.tracker.updateFromSlots(deriveBotGuid("c@example.com"), { 4: { itemId: "ubatk", enchantments: [] }, 5: { itemId: "ubatk", enchantments: [] }, 6: { itemId: "ubatk", enchantments: [] } }, 8);
    privately(fleet).rebuildAdvancedState();
    expect(fleet.dispatcher!.largestFreeByPool()).toEqual({ seasonal: 8, nonseasonal: 5 });
    nodeSettings.update((s) => { s.advanced = { ...s.advanced, pool: true, communism: true }; });
    privately(fleet).rebuildAdvancedState();
    // Four empty 8-slot characters on the seasonal side: 32 slots, one deposit takes at most 24. Non-seasonal falls back.
    expect(fleet.dispatcher!.largestFreeByPool()).toEqual({ seasonal: 24, nonseasonal: 5, communism: { seasonal: 0, nonseasonal: 0 } });
    expect(fleet.dispatcher!.advancedStatus().intake).toEqual({ "p|s": { empties: 4, room: 32, largest: 8, offline: 4 } });
  });
});

describe("advanced management: empty characters that cannot take a deposit", () => {
  it("one on an account Realm refuses (bad credentials) is no intake, and the side keeps the old rule", () => {
    const dataDir = dataDirWith([
      { alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotB", guid: "b@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]);
    writeStorage(dataDir, [
      { email: "a@example.com", chars: [{ id: 1, seasonal: true }] },
      { email: "b@example.com", chars: [{ id: 1, seasonal: true }] },
    ]);
    const nodeSettings = advancedOn(dataDir);
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new AdvSite([], "Partner"), nodeSettings, log: () => {}, bringUp: async () => { throw new Error("no logins here"); } });
    cleanup.push(() => fleet.stop());
    // B holds an item; A is empty but its login is refused for good.
    fleet.tracker.updateFromSlots(deriveBotGuid("b@example.com"), { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    fleet.gate.noteBadCredentials(fleet.pool.byGuid("a@example.com")!.guid);
    privately(fleet).rebuildAdvancedState();
    expect(fleet.dispatcher!.advancedStatus().intake).toEqual({});
    // The side's room is the old rule's, as with the switch off.
    const advanced = fleet.dispatcher!.largestFreeByPool().seasonal;
    nodeSettings.update((st) => { st.advanced = { ...st.advanced, pool: false }; });
    privately(fleet).rebuildAdvancedState();
    expect(advanced).toBe(fleet.dispatcher!.largestFreeByPool().seasonal);
  });
});

describe("advanced management: after the work", () => {
  it("an idle bot banks what it holds before it logs out", async () => {
    // The fake Realm never puts what a trade brings into the bot's slots, so the bot holds an item from its login
    // (its one character, so the side has no empty character and the deposit goes the old way).
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "bot1@example.com", chars: [{ id: 1, seasonal: true }] }]);
    const nodeSettings = advancedOn(dataDir);
    const site = new AdvSite([deposit(101, 4)], "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    fleet.tracker.updateFromSlots(fleet.pool.all()[0].botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    const banks: { alias: string; reserveSlots: number; park: boolean | undefined }[] = [];
    fleet.dispatcher!.setStorageDesk(deskWith(fleet, {
      vaultRoom: () => ({ free: 40, slots: 80 }),
      // The fake Realm cannot move the item: the trip reports the vault full so the bot is not sent again.
      bankOnline: async (acc: BotAccount, _c, o): Promise<OnlineTrip> => {
        banks.push({ alias: acc.alias, reserveSlots: o.reserveSlots, park: o.park });
        return { ok: true, moved: 0, left: 1, vaultFull: true };
      },
    }));
    await fleet.start({ sweep: false });
    await waitFor(() => site.fulfills.length > 0, 15_000, logs);
    const bot = fleet.pool.all()[0];
    await waitFor(() => !bot.online, 15_000, logs);
    expect(banks).toEqual([{ alias: "BotOne", reserveSlots: 0, park: false }]);
    const banked = logs.findIndex((l) => l.includes("BotOne banking the 1 item(s) on its character (before logging out)"));
    const out = logs.findIndex((l) => l.includes("BotOne idle with nothing for it — logging out"));
    expect(banked).toBeGreaterThanOrEqual(0);
    expect(out).toBeGreaterThan(banked);
  }, 40_000);
});

describe("advanced management: a session something else has", () => {
  it("gets no bank trip (and no retry every pass): the bot logs out with what it holds", async () => {
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "bot1@example.com", chars: [{ id: 1, seasonal: true }] }]);
    const nodeSettings = advancedOn(dataDir);
    const site = new AdvSite([deposit(101, 4)], "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    fleet.tracker.updateFromSlots(fleet.pool.all()[0].botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    let banks = 0;
    fleet.dispatcher!.setStorageDesk(deskWith(fleet, {
      vaultRoom: () => ({ free: 40, slots: 80 }),
      liveBlocked: () => "the storage run has the account",
      bankOnline: async (): Promise<OnlineTrip> => {
        banks++;
        return { ok: true, moved: 1, left: 0 };
      },
    }));
    await fleet.start({ sweep: false });
    await waitFor(() => site.fulfills.length > 0, 15_000, logs);
    const bot = fleet.pool.all()[0];
    await waitFor(() => !bot.online, 15_000, logs);
    expect(banks).toBe(0);
    expect(logs.some((l) => l.includes("BotOne idle with nothing for it — logging out"))).toBe(true);
  }, 40_000);
});

describe("advanced management: withdraws", () => {
  it("wakes the bot for a player's next row once the row before it is being traded, not before", async () => {
    const dataDir = dataDirWith([
      { alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotB", guid: "b@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]);
    writeStorage(dataDir, [
      { email: "a@example.com", chars: [{ id: 1, seasonal: true }] },
      { email: "b@example.com", chars: [{ id: 1, seasonal: true }] },
    ]);
    const nodeSettings = advancedOn(dataDir);
    const b = deriveBotGuid("b@example.com");
    const next = { id: 302, server: "USSouth3", items: [{ itemId: "plife", qty: 2 }], targetBotGuid: b, instanceIds: null, seasonal: true, upcoming: true, headClaimed: false } as PendingWithdraw;
    const site = new AdvSite([], "Partner", [next]);
    const logs: string[] = [];
    const logins: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l),
      bringUp: async (_d: FleetDeps, acc) => {
        logins.push(acc.alias);
        throw new Error("the test ends the login here");
      },
    });
    cleanup.push(() => fleet.stop());
    fleet.tracker.updateFromSlots(b, { 4: { itemId: "plife", enchantments: [] }, 5: { itemId: "plife", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    // The head row is still waiting for its player: nobody is woken for the next one.
    await sleep(4500);
    expect(logins).toEqual([]);
    (next as PendingWithdraw & { headClaimed: boolean }).headClaimed = true;
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toBe("BotB");
    expect(logs.some((l) => l.includes("woke BotB on USSouth3 for withdraw #302, next in line after the row being traded"))).toBe(true);
  }, 20_000);
});

describe("advanced management: a fetch on the live session", () => {
  it("wakes the account a withdraw's items wait in the vault of, fetches them on its session, and keeps it online for the trade", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "bot1@example.com", chars: [{ id: 1, seasonal: true }], vault: { v1: "plife", v2: "plife" } }]);
    const nodeSettings = advancedOn(dataDir);
    const botGuid = deriveBotGuid("bot1@example.com");
    const row = { id: 401, server: "USSouth3", items: [{ itemId: "plife", qty: 2 }], targetBotGuid: botGuid, instanceIds: null, seasonal: true } as PendingWithdraw;
    const site = new AdvSite([], "Partner", [row]);
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    const fetches: { alias: string; items: ItemQty[]; online: boolean }[] = [];
    fleet.dispatcher!.setStorageDesk(deskWith(fleet, {
      vaultRoom: () => ({ free: 14, slots: 16 }),
      fetchOnline: async (acc, _c, need) => {
        fetches.push({ alias: acc.alias, items: need.items, online: acc.online });
        return { ok: true };
      },
    }));
    await fleet.start({ sweep: false });
    await waitFor(() => fetches.length > 0, 15_000, logs);
    expect(fetches[0]).toEqual({ alias: "BotOne", items: [{ itemId: "plife", qty: 2 }], online: true });
    expect(logs.some((l) => l.includes("withdraw #401: waking BotOne on USSouth3 to fetch from its storage and trade"))).toBe(true);
    // The row is still its to serve (the fake fetch moved nothing): it stays rather than logging out idle.
    await sleep(4000);
    expect(fleet.pool.all()[0].online).toBe(true);
    expect(logs.some((l) => l.includes("BotOne idle with nothing for it"))).toBe(false);
  }, 30_000);
});

describe("advanced management off", () => {
  it("heartbeats carry nothing new and the old rules hold", async () => {
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "bot1@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true }] }]);
    const site = new AdvSite([deposit(101, 4)], "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    fleet.tracker.updateFromSlots(fleet.pool.all()[0].botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => site.depositClaims.length > 0, 15_000, logs);
    // Seven free slots take the 4-slot deposit, empty character elsewhere or not.
    expect(site.depositClaims[0].freeSlots).toBe(7);
    expect(site.heartbeats.every((h) => h.capacity === undefined && h.emptyOnly === undefined)).toBe(true);
  }, 25_000);
});

describe("advanced management: background work and Realm's patience", () => {
  it("gathers only while the account is inside its login budget, even on a node with a single login slot", async () => {
    const dataDir = dataDirWith([{ alias: "BotA", guid: "a@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeStorage(dataDir, [{ email: "a@example.com", chars: [{ id: 1, seasonal: true }, { id: 2, seasonal: true, items: { p1: "plife", p2: "plife" } }] }]);
    const nodeSettings = advancedOn(dataDir);
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new AdvSite([], "Partner"), nodeSettings, log: () => {}, bringUp: async () => { throw new Error("no logins here"); } });
    cleanup.push(() => fleet.stop());
    cleanup.push(() => resetAccountLogins());
    const runs: { maxChars?: number }[] = [];
    fleet.dispatcher!.setStorageDesk(deskWith(fleet, {
      vaultRoom: () => ({ free: 16, slots: 16 }),
      gatherPotions: async (_acc, o) => {
        runs.push({ maxChars: o.maxChars });
        return { ok: true };
      },
    }));
    const d = fleet.dispatcher as unknown as { advancedChores(f: Map<string, unknown>, now: number): void; advancedFleet(): Map<string, unknown>; lastChores: number };
    const bot = fleet.pool.all()[0];
    // Twelve logins in the last half hour: no background run now.
    for (let i = 0; i < 12; i++) noteAccountLogin(bot.guid);
    d.advancedChores(d.advancedFleet(), Date.now());
    expect(runs).toEqual([]);
    // A quiet account: the node's one login slot (no proxies here) goes to the run, a few characters at a time.
    resetAccountLogins();
    d.lastChores = 0;
    d.advancedChores(d.advancedFleet(), Date.now());
    await waitFor(() => runs.length === 1, 2000);
    expect(runs[0].maxChars).toBe(4);
  });
});
