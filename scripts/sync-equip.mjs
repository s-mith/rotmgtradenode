import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { baseUrl, classify, classSlots, classesFor, firstTexture, isLocalBase, itemName, loose, openBuild, parseNum, readObjects, slotGroup, slug, tradeableItem } from "./lib/equip.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const BASE = baseUrl(args);
if (isLocalBase(BASE) && !fs.existsSync(BASE)) { console.error(`--base ${BASE}: not a URL and not a directory`); process.exit(2); }

const CATALOG_TS = path.join(ROOT, "src", "lib", "catalog.ts");
const ITEM_MAP = path.join(ROOT, "src", "relay", "trade", "itemMap.json");
const REALM_ITEMS = path.join(ROOT, "realm-items.json");
const XML_MARKER = "// --- tradeable (auto-synced from equip.xml) ---";
const WIKI_MARKER = "// --- untiered tradeable (auto-synced from realm.wiki) ---";

const ATLAS_FILES = { 1: "groundTiles.png", 2: "characters.png", 4: "mapObjects.png" };
const TILE = 40, INNER = 32;

const log = (...a) => console.log(...a);

// --- sprite index (spritesheetf.bytes, FlatBuffers) ---------------------------
//
// root { sheets: [Sheet], animated: [...] }
// Sheet { name: string, atlasId: uint, sprites: [Sprite] }
// Sprite { position: {x,y,w,h: float} @f0, index: int @f3, color @f4,
//          sheetName @f6, atlasId @f7 }  (field slots as observed in the file)

function spriteIndex(buf) {
  const u32 = (p) => buf.readUInt32LE(p), i32 = (p) => buf.readInt32LE(p), u16 = (p) => buf.readUInt16LE(p), f32 = (p) => buf.readFloatLE(p);
  const str = (p) => buf.subarray(p + 4, p + 4 + u32(p)).toString("utf8");
  const table = (pos) => {
    const vt = pos - i32(pos), vsize = u16(vt), fields = [];
    for (let i = 0; 4 + i * 2 < vsize; i++) { const off = u16(vt + 4 + i * 2); fields.push(off ? pos + off : null); }
    return fields;
  };
  const root = table(u32(0));
  const sheetsVec = root[0] + u32(root[0]);
  const sheets = new Map();
  for (let k = 0; k < u32(sheetsVec); k++) {
    const ep = sheetsVec + 4 + k * 4;
    const t = table(ep + u32(ep));
    const name = str(t[0] + u32(t[0]));
    const ev = t[2] + u32(t[2]);
    const m = new Map();
    for (let j = 0; j < u32(ev); j++) {
      const e = ev + 4 + j * 4;
      const f = table(e + u32(e));
      if (!f[0]) continue;
      m.set(f[3] ? u32(f[3]) : 0, { atlas: f[7] ? u32(f[7]) : 0, x: f32(f[0]), y: f32(f[0] + 4), w: f32(f[0] + 8), h: f32(f[0] + 12) });
    }
    sheets.set(name, m);
  }
  return sheets;
}

// Outline alpha by distance (in tile pixels) from the nearest sprite pixel,
// fitted to the wiki's renders: a solid 1px ring, then a soft shadow.
const OUTLINE = [[1.5, 255], [2.0, 122], [2.3, 95], [2.9, 68], [3.2, 52], [3.7, 25], [4.2, 26], [4.6, 10], [5.1, 20], [5.5, 8], [6.1, 12], [6.5, 3], [7.3, 4], [8.1, 1]];
const outlineAlpha = (d) => { for (const [lim, a] of OUTLINE) if (d <= lim) return a; return 0; };

async function renderTile(atlas, s) {
  const scale = Math.max(1, Math.floor(INNER / Math.max(s.w, s.h)));
  const dw = s.w * scale, dh = s.h * scale;
  const ox = Math.floor((TILE - dw) / 2), oy = Math.floor((TILE - dh) / 2);
  const out = Buffer.alloc(TILE * TILE * 4);
  const solid = new Uint8Array(TILE * TILE);
  const W = atlas.info.width;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const si = ((s.y + Math.floor(y / scale)) * W + (s.x + Math.floor(x / scale))) * 4;
    if (atlas.data[si + 3] === 0) continue;
    const tx = ox + x, ty = oy + y;
    if (tx < 0 || ty < 0 || tx >= TILE || ty >= TILE) continue;
    const di = (ty * TILE + tx) * 4;
    out[di] = atlas.data[si]; out[di + 1] = atlas.data[si + 1]; out[di + 2] = atlas.data[si + 2]; out[di + 3] = atlas.data[si + 3];
    solid[ty * TILE + tx] = 1;
  }
  const R = 9;
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    if (solid[y * TILE + x]) continue;
    let best = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= TILE || ny >= TILE || !solid[ny * TILE + nx]) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    const a = outlineAlpha(best);
    if (a) out[(y * TILE + x) * 4 + 3] = a;
  }
  return sharp(out, { raw: { width: TILE, height: TILE, channels: 4 } }).png().toBuffer();
}

// --- site files ---------------------------------------------------------------

function readCatalog() {
  const ts = fs.readFileSync(CATALOG_TS, "utf8");
  const entries = [...ts.matchAll(/\{ id: "([^"]+)", name: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));
  return { ts, entries };
}

function spliceCatalog(ts, lines) {
  const block = lines.join("\n") + "\n";
  const at = ts.indexOf(XML_MARKER);
  if (at !== -1) {
    // Append to the existing xml block: it ends at the next marker or the array close.
    const after = ts.indexOf("\n", at) + 1;
    const wiki = ts.indexOf(WIKI_MARKER, after);
    const close = ts.indexOf("];", after);
    let end = wiki !== -1 && wiki < close ? ts.lastIndexOf("\n", wiki) + 1 : close;
    // Skip the blank line that separates blocks, if any.
    return ts.slice(0, end) + block + ts.slice(end);
  }
  // New block. Ahead of the wiki block if there is one (that block gets
  // rewritten wholesale by apply-untiered-tradable.mjs), else before "];".
  const wiki = ts.indexOf(WIKI_MARKER);
  let insertAt;
  if (wiki !== -1) insertAt = ts.lastIndexOf("\n", wiki) + 1;
  else {
    const anchor = ts.indexOf("export const CATEGORIES");
    if (anchor === -1) throw new Error("catalog.ts: CATEGORIES anchor not found");
    insertAt = ts.lastIndexOf("];", anchor);
  }
  return ts.slice(0, insertAt) + `  ${XML_MARKER}\n` + block + "\n" + ts.slice(insertAt);
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
function catalogLine(it) {
  return `  { id: "${it.id}", name: "${esc(it.name)}", category: "${it.category}"${it.subtype ? `, subtype: "${esc(it.subtype)}"` : ""} },`;
}

// --- main ---------------------------------------------------------------------

async function main() {
  const { ident, get } = await openBuild(BASE, log);
  log(`equip sync: ${BASE} (game ${ident.version}, build ${ident.hash})`);
  const [equipXml, playersXml] = await Promise.all([get("extracted_assets/TextAsset/equip.xml"), get("extracted_assets/TextAsset/players.xml")]);

  const objects = readObjects(equipXml);
  const classes = classSlots(playersXml);
  if (!objects.length) throw new Error("equip.xml parsed to zero objects");
  if (classes.length < 10) throw new Error(`players.xml: only ${classes.length} classes parsed`);
  const byType = new Map(objects.map((o) => [parseNum(o["@_type"]), o]));
  log(`  ${objects.length} objects, ${classes.length} classes`);

  const { ts, entries: catalog } = readCatalog();
  const itemMap = JSON.parse(fs.readFileSync(ITEM_MAP, "utf8"));
  itemMap.extra ??= {};
  itemMap.minEnchants ??= {};
  const realmItems = JSON.parse(fs.readFileSync(REALM_ITEMS, "utf8"));
  const siteNames = new Set(catalog.map((c) => loose(c.name)));
  const siteTypes = new Set(Object.values(itemMap.communism));
  // Ids the site already uses; a type's capitalism id can be reused unless it
  // collides with one of these. Minted slugs must avoid every id anywhere.
  const siteIds = new Set([...catalog.map((c) => c.id), ...Object.keys(itemMap.communism)]);
  const takenIds = new Set([...siteIds, ...Object.keys(itemMap.extra)]);
  const extraIdByType = new Map();
  for (const [id, t] of Object.entries(itemMap.extra)) if (!extraIdByType.has(t)) extraIdByType.set(t, id);
  const realmByType = new Map(realmItems.map((it) => [Number(it.realmId), it]));

  // Every tradeable item (not Soulbound in equip.xml), and what of it the site lacks.
  const skipped = [];
  const tradeable = [];
  for (const o of objects) {
    const type = parseNum(o["@_type"]);
    if (tradeableItem(o, (r) => { if ("Item" in o && !("Soulbound" in o)) skipped.push(`${type} ${itemName(o)}: ${r}`); })) tradeable.push({ type, o });
  }
  const seenNames = new Set();
  const missing = [];
  for (const { type, o } of tradeable) {
    const name = itemName(o);
    if (siteTypes.has(type) || siteNames.has(loose(name))) continue;
    if (seenNames.has(loose(name))) { skipped.push(`${type} ${name}: duplicate name in xml`); continue; }
    seenNames.add(loose(name));
    const slot = Number(o.SlotType);
    let id = extraIdByType.get(type);
    if (!id || siteIds.has(id)) { id = slug(name); let n = 2; while (takenIds.has(id)) id = `${slug(name)}_${n++}`; }
    siteIds.add(id);
    takenIds.add(id);
    const tex = firstTexture(o);
    const cls = classify(o);
    missing.push({ type, id, name, slot, group: slotGroup(slot), category: cls.category, subtype: cls.subtype, tier: cls.tier, classes: classesFor(slot, classes), feedPower: o.feedPower ? Number(o.feedPower) : null, texture: tex ? { file: String(tex.File), index: parseNum(tex.Index) } : null, animated: !!o.AnimatedTexture });
  }
  log(`  ${tradeable.length} tradeable items in equip.xml; ${missing.length} not on the site`);
  const byCat = {};
  for (const m of missing) byCat[m.category] = (byCat[m.category] ?? 0) + 1;
  if (missing.length) log(`  by category: ${Object.entries(byCat).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (VERBOSE && skipped.length) log(`  skipped (non-soulbound but not a real item):\n    ${skipped.join("\n    ")}`);

  // Health of what is already listed.
  const gone = [], nowSoulbound = [];
  for (const c of catalog) {
    const t = itemMap.communism[c.id];
    if (t === undefined) continue;
    const o = byType.get(t);
    if (!o) gone.push(`${c.name} (${c.id}, type ${t})`);
    else if ("Soulbound" in o) nowSoulbound.push(`${c.name} (${c.id})`);
  }
  if (nowSoulbound.length) log(`\nWARNING: ${nowSoulbound.length} listed item(s) are now soulbound in equip.xml (not removed):\n  ${nowSoulbound.join("\n  ")}`);
  if (gone.length) log(`\nNOTE: ${gone.length} listed item(s) are not in equip.xml (eggs and consumables live elsewhere; the rest may be retired):\n  ${gone.join("\n  ")}`);

  // Listed items whose realm-items entry is missing or has no sprite render
  // as blank tiles; complete those from the xml too.
  const blank = [];
  for (const c of catalog) {
    const type = itemMap.communism[c.id];
    const o = byType.get(type);
    if (!o || realmByType.get(type)?.sprite) continue;
    const slot = Number(o.SlotType);
    const tex = firstTexture(o);
    blank.push({ type, id: c.id, name: c.name, slot, group: slotGroup(slot), classes: classesFor(slot, classes), feedPower: o.feedPower ? Number(o.feedPower) : null, texture: tex ? { file: String(tex.File), index: parseNum(tex.Index) } : null, animated: !!o.AnimatedTexture });
  }
  if (blank.length) log(`  ${blank.length} listed item(s) have no sprite yet: ${blank.map((b) => b.name).join(", ")}`);

  if (!missing.length && !blank.length) { log("\nnothing to add — the site already lists every tradeable item."); return; }
  if (missing.length) log("\nto add:");
  for (const m of missing) log(`  ${m.type}\t${m.id}\t${m.name}\t${m.category}${m.classes[0] === "ALL" ? "" : ` [${m.classes.join(",")}]`}${realmByType.has(m.type) ? "" : "  (new sprite)"}`);
  if (DRY) { log("\n--dry-run: nothing written."); return; }

  // Sprites for items realm-items.json does not know yet.
  const needSprite = [...missing.filter((m) => !realmByType.get(m.type)?.sprite), ...blank];
  let sheets = null; const atlases = {};
  if (needSprite.length) {
    sheets = spriteIndex(await get("extracted_assets/TextAsset/spritesheetf.bytes"));
    for (const m of needSprite) {
      if (m.animated || !m.texture) { log(`  WARNING: ${m.name} has ${m.animated ? "an animated" : "no"} texture — sprite left blank`); continue; }
      const s = sheets.get(m.texture.file)?.get(m.texture.index);
      if (!s || !ATLAS_FILES[s.atlas]) { log(`  WARNING: ${m.name}: ${m.texture.file}[${m.texture.index}] not in the sprite index — sprite left blank`); continue; }
      atlases[s.atlas] ??= await sharp(await get(`extracted_assets/Texture2D/${ATLAS_FILES[s.atlas]}`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      m.sprite = (await renderTile(atlases[s.atlas], s)).toString("base64");
    }
  }

  // realm-items.json: add or complete entries.
  let addedItems = 0, filledSprites = 0;
  for (const m of [...missing, ...blank]) {
    const existing = realmByType.get(m.type);
    if (existing) {
      if (!existing.sprite && m.sprite) { existing.sprite = m.sprite; filledSprites++; }
      existing.classes ??= m.classes; existing.slot ??= m.group; existing.feedPower ??= m.feedPower;
      continue;
    }
    realmItems.push({ id: m.id, realmId: String(m.type), name: m.name, tier: m.tier !== null ? `T${m.tier}` : null, sprite: m.sprite ?? "", classes: m.classes, slot: m.group, feedPower: m.feedPower });
    addedItems++;
  }
  fs.writeFileSync(REALM_ITEMS, JSON.stringify(realmItems, null, 2) + "\n");

  // itemMap.json (communism): keep the generator's sorted, indent-1 layout.
  for (const m of missing) itemMap.communism[m.id] = m.type;

  const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (missing.length) {
    fs.writeFileSync(ITEM_MAP, JSON.stringify({ communism: sorted(itemMap.communism), extra: sorted(itemMap.extra), minEnchants: sorted(itemMap.minEnchants ?? {}) }, null, 1));
    fs.writeFileSync(CATALOG_TS, spliceCatalog(ts, missing.map(catalogLine)));
  }

  log(`\nwrote ${missing.length} catalog entries, ${missing.length} item-map ids, ${addedItems} realm-items entries (+${filledSprites} sprites filled)`);
  for (const script of ["build-class-index.mjs", "build-spritesheet.mjs", "build-item-tooltips.mjs"]) {
    log(`\n> node scripts/${script}`);
    execFileSync(process.execPath, [path.join(ROOT, "scripts", script), "--base", BASE], { stdio: "inherit" });
  }
  log("\ndone. Review `git diff`, then commit and deploy.");
}

main().catch((e) => { console.error(e); process.exit(1); });
