// Splice the scraped untiered+tradeable candidates into the CATALOG array in
// src/lib/catalog.ts. Idempotent: skips any name already present. Run after
// scrape-untiered-tradable.mjs. Reversible via git.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CAT = path.join(ROOT, "src/lib/catalog.ts");
const CANDIDATES = path.join(ROOT, "data", "untiered-tradable-candidates.json");
const MARKER = "// --- untiered tradeable (auto-synced from realm.wiki) ---";
const normalize = (n) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

let ts = fs.readFileSync(CAT, "utf8");
const candidates = JSON.parse(fs.readFileSync(CANDIDATES, "utf8"));

// Idempotent: strip any previously-synced block first, so re-running replaces
// it wholesale (e.g. after an id correction) instead of skipping/duplicating.
const mIdx = ts.indexOf(MARKER);
if (mIdx !== -1) {
  const blockStart = ts.lastIndexOf("\n", mIdx); // newline ending the prior entry
  const close = ts.indexOf("];", mIdx);          // CATALOG close after the block
  ts = ts.slice(0, blockStart) + "\n" + ts.slice(close);
}

// names still in the file after stripping (hand-curated entries only)
const existing = new Set([...ts.matchAll(/name:\s*"([^"]+)"/g)].map((m) => normalize(m[1])));
const fresh = candidates.filter((c) => !existing.has(normalize(c.name)));

if (fresh.length === 0) {
  console.log("nothing to add — catalog already up to date.");
  fs.writeFileSync(CAT, ts);
  process.exit(0);
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const line = (c) =>
  `  { id: "${c.id}", name: "${esc(c.name)}", category: "UT/ST"` +
  (c.subtype ? `, subtype: "${c.subtype}"` : "") + " },";
const block = `\n  ${MARKER}\n` + fresh.map(line).join("\n") + "\n";

// Insert before the CATALOG array's closing "];" (the one right before
// `export const CATEGORIES`).
const anchor = ts.indexOf("export const CATEGORIES");
if (anchor === -1) throw new Error("could not locate CATEGORIES anchor");
const close = ts.lastIndexOf("];", anchor);
if (close === -1) throw new Error("could not locate CATALOG closing bracket");

const out = ts.slice(0, close) + block + ts.slice(close);
fs.writeFileSync(CAT, out);
console.log(`added ${fresh.length} items to CATALOG (skipped ${candidates.length - fresh.length} already present).`);
