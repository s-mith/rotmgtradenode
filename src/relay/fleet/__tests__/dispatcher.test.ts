// End to end: a pending deposit on a fake site wakes an account, the real
// GameClient logs into an in-process fake Realm server, the dispatcher
// claims the row, the trade machine runs the trade against a scripted
// partner, and the fulfill is reported back to the site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Fleet } from "../fleet";
import { GameClient } from "../../client/gameClient";
import type { FleetDeps } from "../bringUp";
import type { ApiResult, Assignment, FleetVault, ItemQty, PendingDeposit, PendingWithdraw, SiteApi } from "../siteApi";
import { ApiStats } from "../siteApi";
import { RC4, INCOMING_KEY, OUTGOING_KEY } from "../../protocol/rc4";
import { decodePayload, encodeFrame, HEADER_SIZE } from "../../protocol/codec";
import type { AnyPacket, PacketName, Packets } from "../../protocol/packets";
import { Stat } from "../../protocol/stats";

const UBATK = 2979;

/** A scripted Realm server that also plays the trade partner. */
class FakeRealm {
  server: net.Server;
  port = 0;
  connections = 0;
  fulfilledTrades = 0;
  constructor(private readonly partnerIgn: string) {
    this.server = net.createServer((s) => this.handle(s));
  }
  listen(): Promise<void> {
    return new Promise((res) => this.server.listen(0, "127.0.0.1", () => {
      this.port = (this.server.address() as net.AddressInfo).port;
      res();
    }));
  }
  close(): void {
    this.server.close();
  }
  private handle(sock: net.Socket): void {
    this.connections++;
    const inbound = new RC4(OUTGOING_KEY);
    const outbound = new RC4(INCOMING_KEY);
    let pending = Buffer.alloc(0);
    const send = <K extends PacketName>(type: K, body: Packets[K]) => {
      const frame = encodeFrame(type, body);
      outbound.process(frame.subarray(HEADER_SIZE));
      if (!sock.destroyed) sock.write(frame);
    };
    const botObjectId = 42;
    let tick = 0;
    const ticker = setInterval(() => {
      if (sock.destroyed) return clearInterval(ticker);
      send("NEWTICK", { tickId: ++tick, tickTime: 0, serverRealTimeMS: tick * 200, serverLastTimeRTTMS: 0, statuses: [] });
      if (tick % 5 === 0) send("PING", { serial: tick });
    }, 200);
    sock.on("close", () => clearInterval(ticker));
    sock.on("error", () => clearInterval(ticker));
    sock.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= HEADER_SIZE) {
        const size = pending.readInt32BE(0);
        if (pending.length < size) return;
        const id = pending.readUInt8(4);
        const payload = Buffer.from(pending.subarray(HEADER_SIZE, size));
        pending = pending.subarray(size);
        inbound.process(payload);
        const pkt = decodePayload(id, payload);
        this.onPacket(pkt, send, botObjectId);
      }
    });
  }
  private onPacket(pkt: AnyPacket, send: <K extends PacketName>(t: K, b: Packets[K]) => void, botObjectId: number): void {
    switch (pkt.type) {
      case "HELLO":
        send("MAPINFO", { width: 100, height: 100, name: "Nexus", displayName: "Nexus", realmName: "", seed: 1, background: 0, difficulty: 0, allowPlayerTeleport: true, showDisplays: true, newBool: false, maxPlayers: 85, gameOpenedTime: 0, buildVersion: "7.0.0.0.0", viewRadius: 15, newInt: 0, dungeonModifiers: [""], unknownShort1: 0, unknownBool: false, unknownShort2: 0, maxRealmScore: 0, curRealmScore: 0 });
        break;
      case "LOAD": {
        send("CREATESUCCESS", { objectId: botObjectId, charId: 1, pcStats: "" });
        const stats = [
          { statType: Stat.NAME, statValue: 0, strStatValue: "BotIgn", secondaryValue: 0 },
          { statType: Stat.ENCHANTMENTS, statValue: 0, strStatValue: ",,,,,,,,,,,,", secondaryValue: 0 },
        ];
        send("UPDATE", {
          pos: { x: 10, y: 10 }, levelType: 0, tiles: [], drops: [], unknownByte: -1,
          newObjs: [
            { objectType: 782, status: { objectId: botObjectId, pos: { x: 10, y: 10 }, stats } },
            { objectType: 782, status: { objectId: 7, pos: { x: 11, y: 10 }, stats: [{ statType: Stat.NAME, statValue: 0, strStatValue: this.partnerIgn, secondaryValue: 0 }] } },
          ],
        });
        break;
      }
      case "REQUESTTRADE":
        // Partner opens the window and offers one ring.
        send("TRADESTART", { clientItems: Array.from({ length: 8 }, () => ({ item: -1, slotType: 0, tradeable: false, included: false, enchantment: "" })), partnerName: `${this.partnerIgn},1234`, partnerItems: [{ item: UBATK, slotType: 9, tradeable: true, included: false, enchantment: "" }] });
        setTimeout(() => send("TRADECHANGED", { offer: [true] }), 20);
        setTimeout(() => send("TRADEACCEPTED", { clientOffer: Array(8).fill(false), partnerOffer: [true] }), 40);
        break;
      case "ACCEPTTRADE":
        this.fulfilledTrades++;
        send("TRADEDONE", { code: 0, description: "Trade successful!" });
        break;
      default:
        break;
    }
  }
}

/** In-memory site: one pending deposit, records claims and fulfills. */
class FakeSite implements SiteApi {
  readonly timeoutMs = 1000;
  readonly stats = new ApiStats();
  heartbeats: { botGuid: string; status: string }[] = [];
  fulfills: { requestId: number; items: ItemQty[] }[] = [];
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
  async listPending(): Promise<ApiResult<{ withdraws: PendingWithdraw[]; deposits: PendingDeposit[] }>> {
    return { ok: true, withdraws: this.withdraws, deposits: this.deposit && this.claimed === null && !this.fulfills.length ? [this.deposit] : [] };
  }
  async listVaults(): Promise<ApiResult<{ vaults: FleetVault[] }>> {
    return { ok: true, vaults: [] };
  }
  async vaultMoved(): Promise<ApiResult<{ moved?: number }>> {
    return { ok: true, moved: 0 };
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

async function waitFor(pred: () => boolean, ms = 8000, logs: string[] = []): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met in time. log tail:\n${logs.slice(-40).join("\n")}`);
}

describe("dispatcher end to end", () => {
  it("wakes a bot for a pending deposit, trades, and reports the fulfill", async () => {
    const realm = new FakeRealm("Partner");
    await realm.listen();
    cleanup.push(() => realm.close());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
    cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    // Two accounts: the login-desk rule parks one on a quiet realm, the other
    // is free to serve the deposit.
    fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify([
      { alias: "BotOne", guid: "bot1@example.com", password: "pw", server: "USSouth3", seasonal: true },
      { alias: "BotTwo", guid: "bot2@example.com", password: "pw", server: "USSouth3", seasonal: true },
    ]));
    const site = new FakeSite({ id: 101, server: "USSouth3", itemCount: 8, declaredCount: 8, seasonal: true }, "Partner");
    const logs: string[] = [];
    const fleet = new Fleet({
      dataDir, proxies: { url: null, file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
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
    // The tracker learned the bots' names.
    for (const acc of fleet.pool.all()) expect(fleet.tracker.ignFor(acc.botGuid)).toBe("BotIgn");
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
      dataDir, proxies: { url: null, file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
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
      dataDir, proxies: { url: null, file: path.join(dataDir, "none.txt") }, buildVersion: "7.0.0.0.0", api: site,
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
  }, 15000);
});
