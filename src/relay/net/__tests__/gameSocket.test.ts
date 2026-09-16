// Drives GameSocket and GameClient against an in-process fake Realm server
// that speaks the same framing and RC4 (mirrored keys), so the handshake
// and keepalive behaviour are exercised end to end without the real game.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RC4, INCOMING_KEY, OUTGOING_KEY } from "../../protocol/rc4";
import { decodePayload, encodeFrame, HEADER_SIZE } from "../../protocol/codec";
import type { AnyPacket, PacketName, Packets } from "../../protocol/packets";
import { GameSocket } from "../gameSocket";
import { GameClient } from "../../client/gameClient";
import { Stat } from "../../protocol/stats";

class FakeServer {
  server: net.Server;
  port = 0;
  received: AnyPacket[] = [];
  private sock: net.Socket | null = null;
  private inbound = new RC4(OUTGOING_KEY); // client's outgoing is our incoming
  private outbound = new RC4(INCOMING_KEY);
  private pending = Buffer.alloc(0);
  private waiters: ((p: AnyPacket) => void)[] = [];
  onPacket: ((p: AnyPacket) => void) | null = null;

  constructor() {
    this.server = net.createServer((s) => {
      this.sock = s;
      s.on("data", (c) => this.onData(c));
    });
  }
  listen(): Promise<void> {
    return new Promise((res) => this.server.listen(0, "127.0.0.1", () => {
      this.port = (this.server.address() as net.AddressInfo).port;
      res();
    }));
  }
  close(): void {
    this.sock?.destroy();
    this.server.close();
  }
  send<K extends PacketName>(type: K, body: Packets[K]): void {
    const frame = encodeFrame(type, body);
    this.outbound.process(frame.subarray(HEADER_SIZE));
    this.sock!.write(frame);
  }
  next(type: string, timeoutMs = 2000): Promise<AnyPacket> {
    const hit = this.received.find((p) => p.type === type);
    if (hit) {
      this.received.splice(this.received.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no ${type} within ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push((p) => {
        if (p.type !== type) return;
        clearTimeout(t);
        this.received.splice(this.received.indexOf(p), 1);
        res(p);
      });
    });
  }
  private onData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= HEADER_SIZE) {
      const size = this.pending.readInt32BE(0);
      if (this.pending.length < size) return;
      const id = this.pending.readUInt8(4);
      const payload = Buffer.from(this.pending.subarray(HEADER_SIZE, size));
      this.pending = this.pending.subarray(size);
      this.inbound.process(payload);
      const pkt = decodePayload(id, payload);
      this.received.push(pkt);
      this.onPacket?.(pkt);
      for (const w of [...this.waiters]) w(pkt);
      this.waiters = this.waiters.filter((w) => !w);
    }
  }
}

const MAPINFO: Packets["MAPINFO"] = {
  width: 100, height: 100, name: "Nexus", displayName: "Nexus", realmName: "", seed: 1, background: 0, difficulty: 0,
  allowPlayerTeleport: true, showDisplays: true, newBool: false, maxPlayers: 85, gameOpenedTime: 0, buildVersion: "7.0.0.0.0",
  viewRadius: 15, newInt: 0, dungeonModifiers: [""], unknownShort1: 0, unknownBool: false, unknownShort2: 0, maxRealmScore: 0, curRealmScore: 0,
};

let servers: FakeServer[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});
async function fakeServer(): Promise<FakeServer> {
  const s = new FakeServer();
  await s.listen();
  servers.push(s);
  return s;
}

describe("GameSocket", () => {
  it("frames and enciphers both directions", async () => {
    const srv = await fakeServer();
    const sock = new GameSocket("127.0.0.1", null, srv.port);
    const got: AnyPacket[] = [];
    sock.on("packet", (p) => got.push(p));
    await sock.connect();
    sock.send("PLAYERTEXT", { text: "hello" });
    sock.send("REQUESTTRADE", { name: "Partner" });
    expect(await srv.next("PLAYERTEXT")).toMatchObject({ text: "hello" });
    expect(await srv.next("REQUESTTRADE")).toMatchObject({ name: "Partner" });
    srv.send("PING", { serial: 9 });
    srv.send("TRADEDONE", { code: 0, description: "ok" });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([{ type: "PING", serial: 9 }, { type: "TRADEDONE", code: 0, description: "ok" }]);
    const closed = new Promise<string>((r) => sock.on("close", (reason) => r(reason)));
    srv.close();
    expect(await closed).toBe("eof");
  });
});

describe("GameClient", () => {
  it("logs in, loads its character, and answers keepalive traffic", async () => {
    const srv = await fakeServer();
    const client = new GameClient({
      guid: "bot@example.com", password: "pw", alias: "Bot", server: "USSouth3", proxy: null,
      buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: srv.port,
    });
    client.adoptSession({ accessToken: "tok", charId: 3 });
    const inWorld = new Promise<number>((r) => client.on("inWorld", r));
    expect(await client.connect()).toBe(true);

    const hello = await srv.next("HELLO");
    expect(hello).toMatchObject({ accessToken: "tok", buildVersion: "7.0.0.0.0", gameId: -2, keyTime: -1 });
    srv.send("MAPINFO", MAPINFO);
    expect(await srv.next("LOAD")).toMatchObject({ charId: 3 });

    srv.send("CREATESUCCESS", { objectId: 42, charId: 3, pcStats: "" });
    expect(await inWorld).toBe(42);
    await srv.next("SHOWALLYSHOOT");

    srv.send("UPDATE", {
      pos: { x: 10, y: 20 }, levelType: 0, tiles: [], drops: [], unknownByte: -1,
      newObjs: [{ objectType: 782, status: { objectId: 42, pos: { x: 10, y: 20 }, stats: [
        { statType: Stat.NAME, statValue: 0, strStatValue: "BotIgn", secondaryValue: 0 },
        { statType: Stat.INVENTORY0 + 4, statValue: 2979, strStatValue: "", secondaryValue: 0 },
      ] } }],
    });
    await srv.next("UPDATEACK");
    expect(client.playerData.name).toBe("BotIgn");
    expect(client.playerData.inv[4]).toBe(2979);
    expect(client.pos).toEqual({ x: 10, y: 20 });

    srv.send("PING", { serial: 5 });
    expect(await srv.next("PONG")).toMatchObject({ serial: 5 });

    srv.send("NEWTICK", { tickId: 1, tickTime: 0, serverRealTimeMS: 123, serverLastTimeRTTMS: 0, statuses: [] });
    const move = await srv.next("MOVE");
    expect(move).toMatchObject({ tickId: 1, time: 123 });
    if (move.type === "MOVE") expect(move.records.length).toBeGreaterThan(0);

    client.stop();
  });

  it("classifies a token security error and stops", async () => {
    const srv = await fakeServer();
    const client = new GameClient({
      guid: "bot@example.com", password: "pw", alias: "Bot", proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: srv.port,
    });
    client.adoptSession({ accessToken: "tok", charId: 3 });
    const failure = new Promise((r) => client.on("failure", r));
    await client.connect();
    await srv.next("HELLO");
    srv.send("FAILURE", { errorId: 20, errorDescription: "" });
    expect(await failure).toEqual({ kind: "token-error", errorId: 20 });
    expect(client.active).toBe(false);
  });

  it("reads the wait out of an account-in-use failure", async () => {
    const srv = await fakeServer();
    const client = new GameClient({
      guid: "bot@example.com", password: "pw", alias: "Bot", proxy: null, buildVersion: "7.0.0.0.0", host: "127.0.0.1", port: srv.port,
    });
    client.adoptSession({ accessToken: "tok", charId: 3 });
    const failure = new Promise((r) => client.on("failure", r));
    await client.connect();
    await srv.next("HELLO");
    srv.send("FAILURE", { errorId: 20, errorDescription: "Account in use! (8 seconds until timeout)" });
    expect(await failure).toEqual({ kind: "account-in-use", seconds: 11 });
  });
});
