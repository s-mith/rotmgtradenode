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
import type { BotAccount, BotPool } from "./botPool";
import { pullAccount } from "./botPool";
import type { FleetDeps } from "./bringUp";
import { takeDown } from "./bringUp";
import { WakeScheduler, type WakeResult } from "./wakes";
import type { InventoryTracker } from "./inventoryTracker";
import type { LoginCodes, PoolSettings, TradeHold, WhisperQueue } from "./stores";
import type { Assignment as SiteAssignment, FleetVault, ItemQty, PendingDeposit, PendingWithdraw, PoolRoom, ReceivedInstance, SiteApi } from "./siteApi";
import { bucketCounts, bucketOf, collectionTargets, electRoles, fragmentation, planMoves, splitStats, type Demand, type Fragmentation, type Inventories, type Move, type MoveKind } from "./potionConsolidation";
import * as C from "./constants";
import { swapAssignment, swapResult } from "./swapJobs";

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
}
interface RoutedDeposit {
  requestId: number;
  itemCount: number;
  seasonal: boolean;
  /** What the player said they are bringing, when they said. */
  items?: ItemQty[];
  /** Personal storage: only this bot (the account's vault bot) may claim it. */
  pinnedBot: string | null;
}
interface ServerRouting {
  count: number;
  withdraws: RoutedWithdraw[];
  deposits: RoutedDeposit[];
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
  /** Vault deposits: the physical items received, once the tracker has seen them. */
  instances?: ReceivedInstance[];
  attempts: number;
  nextAt?: number;
}

/**
 * A vault deposit whose trade is done but whose fulfill waits for the tracker
 * to see the new items, so the site can be told which physical instances the
 * account now owns. Resolved on the next inventory refresh, or reported with
 * whatever matched after VAULT_ATTACH_MAX_MS.
 */
interface PendingVaultAttach {
  acc: BotAccount;
  requestId: number;
  received: ItemQty[];
  units: { itemId: string; enchants: number }[];
  /** Instance ids on the bot before the trade. */
  before: Set<string>;
  since: number;
  /** Phase 4b: a guest's swap; attach what arrived to this vault user instead of fulfilling a deposit. */
  swapVaultUser?: number;
}
const VAULT_ATTACH_MAX_MS = 8_000;

interface PendingMove {
  giver: string;
  taker: string;
  /** giver -> taker */
  items: ItemQty[];
  /** taker -> giver (swaps) */
  swapItems: ItemQty[];
  stat: string;
  kind: MoveKind | "vault";
  score: number;
  reason: string;
  server: string;
  since: number;
  readySince: number | null;
  holdGuids: Set<string>;
  woken: Set<string>;
  /** Bots dropped from another server so they can log in on this one. */
  hopped: Set<string>;
  /** Vault packing: exactly these physical items go over. */
  instanceIds?: string[];
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
  freeSlotsTarget?: number;
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
  private readonly freeSlotsTarget: number;

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
  private tradeTimeline = new Map<string, { claimed: number; requested?: number }>();
  private partnerWaitSince = new Map<string, [number | null, number]>();
  private consolidationAssignedAt = new Map<string, [number | null, number]>();
  /** guid -> [first deferral, limit (s), last re-evaluation] for a deposit this bot is holding off on. */
  private depositDefer = new Map<string, [number, number, number]>();
  private emptyWakeFor = new Map<string, [string, number, boolean]>();
  private readonly standby: Map<string, Map<boolean | null, number>>;
  private standbyGuids = new Set<string>();
  private standbyWaking = new Map<string, [string, number]>();
  private lastStandbyStarvedLog = 0;
  private loginBotGuid: string | null = null;
  private loginDeskElected: string | null = null;
  private residentGuids = new Set<string>();
  private residentCounts = new Map<string, number>();
  private queueNoteAt = new Map<string, number>();
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
  private consolidationPairs = new Map<number, { giver: string; taker: string; instanceIds?: string[] }>();
  private consolidationHolds = new Set<string>();
  /** Accounts a maintenance routine (the backpack chore) is driving: no claims, no consolidation, no idle disconnect. */
  readonly maintenanceHolds = new Set<string>();
  /** Bots holding somebody's personal storage (the site's vault assignments). */
  vaultBotGuids(): Set<string> {
    return new Set(this.vaultBots);
  }
  /** Player requests the last routing pass saw (withdraws + deposits, all servers). */
  pendingPlayerRequests(): number {
    let n = 0;
    for (const r of this.lastRouting.values()) n += r.withdraws.length + r.deposits.length;
    return n;
  }
  private isHeld(guid: string): boolean {
    return this.consolidationHolds.has(guid) || this.maintenanceHolds.has(guid);
  }
  private moveBackoff = new Map<string, number>();
  private lastConsolidation = 0;
  private consolidationSeq = 0;
  private consolidationPoolTurn = false;
  private loginPauseNote = 0;
  private lastOnlineCap: number | null = null;
  private serverJamLogAt = new Map<string, number>();
  private lastUnfulfillableSig = new Map<string, string>();
  /** Bots dedicated to somebody's personal storage (from the site, every pass). */
  private vaultBots = new Set<string>();
  /** Every vault with items, from the site each pass; and its items indexed by owner-independent id and by the bot holding them. */
  private vaults: FleetVault[] = [];
  private ownedInstances = new Set<string>();
  private ownedByBot = new Map<string, { instanceId: string; itemId: string }[]>();
  private lastVaultPlan = 0;
  private pendingVaultAttach: PendingVaultAttach[] = [];
  /** guid -> instance ids on the bot when it claimed a vault deposit. */
  private preTradeInstances = new Map<string, Set<string>>();
  private lastWantedServers = new Set<string>();
  private lastWantedAt = 0;
  private lastRouting: Routing = new Map();
  private lastBotStates: BotStates = new Map();
  /** Last "nothing can fulfill" note per server, so a stuck request doesn't log every tick. */
  private unfulfillableNoteAt = new Map<string, number>();
  /** The backpack lane's order desk: fit an empty account of that pool half with a backpack (fleet.ts wires it). */
  private orderBackpackBot: ((seasonal: boolean) => void) | null = null;
  /** When each waiting >8-slot deposit was first seen pending, for the order timer. */
  private bigDepositSince = new Map<number, number>();
  setBackpackOrders(fn: (seasonal: boolean) => void): void {
    this.orderBackpackBot = fn;
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
    this.freeSlotsTarget = opts.freeSlotsTarget ?? C.FREE_SLOTS_TARGET;
    this.standby = C.parseStandby();
    if (this.standby.size) this.log(`standby pool ${JSON.stringify([...this.standby].map(([k, v]) => [k, [...v]]))}`);
    if (C.QUEUE_PROTECTED_SERVERS.size) this.log(`queue-protected servers ${[...C.QUEUE_PROTECTED_SERVERS].sort().join(",")} (up to ${C.QUEUE_PROTECT_MAX_S}s)`);
  }

  private log(line: string): void {
    this.deps.log(`Dispatcher: ${line}`);
  }

  // --- lifecycle --------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("started");
    this.schedule(0);
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
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
  /** Trade slots this bot has: 16 when a backpack was observed on this
   *  character (stat 79, or an item in a backpack slot), else 8. Per bot:
   *  there is no pool-wide switch. */
  private botCapacity(client: GameClient): number {
    return client.hasBackpack ? 16 : 8;
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
      this.refreshInventory(acc, client);
      if (acc.assignedRequestId !== null) this.pollOutcome(acc, client);

      const hb = this.heartbeatPayload(acc, client);
      let heartbeat: HeartbeatPayload | null = null;
      if (now - (this.lastHeartbeat.get(acc.botGuid) ?? 0) >= C.HEARTBEAT_INTERVAL_S * 1000 || this.lastStatus.get(acc.botGuid) !== hb.status) {
        if (this.lastStatus.get(acc.botGuid) !== hb.status && hb.status === "idle") this.lastClaim.delete(acc.botGuid);
        this.lastHeartbeat.set(acc.botGuid, now);
        this.lastStatus.set(acc.botGuid, hb.status);
        heartbeat = hb;
      }

      if (acc.assignedRequestId !== null) {
        if (this.giveUpOnStuckConsolidation(acc, client, now)) continue;
        const session = this.sessionFor(acc);
        const idle = !session || session.isIdle();
        const inNexus = client.gameIdValue === GameId.nexus;
        if (idle && !inNexus && this.giveUpWaitingForPartner(acc, client, now, "never got back to the nexus")) continue;
        if (idle && inNexus && session) {
          if (session.sendTradeRequest()) {
            const tl = this.tradeTimeline.get(acc.guid) ?? { claimed: now };
            tl.requested = now;
            this.tradeTimeline.set(acc.guid, tl);
            this.partnerWaitSince.delete(acc.guid);
          } else if (this.giveUpWaitingForPartner(acc, client, now)) {
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
    this.resolveVaultAttaches(now);
    await this.runAndApply(jobs);
    this.drainFulfillRetries(now);
    this.maintainStandby(now);
    this.maintainLoginBot(now);
    this.maintainVaults(now);
    if (C.CONSOLIDATION_ENABLED) this.maybeConsolidate(now);
  }

  private adoptWakes(): void {
    if (!this.wakeResults.length) return;
    const done = this.wakeResults;
    this.wakeResults = [];
    for (const { acc, client } of done) {
      if (!client) continue;
      if (acc.suspended) {
        this.log(`${acc.alias} retired during login — dropping session`);
        takeDown(this.deps, acc, "retired during login");
        continue;
      }
      acc.client = client;
      this.attachSession(acc, client);
      this.lastActive.set(acc.guid, Date.now());
    }
  }

  private attachSession(acc: BotAccount, client: GameClient): void {
    const session = new TradeSession(client, {
      coordinator: this.coordinator,
      // Somebody's property sitting on this bot (a claimed item waiting to be
      // packed, or a vault bot's own load) is never part of a pool offer.
      excludeSlot: (slot) => {
        const inst = this.tracker.instancesFor(acc.botGuid)[slot];
        return !!inst && this.ownedInstances.has(inst.instanceId);
      },
      resolveInstance: (id) => {
        for (const [slot, info] of Object.entries(this.tracker.instancesFor(acc.botGuid))) {
          if (info.instanceId === id) return { slot: Number(slot), itemId: info.itemId };
        }
        return undefined;
      },
      onOutcome: () => this.poke(),
      log: this.deps.log,
    });
    this.sessions.set(acc.guid, session);
    // Inbound tells: the site's login code capture. Outbound: queued whispers.
    client.on("packet", (p) => {
      if (p.type === "TEXT") {
        if (p.name && this.loginCodes.noteTell(p.name, p.cleanText || p.text || "")) this.deps.log(`[login] ${p.name} verified via /tell code`);
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
  }

  private refreshInventory(acc: BotAccount, client: GameClient): void {
    if (client.objectId === -1 || !client.playerData.name || !client.playerData.enchantmentsSeen) return;
    this.tracker.recordIgn(acc.botGuid, client.playerData.name);
    const inv = client.playerData.inv;
    const ench = client.playerData.enchantments;
    const hasBp = this.botCapacity(client) === 16;
    const end = hasBp ? 20 : 12;
    const slots: Record<number, { itemId: string; enchantments: number[] }> = {};
    for (let i = 4; i < end && i < inv.length; i++) {
      if (inv[i] === -1) continue;
      const cid = toCatalogId(inv[i]);
      if (cid === undefined) continue;
      slots[i] = { itemId: cid, enchantments: [...(ench[i] ?? [])] };
    }
    if (this.tracker.updateFromSlots(acc.botGuid, slots, hasBp ? 16 : 8)) {
      const n = Object.values(slots).filter((x) => x.enchantments.length).length;
      this.log(`${acc.alias} inventory refreshed — ${Object.keys(slots).length} item(s), ${n} enchanted, cap ${hasBp ? 16 : 8}`);
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
    return { botGuid: acc.botGuid, alias: acc.alias, ign, server: client.server, freeSlots: this.countFreeSlots(client), status, seasonal };
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
      const r = await this.api.claimWithdraw(plan.botGuid, plan.inventory, plan.instanceIds);
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
    if (this.isHeld(acc.guid)) return null;
    const [wantWithdraw, wantDeposit] = this.pendingKindsFor(acc, client);
    if (!wantWithdraw && !wantDeposit) {
      this.claimsSkipped++;
      return null;
    }
    const plan: ClaimPlan = { botGuid: acc.botGuid, tryWithdraw: false, tryDeposit: false, inventory: [], instanceIds: [], freeSlots: 0 };
    if (wantWithdraw) {
      plan.inventory = Object.entries(this.poolInventory(acc.botGuid)).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
      plan.instanceIds = Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId);
      plan.tryWithdraw = true;
    }
    if (wantDeposit) {
      const liveFree = this.countFreeSlots(client);
      // Personal storage: this bot's own deposits, by id, with no deferral —
      // there is no other bot that could take them.
      const pinned = liveFree > 0 ? this.lastRouting.get(client.server)?.deposits.find((d) => d.pinnedBot === acc.botGuid) : undefined;
      // A deposit whose declared items this bot gathers is its to take —
      // that is the whole point of the hint — and it names the row so the
      // site doesn't hand it the oldest one instead.
      const routed = !pinned && liveFree > 0 ? this.depositRoutedTo(acc, client) : null;
      if (pinned) {
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
      if (seasonalOf(a) !== seasonal || this.vaultBots.has(a.botGuid)) continue;
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
    acc.assignedVaultUser = a.vault ?? null;
    if (a.kind === "withdraw" && a.swap) {
      // A cross-node swap: two-way trade with another node's bot. The trade
      // machine runs its consolidation swap path; the row is closed through
      // reportSwap rather than fulfill.
      const sa = a as SiteAssignment & { kind: "withdraw" };
      this.swapAssignments.set(acc.guid, sa);
      // A guest's swap: remember what the bot held, so what arrives can be
      // told apart and attached to the guest's vault (resolveVaultAttaches).
      if (a.swap.vaultUserId != null) this.preTradeInstances.set(acc.guid, new Set(Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId)));
      const now = Date.now();
      this.lastActive.set(acc.guid, now);
      const session = this.sessionFor(acc);
      session?.setAssignment(swapAssignment(sa));
      this.log(`${acc.alias} got swap #${a.requestId} (${a.swap.role}) with ${a.ign}: gives ${items.map((i) => `${i.qty}x${i.itemId}`).join(",")}, gets ${a.swap.gets.map((i) => `${i.qty}x${i.itemId}`).join(",")}`);
      this.tradeTimeline.set(acc.guid, { claimed: now });
      if (client.gameIdValue !== GameId.nexus) {
        this.log(`${acc.alias} not in nexus (gameId=${client.gameIdValue}), sending nexus()`);
        client.nexus();
      } else if (a.swap.role === "give") {
        // Only the giver invites; the taker waits for the request.
        if (session?.sendTradeRequest()) this.tradeTimeline.get(acc.guid)!.requested = now;
        else this.log(`${acc.alias} swap request deferred (trade machine busy or partner not in view)`);
      }
      return;
    }
    if (a.kind === "deposit" && acc.assignedVaultUser !== null) {
      this.preTradeInstances.set(acc.guid, new Set(Object.values(this.tracker.instancesFor(acc.botGuid)).map((i) => i.instanceId)));
    }
    const now = Date.now();
    this.lastActive.set(acc.guid, now);
    const session = this.sessionFor(acc);
    session?.setAssignment({ kind: a.kind, requestId: a.requestId, partnerIgn: a.ign, items, itemCount: a.itemCount ?? (items.length || 1), instanceIds: a.instanceIds ?? null, acceptSkins: a.kind === "deposit" && !!a.skins });
    this.log(`${acc.alias} got ${a.kind} #${a.requestId} for ${a.ign}`);
    this.tradeTimeline.set(acc.guid, { claimed: now });
    if (client.gameIdValue !== GameId.nexus) {
      this.log(`${acc.alias} not in nexus (gameId=${client.gameIdValue}), sending nexus()`);
      client.nexus();
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
      this.swapAssignments.delete(acc.guid);
      const result = swapResult(swapRow, outcome);
      this.log(`${acc.alias} swap #${requestId} ${result.ok ? `done: gave ${result.gave.map((i) => `${i.qty}x${i.itemId}`).join(",")}, got ${result.got.map((i) => `${i.qty}x${i.itemId}`).join(",")}` : `failed: ${result.error}`}`);
      const report = this.api.reportSwap
        ? this.api.reportSwap(acc.botGuid, requestId, result)
        : result.ok ? this.api.fulfillWithdraw(acc.botGuid, requestId, result.gave, result.gaveInstanceIds) : this.api.giveUp(acc.botGuid, requestId, "withdraw");
      void report.then((r) => {
        if (!r.ok) this.log(`swap #${requestId} report failed: ${r.error}`);
      }).catch((e) => this.log(`swap #${requestId} report raised: ${String(e)}`));
      if (result.ok && swapRow.swap?.vaultUserId != null && result.got.length) {
        const before = this.preTradeInstances.get(acc.guid) ?? new Set<string>();
        const units = result.got.flatMap((g) => Array.from({ length: g.qty }, () => ({ itemId: g.itemId, enchants: 0 })));
        this.pendingVaultAttach.push({ acc, requestId, received: result.got, units, before, since: Date.now(), swapVaultUser: swapRow.swap.vaultUserId });
      }
      this.preTradeInstances.delete(acc.guid);
      this.clearAssignment(acc, session);
      this.partnerWaitSince.delete(acc.guid);
      this.lastActive.set(acc.guid, Date.now());
      this.refreshInventory(acc, client);
      if (!result.ok && result.partnerAbsent) this.disconnectAccount(acc, false);
      return;
    }

    if (kind === "consolidate_give" || kind === "consolidate_take") {
      if (outcome.ok) {
        const done = outcome.kind === "consolidate_give" || outcome.kind === "consolidate_take" ? outcome : null;
        this.log(`${acc.alias} ${kind} done${done?.swapItems?.length ? " (swap)" : ""}`);
        this.collectorHoldSince.delete(acc.guid);
        this.collectorNoteAt.delete(acc.guid);
        if (kind === "consolidate_take") this.collectorLastArrival.set(acc.guid, Date.now());
        if (kind === "consolidate_give") this.consolidationStats.done++;
        // The physical items keep their identity on the other bot.
        // The instance ids were promised to the receiving bot when the trade
        // was assigned (see driveMove): by now its inventory may already have
        // been refreshed with the new slots, which is exactly when the note
        // has to be there. Here only the site is told, for vault moves.
        const pair = this.consolidationPairs.get(requestId);
        if (pair && done && kind === "consolidate_take" && pair.instanceIds?.length) {
          void this.api.vaultMoved(pair.instanceIds, pair.taker).then((r) => {
            if (!r.ok) this.log(`vault move report failed: ${r.error}`);
          }).catch((e) => this.log(`vault move report raised: ${String(e)}`));
        }
      } else {
        this.log(`${acc.alias} ${kind} failed: ${outcome.error} — dropping, next pass replans`);
        if (kind === "consolidate_give") this.consolidationStats.failed++;
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
        const server = client.server;
        const keepOnline = C.RESIDENT_EMPTY_SERVERS.has(server) || C.QUEUE_PROTECTED_SERVERS.has(server);
        this.handRowBack(acc, client, requestId, kind, outcome.error, true, !partial);
        this.log(`${acc.alias} gave up on ${kind} #${requestId} (${outcome.error}) — partner absent, ${partial ? "remainder re-queued" : "cancelled"}; ${keepOnline ? `staying on ${server}` : "disconnecting"}`);
        if (!keepOnline) this.disconnectAccount(acc, false);
        return;
      }
      this.clearAssignment(acc, session);
      return;
    }

    if (outcome.kind === "deposit") {
      const received = outcome.received;
      const units = received.length ? outcome.receivedUnits : null;
      if (acc.assignedVaultUser !== null && received.length) {
        // Personal storage: hold the report until the tracker has seen the
        // new items, so the site learns which physical instances they are.
        const before = this.preTradeInstances.get(acc.guid) ?? new Set<string>();
        this.pendingVaultAttach.push({ acc, requestId, received, units: units ?? [], before, since: Date.now() });
      } else {
        this.reportFulfill({ kind: "deposit", botGuid: acc.botGuid, requestId, items: received, units, attempts: 0 });
      }
      this.preTradeInstances.delete(acc.guid);
    } else if (outcome.kind === "withdraw") {
      this.reportFulfill({ kind: "withdraw", botGuid: acc.botGuid, requestId, items: outcome.delivered, instanceIds: outcome.deliveredInstanceIds, attempts: 0 });
    }
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
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
    acc.assignedVaultUser = null;
  }

  /**
   * Match a finished vault deposit's units to the instances that appeared on
   * the bot since the trade, then report the fulfill with them. Same item id
   * first with the same enchant count, then any copy of the item. Whatever is
   * still unmatched after the grace period is reported without an instance
   * and the site logs it for the operator.
   */
  private resolveVaultAttaches(now: number): void {
    if (!this.pendingVaultAttach.length) return;
    for (const p of [...this.pendingVaultAttach]) {
      const current = Object.values(this.tracker.instancesFor(p.acc.botGuid)).filter((i) => !p.before.has(i.instanceId));
      const free = [...current];
      const matched: ReceivedInstance[] = [];
      for (const u of p.units) {
        let idx = free.findIndex((i) => i.itemId === u.itemId && Math.min(2, i.enchantments.length) === Math.min(2, u.enchants));
        if (idx === -1) idx = free.findIndex((i) => i.itemId === u.itemId);
        if (idx === -1) continue;
        const [inst] = free.splice(idx, 1);
        matched.push({ instanceId: inst.instanceId, itemId: inst.itemId, enchants: Math.min(2, inst.enchantments.length) });
      }
      const complete = matched.length >= p.units.length;
      const gone = !p.acc.client?.active;
      if (!complete && !gone && now - p.since < VAULT_ATTACH_MAX_MS) continue;
      if (!complete) this.log(`${p.acc.alias} vault deposit #${p.requestId}: matched ${matched.length} of ${p.units.length} received item(s) to tracker instances`);
      this.pendingVaultAttach = this.pendingVaultAttach.filter((x) => x !== p);
      if (p.swapVaultUser != null) {
        // A guest's swap: no fulfil (reportSwap closed the row); just the ownership of what arrived.
        const call = this.api.swapReceived?.(p.acc.botGuid, p.requestId, p.swapVaultUser, matched);
        void call?.then((r) => { if (!r.ok) this.log(`swap #${p.requestId} attach failed: ${r.error}`); }).catch((e) => this.log(`swap #${p.requestId} attach raised: ${String(e)}`));
        continue;
      }
      this.reportFulfill({ kind: "deposit", botGuid: p.acc.botGuid, requestId: p.requestId, items: p.received, units: p.units, instances: matched, attempts: 0 });
    }
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
      const call = giveUp ? this.api.giveUp(acc.botGuid, rid, kind) : this.api.unclaim(acc.botGuid, rid, kind);
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
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
    acc.assignedVaultUser = null;
    this.preTradeInstances.delete(acc.guid);
    this.consolidationAssignedAt.delete(acc.guid);
    this.lastActive.set(acc.guid, Date.now());
    this.lastStatus.delete(acc.botGuid);
    this.lastClaim.delete(acc.botGuid);
  }
  /** session.reset() also drops the presence view; the packet hook stays attached. */
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
    // room is what its fulfill-time "is the vault full?" check reads
    // (lib/capacity.ts), so it has to describe the whole roster — the bots
    // online at any moment are a handful out of thousands.
    void this.api.registerPool(this.accounts().length, this.freeSlotsByPool()).catch((e) => this.log(`register_pool failed: ${String(e)}`));

    const resp = await this.api.listPending();
    if (!resp.ok) return;
    this.vaultBots = new Set(resp.vaultBots ?? []);
    const vr = await this.api.listVaults();
    if (vr.ok) this.adoptVaults(vr.vaults);
    const { routing, botStates, capacity } = this.buildRouting(resp.withdraws ?? [], resp.deposits ?? []);
    const wantedServers = new Set([...routing].filter(([, r]) => r.count > 0).map(([sv]) => sv));
    this.lastWantedServers = wantedServers;
    this.lastRouting = routing;
    this.lastBotStates = botStates;
    this.lastWantedAt = Date.now();
    this.nudgeClaims(wantedServers);
    this.orderBackpackBotsFor(routing);

    if (resp.withdraws?.length || resp.deposits?.length) {
      const digest = [...routing].flatMap(([sv, r]) => r.withdraws.map((w) => `${sv}:wd${w.requestId}(cand=[${w.candidateBots.map((g) => g.slice(0, 8)).join(",")}])`)).join(" ") || "(no withdraws)";
      this.log(`supervise: routing wd=${resp.withdraws?.length ?? 0} dep=${resp.deposits?.length ?? 0} tracker-bots=${botStates.size} suspended=${this.pool.suspendedBotGuids().size} -> ${digest}`);
    }

    const online = this.online();
    const now = Date.now();
    const residentGuids = this.pickResidents(online);
    const swapHeadroom = this.onlineCap() - this.wakes.globalOnline();
    const offlineCover = swapHeadroom > 0 && this.offlineCoverAvailable(wantedServers, routing, botStates);

    for (const acc of online) {
      const client = acc.client!;
      if (acc.assignedRequestId !== null) {
        this.lastActive.set(acc.guid, now);
        continue;
      }
      const server = client.server;
      const resident = residentGuids.has(acc.guid);
      const collecting = this.isCollectingPotions(acc, client, now);
      const stranded = this.onlyCandidateForOtherServer(acc, server, routing, wantedServers);
      if (stranded) {
        this.log(`${acc.alias} on ${server} is the only bot that can fulfill stranded ${stranded} work — force-swapping now`);
        this.disconnectAccount(acc);
        continue;
      }
      if (this.isQueueing(acc, client, now)) {
        this.serverIdleSince.delete(acc.guid);
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
      const exempt = resident || this.isHeld(acc.guid) || this.standbyGuids.has(acc.guid) || acc.guid === this.loginBotGuid;
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
      const inGrace = wokeAt > 0 && now - wokeAt < C.WAKE_GRACE_S * 1000;
      if (wantedServers.has(server)) {
        if (!inGrace && !exempt && !collecting && !this.accountCanFulfill(acc, routing.get(server)!, botStates)) {
          this.log(`${acc.alias} can't fulfill any pending ${server} work — disconnecting`);
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

  private buildRouting(withdraws: PendingWithdraw[], deposits: PendingDeposit[]): { routing: Routing; botStates: BotStates; capacity: { botCount: number; totalSlots: number; usedSlots: number; full: boolean } } {
    const suspended = this.pool.suspendedBotGuids();
    // Read-only views of the tracker's maps, minus suspended bots. The per-bot
    // records are shared with the tracker and never edited here: subtractOwned
    // copies before it changes anything, and the rest only reads.
    const tracker: Record<string, Record<string, number>> = {};
    for (const [g, inv] of this.tracker.itemsView()) if (!suspended.has(g)) tracker[g] = inv as Record<string, number>;
    const caps: Record<string, number> = {};
    for (const [g, cap] of this.tracker.capacityView()) if (!suspended.has(g)) caps[g] = cap;
    const instSnap: Record<string, Readonly<Record<number, { instanceId: string }>>> = {};
    for (const [g, slots] of this.tracker.instancesView()) if (!suspended.has(g)) instSnap[g] = slots;
    // Personal property is not pool stock: a pool withdraw can't be routed
    // to it. A vault withdraw names its owner's own instances, so it is
    // matched against everything the bots hold.
    const instancesByBotAll = new Map<string, Set<string>>();
    for (const [g, slots] of Object.entries(instSnap)) instancesByBotAll.set(g, new Set(Object.values(slots).map((i) => i.instanceId)));
    for (const g of this.ownedByBot.keys()) {
      if (tracker[g]) tracker[g] = this.subtractOwned(g, tracker[g]);
    }
    const instancesByBot = new Map<string, Set<string>>();
    for (const [g, ids] of instancesByBotAll) instancesByBot.set(g, new Set([...ids].filter((id) => !this.ownedInstances.has(id))));
    const poolOf = new Map(this.accounts().map((a) => [a.botGuid, seasonalOf(a)]));
    const routing: Routing = new Map();
    const covers = (inv: Record<string, number> | undefined, items: ItemQty[]) => items.every((it) => (inv?.[it.itemId] ?? 0) >= it.qty);
    for (const w of withdraws) {
      const want = w.seasonal ?? true;
      const inPool = (g: string) => poolOf.get(g) === want;
      let candidates: string[] = [];
      if (w.instanceIds?.length) {
        if (w.targetBotGuid && inPool(w.targetBotGuid)) {
          const held = (w.vaultUserId != null ? instancesByBotAll : instancesByBot).get(w.targetBotGuid) ?? new Set();
          if (w.instanceIds.every((id) => held.has(id))) candidates = [w.targetBotGuid];
        }
      } else if (w.targetBotGuid) {
        if (inPool(w.targetBotGuid) && covers(tracker[w.targetBotGuid], w.items)) candidates = [w.targetBotGuid];
      } else {
        for (const [g, inv] of Object.entries(tracker)) if (inPool(g) && covers(inv, w.items)) candidates.push(g);
      }
      const r = routing.get(w.server) ?? { count: 0, withdraws: [], deposits: [] };
      r.withdraws.push({ requestId: w.id, items: w.items, candidateBots: candidates, seasonal: want, targetBotGuid: w.targetBotGuid ?? null, perInstance: !!w.instanceIds?.length });
      r.count++;
      routing.set(w.server, r);
    }
    for (const d of deposits) {
      // A vault deposit is pinned to the account's vault bot; one whose
      // account has no bot yet can't be served by anyone until the site
      // assigns one, so it is left out of the routing rather than waking a
      // stand-in that could never claim it.
      if (d.vaultUserId != null && !d.vaultBotGuid) continue;
      const r = routing.get(d.server) ?? { count: 0, withdraws: [], deposits: [] };
      r.deposits.push({ requestId: d.id, itemCount: d.itemCount ?? 1, seasonal: d.seasonal ?? true, pinnedBot: d.vaultUserId != null ? d.vaultBotGuid ?? null : null, ...(d.items?.length ? { items: d.items } : {}) });
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
    for (const d of r.deposits) {
      if (d.pinnedBot) targets.add(d.pinnedBot);
      else untargeted++;
    }
    return Math.max(targets.size + untargeted, 1);
  }

  private onlyCandidateForOtherServer(acc: BotAccount, current: string, routing: Routing, wanted: Set<string>): string | null {
    for (const server of wanted) {
      if (server === current || this.deps.gate.serverJamRemainingMs(server) > 0) continue;
      for (const w of routing.get(server)?.withdraws ?? []) {
        if (w.candidateBots.length === 1 && w.candidateBots[0] === acc.botGuid) return server;
      }
      for (const d of routing.get(server)?.deposits ?? []) {
        if (d.pinnedBot === acc.botGuid) return server;
      }
    }
    return null;
  }

  /** The deposits on `r` this bot could claim: its own pinned ones, or the pool's if it is a pool bot. */
  private claimableDeposits(acc: BotAccount, r: ServerRouting): RoutedDeposit[] {
    const isVault = this.vaultBots.has(acc.botGuid);
    return r.deposits.filter((d) => d.seasonal === seasonalOf(acc) && (d.pinnedBot ? d.pinnedBot === acc.botGuid : !isVault));
  }

  private accountCanFulfill(acc: BotAccount, r: ServerRouting, botStates: BotStates): boolean {
    if (r.withdraws.some((w) => w.candidateBots.includes(acc.botGuid))) return true;
    const deposits = this.claimableDeposits(acc, r);
    if (!deposits.length) return false;
    const free = botStates.get(acc.botGuid)?.freeSlots ?? 8;
    // A deposit is one trade of the size it asks for; a bot short of that
    // can't claim it. Its own vault deposits it takes with any room at all.
    return deposits.some((d) => (d.pinnedBot ? free >= 1 : free >= d.itemCount));
  }

  /**
   * Per pool half, the most free slots any bot this routing would send for a
   * deposit has: the site's deposit gate promises no more than this. Counts
   * an offline bot it could wake (not held, not in a lockout) and an online
   * idle bot it would swap or that could claim where it is; leaves out
   * suspended accounts, vault bots, and the posts it never pulls a bot from —
   * standby, resident, the login desk.
   */
  largestFreeByPool(): { seasonal: number; nonseasonal: number } {
    const out = { seasonal: 0, nonseasonal: 0 };
    const waking = this.wakes.waking();
    for (const acc of this.accounts()) {
      if (this.vaultBots.has(acc.botGuid) || this.isHeld(acc.guid)) continue;
      let free: number;
      if (acc.online) {
        if (acc.assignedRequestId !== null || this.standbyGuids.has(acc.guid) || this.residentGuids.has(acc.guid) || acc.guid === this.loginBotGuid) continue;
        // In game the trade window is sized by what the client sees, which
        // is what a claim is judged by — the tracker's memory can say 16
        // for a character the client reads as 8.
        const c = acc.client;
        free = c && c.isReady && c.objectId !== -1 ? this.countFreeSlots(c) : this.trackedFree(acc);
      } else if (waking.has(acc.guid) || this.loginBlockedMs(acc) > 0) continue;
      else free = this.trackedFree(acc);
      const key = seasonalOf(acc) ? "seasonal" : "nonseasonal";
      if (free > out[key]) out[key] = free;
    }
    return out;
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
  private orderBackpackBotsFor(routing: Routing): void {
    if (!this.orderBackpackBot) return;
    const now = Date.now();
    const seen = new Set<number>();
    const wanted = { seasonal: false, nonseasonal: false };
    const big: RoutedDeposit[] = [];
    for (const r of routing.values()) {
      for (const d of r.deposits) {
        if (d.pinnedBot || d.itemCount <= 8) continue;
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
        return !!a && seasonalOf(a) === (half === "seasonal") && !this.vaultBots.has(a.botGuid) && this.trackedFree(a) >= need;
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
    return this.claimableDeposits(acc, r).some((d) => !d.pinnedBot && liveFree >= d.itemCount);
  }

  private yieldsDepositToEmptyBot(acc: BotAccount, r: ServerRouting, botStates: BotStates, offlinePool: BotAccount[]): boolean {
    // A vault bot is the only bot for its deposits; nobody else can take them.
    if (this.vaultBots.has(acc.botGuid)) return false;
    // A collector covers the deposits routed to it (it claims those by id)
    // and nothing else: unrelated items on a collector cost its bucket the
    // room, so for any other deposit it yields like every bot carrying items.
    // It has to, or the empty bot never gets woken: the claim path makes the
    // collector wait for one, and a blanket exemption here meant the
    // supervisor saw the deposit as covered the whole time it waited.
    if (this.collectionTargets.has(acc.botGuid) && r.deposits.some((d) => d.items?.length && this.depositHome(d)?.guid === acc.guid)) return false;
    if (r.withdraws.some((w) => w.candidateBots.includes(acc.botGuid))) return false;
    if (!r.deposits.some((d) => !d.pinnedBot && d.seasonal === seasonalOf(acc))) return false;
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
    for (const d of r.deposits) if (d.pinnedBot && offlineGuids.has(d.pinnedBot)) return true;
    const unpinned = r.deposits.filter((d) => !d.pinnedBot);
    if (unpinned.length) {
      for (const a of offlinePool) {
        if (this.vaultBots.has(a.botGuid)) continue;
        const free = botStates.get(a.botGuid)?.freeSlots ?? 8;
        if (unpinned.some((d) => d.seasonal === seasonalOf(a) && free >= d.itemCount)) return true;
      }
    }
    return false;
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
      if (w.perInstance) {
        const target = w.targetBotGuid ? this.pool.byBotGuid(w.targetBotGuid)?.alias ?? w.targetBotGuid : "(none)";
        this.log(`[diag] ${server}: withdraw #${w.requestId} names physical items its pinned bot ${target} no longer holds — it will age out unless the player re-picks them`);
        continue;
      }
      const holders = [...tracker].filter(([, inv]) => w.items.every((it) => (inv[it.itemId] ?? 0) >= it.qty)).map(([g]) => g);
      if (holders.length) this.log(`[diag] ${server}: withdraw #${w.requestId} is held by ${holders.join(",")} but none is a same-pool candidate`);
      else this.log(`[diag] ${server}: no bot's tracked inventory covers withdraw #${w.requestId} — genuinely nobody holds it`);
    }
    for (const d of r.deposits) {
      const withRoom = offlinePool.filter((a) => seasonalOf(a) === d.seasonal && !this.vaultBots.has(a.botGuid) && (this.lastBotStates.get(a.botGuid)?.freeSlots ?? 8) >= d.itemCount).length;
      this.log(`[diag] ${server}: ${d.seasonal ? "seasonal" : "non-seasonal"} deposit #${d.requestId} (${d.itemCount}-slot trade) — offline ${d.seasonal ? "seasonal" : "non-seasonal"} bots with that much room: ${withRoom}`);
    }
  }

  private evictIdleToUnjam(stillOnline: BotAccount[], routing: Routing, wanted: Set<string>, botStates: BotStates, now: number): number {
    const needBy = new Map([...wanted].map((sv) => [sv, this.distinctWorkCount(routing.get(sv) ?? { count: 0, withdraws: [], deposits: [] })]));
    const keptBy = new Map<string, number>();
    const evictable: BotAccount[] = [];
    const collectors: BotAccount[] = [];
    const queueing: BotAccount[] = [];
    const residents: BotAccount[] = [];
    for (const acc of stillOnline) {
      if (acc.assignedRequestId !== null || this.standbyGuids.has(acc.guid) || acc.guid === this.loginBotGuid) continue;
      if (this.residentGuids.has(acc.guid)) {
        residents.push(acc);
        continue;
      }
      if (this.isHeld(acc.guid)) continue;
      const wokeAt = this.lastActive.get(acc.guid) ?? 0;
      if (wokeAt > 0 && now - wokeAt < C.WAKE_GRACE_S * 1000) continue;
      const server = acc.client!.server;
      const covers = !!server && wanted.has(server) && this.accountCanFulfill(acc, routing.get(server)!, botStates);
      if (covers && (keptBy.get(server) ?? 0) < (needBy.get(server) ?? 0)) {
        keptBy.set(server, (keptBy.get(server) ?? 0) + 1);
        continue;
      }
      if (this.isQueueing(acc, acc.client!, now)) queueing.push(acc);
      else if (this.isCollectingPotions(acc, acc.client!, now)) collectors.push(acc);
      else evictable.push(acc);
    }
    let shortfall = 0;
    for (const sv of wanted) shortfall += Math.max(0, (needBy.get(sv) ?? 0) - (keptBy.get(sv) ?? 0));
    const tiers = [...evictable, ...collectors, ...queueing, ...residents];
    if (shortfall <= 0 || !tiers.length) return 0;
    let evicted = 0;
    for (const acc of tiers.slice(0, shortfall)) {
      const server = acc.client!.server || "?";
      const why = residents.includes(acc) ? `living on ${server}, but it's the last slot that can be freed and a player is waiting`
        : queueing.includes(acc) ? `still queueing on ${server} but no ordinary idle bot left to free`
        : collectors.includes(acc) ? `collecting potions on ${server}, but a player needs the slot`
        : `idle on ${server} and surplus to need`;
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
    for (const acc of offline) {
      if (withdrawCandidates.has(acc.botGuid) && this.wakeSpecificAccount(acc, server)) {
        this.log(`chose ${acc.alias} for withdraw coverage on ${server}`);
        return true;
      }
    }
    // Personal storage: the account's own bot, nobody else.
    for (const d of r.deposits) {
      if (!d.pinnedBot) continue;
      const acc = offline.find((a) => a.botGuid === d.pinnedBot);
      if (acc && this.wakeSpecificAccount(acc, server)) {
        this.log(`chose ${acc.alias} for vault deposit #${d.requestId} on ${server} — it is the account's own bot`);
        return true;
      }
    }
    const poolsNeeded = new Set(r.deposits.filter((d) => !d.pinnedBot && d.itemCount > 0).map((d) => d.seasonal));
    for (const d of r.deposits) {
      if (!d.items?.length) continue;
      const home = this.depositHome(d);
      if (!home || home.online || this.isHeld(home.guid) || waking.has(home.guid)) continue;
      if (this.trackedFree(home) < d.itemCount) continue;
      if (this.wakeSpecificAccount(home, server)) {
        this.log(`chose ${home.alias} for deposit #${d.requestId} on ${server} — it gathers what the player is bringing`);
        return true;
      }
    }
    if (poolsNeeded.size) {
      // A bot is worth waking only if some pending deposit's trade fits its
      // free slots. Among those, the ones that fit the biggest request
      // waiting come first, then the least loaded, then the tightest fit —
      // so an empty backpack bot is not spent on an 8-slot trade while a
      // plain empty bot could take it and a 16-slot trade is waiting.
      const unpinned = r.deposits.filter((d) => !d.pinnedBot);
      const scored: [number, number, number, BotAccount][] = [];
      for (const acc of offline) {
        if (this.vaultBots.has(acc.botGuid) || !poolsNeeded.has(seasonalOf(acc))) continue;
        const st = botStates.get(acc.botGuid);
        const free = st?.freeSlots ?? 8;
        const held = st?.itemsHeld ?? 0;
        const mine = unpinned.filter((d) => d.seasonal === seasonalOf(acc));
        if (!mine.some((d) => free >= d.itemCount)) continue;
        const biggest = Math.max(...mine.map((d) => d.itemCount));
        scored.push([free >= biggest ? 0 : 1, held, free, acc]);
      }
      scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      for (const [, held, free, acc] of scored) {
        if (this.wakeSpecificAccount(acc, server)) {
          this.log(`chose ${acc.alias} for ${seasonalOf(acc) ? "seasonal" : "non-seasonal"} deposit (${free} free slots, ${held} held) on ${server}`);
          if (held === 0) this.emptyWakeFor.set(server, [acc.guid, Date.now(), seasonalOf(acc)]);
          return true;
        }
      }
    }
    // Nothing else is worth a login. A bot that is neither a candidate for one
    // of this server's withdraws nor a same-pool bot with a free slot for one
    // of its deposits cannot claim anything here — the site's claim filters
    // are exactly those two tests — so the old "any same-pool bot" fallback
    // only ever bought a wasted login: the bot landed, failed
    // accountCanFulfill, was dropped, and because it never counted as
    // coverage the next pass woke another. With a withdraw's only candidate
    // sitting out a 20s login cooldown that was a fresh useless login every
    // pass until the online cap was full of them.
    if (!offline.length && this.accounts().length < this.onlineCap()) {
      const now = Date.now();
      if (now - this.wakes.lastPullAt >= C.ACCOUNTGEN_PULL_COOLDOWN_S * 1000) {
        this.wakes.lastPullAt = now;
        const want = poolsNeeded.size ? [...poolsNeeded][0] : true;
        const acc = await pullAccount(this.pool, { server, seasonal: want });
        if (acc && this.wakeSpecificAccount(acc, server)) {
          this.log(`pulled ${acc.alias} from accountgen for ${server}`);
          return true;
        }
      }
    }
    this.log(`no eligible offline bot for ${server} (capacity ${capacity.usedSlots}/${capacity.totalSlots}) — leaving work pending`);
    return false;
  }

  private wakeSpecificAccount(acc: BotAccount, server: string): boolean {
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
    return this.wakes.start(acc, server, (r) => {
      this.wakeResults.push(r);
      this.poke();
    }, this.deps.log);
  }

  private disconnectAccount(acc: BotAccount, unclaim = true, keepMoves = false): void {
    if (!acc.client) return;
    const strandedReq = acc.assignedRequestId;
    const strandedKind = acc.assignedKind;
    const session = this.sessions.get(acc.guid);
    session?.detach();
    this.sessions.delete(acc.guid);
    takeDown(this.deps, acc, "supervisor disconnect");
    acc.client = null;
    for (const m of [this.lastHeartbeat, this.lastClaim, this.lastStatus]) m.delete(acc.botGuid);
    for (const m of [this.tradeTimeline, this.consolidationAssignedAt, this.partnerWaitSince, this.collectorHoldSince, this.collectorNoteAt, this.collectorLastArrival, this.serverIdleSince, this.swapYieldNote, this.notInWorldSince]) m.delete(acc.guid);
    if (unclaim && strandedReq !== null && (strandedKind === "deposit" || strandedKind === "withdraw")) {
      void this.api.unclaim(acc.botGuid, strandedReq, strandedKind).then((r) => {
        if (r.ok) this.log(`${acc.alias} disconnected mid-${strandedKind} #${strandedReq} — unclaimed=${r.unclaimed}`);
        else this.log(`${acc.alias} unclaim of ${strandedKind} #${strandedReq} failed: ${r.error}`);
      }).catch((e) => this.log(`${acc.alias} unclaim raised: ${String(e)}`));
    }
    acc.assignedRequestId = null;
    acc.assignedKind = null;
    acc.assignedPartnerIgn = null;
    acc.assignedVaultUser = null;
    this.preTradeInstances.delete(acc.guid);
    if (!keepMoves) this.releaseMovesFor(acc.guid, `${acc.alias} disconnected during setup`);
    this.coordinator.releaseAllFor(acc.guid);
  }

  // --- residency, queues, standby, login desk ---------------------------------

  private isResidentEmpty(acc: BotAccount, client: GameClient): boolean {
    if (!C.RESIDENT_EMPTY_SERVERS.size || !C.RESIDENT_EMPTY_SERVERS.has(client.server)) return false;
    if (acc.assignedRequestId !== null || client.objectId === -1) return false;
    return this.countFreeSlots(client) >= this.botCapacity(client);
  }

  private pickResidents(online: BotAccount[]): Set<string> {
    if (!C.RESIDENT_EMPTY_SERVERS.size) {
      this.residentGuids = new Set();
      return this.residentGuids;
    }
    const byServer = new Map<string, BotAccount[]>();
    for (const acc of online) {
      if (acc.client && this.isResidentEmpty(acc, acc.client)) {
        const sv = acc.client.server;
        if (!byServer.has(sv)) byServer.set(sv, []);
        byServer.get(sv)!.push(acc);
      }
    }
    const budget = Math.max(1, Math.floor(this.onlineCap() / 2));
    const held = new Set<string>();
    for (const server of [...byServer.keys()].sort()) {
      const accs = byServer.get(server)!;
      accs.sort((a, b) => Number(!this.standbyGuids.has(a.guid)) - Number(!this.standbyGuids.has(b.guid)) || (a.guid < b.guid ? -1 : 1));
      const room = budget - held.size;
      const limit = C.RESIDENT_MAX_PER_SERVER <= 0 ? room : Math.min(C.RESIDENT_MAX_PER_SERVER, room);
      const keep = accs.slice(0, Math.max(0, limit));
      for (const a of keep) held.add(a.guid);
      if (this.residentCounts.get(server) !== keep.length) {
        this.residentCounts.set(server, keep.length);
        const over = accs.length - keep.length;
        this.log(`${keep.length} empty bot(s) living on ${server}${over ? ` (${over} over the bound, back on the normal rules)` : ""}`);
      }
    }
    for (const sv of [...this.residentCounts.keys()]) {
      if (!byServer.has(sv)) {
        this.residentCounts.delete(sv);
        this.log(`no empty bots left on ${sv}`);
      }
    }
    this.residentGuids = held;
    return held;
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

  private isQueueing(acc: BotAccount, client: GameClient, now: number): boolean {
    if (!C.QUEUE_PROTECTED_SERVERS.size || !client.active || !C.QUEUE_PROTECTED_SERVERS.has(client.server)) return false;
    if (client.objectId !== -1) return false;
    const wokeAt = this.lastActive.get(acc.guid) ?? 0;
    const waited = wokeAt > 0 ? now - wokeAt : 0;
    if (waited > C.QUEUE_PROTECT_MAX_S * 1000) {
      if (now - (this.queueNoteAt.get(acc.guid) ?? 0) >= C.QUEUE_LOG_INTERVAL_S * 1000) {
        this.queueNoteAt.set(acc.guid, now);
        this.log(`${acc.alias} still not in-world on ${client.server} after ${Math.floor(s(waited))}s — dropping queue protection`);
      }
      return false;
    }
    if (!client.inLoginQueue()) return wokeAt > 0 && waited <= C.QUEUE_PROTECT_WARMUP_S * 1000;
    if (now - (this.queueNoteAt.get(acc.guid) ?? 0) >= C.QUEUE_LOG_INTERVAL_S * 1000) {
      this.queueNoteAt.set(acc.guid, now);
      this.log(`${acc.alias} holding its place in the ${client.server} queue at ${client.queuePos}/${client.queueMax} (${Math.floor(s(waited))}s) — not recycling it`);
    }
    return true;
  }

  private isStandbyReady(acc: BotAccount): boolean {
    const c = acc.client;
    if (!c || !c.active || !c.isReady || c.objectId === -1 || !c.playerData.name) return false;
    if (acc.assignedRequestId !== null) return false;
    return this.countFreeSlots(c) >= C.FULL_DEPOSIT_SLOTS;
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
        if (r && (r.withdraws.some((w) => w.targetBotGuid === acc.botGuid) || r.deposits.some((d) => d.pinnedBot === acc.botGuid))) return sv;
      }
    }
    for (const sv of C.LOGIN_DESK_SERVERS) if (this.deps.gate.serverJamRemainingMs(sv) <= 0) return sv;
    const home = acc.info.server ?? "";
    if (home && !C.LOGIN_DESK_AVOID_SERVERS.has(home)) return home;
    return C.LOGIN_DESK_SERVERS[0] ?? "";
  }

  private maintainLoginBot(now: number): void {
    const canStaff = (acc: BotAccount) => this.inWorld(acc) && !C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server);
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
    // A bot that is connected but still loading its character (any realm,
    // not only the queue-protected ones) will staff the desk in a moment;
    // waking a second one just puts two bots on the same post.
    for (const acc of this.online()) {
      const c = acc.client!;
      if (c.objectId !== -1 || C.LOGIN_DESK_AVOID_SERVERS.has(c.server)) continue;
      const wokeAt = this.lastActive.get(acc.guid) ?? 0;
      if (wokeAt > 0 && now - wokeAt <= C.QUEUE_PROTECT_WARMUP_S * 1000) return;
    }
    for (const acc of this.online()) if (this.isQueueing(acc, acc.client!, now) && !C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server)) return;
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
    const candidates = this.offline()
      // A held account is somebody else's for now (a maintenance trip about to log it in).
      .filter((a) => !a.inUse && !this.isHeld(a.guid) && !this.vaultBots.has(a.botGuid) && this.deps.gate.lockoutRemainingMs(a.guid) <= 0)
      .map((a) => [a, this.tracker.heldCount(a.botGuid)] as const)
      .sort((x, y) => x[1] - y[1]);
    for (const [acc] of candidates) {
      const server = this.loginDeskServer(acc);
      if (!server) return;
      if (this.wakeSpecificAccount(acc, server)) {
        this.loginBotGuid = acc.guid;
        this.log(`woke ${acc.alias} on ${server} to keep the login desk staffed`);
        return;
      }
    }
  }

  /** The bot the site should name in "/tell <bot> <code>", or null. */
  electLoginBot(): { acc: BotAccount; ign: string } | null {
    const igns = this.tracker.ignsSnapshot();
    const tellName = (acc: BotAccount): string => {
      if (!this.inWorld(acc) || C.LOGIN_DESK_AVOID_SERVERS.has(acc.client!.server)) return "";
      return acc.client!.playerData.name || igns[acc.botGuid] || "";
    };
    if (this.loginDeskElected) {
      const inc = this.pool.byGuid(this.loginDeskElected);
      const name = inc ? tellName(inc) : "";
      if (inc && name) return { acc: inc, ign: name };
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
    this.deps.log(`[login] elected login-desk bot ${chosen.ign}`);
    return chosen;
  }

  private maintainStandby(now: number): void {
    if (!this.standby.size) return;
    const waking = this.wakes.waking();
    for (const [guid, [server, wokenAt]] of [...this.standbyWaking]) {
      const acc = this.pool.byGuid(guid);
      const online = !!acc && acc.online;
      if (waking.has(guid)) continue;
      if (!acc || !online) this.standbyWaking.delete(guid);
      else if (this.isStandbyReady(acc)) this.standbyWaking.delete(guid);
      else if (this.isQueueing(acc, acc.client!, now)) continue;
      else if (now - wokenAt > C.STANDBY_WAKE_GRACE_S * 1000) {
        this.log(`${acc.alias} never reached standby on ${server} within ${C.STANDBY_WAKE_GRACE_S}s — releasing the post`);
        this.standbyWaking.delete(guid);
      }
    }
    if (this.hold.active) return;
    const holding = new Set<string>();
    const label = (x: boolean | null) => (x === null ? "any" : x ? "seasonal" : "non-seasonal");
    for (const [server, buckets] of this.standby) {
      for (const [seasonality, want] of buckets) {
        if (this.deps.gate.serverJamRemainingMs(server) > 0) continue;
        const ready = this.online().filter((a) => a.client!.server === server && this.isStandbyReady(a) && (seasonality === null || seasonalOf(a) === seasonality)).sort((a, b) => (a.guid < b.guid ? -1 : 1));
        for (const a of ready.slice(0, want)) holding.add(a.guid);
        const inflight = [...this.standbyWaking].filter(([g, [sv]]) => sv === server && (seasonality === null || seasonalOf(this.pool.byGuid(g)!) === seasonality)).map(([g]) => g);
        for (const g of inflight) holding.add(g);
        const missing = want - ready.length - inflight.length;
        if (missing <= 0) continue;
        if (this.onlineCap() - this.wakes.globalOnline() <= C.CONSOLIDATION_WAKE_RESERVE) return;
        const heldOf = (a: BotAccount) => this.tracker.heldCount(a.botGuid);
        const asleep = this.offline().filter((a) => !this.vaultBots.has(a.botGuid) && !this.standbyWaking.has(a.guid) && !waking.has(a.guid) && (seasonality === null || seasonalOf(a) === seasonality));
        const offline = asleep.filter((a) => this.tracker.capacityFor(a.botGuid) - heldOf(a) >= C.FULL_DEPOSIT_SLOTS).sort((a, b) => heldOf(a) - heldOf(b) || (a.guid < b.guid ? -1 : 1));
        if (!offline.length) {
          if (now - this.lastStandbyStarvedLog > C.STANDBY_STARVED_LOG_S * 1000) {
            this.lastStandbyStarvedLog = now;
            this.log(`can't fill ${label(seasonality)} standby on ${server} (${ready.length}/${want} held): ${asleep.length ? "every offline account is carrying too much" : "the whole pool is already online"}`);
          }
          continue;
        }
        for (const acc of offline) {
          if (this.wakeSpecificAccount(acc, server)) {
            this.log(`waking ${acc.alias} as ${label(seasonality)} standby on ${server} (${ready.length} ready + ${inflight.length} inflight / ${want})`);
            this.standbyWaking.set(acc.guid, [server, now]);
            holding.add(acc.guid);
            break;
          }
        }
      }
    }
    this.standbyGuids = holding;
  }

  private async maintainCapacity(): Promise<void> {
    if (this.freeSlotsTarget <= 0) return;
    const now = Date.now();
    if (now - this.wakes.lastPullAt < C.ACCOUNTGEN_PULL_COOLDOWN_S * 1000) return;
    this.pool.reload();
    const free = this.freeSlotsByPool();
    this.wakes.lastPullAt = now;
    const want = free.nonseasonal < this.freeSlotsTarget ? false : true;
    // The seasonal side has no bound unless SEASONAL_FREE_SLOTS_TARGET gives
    // one; with one, a pool that has the room pulls nothing, accountgen's
    // ready stock fills up and its mint and walk workers go idle.
    const seasonalBound = C.SEASONAL_FREE_SLOTS_TARGET;
    if (want && seasonalBound > 0 && free.seasonal >= seasonalBound) return;
    const acc = await pullAccount(this.pool, { seasonal: want });
    const why = want ? (seasonalBound > 0 ? `seasonal, ${free.seasonal}/${seasonalBound} free slots` : "seasonal, unbounded") : `non-seasonal, ${free.nonseasonal}/${this.freeSlotsTarget} free slots`;
    if (acc) this.log(`capacity: pulled ${acc.alias} (${why}) from accountgen (pool now ${this.accounts().length})`);
  }

  /** Free trade slots per pool across every usable account on the roster:
   *  tracked bots by capacity minus items held, never-tracked ones the
   *  conservative 8 — the same universe the site's capacity gate counts. */
  private freeSlotsByPool(): PoolRoom {
    const free: PoolRoom = { seasonal: 0, nonseasonal: 0 };
    for (const acc of this.accounts()) {
      if (this.vaultBots.has(acc.botGuid)) continue;
      const room = this.tracker.capacityFor(acc.botGuid) - this.tracker.heldCount(acc.botGuid);
      free[seasonalOf(acc) ? "seasonal" : "nonseasonal"] += Math.max(0, room);
    }
    return free;
  }

  // --- potion consolidation --------------------------------------------------------

  /** The bots consolidation may touch, by botGuid. Cheap: no inventories. */
  private consolidationAccounts(): Map<string, BotAccount> {
    const suspended = this.pool.suspendedBotGuids();
    const fleet = new Map<string, BotAccount>();
    // Vault bots hold one account's property: the potion planner never
    // touches them, as giver or taker.
    for (const acc of this.accounts()) if (!suspended.has(acc.botGuid) && !this.vaultBots.has(acc.botGuid)) fleet.set(acc.botGuid, acc);
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
      inventories[g] = this.ownedByBot.has(g) ? this.subtractOwned(g, inv) : inv;
      // An online bot's capacity is known for sure. An offline bot's comes
      // from the tracker, which char/list feeds at every login and the audit
      // seeds; a wrong 16 costs one wake (the live re-check abandons the move
      // and noteFull corrects the tracker), so 16-slot bots are planned at 16
      // even while asleep — that is what a backpack is for.
      const c = acc.client;
      if (c?.active && c.connected && c.objectId !== -1) caps[g] = this.botCapacity(c);
      else caps[g] = this.tracker.capacityFor(g);
      // Personal property is not pool stock, but it still sits in a slot:
      // without this a vault bot at 8/8 looked like an empty collector and was
      // planned onto, woken and abandoned over and over (2026-09-07).
      const owned = this.ownedByBot.get(g)?.length ?? 0;
      if (owned) caps[g] = Math.max(0, caps[g] - owned);
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
    if (c.gameIdValue !== GameId.nexus || acc.assignedRequestId !== null) return false;
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
   * a vault bot at 8/8 woken every 80 s).
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
    const next = (this.lastRouting.get(client.server)?.deposits ?? []).find((d) => !d.pinnedBot && d.seasonal === seasonalOf(acc));
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
    for (const m of [...this.pendingMoves]) if (m.kind !== "vault") this.driveMove(m, now, fleet);
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
      if (committed.has(g) || acc.assignedRequestId !== null || this.standbyGuids.has(acc.guid) || acc.guid === this.loginBotGuid) continue;
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
    for (const acc of [taker, giver]) {
      const client = acc.client;
      const online = !!client && client.active;
      if (online && client!.server && client!.server !== move.server) {
        // An idle bot parked on another server can be brought over: drop it
        // here and the wake below logs it in where the move is. Once only,
        // and never a bot with a post to keep.
        const pinned = this.residentGuids.has(acc.guid) || this.standbyGuids.has(acc.guid) || acc.guid === this.loginBotGuid || this.isQueueing(acc, client!, now);
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
        if (!this.consolidationWakeAllowed()) return;
        if (this.wakeSpecificAccount(acc, move.server)) move.woken.add(acc.guid);
        return;
      }
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
    if (!holds(giver, move.items)) {
      this.releaseMove(move, `${giver.alias} no longer holds what it was to give`, [giver.guid]);
      return;
    }
    if (move.instanceIds && !move.instanceIds.every((id) => this.tracker.holderOf(id) === giver.botGuid)) {
      this.releaseMove(move, `${giver.alias} no longer holds every item of the vault move`, [giver.guid]);
      return;
    }
    if (move.instanceIds && this.anyReservedNow(move.instanceIds)) {
      // A withdraw was opened for one of these while the bots were logging
      // in; it is pinned to the bot that holds the item now, so the item
      // stays put and the withdraw is served from here.
      this.releaseMove(move, "an item of the vault move was reserved by a withdraw meanwhile");
      return;
    }
    if (back && !holds(taker, move.swapItems)) {
      this.releaseMove(move, `${taker.alias} no longer holds its side of the swap`, [taker.guid]);
      return;
    }
    this.consolidationSeq--;
    const pairId = this.consolidationSeq;
    this.consolidationPairs.set(pairId, { giver: giver.botGuid, taker: taker.botGuid, ...(move.instanceIds ? { instanceIds: [...move.instanceIds] } : {}) });
    for (const id of [...this.consolidationPairs.keys()]) if (id > pairId + 200) this.consolidationPairs.delete(id);
    const giverIgn = giver.client!.playerData.name;
    const takerIgn = taker.client!.playerData.name;
    this.assignConsolidation(taker, "consolidate_take", pairId, giverIgn, move.items, move.swapItems);
    this.assignConsolidation(giver, "consolidate_give", pairId, takerIgn, move.items, move.swapItems, move.instanceIds ?? null);
    // Promise the receiving bot the giver's instance ids NOW, while the giver
    // still lists them and before the taker's inventory can be refreshed with
    // the new slots. Noting this on the outcome came too late: the refresh
    // ran first in the same tick and minted fresh ids, and the identity a
    // per-instance withdraw or a vault record was pinned to was gone.
    if (move.instanceIds) this.tracker.noteTransferInstances(giver.botGuid, taker.botGuid, move.instanceIds);
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

  // --- personal storage --------------------------------------------------------------

  /** The site's list of vaults, indexed for the pass: every owned instance, and who holds each right now. */
  private adoptVaults(vaults: FleetVault[]): void {
    this.vaults = vaults;
    const owned = new Set<string>();
    const byBot = new Map<string, { instanceId: string; itemId: string }[]>();
    for (const v of vaults) {
      for (const it of v.items) {
        owned.add(it.instanceId);
        const holder = this.tracker.holderOf(it.instanceId) ?? it.botGuid;
        if (!holder) continue;
        const list = byBot.get(holder) ?? [];
        list.push({ instanceId: it.instanceId, itemId: it.itemId });
        byBot.set(holder, list);
      }
    }
    this.ownedInstances = owned;
    this.ownedByBot = byBot;
  }

  /** Any of these instances named by an open withdraw, per the last vault list. */
  private anyReservedNow(instanceIds: string[]): boolean {
    const want = new Set(instanceIds);
    for (const v of this.vaults) for (const it of v.items) if (it.reserved && want.has(it.instanceId)) return true;
    return false;
  }

  /** `inv` minus the owned items sitting on `botGuid`. */
  private subtractOwned(botGuid: string, inv: Record<string, number>): Record<string, number> {
    const owned = this.ownedByBot.get(botGuid);
    if (!owned?.length) return inv;
    const out = { ...inv };
    for (const o of owned) {
      const left = (out[o.itemId] ?? 0) - 1;
      if (left > 0) out[o.itemId] = left;
      else delete out[o.itemId];
    }
    return out;
  }

  /** What of this bot's load is the pool's to offer. */
  private poolInventory(botGuid: string): Record<string, number> {
    return this.subtractOwned(botGuid, this.tracker.itemsFor(botGuid));
  }

  /**
   * Pack each account's items onto its own bot: for every owned item the
   * tracker sees on some other bot, one instance-exact give from that bot to
   * the vault bot, driven like a consolidation move (wake both, meet in the
   * nexus, the vault bot accepts first). Items named by an open withdraw stay
   * where they are; the withdraw is pinned to their current bot.
   */
  private maintainVaults(now: number): void {
    for (const m of [...this.pendingMoves]) {
      if (m.kind !== "vault") continue;
      const g = this.pool.byBotGuid(m.giver);
      const t = this.pool.byBotGuid(m.taker);
      const pair = new Map<string, BotAccount>();
      if (g) pair.set(g.botGuid, g);
      if (t) pair.set(t.botGuid, t);
      this.driveMove(m, now, pair);
    }
    if (!this.vaults.length || this.hold.active) return;
    if (now - this.lastVaultPlan < C.VAULT_PACK_INTERVAL_S * 1000) return;
    this.lastVaultPlan = now;
    let active = this.pendingMoves.filter((m) => m.kind === "vault").length;
    if (active >= C.VAULT_PACK_MAX_CONCURRENT) return;
    const busy = this.busyWithConsolidation();
    for (const v of this.vaults) {
      if (!v.botGuid) continue;
      const taker = this.pool.byBotGuid(v.botGuid);
      if (!taker || taker.suspended || busy.has(taker.botGuid) || taker.assignedRequestId !== null) continue;
      if ((this.moveBackoff.get(taker.guid) ?? 0) > now) continue;
      const byHolder = new Map<string, { instanceId: string; itemId: string }[]>();
      for (const it of v.items) {
        if (it.reserved) continue;
        const holder = this.tracker.holderOf(it.instanceId);
        if (!holder || holder === v.botGuid) continue;
        const list = byHolder.get(holder) ?? [];
        list.push(it);
        byHolder.set(holder, list);
      }
      for (const [holderGuid, items] of byHolder) {
        const giver = this.pool.byBotGuid(holderGuid);
        if (!giver || giver.suspended || busy.has(giver.botGuid) || giver.assignedRequestId !== null) continue;
        if ((this.moveBackoff.get(giver.guid) ?? 0) > now) continue;
        const room = this.trackedFree(taker);
        const batch = items.slice(0, Math.max(0, Math.min(items.length, room, 8)));
        if (!batch.length) continue;
        const server = this.consolidationServerFor(giver, taker);
        if (!server) continue;
        const counts: Record<string, number> = {};
        for (const it of batch) counts[it.itemId] = (counts[it.itemId] ?? 0) + 1;
        const pending: PendingMove = {
          giver: giver.botGuid, taker: taker.botGuid,
          items: Object.entries(counts).sort().map(([itemId, qty]) => ({ itemId, qty })), swapItems: [],
          stat: "vault", kind: "vault", score: 0, reason: `packing ${batch.length} item(s) for account ${v.userId}`, server, since: now, readySince: null,
          holdGuids: new Set([giver.guid, taker.guid]), woken: new Set(), hopped: new Set(), instanceIds: batch.map((i) => i.instanceId),
        };
        this.pendingMoves.push(pending);
        for (const h of pending.holdGuids) this.consolidationHolds.add(h);
        busy.add(giver.botGuid);
        busy.add(taker.botGuid);
        this.log(`vault: packing ${batch.length} item(s) ${giver.alias} -> ${taker.alias} on ${server} for account ${v.userId}`);
        this.driveMove(pending, now, new Map([[giver.botGuid, giver], [taker.botGuid, taker]]));
        active++;
        break;
      }
      if (active >= C.VAULT_PACK_MAX_CONCURRENT) return;
    }
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

interface HeartbeatPayload {
  botGuid: string;
  alias: string;
  ign: string;
  server: string;
  freeSlots: number;
  status: "idle" | "busy" | "offline";
  seasonal: boolean;
}
interface ClaimPlan {
  botGuid: string;
  tryWithdraw: boolean;
  tryDeposit: boolean;
  inventory: ItemQty[];
  instanceIds: string[];
  freeSlots: number;
  /** A hinted deposit this bot gathers: ask the site for that row. */
  preferRequestId?: number;
}
export interface ConsolidationStatus {
  enabled: boolean;
  swaps: boolean;
  maxPairs: number;
  pools: { seasonal: boolean; fragmentation: Fragmentation | null; collectors: Record<string, string[]>; roles: Record<string, string>; split: string[] }[];
  pending: { giver: string; taker: string; kind: MoveKind | "vault"; stat: string; items: Record<string, number>; swapItems: Record<string, number>; server: string; ageS: number; readyS: number | null; score: number; reason: string }[];
  lastPlan: { giver: string; taker: string; kind: MoveKind; stat: string; items: Record<string, number>; swapItems: Record<string, number>; score: number; reason: string }[];
  stats: ConsolidationStats;
}
export type { Outcome };
