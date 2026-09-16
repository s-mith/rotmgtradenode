import fs from "node:fs";
import path from "node:path";

// Tags each item in realm-items.json with a `slot` derived from which
// realm.wiki ItemLabel list page it appears on:
//   weapon  -> /list/ItemLabel?label=Weapon
//   ability -> /list/ItemLabel?label=Ability
//   armor   -> /list/ItemLabel?label=Armor
//   ring    -> /list/ItemLabel?label=Ring
//
//   node scripts/build-item-slots.mjs            # full run, writes realm-items.json
//   node scripts/build-item-slots.mjs --dry-run  # report only
//
// Items not found on any list (e.g. potions, pseudo-items) get slot = null.

const ROOT = process.cwd();
const ITEMS_PATH = path.join(ROOT, "realm-items.json");
const BASE = "https://realm.wiki/list/ItemLabel?label=";
const LABELS = { Weapon: "weapon", Ability: "ability", Armor: "armor", Ring: "ring" };
const RETRIES = 3;

const dryRun = process.argv.includes("--dry-run");

const ID_RE = /\/item\?id=(\d+)/g;

async function fetchIds(label) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(BASE + label, {
        headers: { "user-agent": "rotmgcommunism-slotbuilder/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const ids = new Set();
      let m;
      while ((m = ID_RE.exec(html)) !== null) ids.add(m[1]);
      return ids;
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function run() {
  const items = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));

  // realmId -> slot
  const slotById = new Map();
  const overlaps = [];
  for (const [label, slot] of Object.entries(LABELS)) {
    const ids = await fetchIds(label);
    console.log(`${label}: ${ids.size} items`);
    for (const id of ids) {
      if (slotById.has(id) && slotById.get(id) !== slot) {
        overlaps.push(`${id}: ${slotById.get(id)} vs ${slot}`);
      }
      slotById.set(id, slot);
    }
  }

  if (overlaps.length) {
    console.warn(`\n! ${overlaps.length} items appeared under multiple labels (last wins):`);
    for (const o of overlaps.slice(0, 20)) console.warn("  " + o);
  }

  const counts = { weapon: 0, ability: 0, armor: 0, ring: 0, null: 0 };
  let matched = 0;
  for (const it of items) {
    const slot = slotById.get(String(it.realmId)) ?? null;
    counts[slot ?? "null"]++;
    if (slot) matched++;
  }

  console.log(`\nmatched ${matched}/${items.length} items`);
  console.log("slot counts:", JSON.stringify(counts));
  const unmatched = items
    .filter((it) => !slotById.has(String(it.realmId)))
    .slice(0, 15)
    .map((it) => it.name);
  console.log("sample unmatched (slot=null):", unmatched.join(", "));

  if (dryRun) {
    console.log("\n--dry-run: realm-items.json NOT written.");
    return;
  }

  for (const it of items) {
    it.slot = slotById.get(String(it.realmId)) ?? null;
  }
  fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2));
  console.log(`\nwrote slots into realm-items.json (${items.length} items).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
