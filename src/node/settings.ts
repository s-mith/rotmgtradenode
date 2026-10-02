// One JSON file of node-level settings in the data dir: what the owner has
// opted into, and what the node has learned that must survive a restart.
// Read once, written whole on every change; small enough that this is fine.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_ITEM_POLICY, normalizeItemPolicy, type ItemPolicy } from "../lib/itemPolicy";

export interface NodeSettings {
  /** Opt-in ban telemetry (design doc §8). Off until the owner says yes. */
  telemetry: { enabled: boolean; hubUrl: string; salt: string };
  /** Realm builds this node has run bots on without a protocol kick (design doc §8). */
  knownBuilds: string[];
  /** Connected mode (design doc §4.3): the hub this node is linked to, or null in local mode. */
  hub: HubLink | null;
  /**
   * Logins only ever go through a proxy; with none listed, nothing logs in
   * (design doc §2). `ownInternetAt`: when the owner allowed logins from this
   * computer's own connection, confirming they understood the risk (null: not
   * allowed that way, or allowed from the console before it asked).
   */
  proxies: { required: boolean; ownInternetAt: number | null };
  /** Which catalog items this node's bots take in (src/lib/itemPolicy.ts). Everything tradeable unless the owner narrows it. */
  items: ItemPolicy;
  /**
   * Trades with players (docs/hub-protocol.md, "Player meetings"): people on
   * the hub who run no node may take this node's offers by meeting its bot in
   * game with their own character. Off until the owner says yes; at most
   * `maxMeetings` such meetings at once (by default one per bot the node can
   * have online), and the owner's rule for people who do not come.
   */
  players: PlayerTrades;
  /**
   * The login desk: a bot in game that takes "/tell <bot> <code>" logins
   * (this node's site, and the hub's sign-in when this is its login node).
   * Off: a bot logs in only while someone is logging in, and the code shows
   * once it is in the game. On: one is kept in game all the time.
   */
  loginDesk: { alwaysOn: boolean };
  /**
   * Advanced management (docs/relay/ADVANCED.md): deposits into an empty
   * character, hauls banked in idle time, potions kept together by kind,
   * withdraws served one session per account. Off by default, separately for
   * standard (pool) accounts and for communism accounts.
   */
  advanced: AdvancedManagement;
  /**
   * The first-run setup (the desktop app's wizard): when the owner finished
   * it, and whether they chose to skip linking to rotmg trade. A node that
   * already ran before the wizard existed counts as set up (Fleet).
   */
  setup: SetupSettings;
}

export interface SetupSettings {
  completedAt: number | null;
  hubSkipped: boolean;
}
/** The setup record, whatever was stored: anything odd is "not done yet". */
export function normalizeSetup(raw: unknown): SetupSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as { completedAt?: unknown; hubSkipped?: unknown };
  const at = Number(r.completedAt);
  return { completedAt: r.completedAt != null && Number.isFinite(at) && at > 0 ? at : null, hubSkipped: r.hubSkipped === true };
}

export type MergeBudget = "unlimited" | "demand";

export interface AdvancedManagement {
  /** Standard pool accounts follow the advanced rules. */
  pool: boolean;
  /** Communism accounts follow the advanced rules. */
  communism: boolean;
  /**
   * How often the node may wake a pair of bots in a quiet period to merge
   * potion stacks: as often as it helps ("unlimited", the fewest potion
   * trades), or at most twice the potion withdraws of the last hour
   * ("demand", less bot time). Merges between bots already online together
   * are never limited.
   */
  mergeBudget: MergeBudget;
  /** Seconds a bot stays online after its work (idling in its Vault, not the Nexus) before logging out: 0 or 15. */
  lingerS: number;
  /** Communism only: when communism accounts run out of room, give surplus to other nodes' communism through the hub. */
  passSurplus: boolean;
}

export const LINGER_CHOICES = [0, 15] as const;
export const DEFAULT_ADVANCED: AdvancedManagement = { pool: false, communism: false, mergeBudget: "unlimited", lingerS: 0, passSurplus: true };

/** Advanced management settings, whatever was stored or sent: unknown values fall back to the defaults (off). */
export function normalizeAdvanced(raw: unknown): AdvancedManagement {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AdvancedManagement, unknown>>;
  const linger = Number(r.lingerS);
  return {
    pool: r.pool === true,
    communism: r.communism === true,
    mergeBudget: r.mergeBudget === "demand" ? "demand" : "unlimited",
    lingerS: (LINGER_CHOICES as readonly number[]).includes(linger) ? linger : DEFAULT_ADVANCED.lingerS,
    passSurplus: r.passSurplus !== false,
  };
}

/** Whether an account follows the advanced rules: its pool's switch. */
export function advancedFor(a: AdvancedManagement | undefined, communism: boolean): boolean {
  return !!a && (communism ? a.communism : a.pool);
}

export interface PlayerTrades {
  enabled: boolean;
  /** Player meetings at once; null (the default): one per bot the node can have online, as many as its proxies allow. */
  maxMeetings: number | null;
  /** People who never came: this many no-shows within a day pause them for this many hours on this node. A limit of 0 never pauses anyone. */
  noShow: { limit: number; pauseHours: number };
}
export const MAX_PLAYER_MEETINGS = 500;
export const DEFAULT_NO_SHOW = { limit: 2, pauseHours: 24 };

/**
 * The player-trade settings, whatever was stored or sent. `fromFile`: read
 * from node.json, where a file from before 2026-09-29 (it has no `noShow`)
 * stored the old default of 2 meetings as a number; that becomes the new
 * default, one per bot online.
 */
export function normalizePlayers(raw: unknown, fromFile = false): PlayerTrades {
  const r = (raw && typeof raw === "object" ? raw : {}) as { enabled?: unknown; maxMeetings?: unknown; noShow?: unknown };
  const n = Number(r.maxMeetings);
  const oldDefault = fromFile && !(r.noShow && typeof r.noShow === "object") && n === 2;
  const maxMeetings = r.maxMeetings === null || r.maxMeetings === undefined || oldDefault ? null : Number.isInteger(n) && n >= 1 && n <= MAX_PLAYER_MEETINGS ? n : null;
  const ns = (r.noShow && typeof r.noShow === "object" ? r.noShow : {}) as { limit?: unknown; pauseHours?: unknown };
  const limit = Number(ns.limit), hours = Number(ns.pauseHours);
  return {
    enabled: r.enabled === true,
    maxMeetings,
    noShow: {
      limit: Number.isInteger(limit) && limit >= 0 && limit <= 100 ? limit : DEFAULT_NO_SHOW.limit,
      pauseHours: Number.isInteger(hours) && hours >= 0 && hours <= 720 ? hours : DEFAULT_NO_SHOW.pauseHours,
    },
  };
}

/** Player meetings the node runs at once: the owner's number, or one per bot it can have online. */
export function playerMeetingsAtOnce(p: PlayerTrades, onlineCap: number): number {
  return p.maxMeetings ?? Math.max(1, onlineCap);
}

export interface HubLink {
  url: string;
  nodeId: string;
  /** The hub account this node was linked with (for display only). */
  email: string;
  publicKeyPem: string;
  /** Sealed with src/node/secrets.ts; never written in the clear. */
  privateKeyPemSealed: string;
  linkedAt: number;
}

export const NODE_SETTINGS_FILE = "node.json";

function defaults(): NodeSettings {
  return { telemetry: { enabled: false, hubUrl: "", salt: randomBytes(16).toString("base64url") }, knownBuilds: [], hub: null, proxies: { required: true, ownInternetAt: null }, items: { ...DEFAULT_ITEM_POLICY, minTier: { ...DEFAULT_ITEM_POLICY.minTier }, overrides: {} }, players: normalizePlayers(null), loginDesk: { alwaysOn: false }, advanced: { ...DEFAULT_ADVANCED }, setup: normalizeSetup(null) };
}

export class NodeSettingsStore {
  private value: NodeSettings;
  /**
   * No setup record was stored (no file at all, or one from before the
   * first-run setup existed): the fleet decides once whether this node is
   * already set up (SetupService.adoptExisting). False for a file that
   * cannot be read, which is left alone.
   */
  readonly setupWasMissing: boolean = true;
  constructor(readonly file: string, private readonly log: (s: string) => void = () => {}) {
    this.value = defaults();
    try {
      const text = fs.readFileSync(file, "utf8");
      this.setupWasMissing = false;
      const raw = JSON.parse(text) as Partial<NodeSettings>;
      const ownAt = Number(raw.proxies?.ownInternetAt);
      this.value = {
        telemetry: { ...this.value.telemetry, ...(raw.telemetry ?? {}) },
        knownBuilds: Array.isArray(raw.knownBuilds) ? raw.knownBuilds.filter((b): b is string => typeof b === "string") : [],
        hub: raw.hub && typeof raw.hub === "object" && typeof raw.hub.nodeId === "string" ? raw.hub : null,
        proxies: { required: raw.proxies?.required !== false, ownInternetAt: raw.proxies?.ownInternetAt != null && Number.isFinite(ownAt) && ownAt > 0 ? ownAt : null },
        items: normalizeItemPolicy(raw.items),
        players: normalizePlayers(raw.players, true),
        loginDesk: { alwaysOn: raw.loginDesk?.alwaysOn === true },
        advanced: normalizeAdvanced(raw.advanced),
        setup: normalizeSetup(raw.setup),
      };
      this.setupWasMissing = raw === null || typeof raw !== "object" || raw.setup === undefined;
    } catch {
      // absent or unreadable: defaults, written on the first change
    }
  }
  static at(dataDir: string, log?: (s: string) => void): NodeSettingsStore {
    return new NodeSettingsStore(path.join(dataDir, NODE_SETTINGS_FILE), log);
  }
  get(): Readonly<NodeSettings> {
    return this.value;
  }
  update(fn: (s: NodeSettings) => void): Readonly<NodeSettings> {
    fn(this.value);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2) + "\n");
    } catch (e) {
      this.log(`node settings: could not write ${this.file}: ${String(e)}`);
    }
    return this.value;
  }
}
