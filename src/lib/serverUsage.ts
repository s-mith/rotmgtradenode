// Live server load, fed by the in-process fleet. The fleet's usage watcher
// asks Realm's account/servers endpoint every few seconds with any online
// bot's token and reports the answer here; deposits and withdraws are only
// accepted on servers whose load is at or under SERVER_USAGE_MAX (0 by
// default: an empty server). Same single-process design as fleetPresence.
//
// A reading older than the fresh window is ignored and the gate stands down:
// with the watcher silent (boot before any bot is online, the fleet run over
// HTTP, Realm's API down) the operator's manual controls are all that apply.
export interface ServerUsage {
  name: string;
  /** 0..1 as Realm reports it. */
  usage: number;
}
export interface UsageReading {
  usage: number;
  /** When the reading was taken, ms epoch. */
  at: number;
}

/** A report older than this is not acted on. Three refresh periods at the watcher's default. */
export const USAGE_FRESH_MS = Number(process.env.SERVER_USAGE_FRESH_SECONDS ?? 90) * 1000;
/** The most load a server may report and still take trades. */
export const USAGE_MAX = Number(process.env.SERVER_USAGE_MAX ?? 0);

type State = { byName: Map<string, number>; at: number; lastError: string | null; lastErrorAt: number };
declare global {
  // eslint-disable-next-line no-var
  var __server_usage__: State | undefined;
}
function state(): State {
  if (!globalThis.__server_usage__) globalThis.__server_usage__ = { byName: new Map(), at: 0, lastError: null, lastErrorAt: 0 };
  return globalThis.__server_usage__;
}

export const serverUsage = {
  /** A full reading from account/servers. */
  set(list: ServerUsage[], now = Date.now()): void {
    const s = state();
    s.byName = new Map(list.map((e) => [e.name, e.usage]));
    s.at = now;
    s.lastError = null;
  },
  /** The watcher could not get a reading; the last good one stands until it ages out. */
  noteError(error: string, now = Date.now()): void {
    const s = state();
    s.lastError = error;
    s.lastErrorAt = now;
  },
  /** Whether a reading fresh enough to act on is held. */
  fresh(now = Date.now()): boolean {
    const s = state();
    return s.at > 0 && now - s.at <= USAGE_FRESH_MS;
  },
  /** The server's load if a fresh reading names it, else null. */
  reading(server: string, now = Date.now()): UsageReading | null {
    const s = state();
    if (!serverUsage.fresh(now)) return null;
    const u = s.byName.get(server);
    return u === undefined ? null : { usage: u, at: s.at };
  },
  /** True when a fresh reading says the server is over the load limit. Unknown or stale: false. */
  busy(server: string, now = Date.now()): boolean {
    const r = serverUsage.reading(server, now);
    return r !== null && r.usage > USAGE_MAX;
  },
  status(now = Date.now()): { fresh: boolean; at: number | null; ageS: number | null; max: number; lastError: string | null; servers: Record<string, number> } {
    const s = state();
    return {
      fresh: serverUsage.fresh(now), at: s.at || null, ageS: s.at ? Math.round((now - s.at) / 1000) : null, max: USAGE_MAX,
      lastError: s.lastError, servers: Object.fromEntries(s.byName),
    };
  },
  /** Tests only. */
  reset(): void {
    globalThis.__server_usage__ = undefined;
  },
};
