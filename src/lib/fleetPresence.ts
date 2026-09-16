// Live bot presence, fed by the in-process fleet. This replaced the `bots`
// table: the dispatcher reports every bot's status straight into memory
// instead of through a signed heartbeat, and everything on the site that
// used to read the table reads this.
//
// Single-process by design, like the live bus and the rate limiter.
export type BotStatus = "idle" | "busy" | "offline";

export interface PresenceBot {
  botGuid: string;
  alias: string;
  ign: string;
  server: string;
  freeSlots: number;
  status: BotStatus;
  seasonal: boolean;
  /** Last report, ms epoch. */
  lastSeen: number;
}

/** A bot that hasn't reported within this window is treated as offline. */
export const BOT_ONLINE_WINDOW_MS = 20_000;
/** A pool-size report older than this falls back to the live count. */
const READY_COUNT_FRESH_MS = 60_000;
/** A fleet-wide room report older than this is ignored, the same way. */
const POOL_ROOM_FRESH_MS = 60_000;

/** Free trade slots per pool across every account on the roster. */
export interface PoolRoom {
  seasonal: number;
  nonseasonal: number;
}

type State = {
  bots: Map<string, PresenceBot>;
  readyCount: number;
  readyCountAt: number;
  poolRoom: PoolRoom | null;
  poolRoomAt: number;
};
declare global {
  // eslint-disable-next-line no-var
  var __fleet_presence__: State | undefined;
}
function state(): State {
  if (!globalThis.__fleet_presence__) globalThis.__fleet_presence__ = { bots: new Map(), readyCount: 0, readyCountAt: 0, poolRoom: null, poolRoomAt: 0 };
  return globalThis.__fleet_presence__;
}

export const presence = {
  report(bot: Omit<PresenceBot, "lastSeen">, now = Date.now()): void {
    state().bots.set(bot.botGuid, { ...bot, lastSeen: now });
  },
  setStatus(botGuid: string, status: BotStatus, now = Date.now()): void {
    const b = state().bots.get(botGuid);
    if (b) {
      b.status = status;
      b.lastSeen = now;
    }
  },
  /** Decrement a bot's cached free slots after a deposit landed on it. */
  tookSlots(botGuid: string, n: number): void {
    const b = state().bots.get(botGuid);
    if (b) b.freeSlots = Math.max(0, b.freeSlots - n);
  },
  get(botGuid: string): PresenceBot | undefined {
    return state().bots.get(botGuid);
  },
  ignFor(botGuid: string | null | undefined): string {
    return botGuid ? state().bots.get(botGuid)?.ign ?? "" : "";
  },
  all(): PresenceBot[] {
    return [...state().bots.values()];
  },
  /** Bots that reported within the online window. */
  online(now = Date.now()): PresenceBot[] {
    return presence.all().filter((b) => b.lastSeen >= now - BOT_ONLINE_WINDOW_MS && b.status !== "offline");
  },
  isOnline(bot: PresenceBot, now = Date.now()): boolean {
    return bot.lastSeen >= now - BOT_ONLINE_WINDOW_MS;
  },
  setReadyCount(n: number, now = Date.now()): void {
    const s = state();
    s.readyCount = n;
    s.readyCountAt = now;
  },
  /** Registered pool size if reported recently, else null. */
  readyCount(now = Date.now()): number | null {
    const s = state();
    if (!s.readyCountAt || now - s.readyCountAt > READY_COUNT_FRESH_MS) return null;
    return s.readyCount;
  },
  /** Free trade slots across the WHOLE fleet, per pool — bots online and
   *  offline alike — as the dispatcher reports them every supervise pass.
   *  This is what "is the vault full?" has to be answered from: the bots
   *  online at any moment are a handful out of thousands. */
  setPoolRoom(room: PoolRoom, now = Date.now()): void {
    const s = state();
    s.poolRoom = { seasonal: room.seasonal, nonseasonal: room.nonseasonal };
    s.poolRoomAt = now;
  },
  /** Fleet-wide free slots for one pool if reported recently, else null. */
  poolRoom(seasonal: boolean, now = Date.now()): number | null {
    const s = state();
    if (!s.poolRoom || !s.poolRoomAt || now - s.poolRoomAt > POOL_ROOM_FRESH_MS) return null;
    return seasonal ? s.poolRoom.seasonal : s.poolRoom.nonseasonal;
  },
  /** Tests only. */
  reset(): void {
    globalThis.__fleet_presence__ = undefined;
  },
};
