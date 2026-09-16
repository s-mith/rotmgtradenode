// Reconcile the candidate set against the AUTHORITATIVE soulbound signal:
//   - remove candidates the live wiki marks soulbound (from soulbound-cache)
//   - report untiered items we MISSED: non-soulbound per capitalism's wiki-
//     derived map but absent from our set (the TRADEABLE label is unreliable)
// Rewrites data/untiered-tradable-candidates.json (removals only). Missed items
// are reported for review, not auto-added.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const RELAY = path.resolve(ROOT, "..", "rotmgcommunismpyrelay");
const BASE = "https://realm.wiki";
const UA = "rotmgcommunism-catalog-sync/1.0 (personal wiki data sync)";
const CAND = path.join(ROOT, "data", "untiered-tradable-candidates.json");
const CACHE = path.join(ROOT, "data", "soulbound-cache.json");
const CATEGORIES = ["Ring", "Armor", "Ability", "Weapon"];
const RECORD_RE =
  /<a\s+href=['"]\/item\?id=(\d+)['"][^>]*>[\s\S]*?<div class=['"]card-header['"]>\s*(?:(T\d+(?:\.\d+)?|UT|ST)\.\s+)?([^<]+?)\s*<\/div>/g;
const norm = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// capitalism's wiki-derived NON-soulbound objType universe (base curated map +
// auto-generated extras). Used only to *surface* items the label filter missed.
function nonSoulboundObjTypes() {
  const set = new Set();
  for (const f of ["Communism/ItemMap.py", "Communism/ItemMapExtra.py"]) {
    const py = fs.readFileSync(path.join(RELAY, f), "utf8");
    for (const m of py.matchAll(/"[a-z0-9_]+":\s*(\d+)/g)) set.add(Number(m[1]));
  }
  return set;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function main() {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const candidates = JSON.parse(fs.readFileSync(CAND, "utf8"));

  // 1. removals — anything the live wiki cache marks soulbound
  const kept = [], removed = [];
  for (const c of candidates) {
    if (cache[String(c._realmId)] === true) removed.push(c);
    else kept.push(c);
  }
  fs.writeFileSync(CAND, JSON.stringify(kept, null, 2));
  console.log(`removed ${removed.length} soulbound items; kept ${kept.length}.`);

  // 2. missed-item report — untiered category items that are non-soulbound
  //    (per capitalism's map) but not in the catalog or our kept set.
  const nonSB = nonSoulboundObjTypes();
  const catNames = new Set(
    [...fs.readFileSync(path.join(ROOT, "src/lib/catalog.ts"), "utf8").matchAll(/name:\s*"([^"]+)"/g)]
      .map((m) => norm(m[1]))
  );
  const keptNames = new Set(kept.map((c) => norm(c.name)));
  const seen = new Set(), missed = [];
  for (const cat of CATEGORIES) {
    await sleep(500);
    const html = await fetchHtml(`${BASE}/list/ItemLabel?label=${cat}`);
    let m;
    while ((m = RECORD_RE.exec(html)) !== null) {
      const [, realmId, prefix, rawName] = m;
      if (/^T\d/.test(prefix ?? "")) continue;            // untiered only
      const k = norm(rawName);
      if (seen.has(k)) continue; seen.add(k);
      if (catNames.has(k) || keptNames.has(k)) continue;  // already have it
      if (nonSB.has(Number(realmId))) missed.push({ name: rawName.trim(), realmId, cat });
    }
  }
  console.log(`\nMISSED (non-soulbound per capitalism map, not in catalog): ${missed.length}`);
  console.log(missed.slice(0, 40).map((x) => `  ${x.realmId}  ${x.name} (${x.cat})`).join("\n"));
  fs.writeFileSync(path.join(ROOT, "data", "missed-tradable.json"), JSON.stringify(missed, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
