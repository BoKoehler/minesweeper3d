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
/** Colour used both by the terrain mesh and the map. Kept here so the mesher
 *  and any 2D view cannot drift apart.
 *
 *  Variation is layered at three scales on purpose: a regional dry/damp field,
 *  patchwork at field size, and fine grain. One noise scale gives ground that
 *  is either uniformly flat or uniformly speckled, and both read as fake. */
export function surfaceColor(
  out: { r: number; g: number; b: number },
  x: number, z: number, seed: number, h: number, slope: number,
): void {
  if (h <= SEA_LEVEL) {
    // Shallows are lighter and greener than deep water.
    const shallow = smoothstep(-45, 0, h);
    out.r = lerp(0.020, 0.075, shallow);
    out.g = lerp(0.075, 0.185, shallow);
    out.b = lerp(0.125, 0.210, shallow);
    return;
  }

  const m = moisture(x, z, seed);
  const patch = fbm(x / 1400, z / 1400, 3, seed + 2203) * 0.5 + 0.5;   // fields
  const grain = fbm(x / 190, z / 190, 2, seed + 1301);                 // texture
  const region = fbm(x / 26000, z / 26000, 2, seed + 3307) * 0.5 + 0.5;

  if (h < 7) {
    const s = 1 - smoothstep(0, 7, h);
    out.r = lerp(0.62, 0.80, s) + grain * 0.05;
    out.g = lerp(0.57, 0.73, s) + grain * 0.05;
    out.b = lerp(0.42, 0.55, s) + grain * 0.04;
    return;
  }

  const snowLine = 1750 + fbm(x / 24000, z / 24000, 2, seed + 411) * 430;

  // Ground cover: parched, pasture, or forest, decided by moisture with the
  // patchwork breaking up the boundaries so nothing is a clean contour line.
  const wet = clamp(m * 0.80 + patch * 0.30 + region * 0.18 - 0.06, 0, 1);
  const dry = { r: 0.556, g: 0.520, b: 0.300 };
  const grass = { r: 0.320, g: 0.462, b: 0.216 };
  let r = lerp(dry.r, grass.r, wet);
  let g = lerp(dry.g, grass.g, wet);
  let b = lerp(dry.b, grass.b, wet);

  const forest = clamp((m - 0.36) * 2.8, 0, 1)
    * clamp((patch - 0.22) * 2.1, 0, 1)
    * (1 - smoothstep(1250, 1700, h))
    * (1 - smoothstep(0.34, 0.52, slope));
  r = lerp(r, 0.152, forest); g = lerp(g, 0.286, forest); b = lerp(b, 0.136, forest);

  // Rock takes over on steep ground and near the tops, with banding so cliffs
  // are not one flat grey.
  const band = fbm(x / 240, h / 90, 2, seed + 5501) * 0.5 + 0.5;
  const rocky = clamp(smoothstep(0.28, 0.55, slope) + smoothstep(snowLine - 560, snowLine - 80, h), 0, 1);
  const rock = { r: lerp(0.300, 0.455, band), g: lerp(0.286, 0.424, band), b: lerp(0.268, 0.395, band) };
  r = lerp(r, rock.r, rocky); g = lerp(g, rock.g, rocky); b = lerp(b, rock.b, rocky);

  // Snow settles on shallow ground first; steep faces stay bare.
  const snow = smoothstep(snowLine - 90, snowLine + 210, h) * (1 - smoothstep(0.52, 0.82, slope));
  r = lerp(r, 0.905, snow); g = lerp(g, 0.930, snow); b = lerp(b, 0.985, snow);

  // Slope shading, so relief reads even in flat light.
  const shade = 1 - clamp(slope, 0, 1) * 0.16;
  const j = grain * 0.055;
  out.r = clamp((r + j) * shade, 0, 1);
  out.g = clamp((g + j) * shade, 0, 1);
  out.b = clamp((b + j * 0.7) * shade, 0, 1);
}
