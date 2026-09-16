import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCES = ["rings.txt", "abilities.txt", "armour.txt", "weapons.txt", "statpots.txt"];
const OUT = path.join(ROOT, "realm-items.json");

const RECORD_RE =
  /<a\s+href="\/item\?id=(\d+)"[\s\S]*?<div class="card-header">\s*(?:(T\d+(?:\.\d+)?)\.\s+)?([^<\n]+?)\s*<\/div>[\s\S]*?<img[^>]*src="data:image\/png;base64,([^"]+)"/g;

const byName = new Map();
let totalRecords = 0;
let dupes = 0;

for (const src of SOURCES) {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) {
    console.warn(`skip: ${src} not found`);
    continue;
  }
  const html = fs.readFileSync(file, "utf8");
  let m;
  let count = 0;
  while ((m = RECORD_RE.exec(html)) !== null) {
    const [, realmId, tier, rawName, sprite] = m;
    const name = rawName.trim();
    count++;
    totalRecords++;
    if (byName.has(name)) {
      dupes++;
      continue;
    }
    byName.set(name, {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      realmId,
      name,
      tier: tier ?? null,
      sprite,
    });
  }
  console.log(`${src}: ${count} records`);
}

const items = [...byName.values()];
fs.writeFileSync(OUT, JSON.stringify(items, null, 2));
const sizeKb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`\nwrote ${items.length} unique items to realm-items.json (${sizeKb} KB)`);
console.log(`total records seen: ${totalRecords}, duplicate names skipped: ${dupes}`);
