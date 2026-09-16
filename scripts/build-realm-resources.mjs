// Extract what the bots need from Realm's objects/ground/equip XML into one
// compact JSON: walkability, enemy/HP flags, projectile stats for dodging,
// equip slot types, and weapon stats for shooting.
//
//   node scripts/build-realm-resources.mjs <dir with objects.xml ground.xml equip.xml>
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const dir = process.argv[2] ?? "../accountgen/tutorial-state/pyrelay/Resources";
const read = (f) => {
  let s = fs.readFileSync(path.join(dir, f), "latin1");
  s = s.replace(/[^\x09\x0A\x0D\x20-￿]/g, "").replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, "&amp;");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", isArray: (n) => ["Object", "Ground", "Projectile"].includes(n), parseTagValue: false }).parse(s);
};
const has = (o, k) => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
const num = (v, d) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const hex = (v) => parseInt(String(v), 16);

const objects = {};
const objRoot = read("objects.xml");
const objList = objRoot.Objects?.Object ?? objRoot.Object ?? [];
for (const o of objList) {
  if (!o["@type"]) continue;
  const type = hex(o["@type"]);
  if (!Number.isFinite(type)) continue;
  const entry = {};
  const cls = typeof o.Class === "string" ? o.Class : "";
  if (cls) entry.c = cls;
  if (has(o, "OccupySquare") || has(o, "FullOccupy")) entry.o = 1;
  if (has(o, "FullOccupy")) entry.f = 1;
  if (has(o, "Static")) entry.s = 1;
  if (has(o, "Enemy")) entry.e = 1;
  if (has(o, "Invincible")) entry.i = 1;
  const hp = num(o.MaxHitPoints, 0);
  if (hp > 0) entry.h = hp;
  const projs = {};
  (o.Projectile ?? []).forEach((p, idx) => {
    const pid = p["@id"];
    const key = pid !== undefined && /^-?\d+$/.test(String(pid)) ? Number(pid) : idx;
    projs[key] = { s: num(p.Speed, 100) / 10000, l: num(p.LifetimeMS, 1000) };
  });
  if (Object.keys(projs).length) entry.p = projs;
  if (Object.keys(entry).length) objects[type] = entry;
}
const groundNoWalk = [];
for (const g of read("ground.xml").GroundTypes?.Ground ?? []) {
  if (!g["@type"]) continue;
  if (has(g, "NoWalk")) groundNoWalk.push(hex(g["@type"]));
}
const equipSlots = {};
const weapons = {};
const WEAPON_SLOTS = new Set([17, 8, 1, 24, 3, 2]);
for (const o of read("equip.xml").Objects?.Object ?? []) {
  if (!o["@type"]) continue;
  const type = hex(o["@type"]);
  const slot = num(o.SlotType, NaN);
  if (!Number.isFinite(slot)) continue;
  equipSlots[type] = slot;
  if (WEAPON_SLOTS.has(slot) && o.Projectile?.length) {
    const p = o.Projectile[0];
    weapons[type] = {
      name: o["@id"] ?? "", rof: num(o.RateOfFire, 1), n: num(o.NumProjectiles, 1), arc: num(o.ArcGap, 11.25),
      speed: num(p.Speed, 100), life: num(p.LifetimeMS, 1000), amp: num(p.Amplitude, 0), freq: num(p.Frequency, 1),
      min: num(p.Damage ?? p.MinDamage, 0), max: num(p.Damage ?? p.MaxDamage, 0),
    };
  }
}
const out = { version: fs.existsSync(path.join(dir, "version.txt")) ? fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim() : "", objects, groundNoWalk, equipSlots, weapons };
const dest = "src/relay/realm/resources.json";
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`objects=${Object.keys(objects).length} noWalk=${groundNoWalk.length} equip=${Object.keys(equipSlots).length} weapons=${Object.keys(weapons).length} -> ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
