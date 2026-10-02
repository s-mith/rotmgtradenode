// Shared by the fleet's end-to-end tests: a scripted Realm server that also
// plays the trade partner, a bring-up that logs the real GameClient into it,
// and the data-dir helpers (accounts, characters as a read left them).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { GameClient } from "../../client/gameClient";
import { deriveBotGuid, type BotAccount } from "../botPool";
import type { FleetDeps } from "../bringUp";
import { RC4, INCOMING_KEY, OUTGOING_KEY } from "../../protocol/rc4";
import { decodePayload, encodeFrame, HEADER_SIZE } from "../../protocol/codec";
import type { AnyPacket, PacketName, Packets } from "../../protocol/packets";
import { Stat } from "../../protocol/stats";
import { toCatalogId, toObjType } from "../../trade/itemMap";

export const UBATK = 2979;

/**
 * A scripted Realm server that also plays the trade partner. `queueFrom`: the
 * connection (1 = the first) from which a HELLO is answered with a place in
 * the login queue instead of the Nexus. `dropOnTrade`: the server drops the
 * connection when the bot asks for a trade. `items`: what the character
 * carries in its first inventory slots. `stallLoad`: the character never
 * loads (a login that takes its time).
 */
export class FakeRealm {
  server: net.Server;
  port = 0;
  connections = 0;
  fulfilledTrades = 0;
  constructor(private readonly partnerIgn: string, private readonly o: { queueFrom?: number; dropOnTrade?: boolean; items?: number[]; stallLoad?: boolean } = {}) {
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
    const queued = this.o.queueFrom !== undefined && this.connections >= this.o.queueFrom;
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
      if (queued) return;
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
        if (pkt.type === "HELLO" && queued) send("QUEUEINFORMATION", { curPos: 12, maxPos: 40 });
        // A beat later, so the bot has heard a tick first: a client that heard nothing past its first
        // millisecond takes itself for mid-handshake and never re-dials.
        else if (pkt.type === "REQUESTTRADE" && this.o.dropOnTrade) setTimeout(() => sock.destroy(), 300);
        else if (!(pkt.type === "LOAD" && this.o.stallLoad)) this.onPacket(pkt, send, botObjectId);
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
          ...(this.o.items ?? []).map((type, i) => ({ statType: Stat.INVENTORY0 + 4 + i, statValue: type, strStatValue: "", secondaryValue: 0 })),
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

export async function waitFor(pred: () => boolean, ms = 8000, logs: string[] = []): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met in time. log tail:\n${logs.slice(-40).join("\n")}`);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A data dir with these accounts on the roster, removed after the test. */
export function dataDirWith(accounts: Record<string, unknown>[], cleanup: (() => void)[]): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "Accounts.json"), JSON.stringify(accounts));
  return dataDir;
}
/** The account's characters as a read left them, the first one played (the one the tracker describes); `items`: instance id -> item type, in each other character's first trade slots. */
export function writeChars(dataDir: string, email: string, chars: { id: number; seasonal: boolean; items?: Record<string, number> }[]): void {
  writeStorage(dataDir, [{ email, chars }]);
}
/** writeChars for several accounts at once (one storage file holds them all). `items` values are object types, or catalog ids as strings. */
export function writeStorage(dataDir: string, accounts: { email: string; chars: { id: number; seasonal: boolean; items?: Record<string, number | string> }[]; vault?: Record<string, string> }[]): void {
  const all: Record<string, unknown> = {};
  for (const { email, chars, vault } of accounts) {
    const botGuid = deriveBotGuid(email);
    const itemId = (type: number | string) => (typeof type === "string" ? type : toCatalogId(type) ?? String(type));
    const charItems = Object.fromEntries(chars.filter((c) => c.items).map((c) => [String(c.id), Object.fromEntries(Object.entries(c.items!).map(([id, type], i) => [4 + i, { instanceId: id, itemId: itemId(type), enchantments: [], capturedAt: 0 }]))]));
    all[botGuid] = {
      alias: email, guid: email, botGuid, lastVisitAt: null, containers: vault ? containersWith(vault) : null, viewSeasonal: vault ? chars[0].seasonal : null, loginCharId: chars[0].id, charItems, charVisits: {}, moves: [], lastRun: null, lastError: null, charsAt: Date.now(),
      chars: chars.map((c) => ({ id: c.id, objectType: 782, level: 20, seasonal: c.seasonal, dead: false, backpackSlots: 0, hasBackpack: false, quickslots: [], equipment: [-1, -1, -1, -1, ...Object.values(c.items ?? {}).map((t) => (typeof t === "number" ? t : toObjType(t) ?? 0))] })),
    };
  }
  fs.writeFileSync(path.join(dataDir, "storage_state.json"), JSON.stringify({ accounts: all }));
}
/** A bring-up that logs the real GameClient into `realm` as the character the account plays, noting each login. */
export function loginsTo(realm: FakeRealm, logins: { alias: string; charId: number | null }[] = []) {
  return async (deps: FleetDeps, acc: BotAccount, server: string) => {
    logins.push({ alias: acc.alias, charId: acc.info.charId ?? null });
    const client = new GameClient({ guid: acc.guid, password: "pw", alias: acc.alias, server, proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: realm.port });
    client.adoptSession({ accessToken: "tok", charId: acc.info.charId ?? 1, seasonal: true });
    client.on("log", deps.log);
    deps.clients.set(acc.guid, client);
    client.on("stopped", () => deps.clients.delete(acc.guid));
    await client.connect();
    return client;
  };
}
/** An account's containers as a visit read them: `vault` instance id -> catalog id in its first slots (16 in all), the rest empty. */
function containersWith(vault: Record<string, string>) {
  const entries = Object.entries(vault);
  const slots = Array.from({ length: 16 }, (_, i) => (i < entries.length ? toObjType(entries[i][1]) ?? 0 : -1));
  const instances = Object.fromEntries(entries.map(([id, itemId], i) => [i, { instanceId: id, itemId, enchantments: [], capturedAt: 0 }]));
  const none = { objectId: 0, slots: [] as number[], instances: {} };
  return { vault: { objectId: 900, slots, instances }, rack: none, gift: none, spoils: none };
}
