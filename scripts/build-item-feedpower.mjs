import fs from "node:fs";
import path from "node:path";

// Enriches realm-items.json with a `feedPower` field per item by scraping the
// realm.wiki item pages (same source as build-item-classes.mjs).
//
//   node scripts/build-item-feedpower.mjs            # full run
//   node scripts/build-item-feedpower.mjs --limit 20 # sample the first N
//   node scripts/build-item-feedpower.mjs --ids 2718,2982
//   node scripts/build-item-feedpower.mjs --dry-run
//
// feedPower is the pet feed value; items whose page shows none get null.

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

const FEED_RE = /Feed Power:\s*([\d,]+)/i;

function parseFeedPower(html) {
  const m = html.match(FEED_RE);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchFeedPower(realmId) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(BASE + realmId, {
        headers: { "user-agent": "rotmgcommunism-feedbuilder/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseFeedPower(await res.text());
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

  const results = new Map();
  let done = 0;
  let missing = 0;
  let errors = 0;

  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const fp = await fetchFeedPower(item.realmId);
        results.set(item.realmId, fp);
        if (fp == null) missing++;
      } catch (err) {
        errors++;
        console.warn(`  ! ${item.name} (${item.realmId}): ${err.message}`);
      }
      done++;
      if (done % 100 === 0) console.log(`  ...${done}/${targets.length}`);
    }
  }

  console.log(`scraping feed power for ${targets.length} items (concurrency ${CONCURRENCY})...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("\nsample:");
  for (const it of targets.slice(0, 20)) {
    const fp = results.has(it.realmId) ? results.get(it.realmId) : "(error)";
    console.log(`  ${it.name} -> ${fp === null ? "(none)" : fp}`);
  }
  console.log(`\ndone: ${done}, no feed power: ${missing}, errors: ${errors}`);

  if (dryRun) {
    console.log("\n--dry-run: realm-items.json NOT written.");
    return;
  }
  if (idFilter || Number.isFinite(limit)) {
    console.log("\nfiltered/limited run: realm-items.json NOT written (use a full run to persist).");
    return;
  }

  for (const it of items) {
    if (results.has(it.realmId)) it.feedPower = results.get(it.realmId);
  }
  fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
  console.log(`\nwrote feedPower into realm-items.json (${items.length} items).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
