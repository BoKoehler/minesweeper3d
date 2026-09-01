import { FLAGGED } from '../core/grid';
import type { Board } from '../core/board';

/** World-space offset that centres the lattice on the origin. Cell (x,y,z) is
 *  centred at (x - c, y - c, z - c) and spans half a unit either side. */
export function centreOffset(n: number): number { return (n - 1) / 2; }

export interface Ray { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }

/** First solid cell along a ray, by voxel DDA (Amanatides & Woo).
 *
 *  This is O(grid dimension) rather than the O(instances) of raycasting an
 *  InstancedMesh, and it has a property the design leans on: DDA advances one
 *  axis at a time, so the cell before the hit is always face-adjacent to it.
 *  The first solid cell a ray reaches is therefore always diggable — picking
 *  and the frontier rule agree by construction rather than by check.
 */
export function pickCell(b: Board, ray: Ray): number {
  const g = b.grid;
  const n = g.n;
  const c = centreOffset(n);

  // Into grid space, where the lattice is the box [0, n]^3.
  let ox = ray.ox + c + 0.5, oy = ray.oy + c + 0.5, oz = ray.oz + c + 0.5;
  const dx = ray.dx, dy = ray.dy, dz = ray.dz;

  let tmin = 0, tmax = Infinity;
  const slab = (o: number, d: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= 0 && o <= n;
    let t1 = (0 - o) / d, t2 = (n - o) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    return tmax >= tmin;
  };
  if (!slab(ox, dx) || !slab(oy, dy) || !slab(oz, dz)) return -1;

  const t0 = Math.max(tmin, 0) + 1e-4;
  ox += dx * t0; oy += dy * t0; oz += dz * t0;

  const clamp = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  let ix = clamp(ox), iy = clamp(oy), iz = clamp(oz);

  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const inf = Infinity;
  const ddx = Math.abs(dx) < 1e-9 ? inf : Math.abs(1 / dx);
  const ddy = Math.abs(dy) < 1e-9 ? inf : Math.abs(1 / dy);
  const ddz = Math.abs(dz) < 1e-9 ? inf : Math.abs(1 / dz);
  let tx = ddx === inf ? inf : (dx > 0 ? ix + 1 - ox : ox - ix) * ddx;
  let ty = ddy === inf ? inf : (dy > 0 ? iy + 1 - oy : oy - iy) * ddy;
  let tz = ddz === inf ? inf : (dz > 0 ? iz + 1 - oz : oz - iz) * ddz;

  for (let guard = 0; guard < 4 * n + 8; guard++) {
    const i = g.idx(ix, iy, iz);
    if (b.hull[i] === 1 && b.state[i]! <= FLAGGED) return i;
    if (tx < ty && tx < tz) { ix += sx; tx += ddx; }
    else if (ty < tz) { iy += sy; ty += ddy; }
    else { iz += sz; tz += ddz; }
    if (ix < 0 || iy < 0 || iz < 0 || ix >= n || iy >= n || iz >= n) return -1;
  }
  return -1;
}
