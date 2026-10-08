// End to end: a pending deposit on a fake site wakes an account, the real
// GameClient logs into an in-process fake Realm server, the dispatcher
// claims the row, the trade machine runs the trade against a scripted
// partner, and the fulfill is reported back to the site. Also: a login that
// meets a queue, rows no account can serve, and character rotation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// The on-demand login desk lingers a second after its last code here, not two minutes.
vi.hoisted(() => {
  process.env.LOGIN_DESK_LINGER_SECONDS = "1";
});
import { Fleet } from "../fleet";
import { NodeSettingsStore } from "../../../node/settings";
import { GameClient } from "../../client/gameClient";
import { ITEM_BY_ID } from "../../../lib/catalog";
import { deriveBotGuid } from "../botPool";
import type { FleetDeps } from "../bringUp";
import type { ApiResult, Assignment, ItemQty, PendingDeposit, PendingWithdraw, SiteApi } from "../siteApi";
import { ApiStats } from "../siteApi";
import { dataDirWith as dataDirWithIn, FakeRealm, loginsTo, sleep, UBATK, waitFor, writeChars } from "./fleetHarness";

/** In-memory site: one pending deposit, records claims, fulfills and cancels. */
class FakeSite implements SiteApi {
  readonly timeoutMs = 1000;
  readonly stats = new ApiStats();
  heartbeats: { botGuid: string; status: string }[] = [];
  fulfills: { requestId: number; items: ItemQty[] }[] = [];
  cancels: { botGuid: string | null; requestId: number; kind: "deposit" | "withdraw"; why: string }[] = [];
  claimed: number | null = null;
  constructor(private readonly deposit: PendingDeposit | null, private readonly ign: string, private readonly withdraws: PendingWithdraw[] = []) {}
  async heartbeat(p: { botGuid: string; status: "idle" | "busy" | "offline" }): Promise<ApiResult> {
    this.heartbeats.push({ botGuid: p.botGuid, status: p.status });
    return { ok: true };
  }
  async claimDeposit(botGuid: string): Promise<ApiResult<{ assignment: Assignment | null }>> {
    if (!this.deposit || this.claimed !== null || this.fulfills.length) return { ok: true, assignment: null };
    if (this.heartbeats.at(-1)?.status !== "idle") return { ok: true, assignment: null };
    this.claimed = this.deposit.id;
    return { ok: true, assignment: { kind: "deposit", requestId: this.deposit.id, ign: this.ign, server: this.deposit.server, itemCount: 8, botIgn: "BotIgn" } };
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
  async cancel(botGuid: string | null, requestId: number, kind: "deposit" | "withdraw", why: string): Promise<ApiResult<{ cancelled?: boolean }>> {
    this.cancels.push({ botGuid, requestId, kind, why });
    return { ok: true, cancelled: true };
  }
  async listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>> {
    const gone = (kind: string, id: number) => this.cancels.some((c) => c.kind === kind && c.requestId === id);
    return {
      ok: true,
      withdraws: this.withdraws.filter((w) => !gone("withdraw", w.id)),
      deposits: this.deposit && this.claimed === null && !this.fulfills.length && !gone("deposit", this.deposit.id) ? [this.deposit] : [],
    };
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

/** A data dir with these accounts on the roster, removed after the test. */
const dataDirWith = (accounts: Record<string, unknown>[]): string => dataDirWithIn(accounts, cleanup);

describe("dispatcher end to end", () => {
  it("wakes a bot for a pending deposit, trades, and reports the fulfill", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    // Two accounts. The login desk is staffed only while someone logs in, so
    // only the one serving the deposit logs in.
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([
      { alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotTwo", guid: "bot2@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]));
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
      log: (l) => logs.push(l),
      bringUp: async (deps: FleetDeps, acc, server) => {
        const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
        client.adoptSession({ accessToken: "tok", charId: 1, seasonal: true });
        client.on("log", deps.log);
        deps.clients.set(acc.guid, client);
        client.on("stopped", () => deps.clients.delete(acc.guid));
        await client.connect();
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });

    await waitFor(() => site.fulfills.length > 0, 15000, logs);
    expect(site.claimed).toBe(101);
    expect(site.fulfills[0]).toEqual({ requestId: 101, items: [{ itemId: "ubatk", qty: 1 }] });
    expect(realm.fulfilledTrades).toBe(1);
    expect(logs.some((l) => l.includes("got deposit #101 for Partner"))).toBe(true);
    // The bot heartbeated idle before it was allowed to claim. (The scripted
    // partner accepts within one tick, so a "busy" beat isn't guaranteed.)
    expect(site.heartbeats.some((h) => h.status === "idle")).toBe(true);
    // The tracker learned the name of the bot that logged in; nobody else did.
    expect(fleet.pool.all().map((acc) => fleet.tracker.ignFor(acc.botGuid)).filter(Boolean)).toEqual(["BotIgn"]);
  }, 20000);

  it("counts a login in flight as coverage instead of waking another bot every tick", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    // USEast is not a login-desk server, so the only wakes there are for the deposit.
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify(
      ["A", "B", "C", "D", "E"].map((n) => ({ alias: `Bot${n}`, guid: `bot${n}@example.com`, password: "pw", server: "USEast", seasonal: true })),
    ));
    const site = new FakeSite({ id: 202, server: "USEast", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    cleanup.push(() => timers.forEach((t) => clearTimeout(t)));
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
      log: (l) => logs.push(l),
      // A login that takes longer than several supervise ticks, then fails.
      bringUp: async () => {
        await new Promise((r) => timers.push(setTimeout(r, 6000)));
        throw new Error("slow login");
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    // Three supervise ticks (2s apart) while the first login is still in flight.
    await new Promise((r) => timers.push(setTimeout(r, 5200)));
    const wakes = logs.filter((l) => /Dispatcher\.supervise: waking \S+ on USEast$/.test(l));
    expect(wakes).toHaveLength(1);
  }, 15000);

  it("leaves a withdraw alone while its only candidate sits out a login cooldown, instead of waking stand-ins", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify(
      ["A", "B", "C", "D", "E"].map((n) => ({ alias: `Bot${n}`, guid: `bot${n}@example.com`, password: "pw", server: "USEast", seasonal: true })),
    ));
    // One withdraw on USEast, and only BotA's inventory covers it.
    const site = new FakeSite(null, "Partner", [{ id: 303, server: "USEast", items: [{ itemId: "ubatk", qty: 1 }], targetBotGuid: null, instanceIds: null, seasonal: true }]);
    const logs: string[] = [];
    const timers: NodeJS.Timeout[] = [];
    cleanup.push(() => timers.forEach((t) => clearTimeout(t)));
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
      log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("nobody should be logging in");
      },
    });
    cleanup.push(() => fleet.stop());
    const botA = fleet.pool.byGuid("botA@example.com")!;
    fleet.tracker.updateFromSlots(botA.botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    fleet.gate.noteCooldown(botA.guid, 60, "test");
    await fleet.start({ sweep: false });
    // Three supervise passes. The removed "any same-pool bot" fallback woke a
    // different bot on every one of them, none able to serve the withdraw.
    await new Promise((r) => timers.push(setTimeout(r, 5200)));
    expect(logs.filter((l) => /Dispatcher\.supervise: waking \S+ on USEast$/.test(l))).toHaveLength(0);
    expect(logs.some((l) => l.includes("no offline bot can fulfill USEast work"))).toBe(true);
    expect(logs.some((l) => l.includes("BotA are on a login cooldown"))).toBe(true);
    // Waiting out a cooldown is not "nobody can serve it": the row stays.
    expect(site.cancels).toEqual([]);
  }, 15000);

  it("staffs the login desk only while a login code waits, then lets its bot log out", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "DeskOne", guid: "desk1@example.com", password: "pw", server: "USSouth3", seasonal: true }]));
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"),
      log: (l) => logs.push(l),
      bringUp: async (deps: FleetDeps, acc, server) => {
        const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
        client.adoptSession({ accessToken: "tok", charId: 1, seasonal: true });
        deps.clients.set(acc.guid, client);
        client.on("stopped", () => deps.clients.delete(acc.guid));
        await client.connect();
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    // Nobody is logging in: no bot sits at the desk.
    await new Promise((r) => setTimeout(r, 2500));
    expect(fleet.pool.all().filter((a) => a.online)).toHaveLength(0);
    expect(fleet.dispatcher!.electLoginBot()).toBeNull();
    expect(fleet.dispatcher!.loginDeskStatus()).toMatchObject({ alwaysOn: false, wanted: false, bot: null });
    // A code waits for its tell: a bot logs in to take it, and it is the one named.
    fleet.loginCodes.register("DESKCODE1");
    await waitFor(() => fleet.dispatcher!.electLoginBot() !== null, 10_000, logs);
    expect(fleet.dispatcher!.electLoginBot()!.ign).toBe("BotIgn");
    expect(logs.some((l) => l.includes("for the login desk: someone is logging in"))).toBe(true);
    expect(fleet.dispatcher!.loginDeskStatus()).toMatchObject({ alwaysOn: false, wanted: true, bot: "BotIgn" });
    // The tell lands; after the linger the desk is let go, and its bot logs out like any idle one.
    expect(fleet.loginCodes.noteTell("Someone", "DESKCODE1")).toBe(true);
    await waitFor(() => fleet.pool.all().every((a) => !a.online), 12_000, logs);
    expect(logs.some((l) => l.includes("the login desk is not needed any more"))).toBe(true);
  }, 25_000);

  it("staffs the login desk with a communism account when the node has nothing else", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "CommOne", guid: "comm1@example.com", password: "pw", server: "USSouth3", seasonal: false, communism: true }]));
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"),
      log: (l) => logs.push(l),
      bringUp: async (deps: FleetDeps, acc, server) => {
        const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
        client.adoptSession({ accessToken: "tok", charId: 1, seasonal: false });
        deps.clients.set(acc.guid, client);
        client.on("stopped", () => deps.clients.delete(acc.guid));
        await client.connect();
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    fleet.loginCodes.register("COMMCODE1");
    await waitFor(() => fleet.dispatcher!.electLoginBot() !== null, 10_000, logs);
    expect(logs.some((l) => l.includes("woke CommOne") && l.includes("a communism account: no other account is free"))).toBe(true);
  }, 25_000);

  it("staffs the login desk with a communism account when the node has no other", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "CommOne", guid: "comm1@example.com", password: "pw", server: "USSouth3", seasonal: true, communism: true }]));
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"),
      log: (l) => logs.push(l),
      bringUp: async (deps: FleetDeps, acc, server) => {
        const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
        client.adoptSession({ accessToken: "tok", charId: 1, seasonal: true });
        deps.clients.set(acc.guid, client);
        client.on("stopped", () => deps.clients.delete(acc.guid));
        await client.connect();
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    // The only account is set aside for communism, and sits out the few seconds after a session closes;
    // a code still gets a bot to /tell, and the short wait is not reported as "nobody can staff it".
    fleet.gate.noteCooldown("comm1@example.com", 3, "session just closed");
    fleet.loginCodes.register("COMMCODE1");
    await waitFor(() => fleet.dispatcher!.electLoginBot() !== null, 12_000, logs);
    expect(fleet.dispatcher!.electLoginBot()!.ign).toBe("BotIgn");
    expect(logs.some((l) => l.includes("woke CommOne") && l.includes("a communism account: no other account is free"))).toBe(true);
    expect(logs.some((l) => l.includes("the login desk is wanted"))).toBe(false);
    expect(fleet.loginCodes.noteTell("Someone", "COMMCODE1")).toBe(true);
  }, 25_000);

  it("says when the login desk waits on a long login cooldown", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "DeskOne", guid: "desk1@example.com", password: "pw", server: "USSouth3", seasonal: true }]));
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"),
      log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("nobody should be logging in");
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    fleet.gate.noteCooldown("desk1@example.com", 300, "login attempt limit");
    fleet.loginCodes.register("LONGWAIT1");
    await waitFor(() => logs.some((l) => l.includes("the login desk is wanted")), 10_000, logs);
    expect(logs.find((l) => l.includes("the login desk is wanted"))).toMatch(/every account that could staff it is on a login cooldown: the first is free in \d+s/);
    expect(fleet.dispatcher!.electLoginBot()).toBeNull();
  }, 15_000);

  it("keeps a bot at the login desk all the time when the owner turns that on", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "DeskOne", guid: "desk1@example.com", password: "pw", server: "USSouth3", seasonal: true }]));
    const nodeSettings = NodeSettingsStore.at(dataDir);
    nodeSettings.update((s) => { s.loginDesk = { alwaysOn: true }; });
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"), nodeSettings,
      log: (l) => logs.push(l),
      bringUp: async (deps: FleetDeps, acc, server) => {
        const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
        client.adoptSession({ accessToken: "tok", charId: 1, seasonal: true });
        deps.clients.set(acc.guid, client);
        client.on("stopped", () => deps.clients.delete(acc.guid));
        await client.connect();
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => fleet.dispatcher!.electLoginBot() !== null, 10_000, logs);
    expect(logs.some((l) => l.includes("to keep the login desk staffed"))).toBe(true);
    // Well past the idle rule's grace, with no code and no work, it is still there.
    await new Promise((r) => setTimeout(r, 7_000));
    expect(fleet.dispatcher!.loginDeskStatus()).toEqual({ alwaysOn: true, wanted: true, until: null, bot: "BotIgn" });
  }, 25_000);
});

describe("a login that meets the server's login queue", () => {
  it("leaves at once, and the deposit it was woken for is cancelled saying why", async () => {
    const realm = new FakeRealm("Partner", { queueFrom: 1 });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => site.cancels.length > 0, 10_000, logs);
    const bot = fleet.pool.all()[0];
    expect(site.cancels).toEqual([{ botGuid: bot.botGuid, requestId: 101, kind: "deposit", why: "USSouth3 had a login queue" }]);
    expect(logs.some((l) => l.includes("BotOne is in the USSouth3 login queue at 12/40 — disconnecting and cancelling deposit #101"))).toBe(true);
    await waitFor(() => !bot.online && !fleet.clients.has(bot.guid), 5000, logs);
    // The server is benched a while: no other login walks into the same queue.
    expect(fleet.gate.serverJamRemainingMs("USSouth3")).toBeGreaterThan(0);
    await sleep(2500);
    expect(realm.connections).toBe(1);
  }, 20_000);

  it("cancels the withdraw the bot was woken for", async () => {
    const realm = new FakeRealm("Partner", { queueFrom: 1 });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotA", guid: "botA@example.com", password: "pw", server: "USEast", seasonal: true }]);
    const site = new FakeSite(null, "Partner", [{ id: 303, server: "USEast", items: [{ itemId: "ubatk", qty: 1 }], targetBotGuid: null, instanceIds: null, seasonal: true }]);
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    const botA = fleet.pool.all()[0];
    fleet.tracker.updateFromSlots(botA.botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => site.cancels.length > 0, 10_000, logs);
    expect(site.cancels).toEqual([{ botGuid: botA.botGuid, requestId: 303, kind: "withdraw", why: "USEast had a login queue" }]);
    await waitFor(() => !botA.online, 5000, logs);
  }, 20_000);

  it("cancels the row a bot had claimed when its reconnect lands in the queue", async () => {
    // The first login gets in; the server drops the bot as it asks for the trade, and the reconnect is queued.
    const realm = new FakeRealm("Partner", { queueFrom: 2, dropOnTrade: true });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => site.claimed === 101, 10_000, logs);
    await waitFor(() => site.cancels.length > 0, 15_000, logs);
    const bot = fleet.pool.all()[0];
    expect(site.cancels).toEqual([{ botGuid: bot.botGuid, requestId: 101, kind: "deposit", why: "USSouth3 had a login queue" }]);
    expect(realm.connections).toBe(2);
    await waitFor(() => !bot.online, 5000, logs);
  }, 30_000);
});

describe("rows no account can serve", () => {
  it("a deposit no account has the room for is cancelled saying why, and nobody is woken for it", async () => {
    const dataDir = dataDirWith(["A", "B"].map((n) => ({ alias: `Bot${n}`, guid: `bot${n}@example.com`, password: "pw", server: "USEast", seasonal: true })));
    const site = new FakeSite({ id: 404, server: "USEast", itemCount: 16, declaredCount: 16, seasonal: true }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("nobody should be logging in");
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => site.cancels.length > 0, 8000, logs);
    expect(site.cancels).toEqual([{ botGuid: null, requestId: 404, kind: "deposit", why: "no seasonal account has room for a 16-slot trade" }]);
    await sleep(2500);
    expect(logs.filter((l) => /waking/.test(l))).toEqual([]);
    expect(site.cancels).toHaveLength(1);
  }, 15_000);

  it("a deposit only suspended accounts could take is cancelled; one waiting for a login cooldown is not", async () => {
    const dataDir = dataDirWith([
      { alias: "Gone", guid: "gone@example.com", password: "pw", server: "USEast", seasonal: false, suspended: true },
      { alias: "Cool", guid: "cool@example.com", password: "pw", server: "USEast", seasonal: true },
    ]);
    const site = new FakeSite({ id: 505, server: "USEast", itemCount: 8, declaredCount: 8, seasonal: false }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("nobody should be logging in");
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => site.cancels.length > 0, 8000, logs);
    expect(site.cancels).toEqual([{ botGuid: null, requestId: 505, kind: "deposit", why: "every non-seasonal account that could take it is suspended" }]);

    const dataDir2 = dataDirWith([{ alias: "Cool", guid: "cool@example.com", password: "pw", server: "USEast", seasonal: true }]);
    const site2 = new FakeSite({ id: 506, server: "USEast", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const fleet2 = new Fleet({
      dataDir: dataDir2, proxies: { file: path.join(dataDir2, "none.txt") }, buildVersion: "7.0.0.0.0", api: site2, log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("nobody should be logging in");
      },
    });
    cleanup.push(() => fleet2.stop());
    fleet2.gate.noteCooldown(fleet2.pool.all()[0].guid, 60, "test");
    await fleet2.start({ sweep: false });
    await sleep(5200);
    expect(site2.cancels).toEqual([]);
  }, 20_000);

  it("a withdraw whose items are nowhere on the node is cancelled saying why; one whose items are only elsewhere, and a meeting's row, wait", async () => {
    const dataDir = dataDirWith(["A", "B"].map((n) => ({ alias: `Bot${n}`, guid: `bot${n}@example.com`, password: "pw", server: "USEast", seasonal: true })));
    const botA = deriveBotGuid("botA@example.com");
    const site = new FakeSite(null, "Partner", [
      // A pick the pinned account no longer has anywhere (dropped, traded away).
      { id: 601, server: "USEast", items: [{ itemId: "ubatk", qty: 1 }], targetBotGuid: botA, instanceIds: ["lost-instance"], seasonal: true },
      // Three rings by type when the whole node holds two.
      { id: 602, server: "USEast", items: [{ itemId: "ubatk", qty: 3 }], targetBotGuid: null, instanceIds: null, seasonal: true },
      // Two rings by type: no one bot holds both, but the node does.
      { id: 603, server: "USEast", items: [{ itemId: "ubatk", qty: 2 }], targetBotGuid: null, instanceIds: null, seasonal: true },
      // A meeting's row with nothing to route it: it lives by the hub's deadline.
      { id: 604, server: "USEast", items: [{ itemId: "patk", qty: 1 }], targetBotGuid: botA, instanceIds: ["gone-too"], seasonal: true, swap: { rendezvousId: 9, role: "give", gets: [], deadlineAt: Date.now() + 600_000 } },
    ]);
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async () => {
        throw new Error("the test keeps everyone offline");
      },
    });
    cleanup.push(() => fleet.stop());
    for (const g of [botA, deriveBotGuid("botB@example.com")]) fleet.tracker.updateFromSlots(g, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => site.cancels.length >= 2, 8000, logs);
    await sleep(2500);
    const ring = ITEM_BY_ID.get("ubatk")!.name;
    expect(site.cancels.sort((a, b) => a.requestId - b.requestId)).toEqual([
      { botGuid: null, requestId: 601, kind: "withdraw", why: "the picked items are no longer on the node" },
      { botGuid: null, requestId: 602, kind: "withdraw", why: `no account on the node holds 3× ${ring}` },
    ]);
  }, 20_000);

  it("a pick on the character its account is switching to is not cancelled while that login is under way", async () => {
    // The login as character 2 never gets in world: the pick is on its way to the tracker the whole time.
    const realm = new FakeRealm("Partner", { stallLoad: true });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "BotA", guid: "botA@example.com", password: "pw", server: "USEast", seasonal: true }]);
    writeChars(dataDir, "botA@example.com", [{ id: 1, seasonal: true }, { id: 2, seasonal: true, items: { "pick-1": UBATK } }]);
    const botA = deriveBotGuid("botA@example.com");
    const site = new FakeSite(null, "Partner", [{ id: 701, server: "USEast", items: [{ itemId: "ubatk", qty: 1 }], targetBotGuid: botA, instanceIds: ["pick-1"], seasonal: true }]);
    const logs: string[] = [];
    const logins: { alias: string; charId: number | null }[] = [];
    const fleet: Fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async (deps, acc, server) => {
        const client = await loginsTo(realm, logins)(deps, acc, server);
        // What the real bring-up's login hook does: the character switch moves the pick out of storage, on its way to the tracker.
        fleet.storage.onLogin(acc, client);
        return client;
      },
    });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    await waitFor(() => logins.length > 0, 8000, logs);
    expect(logins[0]).toEqual({ alias: "BotA", charId: 2 });
    await sleep(4500);
    expect(site.cancels).toEqual([]);
  }, 20_000);
});

describe("character rotation", () => {
  it("an account woken for a deposit its character has no room for logs in as a roomier character of its side", async () => {
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeChars(dataDir, "bot1@example.com", [{ id: 1, seasonal: true }, { id: 2, seasonal: true }, { id: 3, seasonal: false }]);
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const logins: (number | null)[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async (_d, acc) => {
        logins.push(acc.info.charId ?? null);
        throw new Error("the test ends the login here");
      },
    });
    cleanup.push(() => fleet.stop());
    const bot = fleet.pool.all()[0];
    // One item on character 1: seven free, one short of the trade.
    fleet.tracker.updateFromSlots(bot.botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 8);
    await fleet.start({ sweep: false });
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toBe(2);
    expect(logs.some((l) => l.includes("BotOne will play character 2 (8 free) from its next login: the 8-slot deposit on USSouth3 needs more than its character's 7 free slot(s)"))).toBe(true);
    expect(site.cancels).toEqual([]);
  }, 15_000);

  it("an idle account with an item on its character keeps it: no logout to rotate", async () => {
    const realm = new FakeRealm("Partner", { items: [UBATK] });
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = dataDirWith([{ alias: "DeskOne", guid: "desk1@example.com", password: "pw", server: "USSouth3", seasonal: true }]);
    writeChars(dataDir, "desk1@example.com", [{ id: 1, seasonal: true }, { id: 2, seasonal: true }]);
    const nodeSettings = NodeSettingsStore.at(dataDir);
    nodeSettings.update((s) => { s.loginDesk = { alwaysOn: true }; });
    const logs: string[] = [];
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"), nodeSettings, log: (l) => logs.push(l), bringUp: loginsTo(realm) });
    cleanup.push(() => fleet.stop());
    await fleet.start({ sweep: false });
    const bot = fleet.pool.all()[0];
    await waitFor(() => fleet.tracker.heldCount(bot.botGuid) === 1 && fleet.dispatcher!.electLoginBot() !== null, 10_000, logs);
    // Well past several supervise passes: it stays on character 1 with its seven free slots.
    await sleep(5000);
    expect(bot.online).toBe(true);
    expect(bot.info.charId).toBeUndefined();
    expect(logs.some((l) => l.includes("will play character"))).toBe(false);
    expect(realm.connections).toBe(1);
  }, 25_000);
});

describe("deposit room", () => {
  it("counts an account on a passing login cooldown, not a retired one, and the pool payload follows without a memo key change", async () => {
    const { poolPayload } = await import("../../controlPlane");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([{ alias: "BotA", guid: "botA@example.com", password: "pw", server: "USSouth3", seasonal: false }]));
    const site = new FakeSite(null, "Partner");
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: () => {}, bringUp: async () => { throw new Error("no logins here"); } });
    cleanup.push(() => fleet.stop());
    const bot = fleet.pool.byGuid("botA@example.com")!;
    fleet.tracker.updateFromSlots(bot.botGuid, { 4: { itemId: "ubatk", enchantments: [] } }, 24);
    // The ten seconds after any logout: a deposit waits that out, so the room is there.
    fleet.gate.noteCooldown(bot.guid, 10, "session just closed");
    expect(fleet.dispatcher!.largestFreeByPool()).toEqual({ seasonal: 0, nonseasonal: 23 });
    const before = poolPayload(fleet);
    expect(before.room?.nonseasonal.largestFree).toBe(23);
    // Retired (a suspension): no room, and the payload says so at once even
    // though nothing in its memo key moved.
    fleet.gate.retire(bot.guid);
    const after = poolPayload(fleet);
    expect(after.room?.nonseasonal.largestFree).toBe(0);
    expect(after).not.toBe(before);
    expect(poolPayload(fleet)).toBe(after);
  });
});

describe("both sides of the seasonal split", () => {
  it("an account playing a non-seasonal character takes a seasonal deposit by logging in as its seasonal one", async () => {
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: false }]);
    writeChars(dataDir, "bot1@example.com", [{ id: 204, seasonal: false }, { id: 206, seasonal: true }]);
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const logins: (number | null)[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site, log: (l) => logs.push(l),
      bringUp: async (_d, acc) => {
        logins.push(acc.info.charId ?? null);
        throw new Error("the test ends the login here");
      },
    });
    cleanup.push(() => fleet.stop());
    // Room is counted on both sides, the seasonal one through character 206.
    expect(fleet.dispatcher!.largestFreeByPool()).toEqual({ seasonal: 8, nonseasonal: 8 });
    await fleet.start({ sweep: false });
    await waitFor(() => logins.length > 0, 10_000, logs);
    expect(logins[0]).toBe(206);
    expect(logs.some((l) => l.includes("BotOne will play character 206") && l.includes("seasonal deposit on USSouth3 needs a character of that side"))).toBe(true);
    // Not cancelled as "no seasonal account".
    expect(site.cancels).toEqual([]);
  }, 15_000);

  it("a communism account keeps its side", async () => {
    const dataDir = dataDirWith([{ alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: false, communism: true }]);
    writeChars(dataDir, "bot1@example.com", [{ id: 204, seasonal: false }, { id: 206, seasonal: true }]);
    const fleet = new Fleet({ dataDir, proxies: { file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: new FakeSite(null, "Partner"), log: () => {}, bringUp: async () => { throw new Error("no logins here"); } });
    cleanup.push(() => fleet.stop());
    expect(fleet.dispatcher!.largestFreeByPool()).toEqual({ seasonal: 0, nonseasonal: 0 });
  });
});
