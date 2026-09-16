// What an enchantment does, reduced to a handful of "+Attack" / "-MP Cost" /
// "+Loot Boost" keys so the pool search can offer "adds Loot Boost" and match
// every enchant that grants it, whatever its name or tier — and so a wishlist
// rule can ask for the same thing server-side. Derived from the enchant-mods
// data the tooltip uses (flat stats, multipliers and the game's own effect
// text). No React here: lib/wishlist.ts runs this on the server.
import enchantMods from "./enchant-mods.json";

type EnchantMods = {
  e?: { s: string; v: number }[];
  dmg?: [number, number];
  rof?: number;
  rng?: number;
  mp?: number;
  xp?: number;
  t?: string;
};
const ENCHANT_MODS = enchantMods as unknown as Record<string, EnchantMods>;

const STAT_WORD: Record<string, string> = {
  ATT: "Attack",
  DEF: "Defense",
  SPD: "Speed",
  DEX: "Dexterity",
  VIT: "Vitality",
  WIS: "Wisdom",
  HP: "HP",
  MP: "MP",
  SUMMONPOWER: "Summon Power",
};
const ALL_STATS = ["Attack", "Defense", "Speed", "Dexterity", "Vitality", "Wisdom", "HP", "MP"];

// Long-form names in the effect text → the stat word used in keys.
function statFromText(name: string): string[] {
  const n = name.trim().toLowerCase();
  if (n === "life" || n === "maximum life") return ["HP"];
  if (n === "mana" || n === "maximum mana") return ["MP"];
  if (n === "life and mana regeneration") return ["Life Regen", "Mana Regen"];
  if (n === "life regeneration") return ["Life Regen"];
  if (n === "mana regeneration") return ["Mana Regen"];
  if (n === "loot drop rate") return ["Loot Boost"];
  if (n === "dust drop rate") return ["Dust Boost"];
  if (n.includes("stat mod")) return [];
  const w = ALL_STATS.find((s) => s.toLowerCase() === n);
  if (w) return [w];
  if (n === "summon power") return ["Summon Power"];
  return [];
}

const effectCache = new Map<number, string[]>();

// Effect keys ("+Attack", "-MP Cost", "+Loot Boost", …) for one enchant id.
export function effectsOfEnchant(id: number): string[] {
  const hit = effectCache.get(id);
  if (hit) return hit;
  const out = new Set<string>();
  const m = ENCHANT_MODS[String(id)];
  if (m) {
    for (const e of m.e ?? []) {
      if (!e.v) continue;
      out.add((e.v > 0 ? "+" : "-") + (STAT_WORD[e.s] ?? e.s));
    }
    if (m.dmg) {
      if (m.dmg[1] > 1) out.add("+Damage");
      else if (m.dmg[1] < 1) out.add("-Damage");
    }
    if (m.rof) out.add(m.rof > 1 ? "+Rate of Fire" : "-Rate of Fire");
    if (m.rng) out.add(m.rng > 1 ? "+Range" : "-Range");
    if (m.mp) out.add(m.mp < 1 ? "-MP Cost" : "+MP Cost");
    if (m.xp) out.add(m.xp > 0 ? "+XP Bonus" : "-XP Bonus");
    if (m.t) {
      const t = m.t;
      for (const mm of t.matchAll(/Increases ([A-Za-z ]+?) by/g)) {
        for (const s of statFromText(mm[1])) out.add("+" + s);
      }
      for (const mm of t.matchAll(/\+\d+ (ATT|DEF|SPD|DEX|VIT|WIS|HP|MP)\b/g)) out.add("+" + STAT_WORD[mm[1]]);
      for (const mm of t.matchAll(/Gain (?:\d+ )?(ATT|DEF|SPD|DEX|VIT|WIS|HP|MP|Attack|Defense|Speed|Dexterity|Vitality|Wisdom)\b/g)) {
        out.add("+" + (STAT_WORD[mm[1]] ?? mm[1]));
      }
      if (/Wisdom and Dexterity/.test(t)) out.add("+Dexterity");
      if (/HP and MP/.test(t)) out.add("+MP");
      if (/every other stat/i.test(t)) for (const s of ALL_STATS) out.add("+" + s);
      if (/\bLoot\b/.test(t)) out.add("+Loot Boost");
      if (/\bDust\b/.test(t)) out.add("+Dust Boost");
      if (/XP Bonus/.test(t)) out.add("+XP Bonus");
      if (/less damage|Damage Resistance/.test(t)) out.add("+Damage Resistance");
      if (/restores \d+ HP/.test(t)) out.add("+Heal on Hit");
      if (/restores \d+ MP/.test(t)) out.add("+Energize on Ability");
    }
  }
  const list = [...out].sort();
  effectCache.set(id, list);
  return list;
}

// "+Loot Boost" → "adds Loot Boost", "-MP Cost" → "lowers MP Cost".
export function effectLabel(key: string): string {
  return (key.startsWith("-") ? "lowers " : "adds ") + key.slice(1);
}
