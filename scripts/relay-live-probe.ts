// Live probe: bring ONE account up through the real Realm auth and game
// socket, wait for it to stand in the nexus, print what it holds, log out.
//
//   npx tsx scripts/relay-live-probe.ts <alias-or-index> [server] [holdSeconds]
//
// Reads data/relay/Accounts.json and data/relay/proxies.txt (never committed).
import path from "node:path";
import { BotPool } from "../src/relay/fleet/botPool";
import { ProxyPool } from "../src/relay/fleet/proxyPool";
import { LoginGate } from "../src/relay/fleet/loginGate";
import { bringUp, BringUpRefused, takeDown, type FleetDeps } from "../src/relay/fleet/bringUp";
import { toCatalogId } from "../src/relay/trade/itemMap";
import type { GameClient } from "../src/relay/client/gameClient";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data", "relay");
const which = process.argv[2] ?? "0";
const server = process.argv[3] ?? "USSouth3";
const holdS = Number(process.argv[4] ?? 20);

const pool = BotPool.at(dataDir);
const proxies = ProxyPool.fromFile(path.join(dataDir, "proxies.txt"));
const gate = new LoginGate();
const clients = new Map<string, GameClient>();
const deps: FleetDeps = { pool, proxies, gate, buildVersion: process.env.GAME_VERSION ?? "7.0.0.0.0", clients, log: (l) => console.log(new Date().toISOString().slice(11, 23), l) };

const acc = /^\d+$/.test(which) ? pool.all()[Number(which)] : pool.all().find((a) => a.alias === which || a.guid === which);
if (!acc) {
  console.error(`no account ${which}`);
  process.exit(2);
}
console.log(`probe: ${acc.alias} (${acc.info.password ? "email" : "steam"}) -> ${server}, build ${deps.buildVersion}`);
const t0 = Date.now();
let client: GameClient;
try {
  client = await bringUp(deps, acc, server);
} catch (e) {
  if (e instanceof BringUpRefused) console.error(`bring-up refused: ${e.verdict} — ${e.message}`);
  else console.error("bring-up threw:", e);
  process.exit(1);
}
console.log(`probe: authenticated + socket open after ${Date.now() - t0}ms; seasonal=${client.charSeasonal}`);
const kinds = new Map<string, number>();
const unknownIds = new Map<number, number>();
client.on("packet", (p) => {
  kinds.set(p.type, (kinds.get(p.type) ?? 0) + 1);
  if (p.type === "UNKNOWN") unknownIds.set(p.id, (unknownIds.get(p.id) ?? 0) + 1);
});
client.on("failure", (f) => console.log("probe: FAILURE event", JSON.stringify(f)));
client.on("queue", (pos, max) => console.log(`probe: queue ${pos}/${max}`));
client.on("disconnected", (r, d) => console.log(`probe: disconnected ${r} ${d ?? ""}`));

const deadline = Date.now() + 90_000;
while (Date.now() < deadline && client.active && !(client.objectId !== -1 && client.playerData.name)) await new Promise((r) => setTimeout(r, 250));
if (!client.active) {
  console.log("probe: client stopped before reaching the world");
  process.exit(1);
}
if (client.objectId === -1) {
  console.log("probe: never reached the world in 90s; packets seen:", Object.fromEntries(kinds));
  takeDown(deps, acc, "probe timeout");
  process.exit(1);
}
console.log(`probe: IN WORLD after ${Date.now() - t0}ms as ${client.playerData.name} (objectId ${client.objectId}) on ${client.server}`);
await new Promise((r) => setTimeout(r, 4000));
const pd = client.playerData;
console.log(`probe: level ${pd.level} hp ${pd.hp}/${pd.maxHp} backpack=${pd.hasBackpack} enchantsSeen=${pd.enchantmentsSeen} pos=${JSON.stringify(client.pos)}`);
for (const [slot, { objectType, enchantments }] of pd.occupiedSlots()) {
  console.log(`  slot ${slot}: type ${objectType} -> ${toCatalogId(objectType, "capitalism") ?? "(not in catalog)"} enchants=[${enchantments.join(",")}]`);
}
console.log(`probe: holding ${holdS}s to watch keepalive…`);
await new Promise((r) => setTimeout(r, holdS * 1000));
console.log("probe: packets seen:", JSON.stringify(Object.fromEntries([...kinds].sort())));
console.log("probe: unknown ids:", JSON.stringify(Object.fromEntries([...unknownIds].sort((a, b) => b[1] - a[1]))));
console.log(`probe: still connected=${client.connected} active=${client.active}`);
takeDown(deps, acc, "probe done");
await new Promise((r) => setTimeout(r, 500));
process.exit(client.connected ? 1 : 0);
