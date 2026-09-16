// Process entry point. Owns the lifecycle Next never gave us: load env, open
// the database (which runs migrations), start background work, listen, and
// shut down cleanly on a signal.
import { serve } from "@hono/node-server";
import { loadEnv } from "./env";
import { applyNodeDefaults } from "@/node/config";

loadEnv();
// Every knob gets a local-mode default (design doc §4.3); env still wins.
const nodeConfig = applyNodeDefaults();
console.log(`[node] local mode, data in ${nodeConfig.dataDir}`);

// Imported after loadEnv so module-level reads of process.env (DATA_DIR in
// lib/db, the rate-limit and live-bus globals) see the file-backed values.
const [{ getDb }, { createApp }, { startScheduler }, { installWishlistScanner }] = await Promise.all([
  import("@/lib/db"),
  import("./app"),
  import("./scheduler"),
  import("@/lib/wishlistScan"),
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
// Standing claims (My Wishlist) watch the pool from here on, whichever way
// the relay is reached.
installWishlistScanner();

// Optional: run the bot fleet inside this process. The site's pyrelay client
// then talks to it in memory, and the two share one lifecycle.
let fleet: { stop(): void; proxies: import("@/relay/fleet/proxyPool").ProxyPool } | null = null;
if (process.env.RELAY_EMBEDDED === "1") {
  const [{ Fleet }, { createControlPlane, poolPayload }, { registerEmbeddedRelay, registerEmbeddedPool }, { LocalSiteApi }, { notifyPoolChanged }] = await Promise.all([
    import("@/relay/fleet/fleet"),
    import("@/relay/controlPlane"),
    import("@/lib/devauth"),
    import("@/relay/fleet/localSiteApi"),
    import("@/lib/liveBus"),
  ]);
  // The fleet talks to this site's queue directly: no HTTP, no signatures.
  const f = Fleet.fromEnv({ api: new LocalSiteApi(getDb), onPoolChanged: notifyPoolChanged });
  registerEmbeddedRelay(createControlPlane(f));
  registerEmbeddedPool(() => poolPayload(f));
  fleet = f;
  void f.start().catch((e) => console.error("[relay] fleet failed to start:", e));
  console.log("[relay] embedded fleet starting");
}

// Optional: the onboarding service (tutorial walks for owner-added
// accounts) in this process too. The fleet then pulls finished accounts
// straight from its pool.
let accountgen: { stop(): Promise<void> } | null = null;
if (process.env.ACCOUNTGEN_EMBEDDED === "1") {
  const [{ AccountgenService }, { registerLocalAccountSource }, { registerEmbeddedAccountgen }, { parseCursors }] = await Promise.all([
    import("@/accountgen/service"),
    import("@/relay/fleet/botPool"),
    import("@/lib/devauth"),
    import("@/accountgen/walker/liveFeed"),
  ]);
  // One exit-IP pool for the whole process when the fleet is embedded too.
  const svc = new AccountgenService(process.env.ACCOUNTGEN_DATA_DIR || process.env.DATA_DIR || "./data", undefined, fleet ? { gameProxies: fleet.proxies } : {});
  registerLocalAccountSource(async (seasonal) => {
    const a = await svc.dispense(seasonal === null ? undefined : seasonal);
    return a ? { email: a.email, password: a.password, name: a.name, server: a.server, seasonal: a.seasonal } : null;
  });
  // The dev console's Tutorials tab reads the live view in memory and adds accounts through it.
  registerEmbeddedAccountgen({ live: (w) => svc.liveView(parseCursors(w)), addAccount: (acc) => svc.addAccount(acc) });
  svc.start();
  accountgen = svc;
  console.log("[accountgen] onboarding service starting");
}

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[server] listening on http://${info.address}:${info.port}`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  stopScheduler();
  fleet?.stop();
  // Open SSE streams keep connections alive; don't wait on them forever.
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  // The fleet writes its backpack state (debounced during runs) and stops its timers.
  try {
    fleet?.stop();
  } catch (e) {
    console.error("[relay] fleet stop failed:", e);
  }
  const drained = accountgen ? accountgen.stop() : Promise.resolve();
  server.close(() => {
    void drained.finally(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      process.exit(0);
    });
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
