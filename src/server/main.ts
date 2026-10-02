// Process entry point. Owns the lifecycle Next never gave us: load env, open
// the database (which runs migrations), start background work, listen, and
// shut down cleanly on a signal.
import { serve } from "@hono/node-server";
import { loadEnv } from "./env";
import { applyNodeDefaults, bindRefusal } from "@/node/config";

loadEnv();
// Every knob gets a local-mode default (design doc §4.3); env still wins.
const nodeConfig = applyNodeDefaults();
console.log(`[node] local mode, data in ${nodeConfig.dataDir}`);
{
  const refusal = bindRefusal(nodeConfig.host);
  if (refusal) {
    console.error(`[server] ${refusal}`);
    process.exit(1);
  }
  // The sealing key must open the stored credentials before anything reads or writes them.
  const { secretKey } = await import("@/node/secrets");
  try {
    secretKey(nodeConfig.dataDir);
  } catch (e) {
    console.error(`[server] ${(e as Error).message}`);
    process.exit(1);
  }
}

// Imported after loadEnv so module-level reads of process.env (DATA_DIR in
// lib/db, the rate-limit and live-bus globals) see the file-backed values.
const [{ getDb }, { createApp }, { startScheduler }] = await Promise.all([
  import("@/lib/db"),
  import("./app"),
  import("./scheduler"),
]);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

// Refuse to serve production with dev fallbacks: the session signer falls
// back to a public constant, and the embedded relay needs a token the site's
// pyrelay client can present. Missing pieces are a deploy mistake, not
// something to limp through.
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  console.error("[server] SESSION_SECRET is not set; refusing to start in production");
  process.exit(1);
}

const db = getDb();
const app = createApp();
const stopScheduler = startScheduler();

// Optional: run the bot fleet inside this process. The site's pyrelay client
// then talks to it in memory, and the two share one lifecycle.
let fleet: { stop(): void; proxies: import("@/relay/fleet/proxyPool").ProxyPool; nodeSettings: import("@/node/settings").NodeSettingsStore } | null = null;
let swapsRef: { stop(): void } | null = null;
let requestsRef: { stop(): void } | null = null;
let communismRef: { stop(): void } | null = null;
if (process.env.RELAY_EMBEDDED === "1") {
  const [{ Fleet }, { createControlPlane, poolPayload }, { registerEmbeddedRelay, registerEmbeddedPool }, { LocalSiteApi }, { notifyPoolChanged, onPoolChanged, onRequestChanged }] = await Promise.all([
    import("@/relay/fleet/fleet"),
    import("@/relay/controlPlane"),
    import("@/lib/devauth"),
    import("@/relay/fleet/localSiteApi"),
    import("@/lib/liveBus"),
  ]);
  // The fleet talks to this site's queue directly: no HTTP, no signatures.
  const { reservedInstanceIds } = await import("@/lib/reservations");
  // Items the site has spoken for (picks, posted offers, hand-overs) stay put: no tuck, no banking for room, no consolidation.
  const f = Fleet.fromEnv({ api: new LocalSiteApi(getDb), onPoolChanged: notifyPoolChanged, reserved: () => reservedInstanceIds(getDb()) });
  registerEmbeddedRelay(createControlPlane(f));
  registerEmbeddedPool(() => poolPayload(f));
  // The site's forms and the pool projection follow the owner's accepted-items policy too.
  const { registerItemPolicy } = await import("@/lib/itemPolicy");
  registerItemPolicy(() => f.nodeSettings.get().items);
  // And its advanced management switches (docs/relay/ADVANCED.md): deposit room, withdraw plans, communism picks.
  const { registerAdvancedSettings } = await import("@/lib/advanced");
  registerAdvancedSettings(() => f.nodeSettings.get().advanced);
  fleet = f;
  void f.start().catch((e) => console.error("[relay] fleet failed to start:", e));
  console.log("[relay] embedded fleet starting");
  // Trades with players as they stand: the owner's settings, with "one per bot online" worked out from the proxies now.
  const [{ playerMeetingsAtOnce }, { onlineCapFor }] = await Promise.all([import("@/node/settings"), import("@/relay/fleet/constants")]);
  const playersNow = () => {
    const p = f.nodeSettings.get().players;
    return { ...p, maxMeetings: playerMeetingsAtOnce(p, onlineCapFor(f.proxies.exclusiveCapacity())) };
  };
  // Cross-node swaps (design doc §6.2): offers and rendezvous against the hub.
  const [{ SwapCoordinator }, { registerEmbeddedSwaps }] = await Promise.all([import("@/node/swaps"), import("@/lib/devauth")]);
  const swaps = new SwapCoordinator({
    db: getDb, hub: f.hub, pool: () => poolPayload(f), log: (l) => console.log(l),
    // The outcome check after a lost trade result: when the fleet last looked at a bot, and a look on request.
    verifiedAt: (g) => { const v = f.tracker.verifiedAt(g); return v === undefined ? null : Math.round(v * 1000); },
    verify: (g, why) => { const acc = f.pool.byBotGuid(g); return acc ? f.readAccount(acc, why) : Promise.resolve(null); },
    // Trades with players: the owner's switch and cap (Overview -> Node & hub).
    players: () => playersNow(),
  });
  registerEmbeddedSwaps(swaps);
  // What the hub's node card needs from the site's side: whether this node takes trades with players and the
  // servers its bots meet on (the owner's server controls), and the login desk when the hub made this its login node.
  const [{ WITHDRAW_SERVERS }, { withdrawBlock }, { spareRoom }] = await Promise.all([import("@/lib/servers"), import("@/lib/serverControls"), import("@/node/communism")]);
  f.hubStatusExtra = () => {
    const players = playersNow();
    const desk = f.hub.loginNode ? f.dispatcher?.electLoginBot() ?? null : null;
    return {
      players: { enabled: players.enabled, maxMeetings: players.maxMeetings, servers: WITHDRAW_SERVERS.filter((sv) => !withdrawBlock(getDb(), sv)), noShow: players.noShow },
      ...(f.hub.loginNode ? { login: { botIgn: desk?.ign || null, server: desk?.acc.client?.server ?? null, alwaysOn: f.nodeSettings.get().loginDesk.alwaysOn } } : {}),
      advanced: {
        pool: f.nodeSettings.get().advanced.pool,
        communism: f.nodeSettings.get().advanced.communism,
        // While communism follows the advanced rules: the room each side takes from other nodes' surplus without passing it on.
        ...(f.nodeSettings.get().advanced.communism ? { spare: spareRoom(f.dispatcher?.communismRoom() ?? []) } : {}),
      },
    };
  };
  swaps.start();
  swapsRef = swaps;
  // Communism (design doc §6.3): the accounts set aside for it, published to the hub.
  const [{ CommunismCoordinator }, { registerEmbeddedCommunism }] = await Promise.all([import("@/node/communism"), import("@/lib/devauth")]);
  const communismSvc = new CommunismCoordinator({
    db: getDb, hub: f.hub, swaps, pool: () => poolPayload(f), log: (l) => console.log(l), onPoolChanged,
    // A take meets on a random server Realm reports at 0% load, as the fleet last read it.
    serverUsage: () => { const u = f.serverUsage.status(); return { servers: u.servers, fetchedAt: u.fetchedAt }; },
    // Advanced management's surplus rule: a full side passes surplus on to another node's communism.
    surplusRoom: () => f.dispatcher?.communismRoom() ?? [],
  });
  registerEmbeddedCommunism(communismSvc);
  communismSvc.start();
  communismRef = communismSvc;
  // What hub users ask this node to do: communism deposits and withdraws, the owner's offers and hand-overs.
  const [{ RequestRunner }, { registerEmbeddedRequests }] = await Promise.all([import("@/node/requests"), import("@/lib/devauth")]);
  const requestsSvc = new RequestRunner({ db: getDb, hub: f.hub, swaps, communism: communismSvc, pool: () => poolPayload(f), log: (l) => console.log(l), onRequestChanged });
  registerEmbeddedRequests(requestsSvc);
  requestsSvc.start();
  requestsRef = requestsSvc;
}


const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[server] listening on http://${info.address}:${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  // Each stop is guarded: one throwing must not keep the server and the database open.
  const stop = (what: string, fn: (() => void) | undefined) => {
    try {
      fn?.();
    } catch (e) {
      console.error(`[server] ${what} stop failed:`, e);
    }
  };
  stop("scheduler", stopScheduler);
  stop("requests", requestsRef ? () => requestsRef!.stop() : undefined);
  stop("communism", communismRef ? () => communismRef!.stop() : undefined);
  stop("swaps", swapsRef ? () => swapsRef!.stop() : undefined);
  // Open SSE streams keep connections alive; don't wait on them forever (the database still closes).
  const force = setTimeout(() => finish(), 5_000);
  force.unref();
  // The fleet writes its backpack state (debounced during runs) and stops its timers.
  stop("fleet", fleet ? () => fleet!.stop() : undefined);
  const finish = () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  try {
    server.close(() => finish());
  } catch (e) {
    console.error("[server] close failed:", e);
    finish();
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// The desktop shell's graceful stop (POST /api/dev/shutdown): Windows has no
// SIGTERM for a child process.
declare global {
  // eslint-disable-next-line no-var
  var __rotmgtradenode_shutdown__: ((why: string) => void) | undefined;
}
globalThis.__rotmgtradenode_shutdown__ = shutdown;
