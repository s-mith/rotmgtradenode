// Fills `portalType` on every entry of src/lib/raidDungeons.ts, and writes
// src/relay/realm/portals.json (every portal object), from the game data: a key's <Activate id="X">CreatePortal</Activate> names the portal
// object the key opens, whose type is what a raid watcher looks for.
//   node scripts/raid-portals.mjs [path/to/object.xml]
import fs from "node:fs";
import path from "node:path";

const xmlPath = process.argv[2] ?? process.env.ROTMG_OBJECT_XML ?? path.resolve("../../rotmglearn/data/gamedata/object.xml");
const file = path.resolve("src/lib/raidDungeons.ts");
const xml = fs.readFileSync(xmlPath, "utf8");

/** Keys the site names one way and the game data another. */
const ALIASES = { "St. Patricks Key": "Rainbow Road Key", "The Trials of Cronus": "Trials of Cronus Key" };

const objects = new Map();
for (const m of xml.matchAll(/<Object\s+([^>]*)>([\s\S]*?)<\/Object>/g)) {
  const type = /(?:^|\s)type="([^"]+)"/.exec(m[1])?.[1];
  const id = /(?:^|\s)id="([^"]*)"/.exec(m[1])?.[1];
  if (type === undefined || id === undefined || objects.has(id)) continue;
  objects.set(id, { type: type.startsWith("0x") ? parseInt(type, 16) : Number(type), body: m[2] });
}
function portalFor(keyName) {
  const key = objects.get(ALIASES[keyName] ?? keyName);
  if (!key) return null;
  const portal = /<Activate\s+[^>]*id="([^"]+)"[^>]*>\s*CreatePortal\s*<\/Activate>/.exec(key.body)?.[1];
  if (!portal) return null;
  return objects.get(portal)?.type ?? null;
}

// Every Portal-class object, for the watcher (src/relay/fleet/raidWatch.ts): the relay's own object table
// (realm/resources.json) predates most of today's dungeons, so it cannot tell a new portal from a rock.
const portals = {};
for (const [id, o] of objects) {
  if (!/<Class>\s*Portal\s*<\/Class>/.test(o.body)) continue;
  const dungeon = /<DungeonName>([^<]*)<\/DungeonName>/.exec(o.body)?.[1]?.trim() ?? "";
  portals[o.type] = { id, dungeon, dungeonPortal: /<DungeonPortal\s*\/>/.test(o.body) };
}
const portalsFile = path.resolve("src/relay/realm/portals.json");
fs.writeFileSync(portalsFile, JSON.stringify(portals, null, 0) + "\n");
console.log(`raid-portals: ${Object.keys(portals).length} portal objects -> ${path.relative(process.cwd(), portalsFile)}`);

let src = fs.readFileSync(file, "utf8");
let done = 0;
const missing = [];
src = src.replace(/(\{ id: "[^"]+", limit: \d+,)( portalType: [^,]+,)?( key: "((?:[^"\\]|\\.)*)")/g, (all, head, _old, tail, keyRaw) => {
  const keyName = JSON.parse(`"${keyRaw}"`);
  const type = portalFor(keyName);
  if (type === null) missing.push(keyName);
  else done++;
  return `${head} portalType: ${type === null ? "null" : `0x${type.toString(16).padStart(4, "0")}`},${tail}`;
});
fs.writeFileSync(file, src);
console.log(`raid-portals: ${done} keys mapped${missing.length ? `; no portal for: ${missing.join(", ")}` : ""}`);
