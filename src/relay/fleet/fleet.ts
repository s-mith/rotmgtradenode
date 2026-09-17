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
import { auditProxiesFromFile, BackpackService, BackpackStore } from "./backpacks";
import { StorageService, StorageStore } from "./storage";
import { SeasonWatch } from "./seasonWatch";
import { ServerUsageWatch } from "./serverUsageWatch";
import { WakeScheduler } from "./wakes";
import { ServerList } from "../realm/serverList";
import { BuildGate } from "./buildGate";
import { Telemetry } from "./telemetry";
import { NodeSettingsStore } from "../../node/settings";
import { HubClient } from "../../node/hub";
import { PROXIES_REFRESH_S } from "./constants";

export interface FleetOptions {
  dataDir: string;
  /** Where the exit-IP list comes from: PROXIES_URL and/or PROXIES_FILE. */
  proxies: ProxySource;
  /** Pinned build string; ignored when `versions` is given. */
  buildVersion: string;
  /** Live build source (feed-following); defaults to a pin on `buildVersion`. */
  versions?: GameVersion;
  /** The site's queue client; without one no dispatcher runs. */
  api?: SiteApi;
  log?: (line: string) => void;
  freeSlotsTarget?: number;
  /** Test hook, forwarded to FleetDeps. */
  bringUp?: FleetDeps["bringUp"];
  /** Called whenever the tracker's revision moves. */
  onPoolChanged?: () => void;
  /** Node-level settings (telemetry opt-in, known builds); defaults to `<dataDir>/node.json`. */
  nodeSettings?: NodeSettingsStore;
  /** What telemetry reports as the node version. */
  nodeVersion?: string;
}

export class Fleet {
  readonly dataDir: string;
  readonly log: (line: string) => void;
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
  private started = false;
  private proxyRefresh: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FleetOptions) {
    this.dataDir = opts.dataDir;
    this.log = opts.log ?? ((l) => console.log(l));
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.pool = BotPool.at(this.dataDir);
    this.settings = PoolSettings.at(this.dataDir);
    this.tracker = InventoryTracker.at(this.dataDir);
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
      onLogin: (acc, client) => this.backpacks.onLogin(acc, client),
      servers: this.servers,
      requireProxy: () => this.nodeSettings.get().proxies.required,
      // Read at every bring-up, so a build bump reaches the next HELLO.
      get buildVersion() { return versions.current; },
      refreshBuildVersion: () => versions.refresh(),
    };
    this.wakes = new WakeScheduler(this.deps);
    const sweepDeps = { deps: this.deps, pool: this.pool, tracker: this.tracker, settings: this.settings };
    this.dispatcher = opts.api
      ? new Dispatcher({
          api: opts.api, pool: this.pool, deps: this.deps, tracker: this.tracker, settings: this.settings, hold: this.hold,
          wakes: this.wakes, coordinator: this.coordinator, loginCodes: this.loginCodes, whispers: this.whispers, dataDir: this.dataDir,
          freeSlotsTarget: opts.freeSlotsTarget,
        })
      : null;
    const backpackStore = BackpackStore.at(this.dataDir);
    this.backpacks = new BackpackService({
      sd: sweepDeps, store: backpackStore, holds: this.dispatcher?.maintenanceHolds ?? new Set<string>(),
      auditProxy: auditProxiesFromFile(process.env.BACKPACK_AUDIT_PROXIES_FILE, this.log),
      vaultBots: () => this.dispatcher?.vaultBotGuids() ?? new Set<string>(),
    });
    this.storage = new StorageService({ sd: sweepDeps, store: StorageStore.at(this.dataDir), holds: this.dispatcher?.maintenanceHolds ?? new Set<string>() });
    this.seasonWatch = new SeasonWatch({ store: backpackStore, pool: this.pool, clients: this.clients, log: this.log });
    this.serverUsage = new ServerUsageWatch({ clients: this.clients, api: opts.api ?? null, log: this.log, servers: this.servers });
    this.buildGate = new BuildGate({ versions: this.versions, deps: this.deps, pool: this.pool, settings: this.nodeSettings, log: this.log });
    const nodeVersion = opts.nodeVersion ?? process.env.ROTMGTRADE_VERSION ?? "dev";
    this.hub = new HubClient({
      settings: this.nodeSettings, nodeVersion, log: this.log,
      build: () => this.versions.current,
      bots: () => this.pool.all().map((a) => ({ ign: this.tracker.ignFor(a.botGuid) ?? "", seasonal: a.seasonalOrDefault, online: a.online })).filter((b) => b.ign),
      onKnownBuilds: (b) => this.buildGate.acceptFromHub(b),
    });
    this.telemetry = new Telemetry({
      settings: this.nodeSettings, pool: this.pool, tracker: this.tracker, versions: this.versions, nodeVersion, log: this.log,
      sender: async (reports) => {
        if (!this.hub.linked) return { ok: false, error: "not linked to a hub" };
        const r = await this.hub.signed<{ ok: true; accepted: number }>("POST", "/api/v1/telemetry/bans", { reports });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    });
    // A 16-slot deposit nothing can serve: the dispatcher records a backpack
    // order; the owner runs the chore from the Backpacks tab.
    this.dispatcher?.setBackpackOrders((seasonal) => {
      if (!this.backpacks.orderBackpackBot(seasonal)) return;
      this.log(`backpacks: a waiting ${seasonal ? "seasonal" : "non-seasonal"} 16-slot deposit has no bot with the room — run the backpack chore to fit one`);
    });
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
    // The cached file was loaded in the constructor; the live list replaces
    // it before anything logs in, so pins are computed against today's hosts.
    if (this.proxies.sourceStatus().urlConfigured) {
      await this.proxies.refresh();
      // Keep following the list: a host added at the provider is a bot more
      // the fleet can have online, and a removed one stops being handed out.
      if (PROXIES_REFRESH_S > 0) {
        this.proxyRefresh = setInterval(() => {
          void this.proxies.refresh();
        }, PROXIES_REFRESH_S * 1000);
        this.proxyRefresh.unref?.();
      }
    }
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
    if (this.dispatcher) this.dispatcher.start();
    else this.log("Fleet: no site configured (COMMUNISM_URL/COMMUNISM_SECRET unset) — no dispatcher started");
    this.telemetry.start();
    this.hub.start();
  }

  stop(): void {
    if (this.proxyRefresh) clearInterval(this.proxyRefresh);
    this.proxyRefresh = null;
    this.storage.flush();
    this.seasonWatch.stop();
    this.serverUsage.stop();
    this.telemetry.stop();
    this.hub.stop();
    this.buildGate.stop();
    this.backpacks.flush();
    this.dispatcher?.stop();
    this.versions.stop();
    this.wakes.stop();
    for (const c of this.clients.values()) c.stop();
    this.tracker.close();
  }

}
