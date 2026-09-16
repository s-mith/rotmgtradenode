// The parts of the raid rules that the browser shares with the server
// (lib/raids.ts) and the fleet (relay/fleet/raidWatch.ts): stages, the
// bazaars, timers, limits, the view a raid presents to one viewer, and how a
// server maps to the region that is public before the AFK check. No server
// imports here — the Raids component loads this file.

export type RaidStatus = "headcount" | "afk" | "popping" | "running" | "ended";
export const RAID_STATUSES: readonly RaidStatus[] = ["headcount", "afk", "popping", "running", "ended"];

/** Where a key gets popped: one of the two Nexus bazaars (worlds behind the Cloth Bazaar Portals left and right of spawn). */
export const LOCATIONS = ["Left bazaar", "Right bazaar"] as const;
export type Location = (typeof LOCATIONS)[number];
export type BazaarSide = "left" | "right";
export function sideOf(location: string): BazaarSide {
  return location === "Right bazaar" ? "right" : "left";
}

export const MAX_DESCRIPTION = 200;
export const MAX_PARTY = 24;
export const MAX_KEYS = 20;
/** The AFK check: a fixed two minutes. */
export const AFK_SECONDS = 120;
/** The Pop stage: the leader has this long to pop once the AFK check is over. */
export const POP_WINDOW_S = 120;
/** One extension per pop attempt, this long. */
export const POP_EXTEND_S = 120;
export const MAX_POP_EXTENSIONS = 1;

export type EndedBy = "leader" | "leader_left" | "timeout" | "operator" | "no_pop";

/** How one pop attempt ended: confirmed = a portal of the raid's dungeon was seen in its bazaar (whoever popped it);
 *  none = a watcher stood there for the whole window and saw nothing; unverified = no watcher could look.
 *  ("other" is a legacy value from when a stranger's pop did not count.) */
export type PopVerdict = "pending" | "confirmed" | "other" | "none" | "unverified";

/** The watcher bot's progress, as the site shows it. */
export type WatcherState = "none" | "ordered" | "logging_in" | "queued" | "entering" | "in_bazaar" | "left" | "failed";
export const WATCHER_LABEL: Record<WatcherState, string> = {
  none: "no watcher", ordered: "watcher ordered", logging_in: "watcher logging in", queued: "watcher in the login queue",
  entering: "watcher entering the bazaar", in_bazaar: "watcher in the bazaar", left: "watcher left", failed: "watcher failed",
};

export interface PopView {
  /** 1-based: the first key is pop 1. */
  n: number;
  verdict: PopVerdict;
  /** Who opened it; null when nobody could be named. Any pop of the raid's dungeon in its bazaar counts, whoever popped. */
  opener: string | null;
  /** The opener was the raid's leader. */
  byLeader: boolean;
  poppedAt: number | null;
  closedAt: number | null;
  /** Raid members who vanished from the bazaar while the portal stood: the ones who went in. */
  entered: number | null;
  /** Points the leader earned for this pop (LEADER_POINTS_PER_RAIDER × raiders who went in); null until the portal closed. */
  leaderPoints: number | null;
  /** The dungeon modifiers the portal was opened with, as the server sent them. */
  modifiers: string | null;
  windowEndsAt: number | null;
}

/** A raid as one viewer is allowed to see it. */
export interface RaidView {
  id: number;
  dungeonId: string;
  leader: string;
  /** Always present: US, EU, … */
  region: string;
  /** The exact server and bazaar, or null while hidden from this viewer. */
  server: string | null;
  location: string | null;
  /** The in-game party, or null while hidden (also null when the leader set none). */
  party: string | null;
  /** True when a party name exists, whether or not it is shown yet. */
  hasParty: boolean;
  description: string;
  keys: number;
  status: RaidStatus;
  /** While status = afk: when the check closes on its own. */
  afkEndsAt: number | null;
  /** While status = popping: when the pop window closes. */
  popWindowEndsAt: number | null;
  createdAt: number;
  endedAt: number | null;
  endedBy: EndedBy | null;
  /** Player limit for the dungeon: the raid fills to it. */
  limit: number;
  raiders: string[];
  joined: boolean;
  leading: boolean;
  /** Pops confirmed so far, and keys the leader said they have minus those. */
  popsDone: number;
  keysLeft: number;
  /** Every pop attempt, oldest first. */
  pops: PopView[];
  /** The latest attempt's verdict, or null before the first. */
  verdict: PopVerdict | null;
  /** True when this key's portal is known, so a watcher can confirm it. */
  verifiable: boolean;
  watcher: { state: WatcherState; note: string; since: number | null };
  /** Players the watcher sees in the bazaar (everyone, not just raiders); null before it is inside. */
  bazaarCount: number | null;
  /** Raid members the watcher has seen in the bazaar. */
  presentCount: number;
  /** Their names: the leader's view only. */
  present: string[] | null;
  /** This viewer, a member, has been seen in the bazaar. */
  presentMe: boolean;
  /** Extensions used on the current pop attempt. */
  extended: number;
  /** The watcher can see the leader (a pop only counts within its view); null until the watcher has looked. */
  leaderInRange: boolean | null;
  /** Tiles between the leader and the watcher, as last seen. */
  leaderDistance: number | null;
  /** The leader's standing, for raiders deciding whether to join. */
  leaderRecord: LeaderRecord;
}
/** A pop counts only within the watcher's view: the leader is warned past this many tiles from it. */
export const LEADER_RANGE_TILES = 20;

// Strikes: a raid that ended because a watcher saw no pop, or one the leader
// cancelled after the AFK check had sent raiders moving. They decay after
// 30 days and stack into posting cooldowns; three block posting until an
// operator clears them.
// Points for a raid (docs/RAIDS.md §7c). Paid only when a watcher confirmed
// the pop and saw the portal close: the leader earns a share for every raider
// seen going in (uncapped), and each of those raiders earns theirs. No base
// pay for the pop itself. Rows in raid_rewards store the points as paid, so
// changing these never rescores an old raid.
export const LEADER_POINTS_PER_RAIDER = 0.1;
export const RAIDER_POINTS_ENTERED = 0.1;

export type StrikeKind = "no_pop" | "cancelled";
export const STRIKE_DECAY_MS = 30 * 24 * 60 * 60_000;
/** Posting cooldown after the Nth active strike (index = strikes); past the last entry, posting is blocked. */
export const STRIKE_COOLDOWN_MS: readonly number[] = [0, 60 * 60_000, 24 * 60 * 60_000];
export const STRIKES_TO_BLOCK = 3;

/** What a raid card says about its leader. */
export interface LeaderRecord {
  /** Raids posted. */
  led: number;
  /** Raids whose pop the leader made themselves, as a watcher saw it. */
  popped: number;
  /** Raids whose pop someone else made. */
  poppedByOthers: number;
  /** Active strikes (last 30 days, not cleared). */
  strikes: number;
}
/** Whether the leader may post now. */
export interface PostingHold {
  /** Active strikes. */
  strikes: number;
  /** When posting reopens; null when it is open, Infinity when blocked until an operator clears the strikes. */
  until: number | null;
}

/** Until the location is revealed, only the server's region is public. */
export function regionOf(server: string): string {
  return server.startsWith("US") ? "US" : server.startsWith("EU") ? "EU" : server.startsWith("Asia") ? "Asia" : server.startsWith("Aus") ? "Australia" : server;
}

export function locationRevealed(status: RaidStatus, joined: boolean, leading: boolean): boolean {
  return leading || (joined && status !== "headcount");
}
/** The party name goes out once the AFK check is complete. */
export function partyRevealed(status: RaidStatus, joined: boolean, leading: boolean): boolean {
  return leading || (joined && (status === "popping" || status === "running" || status === "ended"));
}

/** A party name as typed in game: letters, digits, spaces, a few separators. */
export function validParty(v: string): boolean {
  return v === "" || (v.length <= MAX_PARTY && /^[A-Za-z0-9 _.-]+$/.test(v));
}

// ---------------------------------------------------------------------------
// The watcher (relay/fleet/raidWatch.ts) and the site talk through these.

export interface WatchOrder {
  raidId: number;
  server: string;
  side: BazaarSide;
  /** The portal object the raid's key opens. */
  portalType: number;
  leaderIgn: string;
  /** The subscription lapses at this time. */
  until: number;
}
export interface WatcherReport {
  key: string;
  server: string;
  side: BazaarSide;
  state: WatcherState;
  note: string;
  bot: string | null;
  since: number;
  subscriptions: { raidId: number; portalType: number; until: number }[];
  roster: string[];
  pops: number;
}
export interface RaidWatchHook {
  /** Subscribe a raid to the watcher for its server and bazaar (starting one if none), or renew its `until`. */
  order(o: WatchOrder): void;
  release(raidId: number): void;
  list(): WatcherReport[];
  /** An operator's watcher with no raid, for exercising the trip; returns the watcher key. */
  manual(server: string, side: BazaarSide, minutes: number): string;
}

/** What the watcher reports when a dungeon portal appears in its bazaar. */
export interface PopReport {
  portalObjectId: number;
  portalType: number;
  dungeon: string;
  ownerAccountId: string;
  /** Who opened it: named by the server's "dungeon opened by" notification, by the portal's owner account through the roster, or null. */
  opener: { name: string; accountId: string } | null;
  /** How the opener was named: the server said so (a NOTIFICATION), the portal's owner account, or nobody yet. */
  openerSource: "notification" | "owner" | null;
  /** Players standing on the spot when it appeared, nearest first (a key portal spawns at the opener's feet). */
  beside: { name: string; accountId: string; d: number }[];
  modifiers: string;
  openedAt: number | null;
  /** Everyone in the bazaar at that moment (the watcher itself excluded). */
  roster: { name: string; accountId: string }[];
  at: number;
}
