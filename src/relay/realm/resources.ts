// Realm's object/ground/equip tables, extracted by scripts/build-realm-resources.mjs.
import raw from "./resources.json";

export interface ObjectProps {
  cls: string;
  occupySquare: boolean;
  fullOccupy: boolean;
  isStatic: boolean;
  enemy: boolean;
  invincible: boolean;
  maxHp: number;
  /** bulletType -> { speed tiles/ms, life ms } */
  projectiles: Record<number, { speed: number; life: number }>;
}
export interface Weapon {
  name: string;
  rateOfFire: number;
  numProjectiles: number;
  arcGap: number;
  /** tiles per 10s (XML units) */
  speed: number;
  lifetime: number;
  amplitude: number;
  frequency: number;
  minDmg: number;
  maxDmg: number;
}
export interface RealmResources {
  version: string;
  object(type: number): ObjectProps | undefined;
  noWalk(groundType: number): boolean;
  equipSlot(itemType: number): number | undefined;
  weapon(itemType: number): Weapon | undefined;
}

type RawObj = { c?: string; o?: 1; f?: 1; s?: 1; e?: 1; i?: 1; h?: number; p?: Record<string, { s: number; l: number }> };
const data = raw as unknown as {
  version: string;
  objects: Record<string, RawObj>;
  groundNoWalk: number[];
  equipSlots: Record<string, number>;
  weapons: Record<string, { name: string; rof: number; n: number; arc: number; speed: number; life: number; amp: number; freq: number; min: number; max: number }>;
};

const objectCache = new Map<number, ObjectProps | undefined>();
const noWalkSet = new Set(data.groundNoWalk);

export const RESOURCES: RealmResources = {
  version: data.version,
  object(type) {
    if (objectCache.has(type)) return objectCache.get(type);
    const r = data.objects[String(type)];
    let out: ObjectProps | undefined;
    if (r) {
      const projectiles: Record<number, { speed: number; life: number }> = {};
      for (const [k, v] of Object.entries(r.p ?? {})) projectiles[Number(k)] = { speed: v.s, life: v.l };
      out = { cls: r.c ?? "", occupySquare: !!r.o, fullOccupy: !!r.f, isStatic: !!r.s, enemy: !!r.e, invincible: !!r.i, maxHp: r.h ?? 0, projectiles };
    }
    objectCache.set(type, out);
    return out;
  },
  noWalk: (t) => noWalkSet.has(t),
  equipSlot: (t) => data.equipSlots[String(t)],
  weapon(t) {
    const w = data.weapons[String(t)];
    if (!w) return undefined;
    return { name: w.name, rateOfFire: w.rof, numProjectiles: w.n, arcGap: w.arc, speed: w.speed, lifetime: w.life, amplitude: w.amp, frequency: w.freq, minDmg: w.min, maxDmg: w.max };
  },
};
