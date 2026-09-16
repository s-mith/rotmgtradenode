import fs from "node:fs";
import path from "node:path";

// Enriches realm-items.json with a `classes` field per item by scraping
// realm.wiki item pages for their "Usable by:" class list.
//
//   node scripts/build-item-classes.mjs            # full run
//   node scripts/build-item-classes.mjs --limit 20 # sample the first N items
//   node scripts/build-item-classes.mjs --ids 2718,2652
//
// Rules:
//   - "Usable by:" present  -> classes = [parsed class names]
//   - "Usable by:" absent    -> classes = ["ALL"] (rings and other all-class gear)
//   - potions are skipped (classes = null) and handled separately elsewhere.

const ROOT = process.cwd();
const ITEMS_PATH = path.join(ROOT, "realm-items.json");
const BASE = "https://realm.wiki/item?id=";
const CONCURRENCY = 6;
const RETRIES = 3;

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = getFlag("--limit") ? Number(getFlag("--limit")) : Infinity;
const idFilter = getFlag("--ids")
  ? new Set(getFlag("--ids").split(",").map((s) => s.trim()))
  : null;
const dryRun = args.includes("--dry-run");

const USABLE_RE = /<strong>\s*Usable by:\s*<\/strong>\s*<ul>([\s\S]*?)<\/ul>/i;
const CLASS_RE = /<a[^>]*href=['"]\/object\?id=(\d+)['"][^>]*>([^<]+)<\/a>/g;

// Potions are handled separately; detect them by name so we can skip.
const isPotion = (item) => /\bpotion\b|\bpot of\b/i.test(item.name);

function parseClasses(html) {
  const block = html.match(USABLE_RE);
  if (!block) return ["ALL"]; // no restriction listed -> usable by every class
  const classes = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(block[1])) !== null) classes.push(m[2].trim());
  return classes.length ? classes : ["ALL"];
}

async function fetchClasses(realmId) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(BASE + realmId, {
        headers: { "user-agent": "rotmgcommunism-classbuilder/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseClasses(await res.text());
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function run() {
  const items = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));

  let targets = items.filter((it) => it.realmId);
  if (idFilter) targets = targets.filter((it) => idFilter.has(String(it.realmId)));
  if (Number.isFinite(limit)) targets = targets.slice(0, limit);

  let done = 0;
  let skipped = 0;
  let errors = 0;
  const results = new Map();

  // Simple concurrency-limited worker pool.
  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (isPotion(item)) {
        results.set(item.realmId, null);
        skipped++;
        continue;
      }
      try {
        const classes = await fetchClasses(item.realmId);
        results.set(item.realmId, classes);
      } catch (err) {
        errors++;
        console.warn(`  ! ${item.name} (${item.realmId}): ${err.message}`);
      }
      done++;
      if (done % 50 === 0) console.log(`  ...${done}/${targets.length}`);
    }
  }

  console.log(`scraping ${targets.length} items (concurrency ${CONCURRENCY})...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Sample report.
  const sample = targets.slice(0, 20).map((it) => ({
    name: it.name,
    classes: results.has(it.realmId) ? results.get(it.realmId) : "(error)",
  }));
  console.log("\nsample:");
  for (const s of sample) {
    console.log(`  ${s.name} -> ${s.classes === null ? "(potion, skipped)" : JSON.stringify(s.classes)}`);
  }
  console.log(`\ndone: ${done}, skipped potions: ${skipped}, errors: ${errors}`);

  if (dryRun) {
    console.log("\n--dry-run: realm-items.json NOT written.");
    return;
  }

  // Only write when doing a full pass (no filters), so a sample run can't
  // wipe classes off the items it didn't touch.
  if (idFilter || Number.isFinite(limit)) {
    console.log("\nfiltered/limited run: realm-items.json NOT written (use full run to persist).");
    return;
  }

  for (const it of items) {
    if (results.has(it.realmId)) it.classes = results.get(it.realmId);
  }
  fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
  console.log(`\nwrote classes into realm-items.json (${items.length} items).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
