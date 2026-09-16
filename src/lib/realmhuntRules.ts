// Realm hunting (docs/REALMHUNTS.md): the rules and types the site and the
// fleet share. A hunt is a request for a dungeon in a region; a fleet bot
// goes to a server there, stays in the Nexus and opens an in-game party
// named after the hunt. The hunters roam realms for the dungeon; when one
// is inside it they say "j" in party chat, the bot teleports to them
// through the party, counts who follows within the window, and nexuses to
// wait for the next call.
import { regionOf } from "./raidRules";
import { SERVERS } from "./servers";

/** The regions a hunt can ask for: whatever the server list spans (US and EU today). */
export const REGIONS: readonly string[] = [...new Set(SERVERS.map(regionOf))];

export type HuntStatus = "open" | "ended";
export const HUNT_STATUSES: readonly HuntStatus[] = ["open", "ended"];
/** idle: no call into the hunted dungeon for CALL_IDLE_MS; timeout: the HUNT_MAX_MS ceiling; hunter: the bot failed; operator: closed from the dev console. Nobody else can close a hunt. */
export type EndedBy = "idle" | "timeout" | "operator" | "hunter";

/** Where the hunter bot is, as it reports it. */
export type HunterState = "none" | "ordered" | "logging_in" | "queued" | "hunting" | "joining" | "counting" | "returning" | "done" | "left" | "failed";
export const HUNTER_LABEL: Record<HunterState, string> = {
  none: "no hunter", ordered: "hunter ordered", logging_in: "hunter logging in", queued: "hunter in the login queue",
  hunting: "party open, waiting for a call", joining: "hunter teleporting to the caller",
  counting: "hunter counting who joins", returning: "hunter returning to the Nexus", done: "no call for 20 minutes; the hunter left the party", left: "hunter left", failed: "hunter failed",
};

/** After the hunter lands in the caller's dungeon, players seen within this window are counted. */
export const JOIN_COUNT_WINDOW_S = 30;
/**
 * The hunter waits this long for a join call; a call that lands it in the
 * hunted dungeon (outcome "counted") restarts the clock, and when it runs
 * out the hunter leaves the party and the hunt ends ("idle"). A hunt with
 * no bot is ended by the site's sweep on the same clock from its posting.
 */
export const CALL_IDLE_MS = 20 * 60_000;
/** A safety ceiling on any hunt. */
export const HUNT_MAX_MS = 12 * 60 * 60_000;
/** The hunter re-reads its party (PARTYACTION refresh) this often, so leavers are known even if the leave notice is missed. */
export const PARTY_REFRESH_MS = 60_000;
/** Ended hunts stay listed this long, and are deleted after ENDED_KEEP_MS. */
export const ENDED_LISTED_MS = 60 * 60_000;
export const ENDED_KEEP_MS = 24 * 60 * 60_000;

/**
 * A player's name without its name-style tag: the wire carries "Chambara,fe14"
 * (30 of 129 party chat lines in a live sample), the party list and the
 * site carry "Chambara". Every comparison of names goes through this.
 */
export function bareName(name: string): string {
  const i = name.indexOf(",");
  return (i < 0 ? name : name.slice(0, i)).trim();
}

/** The in-game party's name: "realmhunt Moonlight Village US". */
export function partyName(dungeon: string, region: string): string {
  return `realmhunt ${dungeon} ${region}`;
}

/**
 * A join call in party chat: "j", "join", or either followed by anything
 * ("j lb", "join me at the top"). Not "jk", "joined", "joke".
 */
export function isJoinCall(text: string): boolean {
  return /^\s*(?:j|join)(?:\s|$)/i.test(text);
}

/**
 * Points (like raids, docs/RAIDS.md §7c): on a counted call, every party
 * member the bot saw in the dungeon earns HUNTER_POINTS_ENTERED, and the
 * caller who found it earns FINDER_POINTS_PER_HUNTER for each of them
 * (themself excluded). Paid only to names with a site account.
 */
export const FINDER_POINTS_PER_HUNTER = 0.1;
export const HUNTER_POINTS_ENTERED = 0.1;

export type CallOutcome = "counted" | "other_dungeon" | "unreachable" | "failed";
export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  counted: "counted", other_dungeon: "counted, but not the hunt's dungeon", unreachable: "could not teleport to the caller", failed: "failed",
};

export interface HuntCallView {
  id: number;
  caller: string;
  at: number;
  /** Players seen in the dungeon within the window (the hunter excluded); null while the call is in progress. */
  entered: number | null;
  /** Of those, party members. */
  partyEntered: number | null;
  outcome: CallOutcome | null;
  note: string;
  doneAt: number | null;
  /** What the caller earned for this call (0 until counted). */
  finderPoints: number;
}

export interface HuntView {
  id: number;
  dungeonId: string;
  region: string;
  requester: string;
  status: HuntStatus;
  endedBy: EndedBy | null;
  /** The server the hunter was sent to; picked by the site when the hunt is posted. */
  server: string;
  partyName: string;
  /** Realm's id for the party once created, 0 before. */
  partyId: number;
  /** Party members the hunter has seen join, in order. */
  members: string[];
  hunter: { state: HunterState; note: string; bot: string | null; since: number | null };
  calls: HuntCallView[];
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** The dungeon's player limit = the party's size. */
  limit: number;
  /** The viewer posted this hunt. */
  requesting: boolean;
}

/** What the site hands the fleet for a hunt. */
export interface HuntOrder {
  huntId: number;
  server: string;
  dungeonId: string;
  dungeon: string;
  /** The portal object the dungeon drops as, when known; null = match by dungeon name only. */
  portalType: number | null;
  region: string;
  partyName: string;
  maxPartySize: number;
  /** The order lapses at this time. */
  until: number;
}
export interface HunterReport {
  huntId: number;
  server: string;
  state: HunterState;
  note: string;
  bot: string | null;
  since: number;
  partyId: number;
  members: string[];
  calls: number;
  until: number;
}
export interface RealmHuntHook {
  /** Start a hunter for the hunt (or renew its `until`). One hunter per hunt. */
  order(o: HuntOrder): void;
  release(huntId: number): void;
  list(): HunterReport[];
}

/** What the fleet reports back (relay/fleet/realmHunt.ts → lib/realmhunts.ts). */
export interface HuntSite {
  hunterUpdate(u: { huntId: number; state: HunterState; note: string; bot: string | null; server: string; partyId: number }): void;
  membersSeen(u: { huntId: number; members: string[] }): void;
  /** A join call was heard: a call row opens. Returns its id. */
  callStarted(u: { huntId: number; caller: string; at: number }): number;
  /** `names`: everyone seen in the dungeon (null when the bot never got in); `partyMembers`: the party as the bot knows it. */
  callDone(u: { huntId: number; callId: number; outcome: CallOutcome; names: string[] | null; partyMembers: string[]; note: string; at: number }): void;
}
