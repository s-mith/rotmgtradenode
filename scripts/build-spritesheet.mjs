// Pack every catalog item's 40x40 sprite into one PNG spritesheet + a name->
// index atlas, so the frontend downloads sprites ONCE (cached, content-hashed)
// instead of the site reshipping ~1.15 KB of base64 per item on every poll.
//
// Uniform 40x40 sprites => a plain fixed grid, no atlas packer needed. Sprites
// are matched by the same normalized name sprites.ts uses, so both catalog
// tiles and pool instances (which resolve to catalog names) share the sheet.
//
//   node scripts/build-spritesheet.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const ROOT = process.cwd();
const TILE = 40;
const COLS = 32;
const OUT_DIR = path.join(ROOT, "public", "sprites");
const ATLAS = path.join(ROOT, "src", "lib", "sprite-atlas.json");

// Same normalization as src/lib/sprites.ts (strip UT./ST./T# display prefix).
const normalize = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

// normName -> base64 sprite, first occurrence wins (mirrors getSpriteMap).
function spriteByName() {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, "realm-items.json"), "utf8"));
  const m = new Map();
  for (const it of items) {
    if (!it.sprite) continue;
    const k = normalize(it.name);
    if (!m.has(k)) m.set(k, it.sprite);
  }
  return m;
}

// Catalog item names, in file order (stable tile indices across rebuilds as
// long as items are only appended).
function catalogNames() {
  const ts = fs.readFileSync(path.join(ROOT, "src/lib/catalog.ts"), "utf8");
  return [...ts.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

async function main() {
  const sprites = spriteByName();
  const names = catalogNames();

  const index = {};          // normName -> tile index
  const composites = [];      // sharp composite ops
  const missing = [];
  let i = 0;
  const seen = new Set();
  for (const name of names) {
    const key = normalize(name);
    if (seen.has(key)) continue;   // dedup: one tile per distinct sprite name
    seen.add(key);
    const b64 = sprites.get(key);
    if (!b64) { missing.push(name); continue; }
    index[key] = i;
    composites.push({
      input: Buffer.from(b64, "base64"),
      left: (i % COLS) * TILE,
      top: Math.floor(i / COLS) * TILE,
    });
    i++;
  }

  const rows = Math.ceil(i / COLS);
  const width = COLS * TILE;
  const height = rows * TILE;

  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    // Truecolor, lossless. NOT palette/quantized: RotMG sprites are exact pixel
    // art and a <=256-color palette across all 593 sprites would dither them.
    .png({ compressionLevel: 9 })
    .toBuffer();

  const hash = crypto.createHash("sha256").update(png).digest("hex").slice(0, 10);
  const file = `items.${hash}.png`;

  // Drop any previous sheet so stale hashes don't pile up in public/.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) if (/^items\.[0-9a-f]+\.png$/.test(f)) fs.rmSync(path.join(OUT_DIR, f));
  fs.writeFileSync(path.join(OUT_DIR, file), png);

  const atlas = { file: `/sprites/${file}`, tile: TILE, cols: COLS, rows, count: i, index };
  fs.writeFileSync(ATLAS, JSON.stringify(atlas, null, 2));

  const kb = (png.length / 1024).toFixed(1);
  console.log(`sheet: ${width}x${height}px, ${i} tiles, ${kb} KB -> public/sprites/${file}`);
  console.log(`atlas: ${path.relative(ROOT, ATLAS)} (${Object.keys(index).length} names)`);
  if (missing.length) {
    console.log(`\nWARNING: ${missing.length} catalog item(s) have no sprite (blank tiles):`);
    console.log(missing.map((n) => `  - ${n}`).join("\n"));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
