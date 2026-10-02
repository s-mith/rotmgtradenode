// Builds src/lib/item-tooltips.json: the in-game style tooltip for every
// catalog item, generated from the extracted client's equip.xml (the same data
// realm.wiki renders), keyed by normalized item name like item-index.json.
//
//   node scripts/build-item-tooltips.mjs [--base URL]
//
// Per item: tier badge, kind, usable classes, description, attacks (damage,
// shots, range, rate of fire), projectile traits, on-equip stats, MP cost and
// cooldown, effect lines (ability activations rendered from templates plus the
// game's own ExtraTooltipData text), XP bonus, feed power and set name.
import fs from "node:fs";
import path from "node:path";
import { baseUrl, classSlots, classesFor, itemName, labelsOf, normName, openBuild, parseNum, readObjects, slotGroup, slotName } from "./lib/equip.mjs";

const ROOT = process.cwd();
const BASE = baseUrl();
const OUT = path.join(ROOT, "src", "lib", "item-tooltips.json");
const ENCH_OUT = path.join(ROOT, "src", "lib", "enchant-mods.json");
const ITEM_MAP = path.join(ROOT, "src", "relay", "trade", "itemMap.json");
const CATALOG_TS = path.join(ROOT, "src", "lib", "catalog.ts");

const STAT = { ATT: "ATT", DEF: "DEF", SPD: "SPD", DEX: "DEX", VIT: "VIT", WIS: "WIS", MAXHP: "HP", MAXMP: "MP", HP: "HP", MP: "MP" };
const stat = (s) => STAT[String(s).toUpperCase()] ?? String(s);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const secs = (v) => `${fmt(num(v))}s`;
const attrs = (a) => (typeof a === "string" ? {} : Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("@_")).map(([k, v]) => [k.slice(2), v])));
const kindOf = (a) => (typeof a === "string" ? a : a["#text"]);
// Internal object names carry prefixes like "AoO " (ability-of-origin).
const cleanId = (s) => String(s ?? "").replace(/^AoO\s*/i, "").trim();

// --- attacks ------------------------------------------------------------------

function projectilesOf(o) {
  const list = (o.Projectile ?? []).map((p, i) => ({ id: p["@_id"] !== undefined ? parseNum(p["@_id"]) : i, p }));
  return new Map(list.map(({ id, p }) => [id, p]));
}

function projTraits(p) {
  const t = [];
  if ("MultiHit" in p) t.push("Shots hit multiple targets");
  if ("PassesCover" in p) t.push("Shots pass through obstacles");
  if ("ArmorPiercing" in p) t.push("Ignores defense of target");
  if ("Boomerang" in p) t.push("Shots boomerang");
  if ("Wavy" in p) t.push("Wavy shots");
  if ("Parametric" in p) t.push("Parametric shots");
  for (const c of p.ConditionEffect ?? []) {
    const a = attrs(c); const name = kindOf(c);
    t.push(`Shots inflict ${name}${a.duration ? ` for ${secs(a.duration)}` : ""}`);
  }
  return t;
}

function attacksOf(o) {
  const projs = projectilesOf(o);
  if (!projs.size) return { attacks: [], traits: [] };
  const subs = o.Subattack?.length ? o.Subattack : [{ "@_projectileId": "0", NumProjectiles: o.NumProjectiles, RateOfFire: o.RateOfFire, ArcGap: o.ArcGap }];
  const attacks = []; const traits = new Set();
  for (const s of subs) {
    const p = projs.get(s["@_projectileId"] !== undefined ? parseNum(s["@_projectileId"]) : 0) ?? [...projs.values()][0];
    if (!p) continue;
    const min = num(p.MinDamage ?? p.Damage), max = num(p.MaxDamage ?? p.Damage);
    const range = Math.round((num(p.Speed) * num(p.LifetimeMS)) / 1000) / 10;
    const a = { dmg: [min, max], shots: num(s.NumProjectiles ?? 1, 1), rof: Math.round(num(s.RateOfFire ?? 1, 1) * 100), range };
    if (num(s.ArcGap) && a.shots > 1) a.arc = num(s.ArcGap);
    if (s.BurstCount) a.burst = num(s.BurstCount);
    for (const t of projTraits(p)) traits.add(t);
    if (!attacks.some((b) => JSON.stringify(b) === JSON.stringify(a))) attacks.push(a);
  }
  return { attacks, traits: [...traits] };
}

// --- effect lines ---------------------------------------------------------------

const scaleNote = (a) => (a.scalingStat ? ` (scales with ${stat(a.scalingStat)})` : "");
const within = (a, key = "range") => (a[key] ? ` within ${fmt(num(a[key]))} sqrs` : "");

const TEMPLATES = {
  Shoot: () => null,
  Pet: () => null,
  Create: () => null,
  ChangeObject: () => null,
  ObjectToss: () => null,
  IncrementStat: (a) => `Permanently ${num(a.amount) >= 0 ? "+" : ""}${fmt(num(a.amount))} ${stat(a.stat)}`,
  ConditionEffectSelf: (a) => `Effect on self: ${a.effect} for ${secs(a.duration)}${scaleNote(a)}`,
  ConditionEffectAura: (a) => `Party effect${within(a)}: ${a.effect} for ${secs(a.duration)}${scaleNote(a)}`,
  EffectBlast: (a) => (a.condEffect ? `${a.condEffect} for ${secs(a.condDuration)}${within(a, "radius")}` : null),
  StatBoostAura: (a) => `Party boost${within(a)}: +${fmt(num(a.amount))} ${stat(a.stat)} for ${secs(a.duration)}`,
  StatBoostSelf: (a) => `Self boost: ${num(a.amount) >= 0 ? "+" : ""}${fmt(num(a.amount))} ${stat(a.stat)} for ${secs(a.duration)}`,
  BulletCreate: (a, ctx) => { ctx.used = true; return `${a.numShots && num(a.numShots) > 1 ? `${a.numShots} shots` : "Shot"}${ctx.dmg ? `, ${ctx.dmg} damage` : ""}${a.maxDistance ? ` up to ${fmt(num(a.maxDistance))} sqrs` : ""}${scaleNote(a)}`; },
  BulletNova: (a, ctx) => { ctx.used = true; return `Nova: ${a.numShots ?? "?"} shots${ctx.dmg ? `, ${ctx.dmg} damage each` : ""}${scaleNote(a)}`; },
  VampireBlast: (a) => `Vampire blast: ${fmt(num(a.totalDamage))} damage${within(a, "radius")}${a.heal ? `, heals ${fmt(num(a.heal))} HP` : ""}${a.condEffect ? `, ${a.condEffect} for ${secs(a.condDuration)}` : ""}${scaleNote(a)}`,
  PoisonGrenade: (a) => `Poison: ${fmt(num(a.totalDamage))} damage over ${secs(a.duration)}${a.impactDamage ? `, ${fmt(num(a.impactDamage))} on impact` : ""}${within(a, "radius")}${scaleNote(a)}`,
  SpawnCreep: (a) => `Summons ${cleanId(a.objectId) || "a minion"} for ${secs(a.lifeTime)}${scaleNote(a)}`,
  Lightning: (a) => `Lightning: ${fmt(num(a.totalDamage))} damage to up to ${a.maxTargets ?? "?"} targets${within(a)}${scaleNote(a)}`,
  Decoy: (a) => `Decoy for ${secs(a.duration)}${a.distance ? `, travels ${fmt(num(a.distance))} sqrs` : ""}`,
  ChannelDash: (a) => `Dash ${fmt(num(a.amount))} sqrs after channelling ${secs(num(a.channelTime) / 1000)}`,
  Dash: (a) => `Dash${a.amount ? ` ${fmt(num(a.amount))} sqrs` : ""}`,
  BoostRange: (a) => `Party boost${within(a, "radius")}: ${a.speedBoost ? `×${fmt(num(a.speedBoost))} shot speed` : ""}${a.speedBoost && a.lifeBoost && num(a.lifeBoost) !== 1 ? ", " : ""}${a.lifeBoost && num(a.lifeBoost) !== 1 ? `×${fmt(num(a.lifeBoost))} shot range` : ""} for ${secs(a.duration)}`,
  Sneak: (a) => `Effect on self: ${a.conditionEffect ?? "Invisible"} for ${secs(a.duration)}`,
  DetonateHex: (a) => `Detonates hexes: ${fmt(num(a.baseDamage))} damage +${fmt(num(a.stackDamage))} per stack${within(a, "radius")}${scaleNote(a)}`,
  Heal: (a) => `Heals ${fmt(num(a.amount))} HP${scaleNote(a)}`,
  HealNova: (a) => `Party heal${within(a)}: ${fmt(num(a.amount))} HP${scaleNote(a)}`,
  Trap: (a) => `Trap: ${fmt(num(a.totalDamage))} damage${within(a, "radius")}${a.condEffect ? `, ${a.condEffect} for ${secs(a.condDuration)}` : ""}${a.armTime && num(a.armTime) > 0 ? `, arms in ${secs(a.armTime)}` : ""}${a.duration ? `, lasts ${secs(a.duration)}` : ""}${scaleNote(a)}`,
  RaiseDead: (a) => `Raises ${a.numDead ?? 1} ${cleanId(a.undeadId) || "undead"}${scaleNote(a)}`,
  Teleport: (a) => `Teleport up to ${fmt(num(a.maxDistance))} sqrs`,
  ShurikenAbility: (a) => (a.stat ? `+${fmt(num(a.amount))} ${stat(a.stat)} while held${a.effect ? `, ${a.effect} on release` : ""}` : a.effect ? `${a.effect} on release` : null),
  GenericActivate: (a) => `${a.effect ?? "Effect"} on ${a.target ?? "self"} for ${secs(a.duration)}${within(a)}`,
  DamageNova: (a) => `Nova: ${fmt(num(a.minDamage))}${num(a.maxDamage) !== num(a.minDamage) ? `–${fmt(num(a.maxDamage))}` : ""} damage${within(a, "radius")}${a.activationCount && num(a.activationCount) > 1 ? ` ×${a.activationCount}` : ""}${scaleNote(a)}`,
  DamageMultAura: (a) => `${a.type === "self" ? "Own" : "Party"} damage ×${fmt(num(a.mult))} for ${secs(a.duration)}`,
  ClearConditionEffectSelf: (a) => `Removes ${a.effect}`,
  RemoveNegativeConditionsSelf: () => "Removes negative conditions",
  SelfTransform: (a) => `Transforms you for ${secs(a.duration)}`,
  StasisBlast: (a) => `Stasis${within(a, "radius")} for ${secs(a.duration)}`,
  Magic: (a) => `Restores ${fmt(num(a.amount))} MP`,
  FillMeter: () => null,
  LethalStrike: (a) => `Lethal Strike for ${secs(a.duration)}`,
};

function effectLine(a, ctx) {
  const at = attrs(a); const kind = kindOf(a);
  if (at.ignoreOnTooltip === "true") return null;
  const tpl = TEMPLATES[kind];
  if (tpl) return tpl(at, ctx);
  // Unknown kind: a readable fallback rather than nothing.
  const bits = Object.entries(at).filter(([k]) => !/color|scalingStat|statMod|proc|type$/i.test(k)).slice(0, 3).map(([k, v]) => `${k} ${v}`);
  return `${kind}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

const HOOKS = [["OnPlayerShootActivate", "On shoot"], ["OnPlayerAbilityActivate", "On ability use"], ["OnPlayerHitActivate", "When hit"], ["OnEnemyHitActivate", "On enemy hit"], ["OnPlayerHealActivate", "On heal"], ["OnConditionEndActivate", "Afterwards"]];

// Newer abilities nest their activations in one or more <Ability name="…">
// blocks (with meter-driven OnSwitchAbilityActivate procs); older items keep
// them at the top level. Read both.
function effectSources(o) {
  const blocks = [].concat(o.Ability ?? []).filter((b) => b && typeof b === "object");
  return [{ src: o, name: null }, ...blocks.map((b) => ({ src: b, name: b["@_name"] ? String(b["@_name"]) : null }))];
}

function effectLines(o, ctx) {
  const lines = []; const push = (l) => { if (l && !lines.includes(l)) lines.push(l); };
  const sources = effectSources(o);
  const multi = sources.length > 2;
  for (const { src, name } of sources) {
    const prefix = multi && name ? `${name}: ` : "";
    for (const a of src.Activate ?? []) push(prefix + (effectLine(a, ctx) ?? ""));
    for (const a of [].concat(src.OnSwitchAbilityActivate ?? [])) { const l = effectLine(a, ctx); if (l) push(`${prefix}With a full meter: ${l}`); }
    // The game's own effect text covers most procs; only spell the hooks out
    // when it is absent.
    if (!o.ExtraTooltipData) for (const [hook, label] of HOOKS) for (const a of [].concat(src[hook] ?? [])) { const l = effectLine(a, ctx); if (l) push(`${prefix}${label}: ${l}`); }
  }
  for (const m of [].concat(o.Meter ?? [])) { const a = attrs(m); if (a.chargeString) push(String(a.chargeString)); }
  return lines.filter(Boolean);
}

function extraTooltip(o) {
  const out = [];
  for (const block of Array.isArray(o.ExtraTooltipData) ? o.ExtraTooltipData : [o.ExtraTooltipData].filter(Boolean)) {
    for (const e of block.EffectInfo ?? []) {
      const a = attrs(e);
      if (!a.description && !a.name) continue;
      out.push({ n: a.name ?? "", d: a.description ?? "" });
    }
  }
  return out;
}

function onEquip(o) {
  const out = [];
  for (const a of o.ActivateOnEquip ?? []) {
    const at = attrs(a); const kind = kindOf(a);
    if (kind === "IncrementStat") out.push({ s: stat(at.stat), v: num(at.amount) });
    else if (kind === "IncrementStatRelative") out.push({ s: stat(at.stat), v: num(at.amount), r: stat(at.statRelativeTo ?? at.stat) });
    else if (kind === "AbilityUseDiscount") out.push({ s: "ability MP cost", v: -Math.round((1 - num(at.multiplier, 1)) * 100), pct: true });
  }
  return out;
}

function tierOf(o) {
  const labels = new Set(labelsOf(o));
  if (o.Tier !== undefined) return `T${o.Tier}`;
  if (labels.has("ST")) return "ST";
  if (labels.has("UT")) return "UT";
  return null;
}

function tooltipFor(o, classes) {
  const slot = Number(o.SlotType);
  const { attacks, traits } = attacksOf(o);
  const first = attacks[0];
  const ctx = { dmg: first ? `${first.dmg[0]}–${first.dmg[1]}` : null };
  const consumable = "Consumable" in o;
  const weapon = slotGroup(slot) === "weapon";
  const t = {
    t: consumable ? null : tierOf(o),
    k: slotName(o),
    c: consumable ? ["ALL"] : classesFor(slot, classes),
    d: String(o.Description ?? "").trim(),
  };
  // Weapons get the full attack table. An ability's projectile is described
  // by its effect line instead (or by a single "shot" line below).
  if (weapon && attacks.length) t.a = attacks;
  if (traits.length) t.p = traits;
  const eq = onEquip(o); if (eq.length) t.e = eq;
  if (o.MpCost && num(o.MpCost) > 0) t.mp = num(o.MpCost);
  if (o.MpEndCost) t.mpe = num(o.MpEndCost);
  if (o.MpCostPerSecond) t.mps = num(o.MpCostPerSecond);
  if (o.Cooldown) t.cd = num(o.Cooldown);
  const lines = effectLines(o, ctx);
  if (!weapon && first && !ctx.used) lines.push(`${first.shots > 1 ? `${first.shots} shots` : "Shot"}: ${ctx.dmg} damage, range ${fmt(first.range)}`);
  if (lines.length) t.l = lines;
  const extra = extraTooltip(o); if (extra.length) t.x = extra;
  if (o.XPBonus) t.xp = num(o.XPBonus);
  if (o.feedPower) t.fp = num(o.feedPower);
  if (o["@_setName"]) t.set = String(o["@_setName"]);
  if ("Consumable" in o) t.cons = true;
  return t;
}

// --- enchantment stat mods ------------------------------------------------------
// Only what changes the item's own numbers or is a plain stat: flat stat
// bonuses, damage / fire-rate / range / MP-cost multipliers, XP bonus. Other
// stat-style mutators that depend on the player (relative bonuses, regen,
// loot) keep the game's one-line description; procs are left out entirely.
const FOLDED = new Set(["IncrementStat", "XPBonus"]);
const STAT_TEXT_KINDS = new Set(["BonusStatRelative", "StatModMult", "LootBonus", "DustBonus", "FlatRegen", "PercentageRegen", "DamageMultSelf"]);

function enchantMods(enchXml) {
  const root = readObjects.parser.parse(enchXml.toString("utf8"));
  const list = [].concat(root.Enchantments?.Enchantment ?? []);
  const out = {};
  for (const e of list) {
    const type = parseNum(e["@_type"]);
    const m = e.Mutators ?? {};
    const mods = {};
    const eq = [];
    let text = false;
    for (const a of [].concat(m.ActivateOnEquip ?? [])) {
      const at = attrs(a); const kind = kindOf(a);
      if (kind === "IncrementStat") eq.push({ s: stat(at.stat), v: num(at.amount) });
      else if (kind === "XPBonus") mods.xp = (mods.xp ?? 0) + num(at.amount);
      else if (STAT_TEXT_KINDS.has(kind)) text = true;
    }
    if (eq.length) mods.e = eq;
    const mult = (tag) => Math.round([].concat(m[tag] ?? []).reduce((acc, v) => acc * num(typeof v === "string" ? v : v["#text"], 1), 1) * 10000) / 10000;
    const dmgMin = mult("MultiplyMinDamage"), dmgMax = mult("MultiplyMaxDamage");
    if (dmgMin !== 1 || dmgMax !== 1) mods.dmg = [dmgMin, dmgMax];
    const rof = mult("MultiplyRateOfFire"); if (rof !== 1) mods.rof = rof;
    const rng = mult("MultiplySpeed") * mult("MultiplyLifetimeMS"); if (rng !== 1) mods.rng = rng;
    const mp = mult("MultiplyMPCost"); if (mp !== 1) mods.mp = mp;
    if (text && e.Description) mods.t = String(e.Description).trim();
    if (Object.keys(mods).length) out[type] = mods;
  }
  return out;
}

async function main() {
  const { ident, get } = await openBuild(BASE, (l) => console.log(l));
  console.log(`item tooltips: ${BASE} (game ${ident.version}, build ${ident.hash})`);
  const [equipXml, playersXml, enchXml] = await Promise.all([get("extracted_assets/TextAsset/equip.xml"), get("extracted_assets/TextAsset/players.xml"), get("extracted_assets/TextAsset/enchantments.xml")]);
  // Eggs and skins live in their own files; a build without one just has no tooltips for those.
  const extra = await Promise.all(["equipEggs.xml", "equipSkins.xml"].map((f) => get(`extracted_assets/TextAsset/${f}`).catch(() => null)));
  const byType = new Map([...readObjects(equipXml), ...extra.flatMap((x) => (x ? readObjects(x) : []))].map((o) => [parseNum(o["@_type"]), o]));
  const ench = enchantMods(enchXml);
  fs.writeFileSync(ENCH_OUT, JSON.stringify(ench));
  console.log(`wrote ${Object.keys(ench).length} enchantment stat mods (${(fs.statSync(ENCH_OUT).size / 1024).toFixed(1)} KB) -> ${path.relative(ROOT, ENCH_OUT)}`);
  const classes = classSlots(playersXml);
  const itemMap = JSON.parse(fs.readFileSync(ITEM_MAP, "utf8"));
  const catalog = [...fs.readFileSync(CATALOG_TS, "utf8").matchAll(/\{ id: "([^"]+)", name: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));

  const out = {}; const missing = [];
  for (const c of catalog) {
    const o = byType.get(itemMap.communism[c.id]);
    if (!o) { missing.push(c.name); continue; }
    out[normName(c.name)] = tooltipFor(o, classes);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`wrote ${Object.keys(out).length} tooltips (${kb} KB) -> ${path.relative(ROOT, OUT)}`);
  if (missing.length) console.log(`  ${missing.length} catalog item(s) not in equip.xml (no tooltip): ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}`);
  // Unknown activation kinds get the generic fallback; list them so templates can grow.
  const unknown = new Set();
  for (const o of byType.values()) for (const a of o.Activate ?? []) { const k = kindOf(a); if (!(k in TEMPLATES) && out[normName(itemName(o))]) unknown.add(k); }
  if (unknown.size) console.log(`  activation kinds without a template: ${[...unknown].join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
