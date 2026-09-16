import fs from "node:fs";
import path from "node:path";

// Emits src/lib/item-index.json: a compact
//   { normalizedName -> { classes, slot, dismantle, feedPower } }
// map derived from realm-items.json (classes/slot/feedPower) and
// data/dismantle-values.json (dismantle), so the client can filter the pool by
// class and slot and show dismantle / feed values without shipping the 2.5 MB
// item file.
//
//   node scripts/build-class-index.mjs
//
//   classes:   string[] of class names ("ALL" = every class), or null (potions)
//   slot:      "weapon" | "ability" | "armor" | "ring" | null
//   dismantle: { common, rare, legendary, mythical } Forge material counts, or null
//   feedPower: pet feed value (number), or null
//
// Normalization matches ItemSprite/sprites.ts so pool instances (which carry
// item names) resolve the same way sprites do.

const ROOT = process.cwd();
const ITEMS_PATH = path.join(ROOT, "realm-items.json");
const DISMANTLE_PATH = path.join(ROOT, "data", "dismantle-values.json");
const OUT = path.join(ROOT, "src", "lib", "item-index.json");

const norm = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

const items = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));
const index = {};
for (const it of items) {
  index[norm(it.name)] = {
    classes: Array.isArray(it.classes) ? it.classes : null,
    slot: it.slot ?? null,
    dismantle: null,
    feedPower: typeof it.feedPower === "number" ? it.feedPower : null,
  };
}

// Overlay dismantle values (keyed by catalog id, but each carries its name).
let dismantleMerged = 0;
if (fs.existsSync(DISMANTLE_PATH)) {
  const dv = JSON.parse(fs.readFileSync(DISMANTLE_PATH, "utf8"));
  for (const v of Object.values(dv)) {
    const key = norm(v.name);
    const d = { common: v.common, rare: v.rare, legendary: v.legendary ?? null, mythical: v.mythical };
    if (index[key]) index[key].dismantle = d;
    else index[key] = { classes: null, slot: null, dismantle: d, feedPower: null };
    dismantleMerged++;
  }
}

fs.writeFileSync(OUT, JSON.stringify(index));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(
  `wrote ${Object.keys(index).length} entries to item-index.json (${kb} KB); ` +
    `merged ${dismantleMerged} dismantle values`,
);
