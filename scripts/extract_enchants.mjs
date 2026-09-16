// One-shot extractor: rotmgenchants.txt (scraped HTML) -> realm-enchants.json.
// Output shape mirrors realm-items.json:
//   [{ id, realmId, name, sprite }, ...]
// `id` is a slug, `realmId` is the numeric server ID used by the protocol.
// Run with: node scripts/extract_enchants.mjs
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "rotmgenchants.txt");
const OUT = path.join(process.cwd(), "realm-enchants.json");

const html = fs.readFileSync(SRC, "utf8");

// Each enchant card looks like:
//   <a href="/enchantment?id=N">
//     <div class="card preview-card">
//       <div class="card-header"> NAME </div>
//       <div class="card-body">
//         <div class="gameobject">
//           <img class="game-sprite" src="data:image/png;base64,..." >
// Parse them in document order so the three fields stay aligned per entry.
const cardRe =
  /<a href="\/enchantment\?id=(\d+)">[\s\S]*?<div class="card-header">\s*([^<]+?)\s*<\/div>[\s\S]*?<img[^>]+src="data:image\/png;base64,([^"]+)"/g;

const entries = [];
const seenSlugs = new Map();
for (const m of html.matchAll(cardRe)) {
  const realmId = m[1];
  const name = m[2].trim();
  const sprite = m[3];

  // Slug: lowercased, non-alphanum -> "_", deduped if a name collides.
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = `enchant_${realmId}`;
  const used = seenSlugs.get(slug) ?? 0;
  if (used > 0) slug = `${slug}_${used + 1}`;
  seenSlugs.set(slug, used + 1);

  entries.push({ id: slug, realmId, name, sprite });
}

fs.writeFileSync(OUT, JSON.stringify(entries, null, 2));
console.log(`wrote ${entries.length} enchantments -> ${OUT}`);
