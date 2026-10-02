// A* over the tile grid plus string-pulling, on whatever the bot has seen.
// Unseen tiles are walkable so long routes plan optimistically and correct
// themselves as UPDATEs stream in. The vault trip walks to portals and chests
// with it (fleet/vaultTrip.ts).
import type { WorldPos } from "../protocol/data";

export interface Grid {
  isWalkable(tx: number, ty: number): boolean;
  blockedTileList(): [number, number][];
  losWalkable(x0: number, y0: number, x1: number, y1: number): boolean;
}

const SQRT2 = Math.SQRT2;
export const PATH_MAX_EXPAND = 40_000;

/** Binary min-heap keyed on f. */
class Heap {
  private a: { f: number; g: number; x: number; y: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(n: { f: number; g: number; x: number; y: number }): void {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Tile-centre waypoints from start to within goalDist of goal, or null. */
export function findPath(grid: Grid, start: WorldPos, goal: WorldPos, goalDist: number): WorldPos[] | null {
  // Tiles hugging a wall cost extra so routes swing around corners.
  const nearWall = new Set<string>();
  for (const [bx, by] of grid.blockedTileList()) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) nearWall.add(`${bx + dx},${by + dy}`);
  }
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const h = (x: number, y: number) => Math.hypot(x + 0.5 - goal.x, y + 0.5 - goal.y);
  const open = new Heap();
  open.push({ f: h(sx, sy), g: 0, x: sx, y: sy });
  const gScore = new Map<string, number>([[`${sx},${sy}`, 0]]);
  const came = new Map<string, string>();
  let expansions = 0;
  while (open.size) {
    const cur = open.pop();
    const ck = `${cur.x},${cur.y}`;
    if (cur.g > (gScore.get(ck) ?? Infinity)) continue;
    if (h(cur.x, cur.y) <= goalDist) {
      const path: string[] = [ck];
      let k = ck;
      while (came.has(k)) {
        k = came.get(k)!;
        path.push(k);
      }
      path.reverse();
      const out = path.slice(1).map((s) => {
        const [x, y] = s.split(",").map(Number);
        return { x: x + 0.5, y: y + 0.5 };
      });
      return out.length ? out : [{ x: sx + 0.5, y: sy + 0.5 }];
    }
    if (++expansions > PATH_MAX_EXPAND) return null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (!grid.isWalkable(nx, ny)) continue;
        if (dx && dy && (!grid.isWalkable(cur.x + dx, cur.y) || !grid.isWalkable(cur.x, cur.y + dy))) continue;
        let ng = cur.g + (dx && dy ? SQRT2 : 1);
        const nk = `${nx},${ny}`;
        if (nearWall.has(nk)) ng += 0.45;
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, ck);
          open.push({ f: ng + h(nx, ny), g: ng, x: nx, y: ny });
        }
      }
    }
  }
  return null;
}

/** Drop waypoints reachable in a straight walkable line. */
export function smoothPath(grid: Grid, start: WorldPos, path: WorldPos[], lookahead = 25): WorldPos[] {
  if (!path.length) return path;
  const out: WorldPos[] = [];
  let cur = start;
  let i = 0;
  while (i < path.length) {
    let j = Math.min(i + lookahead, path.length - 1);
    while (j > i && !grid.losWalkable(cur.x, cur.y, path[j].x, path[j].y)) j--;
    out.push(path[j]);
    cur = path[j];
    i = j + 1;
  }
  return out;
}
