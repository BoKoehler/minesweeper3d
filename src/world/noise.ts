/** Deterministic noise. Everything in the world — terrain, airports, cities,
 *  individual buildings — is a pure function of position and seed, so nothing
 *  needs storing and any coordinate can be evaluated on demand, at any time,
 *  on the CPU. That is what lets the flight model, the mesher and the airport
 *  placer all agree about the ground without sharing state. */

export function hash2i(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Uniform in [0,1) from integer lattice coords. */
export function rand2i(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
]);

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Simplex noise in [-1,1]. Gradients come from the hash rather than a
 *  permutation table so the field is fully defined by the seed argument. */
export function simplex2(xin: number, yin: number, seed: number): number {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);

  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;

  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;

  let n = 0;
  const corner = (cx: number, cy: number, gi: number, gj: number): void => {
    let t0 = 0.5 - cx * cx - cy * cy;
    if (t0 <= 0) return;
    const g = (hash2i(gi, gj, seed) & 7) * 2;
    t0 *= t0;
    n += t0 * t0 * (GRAD2[g]! * cx + GRAD2[g + 1]! * cy);
  };
  corner(x0, y0, i, j);
  corner(x1, y1, i + i1, j + j1);
  corner(x2, y2, i + 1, j + 1);
  return 70 * n;
}

/** Fractal Brownian motion: the workhorse for rolling, natural-looking ground. */
export function fbm(x: number, y: number, octaves: number, seed: number, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex2(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal. Folding the noise about zero turns smooth hills into
 *  sharp crests and V-shaped valleys — this is what makes mountains read as
 *  mountains rather than as large dunes. */
export function ridged(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0, prev = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(simplex2(x * freq, y * freq, seed + o * 7919));
    const v = n * n * prev;
    prev = v;
    sum += amp * v;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
