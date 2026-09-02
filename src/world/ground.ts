import { airportsNear, airportFlatten } from './places';
import { baseElevation, slopeAt } from './terrain';
import { lerp } from './noise';

/** Ground elevation including everything built into it. This is the single
 *  source of truth: the terrain mesher, the landing-gear contact test and the
 *  runway geometry all call it, so none of them can disagree about where the
 *  ground is. */
export function elevation(x: number, z: number, seed: number): number {
  let h = baseElevation(x, z, seed);
  const near = airportsNear(x, z, seed);
  for (let i = 0; i < near.length; i++) {
    const a = near[i]!;
    const t = airportFlatten(a, x, z);
    if (t > 0) h = lerp(h, a.elev, t);
  }
  return h;
}

export function groundSlope(x: number, z: number, seed: number, step = 30): number {
  return slopeAt(x, z, seed, elevation, step);
}

/** Upward surface normal, for gear contact and for lighting the ground. */
export function groundNormal(
  out: { x: number; y: number; z: number },
  x: number, z: number, seed: number, step = 12,
): void {
  const e = elevation(x + step, z, seed) - elevation(x - step, z, seed);
  const n = elevation(x, z + step, seed) - elevation(x, z - step, seed);
  const len = Math.hypot(e, 2 * step, n);
  out.x = -e / len; out.y = (2 * step) / len; out.z = -n / len;
}
