// Scrape realm.wiki for UNTIERED + TRADEABLE items across Ring/Armor/Ability/
// Weapon, cross-reference the existing catalog, and emit review candidates for
// src/lib/catalog.ts (category "UT/ST"). Non-destructive: writes a JSON review
// file only. Reuses the card-header HTML shape that build-items-json.mjs parses.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = "https://realm.wiki";
const CATEGORIES = ["Ring", "Armor", "Ability", "Weapon"];
const OUT = path.join(ROOT, "data", "untiered-tradable-candidates.json");
const UA = "rotmgcommunism-catalog-sync/1.0 (personal wiki data sync)";

// <a href="/item?id=ID> ... <div class="card-header"> [PREFIX. ]NAME </div>
// PREFIX is a tier (T12) or rarity marker (UT/ST). Untiered => not a T\d+.
const RECORD_RE =
  /<a\s+href=['"]\/item\?id=(\d+)['"][^>]*>[\s\S]*?<div class=['"]card-header['"]>\s*(?:(T\d+(?:\.\d+)?|UT|ST)\.\s+)?([^<]+?)\s*<\/div>/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function parseRecords(html) {
  const out = [];
  let m;
  while ((m = RECORD_RE.exec(html)) !== null) {
    const [, realmId, prefix, rawName] = m;
    out.push({
      realmId,
      prefix: prefix ?? null,
      name: rawName.trim(),
      tiered: /^T\d/.test(prefix ?? ""),
    });
  }
  return out;
}

// Existing catalog names, normalized the same way sprites.ts matches, so we
// don't re-add anything already tradable on the site.
function existingCatalogNames() {
  const ts = fs.readFileSync(path.join(ROOT, "src/lib/catalog.ts"), "utf8");
  const names = new Set();
  const re = /name:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(ts)) !== null) names.add(normalize(m[1]));
  return names;
}
const normalize = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

// short, unique id from the name initials; fall back to a slug, then suffix.
function makeId(name, taken) {
  const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const candidates = [
    words.map((w) => w[0]).join(""),
    words.map((w) => w[0]).join("") + (words.at(-1)?.slice(1, 2) ?? ""),
    words.join("_"),
  ];
  for (const base of candidates) {
    if (base && base.length >= 2 && !taken.has(base)) { taken.add(base); return base; }
  }
  let i = 2, base = words.map((w) => w[0]).join("") || "item";
  while (taken.has(base + i)) i++;
  taken.add(base + i);
  return base + i;
}

async function main() {
  // 1. tradeable set (one request)
  console.log("fetching TRADEABLE label list...");
  const tradeableIds = new Set(
    parseRecords(await fetchHtml(`${BASE}/list/ItemLabel?label=TRADEABLE`)).map((r) => r.realmId)
  );
  console.log(`  tradeable items: ${tradeableIds.size}`);

  // 2. category lists -> untiered records
  const untiered = [];
  for (const cat of CATEGORIES) {
    await sleep(600);
    console.log(`fetching ${cat}...`);
    const recs = parseRecords(await fetchHtml(`${BASE}/list/ItemLabel?label=${cat}`));
    const u = recs.filter((r) => !r.tiered);
    console.log(`  ${recs.length} items, ${u.length} untiered`);
    for (const r of u) untiered.push({ ...r, category: cat });
  }

  // 3. filter tradeable, dedup vs catalog + within results
  const existing = existingCatalogNames();
  const taken = new Set();
  {
    const ts = fs.readFileSync(path.join(ROOT, "src/lib/catalog.ts"), "utf8");
    let m; const re = /id:\s*"([^"]+)"/g;
    while ((m = re.exec(ts)) !== null) taken.add(m[1]);
  }

  const JUNK_RE = /\b(test|dev|debug|dummy|placeholder|admin|unreleased)\b/i;
  const seen = new Set();
  const candidates = [];
  const skippedExisting = [];
  let skippedJunk = 0;
  for (const r of untiered) {
    if (!tradeableIds.has(r.realmId)) continue;      // must be tradeable
    if (JUNK_RE.test(r.name)) { skippedJunk++; continue; } // drop test/dev items
    const key = normalize(r.name);
    if (seen.has(key)) continue;                     // dedup within scrape
    seen.add(key);
    if (existing.has(key)) { skippedExisting.push(r.name); continue; }
    const subtype = r.category === "Ring" ? "Ring" : r.category === "Armor" ? "Armor" : undefined;
    candidates.push({
      id: makeId(normalize(r.name), taken),
      name: r.name,                                   // original Title Case (prefix already stripped)
      category: "UT/ST",
      ...(subtype ? { subtype } : {}),
      _realmId: r.realmId,
      _sourceLabel: r.category,
    });
  }
  if (skippedJunk) console.log(`skipped ${skippedJunk} test/dev items`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(candidates, null, 2));
  console.log(`\n=== summary ===`);
  console.log(`untiered+tradeable found: ${candidates.length + skippedExisting.length}`);
  console.log(`already in catalog (skipped): ${skippedExisting.length}`);
  console.log(`NEW candidates written: ${candidates.length} -> ${path.relative(ROOT, OUT)}`);
  console.log(`by source label:`, CATEGORIES.map((c) => `${c}=${candidates.filter((x) => x._sourceLabel === c).length}`).join(" "));
}

main().catch((e) => { console.error(e); process.exit(1); });
