// Scrape realm.wiki for all TRADABLE character skins (name + sprite image).
//
// Source of the skin list: https://realm.wiki/search?query=skin — every result
// block carries the display name and a base64 `game-sprite` PNG that is
// byte-identical to the item page's tooltip icon, so no per-item image fetch is
// needed. Tradability is decided per item page exactly like check-soulbound.mjs:
// a skin is tradable iff its /item?id= page has NO populated
// `class='itemtooltip-body-stats-soulbound'>Soulbound</span>` element. The bare
// `.itemtooltip-body-stats-soulbound { ... }` CSS rule is on every page and must
// NOT count. Soulbound lookups are cached in data/soulbound-cache.json so
// re-runs are cheap and resumable.
//
// Outputs:
//   public/skins/<realmId>.png   decoded sprite for each tradable skin
//   data/skins.json              [{ realmId, name, image }] sorted by name
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = "https://realm.wiki";
const UA = "rotmgcommunism-catalog-sync/1.0 (personal wiki data sync)";
const CACHE = path.join(ROOT, "data", "soulbound-cache.json");
const IMG_DIR = path.join(ROOT, "public", "skins");
const MANIFEST = path.join(ROOT, "src", "lib", "skins.json");
const CONCURRENCY = 6;

const SB_RE = /itemtooltip-body-stats-soulbound['"]\s*>\s*Soulbound\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
let cacheDirty = 0;

async function fetchText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(res.status);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function soulbound(realmId) {
  const key = String(realmId);
  if (key in cache) return cache[key];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/item?id=${realmId}`, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(res.status);
      const sb = SB_RE.test(await res.text());
      cache[key] = sb;
      if (++cacheDirty % 25 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache));
      return sb;
    } catch (e) {
      if (attempt === 2) { console.warn(`  ! ${realmId}: ${e.message}`); return null; }
      await sleep(500 * (attempt + 1));
    }
  }
}

// Pull { realmId, name, image } out of every search-result card. Only real
// character skins are kept: the name must END in "Skin", which excludes the
// "... Skin SB" soulbound dupes, "... Skin Unlocker" pet consumables, and the
// chest/bag/agreement containers that merely contain the word.
function parseSkins(html) {
  const re =
    /<a href='\/item\?id=(\d+)'>.*?<div class='card-header'>\s*(.*?)\s*<\/div>.*?<img class='game-sprite' src='(data:image\/png;base64,[^']+)'/gs;
  const out = [];
  for (const m of html.matchAll(re)) {
    const [, realmId, name, image] = m;
    if (!/skin$/i.test(name.trim())) continue;
    out.push({ realmId, name: name.trim(), image });
  }
  return out;
}

async function main() {
  console.log("fetching search index...");
  const search = await fetchText(`${BASE}/search?query=skin`);
  const skins = parseSkins(search);
  console.log(`found ${skins.length} character skins in the index`);

  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  console.log(`checking soulbound (cache has ${Object.keys(cache).length})...`);

  const results = [];
  for (let i = 0; i < skins.length; i += CONCURRENCY) {
    const batch = skins.slice(i, i + CONCURRENCY);
    const sbs = await Promise.all(batch.map((s) => soulbound(s.realmId)));
    batch.forEach((s, j) => results.push({ ...s, soulbound: sbs[j] }));
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, skins.length)}/${skins.length}`);
    await sleep(120);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const tradable = results.filter((r) => r.soulbound === false);
  const soulboundItems = results.filter((r) => r.soulbound === true);
  const errors = results.filter((r) => r.soulbound === null);

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const manifest = [];
  for (const s of tradable) {
    const b64 = s.image.slice(s.image.indexOf(",") + 1);
    fs.writeFileSync(path.join(IMG_DIR, `${s.realmId}.png`), Buffer.from(b64, "base64"));
    manifest.push({ realmId: s.realmId, name: s.name, image: `/skins/${s.realmId}.png` });
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`\n\n=== skin scrape ===`);
  console.log(`skins checked:   ${results.length}`);
  console.log(`TRADABLE:        ${tradable.length}  -> ${manifest.length} images + data/skins.json`);
  console.log(`soulbound:       ${soulboundItems.length}`);
  console.log(`fetch errors:    ${errors.length}`);
  if (errors.length)
    console.log(`  ` + errors.map((e) => e.realmId).join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
