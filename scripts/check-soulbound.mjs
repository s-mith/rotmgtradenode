// Check live realm.wiki soulbound status for a set of items. Tradable = the
// item detail page has NO populated soulbound span. The `.itemtooltip-body-
// stats-soulbound { ... }` CSS rule is on every page and must NOT count; only
// a real `class='itemtooltip-body-stats-soulbound'>Soulbound</span>` element
// marks an item soulbound. Caches results so re-runs are cheap/resumable.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = "https://realm.wiki";
const UA = "rotmgcommunism-catalog-sync/1.0 (personal wiki data sync)";
const CACHE = path.join(ROOT, "data", "soulbound-cache.json");
const CONCURRENCY = 6;

// input: JSON file of [{name, realmId|_realmId}, ...]; default = the candidates
const INPUT = process.argv[2] || path.join(ROOT, "data", "untiered-tradable-candidates.json");

const SB_RE = /itemtooltip-body-stats-soulbound['"]\s*>\s*Soulbound\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
let cacheDirty = 0;

async function soulbound(realmId) {
  const key = String(realmId);
  if (key in cache) return cache[key];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/item?id=${realmId}`, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(res.status);
      const html = await res.text();
      const sb = SB_RE.test(html);
      cache[key] = sb;
      if (++cacheDirty % 25 === 0) fs.writeFileSync(CACHE, JSON.stringify(cache));
      return sb;
    } catch (e) {
      if (attempt === 2) { console.warn(`  ! ${realmId}: ${e.message}`); return null; }
      await sleep(500 * (attempt + 1));
    }
  }
}

async function main() {
  const items = JSON.parse(fs.readFileSync(INPUT, "utf8"))
    .map((x) => ({ name: x.name, realmId: String(x.realmId ?? x._realmId) }));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  console.log(`checking soulbound for ${items.length} items (cache has ${Object.keys(cache).length})...`);

  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const sbs = await Promise.all(batch.map((it) => soulbound(it.realmId)));
    batch.forEach((it, j) => results.push({ ...it, soulbound: sbs[j] }));
    if (i % 60 === 0) process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, items.length)}/${items.length}`);
    await sleep(120);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const soulboundItems = results.filter((r) => r.soulbound === true);
  const errors = results.filter((r) => r.soulbound === null);
  console.log(`\n\n=== soulbound check ===`);
  console.log(`total: ${results.length}`);
  console.log(`SOULBOUND (untradable, should NOT be in catalog): ${soulboundItems.length}`);
  console.log(`tradable: ${results.filter((r) => r.soulbound === false).length}`);
  console.log(`fetch errors: ${errors.length}`);
  if (soulboundItems.length) {
    console.log(`\nsoulbound items:`);
    console.log(soulboundItems.map((r) => `  ${r.realmId}  ${r.name}`).join("\n"));
  }
  fs.writeFileSync(path.join(ROOT, "data", "soulbound-report.json"),
    JSON.stringify({ soulbound: soulboundItems, errors }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
