// Shooting, ability use, projectile lifecycle reporting, and dodging.
//
// The server spawns a projectile per PLAYERSHOOT and expects the client to
// report how each ends (ENEMYHIT on something with HP). Unreported or invalid
// reports get the session kicked, so the simulation here mirrors what the
// real client would report and holds fire on targets the server is ignoring.
import type { WorldPos } from "../protocol/data";
import type { Packet } from "../protocol/packets";
import { Condition, hasCondition } from "../realm/constants";
import type { RealmResources } from "../realm/resources";
import type { WorldState } from "./world";

const MIN_FREQ = 0.0015;
const MAX_FREQ = 0.008;
/** ENEMYHITs on a killable target with zero DAMAGE confirms before holding fire. */
export const NO_DAMAGE_HIT_LIMIT = 15;
export const HOLD_FIRE_MS = 15_000;
const BLACKLIST_HITS = 25;
const UNHITTABLE = (1 << (22 - 1)) | (1 << (24 - 1)) | (1 << (25 - 1)); // stasis, invincible, invulnerable

interface Shot {
  t0: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  life: number;
  amplitude: number;
  frequency: number;
  parity: number;
  bulletId: number;
  simAge: number;
}
interface EnemyBullet {
  t0: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  life: number;
  dmg: number;
  /** Age (ms) up to which the path was checked against cover. */
  checkedAge?: number;
}

export interface CombatHost {
  readonly objectId: number;
  readonly pos: WorldPos | null;
  readonly world: WorldState;
  playerData: { inv: number[]; dex: number; dexBoost: number; spd: number; spdBoost: number; condition: number; mp: number };
  getTime(): number;
  speedPerMs(): number;
  send<K extends "PLAYERSHOOT" | "ENEMYHIT" | "USEITEM" | "SHOOTACKCOUNTER">(type: K, body: import("../protocol/packets").Packets[K]): boolean;
  logLine(line: string): void;
}

export class Combat {
  private activeShots: Shot[] = [];
  private enemyBullets: EnemyBullet[] = [];
  private hitCounts = new Map<number, number>();
  private noHitTargets = new Set<number>();
  private confirmedDamage = new Map<number, number>();
  /** objectId -> epoch ms until which we don't shoot it. */
  readonly holdFire = new Map<number, number>();
  private lastPhaseLog = new Map<number, number>();
  private bulletCounter = 0;
  private lastAttackTime = 0;
  private lastAbilityTime = 0;
  private lastCastMp: number | null = null;
  private failedCasts = 0;
  abilityDisabled = false;

  constructor(private readonly host: CombatHost, private readonly res: RealmResources) {}

  resetForMap(): void {
    this.activeShots = [];
    this.enemyBullets = [];
    this.hitCounts.clear();
    this.noHitTargets.clear();
    this.confirmedDamage.clear();
    this.holdFire.clear();
    this.lastPhaseLog.clear();
    this.bulletCounter = 0;
  }

  private attackFreq(): number {
    const pd = this.host.playerData;
    if (hasCondition(pd.condition, Condition.DAZED)) return MIN_FREQ;
    let f = MIN_FREQ + ((pd.dex + pd.dexBoost) / 75) * (MAX_FREQ - MIN_FREQ);
    if (hasCondition(pd.condition, Condition.BERSERK)) f *= 1.5;
    return f;
  }

  /** Fire the equipped weapon toward `angle`. */
  shoot(angle: number): boolean {
    const pd = this.host.playerData;
    const pos = this.host.pos;
    if (!pos) return false;
    if (hasCondition(pd.condition, Condition.STUNNED, Condition.PAUSED, Condition.PETRIFIED)) return false;
    const weaponId = pd.inv[0];
    const weapon = this.res.weapon(weaponId);
    if (!weapon) return false;
    const t = this.host.getTime();
    const period = 1 / this.attackFreq();
    if (t < this.lastAttackTime + period) return false;
    this.lastAttackTime = t;
    if (this.bulletCounter === 0) this.host.logLine(`[shoot] weapon=${weaponId} (${weapon.name}) numProj=${weapon.numProjectiles} dex=${pd.dex}+${pd.dexBoost} minPeriod=${period.toFixed(0)}ms`);
    const arc = (weapon.arcGap * Math.PI) / 180;
    let a = angle - Math.max(0, arc * (weapon.numProjectiles - 1)) / 2;
    const origin = { ...pos };
    for (let i = 0; i < weapon.numProjectiles; i++) {
      const counter = this.bulletCounter++;
      const start = { x: origin.x + Math.cos(a) * 0.3, y: origin.y + Math.sin(a) * 0.3 };
      this.host.send("PLAYERSHOOT", {
        time: t, bulletId: counter % 32768, weaponId, projectileId: -1, startingPos: start, angle: a,
        isBurst: false, patternIdx: 0, attackType: 1, playerPosition: { ...origin },
      });
      this.activeShots.push({
        t0: Date.now(), x: start.x, y: start.y, angle: a, speed: weapon.speed / 10000, life: weapon.lifetime,
        amplitude: weapon.amplitude, frequency: weapon.frequency, parity: counter % 2, bulletId: counter % 32768, simAge: 0,
      });
      if (arc > 0) a += arc;
    }
    if (this.activeShots.length > 200) this.activeShots.splice(0, 100);
    return true;
  }

  /** Slot-1 ability (the wizard's spell) at a world position. */
  useAbility(target: WorldPos): boolean {
    const pd = this.host.playerData;
    const itemType = pd.inv[1];
    if (itemType <= 0 || this.abilityDisabled) return false;
    if (hasCondition(pd.condition, Condition.STUNNED, Condition.PAUSED, Condition.PETRIFIED, 2)) return false;
    const t = this.host.getTime();
    if (t < this.lastAbilityTime + 1000) return false;
    if (pd.mp < 25) return false;
    // An accepted cast consumes MP; if it never drops the server is rejecting
    // USEITEM, and rejected actions get us kicked after ~10.
    if (this.lastCastMp !== null && pd.mp >= this.lastCastMp) {
      if (++this.failedCasts >= 3) {
        this.abilityDisabled = true;
        this.host.logLine("[ability] casts are not consuming MP — disabling the spell for this session");
        return false;
      }
    } else {
      this.failedCasts = 0;
    }
    this.lastCastMp = pd.mp;
    this.lastAbilityTime = t;
    this.host.send("USEITEM", { time: t, slotObject: { objectId: this.host.objectId, slotId: 1, objectType: itemType }, pos: { ...target }, useType: 0, unknownInt: 0 });
    return true;
  }

  private static shotPos(s: Shot, ageMs: number): [number, number] {
    const dx = Math.cos(s.angle);
    const dy = Math.sin(s.angle);
    const dist = s.speed * ageMs;
    let x = s.x + dx * dist;
    let y = s.y + dy * dist;
    if (s.amplitude) {
      const amp = s.parity ? -s.amplitude : s.amplitude;
      const off = amp * Math.sin((2 * Math.PI * s.frequency * ageMs) / s.life);
      x += -dy * off;
      y += dx * off;
    }
    return [x, y];
  }

  /** Advance our projectiles and report the ones that hit something. Call every frame. */
  simulateShots(): void {
    if (!this.activeShots.length) return;
    const now = Date.now();
    const world = this.host.world;
    const wallAt = new Set(world.bulletBlockTiles.values());
    const targets: [number, WorldPos][] = [];
    const absorbers: WorldPos[] = [];
    for (const [oid, e] of world.entities) {
      const phased = (e.condition & UNHITTABLE) !== 0;
      const held = (this.holdFire.get(oid) ?? 0) > now;
      if (e.absorb || (e.hittable && (phased || held))) {
        absorbers.push(e.pos);
        if (phased && !e.absorb && now - (this.lastPhaseLog.get(oid) ?? 0) > 1000) {
          this.lastPhaseLog.set(oid, now);
          this.host.logLine(`[hit] target ${oid} (type ${e.type}) is phase-invulnerable — holding fire reports`);
        }
      } else if (e.hittable && !this.noHitTargets.has(oid)) {
        targets.push([oid, e.pos]);
      }
    }
    const alive: Shot[] = [];
    for (const shot of this.activeShots) {
      const age = now - shot.t0;
      let a = shot.simAge;
      const end = Math.min(age, shot.life);
      const stepMs = shot.speed > 0 ? 0.2 / shot.speed : end;
      let resolved = false;
      while (a < end) {
        a = Math.min(a + stepMs, end);
        const [x, y] = Combat.shotPos(shot, a);
        const tile = `${Math.floor(x)},${Math.floor(y)}`;
        const practice = world.enemyHitTiles.get(tile);
        if (practice !== undefined) {
          this.reportEnemyHit(shot, practice);
          resolved = true;
          break;
        }
        if (wallAt.has(tile)) {
          // Dies on the wall; never report it (an OTHERHIT for our own shot is a kick).
          resolved = true;
          break;
        }
        if (absorbers.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= 0.25)) {
          resolved = true;
          break;
        }
        const hit = targets.find(([, p]) => (p.x - x) ** 2 + (p.y - y) ** 2 <= 0.25);
        if (hit) {
          this.reportEnemyHit(shot, hit[0]);
          resolved = true;
          break;
        }
      }
      shot.simAge = a;
      if (!resolved && age < shot.life) alive.push(shot);
    }
    this.activeShots = alive;
  }

  private reportEnemyHit(shot: Shot, targetId: number): void {
    const ent = this.host.world.entities.get(targetId);
    const props = ent ? this.res.object(ent.type) : undefined;
    const killable = (props?.maxHp ?? 0) > 0;
    const count = (this.hitCounts.get(targetId) ?? 0) + 1;
    this.hitCounts.set(targetId, count);
    if (count > BLACKLIST_HITS && !killable) {
      if (!this.noHitTargets.has(targetId)) {
        this.noHitTargets.add(targetId);
        this.host.logLine(`[hit] target ${targetId} (type ${ent?.type ?? "?"}) soaked ${count} hits without dying — blacklisting`);
      }
      return;
    }
    if (killable && count >= NO_DAMAGE_HIT_LIMIT && !this.confirmedDamage.get(targetId)) {
      this.holdFire.set(targetId, Date.now() + HOLD_FIRE_MS);
      this.hitCounts.set(targetId, 0);
      this.host.logLine(`[hit] target ${targetId} (type ${ent?.type ?? "?"}) soaked ${count} hits with no confirmed damage — holding fire ${HOLD_FIRE_MS / 1000}s`);
      return;
    }
    this.host.send("ENEMYHIT", { time: this.host.getTime(), bulletId: shot.bulletId, id1: this.host.objectId, targetId, kill: false, id2: this.host.objectId });
  }

  onDamage(p: Packet<"DAMAGE">): void {
    this.noteDamage(p.targetId, p.damageAmount);
  }

  /**
   * Server-confirmed damage on a target, from a DAMAGE packet or from its HP stat
   * dropping in a NEWTICK. The current build sends no DAMAGE packets for our own
   * hits at all, so without the stat path every killable target looked "unhurt"
   * after 15 hits and got a 15 s hold — the Chicken God fight took 5 volleys and
   * several minutes of waiting (world logs, 2026-09-03).
   */
  noteDamage(targetId: number, amount: number): void {
    if (amount <= 0) return;
    this.confirmedDamage.set(targetId, (this.confirmedDamage.get(targetId) ?? 0) + amount);
    this.hitCounts.set(targetId, 0);
    if (this.holdFire.delete(targetId)) this.host.logLine(`[hit] target ${targetId} is taking damage again — resuming fire`);
  }

  onEnemyShoot(p: Packet<"ENEMYSHOOT">): void {
    const shooter = this.host.world.entities.get(p.ownerId);
    const proj = shooter ? this.res.object(shooter.type)?.projectiles[p.bulletType] : undefined;
    const speed = proj?.speed ?? 0.01;
    const life = proj?.life ?? 2000;
    const now = Date.now();
    for (let i = 0; i < Math.max(1, p.numShots); i++) {
      this.enemyBullets.push({ t0: now, x: p.startingPos.x, y: p.startingPos.y, angle: p.angle + p.angleInc * i, speed, life, dmg: p.damage });
    }
    if (this.enemyBullets.length > 600) this.enemyBullets.splice(0, 300);
  }

  /** Live enemy projectiles near us with their current age (ms). Read-only view for observers. */
  bulletsSnapshot(nearRadius = 28): { x: number; y: number; angle: number; speed: number; life: number; age: number; dmg: number }[] {
    if (!this.host.pos) return [];
    return this.liveBullets(nearRadius).map(([b, age]) => ({ x: b.x, y: b.y, angle: b.angle, speed: b.speed, life: b.life, age, dmg: b.dmg }));
  }
  /** Ms until the weapon can fire again (0 = ready). */
  shootCooldownMs(): number {
    const t = this.host.getTime();
    return Math.max(0, this.lastAttackTime + 1 / this.attackFreq() - t);
  }
  /** Ms until the ability can be used again (0 = ready); ignores MP. */
  abilityCooldownMs(): number {
    return Math.max(0, this.lastAbilityTime + 1000 - this.host.getTime());
  }

  private liveBullets(nearRadius = 28): [EnemyBullet, number][] {
    const now = Date.now();
    const pos = this.host.pos!;
    const alive: EnemyBullet[] = [];
    const near: [EnemyBullet, number][] = [];
    const cover = this.host.world.bulletBlockTiles.size ? new Set(this.host.world.bulletBlockTiles.values()) : null;
    for (const b of this.enemyBullets) {
      const age = now - b.t0;
      if (age > b.life) continue;
      // Enemy bullets die on cover (FullOccupy walls) like ours do; without this the danger
      // model kept them flying through walls (visible in the UI, and phantom danger for the
      // expert). Sweep the path since the last check in 0.25-tile steps.
      if (cover && cover.size) {
        const from = b.checkedAge ?? 0;
        const stepMs = 0.25 / b.speed;
        let a = from;
        let dead = false;
        while (a < age) {
          a = Math.min(a + stepMs, age);
          const x = b.x + Math.cos(b.angle) * b.speed * a;
          const y = b.y + Math.sin(b.angle) * b.speed * a;
          if (cover.has(`${Math.floor(x)},${Math.floor(y)}`)) {
            dead = true;
            break;
          }
        }
        if (dead) continue;
        b.checkedAge = age;
      }
      alive.push(b);
      const bx = b.x + Math.cos(b.angle) * b.speed * age;
      const by = b.y + Math.sin(b.angle) * b.speed * age;
      if ((bx - pos.x) ** 2 + (by - pos.y) ** 2 <= nearRadius * nearRadius) near.push([b, age]);
    }
    this.enemyBullets = alive;
    return near;
  }

  /** Damage taken walking from here toward (tx, ty) while tracked bullets fly. */
  journeyDanger(tx: number, ty: number, horizonMs = 900, stepMs = 60, radius = 0.7, bullets?: [EnemyBullet, number][]): number {
    const bs = bullets ?? this.liveBullets();
    if (!bs.length) return 0;
    const speed = this.host.speedPerMs();
    let px = this.host.pos!.x;
    let py = this.host.pos!.y;
    let danger = 0;
    const hit = new Set<number>();
    for (let t = stepMs; t <= horizonMs; t += stepMs) {
      const dx = tx - px;
      const dy = ty - py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        const f = Math.min(1, (speed * stepMs) / d);
        px += dx * f;
        py += dy * f;
      }
      bs.forEach(([b, age], idx) => {
        if (hit.has(idx)) return;
        const a = age + t;
        if (a > b.life) return;
        const bx = b.x + Math.cos(b.angle) * b.speed * a;
        const by = b.y + Math.sin(b.angle) * b.speed * a;
        if ((bx - px) ** 2 + (by - py) ** 2 <= radius * radius) {
          hit.add(idx);
          danger += Math.max(1, b.dmg);
        }
      });
    }
    return danger;
  }

  /** Safest reachable point if standing still gets us hit. */
  bestDodge(biasPos: WorldPos | null, horizonMs = 900): { target: WorldPos | null; danger: number } {
    const pos = this.host.pos;
    if (!pos) return { target: null, danger: 0 };
    const bullets = this.liveBullets();
    const here = this.journeyDanger(pos.x, pos.y, horizonMs, 60, 0.7, bullets);
    if (here <= 0) return { target: null, danger: 0 };
    let best: { score: [number, number, number]; x: number; y: number } | null = null;
    for (const r of [1.2, 2.4]) {
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6;
        const tx = pos.x + Math.cos(a) * r;
        const ty = pos.y + Math.sin(a) * r;
        if (!this.host.world.losWalkable(pos.x, pos.y, tx, ty)) continue;
        const d = this.journeyDanger(tx, ty, horizonMs, 60, 0.7, bullets);
        const bias = biasPos ? Math.hypot(tx - biasPos.x, ty - biasPos.y) : 0;
        const score: [number, number, number] = [d, bias, r];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
          best = { score, x: tx, y: ty };
        }
      }
    }
    if (best && best.score[0] < here) return { target: { x: best.x, y: best.y }, danger: here };
    return { target: null, danger: here };
  }
}
