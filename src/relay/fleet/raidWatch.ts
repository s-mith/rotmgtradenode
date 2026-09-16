// The raid watcher: a bot sent into a Nexus bazaar to see a key popped
// (docs/RAIDS.md §5). The site orders one per (server, bazaar side) through
// the hook in lib/raids.ts; several raids popping in the same bazaar share
// it. The trip: pick an idle account, hold it out of trading, log in on the
// raid's server, walk to that side's Cloth Bazaar Portal, use it, follow the
// reconnect, then stand there and read the wire — every player object (the
// roster) and every dungeon portal that appears (a pop, with the owner's
// account id, the modifiers and who stood on the spot) — reporting each to
// the site as it happens, until no raid needs it any more. It never enters
// a dungeon, never uses an item, never trades.
//
// The mechanics (which portal is which bazaar, what a pop carries) were
// proved with a human client in rotmgproxy's bazaar / players / keypop
// plugins; BazaarObserver below is their port to the relay's packet stream.
import type { GameClient } from "../client/gameClient";
import type { AnyPacket } from "../protocol/packets";
import type { StatData, WorldPos } from "../protocol/data";
import { Stat } from "../protocol/stats";
import { RESOURCES } from "../realm/resources";
import portalsRaw from "../realm/portals.json";
import type { BotAccount, BotPool } from "./botPool";
import { bringUp, BringUpRefused, takeDown, type FleetDeps } from "./bringUp";
import { walkTo } from "./backpacks";
import { LEADER_RANGE_TILES, type BazaarSide, type PopReport, type RaidWatchHook, type WatchOrder, type WatcherReport, type WatcherState } from "../../lib/raidRules";

export const CLOTH_BAZAAR_PORTAL_TYPE = 0x0750;
/**
 * Every portal object in the current game data (scripts/raid-portals.mjs), by
 * type. The relay's own object table (realm/resources.json) is from an old
 * build and lacks most of today's dungeons — the Ice Citadel portal was
 * not in it, so a live pop went unseen (2026-09-13) — hence this table.
 */
export const PORTALS: Record<string, { id: string; dungeon: string; dungeonPortal: boolean }> = portalsRaw as Record<string, { id: string; dungeon: string; dungeonPortal: boolean }>;
export function portalInfo(type: number): { id: string; dungeon: string; dungeonPortal: boolean } | undefined {
  return PORTALS[String(type)];
}
/** Portal-class objects a Nexus world always has: never a pop. */
const PERMANENT_PORTALS = new Set([CLOTH_BAZAAR_PORTAL_TYPE, 0x0712, 0x071d, 0x0704, 0x070e, 0x071c, 0x0720, 0x0746, 0x0747, 0x0748, 0x0753, 0x075e, 0x1756, 0x175c, 0xcad2, 0xcebe]);
/** A key portal spawns at the feet of whoever used it: players this close when it appears are its likely opener. */
export const OPENER_RADIUS = 2;
export const NEXUS_MAP = "Nexus";
export const TIMEOUTS = {
  /** Login, queue included. */
  inWorldMs: 180_000,
  findPortalsMs: 10_000,
  walkMs: 30_000,
  portalWaitMs: 6_000,
  portalAttempts: 3,
  bazaarInWorldMs: 30_000,
  /** Roster reports to the site at most this often. */
  rosterEveryMs: 3_000,
  retryDelayMs: 5_000,
  tickMs: 1_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dist = (a: WorldPos, b: WorldPos): number => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
// Keeping the leader within sight: a pop only counts if the portal streams
// to the watcher, and a key portal spawns at the popper's feet, so the
// leader has to stay within the watcher's view (25 tiles; warned at 20).

/** Coming back counts this many tiles inside the line, so a leader on the line does not flap. */
const RANGE_HYSTERESIS = 2;
/** Two whispers to the same leader are at least this far apart. */
const RANGE_MESSAGE_GAP_MS = 8_000;

export interface RangeChange {
  inRange: boolean;
  distance: number | null;
  /** The whisper to send the leader, or null when nothing changed (or too soon). */
  message: string | null;
}

/** Per leader: in or out of the watcher's sight, with hysteresis and a gap between messages. */
export class RangeTracker {
  private readonly state = new Map<string, { inRange: boolean | null; lastMessageAt: number; pending: boolean | null }>();
  constructor(private readonly opts: { range?: number; side: BazaarSide; botName: () => string } = { side: "left", botName: () => "the watcher" }) {}

  /** Feed the leader's position (null when not in the watcher's view at all) and the watcher's own. */
  update(leader: string, leaderPos: WorldPos | null, mine: WorldPos | null, now: number): RangeChange | null {
    const key = leader.toLowerCase();
    const range = this.opts.range ?? LEADER_RANGE_TILES;
    const st = this.state.get(key) ?? { inRange: null, lastMessageAt: 0, pending: null };
    const distance = leaderPos && mine ? dist(leaderPos, mine) : null;
    const inRange = distance !== null && (st.inRange ? distance <= range : distance <= range - RANGE_HYSTERESIS);
    if (st.inRange === inRange) {
      this.state.set(key, st);
      return null;
    }
    // A change is only spoken once the message gap has passed; until then it is held (and dropped if it flips back).
    if (now - st.lastMessageAt < RANGE_MESSAGE_GAP_MS) {
      st.pending = inRange;
      this.state.set(key, st);
      return null;
    }
    const first = st.inRange === null;
    st.inRange = inRange;
    st.pending = null;
    st.lastMessageAt = now;
    this.state.set(key, st);
    const message = inRange
      ? first
        ? `I'm watching the ${this.opts.side} bazaar from the entrance. I can see you (${distance!.toFixed(0)} tiles): pop within ${range} tiles of me and it counts.`
        : `Back in my sight (${distance!.toFixed(0)} tiles): your pop counts again.`
      : first
        ? `I'm watching the ${this.opts.side} bazaar from the entrance and can't see you yet. Come within ${range} tiles of me before you pop, or it won't count.`
        : distance === null
          ? `I can't see you any more. Come within ${range} tiles of me at the bazaar entrance or your pop won't count.`
          : `You're ${distance.toFixed(0)} tiles from me, out of my sight. Come within ${range} tiles or your pop won't count.`;
    return { inRange, distance, message };
  }

  /** A change held back by the message gap, once it has passed. */
  due(leader: string, leaderPos: WorldPos | null, mine: WorldPos | null, now: number): RangeChange | null {
    const st = this.state.get(leader.toLowerCase());
    if (!st || st.pending === null || now - st.lastMessageAt < RANGE_MESSAGE_GAP_MS) return null;
    st.pending = null;
    return this.update(leader, leaderPos, mine, now);
  }

  current(leader: string): boolean | null {
    return this.state.get(leader.toLowerCase())?.inRange ?? null;
  }
}

// ---------------------------------------------------------------------------
// Which Cloth Bazaar Portal is the left bazaar

/**
 * With both portals in view their order along x decides (the smaller x is the
 * left bazaar; the spawn is not at the map's centre, so the centre line is no
 * guide). A lone portal is left or right of the player. `mirror` swaps the
 * names if the community's left turns out to be the other one.
 */
export function bazaarSides<T extends { pos: WorldPos }>(portals: T[], me: WorldPos | null, mirror: boolean): (T & { side: BazaarSide })[] {
  const flip = (s: BazaarSide): BazaarSide => (mirror ? (s === "left" ? "right" : "left") : s);
  if (portals.length >= 2) {
    const xs = portals.map((p) => p.pos.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return portals.map((p) => ({ ...p, side: flip(p.pos.x - minX <= maxX - p.pos.x ? "left" : "right") }));
  }
  return portals.map((p) => ({ ...p, side: flip(me && p.pos.x >= me.x ? "right" : "left") }));
}

// ---------------------------------------------------------------------------
// The observer: the roster and the pops, from the bot's own packet stream

export interface RosterEntry {
  objectId: number;
  type: number;
  name: string;
  accountId: string;
  pos: WorldPos;
  gone: boolean;
}
/**
 * The server announces a key pop with two NOTIFICATIONs in the portal's tick
 * (live 2026-09-13): effect 8 with message `{"k":"s.dungeon_opened_by","t":{"player":"Name",}}`
 * and pictureType = the portal's object type; and effect 6, the bubble over the
 * opener's head, with the same key family and objectId = the opener's object.
 * The message is not valid JSON (a trailing comma), hence the regex.
 */
export interface OpenedNotice {
  player: string;
  /** The portal type (effect 8) or 0. */
  portalType: number;
  /** The opener's object id (effect 6) or 0. */
  playerObjectId: number;
  at: number;
}
export function parseOpenedNotice(n: { message: string; objectId: number; pictureType: number }, now: number): OpenedNotice | null {
  if (!/"k"\s*:\s*"s\.(dungeon_)?opened_by"/.test(n.message)) return null;
  const player = /"player"\s*:\s*"([^"]*)"/.exec(n.message)?.[1] ?? "";
  if (!player) return null;
  return { player, portalType: n.pictureType > 0 ? n.pictureType : 0, playerObjectId: n.objectId > 0 ? n.objectId : 0, at: now };
}
/** A notice and a portal belong together when they are this close in time. */
const NOTICE_WINDOW_MS = 5_000;

interface PopTrack {
  objectId: number;
  type: number;
  pos: WorldPos;
  at: number;
  /** The server's word on who opened it, once the notification has been seen. */
  announced: OpenedNotice | null;
  strings: Record<number, string>;
  numbers: Record<number, number>;
  /** Names present when it appeared; those gone by the time it closes went in. */
  presentAtPop: string[];
  /** The report went out naming the opener (else a later stat may name them and a second report follows). */
  openerReported: boolean;
  /** The modifiers the last report carried: they arrive a tick after the object (live 2026-09-13), so a second report follows them. */
  modifiersReported: string;
}
export interface ObserverOptions {
  selfId: () => number;
  /** Is this object type a player? null = unknown (then a NUMSTARS stat decides). Default: the realm resources. */
  isPlayer?: (type: number) => boolean | null;
  /** Is this object type a portal worth reporting? Default: any Portal-class object but the permanent ones. */
  isPortal?: (type: number) => boolean;
  now?: () => number;
}

export class BazaarObserver {
  readonly players = new Map<number, RosterEntry>();
  readonly pops = new Map<number, PopTrack>();
  /** "Opened by" notices not yet matched to a portal (they may precede it by a packet). */
  private readonly notices: OpenedNotice[] = [];
  /** Bumps whenever the set of present, named players changes. */
  rosterVersion = 0;
  private readonly now: () => number;
  constructor(private readonly o: ObserverOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  reset(): void {
    this.players.clear();
    this.pops.clear();
    this.notices.length = 0;
    this.rosterVersion++;
  }

  /** Everyone present and named, the bot itself excluded. */
  roster(): { name: string; accountId: string }[] {
    const out: { name: string; accountId: string }[] = [];
    for (const p of this.players.values()) if (!p.gone && p.name && p.objectId !== this.o.selfId()) out.push({ name: p.name, accountId: p.accountId });
    return out;
  }

  private isPlayer(type: number, stats: StatData[]): boolean {
    const known = this.o.isPlayer ? this.o.isPlayer(type) : (RESOURCES.object(type) ? RESOURCES.object(type)!.cls === "Player" : null);
    return known ?? stats.some((s) => s.statType === Stat.NUMSTARS);
  }
  private isPortal(type: number): boolean {
    if (this.o.isPortal) return this.o.isPortal(type);
    return (portalInfo(type) !== undefined || RESOURCES.object(type)?.cls === "Portal") && !PERMANENT_PORTALS.has(type);
  }

  /** The roster's player for a notice: by object id, else by name. */
  private playerFor(n: OpenedNotice): RosterEntry | null {
    if (n.playerObjectId) {
      const p = this.players.get(n.playerObjectId);
      if (p) return p;
    }
    const lower = n.player.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lower) return p;
    return null;
  }

  private report(t: PopTrack): PopReport {
    const owner = t.strings[Stat.OWNERACCOUNTID] ?? "";
    let opener: { name: string; accountId: string } | null = null;
    let openerSource: PopReport["openerSource"] = null;
    if (t.announced) {
      const p = this.playerFor(t.announced);
      opener = { name: p?.name || t.announced.player, accountId: p?.accountId ?? "" };
      openerSource = "notification";
    }
    if (!opener && owner) for (const p of this.players.values()) if (p.accountId === owner && p.name) { opener = { name: p.name, accountId: p.accountId }; openerSource = "owner"; break; }
    const beside = [...this.players.values()]
      .filter((p) => !p.gone && p.name && p.objectId !== this.o.selfId())
      .map((p) => ({ name: p.name, accountId: p.accountId, d: dist(p.pos, t.pos) }))
      .filter((p) => p.d <= OPENER_RADIUS)
      .sort((a, b) => a.d - b.d);
    // A named opener without an account id (a notice for a player not yet in the roster) may be named again once they stream in.
    t.openerReported = opener !== null && (opener.accountId !== "" || openerSource === "owner");
    t.modifiersReported = t.strings[Stat.MODIFIERS] ?? "";
    return {
      portalObjectId: t.objectId, portalType: t.type, dungeon: portalInfo(t.type)?.dungeon ?? "", ownerAccountId: owner, opener, openerSource, beside,
      modifiers: t.modifiersReported, openedAt: t.numbers[Stat.OPENEDATTIMESTAMP] ?? null, roster: this.roster(), at: t.at,
    };
  }

  /** Pair a notice with the portal it announces: same type when the notice says one, else the newest unannounced portal of the window. */
  private matchNotice(n: OpenedNotice): PopTrack | null {
    let best: PopTrack | null = null;
    for (const t of this.pops.values()) {
      if (t.announced || Math.abs(t.at - n.at) > NOTICE_WINDOW_MS) continue;
      if (n.portalType && t.type !== n.portalType) continue;
      if (!best || t.at > best.at) best = t;
    }
    return best;
  }

  private applyPlayerStats(p: RosterEntry, stats: StatData[]): boolean {
    let named = false;
    for (const s of stats) {
      if (s.statType === Stat.NAME && s.strStatValue && s.strStatValue !== p.name) { p.name = s.strStatValue; named = true; }
      else if (s.statType === Stat.ACCOUNTID && s.strStatValue) p.accountId = s.strStatValue;
    }
    return named;
  }

  /** Feed one packet of the bot's stream; returns what is worth reporting. */
  apply(pkt: AnyPacket): { pops: PopReport[]; closed: { portalObjectId: number; goneNames: string[]; closedAt: number }[] } {
    const pops: PopReport[] = [];
    const closed: { portalObjectId: number; goneNames: string[]; closedAt: number }[] = [];
    switch (pkt.type) {
      case "MAPINFO":
        this.reset();
        break;
      case "UPDATE": {
        for (const o of pkt.newObjs) {
          const id = o.status.objectId;
          if (id === this.o.selfId()) continue;
          const stats = o.status.stats;
          if (this.isPlayer(o.objectType, stats)) {
            let p = this.players.get(id);
            const fresh = !p;
            if (!p) {
              p = { objectId: id, type: o.objectType, name: "", accountId: "", pos: o.status.pos, gone: false };
              this.players.set(id, p);
            }
            p.pos = o.status.pos;
            if (p.gone) { p.gone = false; this.rosterVersion++; }
            if (this.applyPlayerStats(p, stats) || (fresh && p.name)) this.rosterVersion++;
          } else if (this.isPortal(o.objectType) && !this.pops.has(id)) {
            const t: PopTrack = { objectId: id, type: o.objectType, pos: o.status.pos, at: this.now(), announced: null, strings: {}, numbers: {}, presentAtPop: [], openerReported: false, modifiersReported: "" };
            for (const s of stats) {
              if (s.strStatValue) t.strings[s.statType] = s.strStatValue;
              else t.numbers[s.statType] = s.statValue;
            }
            t.presentAtPop = this.roster().map((r) => r.name);
            this.pops.set(id, t);
            // A notice that came ahead of its portal (the same tick, either order on the wire).
            const i = this.notices.findIndex((n) => Math.abs(n.at - t.at) <= NOTICE_WINDOW_MS && (!n.portalType || n.portalType === t.type));
            if (i >= 0) t.announced = this.notices.splice(i, 1)[0];
            pops.push(this.report(t));
          }
        }
        for (const id of pkt.drops) {
          const p = this.players.get(id);
          if (p && !p.gone) {
            p.gone = true;
            this.rosterVersion++;
          }
          const t = this.pops.get(id);
          if (t) {
            this.pops.delete(id);
            const present = new Set(this.roster().map((r) => r.name.toLowerCase()));
            closed.push({ portalObjectId: id, goneNames: t.presentAtPop.filter((n) => !present.has(n.toLowerCase())), closedAt: this.now() });
          }
        }
        break;
      }
      case "NEWTICK":
        for (const st of pkt.statuses) {
          const p = this.players.get(st.objectId);
          if (p) {
            p.pos = st.pos;
            if (this.applyPlayerStats(p, st.stats)) this.rosterVersion++;
            continue;
          }
          const t = this.pops.get(st.objectId);
          if (!t) continue;
          t.pos = st.pos;
          let ownerChanged = false;
          let modifiersChanged = false;
          for (const s of st.stats) {
            if (s.strStatValue) {
              if (t.strings[s.statType] === s.strStatValue) continue;
              t.strings[s.statType] = s.strStatValue;
              if (s.statType === Stat.OWNERACCOUNTID) ownerChanged = true;
              if (s.statType === Stat.MODIFIERS && s.strStatValue !== t.modifiersReported) modifiersChanged = true;
            } else t.numbers[s.statType] = s.statValue;
          }
          // The owner or the modifiers arrived after the object did: say so again, now with them.
          if ((ownerChanged && !t.openerReported) || modifiersChanged) pops.push(this.report(t));
        }
        break;
      case "NOTIFICATION": {
        const n = parseOpenedNotice(pkt, this.now());
        if (!n) break;
        const t = this.matchNotice(n);
        if (t) {
          t.announced = n;
          pops.push(this.report(t));
          break;
        }
        // The second notice of a pop (the bubble over the opener) adds their object id to a portal already announced.
        const again = [...this.pops.values()].find((x) => x.announced && !x.announced.playerObjectId && n.playerObjectId && x.announced.player === n.player && Math.abs(x.at - n.at) <= NOTICE_WINDOW_MS);
        if (again && again.announced) {
          again.announced = { ...again.announced, playerObjectId: n.playerObjectId };
          if (!again.openerReported) pops.push(this.report(again));
          break;
        }
        // Ahead of its portal (either order on the wire): kept for the next UPDATE.
        this.notices.push(n);
        while (this.notices.length > 8) this.notices.shift();
        break;
      }
    }
    // A player named only now (their stats trail their object) may be the opener an earlier report could not name.
    for (const t of this.pops.values()) {
      if (t.openerReported || (!t.announced && !t.strings[Stat.OWNERACCOUNTID])) continue;
      const r = this.report(t);
      if (r.opener?.accountId || (r.opener && !t.announced)) pops.push(r);
    }
    return { pops, closed };
  }
}

// ---------------------------------------------------------------------------
// The service: one watcher per bazaar, shared by the raids there

/** The site's side (lib/raids.ts), attached by main.ts when the fleet is embedded. */
export interface RaidSite {
  watcherUpdate(u: { raidIds: number[]; state: WatcherState; note: string; bot: string | null }): void;
  rosterSeen(u: { raidIds: number[]; names: string[] }): void;
  popSeen(u: { raidIds: number[]; pop: PopReport }): void;
  portalClosed(u: { raidIds: number[]; portalObjectId: number; goneNames: string[]; closedAt: number }): void;
  /** The raid's leader is (or is no longer) within the watcher's sight. */
  leaderRange(u: { raidId: number; inRange: boolean; distance: number | null }): void;
}

type Sub = { raidId: number; portalType: number; leaderIgn: string; until: number };

/** What a trip drives: the watcher it serves, and how to report. */
export interface TripContext {
  key: string;
  server: string;
  side: BazaarSide;
  /** Portal types the subscribed raids wait for; 0 (a manual watch) means every dungeon portal. */
  wants(): Set<number>;
  stopped(): boolean;
  report(state: WatcherState, note: string): void;
  setBot(alias: string | null): void;
  roster(names: string[]): void;
  pop(p: PopReport): void;
  closed(c: { portalObjectId: number; goneNames: string[]; closedAt: number }): void;
  /** The raids served here with a leader to keep in sight. */
  leaders(): { raidId: number; leaderIgn: string }[];
  range(raidId: number, inRange: boolean, distance: number | null): void;
}
export type TripRunner = (ctx: TripContext) => Promise<void>;

class Watcher {
  readonly subs = new Map<number, Sub>();
  state: WatcherState = "ordered";
  note = "";
  bot: string | null = null;
  roster: string[] = [];
  popsSeen = 0;
  running = false;
  stopRequested = false;
  retries = 0;
  constructor(readonly key: string, readonly server: string, readonly side: BazaarSide, public since: number) {}
}

export interface RaidWatchOptions {
  deps: FleetDeps;
  pool: BotPool;
  /** The dispatcher's maintenance holds: a watching bot is neither traded with nor evicted for idling. */
  holds: Set<string>;
  vaultBots?: () => Set<string>;
  log: (line: string) => void;
  now?: () => number;
  /** Swap which portal is called the left bazaar (RAID_BAZAAR_MIRROR=1). */
  mirror?: () => boolean;
  /** Test hook: replaces the real trip. */
  trip?: TripRunner;
  timeouts?: Partial<typeof TIMEOUTS>;
}

export class RaidWatchService implements RaidWatchHook {
  private readonly watchers = new Map<string, Watcher>();
  private site: RaidSite | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private manualSeq = 0;
  private readonly now: () => number;
  private readonly T: typeof TIMEOUTS;
  constructor(private readonly o: RaidWatchOptions) {
    this.now = o.now ?? (() => Date.now());
    this.T = { ...TIMEOUTS, ...o.timeouts };
  }

  attachSite(site: RaidSite | null): void {
    this.site = site;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.T.tickMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) w.stopRequested = true;
  }

  // --- the hook ---------------------------------------------------------------

  order(o: WatchOrder): void {
    const key = `${o.server}|${o.side}`;
    let w = this.watchers.get(key);
    if (!w) {
      w = new Watcher(key, o.server, o.side, this.now());
      this.watchers.set(key, w);
    }
    const had = w.subs.get(o.raidId);
    w.subs.set(o.raidId, { raidId: o.raidId, portalType: o.portalType, leaderIgn: o.leaderIgn, until: o.until });
    if (!had) this.o.log(`raidwatch: ${key}: ${o.raidId < 0 ? "manual watch" : `raid #${o.raidId}`} subscribed until +${Math.round((o.until - this.now()) / 1000)}s (${w.subs.size} on this watcher)`);
    w.stopRequested = false;
    if (!w.running) this.launch(w);
    // A raid joining a watcher already on its way (or in place) learns where it stands right away.
    else if (!had && o.raidId > 0) this.site?.watcherUpdate({ raidIds: [o.raidId], state: w.state, note: w.note, bot: w.bot });
  }

  release(raidId: number): void {
    for (const w of this.watchers.values()) {
      if (w.subs.delete(raidId)) this.o.log(`raidwatch: ${w.key}: raid #${raidId} released (${w.subs.size} left)`);
    }
    this.tick();
  }

  manual(server: string, side: BazaarSide, minutes: number): string {
    const raidId = -(++this.manualSeq);
    this.order({ raidId, server, side, portalType: 0, leaderIgn: "", until: this.now() + minutes * 60_000 });
    return `${server}|${side}`;
  }

  list(): WatcherReport[] {
    return [...this.watchers.values()].map((w) => ({
      key: w.key, server: w.server, side: w.side, state: w.state, note: w.note, bot: w.bot, since: w.since,
      subscriptions: [...w.subs.values()].map((s) => ({ raidId: s.raidId, portalType: s.portalType, until: s.until })),
      roster: w.roster.slice(), pops: w.popsSeen,
    }));
  }

  // --- lifecycle ---------------------------------------------------------------

  private tick(): void {
    const now = this.now();
    for (const [key, w] of [...this.watchers]) {
      for (const [id, s] of [...w.subs]) if (s.until <= now) {
        w.subs.delete(id);
        this.o.log(`raidwatch: ${key}: ${id < 0 ? "manual watch" : `raid #${id}`} lapsed`);
      }
      if (w.subs.size === 0) {
        if (w.running) w.stopRequested = true;
        else this.watchers.delete(key);
      }
    }
  }

  private raidIds(w: Watcher, portalType?: number): number[] {
    return [...w.subs.values()].filter((s) => s.raidId > 0 && (portalType === undefined || s.portalType === portalType)).map((s) => s.raidId);
  }

  private context(w: Watcher): TripContext {
    return {
      key: w.key, server: w.server, side: w.side,
      wants: () => new Set([...w.subs.values()].map((s) => s.portalType)),
      stopped: () => w.stopRequested,
      report: (state, note) => {
        w.state = state;
        w.note = note;
        this.o.log(`raidwatch: ${w.key}: ${state}${note ? ` — ${note}` : ""}`);
        this.site?.watcherUpdate({ raidIds: this.raidIds(w), state, note, bot: w.bot });
      },
      setBot: (alias) => {
        w.bot = alias;
      },
      roster: (names) => {
        w.roster = names;
        const ids = this.raidIds(w);
        if (ids.length) this.site?.rosterSeen({ raidIds: ids, names });
      },
      pop: (p) => {
        w.popsSeen++;
        this.o.log(`raidwatch: ${w.key}: portal type 0x${p.portalType.toString(16)} #${p.portalObjectId}${p.opener ? ` opened by ${p.opener.name}${p.opener.accountId ? ` (account ${p.opener.accountId})` : ""} [${p.openerSource}]` : p.ownerAccountId ? ` owner account ${p.ownerAccountId} (not in the roster)` : ""}${p.beside.length ? `; beside it: ${p.beside.map((b) => `${b.name} ${b.d.toFixed(1)}t`).join(", ")}` : ""}${p.modifiers ? `; mods ${p.modifiers}` : ""}; ${p.roster.length} in the bazaar`);
        const ids = this.raidIds(w, p.portalType);
        if (ids.length) this.site?.popSeen({ raidIds: ids, pop: p });
      },
      closed: (c) => {
        this.o.log(`raidwatch: ${w.key}: portal #${c.portalObjectId} closed; gone since the pop: ${c.goneNames.join(", ") || "nobody"}`);
        const ids = this.raidIds(w);
        if (ids.length) this.site?.portalClosed({ raidIds: ids, ...c });
      },
      leaders: () => [...w.subs.values()].filter((s) => s.raidId > 0 && s.leaderIgn).map((s) => ({ raidId: s.raidId, leaderIgn: s.leaderIgn })),
      range: (raidId, inRange, distance) => {
        this.o.log(`raidwatch: ${w.key}: raid #${raidId}'s leader ${inRange ? "in" : "out of"} sight${distance === null ? "" : ` (${distance.toFixed(1)} tiles)`}`);
        this.site?.leaderRange({ raidId, inRange, distance });
      },
    };
  }

  private launch(w: Watcher): void {
    w.running = true;
    w.stopRequested = false;
    const ctx = this.context(w);
    void (async () => {
      try {
        await (this.o.trip ?? this.trip)(ctx);
        ctx.report("left", w.subs.size ? "the trip ended" : "no raid left to watch");
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        ctx.report("failed", why);
        // Something still wants a watcher and there is time: one more go.
        const soon = this.now() + 60_000;
        if (!w.stopRequested && w.retries < 1 && [...w.subs.values()].some((s) => s.until > soon)) {
          w.retries++;
          await sleep(this.T.retryDelayMs);
          if (!w.stopRequested && w.subs.size) {
            this.o.log(`raidwatch: ${w.key}: retrying`);
            w.running = false;
            this.launch(w);
            return;
          }
        }
      } finally {
        if (w.running) {
          w.running = false;
          if (w.subs.size === 0) this.watchers.delete(w.key);
        }
      }
    })();
  }

  // --- the trip ------------------------------------------------------------------

  private pickAccount(server: string): BotAccount | null {
    const vault = this.o.vaultBots?.() ?? new Set<string>();
    const gate = this.o.deps.gate;
    const free = this.o.pool.all().filter((a) =>
      !a.online && !a.inUse && a.assignedRequestId === null && !a.suspended && !this.o.holds.has(a.guid) && !vault.has(a.botGuid) && gate.lockoutRemainingMs(a.guid) <= 0,
    );
    free.sort((a, b) => Number(b.info.server === server) - Number(a.info.server === server) || (a.guid < b.guid ? -1 : 1));
    return free[0] ?? null;
  }

  private readonly trip: TripRunner = async (ctx) => {
    const { deps, holds } = this.o;
    const T = this.T;
    if (deps.gate.pausedRemainingMs() > 0) throw new Error("logins are paused");
    const acc = this.pickAccount(ctx.server);
    if (!acc) throw new Error("no free account to send");
    holds.add(acc.guid);
    ctx.setBot(acc.alias);
    let client: GameClient | null = null;
    let onPacket: ((p: AnyPacket) => void) | null = null;
    let onQueue: ((pos: number, max: number) => void) | null = null;
    try {
      ctx.report("logging_in", `${acc.alias} on ${ctx.server}`);
      try {
        client = await (deps.bringUp ?? bringUp)(deps, acc, ctx.server);
      } catch (e) {
        throw new Error(e instanceof BringUpRefused ? `bring-up ${e.verdict}: ${e.message}` : String(e));
      }
      const c = client;
      onQueue = (pos, max) => ctx.report("queued", `${acc.alias}: position ${pos} of ${max} on ${ctx.server}`);
      c.on("queue", onQueue);
      await waitFor(c, () => inWorld(c, NEXUS_MAP), T.inWorldMs, "the Nexus", ctx);
      c.off("queue", onQueue);
      onQueue = null;
      // The observer sees the bazaar's MAPINFO (a reset) and its first UPDATE only if it listens before the portal is used.
      const obs = new BazaarObserver({ selfId: () => c.objectId, isPortal: (t) => interesting(t, ctx.wants()) });
      const seenTypes = new Set<number>();
      onPacket = (pkt) => {
        if (pkt.type === "UPDATE") {
          for (const o of pkt.newObjs) {
            const t = o.objectType;
            if (seenTypes.has(t) || RESOURCES.object(t)?.cls === "Player") continue;
            seenTypes.add(t);
            const info = portalInfo(t);
            this.o.log(`raidwatch: ${ctx.key}: object type 0x${t.toString(16)} in view${info ? ` = ${info.id}${info.dungeon ? ` (${info.dungeon})` : ""}` : RESOURCES.object(t) ? ` (${RESOURCES.object(t)!.cls || "no class"})` : " (unknown to both object tables)"} at (${o.status.pos.x.toFixed(1)},${o.status.pos.y.toFixed(1)})`);
          }
        }
        const out = obs.apply(pkt);
        for (const p of out.pops) ctx.pop(p);
        for (const x of out.closed) ctx.closed(x);
      };
      c.on("packet", onPacket);
      ctx.report("entering", `${acc.alias} in the Nexus, heading for the ${ctx.side} bazaar`);
      const mapName = await enterBazaar(c, ctx.side, T, this.o.mirror?.() ?? false, ctx);
      ctx.report("in_bazaar", `${acc.alias} in "${mapName}"${/bazaar/i.test(mapName) ? "" : " (not named like a bazaar)"}`);
      let lastVersion = -1;
      let rosterAt = 0;
      const tracker = new RangeTracker({ side: ctx.side, botName: () => c.playerData.name || acc.alias });
      const whisper = (name: string, text: string) => {
        c.send("PLAYERTEXT", { text: `/tell ${name} ${text}` });
        this.o.log(`raidwatch: ${ctx.key}: whispered ${name}: ${text}`);
      };
      while (!ctx.stopped() && c.active && c.connected) {
        const now = Date.now();
        if (obs.rosterVersion !== lastVersion && now - rosterAt >= T.rosterEveryMs) {
          lastVersion = obs.rosterVersion;
          rosterAt = now;
          ctx.roster(obs.roster().map((r) => r.name));
        }
        // Every leader served here: in sight, or whispered to come back.
        for (const { raidId, leaderIgn } of ctx.leaders()) {
          const lower = leaderIgn.toLowerCase();
          let pos: WorldPos | null = null;
          for (const p of obs.players.values()) if (!p.gone && p.name.toLowerCase() === lower) { pos = p.pos; break; }
          const change = tracker.update(leaderIgn, pos, c.pos, now) ?? tracker.due(leaderIgn, pos, c.pos, now);
          if (!change) continue;
          ctx.range(raidId, change.inRange, change.distance);
          if (change.message) whisper(leaderIgn, change.message);
        }
        await sleep(200);
      }
      if (!ctx.stopped()) throw new Error(`${acc.alias} lost its connection in the bazaar`);
    } finally {
      if (client) {
        if (onPacket) client.off("packet", onPacket);
        if (onQueue) client.off("queue", onQueue);
      }
      takeDown(deps, acc, "raid watch done");
      holds.delete(acc.guid);
    }
  };
}

/** A portal worth reporting: a dungeon portal (never the permanent ones), and one a subscribed raid waits for unless a manual watch (0) wants them all. */
export function interesting(type: number, wants: Set<number>): boolean {
  if (PERMANENT_PORTALS.has(type)) return false;
  if (portalInfo(type) === undefined && RESOURCES.object(type)?.cls !== "Portal") return false;
  return wants.size === 0 || wants.has(0) || wants.has(type);
}

const inWorld = (client: GameClient, map: string): boolean => client.connected && client.objectId !== -1 && !!client.playerData.name && client.mapName === map;

/** Poll `pred` until true or the deadline; throws with `what` on timeout, or when the watcher was told to stop. */
async function waitFor(client: GameClient, pred: () => boolean, ms: number, what: string, ctx: TripContext): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ctx.stopped()) throw new Error(`stopped while waiting for ${what}`);
    if (!client.active) throw new Error(`client went inactive while waiting for ${what}`);
    if (pred()) return;
    await sleep(150);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

/** The first `pred` packet within `ms`; arm BEFORE the action that provokes it. */
function nextPacket<K extends AnyPacket["type"]>(client: GameClient, type: K, ms: number, pred: (p: Extract<AnyPacket, { type: K }>) => boolean = () => true): Promise<Extract<AnyPacket, { type: K }> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.off("packet", on);
      resolve(null);
    }, ms);
    const on = (p: AnyPacket) => {
      if (p.type !== type) return;
      const q = p as Extract<AnyPacket, { type: K }>;
      if (!pred(q)) return;
      clearTimeout(timer);
      client.off("packet", on);
      resolve(q);
    };
    client.on("packet", on);
  });
}

/** From the Nexus: find that side's Cloth Bazaar Portal, walk to it, use it, follow the reconnect. Resolves with the bazaar world's name. */
async function enterBazaar(client: GameClient, side: BazaarSide, T: typeof TIMEOUTS, mirror: boolean, ctx: TripContext): Promise<string> {
  let last = "";
  for (let attempt = 1; attempt <= T.portalAttempts; attempt++) {
    // Both portals stand a few tiles from spawn; wait a moment for the second so the sides are told apart by their order.
    const seen: { objectId: number; pos: WorldPos }[] = [];
    const started = Date.now();
    await waitFor(client, () => {
      seen.length = 0;
      for (const [oid, ent] of client.world.entities) if (ent.type === CLOTH_BAZAAR_PORTAL_TYPE) seen.push({ objectId: oid, pos: ent.pos });
      return seen.length >= 2 || (seen.length === 1 && Date.now() - started > 3000);
    }, T.findPortalsMs, "the Cloth Bazaar Portals in view", ctx);
    const hit = bazaarSides(seen, client.pos, mirror).find((p) => p.side === side);
    if (!hit) throw new Error(`no Cloth Bazaar Portal on the ${side} (${seen.length} in view)`);
    await walkTo(client, hit.pos, 0.8, T.walkMs, `the ${side} Cloth Bazaar Portal`);
    await sleep(700); // let the server's copy of us arrive too (the first USEPORTAL right after a walk was ignored, live 2026-09-07)
    const arrived = nextPacket(client, "MAPINFO", T.portalWaitMs, (p) => p.name !== NEXUS_MAP);
    client.send("USEPORTAL", { objectId: hit.objectId });
    last = `USEPORTAL #${hit.objectId} attempt ${attempt} (portal at ${hit.pos.x.toFixed(1)},${hit.pos.y.toFixed(1)})`;
    const map = await arrived;
    if (map) {
      await waitFor(client, () => inWorld(client, map.name), T.bazaarInWorldMs, `the bazaar world "${map.name}"`, ctx);
      return map.name;
    }
  }
  throw new Error(`USEPORTAL did not lead into the bazaar after ${T.portalAttempts} attempts (${last})`);
}
