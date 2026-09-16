// One bot account's game session: authenticate over HTTP, open the socket,
// answer the server's keepalive traffic (MOVE/PONG/acks) so the character
// stays in world, and classify login failures for the fleet to act on.
//
// Port of pyrelay's Client. The policy decisions that used to live in the
// failure handler (how long to bench an account, whether to bench a server)
// are emitted as typed events instead; the fleet layer decides.
import { EventEmitter } from "node:events";
import type { Proxy } from "../net/proxy";
import { GameSocket, type CloseReason } from "../net/gameSocket";
import { getAccessToken, getCharList, clientTokenFor, type AuthFailure } from "../realm/api";
import { ClassId, Condition, DEFAULT_SERVER, GameId, SERVER_IPS, hasCondition, isServerName } from "../realm/constants";
import { HELLO_TOKEN, type AnyPacket, type PacketName, type Packets, type Packet } from "../protocol/packets";
import type { MoveRecord, WorldPos } from "../protocol/data";
import { WorldPos as Pos } from "../protocol/data";
import { PlayerData } from "./playerData";
import { WorldState } from "./world";
import { Combat } from "./combat";
import type { RealmResources } from "../realm/resources";

const MIN_SPEED = 0.004;
const MAX_SPEED = 0.0096;
const FRAME_MS = 100;
/** Silence this long after the last queue packet means the queue is over. */
export const QUEUE_SILENCE_MS = 20_000;
/** Reconnect if the server has said nothing for this long after we were in. */
const WATCHDOG_SILENCE_MS = 2_500;
const WATCHDOG_TICK_MS = 500;

export interface AccountConfig {
  guid: string;
  password?: string;
  secret?: string;
  alias: string;
  server?: string;
  proxy: Proxy | null;
  buildVersion: string;
  /** Test hooks: dial this host/port instead of the named server. */
  host?: string;
  port?: number;
  /** Object/ground/weapon tables; enables combat, looting and dodging. */
  resources?: RealmResources;
  /**
   * Tutorial mode (the account walker): a fresh character is created on the
   * given pool, not-yet-TDone accounts are routed to the tutorial map, and
   * session kicks back off and retry instead of stopping the client.
   */
  tutorial?: { seasonal: boolean };
}

export type FailureEvent =
  | { kind: "ip-ban"; proxyHost: string }
  | { kind: "token-error"; errorId: number }
  | { kind: "account-in-use"; seconds: number }
  | { kind: "rate-limit"; seconds: number; serverJam: boolean }
  | { kind: "update-client" }
  | { kind: "bad-credentials" }
  | { kind: "bad-message" }
  | { kind: "other"; errorId: number; description: string };

export interface GameClientEvents {
  packet: [pkt: AnyPacket];
  connected: [];
  inWorld: [objectId: number];
  mapInfo: [pkt: Packet<"MAPINFO">];
  queue: [pos: number, max: number];
  failure: [ev: FailureEvent];
  disconnected: [reason: CloseReason, detail?: string];
  stopped: [];
  log: [line: string];
  /** After each 100 ms movement frame (position advanced, own shots simulated). */
  frame: [];
}

const TOKEN_ERROR_IDS = new Set([20]);
const TOKEN_ERROR_SUBSTRINGS = ["token security error", "invalid token", "token expired", "bad token"];
const RATE_LIMIT_ERROR_IDS = new Set([0]);
const CONNECTION_LIMIT_SUBSTRINGS = ["connection amount"];
const IP_BAN_SUBSTRINGS = ["ip has been temporarily banned", "abuse/hacking"];
export const TOKEN_ERROR_COOLDOWN_S = 20;
export const ACCOUNT_IN_USE_DEFAULT_S = 15;
export const ACCOUNT_IN_USE_MAX_S = 120;
export const ACCOUNT_IN_USE_BUFFER_S = 3;
export const RATE_LIMIT_DEFAULT_COOLDOWN_S = 60;
/** Tutorial mode: retry budget and back-offs after a session kick. */
export const TUTORIAL_MAX_KICKS = 5;
export const KICK_BACKOFF_S = Number(process.env.KICK_BACKOFF_SECONDS ?? 60);
export const INWORLD_BACKOFF_S = Number(process.env.INWORLD_BACKOFF_SECONDS ?? 10);

export class GameClient extends EventEmitter<GameClientEvents> {
  readonly guid: string;
  readonly alias: string;
  readonly proxy: Proxy | null;
  server: string;
  private readonly buildVersion: string;
  private readonly clientToken: string;
  private readonly creds: { guid: string; password?: string; secret?: string };

  private accessToken = "";
  tokenIssuedAt = 0;
  private currentCharId = -1;
  private needsNewChar = false;
  /** Whether the char list said the tutorial is done (TDone). */
  tutorialDone = true;
  private readonly tutorial: { seasonal: boolean } | null;
  private awaitingLoad = false;
  kickCount = 0;
  readonly world: WorldState;
  readonly combat: Combat | null;
  private serverRealTimeMS = 0;
  private lastTickLocalTime = -1;
  /** Current map's name from MAPINFO. */
  mapName = "";
  /** null until the char list has been read, or when the account has no character. */
  charSeasonal: boolean | null = null;
  /**
   * The fleet knows this character wears a backpack (char/list BackpackSlots,
   * a confirmed equip, or the tracker's 16). Stat 79 does not reach most
   * accounts and an empty backpack shows no item, so in-game evidence alone
   * would keep re-recording such a bot at 8 slots.
   */
  knownBackpack = false;
  /** What char/list said about the character's backpack at this login; null = no character. */
  charHasBackpack: boolean | null = null;
  /** In-game evidence or the fleet's knowledge: 16 trade slots. */
  get hasBackpack(): boolean {
    return this.playerData.hasBackpack || this.knownBackpack;
  }

  private gameId: number = GameId.nexus;
  private key: Uint8Array = new Uint8Array(0);
  private keyTime = -1;
  private host = "";
  private readonly port: number | undefined;
  private sock: GameSocket | null = null;
  private readonly connectedTime = Date.now();
  private connectCooldown = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastFrameTime = 0;
  private records: MoveRecord[] = [];
  private nextPos: WorldPos[] = [];
  private connecting = false;

  active = true;
  /** True once the char list was read successfully. */
  isReady = false;
  objectId = -1;
  pos: WorldPos | null = null;
  playerData = new PlayerData();
  /** Ms-since-setup of the last packet; 0 until the first arrives. */
  lastPacketTime = 0;
  queuePos = -1;
  queueMax = -1;
  private queueSince = -1;
  private lastQueueTime = -1;
  helloCount = 0;

  constructor(cfg: AccountConfig) {
    super();
    this.guid = cfg.guid;
    this.alias = cfg.alias || cfg.guid;
    this.proxy = cfg.proxy;
    this.buildVersion = cfg.buildVersion;
    this.clientToken = clientTokenFor(cfg.guid, cfg.password ?? "");
    this.server = cfg.server && isServerName(cfg.server) ? cfg.server : DEFAULT_SERVER;
    this.creds = { guid: cfg.guid, password: cfg.password, secret: cfg.secret };
    if (cfg.host) this.host = cfg.host;
    this.port = cfg.port;
    this.tutorial = cfg.tutorial ?? null;
    this.world = new WorldState(cfg.resources ?? null);
    this.combat = cfg.resources ? new Combat(this, cfg.resources) : null;
  }

  /** Tiles per ms at current speed. */
  speedPerMs(): number {
    return this.speedFor(1);
  }
  /** The serverRealTimeMS timeline, extrapolated between ticks. */
  getServerTime(): number {
    if (this.lastTickLocalTime < 0) return this.getTime();
    return this.serverRealTimeMS + (this.getTime() - this.lastTickLocalTime);
  }
  /** Public log for the combat/walker modules. */
  logLine(line: string): void {
    this.log(line);
  }

  /** Adopt an already-minted session instead of calling authenticate(). */
  adoptSession(s: { accessToken: string; charId: number; needsNewChar?: boolean; seasonal?: boolean | null; tutorialDone?: boolean }): void {
    this.accessToken = s.accessToken;
    this.tokenIssuedAt = Date.now();
    this.currentCharId = s.charId;
    this.needsNewChar = s.needsNewChar ?? false;
    this.charSeasonal = s.seasonal ?? null;
    this.tutorialDone = s.tutorialDone !== false;
    if (s.tutorialDone === false && !this.needsNewChar) this.gameId = GameId.tutorial;
    this.isReady = true;
  }

  private log(line: string): void {
    this.emit("log", `${this.alias}: ${line}`);
  }

  /** A CREATE is pending for the next Nexus MAPINFO (no character exists). */
  get needsCreate(): boolean {
    return this.needsNewChar;
  }

  /**
   * Re-read the char list with the current token (no new login): after a
   * death the character is gone and the next map needs a CREATE. Mirrors the
   * routing in authenticate(). Returns false when the token is unusable.
   */
  async refreshCharList(): Promise<boolean> {
    if (!this.accessToken) return false;
    const chars = await getCharList(this.accessToken, this.proxy);
    if (!chars.ok) return false;
    const c = chars.value;
    this.charSeasonal = c.seasonal;
    this.charHasBackpack = c.hasBackpack;
    if (c.hasBackpack !== null) this.knownBackpack = c.hasBackpack;
    if (c.charIds.length > 0) {
      this.currentCharId = c.charIds[0];
      this.needsNewChar = false;
    } else {
      this.currentCharId = c.nextCharId;
      this.needsNewChar = true;
    }
    this.tutorialDone = c.tutorialDone;
    this.gameId = !c.tutorialDone && !this.needsNewChar ? GameId.tutorial : GameId.nexus;
    return true;
  }

  // --- auth ---------------------------------------------------------------

  /** Mint a token and read the char list. Does not open the socket. */
  async authenticate(): Promise<{ ok: true } | { ok: false; error: AuthFailure }> {
    const tok = await getAccessToken(this.creds, this.clientToken, this.proxy);
    if (!tok.ok) return tok;
    this.accessToken = tok.value;
    this.tokenIssuedAt = Date.now();
    const chars = await getCharList(this.accessToken, this.proxy);
    if (!chars.ok) return chars;
    const c = chars.value;
    this.charSeasonal = c.seasonal;
    if (c.charIds.length > 0) {
      this.currentCharId = c.charIds[0];
    } else {
      this.currentCharId = c.nextCharId;
      this.needsNewChar = true;
    }
    this.tutorialDone = c.tutorialDone;
    // Since build 6.11 a first login is kicked no matter what, but CREATE is
    // only applied when sent in the Nexus; an existing not-yet-TDone char
    // loads fine in the tutorial map. So: brand-new account -> Nexus for its
    // CREATE (onFailure reroutes afterwards); existing unfinished char ->
    // straight to the tutorial.
    if (!c.tutorialDone && !this.needsNewChar) this.gameId = GameId.tutorial;
    this.isReady = true;
    return { ok: true };
  }

  // --- connection ---------------------------------------------------------

  getTime(): number {
    return Date.now() - this.connectedTime;
  }
  /** The access token this session logged in with ("" before authenticate). For read-only HTTP calls (calendar, char list) that must not mint a second token. */
  get token(): string {
    return this.accessToken;
  }
  /** The character this session plays (-1 before authenticate). */
  get charId(): number {
    return this.currentCharId;
  }

  get connected(): boolean {
    return this.sock !== null && this.sock.connected;
  }
  /** Which map the last HELLO asked for (nexus, a realm, the tutorial). */
  get gameIdValue(): number {
    return this.gameId;
  }

  /** Open the game socket to the current server and send HELLO. */
  async connect(): Promise<boolean> {
    if (!this.active || !this.isReady || this.connecting) return false;
    if (this.connectCooldown > this.getTime()) return false;
    this.connecting = true;
    try {
      if (this.sock) {
        const old = this.sock;
        this.sock = null;
        old.removeAllListeners();
        old.close();
      }
      this.stopFrames();
      // Each attempt starts at the back of the line.
      this.queuePos = -1;
      this.queueMax = -1;
      this.queueSince = -1;
      this.lastQueueTime = -1;
      if (!this.host) this.host = SERVER_IPS[this.server];
      const sock = new GameSocket(this.host, this.proxy, this.port);
      sock.on("packet", (p) => this.onPacket(p));
      sock.on("close", (reason, detail) => {
        if (this.sock !== sock) return;
        this.sock = null;
        this.stopFrames();
        this.log(`disconnected from ${this.host}: ${reason}${detail ? ` (${detail})` : ""}`);
        this.emit("disconnected", reason, detail);
      });
      sock.on("parseError", (id, err) => this.log(`failed to parse packet ${id}: ${String(err)}`));
      try {
        await sock.connect();
      } catch (e) {
        this.log(`connect to ${this.host} failed: ${(e as Error).message}`);
        // A key whose HELLO never went out is dead either way.
        this.key = new Uint8Array(0);
        this.keyTime = -1;
        this.emit("disconnected", "error", (e as Error).message);
        return false;
      }
      this.sock = sock;
      this.sendHello();
      // Single use: only the connect() directly after a RECONNECT carries one.
      this.key = new Uint8Array(0);
      this.keyTime = -1;
      this.startWatchdog();
      this.emit("connected");
      return true;
    } finally {
      this.connecting = false;
    }
  }

  private sendHello(): void {
    this.helloCount++;
    this.send("HELLO", {
      gameId: this.gameId,
      buildVersion: this.buildVersion,
      accessToken: this.accessToken,
      keyTime: this.keyTime,
      key: this.key,
      userPlatform: "rotmg",
      playPlatform: "rotmg",
      platformToken: "",
      userToken: this.clientToken,
      token: HELLO_TOKEN,
    });
  }

  send<K extends PacketName>(type: K, body: Packets[K]): boolean {
    // Flight recorder: what we sent right before a kick (FAILURE dumps it).
    this.recentSent.push(`${type}@${this.getTime()}${type === "MOVE" || type === "UPDATEACK" || type === "GOTOACK" || type === "PONG" ? "" : " " + summarize(body)}`);
    if (this.recentSent.length > 14) this.recentSent.shift();
    return this.sock?.send(type, body) ?? false;
  }
  private recentSent: string[] = [];
  private recentRecv: string[] = [];
  private noteRecv(type: string): void {
    if (type === "NEWTICK" || type === "UPDATE" || type === "GOTO" || type === "SERVERPLAYERSHOOT" || type === "ENEMYSHOOT" || type === "PLAYSOUND") return;
    this.recentRecv.push(`${type}@${this.getTime()}`);
    if (this.recentRecv.length > 10) this.recentRecv.shift();
  }

  /** Move to another realm; reconnects. */
  changeServer(server: string): Promise<boolean> {
    if (!isServerName(server)) {
      this.log(`${server} is not a valid server`);
      return Promise.resolve(false);
    }
    this.server = server;
    this.host = SERVER_IPS[server];
    this.key = new Uint8Array(0);
    this.keyTime = -1;
    this.gameId = GameId.nexus;
    return this.connect();
  }

  /** Tutorial mode: reconnect into the tutorial map. */
  gotoTutorial(): void {
    this.gameId = GameId.tutorial;
    this.disconnect();
  }

  nexus(): void {
    this.send("ESCAPE", {});
    this.gameId = GameId.nexus;
    this.key = new Uint8Array(0);
    this.keyTime = -1;
  }

  /** Close the socket but keep the client alive (the watchdog will re-dial). */
  disconnect(): void {
    if (this.tutorial) this.objectId = -1;
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      s.removeAllListeners("close");
      s.close();
      this.emit("disconnected", "local");
    }
    this.stopFrames();
    // Half a second of grace lowers the odds of a FAILURE for the old session.
    this.connectCooldown = this.getTime() + 500;
  }

  /** Retire this client for good. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.disconnect();
    this.emit("stopped");
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.active || !this.isReady || this.connected || this.connecting) return;
      // 0 means the first handshake hasn't completed; re-dialling now would
      // race the in-flight login.
      if (this.lastPacketTime === 0) return;
      if (this.lastPacketTime + WATCHDOG_SILENCE_MS < this.getTime()) void this.connect();
    }, WATCHDOG_TICK_MS);
    this.watchdog.unref();
  }

  // --- queue --------------------------------------------------------------

  inLoginQueue(silenceMs = QUEUE_SILENCE_MS): boolean {
    if (!this.active || this.objectId !== -1) return false;
    if (this.lastQueueTime < 0) return false;
    return this.getTime() - this.lastQueueTime <= silenceMs;
  }

  queueWaitMs(): number {
    return this.queueSince < 0 ? 0 : Math.max(0, this.getTime() - this.queueSince);
  }

  // --- movement -----------------------------------------------------------

  private startFrames(): void {
    this.stopFrames();
    this.lastFrameTime = this.getTime();
    this.frameTimer = setInterval(() => this.frame(), FRAME_MS);
    this.frameTimer.unref();
  }
  private stopFrames(): void {
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.frameTimer = null;
  }
  private frame(): void {
    if (!this.pos) return;
    const now = this.getTime();
    if (this.nextPos.length > 0) {
      const dt = Math.min(100, now - this.lastFrameTime);
      this.moveTowards(this.nextPos[0], dt);
    }
    this.records.push({ time: now, pos: { ...this.pos } });
    this.lastFrameTime = now;
    this.combat?.simulateShots();
    this.emit("frame");
  }
  private speedFor(dt: number): number {
    const pd = this.playerData;
    if (hasCondition(pd.condition, Condition.SLOWED)) return MIN_SPEED * dt;
    let speed = MIN_SPEED + ((pd.spd + pd.spdBoost) / 75) * (MAX_SPEED - MIN_SPEED);
    if (hasCondition(pd.condition, Condition.SPEEDY, Condition.NINJASPEEDY)) speed *= 1.5;
    return speed * dt;
  }
  private moveTowards(target: WorldPos, dt: number): void {
    if (!this.pos) return;
    const step = this.speedFor(dt);
    if (Pos.dist(this.pos, target) > step) {
      const a = Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
      this.walkTo({ x: this.pos.x + Math.cos(a) * step, y: this.pos.y + Math.sin(a) * step });
    } else {
      this.walkTo(target);
      this.nextPos.shift();
    }
  }
  private walkTo(target: WorldPos): void {
    if (hasCondition(this.playerData.condition, Condition.PARALYZED, Condition.PAUSED, Condition.PETRIFIED)) return;
    if (!this.pos) return;
    // Never step onto NoWalk ground or a wall square; slide along the wall
    // (axis-separated, like the real client) instead of stalling on a corner.
    if (this.world.isWalkable(Math.floor(target.x), Math.floor(target.y))) this.pos = { ...target };
    else if (this.world.isWalkable(Math.floor(target.x), Math.floor(this.pos.y))) this.pos = { x: target.x, y: this.pos.y };
    else if (this.world.isWalkable(Math.floor(this.pos.x), Math.floor(target.y))) this.pos = { x: this.pos.x, y: target.y };
  }
  /** Replace the walk queue. */
  setPath(points: WorldPos[]): void {
    this.nextPos = points.map((p) => ({ ...p }));
  }
  get pathLength(): number {
    return this.nextPos.length;
  }
  get pathEnd(): WorldPos | null {
    return this.nextPos.length ? this.nextPos[this.nextPos.length - 1] : null;
  }

  /** INVSWAP one item out of a ground container into our own equip slot. */
  equipFromContainer(containerId: number, containerSlot: number, itemType: number, equipSlot: number): void {
    if (!this.pos) return;
    this.send("INVSWAP", {
      time: this.getTime(), pos: { ...this.pos },
      slotObject1: { objectId: containerId, slotId: containerSlot, objectType: itemType },
      slotObject2: { objectId: this.objectId, slotId: equipSlot, objectType: this.playerData.inv[equipSlot] },
    });
  }

  /** One ack per received shot packet, ack=1 (anything else is a kick). */
  private sendShootAck(): void {
    this.send("SHOOTACKCOUNTER", { time: this.lastFrameTime, ack: 1 });
  }
  /** Queue a walk target. */
  moveTo(target: WorldPos): void {
    this.nextPos.push({ ...target });
  }

  // --- packets ------------------------------------------------------------

  private onPacket(pkt: AnyPacket): void {
    this.noteRecv(pkt.type);
    this.lastPacketTime = this.getTime();
    switch (pkt.type) {
      case "CREATESUCCESS": this.onCreateSuccess(pkt); break;
      case "GOTO": this.onGoto(pkt); break;
      case "MAPINFO": this.onMapInfo(pkt); break;
      case "QUEUEINFORMATION": this.onQueue(pkt); break;
      case "FAILURE": this.onFailure(pkt); break;
      case "PING": this.send("PONG", { serial: pkt.serial, time: this.getTime() }); break;
      case "NEWTICK": this.onNewTick(pkt); break;
      case "UPDATE": this.onUpdate(pkt); break;
      case "SERVERPLAYERSHOOT":
        // Only our own shots. Acking other players' fire is an unsolicited
        // send: in a busy nexus that's a FAILURE 0 kick within seconds
        // (flight recorder, 2026-09-02). The tutorial client acked everything
        // because nobody else is ever in the tutorial.
        if (pkt.ownerId === this.objectId) this.sendShootAck();
        break;
      case "ENEMYSHOOT":
        this.sendShootAck();
        this.combat?.onEnemyShoot(pkt);
        break;
      case "DAMAGE": this.combat?.onDamage(pkt); break;
      case "QUESTOBJID": this.world.questObjectId = pkt.objectId; break;
      case "RECONNECT": this.onReconnect(pkt); break;
      default: break;
    }
    this.emit("packet", pkt);
  }

  private onCreateSuccess(pkt: Packet<"CREATESUCCESS">): void {
    if (this.queueSince >= 0) this.log(`cleared ${this.server} queue after ${Math.floor(this.queueWaitMs() / 1000)}s`);
    this.queuePos = -1;
    this.queueMax = -1;
    this.queueSince = -1;
    this.lastQueueTime = -1;
    this.objectId = pkt.objectId;
    this.kickCount = 0;
    this.awaitingLoad = false;
    this.records = [];
    this.startFrames();
    this.send("SHOWALLYSHOOT", { toggle: 1 });
    this.emit("inWorld", pkt.objectId);
  }

  private onGoto(pkt: Packet<"GOTO">): void {
    this.send("GOTOACK", { time: this.lastFrameTime, unknownByte: 0 });
    if (pkt.objectId === this.objectId) this.pos = { ...pkt.position };
  }

  private onMapInfo(pkt: Packet<"MAPINFO">): void {
    this.log(`connected to ${this.server} ${pkt.name}`);
    this.mapName = pkt.name;
    this.nextPos = [];
    this.world.reset();
    this.combat?.resetForMap();
    if (this.needsNewChar) {
      this.log("creating new char");
      // The seasonal field is honoured (verified 2026-07-05 via the char list).
      this.send("CREATE", { classType: ClassId.WIZARD, skinType: 0, isChallenger: false, isSeasonal: this.tutorial?.seasonal ?? false, newBool: false });
      this.needsNewChar = false;
    } else {
      this.awaitingLoad = true;
      this.send("LOAD", { charId: this.currentCharId, isFromArena: false });
    }
    this.emit("mapInfo", pkt);
  }

  private onQueue(pkt: Packet<"QUEUEINFORMATION">): void {
    const now = this.getTime();
    if (this.queueSince < 0) this.queueSince = now;
    this.queuePos = pkt.curPos;
    this.queueMax = pkt.maxPos;
    this.lastQueueTime = now;
    this.connectCooldown = now + 10_000;
    this.emit("queue", pkt.curPos, pkt.maxPos);
  }

  private onNewTick(pkt: Packet<"NEWTICK">): void {
    this.serverRealTimeMS = pkt.serverRealTimeMS;
    this.lastTickLocalTime = this.getTime();
    // HP stats before the tick, so a drop counts as a damage confirm (see Combat.noteDamage).
    const hpBefore = this.combat ? pkt.statuses.map((st) => [st.objectId, this.world.entities.get(st.objectId)?.hp ?? -1] as const) : [];
    this.world.applyTick(pkt, this.objectId);
    for (const [oid, before] of hpBefore) {
      const after = this.world.entities.get(oid)?.hp ?? -1;
      if (before >= 0 && after >= 0 && after < before) this.combat!.noteDamage(oid, before - after);
    }
    let records = this.records;
    if (records.length === 0 && this.pos) {
      // An empty MOVE disconnects us.
      records = [{ time: this.lastFrameTime, pos: { ...this.pos } }];
    }
    this.records = [];
    this.send("MOVE", { tickId: pkt.tickId, time: pkt.serverRealTimeMS, records });
    for (const st of pkt.statuses) {
      if (st.objectId === this.objectId) this.playerData.applyStats(st.stats);
    }
  }

  private onUpdate(pkt: Packet<"UPDATE">): void {
    if (this.pos === null) this.pos = { ...pkt.pos };
    this.send("UPDATEACK", {});
    for (const obj of pkt.newObjs) {
      if (obj.status.objectId === this.objectId) {
        this.pos = { ...obj.status.pos };
        this.playerData.applyObject(obj);
      }
    }
    this.world.applyUpdate(pkt, this.objectId, this.pos);
  }

  private onReconnect(pkt: Packet<"RECONNECT">): void {
    if (pkt.host) this.host = pkt.host;
    this.gameId = pkt.gameId;
    this.key = pkt.key;
    this.keyTime = pkt.keyTime;
    void this.connect();
  }

  /**
   * Tutorial mode: every failure here is a session kick (0 "Bad message
   * received", 11 throttle, 13 rejected HELLO). Back off and retry; give up
   * after a handful so the walker records the failure and moves on.
   */
  private onTutorialFailure(pkt: Packet<"FAILURE">): void {
    this.log(`kick: id=${pkt.errorId} desc=${JSON.stringify(pkt.errorDescription)} map=${this.mapName} inWorld=${this.objectId !== -1}`);
    this.kickCount++;
    if (this.kickCount >= TUTORIAL_MAX_KICKS) {
      this.log(`kicked ${this.kickCount}x — giving up on this account`);
      this.emit("failure", { kind: "other", errorId: pkt.errorId, description: `kicked ${this.kickCount}x: ${pkt.errorDescription}` });
      this.stop();
      return;
    }
    this.keyTime = -1;
    this.key = new Uint8Array(0);
    if (pkt.errorId === 0 && this.awaitingLoad) {
      // LOAD was kicked with no CREATE_SUCCESS: the preseeded charId doesn't
      // exist — its CREATE was swallowed. CREATE again on the next attempt.
      this.needsNewChar = true;
    }
    this.awaitingLoad = false;
    // Not-yet-TDone accounts stay routed to the tutorial (the Nexus kicks
    // first-login accounts); a pending CREATE only applies in the Nexus.
    this.gameId = this.tutorialDone || this.needsNewChar ? GameId.nexus : GameId.tutorial;
    if (pkt.errorDescription === "s.update_client" || pkt.errorDescription === "Account credentials not valid") {
      this.emit("failure", pkt.errorDescription === "s.update_client" ? { kind: "update-client" } : { kind: "bad-credentials" });
      this.stop();
      return;
    }
    const inWorld = this.objectId !== -1;
    this.disconnect();
    const backoff = (inWorld ? INWORLD_BACKOFF_S : KICK_BACKOFF_S) * 1000;
    this.connectCooldown = Math.max(this.connectCooldown, this.getTime() + backoff);
    this.emit("failure", { kind: "other", errorId: pkt.errorId, description: pkt.errorDescription });
  }

  // --- failure classification --------------------------------------------

  private onFailure(pkt: Packet<"FAILURE">): void {
    if (pkt.errorId === 15) {
      this.disconnect();
      return;
    }
    if (this.tutorial) {
      this.onTutorialFailure(pkt);
      return;
    }
    const desc = (pkt.errorDescription || "").toLowerCase();
    const tokenAge = this.tokenIssuedAt ? Math.floor((Date.now() - this.tokenIssuedAt) / 1000) : -1;
    this.log(
      `FAILURE id=${pkt.errorId} desc=${JSON.stringify(pkt.errorDescription)} server=${this.server} ` +
        `gameId=${this.gameId} hello=${this.helloCount} tokenAge=${tokenAge}s proxy=${this.proxy?.host ?? "<none>"} ` +
        `uptime=${Math.floor(this.getTime() / 1000)}s objectId=${this.objectId}`,
    );
    this.log(`  last sent: ${this.recentSent.join(", ") || "(nothing)"}`);
    this.log(`  last recv: ${this.recentRecv.join(", ") || "(nothing)"}`);
    this.keyTime = -1;
    this.key = new Uint8Array(0);
    this.gameId = GameId.nexus;

    // Order matters: IP bans arrive as error 0 and would otherwise read as a
    // rate limit; token errors share id 20 with nothing else but the text
    // check still guards the odd build that populates a description.
    if (IP_BAN_SUBSTRINGS.some((s) => desc.includes(s))) {
      this.emit("failure", { kind: "ip-ban", proxyHost: this.proxy?.host ?? "<no-proxy>" });
      this.stop();
      return;
    }
    const tokenError =
      TOKEN_ERROR_SUBSTRINGS.some((s) => desc.includes(s)) ||
      (TOKEN_ERROR_IDS.has(pkt.errorId) && !desc.includes("account in use"));
    if (tokenError) {
      this.accessToken = "";
      this.emit("failure", { kind: "token-error", errorId: pkt.errorId });
      this.stop();
      return;
    }
    if (desc.includes("account in use")) {
      const m = /(\d+)/.exec(pkt.errorDescription || "");
      const seconds = m ? Math.max(1, Math.min(Number(m[1]) + ACCOUNT_IN_USE_BUFFER_S, ACCOUNT_IN_USE_MAX_S)) : ACCOUNT_IN_USE_DEFAULT_S;
      this.emit("failure", { kind: "account-in-use", seconds });
      this.stop();
      return;
    }
    const rateLimited = RATE_LIMIT_ERROR_IDS.has(pkt.errorId) || ["too quickly", "try again", "wait"].some((s) => desc.includes(s));
    if (rateLimited) {
      let seconds = RATE_LIMIT_DEFAULT_COOLDOWN_S;
      const m = /(\d+)/.exec(pkt.errorDescription || "");
      if (m) seconds = Math.max(Number(m[1]), RATE_LIMIT_DEFAULT_COOLDOWN_S);
      const serverJam = CONNECTION_LIMIT_SUBSTRINGS.some((s) => desc.includes(s));
      this.emit("failure", { kind: "rate-limit", seconds, serverJam });
      this.stop();
      return;
    }
    if (pkt.errorDescription === "s.update_client") {
      this.emit("failure", { kind: "update-client" });
      this.stop();
    } else if (pkt.errorDescription === "Account credentials not valid") {
      this.emit("failure", { kind: "bad-credentials" });
      this.stop();
    } else if (pkt.errorDescription === "Bad message received") {
      this.emit("failure", { kind: "bad-message" });
      this.disconnect();
    } else {
      this.emit("failure", { kind: "other", errorId: pkt.errorId, description: pkt.errorDescription });
    }
  }
}

function summarize(body: unknown): string {
  try {
    const j = JSON.stringify(body, (_k, v) => (typeof v === "string" && v.length > 24 ? v.slice(0, 12) + "…" : v));
    return j.length > 90 ? j.slice(0, 90) + "…" : j;
  } catch {
    return "?";
  }
}
