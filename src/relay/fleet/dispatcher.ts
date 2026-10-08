// The fleet coordinator. Port of Communism/Dispatcher.
//
// One tick every TICK_INTERVAL_S: adopt finished logins, refresh the tracker
// from live inventories, report finished trades, heartbeat, claim. Every
// SUPERVISE_INTERVAL_S: read the site's pending rows, route them against the
// tracker, disconnect bots that are no longer useful, wake bots that are.
// Policies are catalogued in docs/relay/POLICIES.md.
import fs from "node:fs";
import path from "node:path";
import type { GameClient } from "../client/gameClient";
import { GameId } from "../realm/constants";
import { PartnerCoordinator, TradeSession, type Outcome } from "../trade/tradeMachine";
import { toCatalogId } from "../trade/itemMap";
import { acceptsItem, COMMUNISM_ITEM_POLICY } from "../../lib/itemPolicy";
import { ITEM_BY_ID } from "../../lib/catalog";
import type { BotAccount, BotPool } from "./botPool";
import type { FleetDeps } from "./bringUp";
import { takeDown } from "./bringUp";
import { WakeScheduler, type WakeResult } from "./wakes";
import type { Instance, InventoryTracker } from "./inventoryTracker";
import type { LoginCodes, PoolSettings, TradeHold, WhisperQueue } from "./stores";
import type { Assignment as SiteAssignment, ItemQty, PendingDeposit, PendingWithdraw, PoolRoom, ReceivedInstance, SiteApi } from "./siteApi";
import { bucketCounts, bucketOf, collectionTargets, electRoles, fragmentation, planMoves, POTION_INFO, splitStats, type Demand, type Fragmentation, type Inventories, type Move, type MoveKind } from "./potionConsolidation";
import * as C from "./constants";
import { swapAssignment, swapResult } from "./swapJobs";
import type { FetchNeed, FetchOptions, FetchResult, StoredInstance } from "./storage";
import { advancedFor, DEFAULT_ADVANCED, type AdvancedManagement } from "../../node/settings";
import { MAX_TRADE_SLOTS } from "../../lib/depositSizes";
import { compactionWanted, gatherWanted, planEvacuation, planMerges, type AcctView, type Held } from "./advancedPlan";
import { accountLoginsWithin } from "./tokenCache";

// --- routing types ----------------------------------------------------------

interface RoutedWithdraw {
  requestId: number;
  items: ItemQty[];
  candidateBots: string[];
  seasonal: boolean;
  /** The bot the site pinned this fragment to, if any. */
  targetBotGuid: string | null;
  /** Picked physical items: only that bot, with those instances, will do. */
  perInstance: boolean;
  /** The picked instances, when perInstance. */
  instanceIds: string[] | null;
  /** A cross-node swap or player meeting: it lives by the hub's deadline, and the fleet never cancels it. */
  swap: boolean;
  /**
   * No bot carries it, but this account has what is missing in a container:
   * a fetch trip brings it onto the character first (docs/relay/STORAGE.md),
   * then the bot is a candidate.
   */
  fetchFrom: { botGuid: string; need: FetchNeed } | null;
  /** The picks sit on another character of the pinned account: it logs in as that one for the trade; no fetch. */
  switchChar: number | null;
  /** An upcoming row (advanced management): the player's row before it is being traded now. */
  headClaimed?: boolean;
}
/** The storage service as the dispatcher sees it (fleet.ts wires it). */
export interface StorageDesk {
  /** What the account behind `botGuid` holds beyond its character's trade slots. */
  stored: (botGuid: string) => StoredInstance[];
  fetch: (acc: BotAccount, need: FetchNeed, o: FetchOptions) => Promise<FetchResult>;
  /** The account's living characters with their side and trade slots, the played one first. */
  chars: (botGuid: string) => { id: number; seasonal: boolean; login: boolean; held: number; capacity: number }[];
  /** The character the tracker describes (the one the account logged in as last), or null. */
  loginChar: (botGuid: string) => number | null;
  // Advanced management (docs/relay/ADVANCED.md) works on the live client, without the log-out a trip makes.
  /** Put the played character's items in the vault, keeping `reserveSlots` of it free; `park` enters the Vault even with nothing to move. Leaves the bot in the Vault. */
  bankOnline?: (acc: BotAccount, client: GameClient, o: { keep: Set<string>; reserveSlots: number; park?: boolean; why: string }) => Promise<OnlineTrip>;
  /** A fetch for a withdraw on the live client: containers onto the played character. Leaves the bot in the Vault. */
  fetchOnline?: (acc: BotAccount, client: GameClient, need: FetchNeed, o: FetchOptions) => Promise<FetchResult>;
  /** A live storage trip is running on the account: its inventory is in flux. */
  tripping?: (guid: string) => boolean;
  /** Why a live trip would be refused now (another trip, a run, a character being made), or null. */
  liveBlocked?: (acc: BotAccount, client: GameClient) => string | null;
  /** The account's vault of that side (the two sides keep separate vaults) as last seen, or null when never seen. */
  vaultRoom?: (botGuid: string, seasonal: boolean) => { free: number; slots: number } | null;
  /** Offline runs: empty the emptiest character onto the others through the vault reserve; bank other characters' potions. */
  compact?: (acc: BotAccount, o: { reserveSlots: number; why: string }) => Promise<StorageRunResult>;
  gatherPotions?: (acc: BotAccount, o: { reserveSlots: number; why: string; maxChars?: number; stop?: () => boolean }) => Promise<StorageRunResult>;
}
/** What an online storage trip did: items moved, items it could not put away, and why not. */
export interface OnlineTrip {
  ok: boolean;
  moved: number;
  left: number;
  vaultFull?: boolean;
  /** No trip was made: the account was not free. */
  busy?: boolean;
  error?: string;
}
export interface StorageRunResult {
  ok: boolean;
  busy?: boolean;
  error?: string;
  /** Nothing was done, and why (a precondition did not hold): not a failure. */
  skipped?: string;
}
/** A player's row as the fleet refers to it: what a wake is for, what it cancels. */
type RowRef = { kind: "deposit" | "withdraw"; requestId: number };
interface FetchOrder {
  /** Trips made for this request (transient refusals — the bot was busy — do not count). */
  attempts: number;
  nextAt: number;
  inflight: boolean;
  gaveUp: boolean;
  /** An advanced account's fetch the live client cannot make (it needs another character), or one refused as busy too long: the trip with a login of its own. */
  offlineOnly?: boolean;
  /** When the live fetch was first refused as busy, in the current run of refusals. */
  busySince?: number;
}
interface RoutedDeposit {
  requestId: number;
  itemCount: number;
  seasonal: boolean;
  /** What the player said they are bringing, when they said. */
  items?: ItemQty[];
  /** Into communism: only a communism account of this half may claim it. */
  communism: boolean;
}
interface ServerRouting {
  count: number;
  withdraws: RoutedWithdraw[];
  deposits: RoutedDeposit[];
  /**
   * Each player's next row after the one being served (advanced management):
   * never claimed, counted or cancelled from here; its bot is woken, fetched
   * for or switched in time for its turn, and kept online for it.
   */
  upcoming?: RoutedWithdraw[];
}
/** Per pool side (advanced management): the characters holding nothing that intake can use. */
interface IntakeSide {
  /** Empty characters on the side, across the roster: ones a session could take a deposit into. */
  empties: number;
  /** Their slots added up, and the biggest one. */
  room: number;
  largest: number;
  /** Of them, on accounts offline now that could be woken: an empty bot that is coming. */
  offline: number;
}
type Routing = Map<string, ServerRouting>;
type BotStates = Map<string, { freeSlots: number; itemsHeld: number }>;

interface FulfillJob {
  kind: "deposit" | "withdraw";
  botGuid: string;
  requestId: number;
  items: ItemQty[];
  units?: { itemId: string; enchants: number }[] | null;
  instanceIds?: string[];
  /** The physical items received, when the tracker could tell them apart. */
  instances?: ReceivedInstance[];
  attempts: number;
  nextAt?: number;
}

interface PendingMove {
  giver: string;
  taker: string;
  /** giver -> taker */
  items: ItemQty[];
  /** taker -> giver (swaps) */
  swapItems: ItemQty[];
  stat: string;
  kind: MoveKind;
  score: number;
  reason: string;
  server: string;
  since: number;
  readySince: number | null;
  holdGuids: Set<string>;
  woken: Set<string>;
  /** Bots dropped from another server so they can log in on this one. */
  hopped: Set<string>;
  /** Advanced management's move (a potion merge, an evacuation): these physical items, giver to taker; never a swap. */
  advanced?: { why: "merge" | "evacuate"; instanceIds: string[]; fromVault: string[]; quiet: boolean; fetched?: boolean };
}
interface ConsolidationStats {
  planned: number;
  done: number;
  failed: number;
  abandoned: number;
  swaps: number;
}

export interface DispatcherOptions {
  api: SiteApi;
  pool: BotPool;
  deps: FleetDeps;
  tracker: InventoryTracker;
  settings: PoolSettings;
  hold: TradeHold;
  wakes: WakeScheduler;
  coordinator: PartnerCoordinator;
  loginCodes: LoginCodes;
  whispers: WhisperQueue;
  dataDir: string;
  /** Instances spoken for by the site (open picks, posted offers, hand-overs): never banked for room, never moved by consolidation. */
  reserved?: () => Set<string>;
  /** Keep a login desk bot in game all the time (the owner's node setting). Otherwise one logs in only while someone is logging in. */
  loginDeskAlwaysOn?: () => boolean;
  /** Servers a fresh load reading (Realm's account/servers) reports empty, or null without one: where the login desk may sit. */
  emptyServers?: () => string[] | null;
  /** Advanced management (the owner's node setting, docs/relay/ADVANCED.md): off for both pools unless the owner turns it on. */
  advanced?: () => AdvancedManagement;
}

const s = (ms: number) => ms / 1000;
const seasonalOf = (acc: BotAccount) => acc.seasonalOrDefault;
/** Shared stand-in for a bot the tracker has never seen holding anything. */
const EMPTY_INVENTORY: Readonly<Record<string, number>> = Object.freeze({});

export class Dispatcher {
  private readonly api: SiteApi;
  private readonly pool: BotPool;
  private readonly deps: FleetDeps;
  private readonly tracker: InventoryTracker;
  private readonly settings: PoolSettings;
  private readonly hold: TradeHold;
  private readonly wakes: WakeScheduler;
  private readonly coordinator: PartnerCoordinator;
  private readonly loginCodes: LoginCodes;
  private readonly whispers: WhisperQueue;
  private readonly dataDir: string;
  private readonly reserved: () => Set<string>;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeSignal = false;
  private ticking = false;

  private readonly sessions = new Map<string, TradeSession>();
  private wakeResults: WakeResult[] = [];
  private lastHeartbeat = new Map<string, number>();
  private lastClaim = new Map<string, number>();
  private lastStatus = new Map<string, string>();
  private lastTradeRetryLog = new Map<string, number>();
  private pendingFulfills: FulfillJob[] = [];
  private lastActive = new Map<string, number>();
  private serverIdleSince = new Map<string, number>();
  /** guid -> when the supervisor first saw the bot online but not in-world. */
  private notInWorldSince = new Map<string, number>();
  private swapYieldNote = new Map<string, number>();
  /** guid -> last "still waiting for the partner" note on a swap row's timeline. */
  private swapWaitNoteAt = new Map<string, number>();
  /** guid -> the player meeting whose bot has already said it is in the nexus. */
  private playerReadyNoted = new Map<string, number>();
  /** guid -> when the bot's swap row was last checked to still be open; guid -> the row found closed under it; guid -> the row whose open window it was told to close. */
  private swapRowCheckedAt = new Map<string, number>();
  private swapRowClosed = new Map<string, number>();
  private swapCancelSent = new Map<string, number>();
  private tradeTimeline = new Map<string, { claimed: number; requested?: number }>();
  private partnerWaitSince = new Map<string, [number | null, number]>();
  private consolidationAssignedAt = new Map<string, [number | null, number]>();
  /** guid -> [first deferral, limit (s), last re-evaluation] for a deposit this bot is holding off on. */
  private depositDefer = new Map<string, [number, number, number]>();
  private emptyWakeFor = new Map<string, [string, number, boolean]>();
  /** guid -> the player rows a wake brought the account in for, until it stands in world: what is cancelled should its login meet a queue. */
  private wokeFor = new Map<string, RowRef[]>();
  /** Accounts open withdraws name (the last routing pass): they keep the character that holds their items, so they do not rotate. */
  private pinnedAccounts = new Set<string>();
  private loginBotGuid: string | null = null;
  private loginDeskElected: string | null = null;
  private readonly loginDeskAlwaysOn: () => boolean;
  private readonly advancedSettings: () => AdvancedManagement;
  private readonly emptyServers: () => string[] | null;
  /** Until when the on-demand login desk stays staffed (a login asked for, a code waiting): then it may log out. */
  private loginDeskWantedUntil = 0;
  private collectorHoldSince = new Map<string, number>();
  /** When a consolidation move last landed on this collector (account guid). */
  private collectorLastArrival = new Map<string, number>();
  private collectorNoteAt = new Map<string, number>();
  private collectionTargets = new Set<string>();
  /** Per pool (seasonal?): bucket -> collectors, bucket -> where a deposit of it should land, sticky roles, split stats. */
  private collectorsByBucket = new Map<boolean, Record<string, string[]>>();
  private bucketHomes = new Map<boolean, Record<string, string[]>>();
  private consolidationRoles = new Map<boolean, Record<string, string>>();
  private consolidationSplit = new Map<boolean, Set<string>>();
  private lastFragmentation = new Map<boolean, Fragmentation>();
  private lastFragmentationLog = new Map<boolean, [number, number]>();
  private lastPlan: Move[] = [];
  private consolidationStats: ConsolidationStats = { planned: 0, done: 0, failed: 0, abandoned: 0, swaps: 0 };
  private pendingMoves: PendingMove[] = [];
  /** pairId -> the two bots, for carrying instance ids across the trade. */
  private consolidationPairs = new Map<number, { giver: string; taker: string; advanced?: "merge" | "evacuate" }>();
  private consolidationHolds = new Set<string>();
  /** Accounts a maintenance routine (the backpack chore) is driving: no claims, no consolidation, no idle disconnect. */
  readonly maintenanceHolds = new Set<string>();
  /** Accounts set aside for communism, by botGuid. */
  communismBotGuids(): Set<string> {
    return new Set(this.accounts().filter((a) => a.communism).map((a) => a.botGuid));
  }
  /** Player requests the last routing pass saw (withdraws + deposits, all servers). */
  pendingPlayerRequests(): number {
    let n = 0;
    for (const r of this.lastRouting.values()) n += r.withdraws.length + r.deposits.length;
    return n;
  }
  /** Per account, for its current by-type withdraw: instances other requests have named. */
  private keepInstances = new Map<string, Set<string>>();
  /** The advanced management settings now (live: the owner may switch them while the node runs). */
  advanced(): AdvancedManagement {
    return this.advancedSettings();
  }
  /** Whether this account follows the advanced rules: its pool's switch (standard or communism). */
  isAdvanced(acc: BotAccount): boolean {
    return advancedFor(this.advancedSettings(), acc.communism);
  }
  // --- advanced management state (docs/relay/ADVANCED.md) ---
  /** Per pool side ("p|s" pool seasonal, "c|n" communism non-seasonal…): the empty characters intake can use, from the last supervise pass. */
  private intake = new Map<string, IntakeSide>();
  /** Potions per account (botGuid) in every place it keeps them: the warehouse tie-break. Rebuilt each supervise pass. */
  private potionsHeld = new Map<string, number>();
  /** guid -> when the account's session came up, and when its last piece of work ended (the linger counts from it). */
  private sessionStartedAt = new Map<string, number>();
  private workEndedAt = new Map<string, number>();
  /** guid -> no bank trip before this: the vault had no room, or a trip failed; and no walk into the Vault to wait, after one failed. */
  private bankBackoff = new Map<string, number>();
  private parkBackoff = new Map<string, number>();
  /** Accounts on an online storage trip the dispatcher started (bank, park, fetch): held, and their inventory left alone. */
  private readonly onlineTrips = new Set<string>();
  /** Accounts an open withdraw (head or next row) counts on: their items stay put. Per routing pass. */
  private withdrawAccountsCache: Set<string> | null = null;
  /** Advanced sides' deposits by id: when first seen pending; and the sides with one waiting past ADV_INTAKE_FALLBACK_S, which take deposits the old way. */
  private depositSeenAt = new Map<number, number>();
  private intakeStuck = new Set<string>();
  /** One-character advanced accounts per planner group ("pool|seasonal"…): how many, and how many stand empty. */
  private oneCharGroups = new Map<string, { n: number; empty: number }>();
  private lastQuietPlan = 0;
  private choresCursor = 0;
  /** Offline chores (compaction, gathering) per account: when each last ran. */
  private choreRuns = new Map<string, number[]>();
  private choreInflight = new Set<string>();
  /** guid -> no chore before this: the last one found nothing to do (storage's own checks said so). */
  private choreSkipUntil = new Map<string, number>();
  private lastChores = 0;
  /** Potion withdraws handed over, by time: what the "demand" merge budget follows. */
  private potionWithdrawsAt: number[] = [];
  /** Woken (quiet-period) merge pairs started, by time. */
  private quietMergesAt: number[] = [];
  private lastMergePlan = 0;
  private advancedCounts = { banks: 0, banked: 0, parks: 0, onlineFetches: 0, merges: 0, mergeFailures: 0, evacuations: 0, compactions: 0, gathers: 0, prewakes: 0, rotations: 0 };

  private isHeld(guid: string): boolean {
    return this.consolidationHolds.has(guid) || this.maintenanceHolds.has(guid);
  }
  private moveBackoff = new Map<string, number>();
  private lastConsolidation = 0;
  private consolidationSeq = 0;
  private consolidationPoolTurn = false;
  private loginPauseNote = 0;
  /** When the login desk last said nobody can staff it (once a minute, not every tick). */
  private loginDeskNoneNote = 0;
  private lastOnlineCap: number | null = null;
  private serverJamLogAt = new Map<string, number>();
  private lastUnfulfillableSig = new Map<string, string>();
  /** Accounts set aside for communism (from the roster, every pass): they take communism requests only and are never pool capacity. */
  private communismBots = new Set<string>();
  private lastWantedServers = new Set<string>();
  private lastWantedAt = 0;
  private lastRouting: Routing = new Map();
  private lastBotStates: BotStates = new Map();
  /** Last "nothing can fulfill" note per server, so a stuck request doesn't log every tick. */
  private unfulfillableNoteAt = new Map<string, number>();
  /** Rows already cancelled as ones no account can serve ("deposit#12"), so a site slow to drop one is not asked again every pass. */
  private cancelledUnservable = new Set<string>();
  /** The backpack lane's order desk: fit an empty account of that pool half with a backpack (fleet.ts wires it). */
  private orderBackpackBot: ((seasonal: boolean) => void) | null = null;
  /** When each waiting >8-slot deposit was first seen pending, for the order timer. */
  private bigDepositSince = new Map<number, number>();
  setBackpackOrders(fn: (seasonal: boolean) => void): void {
    this.orderBackpackBot = fn;
  }
  /** The storage service: what each account keeps beyond its trade slots, and the trips that fetch it for a withdraw. */
  private storageDesk: StorageDesk | null = null;
  /** One entry per pending withdraw waiting on a fetch. */
  private readonly fetchOrders = new Map<number, FetchOrder>();
  setStorageDesk(desk: StorageDesk): void {
    this.storageDesk = desk;
  }
  private lastSupervise = 0;
  private tickCount = 0;
  private tickMsTotal = 0;
  private tickMsMax = 0;
  private claimsSkipped = 0;
  private lastHttpStatsAt = 0;

  constructor(opts: DispatcherOptions) {
    this.api = opts.api;
    this.pool = opts.pool;
    this.deps = opts.deps;
    this.tracker = opts.tracker;
    this.settings = opts.settings;
    this.hold = opts.hold;
    this.wakes = opts.wakes;
    this.coordinator = opts.coordinator;
    this.loginCodes = opts.loginCodes;
    this.whispers = opts.whispers;
    this.dataDir = opts.dataDir;
    this.reserved = opts.reserved ?? (() => new Set<string>());
    this.loginDeskAlwaysOn = opts.loginDeskAlwaysOn ?? (() => false);
    this.advancedSettings = opts.advanced ?? (() => DEFAULT_ADVANCED);
    this.emptyServers = opts.emptyServers ?? (() => null);
  }

  private log(line: string): void {
    this.deps.log(`Dispatcher: ${line}`);
  }

  // --- lifecycle --------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("started");
    // Advanced management claims on events: a new pending row starts a routing pass at once rather than at the next poll.
    this.unsubscribePending ??= this.api.onPendingChange?.(() => {
      const a = this.advancedSettings();
      if (!a.pool && !a.communism) return;
      this.lastSupervise = 0;
      this.poke();
    }) ?? null;
    this.schedule(0);
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribePending?.();
    this.unsubscribePending = null;
  }
  private unsubscribePending: (() => void) | null = null;
  /** Run the next tick as soon as the current one finishes. */
  private poke(): void {
    this.wakeSignal = true;
    if (!this.ticking) this.schedule(0);
  }
  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }
  private async loop(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    const started = Date.now();
    try {
      await this.tick();
    } catch (e) {
      this.log(`tick error: ${String(e)}`);
    }
    const elapsed = Date.now() - started;
    this.tickCount++;
    this.tickMsTotal += elapsed;
    this.tickMsMax = Math.max(this.tickMsMax, elapsed);
    const now = Date.now();
    if (now - this.lastSupervise >= C.SUPERVISE_INTERVAL_S * 1000) {
      try {
        await this.supervise();
      } catch (e) {
        this.log(`supervise error: ${String(e)}`);
      }
      try {
        await this.maintainCapacity();
      } catch (e) {
        this.log(`capacity error: ${String(e)}`);
      }
      this.lastSupervise = now;
    }
    this.reportHttpStats(now);
    this.ticking = false;
    const wait = this.wakeSignal ? 0 : C.TICK_INTERVAL_S * 1000;
    this.wakeSignal = false;
    this.schedule(wait);
  }

  // --- fleet index --------------------------------------------------------------

  private accounts(): BotAccount[] {
    return this.pool.all();
  }
  private online(): BotAccount[] {
    return this.accounts().filter((a) => a.online);
  }
  private offline(): BotAccount[] {
    return this.accounts().filter((a) => !a.online);
  }
  private sessionFor(acc: BotAccount): TradeSession | undefined {
    return this.sessions.get(acc.guid);
  }
  /** Trade slots this bot has: 8, 16 with a backpack, 24 with the upgraded
   *  one, read the same way the sweep reads it (playerData.tradeSlots, never
   *  below what an observed backpack implies). Per bot: there is no
   *  pool-wide switch. */
  private botCapacity(client: GameClient): number {
    const seen = client.playerData.tradeSlots;
    return Math.max(Number.isFinite(seen) ? seen : 8, client.hasBackpack ? 16 : 8);
  }
  private countFreeSlots(client: GameClient): number {
    const inv = client.playerData.inv;
    const end = 4 + this.botCapacity(client);
    let free = 0;
    for (let i = 4; i < end; i++) if (i < inv.length && inv[i] === -1) free++;
    return free;
  }
  /** One bot per enabled exit IP: the proxy list is the budget, so every host
   *  on it can carry a bot. MAX_ONLINE_BOTS, when set, is a ceiling on top. */
  private onlineCap(): number {
    const proxyCap = this.deps.proxies.exclusiveCapacity();
    const cap = C.onlineCapFor(proxyCap);
    if (cap !== this.lastOnlineCap) {
      this.lastOnlineCap = cap;
      const why = proxyCap === null ? `no proxy pool, DIRECT_ONLINE_BOTS` : `${proxyCap} enabled exit IP(s)${C.MAX_ONLINE_BOTS > 0 && C.MAX_ONLINE_BOTS < proxyCap ? `, ceiling MAX_ONLINE_BOTS=${C.MAX_ONLINE_BOTS}` : ""}`;
      this.log(`online cap is ${cap} (${why})`);
    }
    return cap;
  }
  private inWorld(acc: BotAccount): boolean {
    const c = acc.client;
    return !!c && c.active && c.isReady && c.connected && c.objectId !== -1;
  }
  private loginBlockedMs(acc: BotAccount): number {
    if (acc.online) return 0;
    return this.deps.gate.lockoutRemainingMs(acc.guid);
  }

  // --- tick -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    this.adoptWakes();
    const now = Date.now();
    const jobs: { acc: BotAccount; client: GameClient; heartbeat: HeartbeatPayload | null; claim: ClaimPlan | null }[] = [];
    for (const acc of this.online()) {
      const client = acc.client!;
      if (client.inLoginQueue()) {
        this.leaveLoginQueue(acc, client);
        continue;
      }
      if (this.inWorld(acc)) this.wokeFor.delete(acc.guid);
      // A storage trip on the live client moves items in and out of its slots: the trip's own bookkeeping says where they went.
      if (!this.onlineTrips.has(acc.guid) && !this.storageDesk?.tripping?.(acc.guid)) this.refreshInventory(acc, client);
      if (acc.assignedRequestId !== null) this.pollOutcome(acc, client);

      const hb = this.heartbeatPayload(acc, client);
      let heartbeat: HeartbeatPayload | null = null;
      // The status, plus what the site's deposit claim reads of an advanced bot (its slots, whether it takes only into an empty character).
      const hbKey = hb.emptyOnly === undefined ? hb.status : `${hb.status}|${hb.capacity}|${hb.emptyOnly}`;
      if (now - (this.lastHeartbeat.get(acc.botGuid) ?? 0) >= C.HEARTBEAT_INTERVAL_S * 1000 || this.lastStatus.get(acc.botGuid) !== hbKey) {
        if (this.lastStatus.get(acc.botGuid) !== hbKey && hb.status === "idle") this.lastClaim.delete(acc.botGuid);
        this.lastHeartbeat.set(acc.botGuid, now);
        this.lastStatus.set(acc.botGuid, hbKey);
        heartbeat = hb;
      }

      if (acc.assignedRequestId !== null) {
        if (this.giveUpOnStuckConsolidation(acc, client, now)) continue;
        const session = this.sessionFor(acc);
        const idle = !session || session.isIdle();
        const inNexus = this.inNexusNow(acc, client);
        // A meeting with another node's bot waits until its deadline and then
        // fails as a swap (a receipt goes out); player trades keep the short wait.
        const swap = this.swapAssignments.get(acc.guid) ?? null;
        if (swap && this.letGoOfClosedSwap(acc, client, session, now)) continue;
        // A player meeting: the moment its bot stands in the nexus is the moment the person can /trade it.
        if (swap?.swap?.player && inNexus && this.playerReadyNoted.get(acc.guid) !== acc.assignedRequestId) {
          this.playerReadyNoted.set(acc.guid, acc.assignedRequestId);
          void this.api.noteSwap?.(acc.botGuid, acc.assignedRequestId, "player-ready", { bot: client.playerData.name || this.tracker.ignFor(acc.botGuid) || "", server: client.server }).catch(() => null);
        }
        if (idle && !inNexus && (swap ? this.giveUpSwapAtDeadline(acc, client, swap, now, "never got back to the nexus") : this.giveUpWaitingForPartner(acc, client, now, "never got back to the nexus"))) continue;
        if (idle && inNexus && session) {
          if (session.sendTradeRequest()) {
            const tl = this.tradeTimeline.get(acc.guid) ?? { claimed: now };
            if (tl.requested === undefined && swap) void this.api.noteSwap?.(acc.botGuid, acc.assignedRequestId, "swap-requested", { partner: acc.assignedPartnerIgn, server: client.server }).catch(() => null);
            tl.requested = now;
            this.tradeTimeline.set(acc.guid, tl);
            if (!swap) this.partnerWaitSince.delete(acc.guid);
          } else if (swap ? this.giveUpSwapAtDeadline(acc, client, swap, now) : this.giveUpWaitingForPartner(acc, client, now)) {
            continue;
          } else if (now - (this.lastTradeRetryLog.get(acc.guid) ?? 0) >= 1000) {
            this.lastTradeRetryLog.set(acc.guid, now);
            const partner = session.getAssignment()?.partnerIgn ?? "";
            const cd = partner ? this.coordinator.cooldownRemainingMs(partner) : 0;
            const waited = now - (this.partnerWaitSince.get(acc.guid)?.[1] ?? now);
            this.log(`${acc.alias} #${acc.assignedRequestId} retry deferred (partner=${JSON.stringify(partner)}, cooldown_left=${cd}ms, waited=${Math.floor(s(waited))}s/${C.PARTNER_WAIT_MAX_S}s)`);
          }
        }
        if (heartbeat) jobs.push({ acc, client, heartbeat, claim: null });
        continue;
      }

      let claim: ClaimPlan | null = null;
      if (now - (this.lastClaim.get(acc.botGuid) ?? 0) >= C.CLAIM_INTERVAL_S * 1000) {
        claim = this.claimPlan(acc, client);
        this.lastClaim.set(acc.botGuid, now);
      }
      if (heartbeat || claim) jobs.push({ acc, client, heartbeat, claim });
    }
    await this.runAndApply(jobs);
    this.drainFulfillRetries(now);
    this.maintainLoginBot(now);
    if (C.CONSOLIDATION_ENABLED) this.maybeConsolidate(now);
    const adv = this.advancedSettings();
    if (adv.pool || adv.communism || this.pendingMoves.some((m) => m.advanced)) this.maybeAdvancedMoves(now);
  }

  private adoptWakes(): void {
    if (!this.wakeResults.length) return;
    const done = this.wakeResults;
    this.wakeResults = [];
    for (const { acc, client } of done) {
      if (!client) {
        this.wokeFor.delete(acc.guid);
        continue;
      }
      if (acc.suspended) {
        this.log(`${acc.alias} retired during login — dropping session`);
        takeDown(this.deps, acc, "retired during login");
        this.wokeFor.delete(acc.guid);
        continue;
      }
      acc.client = client;
      this.attachSession(acc, client);
      this.lastActive.set(acc.guid, Date.now());
      this.sessionStartedAt.set(acc.guid, Date.now());
    }
  }

  private attachSession(acc: BotAccount, client: GameClient): void {
    const session = new TradeSession(client, {
      coordinator: this.coordinator,
      // What comes in: the owner's Accepted items setting for a pool account; communism's own fixed list for a communism account.
      acceptsType: (type) => {
        const policy = acc.communism ? COMMUNISM_ITEM_POLICY : this.deps.itemPolicy?.();
        if (!policy) return true;
        const id = toCatalogId(type);
        return !!id && acceptsItem(policy, id);
      },
      // A by-type offer never takes a copy something else has named (the claim says which).
      excludeSlot: (slot) => {
        const id = this.tracker.instancesFor(acc.botGuid)[slot]?.instanceId;
        return !!id && !!this.keepInstances.get(acc.guid)?.has(id);
      },
      resolveInstance: (id) => {
        for (const [slot, info] of Object.entries(this.tracker.instancesFor(acc.botGuid))) {
          if (info.instanceId === id) return { slot: Number(slot), itemId: info.itemId };
        }
        return undefined;
      },
      onOutcome: () => this.poke(),
      // An advanced bot may come from its Vault: the tick asks for the trade once it stands in the Nexus.
      requestOnArrival: () => this.isAdvanced(acc),
      // A player meeting's window, as it goes: onto the swap row's timeline, from where the swap coordinator tells the player on the hub.
      onNote: (event, detail) => {
        const rid = acc.assignedRequestId;
        if (rid === null || !this.swapAssignments.has(acc.guid)) return;
        void this.api.noteSwap?.(acc.botGuid, rid, event, { bot: client.playerData.name || this.tracker.ignFor(acc.botGuid) || "", server: client.server, ...detail }).catch(() => null);
      },
      log: this.deps.log,
    });
    this.sessions.set(acc.guid, session);
    // Inbound tells: the site's login code capture. Outbound: queued whispers.
    client.on("packet", (p) => {
      if (p.type === "TEXT") {
        // Only a tell to this bot proves the sender typed the code: public,
        // guild and party lines carry no recipient (or someone else's).
        if (p.name && isTellTo(p.recipient, client.playerData.name) && this.loginCodes.noteTell(p.name, p.cleanText || p.text || "")) this.deps.log(`[login] ${p.name} verified via /tell code`);
      } else if (p.type === "NEWTICK") {
        for (const text of this.whispers.take(acc.botGuid)) {
          client.send("PLAYERTEXT", { text });
          this.deps.log(`[ign-verify] ${acc.alias} -> whispered a verification code`);
        }
      }
    });
    client.on("stopped", () => {
      // Realm dropped us or a failure stopped the client: the supervisor's
      // zombie prune turns this into a full disconnect on its next pass.
      this.poke();
    });
    // Put in the server's login queue: the next tick takes the bot out of it (leaveLoginQueue).
    client.on("queue", () => this.poke());
  }

  private refreshInventory(acc: BotAccount, client: GameClient): void {
    if (client.objectId === -1 || !client.playerData.name || !client.playerData.enchantmentsSeen) return;
    this.tracker.recordIgn(acc.botGuid, client.playerData.name);
    const inv = client.playerData.inv;
    const ench = client.playerData.enchantments;
    const cap = this.botCapacity(client);
    const end = 4 + cap;
    const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
    for (let i = 4; i < end && i < inv.length; i++) {
      if (inv[i] === -1) continue;
      const cid = toCatalogId(inv[i]);
      if (cid === undefined) continue;
      slots[i] = { itemId: cid, enchantments: [...(ench[i] ?? [])] };
    }
    if (this.tracker.updateFromSlots(acc.botGuid, slots, cap)) {
      const n = Object.values(slots).filter((x) => x.enchantments.length).length;
      this.log(`${acc.alias} inventory refreshed — ${Object.keys(slots).length} item(s), ${n} enchanted, cap ${cap}`);
    }
  }

  private heartbeatPayload(acc: BotAccount, client: GameClient): HeartbeatPayload {
    const ign = client.playerData.name || "";
    let status: "idle" | "busy" | "offline" = acc.assignedRequestId !== null ? "busy" : "idle";
    if (!client.isReady || !client.connected) status = "offline";
    if (client.objectId === -1 || !ign) status = "offline";
    let seasonal = client.charSeasonal;
    if (seasonal === null) seasonal = seasonalOf(acc);
    else if (acc.seasonal !== seasonal) this.pool.setSeasonal(acc, seasonal);
    const hb: HeartbeatPayload = { botGuid: acc.botGuid, alias: acc.alias, ign, server: client.server, freeSlots: this.countFreeSlots(client), status, seasonal, communism: acc.communism };
    // Advanced management: the site lets this bot claim a deposit only into an empty character, while its side has one anywhere.
    if (this.isAdvanced(acc)) {
      hb.capacity = this.botCapacity(client);
      hb.emptyOnly = this.emptyIntake(acc.communism, seasonal);
    }
    return hb;
  }

  private async runAndApply(jobs: { acc: BotAccount; client: GameClient; heartbeat: HeartbeatPayload | null; claim: ClaimPlan | null }[]): Promise<void> {
    if (!jobs.length) return;
    const results = await Promise.all(
      jobs.map(async (j) => {
        // Heartbeat first: the site gates claims on the row it writes.
        let hb: Awaited<ReturnType<SiteApi["heartbeat"]>> | null = null;
        let claim: Awaited<ReturnType<SiteApi["claimDeposit"]>> | null = null;
        try {
          if (j.heartbeat) hb = await this.api.heartbeat(j.heartbeat);
          if (j.claim) claim = await this.claimCall(j.claim);
        } catch (e) {
          this.log(`site call for ${j.acc.alias} raised: ${String(e)}`);
        }
        return { ...j, hb, claimResult: claim };
      }),
    );
    for (const r of results) {
      if (r.hb && !r.hb.ok) {
        this.log(`heartbeat(${r.acc.alias}) failed: ${r.hb.error}`);
        this.lastStatus.delete(r.acc.botGuid);
      }
      const assignment = r.claimResult && r.claimResult.ok ? r.claimResult.assignment : null;
      if (!assignment) continue;
      if (r.acc.assignedRequestId !== null) {
        this.log(`${r.acc.alias} claimed ${assignment.kind} #${assignment.requestId} but is already busy — unclaiming`);
        void this.api.unclaim(r.acc.botGuid, assignment.requestId, assignment.kind).catch((e) => this.log(`unclaim raised: ${String(e)}`));
        continue;
      }
      this.acceptAssignment(r.acc, r.client, assignment);
    }
  }

  private async claimCall(plan: ClaimPlan) {
    if (plan.tryWithdraw) {
      const r = await this.api.claimWithdraw(plan.botGuid, plan.inventory, plan.instanceIds, plan.heldItems);
      if (r.ok && r.assignment) return r;
    }
    if (plan.tryDeposit) return this.api.claimDeposit(plan.botGuid, plan.freeSlots, plan.preferRequestId ?? null);
    return { ok: true as const, assignment: null };
  }

  // --- claim planning -----------------------------------------------------------

  private claimPlan(acc: BotAccount, client: GameClient): ClaimPlan | null {
    if (this.hold.active) return null;
    if (!client.isReady || !client.connected || !client.server) return null;
    if (client.objectId === -1 || !client.playerData.name) return null;
    if (this.isHeld(acc.guid) || this.onlineTrips.has(acc.guid)) return null;
    const [wantWithdraw, wantDeposit] = this.pendingKindsFor(acc, client);
    if (!wantWithdraw && !wantDeposit) {
      this.claimsSkipped++;
      return null;
    }
    const plan: ClaimPlan = { botGuid: acc.botGuid, tryWithdraw: false, tryDeposit: false, inventory: [], instanceIds: [], freeSlots: 0 };
    // Per-instance work (a pick, a swap) is judged against the tracker, which
    // only reflects this login once the enchantment stat has arrived; before
    // that the tracker may still describe the character as it was, and a
    // claim on stale slots ends in "items not present" at the trade window.
    if (wantWithdraw && client.playerData.enchantmentsSeen) {
      plan.inventory = Object.entries(this.tracker.itemsFor(acc.botGuid)).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
      plan.instanceIds = Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId);
      // Advanced: which item each one is, so picks waiting on its other characters do not hold back a by-type row here.
      if (this.isAdvanced(acc)) plan.heldItems = Object.fromEntries(Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => [i.instanceId, i.itemId]));
      plan.tryWithdraw = true;
    }
    const intakeSide = client.charSeasonal ?? seasonalOf(acc);
    if (wantDeposit && this.isAdvanced(acc) && this.emptyIntake(acc.communism, intakeSide)) {
      // Advanced management: a deposit goes into an empty character, in one trade when it fits.
      const liveFree = this.countFreeSlots(client);
      const cap = this.botCapacity(client);
      if (liveFree >= cap && this.advancedDepositClaim(acc, client, cap)) {
        plan.freeSlots = liveFree;
        plan.tryDeposit = true;
      }
    } else if (wantDeposit) {
      const liveFree = this.countFreeSlots(client);
      // A communism account: communism's deposits on this server, with no
      // deferral — the pool's bots can't take them.
      const pinned = liveFree > 0 && acc.communism ? this.lastRouting.get(client.server)?.deposits.find((d) => d.communism && d.seasonal === seasonalOf(acc)) : undefined;
      // A deposit whose declared items this bot gathers is its to take —
      // that is the whole point of the hint — and it names the row so the
      // site doesn't hand it the oldest one instead.
      const routed = !pinned && liveFree > 0 ? this.depositRoutedTo(acc, client) : null;
      if (pinned && this.communismRoomierFor(acc, pinned, liveFree)) {
        // A roomier character of its side takes a full trade of it: no claim
        // here; the supervise pass brings it back as that one (rotateFor).
      } else if (pinned) {
        plan.freeSlots = liveFree;
        plan.tryDeposit = true;
        plan.preferRequestId = pinned.requestId;
      } else if (routed && liveFree >= routed.itemCount) {
        plan.freeSlots = liveFree;
        plan.tryDeposit = true;
        plan.preferRequestId = routed.requestId;
      } else if (liveFree > 0 && this.depositFitsHere(acc, client, liveFree) && !this.shouldDeferDeposit(acc, client, liveFree) && !(this.collectionTargets.has(acc.botGuid) && this.otherDepositBotOnline(acc, client))) {
        plan.freeSlots = liveFree;
        plan.tryDeposit = true;
      }
    }
    if (!plan.tryWithdraw && !plan.tryDeposit) {
      this.claimsSkipped++;
      return null;
    }
    return plan;
  }

  private pendingKindsFor(acc: BotAccount, client: GameClient): [boolean, boolean] {
    if (!this.lastRouting.size && !this.lastWantedAt) return [true, true];
    if (Date.now() - this.lastWantedAt > C.ROUTING_FRESH_S * 1000) return [true, true];
    if (!client.server) return [true, true];
    const r = this.lastRouting.get(client.server);
    if (!r) return [false, false];
    const wantWithdraw = r.withdraws.some((w) => w.candidateBots.includes(acc.botGuid));
    const wantDeposit = this.claimableDeposits(acc, r).length > 0;
    return [wantWithdraw, wantDeposit];
  }

  private shouldDeferDeposit(acc: BotAccount, client: GameClient, liveFree: number): boolean {
    const server = client.server;
    const wakePending = this.emptyWakePending(server, seasonalOf(acc));
    let limit: number;
    let reason: string;
    const home = this.depositHomeOnlineHere(acc, client);
    if (home) {
      limit = C.DEPOSIT_COLLECTOR_WAIT_S;
      reason = `${home.alias}, which gathers what is being deposited`;
    } else if (this.emptierBotOnline(acc, client, liveFree + 1)) {
      limit = C.DEPOSIT_DEFER_MAX_S;
      reason = "an emptier bot on the same server";
    } else if (liveFree < this.botCapacity(client) && (wakePending || this.emptyOfflineAccount(seasonalOf(acc)) !== null)) {
      if (wakePending) {
        limit = C.DEPOSIT_EMPTY_WAKE_WAIT_S;
        reason = "an empty bot logging in";
      } else {
        limit = C.DEPOSIT_DEFER_MAX_S;
        reason = "an empty bot to be woken";
      }
    } else {
      this.depositDefer.delete(acc.guid);
      return false;
    }
    if (!this.depositPendingFor(acc, client)) {
      this.depositDefer.delete(acc.guid);
      return true;
    }
    const now = Date.now();
    // The wait is only re-evaluated while a deposit is pending here, so an
    // entry nobody has touched for a while belongs to an earlier deposit;
    // starting from its clock skipped this wait entirely ("waited 3543s").
    let prev = this.depositDefer.get(acc.guid);
    if (prev && now - prev[2] > 15_000) prev = undefined;
    const since = prev ? prev[0] : now;
    limit = Math.max(limit, prev ? prev[1] : 0);
    this.depositDefer.set(acc.guid, [since, limit, now]);
    if (now - since < limit * 1000) return true;
    this.log(`${acc.alias} waited ${Math.floor(s(now - since))}s on ${reason} with no takers — claiming the deposit anyway (${liveFree} free)`);
    this.depositDefer.delete(acc.guid);
    return false;
  }

  private emptyOfflineAccount(seasonal: boolean, botStates?: BotStates, offlinePool?: BotAccount[]): BotAccount | null {
    const states = botStates ?? this.lastBotStates;
    const pool = offlinePool ?? this.offline();
    const waking = this.wakes.waking();
    for (const a of pool) {
      if (seasonalOf(a) !== seasonal || a.communism) continue;
      if (this.isHeld(a.guid) || waking.has(a.guid)) continue;
      if ((states.get(a.botGuid)?.itemsHeld ?? 0) > 0) continue;
      if (this.deps.gate.lockoutRemainingMs(a.guid) > 0) continue;
      return a;
    }
    return null;
  }

  private emptyWakePending(server: string, seasonal: boolean): boolean {
    const entry = this.emptyWakeFor.get(server);
    if (!entry) return false;
    const [guid, started, wakeSeasonal] = entry;
    if (wakeSeasonal !== seasonal) return false;
    if (Date.now() - started > C.DEPOSIT_EMPTY_WAKE_WAIT_S * 1000) {
      this.emptyWakeFor.delete(server);
      return false;
    }
    if (this.wakes.waking().has(guid)) return true;
    const acc = this.pool.byGuid(guid);
    const client = acc?.client ?? null;
    if (!client || !client.active) {
      this.emptyWakeFor.delete(server);
      return false;
    }
    if (client.isReady && client.objectId !== -1) {
      this.emptyWakeFor.delete(server);
      return false;
    }
    return true;
  }

  private depositPendingFor(acc: BotAccount, client: GameClient): boolean {
    if (Date.now() - this.lastWantedAt > C.SUPERVISE_INTERVAL_S * 3000) return true;
    const r = this.lastRouting.get(client.server);
    return !!r && this.claimableDeposits(acc, r).length > 0;
  }
  private otherDepositBotOnline(acc: BotAccount, client: GameClient): boolean {
    return this.emptierBotOnline(acc, client, 1);
  }
  private emptierBotOnline(acc: BotAccount, client: GameClient, minFree: number): boolean {
    const server = client.server;
    if (!server) return false;
    for (const other of this.online()) {
      if (other.guid === acc.guid) continue;
      const oc = other.client!;
      if (!oc.isReady || other.assignedRequestId !== null || oc.server !== server) continue;
      if (seasonalOf(other) !== seasonalOf(acc)) continue;
      if (this.isHeld(other.guid) || this.collectionTargets.has(other.botGuid)) continue;
      if (oc.objectId === -1 || !oc.playerData.name) continue;
      if (this.countFreeSlots(oc) >= minFree) return true;
    }
    return false;
  }

  /** Swap rows (design doc §6.2) by account guid: the site assignment the outcome is reported against. */
  private readonly swapAssignments = new Map<string, SiteAssignment & { kind: "withdraw" }>();

  private acceptAssignment(acc: BotAccount, client: GameClient, a: SiteAssignment): void {
    const items = a.items ?? [];
    acc.assignedRequestId = a.requestId;
    acc.assignedKind = a.kind;
    acc.assignedPartnerIgn = a.ign;
    this.keepInstances.set(acc.guid, new Set(a.kind === "withdraw" ? a.keepInstanceIds ?? [] : []));
    if (a.kind === "withdraw" && a.swap) {
      // A cross-node swap: two-way trade with another node's bot. The trade
      // machine runs its consolidation swap path; the row is closed through
      // reportSwap rather than fulfill.
      const sa = a as SiteAssignment & { kind: "withdraw" };
      this.swapAssignments.set(acc.guid, sa);
      const now = Date.now();
      this.lastActive.set(acc.guid, now);
      const session = this.sessionFor(acc);
      session?.setAssignment(swapAssignment(sa));
      this.log(`${acc.alias} got ${a.swap.player ? "player meeting" : "swap"} #${a.requestId} (${a.swap.role}) with ${a.ign}: gives ${items.map((i) => `${i.qty}x${i.itemId}`).join(",")}, gets ${a.swap.gets.map((i) => `${i.qty}x${i.itemId}`).join(",")}${a.swap.deadlineAt ? `, deadline in ${Math.max(0, Math.floor((a.swap.deadlineAt - now) / 60_000))} min` : ""}`);
      this.tradeTimeline.set(acc.guid, { claimed: now });
      this.partnerWaitSince.set(acc.guid, [a.requestId, now]);
      void this.api.noteSwap?.(acc.botGuid, a.requestId, "swap-assigned", { bot: acc.alias, role: a.swap.role, partner: a.ign, server: a.server, inNexus: this.inNexusNow(acc, client) }).catch(() => null);
      if (!this.inNexusNow(acc, client)) {
        this.log(`${acc.alias} not in nexus (gameId=${client.gameIdValue}), sending nexus()`);
        this.toNexus(acc, client);
      } else if (a.swap.role === "give") {
        // Only the giver invites; the taker waits for the request.
        if (session?.sendTradeRequest()) this.tradeTimeline.get(acc.guid)!.requested = now;
        else this.log(`${acc.alias} swap request deferred (trade machine busy or partner not in view)`);
      }
      return;
    }
    const now = Date.now();
    this.lastActive.set(acc.guid, now);
    const session = this.sessionFor(acc);
    session?.setAssignment({ kind: a.kind, requestId: a.requestId, partnerIgn: a.ign, items, itemCount: a.itemCount ?? (items.length || 1), instanceIds: a.instanceIds ?? null, acceptSkins: a.kind === "deposit" && !!a.skins });
    this.log(`${acc.alias} got ${a.kind} #${a.requestId} for ${a.ign}`);
    this.tradeTimeline.set(acc.guid, { claimed: now });
    if (!this.inNexusNow(acc, client)) {
      this.log(`${acc.alias} not in nexus (gameId=${client.gameIdValue}), sending nexus()`);
      this.toNexus(acc, client);
    } else if (session?.sendTradeRequest()) {
      this.tradeTimeline.get(acc.guid)!.requested = now;
    } else {
      this.log(`${acc.alias} send_trade_request returned false (trade machine not idle or partner busy)`);
    }
  }

  // --- outcomes --------------------------------------------------------------------

  private pollOutcome(acc: BotAccount, client: GameClient): void {
    const session = this.sessionFor(acc);
    const outcome = session?.takeOutcome() ?? null;
    if (!outcome) return;
    const requestId = acc.assignedRequestId!;
    const kind = acc.assignedKind!;
    const timing = this.tradeStageSummary(acc);
    if (timing) this.log(`${acc.alias} ${kind} #${requestId} ${timing}`);

    const swapRow = this.swapAssignments.get(acc.guid);
    if (swapRow) {
      this.settleSwap(acc, client, session, swapResult(swapRow, outcome));
      return;
    }

    if (kind === "consolidate_give" || kind === "consolidate_take") {
      if (outcome.ok) {
        const done = outcome.kind === "consolidate_give" || outcome.kind === "consolidate_take" ? outcome : null;
        this.log(`${acc.alias} ${kind} done${done?.swapItems?.length ? " (swap)" : ""}`);
        this.collectorHoldSince.delete(acc.guid);
        this.collectorNoteAt.delete(acc.guid);
        if (kind === "consolidate_take") this.collectorLastArrival.set(acc.guid, Date.now());
        const why = this.consolidationPairs.get(requestId)?.advanced;
        if (kind === "consolidate_give" && why) this.advancedCounts[why === "merge" ? "merges" : "evacuations"]++;
        else if (kind === "consolidate_give") this.consolidationStats.done++;
      } else {
        this.log(`${acc.alias} ${kind} failed: ${outcome.error} — dropping, next pass replans`);
        if (kind === "consolidate_give" && this.consolidationPairs.get(requestId)?.advanced) this.advancedCounts.mergeFailures++;
        else if (kind === "consolidate_give") this.consolidationStats.failed++;
        // Nothing crossed over: the ids promised to the receiving side would
        // otherwise be handed to the next unrelated item that lands on it.
        const pair = this.consolidationPairs.get(requestId);
        if (pair) {
          this.tracker.cancelTransfer(pair.taker);
          this.tracker.cancelTransfer(pair.giver);
        }
      }
      this.clearAssignment(acc, session);
      this.consolidationAssignedAt.delete(acc.guid);
      this.partnerWaitSince.delete(acc.guid);
      this.lastActive.set(acc.guid, Date.now());
      this.noteWorkEnded(acc);
      this.refreshInventory(acc, client);
      return;
    }

    if (!outcome.ok) {
      this.log(`${acc.alias} ${kind} #${requestId} failed: ${outcome.error}`);
      // A chunked withdraw that broke off after some windows completed: the
      // items that crossed are gone from this bot, so the site is told what
      // was delivered and re-opens the row with the remainder. A give-up or
      // unclaim here would cancel the row and lose that accounting.
      const partial = kind === "withdraw" && outcome.delivered?.length ? outcome.delivered : null;
      if (partial) {
        this.log(`${acc.alias} withdraw #${requestId} handed over ${partial.map((i) => `${i.qty}x${i.itemId}`).join(",")} before failing — reporting the partial delivery`);
        this.reportFulfill({ kind: "withdraw", botGuid: acc.botGuid, requestId, items: partial, instanceIds: outcome.deliveredInstanceIds ?? [], attempts: 0 });
      }
      if (outcome.partnerAbsent) {
        this.handRowBack(acc, client, requestId, kind, outcome.error, true, !partial);
        this.log(`${acc.alias} gave up on ${kind} #${requestId} (${outcome.error}) — partner absent, ${partial ? "remainder re-queued" : "cancelled"}; disconnecting`);
        this.disconnectAccount(acc, false);
        return;
      }
      // The player was there but the trade broke (the window closed, items
      // added to a withdraw, no room on their side, the idle timeout): the
      // site hears it now rather than from the 5-minute stale-claim sweep,
      // which would block the player's other rows meanwhile. With a partial
      // delivery the fulfill above re-opens the remainder; otherwise the row
      // ends, saying why.
      this.handRowBack(acc, client, requestId, kind, outcome.error, true, !partial);
      return;
    }

    if (outcome.kind === "deposit") {
      const received = outcome.received;
      const units = received.length ? outcome.receivedUnits : null;
      this.reportFulfill({ kind: "deposit", botGuid: acc.botGuid, requestId, items: received, units, attempts: 0 });
    } else if (outcome.kind === "withdraw") {
      this.reportFulfill({ kind: "withdraw", botGuid: acc.botGuid, requestId, items: outcome.delivered, instanceIds: outcome.deliveredInstanceIds, attempts: 0 });
      // What the "demand" merge budget follows: potion withdraws handed over lately.
      if (this.isAdvanced(acc) && outcome.delivered.some((i) => POTION_INFO[i.itemId])) {
        const now = Date.now();
        this.potionWithdrawsAt = this.potionWithdrawsAt.filter((t) => t > now - 3_600_000);
        this.potionWithdrawsAt.push(now);
      }
    }
    this.noteWorkEnded(acc);
    this.clearAssignment(acc, session);
    if (kind === "withdraw") {
      this.lastActive.set(acc.guid, Date.now());
    } else if (this.countFreeSlots(client) >= 1) {
      this.lastActive.set(acc.guid, Date.now());
    } else {
      this.log(`${acc.alias} fulfilled deposit but has 0 free slots — NOT refreshing wake-grace so the supervisor can free the slot`);
    }
  }

  private clearAssignment(acc: BotAccount, session?: TradeSession): void {
    session?.setAssignment(null);
    this.coordinator.releaseAllFor(acc.guid);
    this.swapAssignments.delete(acc.guid);
    this.forgetSwapChecks(acc.guid);
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
  }

  private forgetSwapChecks(guid: string): void {
    this.swapRowCheckedAt.delete(guid);
    this.swapRowClosed.delete(guid);
    this.swapCancelSent.delete(guid);
  }

  /**
   * A swap row's end, whatever brought it: the result goes to the site (which
   * turns it into a signed receipt for the hub) and the bot is free again. A
   * partner that never came means this server was the wrong place to stay.
   */
  private settleSwap(acc: BotAccount, client: GameClient, session: TradeSession | undefined, result: ReturnType<typeof swapResult>): void {
    const requestId = acc.assignedRequestId!;
    this.swapAssignments.delete(acc.guid);
    this.log(`${acc.alias} swap #${requestId} ${result.ok ? `done: gave ${result.gave.map((i) => `${i.qty}x${i.itemId}`).join(",")}, got ${result.got.map((i) => `${i.qty}x${i.itemId}`).join(",")}` : `failed: ${result.error}`}`);
    const report = this.api.reportSwap
      ? this.api.reportSwap(acc.botGuid, requestId, result)
      : result.ok ? this.api.fulfillWithdraw(acc.botGuid, requestId, result.gave, result.gaveInstanceIds) : this.api.giveUp(acc.botGuid, requestId, "withdraw");
    void report.then((r) => {
      if (!r.ok) this.log(`swap #${requestId} report failed: ${r.error}`);
    }).catch((e) => this.log(`swap #${requestId} report raised: ${String(e)}`));
    this.clearAssignment(acc, session);
    this.partnerWaitSince.delete(acc.guid);
    this.lastActive.set(acc.guid, Date.now());
    this.refreshInventory(acc, client);
    if (!result.ok && result.partnerAbsent) this.disconnectAccount(acc, false);
  }

  /**
   * A meeting's bot waits for the other node's bot until the hub's deadline
   * (less a margin, so this side's receipt lands before the hub's own sweep),
   * then fails the row as a swap. A row from an older hub with no deadline
   * gets the ordinary partner wait. While waiting, a note every minute says so
   * on the row's timeline.
   */
  private giveUpSwapAtDeadline(acc: BotAccount, client: GameClient, sa: SiteAssignment & { kind: "withdraw" }, now: number, why = "partner never came"): boolean {
    const rid = acc.assignedRequestId!;
    let prev = this.partnerWaitSince.get(acc.guid);
    if (!prev || prev[0] !== rid) {
      prev = [rid, now];
      this.partnerWaitSince.set(acc.guid, prev);
    }
    const deadline = sa.swap?.deadlineAt ?? null;
    // A player meeting keeps its bot until the deadline itself: a person may still be on their way.
    const margin = sa.swap?.player ? 0 : C.SWAP_GIVE_UP_MARGIN_S * 1000;
    const limitAt = deadline !== null ? deadline - margin : prev[1] + C.PARTNER_WAIT_MAX_S * 1000;
    if (now < limitAt) {
      const last = this.swapWaitNoteAt.get(acc.guid) ?? 0;
      if (now - last >= C.SWAP_WAIT_NOTE_S * 1000) {
        this.swapWaitNoteAt.set(acc.guid, now);
        const partner = sa.ign;
        const seen = this.sessionFor(acc)?.partnerPresent(partner);
        void this.api.noteSwap?.(acc.botGuid, rid, "swap-waiting", { bot: acc.alias, partner, server: client.server, inNexus: client.gameIdValue === GameId.nexus, partnerSeen: seen ?? null, waitedS: Math.floor(s(now - prev[1])), untilS: Math.floor(s(limitAt - now)) }).catch(() => null);
      }
      return false;
    }
    this.log(`${acc.alias} swap #${rid}: ${why} for ${JSON.stringify(sa.ign)} in ${Math.floor(s(now - prev[1]))}s — failing this side of the meeting`);
    this.swapWaitNoteAt.delete(acc.guid);
    // A player who came and traded without it working out is not a no-show.
    const tried = sa.swap?.player ? this.sessionFor(acc)?.playerProgress() : undefined;
    const error = tried
      ? tried.seen ? `no trade before the meeting deadline (${tried.windowsOpened} trade window${tried.windowsOpened === 1 ? "" : "s"} opened)` : "the player never came before the meeting deadline"
      : deadline !== null ? `${why} before the meeting deadline` : why;
    this.settleSwap(acc, client, this.sessionFor(acc), { ok: false, gave: [], gaveInstanceIds: [], got: [], partnerIgn: sa.ign, error, partnerAbsent: tried ? !tried.seen : true });
    return true;
  }

  /**
   * A meeting called off while its bot works it (the hub aborted it, the
   * owner gave it up, the player cancelled): its swap row was closed under
   * the bot. Checked every few seconds. An open trade window is closed first
   * (should the trade have beaten the cancel, its outcome is still reported);
   * then the bot lets go of the row without telling the queue anything more.
   * True while the bot is busy letting go.
   */
  private letGoOfClosedSwap(acc: BotAccount, client: GameClient, session: TradeSession | undefined, now: number): boolean {
    const rid = acc.assignedRequestId!;
    if (this.swapRowClosed.get(acc.guid) !== rid) {
      if (this.api.swapRowOpen && now - (this.swapRowCheckedAt.get(acc.guid) ?? 0) >= C.SWAP_ROW_CHECK_S * 1000) {
        this.swapRowCheckedAt.set(acc.guid, now);
        void this.api.swapRowOpen(rid).then((r) => {
          if (r.ok && !r.open && acc.assignedRequestId === rid) {
            this.swapRowClosed.set(acc.guid, rid);
            this.poke();
          }
          // The hub gave the meeting more time: the bot waits (and the trade machine re-requests) until the new deadline.
          const sa = this.swapAssignments.get(acc.guid);
          if (r.ok && r.open && r.deadlineAt != null && acc.assignedRequestId === rid && sa?.swap && r.deadlineAt > (sa.swap.deadlineAt ?? 0)) {
            this.log(`${acc.alias} swap #${rid}: the meeting was extended to ${new Date(r.deadlineAt).toISOString()}; waiting until then`);
            this.swapAssignments.set(acc.guid, { ...sa, swap: { ...sa.swap, deadlineAt: r.deadlineAt } });
            this.sessionFor(acc)?.extendMeeting(r.deadlineAt);
          }
        }).catch(() => null);
      }
      return false;
    }
    const phase = session?.phase ?? "IDLE";
    if (phase === "IN_TRADE" || phase === "ACCEPTED") {
      if (this.swapCancelSent.get(acc.guid) !== rid) {
        this.swapCancelSent.set(acc.guid, rid);
        client.send("CANCELTRADE", {});
        this.log(`${acc.alias} swap #${rid} was called off with its trade window open — closing the window first`);
      }
      return true;
    }
    this.log(`${acc.alias} swap #${rid} was called off — letting it go`);
    void this.api.noteSwap?.(acc.botGuid, rid, "swap-let-go", { bot: acc.alias, why: "the meeting was called off" }).catch(() => null);
    this.handRowBack(acc, client, rid, "withdraw", "the meeting was called off", false, false);
    return true;
  }

  private tradeStageSummary(acc: BotAccount): string {
    const marks = this.tradeTimeline.get(acc.guid);
    this.tradeTimeline.delete(acc.guid);
    if (!marks) return "";
    const now = Date.now();
    const total = s(now - marks.claimed).toFixed(1);
    if (marks.requested === undefined) return `took ${total}s (never sent a request)`;
    return `took ${total}s (claim->request ${s(marks.requested - marks.claimed).toFixed(1)}s, request->done ${s(now - marks.requested).toFixed(1)}s)`;
  }

  private reportFulfill(job: FulfillJob): void {
    void this.fulfillAttempt(job);
  }
  private async fulfillAttempt(job: FulfillJob): Promise<void> {
    job.attempts++;
    let settled = false;
    try {
      const r = job.kind === "deposit"
        ? await this.api.fulfillDeposit(job.botGuid, job.requestId, job.items, job.units, job.instances ?? null)
        : await this.api.fulfillWithdraw(job.botGuid, job.requestId, job.items, job.instanceIds ?? []);
      if (r.ok) {
        this.log(`${job.kind} fulfill #${job.requestId} -> ok`);
        settled = true;
      } else {
        const err = r.error.toLowerCase();
        if (C.FULFILL_TERMINAL_ERRORS.some((t) => err.includes(t))) {
          this.log(`${job.kind} fulfill #${job.requestId} settled without retry: ${r.error}`);
          settled = true;
        } else {
          this.log(`${job.kind} fulfill #${job.requestId} FAILED (attempt ${job.attempts}/${C.FULFILL_RETRY_MAX_ATTEMPTS}, status=${r.status}): ${r.error}`);
        }
      }
    } catch (e) {
      this.log(`fulfill #${job.requestId} raised: ${String(e)}`);
    }
    if (settled) return;
    if (job.attempts >= C.FULFILL_RETRY_MAX_ATTEMPTS) {
      this.deadLetterFulfill(job);
      return;
    }
    job.nextAt = Date.now() + job.attempts * C.FULFILL_RETRY_BACKOFF_S * 1000;
    this.pendingFulfills.push(job);
  }
  private deadLetterFulfill(job: FulfillJob): void {
    const file = path.join(this.dataDir, "unreported_fulfills.jsonl");
    const record = { at: Date.now() / 1000, ...job };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + "\n");
    } catch (e) {
      this.log(`could not write dead-letter fulfill: ${String(e)}`);
    }
    this.log(`*** UNREPORTED ${job.kind.toUpperCase()} #${job.requestId} *** gave up after ${job.attempts} attempts; logged to ${file}`);
  }
  private drainFulfillRetries(now: number): void {
    if (!this.pendingFulfills.length) return;
    const due = this.pendingFulfills.filter((j) => (j.nextAt ?? 0) <= now);
    if (!due.length) return;
    this.pendingFulfills = this.pendingFulfills.filter((j) => !due.includes(j));
    for (const j of due) this.reportFulfill(j);
  }

  private giveUpOnStuckConsolidation(acc: BotAccount, client: GameClient, now: number): boolean {
    if (acc.assignedKind !== "consolidate_give" && acc.assignedKind !== "consolidate_take") return false;
    const rid = acc.assignedRequestId;
    const prev = this.consolidationAssignedAt.get(acc.guid);
    if (!prev || prev[0] !== rid) {
      this.consolidationAssignedAt.set(acc.guid, [rid, now]);
      return false;
    }
    if (now - prev[1] < C.CONSOLIDATION_ASSIGNMENT_MAX_S * 1000) return false;
    this.log(`${acc.alias} stuck on ${acc.assignedKind} #${rid} for ${Math.floor(s(now - prev[1]))}s with nothing in flight — dropping the move`);
    this.consolidationAssignedAt.delete(acc.guid);
    this.handRowBack(acc, client, rid!, acc.assignedKind, "consolidation stalled");
    return true;
  }

  private giveUpWaitingForPartner(acc: BotAccount, client: GameClient, now: number, why = "never got the trade slot"): boolean {
    const rid = acc.assignedRequestId;
    const kind = acc.assignedKind!;
    const prev = this.partnerWaitSince.get(acc.guid);
    if (!prev || prev[0] !== rid) {
      this.partnerWaitSince.set(acc.guid, [rid, now]);
      return false;
    }
    if (now - prev[1] < C.PARTNER_WAIT_MAX_S * 1000) return false;
    const partner = this.sessionFor(acc)?.getAssignment()?.partnerIgn ?? "";
    this.log(`${acc.alias} #${rid} ${why} for ${JSON.stringify(partner)} in ${Math.floor(s(now - prev[1]))}s — releasing the row`);
    this.partnerWaitSince.delete(acc.guid);
    this.handRowBack(acc, client, rid!, kind, why);
    return true;
  }

  /** `tellSite` false: the row's fate is already settled by a fulfill report in flight (partial withdraw); only the local state is released. */
  private handRowBack(acc: BotAccount, client: GameClient, rid: number, kind: string, why: string, giveUp = false, tellSite = true): void {
    if ((kind === "deposit" || kind === "withdraw") && tellSite) {
      const verb = giveUp ? "give-up" : "unclaim";
      const call = giveUp ? this.api.giveUp(acc.botGuid, rid, kind, playerReason(why)) : this.api.unclaim(acc.botGuid, rid, kind);
      void call.then((r) => {
        if (!r.ok) this.log(`${acc.alias} ${verb} of ${kind} #${rid} failed: ${r.error} — the site's stale-claim sweep will get it`);
      }).catch((e) => this.log(`${acc.alias} ${verb} raised: ${String(e)}`));
    } else {
      this.releaseMovesFor(acc.guid, `${acc.alias} ${why}`);
    }
    const session = this.sessionFor(acc);
    session?.reset();
    if (session) this.attachFreshSession(acc, client, session);
    this.coordinator.releaseAllFor(acc.guid);
    this.swapAssignments.delete(acc.guid);
    this.swapWaitNoteAt.delete(acc.guid);
    this.forgetSwapChecks(acc.guid);
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
    this.consolidationAssignedAt.delete(acc.guid);
    this.lastActive.set(acc.guid, Date.now());
    this.lastStatus.delete(acc.botGuid);
    this.lastClaim.delete(acc.botGuid);
  }
  /** session.reset() keeps the presence view (same map); the packet hook stays attached. */
  private attachFreshSession(_acc: BotAccount, _client: GameClient, _session: TradeSession): void {}

  // --- supervisor ------------------------------------------------------------------

  private async supervise(): Promise<void> {
    this.pool.reload();
    for (const acc of this.accounts()) {
      if (acc.client && !acc.client.active) {
        this.log(`pruning zombie client for ${acc.alias} (active=false)`);
        this.disconnectAccount(acc);
      }
    }
    // Pool size and the room left per pool go to the site every pass. The
    // room is what its fulfill-time "is the pool full?" check reads
    // (lib/capacity.ts), so it has to describe the whole roster — the bots
    // online at any moment are a handful out of thousands.
    void this.api.registerPool(this.accounts().length, this.freeSlotsByPool(), this.onlineCap()).catch((e) => this.log(`register_pool failed: ${String(e)}`));

    const resp = await this.api.listPending();
    if (!resp.ok) return;
    this.communismBots = this.communismBotGuids();
    // Each player's next row comes flagged (advanced management): it is woken and fetched for, never claimed, counted or cancelled here.
    const allWithdraws = resp.withdraws ?? [];
    const isUpcoming = (w: PendingWithdraw) => !!(w as PendingWithdraw & { upcoming?: boolean }).upcoming;
    const upcomingRows = allWithdraws.filter(isUpcoming);
    const withdraws = upcomingRows.length ? allWithdraws.filter((w) => !isUpcoming(w)) : allWithdraws;
    const { routing, botStates, capacity } = this.buildRouting(withdraws, resp.deposits ?? [], upcomingRows);
    this.lastBotStates = botStates;
    this.pinnedAccounts = new Set(allWithdraws.flatMap((w) => (w.targetBotGuid ? [w.targetBotGuid] : [])));
    this.noteStuckDeposits(routing, Date.now());
    this.rebuildAdvancedState();
    this.cancelUnservable(routing, botStates);
    const wantedServers = new Set([...routing].filter(([, r]) => r.count > 0).map(([sv]) => sv));
    this.lastWantedServers = wantedServers;
    this.lastRouting = routing;
    this.withdrawAccountsCache = null;
    this.lastWantedAt = Date.now();
    this.nudgeClaims(wantedServers);
    this.orderBackpackBotsFor(routing);
    this.orderFetchesFor(routing, allWithdraws);

    if (withdraws.length || resp.deposits?.length) {
      const digest = [...routing].flatMap(([sv, r]) => r.withdraws.map((w) => `${sv}:wd${w.requestId}(cand=[${w.candidateBots.map((g) => g.slice(0, 8)).join(",")}])`)).join(" ") || "(no withdraws)";
      this.log(`supervise: routing wd=${withdraws.length} dep=${resp.deposits?.length ?? 0}${upcomingRows.length ? ` next=${upcomingRows.length}` : ""} tracker-bots=${botStates.size} suspended=${this.pool.suspendedBotGuids().size} -> ${digest}`);
    }

    const online = this.online();
    const now = Date.now();
    const swapHeadroom = this.onlineCap() - this.wakes.globalOnline();
    const offlineCover = swapHeadroom > 0 && this.offlineCoverAvailable(wantedServers, routing, botStates);

    for (const acc of online) {
      const client = acc.client!;
      if (acc.assignedRequestId !== null) {
        this.lastActive.set(acc.guid, now);
        continue;
      }
      const server = client.server;
      const collecting = this.isCollectingPotions(acc, client, now);
      // An advanced account on a storage trip of its own (banking, a fetch) finishes it first.
      const stranded = this.isAdvanced(acc) && this.isHeld(acc.guid) ? null : this.onlyCandidateForOtherServer(acc, server, routing, wantedServers);
      if (stranded) {
        this.log(`${acc.alias} on ${server} is the only bot that can fulfill stranded ${stranded} work — force-swapping now`);
        this.disconnectAccount(acc);
        continue;
      }
      if (this.inWorld(acc)) this.notInWorldSince.delete(acc.guid);
      else if (!this.isHeld(acc.guid)) {
        // Connected but never in-world (a login that stalled, an UPDATE the
        // decoder can't read) is a slot burned for nothing: it can't heartbeat
        // idle, so it never claims, and it would otherwise sit here for as
        // long as work is pending on its server.
        const since = this.notInWorldSince.get(acc.guid) ?? now;
        this.notInWorldSince.set(acc.guid, since);
        if (now - since >= C.IN_WORLD_TIMEOUT_S * 1000) {
          this.log(`${acc.alias} on ${server} still not in-world after ${Math.floor(s(now - since))}s — recycling the slot`);
          this.disconnectAccount(acc);
          continue;
        }
      }
      if (wantedServers.has(server)) this.serverIdleSince.delete(acc.guid);
      const exempt = this.isHeld(acc.guid) || acc.guid === this.loginBotGuid;
      if (!exempt && this.isAdvanced(acc)) {
        if (this.inWorld(acc)) this.superviseAdvanced(acc, client, routing, wantedServers, botStates, offlineCover, now);
        continue;
      }
      if (wantedServers.size && !wantedServers.has(server) && !exempt) {
        const idleSince = this.serverIdleSince.get(acc.guid);
        if (idleSince === undefined) {
          this.serverIdleSince.set(acc.guid, now);
          this.log(`${acc.alias} on ${server} but work is on ${[...wantedServers].sort().join(",")} — holding ${C.SERVER_SWAP_GRACE_S}s before swap`);
          continue;
        }
        if (now - idleSince < C.SERVER_SWAP_GRACE_S * 1000) continue;
        if (offlineCover) {
          if (now - (this.swapYieldNote.get(acc.guid) ?? 0) >= 30_000) {
            this.swapYieldNote.set(acc.guid, now);
            this.log(`${acc.alias} on ${server} would swap to ${[...wantedServers].sort().join(",")}, but an offline bot can cover — waking one instead`);
          }
          continue;
        }
        this.swapYieldNote.delete(acc.guid);
        this.log(`${acc.alias} on ${server} idle for ${Math.floor(s(now - idleSince))}s, work is on ${[...wantedServers].sort().join(",")} — disconnecting`);
        this.disconnectAccount(acc);
        continue;
      }
      const wokeAt = this.lastActive.get(acc.guid) ?? 0;
      // Communism accounts follow the same rule as every bot (2026-09-29): logging one in again for the next request is cheap.
      const inGrace = wokeAt > 0 && now - wokeAt < C.WAKE_GRACE_S * 1000;
      if (wantedServers.has(server)) {
        if (!inGrace && !exempt && !collecting && !this.accountCanFulfill(acc, routing.get(server)!, botStates)) {
          // Short of room for the deposits here it would otherwise take: it comes back as a roomier character of its side.
          const next = this.rotateFor(acc, this.claimableDeposits(acc, routing.get(server)!), this.countFreeSlots(client)) ?? this.rotateAcross(acc, routing.get(server)!);
          this.log(`${acc.alias} can't fulfill any pending ${server} work — ${next ? `logging out to come back as character ${next.id} (${next.free} free), which has the room` : "disconnecting"}`);
          this.disconnectAccount(acc);
          continue;
        }
      }
      if (!wantedServers.size && !inGrace && !exempt && !collecting) {
        this.log(`${acc.alias} idle and no work pending — disconnecting`);
        this.disconnectAccount(acc);
        continue;
      }
    }

    this.preWakeUpcoming(routing);
    if (!wantedServers.size) return;
    const waking = this.wakes.waking();
    const stillOnline = this.online();
    // Only bots that could be woken right now. A candidate sitting out a
    // login cooldown is not cover: counting it sent the wake path looking
    // for a stand-in that could not do the work (see wakeAccountForServer).
    const offlinePool = this.accounts().filter((a) => !a.online && !waking.has(a.guid) && this.loginBlockedMs(a) <= 0);
    let wakeBudget = Math.min(this.onlineCap() - this.wakes.globalOnline(), C.MAX_WAKES_PER_TICK);
    if (wakeBudget <= 0) {
      const evicted = this.evictIdleToUnjam(stillOnline, routing, wantedServers, botStates, now);
      if (evicted === 0) this.log(`${stillOnline.length} bots online (cap ${this.onlineCap()}) — not waking more this tick`);
      return;
    }
    const availableByServer = new Map<string, Set<string>>();
    for (const a of stillOnline) {
      if (a.assignedRequestId !== null || this.isHeld(a.guid)) continue;
      const sv = a.client!.server;
      const r = routing.get(sv);
      if (!sv || !r) continue;
      if (!this.accountCanFulfill(a, r, botStates)) continue;
      if (this.yieldsDepositToEmptyBot(a, r, botStates, offlinePool)) continue;
      if (!availableByServer.has(sv)) availableByServer.set(sv, new Set());
      availableByServer.get(sv)!.add(a.botGuid);
    }
    // A login in flight for a server covers its work too. A wake takes far
    // longer than a supervise tick, and counting live clients alone woke a
    // fresh bot for the same deposit every tick until the cap was full.
    //
    // Same tests as for the bots already online, though: a bot logging in
    // for a consolidation move never claims, and one carrying items yields
    // a deposit to an empty account just like its online peers. Counting
    // those as cover was why no empty bot got woken while the online ones
    // waited on exactly that, then claimed with a slot or two ("waited 20s
    // on an empty bot to be woken with no takers").
    for (const [guid, sv] of this.wakes.wakingServers()) {
      const a = this.pool.byGuid(guid);
      const r = routing.get(sv);
      if (!a || !r || this.isHeld(a.guid) || !this.accountCanFulfill(a, r, botStates)) continue;
      if (this.yieldsDepositToEmptyBot(a, r, botStates, offlinePool)) continue;
      if (!availableByServer.has(sv)) availableByServer.set(sv, new Set());
      availableByServer.get(sv)!.add(a.botGuid);
    }
    for (const server of wantedServers) {
      if (wakeBudget <= 0) break;
      if (this.serverBenched(server, now)) continue;
      const r = routing.get(server)!;
      const need = this.distinctWorkCount(r);
      const have = availableByServer.get(server)?.size ?? 0;
      let short = need - have;
      if (short <= 0) continue;
      short = Math.min(short, wakeBudget);
      if (!this.anyOfflineCanFulfill(r, botStates, offlinePool)) {
        // Once a minute per server, not every tick: a request that nothing
        // fits sits here until it ages out, and the note doesn't change.
        const nowMs = Date.now();
        if (nowMs - (this.unfulfillableNoteAt.get(server) ?? 0) >= C.UNFULFILLABLE_NOTE_S * 1000) {
          this.unfulfillableNoteAt.set(server, nowMs);
          this.log(`no offline bot can fulfill ${server} work — leaving alone`);
          this.diagnoseUnfulfillable(server, r, offlinePool);
        }
        continue;
      }
      for (let i = 0; i < short; i++) {
        if (!(await this.wakeAccountForServer(server, r, botStates, capacity))) break;
        wakeBudget--;
      }
    }
  }

  private nudgeClaims(wantedServers: Set<string>): void {
    if (!wantedServers.size) return;
    for (const acc of this.online()) {
      if (acc.assignedRequestId !== null) continue;
      if (wantedServers.has(acc.client!.server)) this.lastClaim.delete(acc.botGuid);
    }
  }

  private buildRouting(withdraws: PendingWithdraw[], deposits: PendingDeposit[], upcoming: PendingWithdraw[] = []): { routing: Routing; botStates: BotStates; capacity: { botCount: number; totalSlots: number; usedSlots: number; full: boolean } } {
    const suspended = this.pool.suspendedBotGuids();
    // Read-only views of the tracker's maps, minus suspended bots. The per-bot
    // records are shared with the tracker and never edited here: the rest
    // copies before it changes anything, and the rest only reads.
    const tracker: Record<string, Record<string, number>> = {};
    for (const [g, inv] of this.tracker.itemsView()) if (!suspended.has(g)) tracker[g] = inv as Record<string, number>;
    const caps: Record<string, number> = {};
    for (const [g, cap] of this.tracker.capacityView()) if (!suspended.has(g)) caps[g] = cap;
    const instSnap: Record<string, Readonly<Record<number, { instanceId: string }>>> = {};
    for (const [g, slots] of this.tracker.instancesView()) if (!suspended.has(g)) instSnap[g] = slots;
    const instancesByBot = new Map<string, Set<string>>();
    for (const [g, slots] of Object.entries(instSnap)) instancesByBot.set(g, new Set(Object.values(slots).map((i) => i.instanceId)));
    const poolOf = new Map(this.accounts().map((a) => [a.botGuid, seasonalOf(a)]));
    const routing: Routing = new Map();
    const covers = (inv: Record<string, number> | undefined, items: ItemQty[]) => items.every((it) => (inv?.[it.itemId] ?? 0) >= it.qty);
    // What an account keeps beyond its character's trade slots, reachable for a pool half (a suspended account's is not).
    const storedOf = (g: string, want: boolean): StoredInstance[] => (suspended.has(g) ? [] : (this.storageDesk?.stored(g) ?? [])).filter((s) => s.pools[want ? "seasonal" : "nonseasonal"]);
    const route = (w: PendingWithdraw): RoutedWithdraw => {
      const want = w.seasonal ?? true;
      const inPool = (g: string) => poolOf.get(g) === want;
      let candidates: string[] = [];
      let fetchFrom: RoutedWithdraw["fetchFrom"] = null;
      let switchChar: number | null = null;
      if (w.instanceIds?.length) {
        if (w.targetBotGuid) {
          // What the character holds only counts while it is of the wanted side; the rest may be in storage.
          const held = inPool(w.targetBotGuid) ? instancesByBot.get(w.targetBotGuid) ?? new Set<string>() : new Set<string>();
          const missing = w.instanceIds.filter((id) => !held.has(id));
          if (!missing.length) candidates = [w.targetBotGuid];
          else {
            const stored = new Map(storedOf(w.targetBotGuid, want).map((s) => [s.instanceId, s]));
            const rows = missing.map((id) => stored.get(id));
            if (rows.every((r) => !!r)) {
              // Every pick on one other character, none on the played one: the
              // account simply logs in as that character; nothing is fetched.
              const chars = new Set(rows.map((r) => (r!.where.kind === "char" ? r!.where.charId : -1)));
              if (chars.size === 1 && !chars.has(-1) && missing.length === w.instanceIds.length) {
                switchChar = [...chars][0];
                candidates = [w.targetBotGuid];
              } else {
                fetchFrom = { botGuid: w.targetBotGuid, need: { instanceIds: missing, items: [] } };
              }
            }
          }
        }
      } else if (w.targetBotGuid) {
        const inv = inPool(w.targetBotGuid) ? tracker[w.targetBotGuid] : undefined;
        if (inPool(w.targetBotGuid) && covers(inv, w.items)) candidates = [w.targetBotGuid];
        else if (w.swap && !w.items.length && !inPool(w.targetBotGuid)) {
          // A hand-over a communism account only receives, on the other side of the split from the one it plays: it logs in as a character of that side.
          const to = this.receivingCharAcross(w.targetBotGuid, want, w.swap.gets.reduce((n, it) => n + it.qty, 0));
          if (to !== null) {
            switchChar = to;
            candidates = [w.targetBotGuid];
          }
        } else {
          // A count of a type is filled from the account's containers (never another character).
          const stock: Record<string, number> = {};
          for (const s of storedOf(w.targetBotGuid, want)) if (s.where.kind !== "char") stock[s.itemId] = (stock[s.itemId] ?? 0) + 1;
          const short = w.items.map((it) => ({ itemId: it.itemId, qty: Math.max(0, it.qty - (inv?.[it.itemId] ?? 0)) })).filter((it) => it.qty > 0);
          if (short.length && short.every((it) => (stock[it.itemId] ?? 0) >= it.qty)) fetchFrom = { botGuid: w.targetBotGuid, need: { instanceIds: [], items: short } };
        }
      } else {
        // A pool withdraw by type never comes off a communism account.
        for (const [g, inv] of Object.entries(tracker)) if (inPool(g) && !this.communismBots.has(g) && covers(inv, w.items)) candidates.push(g);
      }
      return { requestId: w.id, items: w.items, candidateBots: candidates, seasonal: want, targetBotGuid: w.targetBotGuid ?? null, perInstance: !!w.instanceIds?.length, instanceIds: w.instanceIds?.length ? w.instanceIds : null, swap: !!w.swap, fetchFrom, switchChar };
    };
    for (const w of withdraws) {
      const r = routing.get(w.server) ?? { count: 0, withdraws: [], deposits: [] };
      r.withdraws.push(route(w));
      r.count++;
      routing.set(w.server, r);
    }
    // A player's next row, for an advanced account it is pinned to: routed the same way, kept apart (never counted as work here).
    for (const w of upcoming) {
      const target = w.targetBotGuid ? this.pool.byBotGuid(w.targetBotGuid) : undefined;
      if (!target || !this.isAdvanced(target)) continue;
      const r = routing.get(w.server) ?? { count: 0, withdraws: [], deposits: [] };
      (r.upcoming ??= []).push({ ...route(w), headClaimed: !!(w as PendingWithdraw & { headClaimed?: boolean }).headClaimed });
      routing.set(w.server, r);
    }
    for (const d of deposits) {
      const r = routing.get(d.server) ?? { count: 0, withdraws: [], deposits: [] };
      r.deposits.push({ requestId: d.id, itemCount: d.itemCount ?? 1, seasonal: d.seasonal ?? true, communism: !!d.communism, ...(d.items?.length ? { items: d.items } : {}) });
      r.count++;
      routing.set(d.server, r);
    }
    const botStates: BotStates = new Map();
    let trackedCapacity = 0;
    for (const [g, inv] of Object.entries(tracker)) {
      const held = Object.values(inv).reduce((a, b) => a + b, 0);
      const cap = caps[g] ?? 8;
      trackedCapacity += cap;
      botStates.set(g, { freeSlots: Math.max(0, cap - held), itemsHeld: held });
    }
    // An account switched to another character (a rotation, a withdraw's
    // picks) and not in the game yet logs in as that one: its room is that
    // character's, not the one the tracker still describes.
    for (const acc of this.accounts()) {
      if (this.inWorld(acc)) continue;
      const next = this.switchedTo(acc);
      if (next) botStates.set(acc.botGuid, { freeSlots: Math.max(0, next.capacity - next.held), itemsHeld: next.held });
    }
    const botCount = this.accounts().length;
    const phantom = Math.max(0, botCount - Object.keys(tracker).length);
    const totalSlots = trackedCapacity + phantom * 8;
    const usedSlots = [...botStates.values()].reduce((a, b) => a + b.itemsHeld, 0);
    return { routing, botStates, capacity: { botCount, totalSlots, usedSlots, full: totalSlots > 0 && usedSlots >= totalSlots } };
  }

  private distinctWorkCount(r: ServerRouting): number {
    const targets = new Set<string>();
    let untargeted = 0;
    for (const w of r.withdraws) {
      if (w.candidateBots.length === 1) targets.add(w.candidateBots[0]);
      else if (w.candidateBots.length > 1) untargeted++;
    }
    untargeted += r.deposits.length;
    return Math.max(targets.size + untargeted, 1);
  }

  private onlyCandidateForOtherServer(acc: BotAccount, current: string, routing: Routing, wanted: Set<string>): string | null {
    for (const server of wanted) {
      if (server === current || this.deps.gate.serverJamRemainingMs(server) > 0) continue;
      for (const w of routing.get(server)?.withdraws ?? []) {
        if (w.candidateBots.length === 1 && w.candidateBots[0] === acc.botGuid) return server;
      }
      for (const d of routing.get(server)?.deposits ?? []) {
        if (!d.communism || !acc.communism || d.seasonal !== seasonalOf(acc)) continue;
        if (!this.isAdvanced(acc) || !this.emptyIntake(true, d.seasonal)) return server;
        // Advanced: idle communism bots keep their server; one moves only to take the deposit into its empty character when no other empty one is coming.
        if (this.nextCharEmpty(acc, d.seasonal) && !this.emptyComing(true, d.seasonal)) return server;
      }
    }
    return null;
  }

  /** The deposits on `r` this bot could claim: communism's if it is a communism account, else the pool's. */
  private claimableDeposits(acc: BotAccount, r: ServerRouting): RoutedDeposit[] {
    return r.deposits.filter((d) => d.seasonal === seasonalOf(acc) && d.communism === acc.communism);
  }

  private accountCanFulfill(acc: BotAccount, r: ServerRouting, botStates: BotStates): boolean {
    if (r.withdraws.some((w) => w.candidateBots.includes(acc.botGuid))) return true;
    // A player's next row it is pinned to (advanced management): it stays for its turn. And one whose items
    // it is to fetch from its storage while online: it stays for the fetch and the trade after it.
    if (r.upcoming?.some((w) => w.targetBotGuid === acc.botGuid || w.candidateBots.includes(acc.botGuid))) return true;
    if (this.isAdvanced(acc) && r.withdraws.some((w) => w.fetchFrom?.botGuid === acc.botGuid && !this.fetchOrders.get(w.requestId)?.offlineOnly)) return true;
    const deposits = this.claimableDeposits(acc, r);
    if (!deposits.length) return false;
    // Advanced: a deposit goes into an empty character, the one it plays (or logs in as) now.
    if (this.isAdvanced(acc) && this.emptyIntake(acc.communism, seasonalOf(acc))) {
      const c = acc.client;
      if (c && this.inWorld(acc)) return this.countFreeSlots(c) >= this.botCapacity(c);
      return this.nextCharEmpty(acc, seasonalOf(acc));
    }
    const free = botStates.get(acc.botGuid)?.freeSlots ?? 8;
    // A deposit is one trade of the size it asks for; a bot short of that
    // can't claim it. A communism account takes communism deposits with any
    // room at all (the rest continues), unless a roomier character of its side
    // takes a full trade of one: then it comes back as that one (rotateFor).
    // In game that is judged by what the client sees, as its claim (claimPlan)
    // and the rotation are: the tracker can say more room than there is.
    const communismFree = acc.communism && acc.client && this.inWorld(acc) ? this.countFreeSlots(acc.client) : free;
    return deposits.some((d) => (d.communism ? communismFree >= 1 && !this.communismRoomierFor(acc, d, communismFree) : free >= d.itemCount));
  }

  /**
   * Per pool half, the most free slots any bot this routing would send for a
   * deposit has: the site's deposit gate promises no more than this. Counts
   * an offline bot it could wake (not held, not in a lockout) and an online
   * idle bot it would swap or that could claim where it is, each with the
   * room of a roomier character of its side it would log in as for a
   * deposit that needs it (rotateFor); leaves out suspended or retired
   * accounts and communism accounts. The login desk's bot and a bot on a
   * passing login cooldown count: both can still take the deposit.
   */
  largestFreeByPool(): { seasonal: number; nonseasonal: number; communism?: { seasonal: number; nonseasonal: number } } {
    const out: { seasonal: number; nonseasonal: number; communism?: { seasonal: number; nonseasonal: number } } = { seasonal: 0, nonseasonal: 0 };
    const waking = this.wakes.waking();
    // Advanced management: a side with empty characters takes as much as they hold together (a deposit bigger than one continues on the next).
    const emptyRoom = (communism: boolean, seasonal: boolean) => Math.min(MAX_TRADE_SLOTS, this.intake.get(this.intakeKey(communism, seasonal))?.room ?? 0);
    if (this.advancedSettings().communism) out.communism = { seasonal: this.emptyIntake(true, true) ? emptyRoom(true, true) : this.communismLargestFree(true), nonseasonal: this.emptyIntake(true, false) ? emptyRoom(true, false) : this.communismLargestFree(false) };
    const advSeasonal = this.emptyIntake(false, true);
    const advNonseasonal = this.emptyIntake(false, false);
    if (advSeasonal) out.seasonal = emptyRoom(false, true);
    if (advNonseasonal) out.nonseasonal = emptyRoom(false, false);
    if (advSeasonal && advNonseasonal) return out;
    for (const acc of this.accounts()) {
      if (acc.communism || this.isHeld(acc.guid)) continue;
      let free: number;
      if (acc.online) {
        // The login desk's bot claims deposits on its own server like any
        // idle bot (claimPlan does not exclude it), so its room counts.
        if (acc.assignedRequestId !== null) continue;
        // In game the trade window is sized by what the client sees, which
        // is what a claim is judged by — the tracker's memory can say 16
        // for a character the client reads as 8.
        const c = acc.client;
        free = c && c.isReady && c.objectId !== -1 ? this.countFreeSlots(c) : this.trackedFree(acc);
      } else if (waking.has(acc.guid) || this.deps.gate.isRetired(acc.guid)) continue;
      // A bot on a passing cooldown (the 10 s after any logout, an attempt
      // limit) still counts: a pending deposit has no clock and waits it out.
      else free = this.trackedFree(acc);
      const key = seasonalOf(acc) ? "seasonal" : "nonseasonal";
      const otherKey = key === "seasonal" ? "nonseasonal" : "seasonal";
      const advanced = { seasonal: advSeasonal, nonseasonal: advNonseasonal };
      if (!advanced[key]) {
        free = Math.max(free, this.roomierChar(acc, Math.max(free, out[key]) + 1)?.free ?? 0);
        if (free > out[key]) out[key] = free;
      }
      // An account with a living character on the other side serves that
      // side too, logging in as it (rotation across the split).
      if (!advanced[otherKey]) {
        const across = this.roomierChar(acc, out[otherKey] + 1, false, !seasonalOf(acc));
        if (across && across.free > out[otherKey]) out[otherKey] = across.free;
      }
    }
    return out;
  }
  /** Communism the old way (no empty character left on the side): the most room any communism account of it has on a character it plays or would switch to. */
  private communismLargestFree(seasonal: boolean): number {
    let best = 0;
    for (const acc of this.accounts()) {
      if (!acc.communism || seasonalOf(acc) !== seasonal || this.deps.gate.isRetired(acc.guid)) continue;
      const c = acc.client;
      const free = c && this.inWorld(acc) ? this.countFreeSlots(c) : this.trackedFree(acc);
      best = Math.max(best, free, this.roomierChar(acc, Math.max(free, best) + 1, true)?.free ?? 0);
    }
    return best;
  }
  /** An advanced account of the pool, offline and free to be woken (or logging in), that would take a deposit of the side into an empty character. */
  private emptyComing(communism: boolean, seasonal: boolean): boolean {
    return (this.intake.get(this.intakeKey(communism, seasonal))?.offline ?? 0) > 0;
  }

  /**
   * A waiting deposit bigger than a plain bot that nothing is serving: ask
   * the backpack lane to fit an empty account of that pool half with one,
   * and keep asking every pass until the deposit is gone (an order nobody
   * renews lapses on its own). Two signals, either is enough: no bot the
   * routing could send has the room, or the deposit has sat unclaimed for
   * ORDER_AFTER_S — a bot that fits claims within a pass or two, so a wait
   * even that short means whatever the room count sees can't actually come.
   * A fitting bot already being woken for the half is given its login first.
   */
  /**
   * A withdraw whose items sit in an account's storage gets a fetch trip
   * ordered (docs/relay/STORAGE.md): the storage service logs the account in
   * as the character that can reach them, moves them onto it, and the next
   * routing pass finds the bot a candidate. One order per request; a failed
   * trip is retried after FETCH_RETRY_S, and after FETCH_MAX_ATTEMPTS trips
   * the request is given up so the player is told rather than left waiting.
   * A bot that is busy (a trade, a login, a chore) is simply tried next pass.
   */
  /**
   * A withdraw whose picks sit on another character of its account, or a
   * hand-over a communism account receives on its other side: make that
   * character the one the account logs in with. An offline account just gets
   * the preference; an idle online one playing the wrong character logs out
   * so the next wake brings the right one.
   */
  private applyCharSwitches(routing: Routing): void {
    for (const r of routing.values()) {
      for (const w of [...r.withdraws, ...(r.upcoming ?? []).filter((u) => u.headClaimed)]) {
        if (w.switchChar === null || !w.targetBotGuid) continue;
        const acc = this.pool.byBotGuid(w.targetBotGuid);
        if (!acc || acc.suspended) continue;
        if ((acc.info.charId ?? null) !== w.switchChar) {
          this.log(`withdraw #${w.requestId}: ${acc.alias} will play character ${w.switchChar}, ${w.items.length || w.instanceIds?.length ? "which holds the picks" : "of the side the hand-over is on"}`);
          this.pool.setPreferredChar(acc, w.switchChar);
        }
        const c = acc.client;
        if (acc.online && c && c.charId !== w.switchChar && acc.assignedRequestId === null && !acc.inUse && !this.isHeld(acc.guid) && (this.sessions.get(acc.guid)?.isIdle() ?? true)) {
          this.log(`${acc.alias} is playing character ${c.charId}; logging out to come back as ${w.switchChar} for withdraw #${w.requestId}`);
          this.disconnectAccount(acc, false);
        }
      }
    }
  }

  /**
   * Character rotation. Deposits land on the played character and stay
   * there. When the deposit an account is woken or kept for needs more free
   * trade slots than its character has, it logs in as a roomier living
   * character of the same side instead: the deposit lands on fresh slots and
   * nothing has to be moved (the items stay listed on the character that
   * holds them). Only then: an idle account with an item or two on its
   * character keeps it. Not while open withdraws name the account: they need
   * the character that holds their items (applyCharSwitches), and rotating
   * away from it made the two log the account in and out in turn (live
   * 2026-09-24); `anyway` asks about such an account all the same (it
   * rotates once they are done).
   *
   * The roomiest such character with at least `need` free slots, other than
   * the one the account logs in as next, or null.
   */
  private roomierChar(acc: BotAccount, need: number, anyway = false, side = seasonalOf(acc)): { id: number; free: number; held: number } | null {
    const desk = this.storageDesk;
    if (!desk || (!anyway && this.pinnedAccounts.has(acc.botGuid))) return null;
    // Communism accounts keep their one side.
    if (acc.communism && side !== seasonalOf(acc)) return null;
    const current = this.switchedTo(acc)?.id ?? desk.loginChar(acc.botGuid);
    let best: { id: number; free: number; held: number } | null = null;
    for (const c of desk.chars(acc.botGuid)) {
      const free = c.capacity - c.held;
      if (c.id === current || c.seasonal !== side || free < need || (best && free <= best.free)) continue;
      best = { id: c.id, free, held: c.held };
    }
    return best;
  }
  /**
   * A communism account under advanced management receiving a hand-over on
   * the other side of the seasonal split: the character of that side it logs
   * in as for it, the roomiest, when that one has room for `need` items; else
   * null (the hand-over then waits like any other it cannot take).
   */
  private receivingCharAcross(botGuid: string, side: boolean, need: number): number | null {
    const acc = this.pool.byBotGuid(botGuid);
    const desk = this.storageDesk;
    if (!acc?.communism || !this.isAdvanced(acc) || !desk) return null;
    let best: { id: number; free: number } | null = null;
    for (const c of desk.chars(botGuid)) {
      if (c.seasonal !== side) continue;
      const free = c.capacity - c.held;
      if (!best || free > best.free) best = { id: c.id, free };
    }
    return best && best.free >= Math.max(1, need) ? best.id : null;
  }
  /** The living character the account was switched to (a rotation, a withdraw's picks) while the tracker still describes another, or null. */
  private switchedTo(acc: BotAccount): { id: number; held: number; capacity: number } | null {
    const pref = acc.info.charId;
    const desk = this.storageDesk;
    if (pref == null || !desk || desk.loginChar(acc.botGuid) === pref) return null;
    return desk.chars(acc.botGuid).find((c) => c.id === pref) ?? null;
  }
  /** Rotate an account kept for these deposits when its character, with `free` slots, is too small for every one of them and a roomier one of its side fits one: the character it switched to, or null. */
  private rotateFor(acc: BotAccount, deposits: RoutedDeposit[], free: number): { id: number; free: number; held: number } | null {
    if (acc.communism) {
      // A roomier character of its side that takes a full trade of a deposit here; with its own full, any with room.
      let next: { id: number; free: number; held: number } | null = null;
      for (const d of deposits) if ((next = this.communismRoomierFor(acc, d, free))) break;
      if (!next && free < 1 && deposits.length) next = this.roomierChar(acc, 1);
      if (next) this.switchChar(acc, next, `a communism deposit waiting for it needs more than its character's ${free} free slot(s); character ${next.id} has ${next.free}`);
      return next;
    }
    const needs = deposits.map((d) => d.itemCount);
    if (!needs.length || needs.some((n) => free >= n)) return null;
    const need = Math.min(...needs);
    const next = this.roomierChar(acc, need);
    if (next) this.switchChar(acc, next, `the ${need}-slot trade waiting for it needs more than its character's ${free} free slot(s)`);
    return next;
  }
  /**
   * A communism account whose character has `free` slots, short of a full
   * trade of this deposit (as much of it as one character of its side
   * holds): the roomier character of its side that takes a full one, which it
   * comes back as rather than split the trade. Null when the played one takes
   * a full one, or no other does: it takes what it can there and the rest
   * continues (lib/queue.ts), sparing a log-in.
   */
  private communismRoomierFor(acc: BotAccount, d: { itemCount: number }, free: number): { id: number; free: number; held: number } | null {
    const full = Math.min(d.itemCount, this.sideCapacity(acc));
    return free >= full ? null : this.roomierChar(acc, full);
  }
  /** The most one character of the account's side holds in a trade: its biggest capacity (8, 16 with a backpack, 24). */
  private sideCapacity(acc: BotAccount): number {
    let best = this.tracker.capacityFor(acc.botGuid);
    for (const c of this.storageDesk?.chars(acc.botGuid) ?? []) if (c.seasonal === seasonalOf(acc)) best = Math.max(best, c.capacity);
    return best;
  }
  /** A communism account's room over every living character of its side (the played one as the tracker counts it): its deposits continue from one to the next. */
  private communismSideRoom(acc: BotAccount): number {
    const side = (this.storageDesk?.chars(acc.botGuid) ?? []).filter((c) => c.seasonal === seasonalOf(acc));
    if (!side.length) return Math.max(0, this.tracker.capacityFor(acc.botGuid) - this.tracker.heldCount(acc.botGuid));
    return side.reduce((n, c) => n + Math.max(0, c.capacity - c.held), 0);
  }
  /**
   * The deposits here are all for the other side of the seasonal split: an
   * account with a living character of that side, roomy enough for one of
   * them, logs in as it next. Communism accounts keep their side.
   */
  private rotateAcross(acc: BotAccount, r: ServerRouting): { id: number; free: number; held: number } | null {
    if (acc.communism) return null;
    const other = r.deposits.filter((d) => !d.communism && d.seasonal !== seasonalOf(acc));
    if (!other.length) return null;
    const need = Math.min(...other.map((d) => d.itemCount));
    const to = this.roomierChar(acc, need, false, !seasonalOf(acc));
    if (to) this.switchChar(acc, to, `the ${need}-slot ${seasonalOf(acc) ? "non-seasonal" : "seasonal"} deposit waiting here needs a character of that side`);
    return to;
  }
  /** The account logs in as `to` from its next login, and is routed as that character from now on. */
  private switchChar(acc: BotAccount, to: { id: number; free: number; held: number }, why: string): void {
    this.log(`${acc.alias} will play character ${to.id} (${to.free} free) from its next login: ${why}`);
    this.pool.setPreferredChar(acc, to.id);
    this.lastBotStates.set(acc.botGuid, { freeSlots: to.free, itemsHeld: to.held });
  }

  private orderFetchesFor(routing: Routing, pending: PendingWithdraw[]): void {
    this.applyCharSwitches(routing);
    const desk = this.storageDesk;
    if (!desk) return;
    const now = Date.now();
    const seen = new Set<number>();
    // What other open withdraws count on per bot: a fetch never banks it away to make room.
    const keepIds = new Map<string, Set<string>>();
    const keepItems = new Map<string, Set<string>>();
    for (const w of pending) {
      if (!w.targetBotGuid) continue;
      if (w.instanceIds?.length) {
        const s = keepIds.get(w.targetBotGuid) ?? new Set<string>();
        for (const id of w.instanceIds) s.add(id);
        keepIds.set(w.targetBotGuid, s);
      } else {
        const s = keepItems.get(w.targetBotGuid) ?? new Set<string>();
        for (const it of w.items) s.add(it.itemId);
        keepItems.set(w.targetBotGuid, s);
      }
    }
    for (const [server, r] of routing) {
      const upcoming = new Set(r.upcoming ?? []);
      for (const w of [...r.withdraws, ...upcoming]) {
        if (!w.fetchFrom) continue;
        seen.add(w.requestId);
        let o = this.fetchOrders.get(w.requestId);
        if (!o) this.fetchOrders.set(w.requestId, (o = { attempts: 0, nextAt: 0, inflight: false, gaveUp: false }));
        if (o.inflight || o.gaveUp || o.nextAt > now) continue;
        const acc = this.pool.byBotGuid(w.fetchFrom.botGuid);
        if (!acc || acc.suspended) continue;
        // Advanced management: the account fetches on its live client and stays online for the trade; a next row only once it is up.
        if (this.isAdvanced(acc) && !o.offlineOnly && o.attempts < C.FETCH_MAX_ATTEMPTS) {
          this.advancedFetch(acc, server, w, o, keepIds.get(acc.botGuid), keepItems.get(acc.botGuid), upcoming.has(w));
          continue;
        }
        if (upcoming.has(w)) continue;
        if (o.attempts >= C.FETCH_MAX_ATTEMPTS) {
          o.gaveUp = true;
          this.log(`withdraw #${w.requestId}: giving up after ${o.attempts} fetch trip(s) on ${acc.alias} — the items stay in storage`);
          // The row is still pending (nobody claimed it), so it is cancelled rather than handed back: the player is told why.
          this.cancelRow({ kind: "withdraw", requestId: w.requestId }, `the items could not be fetched from ${acc.alias}'s storage`, null);
          continue;
        }
        if (acc.assignedRequestId !== null || acc.inUse || this.isHeld(acc.guid) || this.wakes.waking().has(acc.guid)) continue;
        const need = w.fetchFrom.need;
        const named = new Set(need.instanceIds);
        const keep = new Set<string>([...(keepIds.get(acc.botGuid) ?? []), ...this.reserved()].filter((id) => !named.has(id)));
        o.inflight = true;
        const order = o;
        const what = need.instanceIds.length ? `${need.instanceIds.length} picked item(s)` : need.items.map((it) => `${it.qty}x${it.itemId}`).join(",");
        this.log(`withdraw #${w.requestId}: ordering a fetch of ${what} from ${acc.alias}'s storage (trip ${order.attempts + 1}/${C.FETCH_MAX_ATTEMPTS})`);
        void desk.fetch(acc, need, { seasonal: w.seasonal, keep, keepItems: keepItems.get(acc.botGuid), why: `withdraw #${w.requestId}` }).then((res) => {
          order.inflight = false;
          if (res.ok) {
            this.log(`withdraw #${w.requestId}: fetch from ${acc.alias}'s storage done — routing it next pass`);
            this.poke();
            return;
          }
          if (res.busy) {
            // Not a trip: the account was not free. Try again soon.
            order.nextAt = Date.now() + C.SUPERVISE_INTERVAL_S * 1000;
            return;
          }
          order.attempts++;
          if (res.permanent) order.attempts = C.FETCH_MAX_ATTEMPTS;
          order.nextAt = Date.now() + C.FETCH_RETRY_S * 1000;
          this.log(`withdraw #${w.requestId}: fetch from ${acc.alias}'s storage failed (${res.error})${order.attempts >= C.FETCH_MAX_ATTEMPTS ? " — no more trips" : ` — retrying in ${C.FETCH_RETRY_S}s`}`);
        }).catch((e) => {
          order.inflight = false;
          order.attempts++;
          order.nextAt = Date.now() + C.FETCH_RETRY_S * 1000;
          this.log(`withdraw #${w.requestId}: fetch raised: ${String(e)}`);
        });
      }
    }
    for (const id of [...this.fetchOrders.keys()]) if (!seen.has(id) && !this.fetchOrders.get(id)!.inflight) this.fetchOrders.delete(id);
  }

  private orderBackpackBotsFor(routing: Routing): void {
    if (!this.orderBackpackBot) return;
    const now = Date.now();
    const seen = new Set<number>();
    const wanted = { seasonal: false, nonseasonal: false };
    const big: RoutedDeposit[] = [];
    for (const r of routing.values()) {
      for (const d of r.deposits) {
        if (d.communism || d.itemCount <= 8) continue;
        big.push(d);
        seen.add(d.requestId);
        const since = this.bigDepositSince.get(d.requestId) ?? now;
        this.bigDepositSince.set(d.requestId, since);
        if (now - since >= C.ORDER_AFTER_S * 1000) wanted[d.seasonal ? "seasonal" : "nonseasonal"] = true;
      }
    }
    for (const id of [...this.bigDepositSince.keys()]) if (!seen.has(id)) this.bigDepositSince.delete(id);
    if (!big.length) return;
    const room = this.largestFreeByPool();
    for (const d of big) if (room[d.seasonal ? "seasonal" : "nonseasonal"] < d.itemCount) wanted[d.seasonal ? "seasonal" : "nonseasonal"] = true;
    // A bot with the room is on its way in: let it land and claim before
    // spending a backpack on a second one.
    const waking = this.wakes.waking();
    for (const half of ["seasonal", "nonseasonal"] as const) {
      if (!wanted[half]) continue;
      const need = Math.max(...big.filter((d) => d.seasonal === (half === "seasonal")).map((d) => d.itemCount));
      const inbound = [...waking].some((g) => {
        const a = this.pool.byGuid(g);
        return !!a && seasonalOf(a) === (half === "seasonal") && !a.communism && this.trackedFree(a) >= need;
      });
      if (!inbound) this.orderBackpackBot(half === "seasonal");
    }
  }

  /** Whether `liveFree` slots fit some pool deposit on this server this bot could claim. Stale routing says yes and lets the site decide. */
  private depositFitsHere(acc: BotAccount, client: GameClient, liveFree: number): boolean {
    if (!this.lastRouting.size && !this.lastWantedAt) return true;
    if (Date.now() - this.lastWantedAt > C.ROUTING_FRESH_S * 1000) return true;
    const r = client.server ? this.lastRouting.get(client.server) : undefined;
    if (!r) return false;
    return this.claimableDeposits(acc, r).some((d) => (d.communism ? liveFree >= 1 : liveFree >= d.itemCount));
  }

  private yieldsDepositToEmptyBot(acc: BotAccount, r: ServerRouting, botStates: BotStates, offlinePool: BotAccount[]): boolean {
    // A communism account's deposits are communism accounts' alone.
    if (acc.communism) return false;
    // A collector covers the deposits routed to it (it claims those by id)
    // and nothing else: unrelated items on a collector cost its bucket the
    // room, so for any other deposit it yields like every bot carrying items.
    // It has to, or the empty bot never gets woken: the claim path makes the
    // collector wait for one, and a blanket exemption here meant the
    // supervisor saw the deposit as covered the whole time it waited.
    if (this.collectionTargets.has(acc.botGuid) && r.deposits.some((d) => d.items?.length && this.depositHome(d)?.guid === acc.guid)) return false;
    if (r.withdraws.some((w) => w.candidateBots.includes(acc.botGuid))) return false;
    if (!r.deposits.some((d) => !d.communism && d.seasonal === seasonalOf(acc))) return false;
    if ((botStates.get(acc.botGuid)?.itemsHeld ?? 0) <= 0) return false;
    return this.emptyOfflineAccount(seasonalOf(acc), botStates, offlinePool) !== null;
  }

  private serverBenched(server: string, now: number): boolean {
    const left = this.deps.gate.serverJamRemainingMs(server);
    if (left <= 0) return false;
    if (now - (this.serverJamLogAt.get(server) ?? 0) > 30_000) {
      this.serverJamLogAt.set(server, now);
      this.log(`skipping ${server} — benched (full / connection-limited), ${Math.floor(s(left))}s left`);
    }
    return true;
  }

  private anyOfflineCanFulfill(r: ServerRouting, botStates: BotStates, offlinePool: BotAccount[]): boolean {
    const offlineGuids = new Set(offlinePool.map((a) => a.botGuid));
    for (const w of r.withdraws) for (const g of w.candidateBots) if (offlineGuids.has(g)) return true;
    for (const a of offlinePool) {
      if (r.deposits.some((d) => d.communism === a.communism && this.hasRoomFor(a, d, botStates))) return true;
    }
    return false;
  }
  /** Whether an offline account has the room for this deposit's trade: on the character it logs in as, or on a roomier one of its side it would rotate to. */
  private hasRoomFor(acc: BotAccount, d: RoutedDeposit, botStates: BotStates): boolean {
    // Advanced: an empty character of the deposit's side, logged in as or switched to.
    if (this.isAdvanced(acc) && this.emptyIntake(acc.communism, d.seasonal)) return this.emptyCharsOf(acc, d.seasonal).some((c) => c.next || (c.id !== -1 && !this.pinnedAccounts.has(acc.botGuid)));
    const need = d.communism ? 1 : d.itemCount;
    // The other side: only by logging in as a character of that side.
    if (d.seasonal !== seasonalOf(acc)) return this.roomierChar(acc, need, false, d.seasonal) !== null;
    return (botStates.get(acc.botGuid)?.freeSlots ?? 8) >= need || this.roomierChar(acc, need) !== null;
  }

  private offlineCoverAvailable(wanted: Set<string>, routing: Routing, botStates: BotStates): boolean {
    const waking = this.wakes.waking();
    const wakeable = this.offline().filter((a) => !waking.has(a.guid) && !this.isHeld(a.guid) && this.loginBlockedMs(a) <= 0);
    if (!wakeable.length) return false;
    for (const sv of wanted) {
      const r = routing.get(sv);
      if (r && this.anyOfflineCanFulfill(r, botStates, wakeable)) return true;
    }
    return false;
  }

  private diagnoseUnfulfillable(server: string, r: ServerRouting, offlinePool: BotAccount[]): void {
    const sig = JSON.stringify([r.withdraws.map((w) => [w.requestId, w.items]), r.deposits.length, offlinePool.map((a) => a.botGuid).sort()]);
    if (this.lastUnfulfillableSig.get(server) === sig) return;
    this.lastUnfulfillableSig.set(server, sig);
    const tracker = this.tracker.itemsView();
    const online = new Set(this.online().map((a) => a.botGuid));
    for (const w of r.withdraws) {
      if (w.candidateBots.length) {
        if (w.candidateBots.every((g) => online.has(g))) this.log(`[diag] ${server}: every candidate for withdraw #${w.requestId} is ONLINE — needs a server swap`);
        else {
          const cooling = w.candidateBots.filter((g) => !online.has(g)).map((g) => this.pool.byBotGuid(g)).filter((a): a is BotAccount => !!a && this.loginBlockedMs(a) > 0);
          if (cooling.length) this.log(`[diag] ${server}: withdraw #${w.requestId}'s offline candidate(s) ${cooling.map((a) => a.alias).join(",")} are on a login cooldown — waiting it out`);
        }
        continue;
      }
      if (w.fetchFrom) {
        const o = this.fetchOrders.get(w.requestId);
        this.log(`[diag] ${server}: withdraw #${w.requestId} needs items from ${this.pool.byBotGuid(w.fetchFrom.botGuid)?.alias ?? w.fetchFrom.botGuid}'s storage — ${o?.inflight ? "a fetch is on its way" : o?.gaveUp ? "given up after repeated fetch failures" : `fetch ordered (${o?.attempts ?? 0} attempt(s) so far)`}`);
        continue;
      }
      if (w.perInstance) {
        const target = w.targetBotGuid ? this.pool.byBotGuid(w.targetBotGuid)?.alias ?? w.targetBotGuid : "(none)";
        this.log(`[diag] ${server}: withdraw #${w.requestId} names physical items its pinned bot ${target} cannot reach for that side — it will age out unless the player re-picks them`);
        continue;
      }
      const holders = [...tracker].filter(([, inv]) => w.items.every((it) => (inv[it.itemId] ?? 0) >= it.qty)).map(([g]) => g);
      if (holders.length) this.log(`[diag] ${server}: withdraw #${w.requestId} is held by ${holders.join(",")} but none is a same-pool candidate`);
      else this.log(`[diag] ${server}: no one bot's tracked inventory covers withdraw #${w.requestId} — what it asks for is spread over several, or in storage`);
    }
    for (const d of r.deposits) {
      const withRoom = offlinePool.filter((a) => seasonalOf(a) === d.seasonal && a.communism === d.communism && this.hasRoomFor(a, d, this.lastBotStates)).length;
      this.log(`[diag] ${server}: ${d.seasonal ? "seasonal" : "non-seasonal"} deposit #${d.requestId} (${d.itemCount}-slot trade) — offline ${d.seasonal ? "seasonal" : "non-seasonal"} bots with that much room: ${withRoom}`);
    }
  }

  private evictIdleToUnjam(stillOnline: BotAccount[], routing: Routing, wanted: Set<string>, botStates: BotStates, now: number): number {
    const needBy = new Map([...wanted].map((sv) => [sv, this.distinctWorkCount(routing.get(sv) ?? { count: 0, withdraws: [], deposits: [] })]));
    const keptBy = new Map<string, number>();
    const evictable: BotAccount[] = [];
    const collectors: BotAccount[] = [];
    for (const acc of stillOnline) {
      if (acc.assignedRequestId !== null || acc.guid === this.loginBotGuid || this.isHeld(acc.guid)) continue;
      // Advanced: a bot woken for a player's next row, or fetching for one, is that row's.
      if (this.isAdvanced(acc) && this.withdrawsCountOn(acc.botGuid)) continue;
      const wokeAt = this.lastActive.get(acc.guid) ?? 0;
      if (wokeAt > 0 && now - wokeAt < C.WAKE_GRACE_S * 1000) continue;
      const server = acc.client!.server;
      const covers = !!server && wanted.has(server) && this.accountCanFulfill(acc, routing.get(server)!, botStates);
      if (covers && (keptBy.get(server) ?? 0) < (needBy.get(server) ?? 0)) {
        keptBy.set(server, (keptBy.get(server) ?? 0) + 1);
        continue;
      }
      if (this.isCollectingPotions(acc, acc.client!, now)) collectors.push(acc);
      else evictable.push(acc);
    }
    let shortfall = 0;
    for (const sv of wanted) shortfall += Math.max(0, (needBy.get(sv) ?? 0) - (keptBy.get(sv) ?? 0));
    const tiers = [...evictable, ...collectors];
    if (shortfall <= 0 || !tiers.length) return 0;
    let evicted = 0;
    for (const acc of tiers.slice(0, shortfall)) {
      const server = acc.client!.server || "?";
      const why = collectors.includes(acc) ? `collecting potions on ${server}, but a player needs the slot` : `idle on ${server} and surplus to need`;
      this.log(`${acc.alias} ${why} — evicting to free a slot for pending ${[...wanted].sort().join(",")} work`);
      this.disconnectAccount(acc);
      evicted++;
    }
    return evicted;
  }

  // --- wakes ---------------------------------------------------------------------------

  private async wakeAccountForServer(server: string, r: ServerRouting, botStates: BotStates, capacity: { usedSlots: number; totalSlots: number }): Promise<boolean> {
    if (this.hold.active) return false;
    const withdrawCandidates = new Set(r.withdraws.flatMap((w) => w.candidateBots));
    const waking = this.wakes.waking();
    const offline = this.accounts().filter((a) => !a.online && !this.isHeld(a.guid) && !waking.has(a.guid));
    const depositRows = (ds: RoutedDeposit[]): RowRef[] => ds.map((d) => ({ kind: "deposit", requestId: d.requestId }));
    for (const acc of offline) {
      if (!withdrawCandidates.has(acc.botGuid)) continue;
      const rows: RowRef[] = r.withdraws.filter((w) => !w.swap && w.candidateBots.includes(acc.botGuid)).map((w) => ({ kind: "withdraw", requestId: w.requestId }));
      if (this.wakeSpecificAccount(acc, server, rows)) {
        this.log(`chose ${acc.alias} for withdraw coverage on ${server}`);
        return true;
      }
    }
    // Advanced management: an empty character takes the deposit; the old ways below serve the rest.
    const emptyIntake = r.deposits.filter((d) => this.emptyIntake(d.communism, d.seasonal));
    if (emptyIntake.length && this.wakeEmptyFor(server, emptyIntake, offline)) return true;
    const oldWay = emptyIntake.length ? r.deposits.filter((d) => !emptyIntake.includes(d)) : r.deposits;
    // Communism: a communism account of the deposit's half with room, roomiest
    // first; one whose character is full, or short of a full trade of the
    // deposit that a roomier one of its side takes, logs in as that one.
    for (const d of oldWay) {
      if (!d.communism) continue;
      const cands = offline
        .filter((a) => a.communism && seasonalOf(a) === d.seasonal && !this.isHeld(a.guid) && !waking.has(a.guid))
        .map((a) => {
          const free = this.trackedFree(a);
          const other = this.communismRoomierFor(a, d, free) ?? (free < 1 ? this.roomierChar(a, 1) : null);
          return { acc: a, free: other ? other.free : free, other };
        })
        .filter((c) => c.free >= 1)
        .sort((a, b) => b.free - a.free || (a.acc.guid < b.acc.guid ? -1 : 1));
      for (const { acc, free, other } of cands) {
        if (this.wakeSpecificAccount(acc, server, depositRows([d]), other && { to: other, why: `communism deposit #${d.requestId} on ${server} needs more room than its character's ${this.trackedFree(acc)} free slot(s)` })) {
          this.log(`chose ${acc.alias} for communism deposit #${d.requestId} on ${server} — a communism account with ${free} free slot(s)`);
          return true;
        }
      }
    }
    const poolsNeeded = new Set(oldWay.filter((d) => !d.communism && d.itemCount > 0).map((d) => d.seasonal));
    for (const d of oldWay) {
      if (!d.items?.length) continue;
      const home = this.depositHome(d);
      if (!home || home.online || this.isHeld(home.guid) || waking.has(home.guid)) continue;
      if (this.trackedFree(home) < d.itemCount) continue;
      if (this.wakeSpecificAccount(home, server, depositRows([d]))) {
        this.log(`chose ${home.alias} for deposit #${d.requestId} on ${server} — it gathers what the player is bringing`);
        return true;
      }
    }
    if (poolsNeeded.size) {
      // A bot is worth waking only if some pending deposit's trade fits its
      // free slots: its character's, or, when the trade it would come for
      // needs more than that one has, a roomier character's of its side it
      // then logs in as (roomierChar). Among those, the ones that fit the
      // biggest request waiting come first, then the least loaded, then the
      // tightest fit — so an empty backpack bot is not spent on an 8-slot
      // trade while a plain empty bot could take it and a 16-slot trade is
      // waiting.
      const unpinned = oldWay.filter((d) => !d.communism);
      // Each side the deposits want: an account serves its own side as the
      // character it plays (or a roomier one of that side), and the other
      // side by logging in as a living character of that side, when it has one.
      const scored: [number, number, number, BotAccount, { id: number; free: number; held: number } | null, boolean][] = [];
      for (const acc of offline) {
        if (acc.communism) continue;
        for (const side of poolsNeeded) {
          const mine = unpinned.filter((d) => d.seasonal === side);
          if (!mine.length) continue;
          const biggest = Math.max(...mine.map((d) => d.itemCount));
          const smallest = Math.min(...mine.map((d) => d.itemCount));
          const st = botStates.get(acc.botGuid);
          let free = st?.freeSlots ?? 8;
          let held = st?.itemsHeld ?? 0;
          let other: { id: number; free: number; held: number } | null;
          if (side === seasonalOf(acc)) other = free < biggest ? this.roomierChar(acc, free >= smallest ? biggest : smallest) : null;
          else {
            other = this.roomierChar(acc, biggest, false, side) ?? this.roomierChar(acc, smallest, false, side);
            if (!other) continue;
          }
          if (other) {
            free = other.free;
            held = other.held;
          }
          if (free < smallest) continue;
          // Its own side first: a switch across the split is a second choice.
          scored.push([(free >= biggest ? 0 : 2) + (side === seasonalOf(acc) ? 0 : 1), held, free, acc, other, side]);
        }
      }
      scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      for (const [, held, free, acc, other, side] of scored) {
        const fits = unpinned.filter((d) => d.seasonal === side && free >= d.itemCount);
        const size = Math.max(...fits.map((d) => d.itemCount));
        const across = side !== seasonalOf(acc);
        const why = across ? `the ${size}-slot ${side ? "seasonal" : "non-seasonal"} deposit on ${server} needs a character of that side` : `the ${size}-slot deposit on ${server} needs more than its character's ${this.trackedFree(acc)} free slot(s)`;
        if (this.wakeSpecificAccount(acc, server, depositRows(fits), other && { to: other, why })) {
          this.log(`chose ${acc.alias} for ${side ? "seasonal" : "non-seasonal"} deposit (${free} free slots, ${held} held) on ${server}${across && other ? ` as character ${other.id}` : ""}`);
          if (held === 0) this.emptyWakeFor.set(server, [acc.guid, Date.now(), side]);
          return true;
        }
      }
    }
    this.log(`no eligible offline bot for ${server} (capacity ${capacity.usedSlots}/${capacity.totalSlots}) — leaving work pending`);
    return false;
  }

  /**
   * Log an account in on `server`. `forRows`: the player rows the wake is
   * for, cancelled should the login meet a queue (leaveLoginQueue).
   * `rotate`: the roomier character it logs in as instead of its own
   * (roomierChar), switched once the wake is on its way; the login reads the
   * character when it runs, after the wake stagger.
   */
  private wakeSpecificAccount(acc: BotAccount, server: string, forRows: RowRef[] = [], rotate: { to: { id: number; free: number; held: number }; why: string } | null = null): boolean {
    const now = Date.now();
    const paused = this.deps.gate.pausedRemainingMs();
    if (paused > 0) {
      if (now - this.loginPauseNote >= 30_000) {
        this.loginPauseNote = now;
        this.log(`logins paused for another ${Math.floor(s(paused))}s — not waking anyone`);
      }
      return false;
    }
    const remaining = this.deps.gate.lockoutRemainingMs(acc.guid);
    if (remaining > 0) {
      this.log(`skipping ${acc.alias} — login cooldown, ${Math.floor(s(remaining))}s left`);
      return false;
    }
    const started = this.wakes.start(acc, server, (r) => {
      this.wakeResults.push(r);
      this.poke();
    }, this.deps.log);
    if (!started) return false;
    if (rotate) this.switchChar(acc, rotate.to, rotate.why);
    if (forRows.length) this.wokeFor.set(acc.guid, forRows);
    else this.wokeFor.delete(acc.guid);
    return true;
  }

  private disconnectAccount(acc: BotAccount, unclaim = true, keepMoves = false): void {
    if (!acc.client) return;
    const strandedReq = acc.assignedRequestId;
    const strandedKind = acc.assignedKind;
    const session = this.sessions.get(acc.guid);
    // Windows of a chunked withdraw that already crossed are reported before
    // the session goes: the fulfill re-opens the row with only the remainder,
    // so the next bot doesn't hand those items over a second time.
    const partial = strandedKind === "withdraw" && strandedReq !== null && !this.swapAssignments.has(acc.guid) ? session?.partialDelivery() ?? null : null;
    if (partial) {
      this.log(`${acc.alias} disconnected mid-withdraw #${strandedReq} after handing over ${partial.delivered.map((i) => `${i.qty}x${i.itemId}`).join(",")} — reporting the partial delivery`);
      this.reportFulfill({ kind: "withdraw", botGuid: acc.botGuid, requestId: strandedReq!, items: partial.delivered, instanceIds: partial.deliveredInstanceIds, attempts: 0 });
      unclaim = false;
    }
    session?.detach();
    this.sessions.delete(acc.guid);
    takeDown(this.deps, acc, "supervisor disconnect");
    acc.client = null;
    for (const m of [this.lastHeartbeat, this.lastClaim, this.lastStatus]) m.delete(acc.botGuid);
    for (const m of [this.tradeTimeline, this.consolidationAssignedAt, this.partnerWaitSince, this.collectorHoldSince, this.collectorNoteAt, this.collectorLastArrival, this.serverIdleSince, this.swapYieldNote, this.notInWorldSince, this.swapWaitNoteAt, this.wokeFor, this.sessionStartedAt, this.workEndedAt]) m.delete(acc.guid);
    // A swap row goes back to pending like any other; the coordinator's
    // outcome check settles it if the trade had in fact finished.
    if (this.swapAssignments.has(acc.guid) && strandedReq !== null) void this.api.noteSwap?.(acc.botGuid, strandedReq, "swap-interrupted", { bot: acc.alias, why: "the bot disconnected" }).catch(() => null);
    this.swapAssignments.delete(acc.guid);
    this.forgetSwapChecks(acc.guid);
    this.playerReadyNoted.delete(acc.guid);
    if (unclaim && strandedReq !== null && (strandedKind === "deposit" || strandedKind === "withdraw")) {
      void this.api.unclaim(acc.botGuid, strandedReq, strandedKind).then((r) => {
        if (r.ok) this.log(`${acc.alias} disconnected mid-${strandedKind} #${strandedReq} — unclaimed=${r.unclaimed}`);
        else this.log(`${acc.alias} unclaim of ${strandedKind} #${strandedReq} failed: ${r.error}`);
      }).catch((e) => this.log(`${acc.alias} unclaim raised: ${String(e)}`));
    }
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
    if (!keepMoves) this.releaseMovesFor(acc.guid, `${acc.alias} disconnected during setup`);
    this.coordinator.releaseAllFor(acc.guid);
  }

  // --- login queues, rows nobody can serve, login desk ---------------------------

  /**
   * A bot that finds itself in a server's login queue leaves at once, on any
   * server: a place in the queue can take many minutes, and the player it
   * came for is better told than kept waiting. The deposit or withdraw it
   * had claimed is cancelled saying so, and so are the rows its wake was for
   * (wakeAccountForServer) that no bot already in the game there can take; a
   * cross-node meeting's row is only handed back, since it lives by the
   * hub's deadline. The server is benched a while, so the next wake (the
   * login desk's above all) does not walk into the same queue.
   */
  private leaveLoginQueue(acc: BotAccount, client: GameClient): void {
    const server = client.server;
    const kind = acc.assignedKind;
    const claimed: RowRef | null = acc.assignedRequestId !== null && (kind === "deposit" || kind === "withdraw") && !this.swapAssignments.has(acc.guid) ? { kind, requestId: acc.assignedRequestId } : null;
    const r = this.lastRouting.get(server);
    const woken = (this.wokeFor.get(acc.guid) ?? []).filter((row) => row.requestId !== claimed?.requestId && this.stillPending(r, row) && !this.takenInWorld(server, row, acc));
    const cancel = claimed ? [claimed, ...woken] : woken;
    this.log(`${acc.alias} is in the ${server} login queue${client.queuePos >= 0 ? ` at ${client.queuePos}/${client.queueMax}` : ""} — disconnecting${cancel.length ? ` and cancelling ${cancel.map((row) => `${row.kind} #${row.requestId}`).join(", ")}` : ""}`);
    this.deps.gate.noteServerJam(server, C.LOGIN_QUEUE_BENCH_S, "a bot met its login queue");
    // The claimed row is not handed back: the next bot would only meet the same queue.
    this.disconnectAccount(acc, claimed === null);
    for (const row of cancel) this.cancelRow(row, `${server} had a login queue`, acc.botGuid, row === claimed);
  }
  /** Whether a row is still waiting in `r`, the last routing pass of its server (never a swap row): one taken or closed meanwhile is left alone. */
  private stillPending(r: ServerRouting | undefined, row: RowRef): boolean {
    return row.kind === "deposit" ? !!r?.deposits.some((d) => d.requestId === row.requestId) : !!r?.withdraws.some((w) => w.requestId === row.requestId && !w.swap);
  }
  /** Whether a bot already in the game on `server`, other than `except`, could take this row. */
  private takenInWorld(server: string, row: RowRef, except: BotAccount): boolean {
    const r = this.lastRouting.get(server);
    const here = this.online().filter((a) => a !== except && this.inWorld(a) && a.client!.server === server);
    if (row.kind === "withdraw") {
      const w = r?.withdraws.find((x) => x.requestId === row.requestId);
      return !!w && here.some((a) => w.candidateBots.includes(a.botGuid));
    }
    const d = r?.deposits.find((x) => x.requestId === row.requestId);
    const takes = (a: BotAccount) => (this.isAdvanced(a) && this.emptyIntake(a.communism, d!.seasonal) ? this.countFreeSlots(a.client!) >= this.botCapacity(a.client!) : this.countFreeSlots(a.client!) >= (d!.communism ? 1 : d!.itemCount));
    return !!d && here.some((a) => seasonalOf(a) === d.seasonal && a.communism === d.communism && takes(a));
  }
  /**
   * Cancel a player's row the fleet cannot serve, saying why; `botGuid` is
   * the bot the row was for. A site without the call can only give up a row
   * that bot had `claimed`.
   */
  private cancelRow(row: RowRef, why: string, botGuid: string | null, claimed = false): void {
    const call = this.api.cancel ? this.api.cancel(botGuid, row.requestId, row.kind, why) : claimed && botGuid ? this.api.giveUp(botGuid, row.requestId, row.kind) : null;
    void call?.then((res) => {
      if (!res.ok) this.log(`cancel of ${row.kind} #${row.requestId} failed: ${res.error}`);
    }).catch((e) => this.log(`cancel of ${row.kind} #${row.requestId} raised: ${String(e)}`));
  }

  /**
   * Rows no account on the node could ever serve are cancelled, saying why,
   * so the player is told rather than left waiting, and leave this routing
   * pass. Only those: a row waiting for a login, a cooldown, a proxy, a fetch
   * or a busy bot waits (docs/relay/POLICIES.md §3). A swap or meeting row is
   * never cancelled here; it lives by the hub's deadline.
   */
  private cancelUnservable(routing: Routing, botStates: BotStates): void {
    const seen = new Set<string>();
    const stock = new StockOnNode(this.tracker, this.storageDesk, this.pool.every());
    const drop = (server: string, row: RowRef, why: string | null): boolean => {
      if (!why) return true;
      const key = `${row.kind}#${row.requestId}`;
      seen.add(key);
      if (!this.cancelledUnservable.has(key)) {
        this.cancelledUnservable.add(key);
        this.log(`${row.kind} #${row.requestId} on ${server}: no account can serve it (${why}) — cancelling`);
        this.cancelRow(row, why, null);
      }
      return false;
    };
    for (const [server, r] of routing) {
      const before = r.withdraws.length + r.deposits.length;
      r.deposits = r.deposits.filter((d) => drop(server, { kind: "deposit", requestId: d.requestId }, this.depositUnservable(d, botStates)));
      r.withdraws = r.withdraws.filter((w) => drop(server, { kind: "withdraw", requestId: w.requestId }, this.withdrawUnservable(w, stock)));
      r.count -= before - r.withdraws.length - r.deposits.length;
    }
    for (const key of [...this.cancelledUnservable]) if (!seen.has(key)) this.cancelledUnservable.delete(key);
  }
  /**
   * Why no account could ever take this deposit, or null when one could, now
   * or once it is free: an account of its side (communism or pool, suspended
   * ones aside) with the room for its trade on a living character of that
   * side, online or not, busy or not, on a login cooldown or not. One with a
   * login under way is not judged until it is read.
   */
  private depositUnservable(d: RoutedDeposit, botStates: BotStates): string | null {
    // Advanced: some character of its side holds nothing, and intake waits for it.
    if (this.emptyIntake(d.communism, d.seasonal)) return null;
    const need = d.communism ? 1 : d.itemCount;
    const kind = `${d.seasonal ? "seasonal" : "non-seasonal"}${d.communism ? " communism" : ""}`;
    let accounts = 0;
    for (const acc of this.accounts()) {
      if (acc.communism !== d.communism) continue;
      if (seasonalOf(acc) !== d.seasonal) {
        // A pool account with a living character of the deposit's side serves it by logging in as that one.
        if (acc.communism || !this.storageDesk?.chars(acc.botGuid).some((c) => c.seasonal === d.seasonal)) continue;
        accounts++;
        if (this.unsettled(acc)) return null;
        if (this.roomierChar(acc, need, true, d.seasonal)) return null;
        continue;
      }
      accounts++;
      if (this.unsettled(acc)) return null;
      const free = this.inWorld(acc) ? this.countFreeSlots(acc.client!) : botStates.get(acc.botGuid)?.freeSlots ?? 8;
      if (free >= need || this.roomierChar(acc, need, true)) return null;
    }
    if (accounts) return d.communism ? `no ${kind} account has a free slot` : `no ${kind} account has room for a ${need}-slot trade`;
    return this.pool.every().some((a) => a.suspended && seasonalOf(a) === d.seasonal && a.communism === d.communism) ? `every ${kind} account that could take it is suspended` : `this node has no ${kind} account`;
  }
  /**
   * Why no account could ever hand this withdraw over, or null when one
   * could, now or once it is free: a candidate bot, a fetch from storage or
   * a character switch routes it, or what it asks for is still on the node
   * where the routing does not reach it. Picked items are lost with their
   * account (off the roster, suspended) or when one is on no account any
   * more (dropped, traded away); a withdraw by type when no account that
   * can trade holds as many as it asks for, on a character of its side or
   * in storage it can reach.
   */
  private withdrawUnservable(w: RoutedWithdraw, stock: StockOnNode): string | null {
    if (w.swap || w.candidateBots.length || w.fetchFrom || w.switchChar !== null || !this.storageDesk) return null;
    if (w.instanceIds) {
      const target = w.targetBotGuid ? this.pool.byBotGuid(w.targetBotGuid) : undefined;
      if (!target) return "the account that held the picked items is no longer on this node";
      if (target.suspended) return "the account that holds the picked items is suspended";
      if (this.unsettled(target)) return null;
      const lost = w.instanceIds.filter((id) => !stock.holds(id)).length;
      if (!lost) return null;
      return lost === w.instanceIds.length ? "the picked items are no longer on the node" : `${lost} of the picked items are no longer on the node`;
    }
    const want = new Map<string, number>();
    for (const it of w.items) want.set(it.itemId, (want.get(it.itemId) ?? 0) + it.qty);
    const short = [...want].find(([itemId, qty]) => stock.count(itemId, w.seasonal) < qty);
    return short ? `no account on the node holds ${short[1]}× ${ITEM_BY_ID.get(short[0])?.name ?? short[0]}` : null;
  }
  /**
   * A login of the account under way (the dispatcher's or a maintenance
   * trip's), or a session not read yet: the tracker may still describe the
   * character it played last, and what the new one holds is on its way to
   * it, so its room and items are not known for sure.
   */
  private unsettled(acc: BotAccount): boolean {
    if (!this.deps.clients.has(acc.guid)) return false;
    const c = acc.client;
    return !(c && this.inWorld(acc) && c.playerData.enchantmentsSeen);
  }

  private isCollectingPotions(acc: BotAccount, client: GameClient, now: number): boolean {
    if (!C.CONSOLIDATION_ENABLED || !this.collectionTargets.has(acc.botGuid) || acc.assignedRequestId !== null) return false;
    if (this.countFreeSlots(client) <= 0) return false;
    // A collector is worth keeping online only while something is on its
    // way: a pending move names it, or an item just landed and the planner
    // may follow up. Otherwise it was sitting idle for the whole hold cap
    // (2026-09-07: five bots parked for ten minutes with nothing to move).
    const expected = this.pendingMoves.some((m) => m.taker === acc.botGuid);
    const recent = now - (this.collectorLastArrival.get(acc.guid) ?? 0) < C.COLLECTOR_GRACE_S * 1000;
    if (!expected && !recent) {
      this.collectorHoldSince.delete(acc.guid);
      return false;
    }
    const started = this.collectorHoldSince.get(acc.guid) ?? now;
    this.collectorHoldSince.set(acc.guid, started);
    if (now - started > C.COLLECTOR_HOLD_MAX_S * 1000) {
      if (now - (this.collectorNoteAt.get(acc.guid) ?? 0) >= C.COLLECTOR_HOLD_MAX_S * 1000) {
        this.collectorNoteAt.set(acc.guid, now);
        this.log(`${acc.alias} has been collecting for ${Math.floor(s(now - started))}s with nothing arriving — releasing the hold`);
      }
      return false;
    }
    return true;
  }

  private loginDeskServer(acc: BotAccount): string {
    // The desk sits where the work is. On a node with one or two accounts the
    // desk bot IS the bot every swap and withdraw needs, so parking it on a
    // fixed server would strand that work (a pinned row on USSouth3 while the
    // desk holds the account on USWest4). Pinned work for this account wins;
    // otherwise the configured desk servers, as before.
    const wanted = this.lastWantedServers;
    if (wanted.size) {
      for (const sv of wanted) {
        if (C.LOGIN_DESK_AVOID_SERVERS.has(sv) || this.deps.gate.serverJamRemainingMs(sv) > 0) continue;
        const r = this.lastRouting?.get(sv);
        if (r && (r.withdraws.some((w) => w.targetBotGuid === acc.botGuid) || r.deposits.some((d) => d.communism && acc.communism && d.seasonal === seasonalOf(acc)))) return sv;
      }
    }
    return this.deskServerFor(acc.info.server ?? "");
  }
  /**
   * Any server Realm reports empty will do for the desk: the configured desk
   * servers first (LOGIN_DESK_SERVERS), then `home` (the account's own), then
   * any other. Without a fresh reading, or with no empty server, the
   * configured ones as before. Never a jammed or avoided server.
   */
  private deskServerFor(home: string): string {
    const usable = (sv: string) => !!sv && !C.LOGIN_DESK_AVOID_SERVERS.has(sv) && this.deps.gate.serverJamRemainingMs(sv) <= 0;
    const empty = new Set((this.emptyServers() ?? []).filter(usable));
    if (empty.size) {
      for (const sv of C.LOGIN_DESK_SERVERS) if (empty.has(sv)) return sv;
      if (empty.has(home)) return home;
      return [...empty].sort()[0];
    }
    for (const sv of C.LOGIN_DESK_SERVERS) if (this.deps.gate.serverJamRemainingMs(sv) <= 0) return sv;
    if (home && !C.LOGIN_DESK_AVOID_SERVERS.has(home)) return home;
    return C.LOGIN_DESK_SERVERS[0] ?? "";
  }
  /** Where the desk bot is in game now, else where one would be woken: for the hub, which suggests it for meetings. */
  deskServerNow(): string | null {
    for (const guid of [this.loginBotGuid, this.loginDeskElected]) {
      const acc = guid ? this.pool.byGuid(guid) : undefined;
      if (acc && this.inWorld(acc) && !C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server)) return acc.client!.server;
    }
    return this.deskServerFor("") || null;
  }

  /**
   * Someone wants to log in by /tell (the site's login, the hub's sign-in):
   * staff the login desk and keep it a while after, when it is not kept on
   * anyway. The next supervise pass (two seconds at most) wakes a bot when
   * none is in game; the code goes out once one is.
   */
  requestLoginDesk(forMs = C.LOGIN_DESK_LINGER_S * 1000): void {
    this.loginDeskWantedUntil = Math.max(this.loginDeskWantedUntil, Date.now() + forMs);
    this.poke();
  }
  /** Whether a bot should be at the login desk now: kept on by the owner, a code waiting for its tell, or a login asked for lately. */
  private loginDeskWanted(now: number): boolean {
    if (this.loginDeskAlwaysOn()) return true;
    if (this.loginCodes.pendingCount() > 0) {
      // Each waiting code keeps it, and so does the linger after the last one (a retry, a second character).
      this.loginDeskWantedUntil = Math.max(this.loginDeskWantedUntil, now + C.LOGIN_DESK_LINGER_S * 1000);
      return true;
    }
    return now < this.loginDeskWantedUntil;
  }
  /** The login desk as the control panel shows it: kept on or on demand, wanted now (and until when), and the bot at it. */
  loginDeskStatus(): { alwaysOn: boolean; wanted: boolean; until: number | null; bot: string | null } {
    const now = Date.now();
    const alwaysOn = this.loginDeskAlwaysOn();
    const wanted = this.loginDeskWanted(now);
    const acc = this.loginBotGuid ? this.pool.byGuid(this.loginBotGuid) : undefined;
    const bot = acc && this.inWorld(acc) ? acc.client!.playerData.name || acc.alias : null;
    return { alwaysOn, wanted, until: wanted && !alwaysOn ? this.loginDeskWantedUntil : null, bot };
  }

  private maintainLoginBot(now: number): void {
    const canStaff = (acc: BotAccount) => this.inWorld(acc) && !C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server);
    // On demand (the default): nobody sits at the desk while nobody is logging in. The bot that did goes back to
    // the ordinary idle rule and logs out when it has nothing else to do.
    if (!this.loginDeskWanted(now)) {
      if (this.loginBotGuid) {
        const inc = this.pool.byGuid(this.loginBotGuid);
        this.log(`the login desk is not needed any more${inc ? `; ${inc.alias} may log out` : ""}`);
        this.loginBotGuid = null;
      }
      return;
    }
    if (this.loginBotGuid) {
      const inc = this.pool.byGuid(this.loginBotGuid);
      if (inc) {
        if (canStaff(inc)) return;
        if (this.inWorld(inc)) {
          this.log(`${inc.alias} left the login desk — now on ${inc.client?.server || "?"}`);
          this.loginBotGuid = null;
        }
      }
    }
    const already = this.online().filter(canStaff).sort((a, b) => Number(a.inUse) - Number(b.inUse));
    if (already.length) {
      this.loginBotGuid = already[0].guid;
      this.log(`${already[0].alias} adopted as the login desk on ${already[0].client?.server || "?"}`);
      return;
    }
    for (const sv of this.wakes.wakingServers().values()) if (!C.LOGIN_DESK_AVOID_SERVERS.has(sv)) return;
    if (this.wakeResults.some((r) => r.client && !C.LOGIN_DESK_AVOID_SERVERS.has(r.server))) return;
    // A bot that is connected but still loading its character will staff
    // the desk in a moment; waking a second one just puts two bots on the
    // same post.
    for (const acc of this.online()) {
      const c = acc.client!;
      if (c.objectId !== -1 || C.LOGIN_DESK_AVOID_SERVERS.has(c.server)) continue;
      const wokeAt = this.lastActive.get(acc.guid) ?? 0;
      if (wokeAt > 0 && now - wokeAt <= C.LOGIN_DESK_WARMUP_S * 1000) return;
    }
    // Nobody can be woken while logins are paused; say so at the same pace
    // the other wake paths do and come back next tick.
    const paused = this.deps.gate.pausedRemainingMs();
    if (paused > 0) {
      if (now - this.loginPauseNote >= 30_000) {
        this.loginPauseNote = now;
        this.log(`logins paused for another ${Math.floor(s(paused))}s — not waking anyone`);
      }
      return;
    }
    // Emptiest first. Accounts on a login cooldown are left out up front:
    // trying them one by one logged a skip line per account (thousands per
    // tick after a sweep) and sorted the whole roster with a per-compare
    // inventory sum.
    const free = this.offline()
      // A held account is somebody else's for now (a maintenance trip about to log it in).
      .filter((a) => !a.inUse && !this.isHeld(a.guid) && this.deps.gate.lockoutRemainingMs(a.guid) <= 0)
      .map((a) => [a, this.tracker.heldCount(a.botGuid)] as const)
      .sort((x, y) => x[1] - y[1]);
    // Pool accounts first: a communism account waits on its server for communism's deposits. But a node
    // with no pool account free (one with only communism accounts) must still sign people in.
    const candidates = [...free.filter(([a]) => !a.communism), ...free.filter(([a]) => a.communism)];
    for (const [acc] of candidates) {
      const server = this.loginDeskServer(acc);
      if (!server) return;
      if (this.wakeSpecificAccount(acc, server)) {
        this.loginBotGuid = acc.guid;
        const why = this.loginDeskAlwaysOn() ? "to keep the login desk staffed" : "for the login desk: someone is logging in";
        this.log(`woke ${acc.alias} on ${server} ${why}${acc.communism ? " (a communism account: no other account is free)" : ""}`);
        return;
      }
    }
    // Tried and could not wake one: the wake path says why.
    if (candidates.length) return;
    // Nobody to try. An account only sitting out a short login cooldown (the seconds after a sweep closes its
    // session) staffs the desk in a moment: nothing to say. Anything longer gets a line a minute.
    const cooldowns = this.offline()
      .filter((a) => !a.inUse && !this.isHeld(a.guid))
      .map((a) => this.deps.gate.lockoutRemainingMs(a.guid))
      // A suspension or a refused password reads as a year: that account is not coming.
      .filter((ms) => ms > 0 && ms < 24 * 3600 * 1000);
    const soonest = cooldowns.length ? Math.min(...cooldowns) : null;
    if (soonest !== null && soonest <= 60_000) return;
    if (now - this.loginDeskNoneNote < 60_000) return;
    this.loginDeskNoneNote = now;
    this.log(soonest !== null
      ? `the login desk is wanted, but every account that could staff it is on a login cooldown: the first is free in ${Math.ceil(s(soonest))}s`
      : `the login desk is wanted but no account can staff it: none of the ${this.pool.all().length} on the roster is free (online elsewhere, in use, held, suspended or its password refused)`);
  }

  /** The bot the site should name in "/tell <bot> <code>", or null. */
  electLoginBot(): { acc: BotAccount; ign: string } | null {
    const igns = this.tracker.ignsSnapshot();
    const tellName = (acc: BotAccount): string => {
      if (!this.inWorld(acc) || C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server)) return "";
      return acc.client!.playerData.name || igns[acc.botGuid] || "";
    };
    // The bot the desk keeps in game first: the one named in a code must still be there when the tell comes.
    for (const guid of [this.loginBotGuid, this.loginDeskElected]) {
      const inc = guid ? this.pool.byGuid(guid) : undefined;
      const name = inc ? tellName(inc) : "";
      if (inc && name) {
        this.loginDeskElected = inc.guid;
        return { acc: inc, ign: name };
      }
    }
    let chosen: { acc: BotAccount; ign: string } | null = null;
    for (const acc of this.accounts()) {
      const name = tellName(acc);
      if (!name) continue;
      if (!acc.inUse) {
        chosen = { acc, ign: name };
        break;
      }
      chosen ??= { acc, ign: name };
    }
    if (!chosen) return null;
    this.loginDeskElected = chosen.acc.guid;
    // Named in a code while the desk is wanted: it is the desk now, kept in game like one.
    if (!this.loginBotGuid && this.loginDeskWanted(Date.now())) this.loginBotGuid = chosen.acc.guid;
    this.deps.log(`[login] elected login-desk bot ${chosen.ign}`);
    return chosen;
  }

  /** Once pulled accounts from an onboarding service to keep free slots up; the roster is the owner's now, so there is nothing to pull. */
  private async maintainCapacity(): Promise<void> {}

  /** Free trade slots per pool across every usable account on the roster:
   *  tracked bots by capacity minus items held, never-tracked ones the
   *  conservative 8 — the same universe the site's capacity gate counts. */
  private freeSlotsByPool(): PoolRoom {
    // The whole roster's room, advanced sides too: it is what the site's "vault full" note and a deposit's
    // continuation read, and the old rule takes deposits again once no character is empty. (The biggest
    // deposit an advanced side takes now is largestFreeByPool's to say.)
    const free: PoolRoom = { seasonal: 0, nonseasonal: 0, communism: { seasonal: 0, nonseasonal: 0 } };
    for (const acc of this.accounts()) {
      // A communism account's deposits continue from one character of its side to the next: all of them are room.
      const room = acc.communism ? this.communismSideRoom(acc) : Math.max(0, this.tracker.capacityFor(acc.botGuid) - this.tracker.heldCount(acc.botGuid));
      (acc.communism ? free.communism! : free)[seasonalOf(acc) ? "seasonal" : "nonseasonal"] += room;
    }
    return free;
  }

  // --- potion consolidation --------------------------------------------------------

  /** The bots consolidation may touch, by botGuid. Cheap: no inventories. */
  private consolidationAccounts(): Map<string, BotAccount> {
    const suspended = this.pool.suspendedBotGuids();
    const fleet = new Map<string, BotAccount>();
    // Communism accounts hold communism: the potion planner never touches
    // them, as giver or taker.
    // Advanced management replaces this planner for its pools (advancedPlan.ts).
    for (const acc of this.accounts()) if (!suspended.has(acc.botGuid) && !acc.communism && !this.isAdvanced(acc)) fleet.set(acc.botGuid, acc);
    return fleet;
  }
  private consolidationFleet(fleet: Map<string, BotAccount>): { inventories: Inventories; caps: Record<string, number> } {
    // The planner reads inventories and copies before it subtracts, so the
    // tracker's own records are handed over rather than deep-copied per pass.
    const items = this.tracker.itemsView();
    const caps: Record<string, number> = {};
    const inventories: Inventories = {};
    for (const [g, acc] of fleet) {
      const inv = (items.get(g) ?? EMPTY_INVENTORY) as Record<string, number>;
      inventories[g] = inv;
      // An online bot's capacity is known for sure. An offline bot's comes
      // from the tracker, which char/list feeds at every login and the audit
      // seeds; a wrong 16 costs one wake (the live re-check abandons the move
      // and noteFull corrects the tracker), so 16-slot bots are planned at 16
      // even while asleep — that is what a backpack is for.
      const c = acc.client;
      if (c?.active && c.connected && c.objectId !== -1) caps[g] = this.botCapacity(c);
      else caps[g] = this.tracker.capacityFor(g);
    }
    return { inventories, caps };
  }
  /**
   * Lend an account to a maintenance routine (the storage chore): an idle
   * bot at the login desk is disconnected so the routine can log it in
   * itself; a bot in a trade or on an assignment is refused. The caller
   * holds the guid in maintenanceHolds first, so the supervisor does not
   * wake it back up meanwhile.
   */
  /** Drop an account the operator is removing: refuses one mid-trade or lent out; otherwise logs it out and forgets its sessions. */
  retireAccount(acc: BotAccount): { ok: true } | { ok: false; error: string } {
    if (acc.assignedRequestId !== null) return { ok: false, error: "it is in the middle of a trade; wait for it to finish or cancel the request" };
    if (acc.inUse || this.isHeld(acc.guid)) return { ok: false, error: "a maintenance run is using it; wait for the run to finish" };
    if (acc.client?.active) {
      this.log(`${acc.alias} is being removed from the roster — logging out`);
      this.disconnectAccount(acc, false);
    }
    this.sessions.delete(acc.guid);
    return { ok: true };
  }
  releaseForMaintenance(acc: BotAccount): boolean {
    if (!acc.client?.active) return true;
    if (acc.assignedRequestId !== null || acc.inUse || !(this.sessionFor(acc)?.isIdle() ?? true)) return false;
    this.log(`${acc.alias} lent to maintenance — disconnecting from the desk`);
    this.disconnectAccount(acc, false);
    return true;
  }
  private readyToTrade(acc: BotAccount): boolean {
    const c = acc.client;
    if (!c || !c.active || !c.isReady || !c.connected || c.objectId === -1 || !c.playerData.name) return false;
    if (!this.inNexusNow(acc, c) || acc.assignedRequestId !== null) return false;
    return this.sessionFor(acc)?.isIdle() ?? true;
  }
  private consolidationServerFor(giver: BotAccount, taker: BotAccount): string {
    for (const a of [taker, giver]) if (a.client?.active && a.client.server) return a.client.server;
    for (const a of [taker, giver]) if (a.info.server) return a.info.server;
    return "";
  }
  private neededByPlayers(acc: BotAccount): boolean {
    if (!this.lastWantedServers.size) return false;
    if (Date.now() - this.lastWantedAt > 30_000) return true;
    const server = acc.client?.active ? acc.client.server : acc.info.server ?? "";
    if (!this.lastWantedServers.has(server)) return false;
    const r = this.lastRouting.get(server);
    return r ? this.accountCanFulfill(acc, r, this.lastBotStates) : false;
  }
  /** A pending withdraw (on any server) can be served by this bot: leave it alone. */
  private withdrawCandidate(botGuid: string): boolean {
    for (const r of this.lastRouting.values()) for (const w of r.withdraws) if (w.candidateBots.includes(botGuid)) return true;
    return false;
  }
  private consolidationWakeAllowed(): boolean {
    return this.onlineCap() - this.wakes.globalOnline() > C.CONSOLIDATION_WAKE_RESERVE;
  }
  private busyWithConsolidation(): Set<string> {
    const out = new Set<string>();
    for (const m of this.pendingMoves) {
      out.add(m.giver);
      out.add(m.taker);
    }
    return out;
  }
  private releaseMove(move: PendingMove, reason = "", blame: Iterable<string> = []): void {
    this.pendingMoves = this.pendingMoves.filter((m) => m !== move);
    this.consolidationHolds = new Set(this.pendingMoves.flatMap((m) => [...m.holdGuids]));
    if (reason) {
      this.log(`consolidation move abandoned (${reason})`);
      this.consolidationStats.abandoned++;
    }
    const until = Date.now() + C.CONSOLIDATION_RETRY_BACKOFF_S * 1000;
    for (const g of blame) this.moveBackoff.set(g, until);
  }
  private releaseMovesFor(guid: string, reason: string): void {
    for (const m of [...this.pendingMoves]) if (m.holdGuids.has(guid)) this.releaseMove(m, reason, [guid]);
  }

  /** Items pending withdraws count on (never moved), and withdraws nobody can serve (demand), per pool. */
  private withdrawPressure(fleet: Map<string, BotAccount>): { reserved: Inventories; demand: Map<boolean, Demand[]> } {
    const reserved: Inventories = {};
    const demand = new Map<boolean, Demand[]>([[true, []], [false, []]]);
    // Instances the site has spoken for (posted offers, picks, hand-overs) stay where they are.
    for (const id of this.reserved()) {
      const g = this.tracker.holderOf(id);
      if (!g) continue;
      const inst = Object.values(this.tracker.instancesView().get(g) ?? {}).find((i) => i.instanceId === id);
      if (!inst) continue;
      const inv = (reserved[g] ??= {});
      inv[inst.itemId] = (inv[inst.itemId] ?? 0) + 1;
    }
    for (const r of this.lastRouting.values()) {
      for (const w of r.withdraws) {
        if (w.candidateBots.length) {
          for (const g of w.candidateBots) {
            const inv = (reserved[g] ??= {});
            for (const it of w.items) inv[it.itemId] = (inv[it.itemId] ?? 0) + it.qty;
          }
          continue;
        }
        // Picked physical items can't be re-created by moving them.
        if (w.perInstance) continue;
        const target = w.targetBotGuid && fleet.has(w.targetBotGuid) ? w.targetBotGuid : null;
        const items: Record<string, number> = {};
        for (const it of w.items) items[it.itemId] = (items[it.itemId] ?? 0) + it.qty;
        demand.get(w.seasonal)?.push({ items, target });
      }
    }
    return { reserved, demand };
  }

  /** Where a deposit of each bucket should land: its collectors, else whoever holds most of it. */
  private homesFor(inventories: Inventories, guids: Set<string>, collectors: Record<string, string[]>, split: Set<string>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [b, gs] of Object.entries(collectors)) out[b] = [...gs];
    const counts = new Map<string, Record<string, number>>();
    for (const g of guids) counts.set(g, bucketCounts(inventories[g] ?? {}, split));
    const buckets = new Set<string>();
    for (const c of counts.values()) for (const b of Object.keys(c)) buckets.add(b);
    for (const b of buckets) {
      if (out[b]) continue;
      out[b] = [...guids].filter((g) => (counts.get(g)?.[b] ?? 0) > 0).sort((x, y) => (counts.get(y)![b] ?? 0) - (counts.get(x)![b] ?? 0) || (x < y ? -1 : 1));
    }
    return out;
  }
  /**
   * A bot turned out to have less room live than the tracker thought: bring
   * the tracker up to date from its live inventory, and keep it out of
   * planning for a while — a full bot does not gain room by itself, and the
   * plan/wake/abandon cycle every backoff was pure login churn (2026-09-07,
   * a full bot woken every 80 s).
   */
  private noteFull(acc: BotAccount, now: number): void {
    if (acc.client) this.refreshInventory(acc, acc.client);
    this.moveBackoff.set(acc.guid, now + C.CONSOLIDATION_FULL_BACKOFF_S * 1000);
  }
  private trackedFree(acc: BotAccount): number {
    const st = this.lastBotStates.get(acc.botGuid);
    if (st) return st.freeSlots;
    return Math.max(0, this.tracker.capacityFor(acc.botGuid) - this.tracker.heldCount(acc.botGuid));
  }
  /** The bot a hinted deposit should land on: gathers its main bucket and has room. */
  private depositHome(d: RoutedDeposit): BotAccount | null {
    if (!d.items?.length || !C.CONSOLIDATION_ENABLED) return null;
    const split = this.consolidationSplit.get(d.seasonal) ?? new Set<string>();
    const weight: Record<string, number> = {};
    for (const it of d.items) {
      const b = bucketOf(it.itemId, split);
      if (b) weight[b] = (weight[b] ?? 0) + it.qty;
    }
    const main = Object.entries(weight).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (!main) return null;
    const suspended = this.pool.suspendedBotGuids();
    for (const g of this.bucketHomes.get(d.seasonal)?.[main[0]] ?? []) {
      if (suspended.has(g)) continue;
      const acc = this.accounts().find((a) => a.botGuid === g);
      if (acc && seasonalOf(acc) === d.seasonal && this.trackedFree(acc) >= 1) return acc;
    }
    return null;
  }
  /** A pending hinted deposit on this bot's server whose home is this bot. */
  private depositRoutedTo(acc: BotAccount, client: GameClient): RoutedDeposit | null {
    if (!C.CONSOLIDATION_ENABLED || !client.server) return null;
    for (const d of this.lastRouting.get(client.server)?.deposits ?? []) {
      if (d.seasonal !== seasonalOf(acc) || !d.items?.length) continue;
      if (this.depositHome(d)?.guid === acc.guid) return d;
    }
    return null;
  }
  /** The oldest deposit this bot would otherwise claim is hinted, and its home is idle on this server. */
  private depositHomeOnlineHere(acc: BotAccount, client: GameClient): BotAccount | null {
    if (!C.CONSOLIDATION_ENABLED || !client.server) return null;
    const next = (this.lastRouting.get(client.server)?.deposits ?? []).find((d) => !d.communism && d.seasonal === seasonalOf(acc));
    if (!next?.items?.length) return null;
    const home = this.depositHome(next);
    if (!home || home.guid === acc.guid) return null;
    const hc = home.client;
    if (!hc || !hc.active || !hc.isReady || hc.server !== client.server || hc.objectId === -1 || home.assignedRequestId !== null) return null;
    return this.countFreeSlots(hc) >= 1 ? home : null;
  }

  private noteFragmentation(want: boolean, frag: Fragmentation, bots: number, now: number): void {
    this.lastFragmentation.set(want, frag);
    const prev = this.lastFragmentationLog.get(want);
    if (prev && Math.abs(prev[0] - frag.score) < 0.02 && now - prev[1] < C.CONSOLIDATION_METRICS_LOG_S * 1000) return;
    this.lastFragmentationLog.set(want, [frag.score, now]);
    const trades = Object.entries(frag.tradesFor16).map(([st, n]) => `${st} ${n === null ? "-" : n}`).join(" ");
    const holders = Object.values(frag.buckets).reduce((a, b) => a + b.holders, 0);
    const ideal = Object.values(frag.buckets).reduce((a, b) => a + b.ideal, 0);
    this.log(`consolidation ${want ? "seasonal" : "non-seasonal"}: spread ${frag.score.toFixed(2)} — ${frag.items} items (${frag.potions} potions) on ${bots} bots, ${frag.emptyBots} empty of ${frag.couldBeEmpty} possible (${holders} bucket-holders, ${ideal} needed); trades per 16-point withdraw: ${trades}`);
  }

  private maybeConsolidate(now: number): void {
    const fleet = this.consolidationAccounts();
    for (const m of [...this.pendingMoves]) if (!m.advanced) this.driveMove(m, now, fleet);
    // Everything below walks the whole pool (thousands of bots): once per
    // interval, not per tick. Moves take minutes to set up anyway.
    if (now - this.lastConsolidation < C.CONSOLIDATION_INTERVAL_S * 1000) return;
    this.lastConsolidation = now;
    const { inventories, caps } = this.consolidationFleet(fleet);
    const byPool = new Map<boolean, Set<string>>([[true, new Set()], [false, new Set()]]);
    for (const [g, acc] of fleet) byPool.get(seasonalOf(acc))!.add(g);
    const online = new Set<string>();
    const servers: Record<string, string> = {};
    for (const [g, acc] of fleet) {
      if (this.inWorld(acc)) online.add(g);
      const sv = acc.client?.active ? acc.client.server : acc.info.server ?? "";
      if (sv) servers[g] = sv;
    }
    const targets = new Set<string>();
    for (const [want, guids] of byPool) {
      const pool: Inventories = {};
      for (const g of guids) pool[g] = inventories[g];
      const split = splitStats(pool, { mode: C.CONSOLIDATION_SPLIT_GREATERS });
      const roles = electRoles(pool, { split, previous: this.consolidationRoles.get(want), hysteresis: C.CONSOLIDATION_ROLE_HYSTERESIS });
      this.consolidationRoles.set(want, roles);
      this.consolidationSplit.set(want, split);
      const ct = collectionTargets(inventories, { eligible: guids, capacities: caps, split, roles });
      this.collectorsByBucket.set(want, ct);
      for (const gs of Object.values(ct)) for (const g of gs) targets.add(g);
      this.bucketHomes.set(want, this.homesFor(inventories, guids, ct, split));
      if (guids.size) this.noteFragmentation(want, fragmentation(inventories, { eligible: guids, capacities: caps, split }), guids.size, now);
    }
    this.collectionTargets = targets;
    if (this.pendingMoves.length >= C.CONSOLIDATION_MAX_CONCURRENT || this.hold.active) return;
    if (fleet.size < 2) return;
    const committed = this.busyWithConsolidation();
    const usable = new Set<string>();
    for (const [g, acc] of fleet) {
      if (committed.has(g) || acc.assignedRequestId !== null || acc.guid === this.loginBotGuid) continue;
      if (this.neededByPlayers(acc) || this.withdrawCandidate(g) || this.loginBlockedMs(acc) > 0 || (this.moveBackoff.get(acc.guid) ?? 0) > now) continue;
      usable.add(g);
    }
    if (usable.size < 2) return;
    const { reserved, demand } = this.withdrawPressure(fleet);
    const room = C.CONSOLIDATION_MAX_CONCURRENT - this.pendingMoves.length;
    this.consolidationPoolTurn = !this.consolidationPoolTurn;
    const order = this.consolidationPoolTurn ? [true, false] : [false, true];
    let moves: Move[] = [];
    for (const want of order) {
      if (moves.length >= room) break;
      const poolUsable = new Set([...usable].filter((g) => byPool.get(want)!.has(g)));
      if (poolUsable.size < 2) continue;
      moves = moves.concat(planMoves(inventories, caps, {
        eligible: poolUsable, online, servers, reserved, demand: demand.get(want), roles: this.consolidationRoles.get(want),
        maxMoves: room - moves.length, allowSwaps: C.CONSOLIDATION_SWAPS, minScore: C.CONSOLIDATION_MIN_SCORE,
        weights: { wake: C.CONSOLIDATION_WAKE_COST, hop: C.CONSOLIDATION_HOP_COST },
        splitGreaters: C.CONSOLIDATION_SPLIT_GREATERS, hysteresis: C.CONSOLIDATION_ROLE_HYSTERESIS,
      }));
    }
    this.lastPlan = moves;
    const toList = (inv: Record<string, number> | undefined) => Object.entries(inv ?? {}).sort().map(([itemId, qty]) => ({ itemId, qty }));
    for (const move of moves) {
      const giver = fleet.get(move.giver)!;
      const taker = fleet.get(move.taker)!;
      const server = this.consolidationServerFor(giver, taker);
      if (!server) continue;
      if ((!giver.online || !taker.online) && !this.consolidationWakeAllowed()) continue;
      const pending: PendingMove = {
        giver: move.giver, taker: move.taker, items: toList(move.items), swapItems: toList(move.swapItems),
        stat: move.stat, kind: move.kind, score: move.score, reason: move.reason, server, since: now, readySince: null,
        holdGuids: new Set([giver.guid, taker.guid]), woken: new Set(), hopped: new Set(),
      };
      this.pendingMoves.push(pending);
      for (const g of pending.holdGuids) this.consolidationHolds.add(g);
      this.consolidationStats.planned++;
      if (move.kind === "swap") this.consolidationStats.swaps++;
      const back = pending.swapItems.reduce((a, i) => a + i.qty, 0);
      this.log(`consolidation planned — ${seasonalOf(taker) ? "seasonal" : "non-seasonal"} ${move.kind} ${move.stat} ${giver.alias} -> ${taker.alias}${back ? ` (+${back} back)` : ""} on ${server} [${move.score.toFixed(1)}: ${move.reason}]`);
      this.driveMove(pending, now, fleet);
    }
  }

  private driveMove(move: PendingMove, now: number, fleet: Map<string, BotAccount>): void {
    if (!this.pendingMoves.includes(move)) return;
    const deadline = move.since + C.CONSOLIDATION_SETUP_TIMEOUT_S * 1000;
    if (now > deadline) {
      this.releaseMove(move, "timed out waiting for both bots", move.holdGuids);
      return;
    }
    const giver = fleet.get(move.giver);
    const taker = fleet.get(move.taker);
    if (!giver || !taker) {
      this.releaseMove(move, "a bot left the pool");
      return;
    }
    if (giver.assignedRequestId !== null || taker.assignedRequestId !== null) {
      this.releaseMove(move, "a bot was claimed for player work");
      return;
    }
    // Advanced: players first — a bot a pending request needs is let go before the trade starts, and a
    // woken pair still coming up gives way to any player request (its logins would take their slots).
    if (move.advanced) {
      const needed = [giver, taker].find((a) => this.neededByPlayers(a) || this.withdrawsCountOn(a.botGuid));
      if (needed) {
        this.releaseMove(move, `${needed.alias} is needed for a player's request`);
        return;
      }
      if (move.advanced.quiet && this.advancedRowsWaiting() > 0 && !(this.inWorld(giver) && this.inWorld(taker))) {
        this.releaseMove(move, "a player's request came in before the pair was up");
        return;
      }
      // A pair planned online never logs anyone in; a bot a maintenance job has borrowed is not woken.
      const gone = [giver, taker].find((a) => !a.online && (!move.advanced!.quiet || a.inUse || this.maintenanceHolds.has(a.guid)));
      if (gone) {
        this.releaseMove(move, `${gone.alias} is not online for it`);
        return;
      }
    }
    for (const acc of [taker, giver]) {
      const client = acc.client;
      const online = !!client && client.active;
      if (online && client!.server && client!.server !== move.server) {
        // An idle bot parked on another server can be brought over: drop it
        // here and the wake below logs it in where the move is. Once only,
        // and never the login desk's bot.
        const pinned = acc.guid === this.loginBotGuid;
        if (pinned || move.hopped.has(acc.guid) || !this.sessionFor(acc)?.isIdle()) {
          this.releaseMove(move, `${acc.alias} is on ${client!.server}, not ${move.server}`, [acc.guid]);
          return;
        }
        move.hopped.add(acc.guid);
        this.log(`${acc.alias} is on ${client!.server}; bringing it to ${move.server} for a consolidation`);
        this.disconnectAccount(acc, true, true);
        return;
      }
      if (!online) {
        const blocked = this.loginBlockedMs(acc);
        if (blocked > 0) {
          // A short lockout (the reconnect grace after a hop) is worth waiting out.
          if (now + blocked < deadline) return;
          this.releaseMove(move, `${acc.alias} can't log in for another ${Math.floor(s(blocked))}s`, [acc.guid]);
          return;
        }
        if (move.woken.has(acc.guid)) continue;
        // A woken pair checked for room for both and the players' reserve when it was planned: the second login only needs a slot.
        if (!(move.advanced ? this.onlineCap() - this.wakes.globalOnline() >= 1 : this.consolidationWakeAllowed())) return;
        if (this.wakeSpecificAccount(acc, move.server)) move.woken.add(acc.guid);
        return;
      }
    }
    if (move.advanced && !this.prepareAdvancedMove(move, giver, taker)) {
      move.readySince = null;
      return;
    }
    if (!(this.readyToTrade(giver) && this.readyToTrade(taker))) {
      move.readySince = null;
      return;
    }
    if (move.readySince === null) move.readySince = now;
    const waited = now - move.readySince;
    if (waited < C.CONSOLIDATION_PAIR_SETTLE_S * 1000) return;
    // The move was planned from the tracker's persisted view; both bots are
    // online now, so trust their live inventories: room on each receiving
    // side net of what it gives away, and the items still where they were.
    const give = move.items.reduce((a, i) => a + i.qty, 0);
    const back = move.swapItems.reduce((a, i) => a + i.qty, 0);
    const takerRoom = this.countFreeSlots(taker.client!);
    const giverRoom = this.countFreeSlots(giver.client!);
    if (takerRoom < give - back) {
      this.releaseMove(move, `${taker.alias} has ${takerRoom} free slot(s), move needs ${give - back}`, [taker.guid]);
      this.noteFull(taker, now);
      return;
    }
    if (giverRoom < back - give) {
      this.releaseMove(move, `${giver.alias} has ${giverRoom} free slot(s), the swap sends it ${back - give} net`, [giver.guid]);
      this.noteFull(giver, now);
      return;
    }
    const holds = (acc: BotAccount, items: ItemQty[]) => {
      const inv = this.tracker.itemsFor(acc.botGuid);
      return items.every((it) => (inv[it.itemId] ?? 0) >= it.qty);
    };
    if (move.advanced ? !move.advanced.instanceIds.every((id) => this.tracker.holderOf(id) === giver.botGuid) : !holds(giver, move.items)) {
      this.releaseMove(move, `${giver.alias} no longer holds what it was to give`, [giver.guid]);
      return;
    }
    if (back && !holds(taker, move.swapItems)) {
      this.releaseMove(move, `${taker.alias} no longer holds its side of the swap`, [taker.guid]);
      return;
    }
    this.consolidationSeq--;
    const pairId = this.consolidationSeq;
    this.consolidationPairs.set(pairId, { giver: giver.botGuid, taker: taker.botGuid, ...(move.advanced ? { advanced: move.advanced.why } : {}) });
    for (const id of [...this.consolidationPairs.keys()]) if (id > pairId + 200) this.consolidationPairs.delete(id);
    const giverIgn = giver.client!.playerData.name;
    const takerIgn = taker.client!.playerData.name;
    this.assignConsolidation(taker, "consolidate_take", pairId, giverIgn, move.items, move.swapItems);
    this.assignConsolidation(giver, "consolidate_give", pairId, takerIgn, move.items, move.swapItems, move.advanced?.instanceIds ?? null);
    // The physical items carry their ids across (advanced moves name them); the planner's by-count moves by type.
    if (move.advanced) this.tracker.noteTransferInstances(giver.botGuid, taker.botGuid, move.advanced.instanceIds);
    else this.tracker.noteTransfer(giver.botGuid, taker.botGuid, move.items);
    if (move.swapItems.length) this.tracker.noteTransfer(taker.botGuid, giver.botGuid, move.swapItems);
    this.log(`consolidating ${move.kind} ${move.stat} — ${giver.alias} -> ${taker.alias} (${give} items${back ? `, ${back} back` : ""}, both in nexus ${Math.floor(s(waited))}s)`);
    if (!this.sessionFor(giver)?.sendTradeRequest()) this.log(`${giver.alias} consolidation request deferred (trade machine busy)`);
    this.releaseMove(move);
  }

  private assignConsolidation(acc: BotAccount, kind: "consolidate_give" | "consolidate_take", pairId: number, partnerIgn: string, items: ItemQty[], swapItems: ItemQty[], instanceIds: string[] | null = null): void {
    acc.assignedRequestId = pairId;
    acc.assignedKind = kind;
    acc.assignedPartnerIgn = partnerIgn;
    this.lastActive.set(acc.guid, Date.now());
    const itemCount = items.reduce((a, i) => a + i.qty, 0) + swapItems.reduce((a, i) => a + i.qty, 0);
    this.sessionFor(acc)?.setAssignment({ kind, requestId: pairId, partnerIgn, items, itemCount, instanceIds, swapItems: swapItems.length ? swapItems : null });
  }

  /** How consolidated the pool is and what the planner is doing, for the control plane. */
  consolidationStatus(): ConsolidationStatus {
    const alias = (g: string) => this.accounts().find((a) => a.botGuid === g)?.alias ?? g.slice(0, 8);
    const list = (items: ItemQty[]) => Object.fromEntries(items.map((i) => [i.itemId, i.qty]));
    const now = Date.now();
    return {
      enabled: C.CONSOLIDATION_ENABLED,
      swaps: C.CONSOLIDATION_SWAPS,
      maxPairs: C.CONSOLIDATION_MAX_CONCURRENT,
      pools: [true, false].map((seasonal) => ({
        seasonal,
        fragmentation: this.lastFragmentation.get(seasonal) ?? null,
        collectors: Object.fromEntries(Object.entries(this.collectorsByBucket.get(seasonal) ?? {}).map(([b, gs]) => [b, gs.map(alias)])),
        roles: Object.fromEntries(Object.entries(this.consolidationRoles.get(seasonal) ?? {}).map(([g, b]) => [alias(g), b])),
        split: [...(this.consolidationSplit.get(seasonal) ?? [])],
      })),
      pending: this.pendingMoves.map((m) => ({
        giver: alias(m.giver), taker: alias(m.taker), kind: m.kind, stat: m.stat, items: list(m.items), swapItems: list(m.swapItems),
        server: m.server, ageS: Math.floor(s(now - m.since)), readyS: m.readySince === null ? null : Math.floor(s(now - m.readySince)), score: m.score, reason: m.reason,
      })),
      lastPlan: this.lastPlan.map((m) => ({ giver: alias(m.giver), taker: alias(m.taker), kind: m.kind, stat: m.stat, items: m.items, swapItems: m.swapItems ?? {}, score: m.score, reason: m.reason })),
      stats: { ...this.consolidationStats },
    };
  }

  // --- advanced management (docs/relay/ADVANCED.md) ---------------------------------
  //
  // Every account decides by its own pool's switch (isAdvanced). With both
  // switches off nothing below runs and every path above behaves as before.

  private intakeKey(communism: boolean, seasonal: boolean): string {
    return `${communism ? "c" : "p"}|${seasonal ? "s" : "n"}`;
  }
  /**
   * Intake on this pool side follows the advanced rule: the pool's switch is
   * on and some character on the side holds nothing. With none left anywhere
   * the side takes deposits the old way until banking or compaction frees one.
   */
  private emptyIntake(communism: boolean, seasonal: boolean): boolean {
    if (!advancedFor(this.advancedSettings(), communism)) return false;
    const key = this.intakeKey(communism, seasonal);
    return (this.intake.get(key)?.empties ?? 0) > 0 && !this.intakeStuck.has(key);
  }
  /** The account's living characters as storage knows them, the one in game read from the live client. Without storage's view, the tracker's character. */
  private charsOf(acc: BotAccount): { id: number; seasonal: boolean; login: boolean; held: number; capacity: number }[] {
    const known = this.storageDesk?.chars(acc.botGuid) ?? [];
    const c = acc.client;
    const live = c && this.inWorld(acc) && c.playerData.enchantmentsSeen ? c : null;
    const chars = known.length ? known : [{ id: -1, seasonal: seasonalOf(acc), login: true, held: this.tracker.heldCount(acc.botGuid), capacity: this.tracker.capacityFor(acc.botGuid) }];
    if (!live) return chars;
    const cap = this.botCapacity(live);
    const held = cap - this.countFreeSlots(live);
    return chars.map((ch) => (ch.id === live.charId || (ch.id === -1 && ch.login) ? { ...ch, held, capacity: cap } : ch));
  }
  /** The character the account plays now, or logs in as next (null: its first one). A preference for a character that is gone does not count. */
  private nextCharId(acc: BotAccount): number | null {
    const c = acc.client;
    if (c && this.inWorld(acc)) return c.charId;
    const pref = acc.info.charId;
    const living = this.storageDesk?.chars(acc.botGuid) ?? [];
    if (pref != null && (!living.length || living.some((ch) => ch.id === pref))) return pref;
    return this.storageDesk?.loginChar(acc.botGuid) ?? null;
  }
  /**
   * The characters of `side` holding nothing; `next`: the one it plays or logs
   * in as. Either side, a communism account's too: under advanced management
   * it takes deposits for the other side by logging in as one of these
   * (wakeEmptyFor ranks that crossing after the accounts already on the side).
   */
  private emptyCharsOf(acc: BotAccount, side: boolean): { id: number; capacity: number; next: boolean }[] {
    const nextId = this.nextCharId(acc);
    return this.charsOf(acc)
      .filter((c) => c.seasonal === side && c.held === 0 && c.capacity > 0)
      .map((c) => ({ id: c.id, capacity: c.capacity, next: c.id === -1 || c.id === nextId || (nextId === null && c.login) }));
  }
  /** The account's next session starts on an empty character of `side`: the one it plays (live) or logs in as. */
  private nextCharEmpty(acc: BotAccount, side: boolean): boolean {
    return this.emptyCharsOf(acc, side).some((c) => c.next);
  }
  /**
   * An empty character of `side` the account can switch to for intake: the
   * smallest that takes `need` items whole, else the biggest. Not the one it
   * plays, and not while open withdraws need the character holding their items.
   */
  private emptyCharToRotate(acc: BotAccount, side: boolean, need: number): { id: number; free: number; held: number } | null {
    if (!this.storageDesk || this.pinnedAccounts.has(acc.botGuid)) return null;
    const empties = this.emptyCharsOf(acc, side).filter((c) => !c.next && c.id !== -1);
    if (!empties.length) return null;
    const whole = empties.filter((c) => c.capacity >= need).sort((a, b) => a.capacity - b.capacity || a.id - b.id);
    const pick = whole[0] ?? [...empties].sort((a, b) => b.capacity - a.capacity || a.id - b.id)[0];
    return { id: pick.id, free: pick.capacity, held: 0 };
  }
  /** Potions the account keeps anywhere (its character, its storage): the warehouse tie-break. Counted once per supervise pass. */
  private potionsOf(acc: BotAccount): number {
    const hit = this.potionsHeld.get(acc.botGuid);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const [id, q] of Object.entries(this.tracker.itemsFor(acc.botGuid))) if (POTION_INFO[id]) n += q;
    for (const st of this.storageDesk?.stored(acc.botGuid) ?? []) if (POTION_INFO[st.itemId]) n++;
    this.potionsHeld.set(acc.botGuid, n);
    return n;
  }
  /**
   * In the Nexus, for trading. An advanced bot may wait in its Vault: it is
   * there only once it has arrived (the gameId flips the moment ESCAPE goes out,
   * and a trade asked for before the map streams in is lost).
   */
  private inNexusNow(acc: BotAccount, client: GameClient): boolean {
    return this.isAdvanced(acc) ? client.inNexus() : client.gameIdValue === GameId.nexus;
  }
  /** Send an advanced bot to the Nexus, retrying ESCAPE until it arrives; others the old way. */
  private toNexus(acc: BotAccount, client: GameClient): void {
    if (this.isAdvanced(acc)) client.escapeToNexus();
    else client.nexus();
  }
  /** One character's worth of the side's vault kept free on an account with several characters (compaction moves through it); none with one character. */
  private transitReserve(acc: BotAccount, side: boolean): number {
    const chars = this.charsOf(acc).filter((c) => c.seasonal === side);
    return chars.length >= 2 ? Math.max(...chars.map((c) => c.capacity)) : 0;
  }
  /** Vault slots of the side free past the transit reserve; null when the vault was never seen (a trip finds out). */
  private bankRoom(acc: BotAccount, side: boolean): number | null {
    const v = this.storageDesk?.vaultRoom?.(acc.botGuid, side);
    if (!v) return null;
    return Math.max(0, v.free - this.transitReserve(acc, side));
  }
  /** An open withdraw (head or next row) targets this account, lists it as a candidate or fetches from it: its items stay where they are. */
  private withdrawsCountOn(botGuid: string): boolean {
    return this.withdrawAccounts().has(botGuid);
  }
  private withdrawAccounts(): Set<string> {
    if (this.withdrawAccountsCache) return this.withdrawAccountsCache;
    const out = new Set<string>();
    for (const r of this.lastRouting.values()) {
      for (const w of [...r.withdraws, ...(r.upcoming ?? [])]) {
        if (w.targetBotGuid) out.add(w.targetBotGuid);
        for (const g of w.candidateBots) out.add(g);
        if (w.fetchFrom) out.add(w.fetchFrom.botGuid);
      }
    }
    return (this.withdrawAccountsCache = out);
  }

  /**
   * Per pool side, the empty characters intake can use (each supervise pass),
   * and a fresh potion count. Only ones a session could take a deposit into:
   * not on an account locked out for long (bad credentials, a long cooldown)
   * or suspended, nor a character an account pinned by an open withdraw could
   * not switch to.
   */
  private rebuildAdvancedState(): void {
    this.intake.clear();
    this.potionsHeld.clear();
    this.oneCharGroups.clear();
    const a = this.advancedSettings();
    if (!a.pool && !a.communism) return;
    for (const acc of this.accounts()) {
      if (!advancedFor(a, acc.communism) || acc.suspended || this.deps.gate.isRetired(acc.guid)) continue;
      const lockout = acc.online ? 0 : this.deps.gate.lockoutRemainingMs(acc.guid);
      if (lockout >= C.ADV_UNUSABLE_LOCKOUT_S * 1000) continue;
      const coming = !acc.online && lockout <= 0 && !this.isHeld(acc.guid) && !acc.inUse;
      const chars = this.charsOf(acc);
      const mine = chars.filter((ch) => ch.seasonal === seasonalOf(acc));
      if (mine.length === 1) {
        const key = `${acc.communism ? "communism" : "pool"}|${seasonalOf(acc) ? "seasonal" : "nonseasonal"}`;
        const g = this.oneCharGroups.get(key) ?? { n: 0, empty: 0 };
        g.n++;
        if (mine[0].held === 0) g.empty++;
        this.oneCharGroups.set(key, g);
      }
      for (const ch of this.emptyCharsOf(acc, true).concat(this.emptyCharsOf(acc, false))) {
        if (!ch.next && (ch.id === -1 || this.pinnedAccounts.has(acc.botGuid))) continue;
        const seasonal = chars.find((x) => x.id === ch.id)?.seasonal ?? seasonalOf(acc);
        const key = this.intakeKey(acc.communism, seasonal);
        const side = this.intake.get(key) ?? { empties: 0, room: 0, largest: 0, offline: 0 };
        side.empties++;
        side.room += ch.capacity;
        side.largest = Math.max(side.largest, ch.capacity);
        if (coming) side.offline++;
        this.intake.set(key, side);
      }
    }
  }
  /**
   * The backstop for empty-only intake: a deposit on an advanced side that no
   * empty character has taken within ADV_INTAKE_FALLBACK_S puts its side back
   * on the old rule (any bot with room) until it is claimed.
   */
  private noteStuckDeposits(routing: Routing, now: number): void {
    const pending = new Set<number>();
    this.intakeStuck.clear();
    for (const r of routing.values()) {
      for (const d of r.deposits) {
        if (!advancedFor(this.advancedSettings(), d.communism)) continue;
        pending.add(d.requestId);
        const since = this.depositSeenAt.get(d.requestId) ?? now;
        this.depositSeenAt.set(d.requestId, since);
        if (now - since < C.ADV_INTAKE_FALLBACK_S * 1000) continue;
        const key = this.intakeKey(d.communism, d.seasonal);
        if (!this.intakeStuck.has(key)) this.log(`deposit #${d.requestId} has waited ${Math.floor(s(now - since))}s for an empty character — ${d.seasonal ? "seasonal" : "non-seasonal"}${d.communism ? " communism" : ""} intake takes it the old way`);
        this.intakeStuck.add(key);
      }
    }
    for (const id of [...this.depositSeenAt.keys()]) if (!pending.has(id)) this.depositSeenAt.delete(id);
  }

  /**
   * Put the played character's items in the vault on the live client, when
   * it holds something and the vault has room past its transit reserve.
   * `park`: the linger — walk into the Vault even with nothing to put away,
   * where an idle bot waits for its next piece of work. The account is held
   * for the trip (no claims, no idle logout). True when a trip started.
   */
  private startBank(acc: BotAccount, client: GameClient, why: string, park = false): boolean {
    const desk = this.storageDesk;
    if (!desk?.bankOnline || !this.isAdvanced(acc)) return false;
    if (acc.assignedRequestId !== null || acc.inUse || this.isHeld(acc.guid) || this.onlineTrips.has(acc.guid)) return false;
    if (!this.inWorld(acc) || !client.playerData.enchantmentsSeen || !(this.sessionFor(acc)?.isIdle() ?? true)) return false;
    // Its items are about to be traded away (or fetched for): they stay where the withdraw expects them.
    if (this.withdrawsCountOn(acc.botGuid)) return false;
    const now = Date.now();
    const side = client.charSeasonal ?? seasonalOf(acc);
    const held = this.botCapacity(client) - this.countFreeSlots(client);
    const room = this.bankRoom(acc, side);
    const bank = held > 0 && (this.bankBackoff.get(acc.guid) ?? 0) <= now && (room === null || room > 0);
    if (!bank && (!park || client.inVault() || (this.parkBackoff.get(acc.guid) ?? 0) > now)) return false;
    // Something else has the account's session (another trip, a storage run, a character being made): not now, and not every pass.
    const blocked = desk.liveBlocked?.(acc, client) ?? null;
    if (blocked) {
      this.bankBackoff.set(acc.guid, now + C.ADV_BUSY_BACKOFF_S * 1000);
      this.parkBackoff.set(acc.guid, now + C.ADV_BUSY_BACKOFF_S * 1000);
      return false;
    }
    const o = { keep: new Set(this.reserved()), reserveSlots: this.transitReserve(acc, side), park: park || !bank, why };
    this.onlineTrips.add(acc.guid);
    this.maintenanceHolds.add(acc.guid);
    this.log(`${acc.alias} ${bank ? `banking the ${held} item(s) on its character` : "going to wait in its Vault"} (${why})`);
    let ran = true;
    void desk.bankOnline(acc, client, o)
      .then((r) => {
        if (r.busy) {
          ran = false;
          this.bankBackoff.set(acc.guid, Date.now() + C.ADV_BUSY_BACKOFF_S * 1000);
          this.parkBackoff.set(acc.guid, Date.now() + C.ADV_BUSY_BACKOFF_S * 1000);
          return;
        }
        if (r.ok && bank) {
          this.advancedCounts.banks++;
          this.advancedCounts.banked += r.moved;
        } else if (r.ok) this.advancedCounts.parks++;
        if (bank && (!r.ok || r.left > 0 || r.vaultFull)) this.bankBackoff.set(acc.guid, Date.now() + C.ADV_BANK_BACKOFF_S * 1000);
        if (!bank && !r.ok) this.parkBackoff.set(acc.guid, Date.now() + C.ADV_BANK_BACKOFF_S * 1000);
        if (bank) this.log(`${acc.alias} ${r.ok ? `banked ${r.moved} item(s)${r.left ? `; ${r.left} stay on the character${r.vaultFull ? " (vault full)" : ""}` : ""}` : `bank trip failed: ${r.error ?? "unknown"}`}`);
        else if (!r.ok) this.log(`${acc.alias} could not walk into its Vault: ${r.error ?? "unknown"}`);
      })
      .catch((e) => {
        (bank ? this.bankBackoff : this.parkBackoff).set(acc.guid, Date.now() + C.ADV_BANK_BACKOFF_S * 1000);
        this.log(`${acc.alias} bank trip raised: ${String(e)}`);
      })
      .finally(() => {
        this.onlineTrips.delete(acc.guid);
        this.maintenanceHolds.delete(acc.guid);
        if (!ran) return;
        this.lastClaim.delete(acc.botGuid);
        this.lastStatus.delete(acc.botGuid);
        this.lastSupervise = 0;
        this.poke();
      });
    return true;
  }
  /** A bot that just came up has yet to claim: the usual wake grace, until its first piece of work. */
  private justWoken(acc: BotAccount, now: number): boolean {
    const started = this.sessionStartedAt.get(acc.guid) ?? this.lastActive.get(acc.guid) ?? 0;
    return started > 0 && (this.workEndedAt.get(acc.guid) ?? 0) < started && now - started < C.WAKE_GRACE_S * 1000;
  }
  /** Within the owner's linger after the bot's last piece of work (0 s by default: none). */
  private lingering(acc: BotAccount, now: number): boolean {
    const ended = this.workEndedAt.get(acc.guid) ?? 0;
    const linger = this.advancedSettings().lingerS * 1000;
    return linger > 0 && ended >= (this.sessionStartedAt.get(acc.guid) ?? 0) && now - ended < linger;
  }
  private noteWorkEnded(acc: BotAccount): void {
    if (this.isAdvanced(acc)) this.workEndedAt.set(acc.guid, Date.now());
  }

  /**
   * The supervisor's idle rules for an advanced account in game (not held,
   * not the login desk): it stays while it can take work here; with deposits
   * here and no room it switches to an empty character (or banks, when it has
   * none); work only elsewhere swaps it over; with nothing for it anywhere it
   * lingers in its Vault (the owner's setting), banks what it holds, and logs out.
   */
  private superviseAdvanced(acc: BotAccount, client: GameClient, routing: Routing, wanted: Set<string>, botStates: BotStates, offlineCover: boolean, now: number): void {
    const server = client.server;
    const here = routing.get(server);
    if (here && this.accountCanFulfill(acc, here, botStates)) {
      this.serverIdleSince.delete(acc.guid);
      return;
    }
    if (this.justWoken(acc, now)) return;
    const side = client.charSeasonal ?? seasonalOf(acc);
    const deposits = here ? this.claimableDeposits(acc, here) : [];
    if (deposits.length && this.emptyIntake(acc.communism, side) && !this.depositsCoveredHere(acc, server, deposits)) {
      // Ready soonest: another empty character of the account is a reconnect away; banking first takes a Vault trip.
      const next = this.emptyCharToRotate(acc, side, Math.max(...deposits.map((d) => d.itemCount)));
      if (next) {
        this.switchChar(acc, next, `the deposit waiting on ${server} goes to an empty character`);
        this.advancedCounts.rotations++;
        this.log(`${acc.alias} holds items — logging out to come back as its empty character ${next.id} (${next.free} slots)`);
        this.disconnectAccount(acc);
        return;
      }
      // Banking takes a Vault trip; an empty bot that can be woken is as quick and costs this one nothing.
      if (!this.emptyComing(acc.communism, side) && this.startBank(acc, client, `to take the deposit waiting on ${server}`)) return;
    }
    const elsewhere = [...wanted].some((sv) => sv !== server && !this.serverBenched(sv, now) && this.accountCanFulfill(acc, routing.get(sv)!, botStates));
    if (elsewhere && !offlineCover) {
      const since = this.serverIdleSince.get(acc.guid);
      if (since === undefined) {
        this.serverIdleSince.set(acc.guid, now);
        return;
      }
      if (now - since < C.SERVER_SWAP_GRACE_S * 1000) return;
      this.log(`${acc.alias} on ${server}: its work is on ${[...wanted].filter((sv) => sv !== server).sort().join(",")} — swapping over`);
      this.disconnectAccount(acc);
      return;
    }
    this.serverIdleSince.delete(acc.guid);
    if (this.lingering(acc, now)) {
      this.startBank(acc, client, "lingering after its work", true);
      return;
    }
    if (this.startBank(acc, client, "before logging out")) return;
    this.log(`${acc.alias} idle with nothing for it — logging out`);
    this.disconnectAccount(acc);
  }
  /** Deposits here are taken care of: as many empty bots idle here or logging in for here as there are deposits. */
  private depositsCoveredHere(acc: BotAccount, server: string, deposits: RoutedDeposit[]): boolean {
    let cover = 0;
    for (const other of this.online()) {
      if (other === acc || other.communism !== acc.communism || other.assignedRequestId !== null || this.isHeld(other.guid)) continue;
      const oc = other.client!;
      if (oc.server !== server || !this.inWorld(other) || seasonalOf(other) !== seasonalOf(acc)) continue;
      if (this.countFreeSlots(oc) >= this.botCapacity(oc)) cover++;
    }
    for (const [guid, sv] of this.wakes.wakingServers()) {
      const other = this.pool.byGuid(guid);
      if (sv === server && other && other !== acc && other.communism === acc.communism && this.nextCharEmpty(other, seasonalOf(acc))) cover++;
    }
    return cover >= deposits.length;
  }

  /**
   * Whether an empty advanced bot in game claims a deposit now. The account
   * holding the most potions goes first among empty bots idle on the same
   * server (stock concentrates); a deposit bigger than this character waits a
   * little for an empty character that takes it whole, then continues across
   * characters anyway.
   */
  private advancedDepositClaim(acc: BotAccount, client: GameClient, cap: number): boolean {
    const r = this.lastRouting.get(client.server);
    if (!r || Date.now() - this.lastWantedAt > C.ROUTING_FRESH_S * 1000) return true;
    const deposits = this.claimableDeposits(acc, r);
    if (!deposits.length) return false;
    const mine = this.potionsOf(acc);
    let ahead = 0;
    for (const other of this.online()) {
      if (other === acc || other.communism !== acc.communism || other.assignedRequestId !== null || this.isHeld(other.guid) || !this.isAdvanced(other)) continue;
      const oc = other.client!;
      if (oc.server !== client.server || !this.inWorld(other) || seasonalOf(other) !== seasonalOf(acc)) continue;
      if (this.countFreeSlots(oc) < this.botCapacity(oc) || this.botCapacity(oc) < cap) continue;
      const theirs = this.potionsOf(other);
      if (theirs > mine || (theirs === mine && other.guid < acc.guid)) ahead++;
    }
    if (ahead >= deposits.length) return false;
    if (deposits.some((d) => d.itemCount <= cap)) {
      this.depositDefer.delete(acc.guid);
      return true;
    }
    // Every deposit here is bigger than this character: is a bigger empty one coming?
    const need = Math.min(...deposits.map((d) => d.itemCount));
    const bigger = (this.intake.get(this.intakeKey(acc.communism, seasonalOf(acc)))?.largest ?? 0) > cap;
    if (!bigger) return true;
    const now = Date.now();
    let prev = this.depositDefer.get(acc.guid);
    if (prev && now - prev[2] > 15_000) prev = undefined;
    const since = prev ? prev[0] : now;
    this.depositDefer.set(acc.guid, [since, C.DEPOSIT_DEFER_MAX_S, now]);
    if (now - since < C.DEPOSIT_DEFER_MAX_S * 1000) return false;
    this.log(`${acc.alias} waited ${Math.floor(s(now - since))}s for an empty character that takes the ${need}-slot deposit whole — taking it, the rest continues on the next empty character`);
    this.depositDefer.delete(acc.guid);
    return true;
  }

  /**
   * Wake for an advanced deposit: an empty character, the one ready soonest
   * — an account that logs in as an empty character, then one that switches
   * to one, then one that crosses the seasonal split — taking the deposit
   * whole before one that would continue it; ties to the account holding the
   * most potions.
   */
  private wakeEmptyFor(server: string, deposits: RoutedDeposit[], offline: BotAccount[]): boolean {
    const cands: { acc: BotAccount; rank: number; cap: number; potions: number; rotate: { id: number; free: number; held: number } | null; d: RoutedDeposit }[] = [];
    for (const acc of offline) {
      if (!this.isAdvanced(acc) || acc.suspended || acc.inUse || this.loginBlockedMs(acc) > 0) continue;
      for (const d of deposits) {
        if (d.communism !== acc.communism) continue;
        const empties = this.emptyCharsOf(acc, d.seasonal);
        if (!empties.length) continue;
        const next = empties.find((c) => c.next);
        const whole = empties.filter((c) => c.capacity >= d.itemCount).sort((a, b) => a.capacity - b.capacity || a.id - b.id);
        const pick = next && next.capacity >= d.itemCount ? next : whole[0] ?? next ?? [...empties].sort((a, b) => b.capacity - a.capacity)[0];
        // A switch needs storage's character ids; without them the account logs in as it is.
        const switching = !pick.next && pick.id !== -1 && !this.pinnedAccounts.has(acc.botGuid);
        if (!pick.next && !switching) continue;
        const rank = (switching ? 1 : 0) + (d.seasonal !== seasonalOf(acc) ? 1 : 0) + (pick.capacity >= d.itemCount ? 0 : 3);
        cands.push({ acc, rank, cap: pick.capacity, potions: 0, rotate: switching ? { id: pick.id, free: pick.capacity, held: 0 } : null, d });
      }
    }
    // The tie-break reads each account's storage: only for the soonest-ready tier, and a bounded number of them.
    const best = Math.min(...cands.map((c) => c.rank));
    let counted = 0;
    for (const c of cands) if (c.rank === best && counted++ < 200) c.potions = this.potionsOf(c.acc);
    cands.sort((a, b) => a.rank - b.rank || b.potions - a.potions || a.cap - b.cap || (a.acc.guid < b.acc.guid ? -1 : 1));
    const tried = new Set<string>();
    for (const c of cands) {
      if (tried.has(c.acc.guid)) continue;
      tried.add(c.acc.guid);
      const what = `${c.d.seasonal ? "seasonal" : "non-seasonal"}${c.d.communism ? " communism" : ""} deposit #${c.d.requestId}`;
      if (this.wakeSpecificAccount(c.acc, server, [{ kind: "deposit", requestId: c.d.requestId }], c.rotate && { to: c.rotate, why: `${what} goes to its empty character` })) {
        this.log(`chose ${c.acc.alias} for ${what} on ${server} — an empty ${c.cap}-slot character${c.rotate ? ` (switching to ${c.rotate.id})` : ""}, ${c.potions} potion(s) held`);
        this.emptyWakeFor.set(server, [c.acc.guid, Date.now(), c.d.seasonal]);
        return true;
      }
    }
    return false;
  }

  /**
   * The bot for a player's next row comes up once the row before it is being
   * traded, so it stands in the Nexus for its turn instead of starting its
   * login after the previous trade ends. Only within the online cap.
   */
  private preWakeUpcoming(routing: Routing): void {
    if (this.hold.active) return;
    let budget = this.onlineCap() - this.wakes.globalOnline();
    const now = Date.now();
    for (const [server, r] of routing) {
      for (const w of r.upcoming ?? []) {
        if (budget <= 0) return;
        if (!w.headClaimed || !w.targetBotGuid || this.serverBenched(server, now)) continue;
        const acc = this.pool.byBotGuid(w.targetBotGuid);
        if (!acc || acc.online || acc.suspended || acc.inUse || this.isHeld(acc.guid) || this.wakes.waking().has(acc.guid) || this.loginBlockedMs(acc) > 0) continue;
        if (this.wakeSpecificAccount(acc, server)) {
          budget--;
          this.advancedCounts.prewakes++;
          this.log(`woke ${acc.alias} on ${server} for withdraw #${w.requestId}, next in line after the row being traded`);
        }
      }
    }
  }

  /**
   * An advanced account's fetch for a withdraw: on its live client when it is
   * in game and idle (then it stays online for the trade); an account that is
   * offline is woken for the row first. A fetch the live client cannot make
   * (it needs another character) goes back to the trip with its own login.
   */
  private advancedFetch(acc: BotAccount, server: string, w: RoutedWithdraw, o: FetchOrder, keepIds: Set<string> | undefined, keepItems: Set<string> | undefined, upcoming: boolean): void {
    const desk = this.storageDesk;
    if (!desk?.fetchOnline || !w.fetchFrom) {
      o.offlineOnly = true;
      return;
    }
    const c = acc.client;
    if (!c || !acc.online) {
      if (upcoming || this.hold.active || acc.inUse || this.isHeld(acc.guid) || this.wakes.waking().has(acc.guid) || this.loginBlockedMs(acc) > 0 || this.onlineCap() - this.wakes.globalOnline() <= 0) return;
      if (this.wakeSpecificAccount(acc, server, [{ kind: "withdraw", requestId: w.requestId }])) this.log(`withdraw #${w.requestId}: waking ${acc.alias} on ${server} to fetch from its storage and trade`);
      return;
    }
    if (!this.inWorld(acc) || !c.playerData.enchantmentsSeen || acc.assignedRequestId !== null || acc.inUse || this.isHeld(acc.guid) || !(this.sessionFor(acc)?.isIdle() ?? true)) return;
    const need = w.fetchFrom.need;
    const named = new Set(need.instanceIds);
    const keep = new Set<string>([...(keepIds ?? []), ...this.reserved()].filter((id) => !named.has(id)));
    o.inflight = true;
    this.onlineTrips.add(acc.guid);
    this.maintenanceHolds.add(acc.guid);
    const what = need.instanceIds.length ? `${need.instanceIds.length} picked item(s)` : need.items.map((it) => `${it.qty}x${it.itemId}`).join(",");
    this.log(`withdraw #${w.requestId}: ${acc.alias} fetching ${what} from its storage while online${upcoming ? " (its turn is next)" : ""}`);
    void desk.fetchOnline(acc, c, need, { seasonal: w.seasonal, keep, keepItems, why: `withdraw #${w.requestId}` })
      .then((res) => {
        if (res.ok) {
          o.busySince = undefined;
          this.advancedCounts.onlineFetches++;
          this.log(`withdraw #${w.requestId}: ${acc.alias} has the items on its character`);
          return;
        }
        if (res.busy) {
          // Something else has the session (a storage run can hold it for long): after a while the trip with its own login, which waits its turn.
          const now = Date.now();
          o.busySince ??= now;
          if (now - o.busySince >= C.ADV_FETCH_BUSY_MAX_S * 1000) {
            o.offlineOnly = true;
            this.log(`withdraw #${w.requestId}: ${acc.alias}'s session stayed busy (${res.error}) — a storage trip will fetch it`);
          }
          o.nextAt = now + C.SUPERVISE_INTERVAL_S * 1000;
          return;
        }
        if (res.permanent) {
          // Not a dead end yet: the trip with its own login can reach another character.
          o.offlineOnly = true;
          this.log(`withdraw #${w.requestId}: the live fetch cannot reach it (${res.error}) — a storage trip will`);
          return;
        }
        o.attempts++;
        o.nextAt = Date.now() + C.FETCH_RETRY_S * 1000;
        this.log(`withdraw #${w.requestId}: live fetch on ${acc.alias} failed (${res.error}) — retrying in ${C.FETCH_RETRY_S}s`);
      })
      .catch((e) => {
        o.attempts++;
        o.nextAt = Date.now() + C.FETCH_RETRY_S * 1000;
        this.log(`withdraw #${w.requestId}: live fetch raised: ${String(e)}`);
      })
      .finally(() => {
        o.inflight = false;
        this.onlineTrips.delete(acc.guid);
        this.maintenanceHolds.delete(acc.guid);
        this.lastClaim.delete(acc.botGuid);
        this.lastSupervise = 0;
        this.poke();
      });
  }

  // --- advanced management: potions by kind, evacuation, compaction ---

  /** Advanced accounts, by botGuid: what merges and evacuations may move between (pool and communism alike; the planner keeps them apart). */
  private advancedFleet(): Map<string, BotAccount> {
    const fleet = new Map<string, BotAccount>();
    for (const acc of this.accounts()) if (!acc.suspended && this.isAdvanced(acc) && !this.deps.gate.isRetired(acc.guid)) fleet.set(acc.botGuid, acc);
    return fleet;
  }
  /** The planner's view of an account: its played character's items, its vault of that side, its other characters there. */
  private acctView(acc: BotAccount, reserved: ReadonlySet<string>): AcctView {
    const side = seasonalOf(acc);
    const chars = this.charsOf(acc).filter((c) => c.seasonal === side);
    const nextId = this.nextCharId(acc);
    const played = chars.find((c) => c.id === nextId) ?? chars.find((c) => c.login) ?? chars[0] ?? { id: -1, seasonal: side, login: true, held: 0, capacity: this.tracker.capacityFor(acc.botGuid) };
    const stored = this.storageDesk?.stored(acc.botGuid) ?? [];
    const onChar = (id: number): Held[] => stored.filter((x) => x.where.kind === "char" && x.where.charId === id).map((x) => ({ instanceId: x.instanceId, itemId: x.itemId }));
    // The tracker describes the character the account last played; one it switched to since is still in storage's view.
    const trackerChar = acc.client && this.inWorld(acc) ? acc.client.charId : this.storageDesk?.loginChar(acc.botGuid) ?? played.id;
    const playedItems: Held[] = played.id === -1 || played.id === trackerChar ? Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => ({ instanceId: i.instanceId, itemId: i.itemId })) : onChar(played.id);
    const v = this.storageDesk?.vaultRoom?.(acc.botGuid, side) ?? null;
    const vaultItems = stored.filter((x) => x.where.kind === "vault" && (x.where.seasonal === undefined || x.where.seasonal === side)).map((x) => ({ instanceId: x.instanceId, itemId: x.itemId }));
    const c = acc.client;
    const online = this.inWorld(acc);
    return {
      botGuid: acc.botGuid, communism: acc.communism, seasonal: side, chars: Math.max(1, chars.length), online,
      idle: online && acc.assignedRequestId === null && !this.isHeld(acc.guid) && !acc.inUse && !this.neededByPlayers(acc) && !this.withdrawsCountOn(acc.botGuid) && (this.sessionFor(acc)?.isIdle() ?? true),
      server: online ? c!.server : acc.info.server ?? null,
      // Slots really taken (untracked items count): from the live client in game, else storage's count.
      played: { capacity: played.capacity, items: playedItems, held: played.held },
      vault: v ? { slots: v.slots, free: v.free, items: vaultItems } : null,
      others: chars.filter((ch) => ch !== played).map((ch) => ({ charId: ch.id, capacity: ch.capacity, held: ch.held, items: onChar(ch.id) })),
      reserved,
    };
  }
  /** Background work may log this account in `logins` more times now: it stays well inside Realm's patience (ADV_BACKGROUND_LOGINS_PER_30MIN). */
  private backgroundLoginsLeft(acc: BotAccount, logins: number): boolean {
    return accountLoginsWithin(acc.guid, 30 * 60_000) + logins <= C.ADV_BACKGROUND_LOGINS_PER_30MIN;
  }
  /** A quiet period: no player request waiting, no fetch under way, and the online cap has room for these logins and the players' reserve. */
  private quietWakeAllowed(slots = 1): boolean {
    if (this.advancedRowsWaiting() > 0 || [...this.fetchOrders.values()].some((o) => o.inflight)) return false;
    // The players' reserve never takes a node's only slot (one exit IP, own internet): there background work
    // uses it in quiet periods and gives it back when a request comes in (the chores stop, woken pairs let go).
    const cap = this.onlineCap();
    return cap - this.wakes.globalOnline() >= slots + Math.min(C.ADV_QUIET_RESERVE, Math.max(0, cap - slots));
  }
  /** Player rows the last routing pass saw, each player's next row included. */
  private advancedRowsWaiting(): number {
    let n = this.pendingPlayerRequests();
    for (const r of this.lastRouting.values()) n += r.upcoming?.length ?? 0;
    return n;
  }
  /** The owner's merge budget for woken pairs: unlimited, or (demand) at most twice the potion withdraws of the last hour. */
  private quietMergeBudget(now: number): number {
    const hour = now - 3_600_000;
    this.potionWithdrawsAt = this.potionWithdrawsAt.filter((t) => t > hour);
    this.quietMergesAt = this.quietMergesAt.filter((t) => t > hour);
    if (this.advancedSettings().mergeBudget === "unlimited") return Infinity;
    return Math.max(0, 2 * this.potionWithdrawsAt.length - this.quietMergesAt.length);
  }

  /**
   * Drive the advanced moves under way, and plan new ones every
   * ADV_MERGE_INTERVAL_S: merges and evacuations between bots idle together
   * (never limited), then one woken pair in a quiet period (the merge
   * budget). Offline chores (compaction, gathering potions) after that.
   */
  private maybeAdvancedMoves(now: number): void {
    const planDue = now - this.lastMergePlan >= C.ADV_MERGE_INTERVAL_S * 1000;
    const choresDue = now - this.lastChores >= C.ADV_CHORES_INTERVAL_S * 1000;
    if (!planDue && !choresDue && !this.pendingMoves.some((m) => m.advanced)) return;
    const fleet = this.advancedFleet();
    for (const m of [...this.pendingMoves]) if (m.advanced) this.driveMove(m, now, fleet);
    if (planDue && !this.hold.active && fleet.size >= 2) {
      this.lastMergePlan = now;
      this.planAdvancedMoves(fleet, now);
    }
    if (choresDue) this.advancedChores(fleet, now);
  }
  private planAdvancedMoves(fleet: Map<string, BotAccount>, now: number): void {
    let room = C.CONSOLIDATION_MAX_CONCURRENT - this.pendingMoves.length;
    if (room <= 0) return;
    // Never a bot a player's withdraw counts on (its items stay where the withdraw expects them), nor one doing anything else.
    const busy = new Set<string>([...this.busyWithConsolidation(), ...this.withdrawAccounts()]);
    for (const acc of fleet.values()) if (this.onlineTrips.has(acc.guid) || this.choreInflight.has(acc.guid) || acc.inUse || this.maintenanceHolds.has(acc.guid) || (this.moveBackoff.get(acc.guid) ?? 0) > now) busy.add(acc.botGuid);
    const reserved = this.reserved();
    const tradeMax = (g: string) => fleet.get(g)?.client?.active ? this.botCapacity(fleet.get(g)!.client!) : this.tracker.capacityFor(g);
    // Evacuation follows the share of empty bots across the whole roster of a group, not the few online now.
    const evacuating = [...this.oneCharGroups].filter(([, g]) => g.empty < C.ADV_EVACUATE_BELOW * g.n).map(([key, g]) => ({ key, wanted: Math.max(1, Math.ceil(C.ADV_EVACUATE_BELOW * g.n) - g.empty) }));
    const evacuate = (views: AcctView[], mode: "online" | "quiet", max: number) => {
      const out: { giver: string; taker: string; instanceIds: string[]; server: string | null }[] = [];
      for (const { key, wanted } of evacuating) {
        if (out.length >= max) break;
        const group = views.filter((v) => `${v.communism ? "communism" : "pool"}|${v.seasonal ? "seasonal" : "nonseasonal"}` === key);
        // The group is short of empty bots: every non-empty bot of it may give (the planner's own share check sees only these views).
        out.push(...planEvacuation(group, { mode, max: Math.min(max - out.length, wanted), busy, tradeMax: Math.max(1, ...group.map((v) => tradeMax(v.botGuid))), threshold: 1.01 }));
      }
      return out;
    };
    // Bots idle together first: no wake, no budget.
    const onlineViews = [...fleet.values()].filter((a) => this.inWorld(a) && !busy.has(a.botGuid)).map((a) => this.acctView(a, reserved));
    if (onlineViews.length >= 2) {
      const max = Math.max(...onlineViews.map((v) => tradeMax(v.botGuid)));
      const merges = planMerges(onlineViews, { mode: "online", max: room, busy, tradeMax: max });
      for (const m of merges) {
        if (!this.startAdvancedMove(fleet, "merge", m.giver, m.taker, [...m.onCharacter, ...m.fromVault], m.fromVault, m.server, false, now)) continue;
        room--;
        busy.add(m.giver).add(m.taker);
      }
      for (const m of room > 0 ? evacuate(onlineViews, "online", room) : []) {
        if (!this.startAdvancedMove(fleet, "evacuate", m.giver, m.taker, m.instanceIds, [], m.server, false, now)) continue;
        room--;
        busy.add(m.giver).add(m.taker);
      }
    }
    // One woken pair at a time, in a quiet period, within the merge budget; it walks the roster's storage, so not every pass.
    if (room <= 0 || now - this.lastQuietPlan < C.ADV_QUIET_PLAN_INTERVAL_S * 1000) return;
    if (this.pendingMoves.some((m) => m.advanced?.quiet) || !this.quietWakeAllowed() || this.quietMergeBudget(now) <= 0) return;
    this.lastQuietPlan = now;
    const waking = this.wakes.waking();
    // An account offline needs a login for it: only one inside its background login budget.
    const views = [...fleet.values()].filter((a) => !busy.has(a.botGuid) && !waking.has(a.guid) && !this.isHeld(a.guid) && this.loginBlockedMs(a) <= 0 && (this.inWorld(a) || this.backgroundLoginsLeft(a, 1))).map((a) => this.acctView(a, reserved));
    if (views.length < 2) return;
    const max = Math.max(...views.map((v) => tradeMax(v.botGuid)));
    // The pair's logins: room for each offline bot of it, plus the players' reserve.
    const fits = (giver: string, taker: string) => this.quietWakeAllowed([giver, taker].filter((g) => !fleet.get(g)?.online).length);
    const merge = planMerges(views, { mode: "quiet", max: 1, busy, tradeMax: max })[0];
    if (merge) {
      if (fits(merge.giver, merge.taker) && this.startAdvancedMove(fleet, "merge", merge.giver, merge.taker, [...merge.onCharacter, ...merge.fromVault], merge.fromVault, merge.server, true, now)) this.quietMergesAt.push(now);
      return;
    }
    const evac = evacuate(views, "quiet", 1)[0];
    if (evac && fits(evac.giver, evac.taker) && this.startAdvancedMove(fleet, "evacuate", evac.giver, evac.taker, evac.instanceIds, [], evac.server, true, now)) this.quietMergesAt.push(now);
  }
  private startAdvancedMove(fleet: Map<string, BotAccount>, why: "merge" | "evacuate", giverGuid: string, takerGuid: string, instanceIds: string[], fromVault: string[], server: string | null, quiet: boolean, now: number): boolean {
    const giver = fleet.get(giverGuid);
    const taker = fleet.get(takerGuid);
    if (!giver || !taker || !instanceIds.length) return false;
    const sv = server || this.consolidationServerFor(giver, taker);
    if (!sv) return false;
    // What crosses, by type: for the log and the trade window's counts.
    const types = new Map<string, number>();
    const stored = new Map((this.storageDesk?.stored(giverGuid) ?? []).map((x) => [x.instanceId, x.itemId]));
    const onChar = new Map(Object.values(this.tracker.instancesFor(giverGuid)).map((i) => [i.instanceId, i.itemId]));
    for (const id of instanceIds) {
      const itemId = onChar.get(id) ?? stored.get(id);
      if (!itemId) return false;
      types.set(itemId, (types.get(itemId) ?? 0) + 1);
    }
    const items = [...types].sort().map(([itemId, qty]) => ({ itemId, qty }));
    const label = items.map((i) => `${i.qty}x${i.itemId}`).join(",");
    const move: PendingMove = {
      giver: giverGuid, taker: takerGuid, items, swapItems: [], stat: why === "merge" ? items[0].itemId : "evacuate", kind: "give", score: 0,
      reason: why === "merge" ? `merging a small stack into the biggest holder` : `emptying a bot while empty bots run short`,
      server: sv, since: now, readySince: null, holdGuids: new Set([giver.guid, taker.guid]), woken: new Set(), hopped: new Set(),
      advanced: { why, instanceIds, fromVault, quiet },
    };
    this.pendingMoves.push(move);
    for (const g of move.holdGuids) this.consolidationHolds.add(g);
    this.log(`${why === "merge" ? "merge" : "evacuation"} planned${quiet ? " (woken pair)" : ""} — ${giver.alias} -> ${taker.alias}: ${label}${fromVault.length ? ` (${fromVault.length} from its vault first)` : ""} on ${sv}`);
    this.driveMove(move, now, fleet);
    return true;
  }
  /**
   * Before an advanced move's trade: the giver fetches the copies kept in its
   * vault onto its character, and a bot waiting in its Vault walks to the
   * Nexus. False until both stand ready to trade.
   */
  private prepareAdvancedMove(move: PendingMove, giver: BotAccount, taker: BotAccount): boolean {
    const adv = move.advanced!;
    if (this.onlineTrips.has(giver.guid) || this.onlineTrips.has(taker.guid)) return false;
    if (adv.fromVault.length && !adv.fetched) {
      const desk = this.storageDesk;
      const c = giver.client;
      if (!desk?.fetchOnline) {
        this.releaseMove(move, "no live fetch for the copies in the vault");
        return false;
      }
      if (!c || !this.inWorld(giver) || !c.playerData.enchantmentsSeen) return false;
      this.onlineTrips.add(giver.guid);
      this.maintenanceHolds.add(giver.guid);
      const keep = new Set([...this.reserved(), ...adv.instanceIds]);
      const keepItems = new Set(move.items.map((i) => i.itemId));
      void desk.fetchOnline(giver, c, { instanceIds: adv.fromVault, items: [] }, { seasonal: seasonalOf(giver), keep, keepItems, why: `${adv.why} to ${taker.alias}` })
        .then((res) => {
          if (res.ok) adv.fetched = true;
          else this.releaseMove(move, `${giver.alias} could not fetch the copies from its vault (${res.error})`, [giver.guid]);
        })
        .catch((e) => this.releaseMove(move, `${giver.alias}'s vault fetch raised: ${String(e)}`, [giver.guid]))
        .finally(() => {
          this.onlineTrips.delete(giver.guid);
          this.maintenanceHolds.delete(giver.guid);
          this.poke();
        });
      return false;
    }
    for (const a of [giver, taker]) {
      const c = a.client;
      if (c && this.inWorld(a) && !this.inNexusNow(a, c)) this.toNexus(a, c);
    }
    return true;
  }

  /**
   * Offline chores in idle gaps (no player request waiting, a free login
   * slot): compaction keeps an empty character on accounts with several,
   * gathering puts other characters' potions in the vault. One at a time,
   * each account at most ADV_CHORES_PER_HOUR times an hour.
   */
  private advancedChores(fleet: Map<string, BotAccount>, now: number): void {
    const desk = this.storageDesk;
    if ((!desk?.compact && !desk?.gatherPotions) || now - this.lastChores < C.ADV_CHORES_INTERVAL_S * 1000) return;
    this.lastChores = now;
    if (this.hold.active || this.choreInflight.size || !this.quietWakeAllowed()) return;
    const reserved = this.reserved();
    const waking = this.wakes.waking();
    // A slice of the roster per pass, carrying on from where the last one stopped: storage views are not free.
    const accounts = [...fleet.values()];
    const n = Math.min(accounts.length, C.ADV_CHORES_SCAN);
    for (let i = 0; i < n; i++) {
      const acc = accounts[(this.choresCursor + i) % accounts.length];
      if (acc.online || acc.inUse || this.isHeld(acc.guid) || waking.has(acc.guid) || this.loginBlockedMs(acc) > 0 || this.withdrawsCountOn(acc.botGuid)) continue;
      if ((this.choreSkipUntil.get(acc.guid) ?? 0) > now) continue;
      // A run logs in once per character it visits: gathering up to ADV_GATHER_CHARS_PER_RUN, compaction a few.
      if (!this.backgroundLoginsLeft(acc, Math.min(3, C.ADV_GATHER_CHARS_PER_RUN))) continue;
      const runs = (this.choreRuns.get(acc.guid) ?? []).filter((t) => now - t < 3_600_000);
      if (runs.length >= C.ADV_CHORES_PER_HOUR) continue;
      const view = this.acctView(acc, reserved);
      const job = desk.compact && compactionWanted(view) ? "compact" : desk.gatherPotions && gatherWanted(view) ? "gather" : null;
      if (!job) continue;
      this.choresCursor = (this.choresCursor + i + 1) % accounts.length;
      runs.push(now);
      this.choreRuns.set(acc.guid, runs);
      this.choreInflight.add(acc.guid);
      const reserveSlots = this.transitReserve(acc, seasonalOf(acc));
      const what = job === "compact" ? "compacting its characters (an empty one for intake)" : "gathering its potions into the vault";
      this.log(`${acc.alias} ${what}`);
      // A run holds the account: a few characters at a time, and it ends early when a player's request comes in.
      const stop = () => this.advancedRowsWaiting() > 0 || this.hold.active || !this.backgroundLoginsLeft(acc, 1);
      const run = job === "compact" ? desk.compact!(acc, { reserveSlots, why: "advanced management: keep an empty character" }) : desk.gatherPotions!(acc, { reserveSlots, why: "advanced management: potions by kind", maxChars: C.ADV_GATHER_CHARS_PER_RUN, stop });
      void run
        .then((r) => {
          if (r.ok) this.advancedCounts[job === "compact" ? "compactions" : "gathers"]++;
          // Storage found nothing to do: not a failure, and not worth asking again for a while.
          if (!r.ok && r.skipped) this.choreSkipUntil.set(acc.guid, Date.now() + C.ADV_CHORE_SKIP_BACKOFF_S * 1000);
          this.log(`${acc.alias} ${job === "compact" ? "compaction" : "gathering"} ${r.ok ? "done" : r.busy ? "put off (the account was busy)" : r.skipped ? `skipped: ${r.skipped}` : `failed: ${r.error ?? "unknown"}`}`);
        })
        .catch((e) => this.log(`${acc.alias} ${job} raised: ${String(e)}`))
        .finally(() => {
          this.choreInflight.delete(acc.guid);
          this.poke();
        });
      return;
    }
    if (accounts.length) this.choresCursor = (this.choresCursor + n) % accounts.length;
  }

  /** Which sides take deposits into an empty character right now (a bigger deposit then continues on the next one); false where the side goes the old way. */
  intakeContinues(): { seasonal: boolean; nonseasonal: boolean; communism: { seasonal: boolean; nonseasonal: boolean } } {
    return {
      seasonal: this.emptyIntake(false, true),
      nonseasonal: this.emptyIntake(false, false),
      communism: { seasonal: this.emptyIntake(true, true), nonseasonal: this.emptyIntake(true, false) },
    };
  }

  /**
   * Communism accounts under advanced management, per side: how many, their
   * empty characters, and vault room past the reserves (the hub's surplus rule
   * reads it). An account counts on the side it plays and on the other one
   * when it has a living character there, which it serves by logging in as it.
   */
  communismRoom(): { seasonal: boolean; accounts: number; emptyChars: number; vaultFree: number }[] {
    if (!this.advancedSettings().communism) return [];
    const out = new Map<boolean, { seasonal: boolean; accounts: number; emptyChars: number; vaultFree: number }>();
    for (const acc of this.accounts()) {
      if (!acc.communism || this.deps.gate.isRetired(acc.guid)) continue;
      const chars = this.charsOf(acc);
      for (const side of [seasonalOf(acc), !seasonalOf(acc)]) {
        if (side !== seasonalOf(acc) && !chars.some((c) => c.seasonal === side)) continue;
        const row = out.get(side) ?? { seasonal: side, accounts: 0, emptyChars: 0, vaultFree: 0 };
        row.accounts++;
        row.emptyChars += this.emptyCharsOf(acc, side).length;
        row.vaultFree += this.bankRoom(acc, side) ?? 0;
        out.set(side, row);
      }
    }
    return [...out.values()];
  }

  /** What advanced management is doing, for the control panel. */
  advancedStatus(): { intake: Record<string, IntakeSide>; counts: Dispatcher["advancedCounts"]; pendingMoves: number; onlineTrips: number } {
    return { intake: Object.fromEntries(this.intake), counts: { ...this.advancedCounts }, pendingMoves: this.pendingMoves.filter((m) => m.advanced).length, onlineTrips: this.onlineTrips.size };
  }

  // --- diagnostics -----------------------------------------------------------------

  private reportHttpStats(now: number): void {
    if (now - this.lastHttpStatsAt < C.HTTP_STATS_INTERVAL_S * 1000) return;
    this.lastHttpStatsAt = now;
    const stats = this.api.stats.drain();
    if (!stats && !this.tickCount) return;
    const parts: string[] = [];
    if (this.tickCount) parts.push(`ticks=${this.tickCount} avg=${(this.tickMsTotal / this.tickCount).toFixed(0)}ms max=${this.tickMsMax.toFixed(0)}ms`);
    if (stats) parts.push(`http=${stats.calls} err=${stats.errors} avg=${stats.avgMs.toFixed(0)}ms max=${stats.maxMs.toFixed(0)}ms slowest=${stats.slowest}`);
    if (this.claimsSkipped) parts.push(`claim-polls-skipped=${this.claimsSkipped}`);
    this.deps.log(`Dispatcher.cost: ${parts.join(" | ")}`);
    this.tickCount = 0;
    this.tickMsTotal = 0;
    this.tickMsMax = 0;
    this.claimsSkipped = 0;
  }

  /** Read-only views for the control plane. */
  liveView(): { acc: BotAccount; client: GameClient; session: TradeSession | undefined }[] {
    return this.online().map((acc) => ({ acc, client: acc.client!, session: this.sessions.get(acc.guid) }));
  }
  get tradeHoldActive(): boolean {
    return this.hold.active;
  }
}

/**
 * What the whole node holds, to tell a withdraw nobody can serve from one
 * that is merely waiting: every account's played character (the tracker),
 * what is on its way to one (a switch of character, a move), and its
 * storage. Built on first use and only then, since it walks every account's
 * storage; one per routing pass.
 */
class StockOnNode {
  private ids: Set<string> | null = null;
  private readonly counts = new Map<boolean, Map<string, number>>();
  private readonly expected: Map<string, Instance[]>;
  constructor(private readonly tracker: InventoryTracker, private readonly desk: StorageDesk | null, private readonly accounts: BotAccount[]) {
    this.expected = tracker.expected();
  }
  /** Whether this instance is on any account, suspended ones included: in a character's trade slots, on its way to them, or in storage. */
  holds(instanceId: string): boolean {
    if (this.tracker.holderOf(instanceId) !== undefined) return true;
    if (!this.ids) {
      this.ids = new Set();
      for (const list of this.expected.values()) for (const i of list) this.ids.add(i.instanceId);
      for (const acc of this.accounts) for (const s of this.desk?.stored(acc.botGuid) ?? []) this.ids.add(s.instanceId);
    }
    return this.ids.has(instanceId);
  }
  /** How many of an item the accounts that can hand over a pool withdraw of this side hold: on played characters of the side (or on their way to them), and in storage a character of it can reach. Not suspended ones, not communism accounts. */
  count(itemId: string, seasonal: boolean): number {
    let m = this.counts.get(seasonal);
    if (!m) {
      m = new Map<string, number>();
      const items = this.tracker.itemsView();
      const side = seasonal ? "seasonal" : "nonseasonal";
      for (const acc of this.accounts) {
        if (acc.suspended || acc.communism) continue;
        if (acc.seasonalOrDefault === seasonal) {
          for (const [id, n] of Object.entries(items.get(acc.botGuid) ?? {})) m.set(id, (m.get(id) ?? 0) + n);
          for (const i of this.expected.get(acc.botGuid) ?? []) m.set(i.itemId, (m.get(i.itemId) ?? 0) + 1);
        }
        for (const s of this.desk?.stored(acc.botGuid) ?? []) if (s.pools[side]) m.set(s.itemId, (m.get(s.itemId) ?? 0) + 1);
      }
      this.counts.set(seasonal, m);
    }
    return m.get(itemId) ?? 0;
  }
}

interface HeartbeatPayload {
  botGuid: string;
  alias: string;
  ign: string;
  server: string;
  freeSlots: number;
  status: "idle" | "busy" | "offline";
  seasonal: boolean;
  communism: boolean;
  /** Advanced accounts only: the played character's trade slots, and whether it claims a deposit only while empty. */
  capacity?: number;
  emptyOnly?: boolean;
}
interface ClaimPlan {
  botGuid: string;
  tryWithdraw: boolean;
  tryDeposit: boolean;
  inventory: ItemQty[];
  instanceIds: string[];
  /** Advanced accounts: instance id -> catalog id of what the played character holds. */
  heldItems?: Record<string, string>;
  freeSlots: number;
  /** A hinted deposit this bot gathers: ask the site for that row. */
  preferRequestId?: number;
}
export interface ConsolidationStatus {
  enabled: boolean;
  swaps: boolean;
  maxPairs: number;
  pools: { seasonal: boolean; fragmentation: Fragmentation | null; collectors: Record<string, string[]>; roles: Record<string, string>; split: string[] }[];
  pending: { giver: string; taker: string; kind: MoveKind; stat: string; items: Record<string, number>; swapItems: Record<string, number>; server: string; ageS: number; readyS: number | null; score: number; reason: string }[];
  lastPlan: { giver: string; taker: string; kind: MoveKind; stat: string; items: Record<string, number>; swapItems: Record<string, number>; score: number; reason: string }[];
  stats: ConsolidationStats;
}
export type { Outcome };

/**
 * What the player is told when the bot ends their request. A trade request
 * that never opened a window is most often a player on the other side of the
 * seasonal split: the game silently drops trade requests between seasonal
 * and non-seasonal characters, so say so.
 */
export function playerReason(why: string): string {
  if (/no trade window/i.test(why)) return `${why}. If you were in the Nexus, check that your character is on the same side (seasonal or non-seasonal) as the pool tab you used: the game does not deliver trade requests across the two.`;
  return why;
}

/** A TEXT packet's recipient names this bot: the line is a /tell to it. */
export function isTellTo(recipient: string | undefined, botName: string | undefined): boolean {
  return !!recipient && !!botName && recipient.toLowerCase() === botName.toLowerCase();
}
