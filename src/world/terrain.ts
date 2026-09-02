import { fbm, ridged, lerp, smoothstep, clamp } from './noise';

export const SEA_LEVEL = 0;

/** How much land there is. Biased toward land on purpose: an ocean crossing
 *  with nothing in it is the least interesting thing a flight sim can offer. */
export function continentMask(x: number, z: number, seed: number): number {
  return smoothstep(-0.64, 0.02, fbm(x / 420000, z / 420000, 4, seed + 11));
}

/** Terrain before airports flatten anything into it. Kept separate so airport
 *  siting can ask what the ground *would* be without recursing through its own
 *  flattening. */
export function baseElevation(x: number, z: number, seed: number): number {
  const cont = continentMask(x, z, seed);
  let h = lerp(-320, 70, cont);

  // Mountain belts are long and coherent rather than scattered, because real
  // ranges follow plate boundaries and a field of random peaks reads as noise.
  const belt = smoothstep(-0.02, 0.58, fbm(x / 96000, z / 96000, 3, seed + 29));
  const mountain = belt * cont;
  h += mountain * ridged(x / 19000, z / 19000, 7, seed + 37) * 4200;

  h += cont * fbm(x / 5200, z / 5200, 5, seed + 53) * 165;
  h += cont * fbm(x / 780, z / 780, 4, seed + 71) * 21;

  // Beaches: flatten the last few metres either side of the shoreline so the
  // coast is a shore rather than a cliff everywhere.
  if (h > -18 && h < 18) h *= 0.55 + 0.45 * Math.abs(h) / 18;
  return h;
}

/** Steepest gradient magnitude, sampled. Used for airport and town siting —
 *  neither goes on a slope — and for picking rock over grass on the surface. */
export function slopeAt(
  x: number, z: number, seed: number,
  h: (x: number, z: number, seed: number) => number = baseElevation,
  step = 30,
): number {
  const e = h(x + step, z, seed) - h(x - step, z, seed);
  const n = h(x, z + step, seed) - h(x, z - step, seed);
  return Math.hypot(e, n) / (2 * step);
}

export const BIOME = { OCEAN: 0, BEACH: 1, GRASS: 2, FOREST: 3, ROCK: 4, SNOW: 5 } as const;
export type Biome = (typeof BIOME)[keyof typeof BIOME];

/** Moisture drives forest cover; it is its own field so treelines and open
 *  ground do not simply track altitude. */
export function moisture(x: number, z: number, seed: number): number {
  return fbm(x / 38000, z / 38000, 3, seed + 907) * 0.5 + 0.5;
}

export function biomeAt(x: number, z: number, seed: number, h: number, slope: number): Biome {
  if (h <= SEA_LEVEL) return BIOME.OCEAN;
  if (h < 6) return BIOME.BEACH;
  const snowLine = 1750 + fbm(x / 24000, z / 24000, 2, seed + 411) * 430;
  if (h > snowLine) return BIOME.SNOW;
  if (slope > 0.42 || h > snowLine - 380) return BIOME.ROCK;
  const m = moisture(x, z, seed);
  const treeLine = 1500 + m * 400;
  if (m > 0.46 && h < treeLine && slope < 0.34) return BIOME.FOREST;
  return BIOME.GRASS;
}

/** Colour used both by the terrain mesh and the map. Kept here so the mesher
 *  and any 2D view cannot drift apart. */
export function surfaceColor(
  out: { r: number; g: number; b: number },
  x: number, z: number, seed: number, h: number, slope: number,
): void {
  const jitter = fbm(x / 320, z / 320, 2, seed + 1301) * 0.06;
  const m = moisture(x, z, seed);
  let r: number, g: number, b: number;

  if (h <= SEA_LEVEL) { r = 0.05; g = 0.13; b = 0.20; }
  else if (h < 6) { r = 0.76; g = 0.70; b = 0.54; }
  else {
    const snowLine = 1750 + fbm(x / 24000, z / 24000, 2, seed + 411) * 430;
    const rocky = clamp(smoothstep(0.30, 0.52, slope) + smoothstep(snowLine - 520, snowLine - 90, h), 0, 1);
    const snow = smoothstep(snowLine - 60, snowLine + 190, h);
    // Dry grass to damp pasture, then forest where moisture allows.
    const dry = { r: 0.47, g: 0.45, b: 0.26 };
    const wet = { r: 0.26, g: 0.39, b: 0.19 };
    const forest = clamp((m - 0.44) * 2.3, 0, 1) * (1 - smoothstep(1400, 1750, h));
    r = lerp(dry.r, wet.r, m); g = lerp(dry.g, wet.g, m); b = lerp(dry.b, wet.b, m);
    r = lerp(r, 0.13, forest * 0.8); g = lerp(g, 0.26, forest * 0.8); b = lerp(b, 0.12, forest * 0.8);
    r = lerp(r, 0.38, rocky); g = lerp(g, 0.36, rocky); b = lerp(b, 0.34, rocky);
    r = lerp(r, 0.92, snow); g = lerp(g, 0.94, snow); b = lerp(b, 0.97, snow);
  }
  out.r = clamp(r + jitter, 0, 1);
  out.g = clamp(g + jitter, 0, 1);
  out.b = clamp(b + jitter, 0, 1);
}
