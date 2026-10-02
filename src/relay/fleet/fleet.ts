// Composition root: one Fleet per process owns the roster, tracker, proxy
// pool, login gate, wake scheduler and the dispatcher.
import fs from "node:fs";
import path from "node:path";
import type { GameClient } from "../client/gameClient";
import { PartnerCoordinator } from "../trade/tradeMachine";
import { BotPool } from "./botPool";
import type { FleetDeps } from "./bringUp";
import { Dispatcher } from "./dispatcher";
import { InventoryTracker } from "./inventoryTracker";
import { LoginGate } from "./loginGate";
import { ProxyPool, proxySourceFromEnv, type ProxySource } from "./proxyPool";
import { GameVersion } from "../realm/gameVersion";
import { HttpSiteApi, type SiteApi } from "./siteApi";
import { LoginCodes, PoolSettings, TradeHold, WhisperQueue } from "./stores";
import { startupSweep } from "./sweeps";
import { BackpackService, BackpackStore } from "./backpacks";
import { StorageService, StorageStore } from "./storage";
import type { SweepDeps } from "./sweeps";
import type { BotAccount } from "./botPool";
import type { BringUpVerdict } from "./bringUp";
import { SeasonWatch } from "./seasonWatch";
import { ServerUsageWatch } from "./serverUsageWatch";
import { WakeScheduler } from "./wakes";
import { ServerList } from "../realm/serverList";
import { BuildGate } from "./buildGate";
import { Telemetry } from "./telemetry";
import { advancedFor, NodeSettingsStore } from "../../node/settings";
import { HubClient } from "../../node/hub";
import { RealmLoginRunner } from "../../node/realmLogins";
import { SetupService } from "../../node/setup";
import type { NodeStatusWire } from "../../shared/hubWire";
import { LOGIN_DESK_SERVERS, onlineCapFor } from "./constants";
import { takeDown } from "./bringUp";

/** Log lines kept in memory for the control panel. */
const LOG_KEEP = 5000;

export interface FleetOptions {
  dataDir: string;
  /** Where the exit-IP list the console saves lives (PROXIES_FILE). */
  proxies: ProxySource;
  /** Pinned build string; ignored when `versions` is given. */
  buildVersion: string;
  /** Live build source (feed-following); defaults to a pin on `buildVersion`. */
  versions?: GameVersion;
  /** The site's queue client; without one no dispatcher runs. */
  api?: SiteApi;
  log?: (line: string) => void;
  /** Test hook, forwarded to FleetDeps. */
  bringUp?: FleetDeps["bringUp"];
  /** Called whenever the tracker's revision moves. */
  onPoolChanged?: () => void;
  /** Node-level settings (telemetry opt-in, known builds); defaults to `<dataDir>/node.json`. */
  nodeSettings?: NodeSettingsStore;
  /** What telemetry reports as the node version. */
  nodeVersion?: string;
  /** Instances the site has spoken for (open picks, posted offers, hand-overs): the storage chores and consolidation leave them where they are. */
  reserved?: () => Set<string>;
}

export class Fleet {
  readonly dataDir: string;
  readonly log: (line: string) => void;
  private readonly recent: { at: number; line: string }[] = [];
  /** The newest `n` log lines, oldest first. */
  /** The newest `n` log lines, every one kept by default. */
  logTail(n = LOG_KEEP): { at: number; line: string }[] {
    return this.recent.slice(-Math.max(1, Math.min(n, LOG_KEEP)));
  }
  readonly pool: BotPool;
  readonly settings: PoolSettings;
  readonly tracker: InventoryTracker;
  readonly proxies: ProxyPool;
  readonly gate: LoginGate;
  readonly versions: GameVersion;
  readonly clients = new Map<string, GameClient>();
  readonly deps: FleetDeps;
  readonly wakes: WakeScheduler;
  readonly hold = new TradeHold();
  readonly coordinator = new PartnerCoordinator();
  readonly loginCodes = new LoginCodes();
  readonly whispers = new WhisperQueue();
  readonly dispatcher: Dispatcher | null;
  /** Backpack audit + chore (docs/relay/BACKPACKS.md). */
  readonly backpacks: BackpackService;
  /** Account storage: vault chests, potion rack, gift and spoils chests (docs/relay/STORAGE.md). */
  readonly storage: StorageService;
  /** Follows Realm's season clock; marks every account non-seasonal when a season ends. */
  readonly seasonWatch: SeasonWatch;
  /** Follows Realm's per-server load and reports it to the site, which gates trades on it. */
  readonly serverUsage: ServerUsageWatch;
  /** Realm's server addresses, refreshed from account/servers (design doc §8). */
  readonly servers: ServerList;
  /** Refuses logins on a Realm build this node has not seen work (design doc §8). */
  readonly buildGate: BuildGate;
  /** Opt-in suspension reports to the hub (design doc §8). */
  readonly telemetry: Telemetry;
  readonly nodeSettings: NodeSettingsStore;
  /** Connected mode: linked hub, heartbeats, version feed (design doc §4.3). */
  readonly hub: HubClient;
  /** The hub's login node duty: sign-in codes whispered to this node's login desk (idle unless the hub names this node). */
  readonly realmLogins: RealmLoginRunner;
  /** The first-run setup (the desktop app's wizard): its steps, the proxy check, the test login. */
  readonly setup: SetupService;
  /** What this node reports as its version (the app's, ROTMGTRADE_VERSION). */
  readonly nodeVersion: string;
  readonly startedAt = Date.now();
  /** Facts the embedding process adds to the node card the hub shows (trades with players, the login desk): they need the site's database, which the fleet does not hold. */
  hubStatusExtra: (() => Partial<NodeStatusWire>) | null = null;
  /** What the sweeps and the maintenance services need (backpacks, storage, a new account's first look). */
  readonly sweepDeps: SweepDeps;
  private started = false;

  constructor(opts: FleetOptions) {
    this.dataDir = opts.dataDir;
    const sink = opts.log ?? ((l: string) => console.log(l));
    // The last lines, for the control panel (GET /node/log): what the console shows, kept in memory only.
    this.log = (l: string) => {
      this.recent.push({ at: Date.now(), line: l });
      if (this.recent.length > LOG_KEEP) this.recent.splice(0, this.recent.length - LOG_KEEP);
      sink(l);
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.pool = BotPool.at(this.dataDir);
    this.settings = PoolSettings.at(this.dataDir);
    this.tracker = InventoryTracker.at(this.dataDir);
    {
      const stale = this.tracker.pruneTo(new Set(this.pool.every().map((a) => a.botGuid)));
      if (stale.length) this.log(`tracker: dropped ${stale.length} bot(s) no longer on the roster: ${stale.map((g) => g.slice(0, 8)).join(", ")}`);
    }
    if (this.settings.poolHasBackpack) this.log("pool_settings: pool_has_backpack is set but no longer forces capacity — slots are per bot (backpack seen on that character); the knob is inert");
    if (opts.onPoolChanged) this.tracker.onChange = opts.onPoolChanged;
    this.proxies = ProxyPool.fromSource(opts.proxies);
    this.gate = new LoginGate();
    this.nodeSettings = opts.nodeSettings ?? NodeSettingsStore.at(this.dataDir, this.log);
    this.servers = ServerList.at(this.dataDir, this.log);
    this.versions = opts.versions ?? new GameVersion({ seed: opts.buildVersion, url: null, log: this.log });
    const versions = this.versions;
    this.deps = {
      pool: this.pool, proxies: this.proxies, gate: this.gate, clients: this.clients, log: this.log, bringUp: opts.bringUp,
      capacityFor: (g) => this.tracker.capacityFor(g),
      onLogin: (acc, client) => {
        this.backpacks.onLogin(acc, client);
        this.storage.onLogin(acc, client);
      },
      servers: this.servers,
      requireProxy: () => this.nodeSettings.get().proxies.required,
      itemPolicy: () => this.nodeSettings.get().items,
      isAdvanced: (acc) => advancedFor(this.nodeSettings.get().advanced, acc.communism),
      // Read at every bring-up, so a build bump reaches the next HELLO.
      get buildVersion() { return versions.current; },
      refreshBuildVersion: () => versions.refresh(),
    };
    this.wakes = new WakeScheduler(this.deps);
    const sweepDeps = { deps: this.deps, pool: this.pool, tracker: this.tracker, settings: this.settings };
    this.sweepDeps = sweepDeps;
    // An account that joins the roster while the node runs is looked at right
    // away, so its items show up without waiting for a restart or a job.
    this.pool.onAdded = (acc) => {
      setTimeout(() => {
        void this.readAccount(acc, "new on the roster").catch((e) => this.log(`read of new account ${acc.alias} failed: ${String(e)}`));
      }, 1_500).unref?.();
    };
    this.dispatcher = opts.api
      ? new Dispatcher({
          api: opts.api, pool: this.pool, deps: this.deps, tracker: this.tracker, settings: this.settings, hold: this.hold,
          wakes: this.wakes, coordinator: this.coordinator, loginCodes: this.loginCodes, whispers: this.whispers, dataDir: this.dataDir,
          reserved: opts.reserved,
          loginDeskAlwaysOn: () => this.nodeSettings.get().loginDesk.alwaysOn,
          advanced: () => this.nodeSettings.get().advanced,
          emptyServers: () => this.serverUsage?.emptyServers() ?? null,
        })
      : null;
    const backpackStore = BackpackStore.at(this.dataDir);
    {
      const gone = backpackStore.pruneTo(new Set(this.pool.every().map((a) => a.botGuid)));
      if (gone) this.log(`backpacks: dropped ${gone} row(s) of accounts no longer on the roster`);
    }
    this.backpacks = new BackpackService({
      sd: sweepDeps, store: backpackStore, holds: this.dispatcher?.maintenanceHolds ?? new Set<string>(),
      // A job waits for the account and borrows it as a storage trip does: an idle bot at the desk is let go for it.
      release: (acc) => this.dispatcher?.releaseForMaintenance(acc) ?? true,
      // A backpack job's look at a side's Vault, and a backpack it applied, reach storage's view of the account.
      onVaultView: (acc, view, seasonal) => this.storage.noteVaultView(acc, view, seasonal),
      onBackpackApplied: (acc, charId) => this.storage.noteBackpackApplied(acc, charId),
    });
    // What the accounts keep in storage is part of the served pool: a change there re-serves it like a tracker change.
    const storageStore = StorageStore.at(this.dataDir);
    if (opts.onPoolChanged) storageStore.onChange = opts.onPoolChanged;
    this.storage = new StorageService({
      sd: sweepDeps, store: storageStore, holds: this.dispatcher?.maintenanceHolds ?? new Set<string>(),
      release: (acc) => this.dispatcher?.releaseForMaintenance(acc) ?? true,
      // The refresh's token also reads the login calendar, so the roster's backpack days are as fresh as its items.
      onToken: (acc, token, proxy) => this.backpacks.refreshFromToken(acc, token, proxy),
      keep: opts.reserved,
    });
    // A withdraw for something in an account's storage: the dispatcher asks
    // what each account keeps, and orders the fetch trip that brings it out.
    this.dispatcher?.setStorageDesk({
      stored: (botGuid) => {
        const acc = this.pool.byBotGuid(botGuid);
        return acc ? this.storage.storedFor(acc) : [];
      },
      fetch: (acc, need, o) => this.storage.fetch(acc, need, o),
      chars: (botGuid) => {
        const acc = this.pool.byBotGuid(botGuid);
        return acc ? this.storage.charsFor(acc) : [];
      },
      loginChar: (botGuid) => {
        const acc = this.pool.byBotGuid(botGuid);
        return acc ? this.storage.loginCharFor(acc)?.id ?? null : null;
      },
      // Advanced management (docs/relay/ADVANCED.md): trips on the live client, and the offline chores.
      bankOnline: (acc, client, o) => this.storage.bankOnline(acc, client, o),
      fetchOnline: (acc, client, need, o) => this.storage.fetchOnline(acc, client, need, o),
      tripping: (guid) => this.storage.isTripping(guid),
      liveBlocked: (acc, client) => this.storage.liveTripBlocked(acc, client),
      vaultRoom: (botGuid, seasonal) => {
        const acc = this.pool.byBotGuid(botGuid);
        return acc ? this.storage.vaultRoom(acc, seasonal) : null;
      },
      compact: (acc, o) => this.storage.compact(acc, o),
      gatherPotions: (acc, o) => this.storage.gatherPotions(acc, o),
    });
    this.seasonWatch = new SeasonWatch({ store: backpackStore, pool: this.pool, clients: this.clients, log: this.log });
    this.serverUsage = new ServerUsageWatch({ clients: this.clients, api: opts.api ?? null, log: this.log, servers: this.servers });
    this.buildGate = new BuildGate({ versions: this.versions, deps: this.deps, pool: this.pool, settings: this.nodeSettings, log: this.log });
    const nodeVersion = opts.nodeVersion ?? process.env.ROTMGTRADE_VERSION ?? "dev";
    this.nodeVersion = nodeVersion;
    this.hub = new HubClient({
      settings: this.nodeSettings, nodeVersion, log: this.log,
      build: () => this.versions.current,
      bots: () => this.pool.all().map((a) => ({ ign: this.tracker.ignFor(a.botGuid) ?? "", seasonal: a.seasonalOrDefault, online: a.online })).filter((b) => b.ign),
      status: () => {
        const gate = this.buildGate.status();
        const accounts = this.pool.all();
        return {
          gate: { held: gate.held, reason: gate.reason, known: gate.known },
          proxies: this.proxies.healthReport().length,
          onlineCap: onlineCapFor(this.proxies.exclusiveCapacity()),
          maxTradeSlots: Math.max(8, ...accounts.filter((a) => !a.suspended).map((a) => this.tracker.capacityFor(a.botGuid))),
          accounts: accounts.length,
          suspended: accounts.filter((a) => a.suspended).length,
          deskServer: this.dispatcher?.deskServerNow() ?? LOGIN_DESK_SERVERS[0] ?? null,
          ...(this.hubStatusExtra?.() ?? {}),
        };
      },
      onKnownBuilds: (b) => this.buildGate.acceptFromHub(b),
    });
    this.realmLogins = new RealmLoginRunner({
      hub: this.hub, codes: this.loginCodes, log: this.log,
      desk: () => {
        const e = this.dispatcher?.electLoginBot() ?? null;
        return e && e.ign ? { ign: e.ign, server: e.acc.client?.server ?? null } : null;
      },
    });
    this.telemetry = new Telemetry({
      settings: this.nodeSettings, pool: this.pool, tracker: this.tracker, versions: this.versions, nodeVersion, log: this.log,
      sender: async (reports) => {
        if (!this.hub.linked) return { ok: false, error: "not linked to a hub" };
        const r = await this.hub.signed<{ ok: true; accepted: number }>("POST", "/api/v1/telemetry/bans", { reports });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    });
    // A 16-slot deposit nothing can serve: nothing fits a bot by itself any more; the owner uses a
    // backpack on a character of that side from the Accounts tab. Said once per side per ten minutes.
    const lastBackpackNote = new Map<boolean, number>();
    this.dispatcher?.setBackpackOrders((seasonal) => {
      const now = Date.now();
      if (now - (lastBackpackNote.get(seasonal) ?? 0) < 10 * 60_000) return;
      lastBackpackNote.set(seasonal, now);
      this.log(`backpacks: a waiting ${seasonal ? "seasonal" : "non-seasonal"} 16-slot deposit has no bot with the room — use a backpack on a ${seasonal ? "seasonal" : "non-seasonal"} character from the Accounts tab`);
    });
    this.setup = new SetupService(this);
    this.setup.adoptExisting();
  }

  static fromEnv(overrides: Partial<FleetOptions> = {}): Fleet {
    // RELAY_DATA_DIR keeps the fleet's files apart from the site's DATA_DIR
    // (which holds pool.db) when both run in one process.
    const dataDir = process.env.RELAY_DATA_DIR || process.env.DATA_DIR || ".";
    const api = HttpSiteApi.fromEnv("COMMUNISM") ?? undefined;
    // An explicit buildVersion override is a pin; otherwise follow the feed.
    const versions = overrides.versions
      ?? (overrides.buildVersion ? new GameVersion({ seed: overrides.buildVersion, url: null, log: overrides.log }) : GameVersion.fromEnv(dataDir, overrides.log));
    return new Fleet({
      dataDir,
      proxies: proxySourceFromEnv(dataDir),
      buildVersion: versions.current,
      versions,
      api,
      ...overrides,
    });
  }

  /** Boot sweep, then start every dispatcher. */
  async start(opts: { sweep?: boolean } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    // The gate reads the cached build before the feed answers; a new build
    // from the feed holds logins the moment it lands.
    this.buildGate.start();
    this.versions.start();
    if (opts.sweep ?? true) {
      try {
        await startupSweep({ deps: this.deps, pool: this.pool, tracker: this.tracker, settings: this.settings });
      } catch (e) {
        this.log(`startup_sweep: aborted with error: ${String(e)}`);
      }
    }
    this.seasonWatch.start();
    this.serverUsage.start();
    this.backpacks.seedCapacities();
    // Accounts with a backpack day ahead on the calendar get one login a day (docs/relay/BACKPACKS.md §12).
    if (process.env.BACKPACK_DAILY_LOGIN !== "0") this.backpacks.startDailyLogins();
    // Characters are made from the Accounts tab (the wizard buttons); the fill pass is opt-in (CHARACTER_FILL=1), a few per account per pass.
    if (process.env.CHARACTER_FILL === "1") this.storage.startCharacterFill();
    // A nearly full played character tucks gear and consumables into its equipment slots and quickslots.
    if (process.env.TUCK !== "0") this.storage.startTuck();
    // Deletes and drops queued before a restart are still in the saved state: once the fleet has settled, they carry on.
    setTimeout(() => this.storage.resumeQueuedJobs(this.pool.every()), 15_000).unref?.();
    if (this.dispatcher) this.dispatcher.start();
    else this.log("Fleet: no site configured (COMMUNISM_URL/COMMUNISM_SECRET unset) — no dispatcher started");
    this.telemetry.start();
    this.hub.start();
    this.realmLogins.start();
  }

  /**
   * Log an account in, read everything it holds — the character, the vault
   * chests, the potion rack, the gift and spoils chests, the other
   * characters — and log it out: a new account's first look, or a fresh one
   * from the console. A storage trip (docs/relay/STORAGE.md), borrowed from
   * the dispatcher (borrow.ts) so a bot idling at the login desk can be read
   * too. The result is what every item of the account looks like in the pool.
   */
  async readAccount(acc: BotAccount, why: string): Promise<BringUpVerdict | "busy" | "login-locked"> {
    const v = await this.storage.read(acc, why);
    if (v === "busy" || v === "login-locked") this.log(`read: ${acc.alias} not read — ${v}`);
    return v;
  }

  /**
   * The computer woke up from sleep: every session it had is dead on Realm's
   * side. Log each bot out cleanly (the dispatcher logs in again whatever
   * work needs), let back the proxies benched for failures the sleep caused
   * (not the ones Realm banned), and catch up on the game version and the
   * hub. Returns how many bots were logged out and proxies let back.
   */
  resume(): { stopped: number; proxies: number } {
    let stopped = 0;
    for (const [guid, client] of [...this.clients]) {
      if (!client.active) continue;
      const acc = this.pool.byGuid(guid);
      if (acc) takeDown(this.deps, acc, "the computer woke up");
      else client.stop();
      stopped++;
    }
    // A dispatcher bot not (or no longer) in the map.
    for (const acc of this.pool.every()) {
      if (acc.client && acc.client.active) {
        acc.client.stop();
        stopped++;
      }
    }
    const proxies = this.proxies.clearBenches();
    this.log(`resume: the computer woke up; ${stopped} bot(s) logged out to start fresh, ${proxies} proxy host(s) let back`);
    void this.versions.refresh().catch(() => false);
    void this.hub.sendHeartbeat().catch(() => false);
    return { stopped, proxies };
  }

  stop(): void {
    this.storage.flush();
    this.seasonWatch.stop();
    this.serverUsage.stop();
    this.telemetry.stop();
    this.hub.stop();
    this.realmLogins.stop();
    this.buildGate.stop();
    this.storage.stopCharacterFill();
    this.storage.stopTuck();
    this.backpacks.stopDailyLogins();
    this.backpacks.flush();
    this.dispatcher?.stop();
    this.versions.stop();
    this.wakes.stop();
    for (const c of this.clients.values()) c.stop();
    this.tracker.close();
  }

}
