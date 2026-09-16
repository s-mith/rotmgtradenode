// Standalone relay process: the bot fleet plus the site-facing control
// plane, for running against a separately deployed site. The same Fleet can
// be embedded in the site process instead (see src/server/main.ts).
import { serve } from "@hono/node-server";
import { Fleet } from "./fleet/fleet";
import { createControlPlane } from "./controlPlane";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // absent
  }
}

const fleet = Fleet.fromEnv();
const app = createControlPlane(fleet);
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port, hostname: "::" }, (info) => {
  fleet.log(`relay: control plane on [${info.address}]:${info.port}`);
});
await fleet.start();

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  fleet.log(`relay: ${signal} received, shutting down`);
  fleet.stop();
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
