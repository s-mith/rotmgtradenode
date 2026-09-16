// Assign each scraped candidate its CANONICAL catalog id so a given in-game
// ObjectType has ONE id across both economies:
//   - objType already in capitalism's ItemMapExtra -> reuse that exact id
//   - otherwise -> mint a name-slug (the scraper convention), collision-safe
// Rewrites data/untiered-tradable-candidates.json in place with corrected ids.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const RELAY = path.resolve(ROOT, "..", "rotmgcommunismpyrelay");
const CAND = path.join(ROOT, "data", "untiered-tradable-candidates.json");

const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// capitalism reverse map: objType -> id (first occurrence wins, mirroring
// FULL_OBJTYPE_TO_ID's setdefault over EXTRA).
function extraObjTypeToId() {
  const py = fs.readFileSync(path.join(RELAY, "Communism/ItemMapExtra.py"), "utf8");
  const m = new Map();
  for (const mm of py.matchAll(/"([a-z0-9_]+)":\s*(\d+)/g)) {
    const id = mm[1], t = Number(mm[2]);
    if (!m.has(t)) m.set(t, id);
  }
  return m;
}

// ids already taken: communism catalog + the curated ID_TO_OBJTYPE + all EXTRA
// ids (everything unions), so a minted slug never collides anywhere.
function takenIds() {
  const taken = new Set();
  const cat = fs.readFileSync(path.join(ROOT, "src/lib/catalog.ts"), "utf8");
  for (const m of cat.matchAll(/id:\s*"([^"]+)"/g)) taken.add(m[1]);
  const im = fs.readFileSync(path.join(RELAY, "Communism/ItemMap.py"), "utf8");
  for (const m of im.matchAll(/"([a-z0-9_]+)":\s*\d+/g)) taken.add(m[1]);
  const ex = fs.readFileSync(path.join(RELAY, "Communism/ItemMapExtra.py"), "utf8");
  for (const m of ex.matchAll(/"([a-z0-9_]+)":\s*\d+/g)) taken.add(m[1]);
  return taken;
}

const objToId = extraObjTypeToId();
const taken = takenIds();
const candidates = JSON.parse(fs.readFileSync(CAND, "utf8"));

let reused = 0, minted = 0;
for (const c of candidates) {
  const t = Number(c._realmId);
  const shared = objToId.get(t);
  if (shared) {
    c.id = shared;                 // canonical capitalism id — one id per objType
    reused++;
  } else {
    let base = slug(c.name) || `ut_${t}`, id = base, i = 2;
    while (taken.has(id)) id = `${base}_${i++}`;
    c.id = id;
    taken.add(id);
    minted++;
  }
}

fs.writeFileSync(CAND, JSON.stringify(candidates, null, 2));
console.log(`resolved ${candidates.length} ids: reused ${reused} from capitalism, minted ${minted} new name-slugs`);
// sanity: unique ids?
const ids = candidates.map((c) => c.id);
const dupe = ids.filter((v, i) => ids.indexOf(v) !== i);
console.log("duplicate ids among candidates:", [...new Set(dupe)].length ? [...new Set(dupe)] : "NONE");
