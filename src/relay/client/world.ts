// What the bot can see: ground tiles, objects (with walk/bullet blocking
// derived from the object tables), containers and their contents, and the
// quest marker. Feeds pathfinding, dodging and looting.
import type { WorldPos, StatData } from "../protocol/data";
import type { Packet } from "../protocol/packets";
import { Stat } from "../protocol/stats";
import type { RealmResources } from "../realm/resources";

export interface Entity {
  type: number;
  pos: WorldPos;
  /** Our projectiles can hit it (and reporting the hit is valid). */
  hittable: boolean;
  /** Permanently invincible: bullets die on it silently. */
  absorb: boolean;
  condition: number;
  /** Last HP / MAXHP stats seen on the object; -1 when the server never sent them. */
  hp: number;
  maxHp: number;
  container?: boolean;
  inv?: number[];
}

/** Square-occupying objects that still count as a hit on contact. */
export const HIT_REPORT_TYPES = new Set([6148, 6149, 355]);
const VIEW_DROP_RADIUS = 13;

const key = (x: number, y: number) => `${x},${y}`;

export class WorldState {
  readonly tiles = new Map<string, number>();
  readonly entities = new Map<number, Entity>();
  /** objectId -> tile of walk-blocking objects. */
  readonly blockedTiles = new Map<number, string>();
  private readonly blockedSet = new Set<string>();
  /** objectId -> tile of projectile-blocking (FullOccupy) objects. */
  readonly bulletBlockTiles = new Map<number, string>();
  /** tile -> objectId of practice targets / destructibles. */
  readonly enemyHitTiles = new Map<string, number>();
  questObjectId = -1;

  constructor(private readonly res: RealmResources | null) {}

  reset(): void {
    this.tiles.clear();
    this.entities.clear();
    this.blockedTiles.clear();
    this.blockedSet.clear();
    this.bulletBlockTiles.clear();
    this.enemyHitTiles.clear();
    this.questObjectId = -1;
  }

  static conditionOf(stats: StatData[], dflt = 0): number {
    for (const s of stats) if (s.statType === Stat.CONDITION) return s.statValue;
    return dflt;
  }
  private static hpOf(stats: StatData[], dflt: number): number {
    for (const s of stats) if (s.statType === Stat.HP) return s.statValue;
    return dflt;
  }
  private static maxHpOf(stats: StatData[], dflt: number): number {
    for (const s of stats) if (s.statType === Stat.MAXHP) return s.statValue;
    return dflt;
  }
  private static hasMaxHp(stats: StatData[]): boolean {
    return stats.some((s) => s.statType === Stat.MAXHP && s.statValue > 0);
  }
  private static applyInv(inv: number[], stats: StatData[]): void {
    for (const s of stats) if (s.statType >= Stat.INVENTORY0 && s.statType <= Stat.INVENTORY0 + 7) inv[s.statType - Stat.INVENTORY0] = s.statValue;
  }

  applyUpdate(p: Packet<"UPDATE">, selfId: number, selfPos: WorldPos | null): void {
    for (const t of p.tiles) this.tiles.set(key(t.x, t.y), t.type);
    for (const obj of p.newObjs) {
      const oid = obj.status.objectId;
      if (oid === selfId) continue;
      const props = this.res?.object(obj.objectType);
      const tile = key(Math.floor(obj.status.pos.x), Math.floor(obj.status.pos.y));
      if (props?.occupySquare) {
        this.blockedTiles.set(oid, tile);
        this.blockedSet.add(tile);
        if (props.fullOccupy) this.bulletBlockTiles.set(oid, tile);
      }
      if (HIT_REPORT_TYPES.has(obj.objectType)) this.enemyHitTiles.set(tile, oid);
      const isPlayer = props?.cls === "Player";
      const hittable = !isPlayer && !(props?.occupySquare ?? false) && !(props?.invincible ?? false) &&
        ((props?.enemy ?? false) || (props?.maxHp ?? 0) > 0 || WorldState.hasMaxHp(obj.status.stats));
      const ent: Entity = {
        type: obj.objectType, pos: obj.status.pos, hittable, absorb: props?.invincible ?? false, condition: WorldState.conditionOf(obj.status.stats),
        hp: WorldState.hpOf(obj.status.stats, -1), maxHp: WorldState.maxHpOf(obj.status.stats, props?.maxHp || -1),
      };
      if (props?.cls === "Container") {
        ent.container = true;
        ent.inv = Array(8).fill(-1);
        WorldState.applyInv(ent.inv, obj.status.stats);
      }
      this.entities.set(oid, ent);
    }
    for (const oid of p.drops) {
      // drops = died OR left view. A wall that merely left view is still
      // there: only forget collision data for drops that happen close by.
      const tile = this.blockedTiles.get(oid);
      if (tile !== undefined && selfPos) {
        const [tx, ty] = tile.split(",").map(Number);
        const dx = tx + 0.5 - selfPos.x;
        const dy = ty + 0.5 - selfPos.y;
        if (dx * dx + dy * dy > VIEW_DROP_RADIUS * VIEW_DROP_RADIUS) {
          this.entities.delete(oid);
          continue;
        }
      }
      if (this.blockedTiles.delete(oid)) {
        this.blockedSet.clear();
        for (const t of this.blockedTiles.values()) this.blockedSet.add(t);
      }
      if (tile !== undefined && this.enemyHitTiles.get(tile) === oid) this.enemyHitTiles.delete(tile);
      this.bulletBlockTiles.delete(oid);
      this.entities.delete(oid);
    }
  }

  applyTick(p: Packet<"NEWTICK">, selfId: number): void {
    for (const st of p.statuses) {
      if (st.objectId === selfId) continue;
      const ent = this.entities.get(st.objectId);
      if (!ent) continue;
      ent.pos = st.pos;
      ent.condition = WorldState.conditionOf(st.stats, ent.condition);
      ent.hp = WorldState.hpOf(st.stats, ent.hp);
      ent.maxHp = WorldState.maxHpOf(st.stats, ent.maxHp);
      if (ent.container && ent.inv) WorldState.applyInv(ent.inv, st.stats);
    }
  }

  /** Unknown tiles count as walkable so long paths plan optimistically. */
  isWalkable(tx: number, ty: number): boolean {
    const k = key(tx, ty);
    if (this.blockedSet.has(k)) return false;
    const t = this.tiles.get(k);
    return !(t !== undefined && this.res?.noWalk(t));
  }
  isBlockedTile(tx: number, ty: number): boolean {
    return this.blockedSet.has(key(tx, ty));
  }
  blockedTileList(): [number, number][] {
    return [...this.blockedSet].map((k) => k.split(",").map(Number) as [number, number]);
  }

  /** Straight segment stays walkable, checked as a fat ray with clearance. */
  losWalkable(x0: number, y0: number, x1: number, y1: number, step = 0.35, clearance = 0.3): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return this.isWalkable(Math.floor(x1), Math.floor(y1));
    const px = (-dy / dist) * clearance;
    const py = (dx / dist) * clearance;
    const n = Math.max(1, Math.floor(dist / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      if (!this.isWalkable(Math.floor(cx), Math.floor(cy)) || !this.isWalkable(Math.floor(cx + px), Math.floor(cy + py)) || !this.isWalkable(Math.floor(cx - px), Math.floor(cy - py))) return false;
    }
    return true;
  }
}
