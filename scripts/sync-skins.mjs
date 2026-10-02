// Add every tradeable character skin to the catalog, from the game's own
// equipSkins.xml (an Item with a bag type that is not Soulbound, as
// sync-equip.mjs judges equipment), with its icon from realm.wiki's skin
// search page (one page carries every skin's tooltip icon as base64) and its
// class from the description ("Skin Class: Warrior"). Skins go under their
// own marker in catalog.ts as category "Skin" with the class as subtype, into
// itemMap.json (id -> type) and realm-items.json (sprite, class, feed power).
//
//   node scripts/sync-skins.mjs --base ~/Projects/rotmgclient/7.0.0.2.0 [--sprites wiki-skins.json] [--dry-run]
//
// `--sprites` is a saved {"<type>": {name, sprite}} map; without it the page
// is fetched. Rebuild the derived files afterwards: build-class-index,
// build-item-tooltips, build-spritesheet.
import fs from "node:fs";
import path from "node:path";
import { baseUrl, isLocalBase, itemName, openBuild, parseNum, readObjects, slug, tradeableItem } from "./lib/equip.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const BASE = baseUrl(args);
if (isLocalBase(BASE) && !fs.existsSync(BASE)) { console.error(`--base ${BASE}: not a URL and not a directory`); process.exit(2); }
const spritesArg = args.indexOf("--sprites");
const CATALOG_TS = path.join(ROOT, "src", "lib", "catalog.ts");
const ITEM_MAP = path.join(ROOT, "src", "relay", "trade", "itemMap.json");
const REALM_ITEMS = path.join(ROOT, "realm-items.json");
const MARKER = "// --- skins (auto-synced from equipSkins.xml) ---";
const log = (...a) => console.log(...a);
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

async function wikiSprites() {
  if (spritesArg >= 0) return JSON.parse(fs.readFileSync(args[spritesArg + 1], "utf8"));
  const res = await fetch("https://realm.wiki/search?query=skin", { headers: { "user-agent": "rotmgtradenode-catalog-sync/1.0 (personal wiki data sync)" } });
  if (!res.ok) throw new Error(`realm.wiki search: HTTP ${res.status}`);
  const html = await res.text();
  const out = {};
  for (const m of html.matchAll(/<a href='\/item\?id=(\d+)'>\s*<div class='card preview-card'>\s*<div class='card-header'>\s*([^<]+?)\s*<\/div>[\s\S]*?data:image\/png;base64,([A-Za-z0-9+/=]+)/g)) out[m[1]] = { name: m[2], sprite: m[3] };
  return out;
}

async function main() {
  const { ident, get } = await openBuild(BASE, log);
  log(`skin sync: ${BASE} (game ${ident.version}, build ${ident.hash})`);
  const objects = readObjects(await get("extracted_assets/TextAsset/equipSkins.xml"));
  const sprites = await wikiSprites();
  log(`  ${objects.length} skins in equipSkins.xml, ${Object.keys(sprites).length} icons from the wiki`);

  const ts = fs.readFileSync(CATALOG_TS, "utf8");
  const listed = new Set([...ts.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]));
  const itemMap = JSON.parse(fs.readFileSync(ITEM_MAP, "utf8"));
  const knownTypes = new Set(Object.values(itemMap.communism));
  const realmItems = JSON.parse(fs.readFileSync(REALM_ITEMS, "utf8"));
  const realmByType = new Map(realmItems.map((it) => [Number(it.realmId), it]));

  const add = [];
  let soulbound = 0, noIcon = 0;
  for (const o of objects) {
    if (!tradeableItem(o)) { if ("Soulbound" in o) soulbound++; continue; }
    const type = parseNum(o["@_type"]);
    if (knownTypes.has(type)) continue;
    const name = itemName(o);
    let id = slug(name);
    for (let n = 2; listed.has(id); n++) id = `${slug(name)}_${n}`;
    listed.add(id);
    const cls = /Skin Class:\s*([A-Za-z]+)/.exec(String(o.Description ?? ""))?.[1] ?? null;
    const sprite = sprites[String(type)]?.sprite ?? realmByType.get(type)?.sprite ?? "";
    if (!sprite) noIcon++;
    add.push({ type, id, name, cls, sprite, feedPower: o.feedPower !== undefined ? Number(o.feedPower) : null });
  }
  log(`  ${soulbound} soulbound, ${add.length} tradeable skins to add (${noIcon} without an icon)`);
  for (const a of add.slice(0, 8)) log(`    ${a.type}\t${a.id}\t${a.name}\t${a.cls ?? "?"}`);
  if (!add.length) { log("nothing to add."); return; }
  if (DRY) { log("--dry-run: nothing written."); return; }

  // realm-items.json
  for (const a of add) {
    const existing = realmByType.get(a.type);
    if (existing) { if (!existing.sprite && a.sprite) existing.sprite = a.sprite; existing.classes ??= a.cls ? [a.cls] : ["ALL"]; existing.slot ??= "consumable"; existing.feedPower ??= a.feedPower; continue; }
    realmItems.push({ id: a.id, realmId: String(a.type), name: a.name, tier: null, sprite: a.sprite, classes: a.cls ? [a.cls] : ["ALL"], slot: "consumable", feedPower: a.feedPower });
  }
  fs.writeFileSync(REALM_ITEMS, JSON.stringify(realmItems, null, 2) + "\n");
  // itemMap.json
  for (const a of add) itemMap.communism[a.id] = a.type;
  const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  fs.writeFileSync(ITEM_MAP, JSON.stringify({ communism: sorted(itemMap.communism), extra: sorted(itemMap.extra ?? {}), minEnchants: sorted(itemMap.minEnchants ?? {}) }, null, 1));
  // catalog.ts: SKIN_CATALOG, its own array under the marker (one literal past ~1100 entries is too complex for the type checker).
  const lines = add.map((a) => `  { id: "${a.id}", name: "${esc(a.name)}", category: "Skin"${a.cls ? `, subtype: "${esc(a.cls)}"` : ""} },`).join("\n") + "\n";
  const at = ts.indexOf(MARKER);
  if (at === -1) throw new Error("catalog.ts: the skins marker (SKIN_CATALOG) is missing");
  const close = ts.indexOf("];", at);
  fs.writeFileSync(CATALOG_TS, ts.slice(0, close) + lines + ts.slice(close));
  log(`  wrote ${add.length} skins to catalog.ts, itemMap.json and realm-items.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
