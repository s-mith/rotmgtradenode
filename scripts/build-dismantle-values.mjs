import fs from "node:fs";
import path from "node:path";

// Scrapes RealmEye's wiki for the Forge "Dismantling Value" of every UT/ST
// item in the catalog and writes data/dismantle-values.json, keyed by catalog
// item id:
//   { "sep": { name, common, rare, legendary, mythical } }
// where each field is the count of that Forge material tier the item dismantles
// to (null if that tier isn't listed for the item).
//
//   node scripts/build-dismantle-values.mjs            # full run
//   node scripts/build-dismantle-values.mjs --limit 8  # sample the first N
//   node scripts/build-dismantle-values.mjs --dry-run
//
// RealmEye throttles bursts (HTTP 204), so requests are sequential with a delay
// and 204/error backoff. Items whose page has no dismantle row are recorded as
// { rare: null, common: null } and reported so they can be checked by hand.

const ROOT = process.cwd();
const CATALOG_TS = path.join(ROOT, "src", "lib", "catalog.ts");
const OUT = path.join(ROOT, "data", "dismantle-values.json");
const BASE = "https://www.realmeye.com/wiki/";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const DELAY_MS = 300;
const RETRIES = 5;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const limit = flag("--limit") ? Number(flag("--limit")) : Infinity;
const dryRun = args.includes("--dry-run");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RealmEye slug: lowercase, then any run of non-alphanumeric characters
// (spaces, apostrophes, punctuation) becomes a single hyphen — e.g.
// "Sun's Judgement" → "sun-s-judgement".
const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Pull every { id, name, category: "UT/ST" } record out of catalog.ts.
function readUtStItems() {
  const src = fs.readFileSync(CATALOG_TS, "utf8");
  const re = /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"[^}]*category:\s*"UT\/ST"[^}]*\}/g;
  const items = [];
  let m;
  while ((m = re.exec(src)) !== null) items.push({ id: m[1], name: m[2] });
  return items;
}

const DISMANTLE_RE = /Dismantling Value<\/th>\s*<td>([\s\S]*?)<\/td>/;
// Count preceding each material-icon <img>, keyed by the Forge material tier.
const matCount = (body, tier) => {
  const m = body.match(new RegExp(`(\\d+)\\s*<a[^>]*>\\s*<img alt="${tier} Material"`));
  return m ? Number(m[1]) : null;
};
function parseDismantle(html) {
  const row = html.match(DISMANTLE_RE);
  if (!row) return null;
  const body = row[1];
  return {
    common: matCount(body, "Common"),
    rare: matCount(body, "Rare"),
    legendary: matCount(body, "Legendary"),
    mythical: matCount(body, "Mythical"),
  };
}

async function fetchPage(slug) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(BASE + slug, { headers: { "user-agent": UA } });
      if (res.status === 200) return await res.text();
      if (res.status === 404) return null; // no such page
      // 204 / 429 / 5xx → throttled or transient; back off and retry.
      if (attempt < RETRIES) await sleep(DELAY_MS * (attempt + 1));
    } catch {
      if (attempt < RETRIES) await sleep(DELAY_MS * (attempt + 1));
    }
  }
  return undefined; // exhausted retries
}

async function run() {
  let items = readUtStItems();
  if (Number.isFinite(limit)) items = items.slice(0, limit);
  console.log(`scraping dismantle values for ${items.length} UT/ST items...`);

  const out = {};
  const misses = [];
  let done = 0;
  for (const it of items) {
    const html = await fetchPage(slugify(it.name));
    if (html === undefined) {
      misses.push(`${it.name} (fetch failed)`);
    } else if (html === null) {
      misses.push(`${it.name} (404: /wiki/${slugify(it.name)})`);
    } else {
      const dv = parseDismantle(html);
      if (!dv) {
        misses.push(`${it.name} (no dismantle row)`);
      } else if (
        dv.common === null && dv.rare === null && dv.legendary === null && dv.mythical === null
      ) {
        misses.push(`${it.name} (dismantle row, no material parsed)`);
      } else {
        out[it.id] = {
          name: it.name,
          common: dv.common,
          rare: dv.rare,
          legendary: dv.legendary,
          mythical: dv.mythical,
        };
      }
    }
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${items.length} (${misses.length} misses)`);
    await sleep(DELAY_MS);
  }

  const found = Object.keys(out).length;
  console.log(`\nfound ${found}/${items.length}; ${misses.length} misses`);
  if (misses.length) {
    console.log("misses:");
    for (const m of misses.slice(0, 60)) console.log("  " + m);
    if (misses.length > 60) console.log(`  … and ${misses.length - 60} more`);
  }
  // Sample of what we got.
  console.log("\nsample:");
  for (const [id, v] of Object.entries(out).slice(0, 8)) {
    const parts = [];
    if (v.mythical != null) parts.push(`${v.mythical} mythical`);
    if (v.legendary != null) parts.push(`${v.legendary} legendary`);
    if (v.rare != null) parts.push(`${v.rare} rare`);
    if (v.common != null) parts.push(`${v.common} common`);
    console.log(`  ${v.name}: ${parts.join(" / ")}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: data/dismantle-values.json NOT written.");
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${found} entries to data/dismantle-values.json`);
}

run().catch((e) => { console.error(e); process.exit(1); });
