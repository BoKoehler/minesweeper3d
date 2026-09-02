import { rand2i, hash2i, lerp, clamp, fbm } from './noise';
import { baseElevation, slopeAt, continentMask } from './terrain';

export const AIRPORT_CELL = 21000;
export const CITY_CELL = 8200;

export interface Runway {
  /** Radians clockwise from north. */
  heading: number;
  length: number;
  width: number;
}

export interface Airport {
  key: string;
  icao: string;
  name: string;
  x: number; z: number;
  elev: number;
  runway: Runway;
  /** 0 grass strip, 1 regional, 2 international. */
  tier: number;
  /** Apron and terminal sit on this side of the runway (+1 or -1). */
  apronSide: number;
}

export interface City {
  key: string;
  name: string;
  x: number; z: number;
  elev: number;
  population: number;
  /** Metres from centre to the edge of the built-up area. */
  radius: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NAME_A = ['Kes', 'Bram', 'Nor', 'Vald', 'Ash', 'Corr', 'Hal', 'Mar', 'Pell', 'Torr', 'Wyn', 'El', 'Gran', 'Dun', 'Fen', 'Ryd'];
const NAME_B = ['ford', 'ton', 'wick', 'holm', 'dale', 'bury', 'mere', 'stead', 'haven', 'ridge', 'field', 'gate', 'moor', 'cross'];

function nameFrom(h: number): string {
  return NAME_A[h % NAME_A.length]! + NAME_B[(h >>> 8) % NAME_B.length]!;
}

function icaoFrom(h: number): string {
  let s = 'K';
  for (let i = 0; i < 3; i++) s += LETTERS[(h >>> (i * 5)) % 26];
  return s;
}

/** Cells are evaluated on demand and cached. A flight crosses only a handful,
 *  so this keeps the terrain query — which asks about airports for every single
 *  vertex it meshes — from re-deriving the same siting test thousands of times. */
function memo<T>(): { get(key: string, make: () => T): T; clear(): void } {
  const map = new Map<string, T>();
  return {
    get(key, make) {
      let v = map.get(key);
      if (v === undefined) { v = make(); map.set(key, v); }
      return v;
    },
    clear() { map.clear(); },
  };
}

const airportCache = memo<Airport | null>();
const cityCache = memo<City | null>();

/** Is this patch buildable? Flat enough, dry, and not up a mountain. */
function siteQuality(x: number, z: number, seed: number, span: number, samples: number): number {
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const px = x + Math.cos(a) * span, pz = z + Math.sin(a) * span;
    const h = baseElevation(px, pz, seed);
    lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h;
  }
  const mean = sum / samples;
  // Reject on the *lowest* sample, not the average: averaging let fields be
  // sited with one end under water.
  if (lo < 6 || mean < 12) return 0;
  const relief = hi - lo;
  return clamp(1 - relief / (span * 0.22), 0, 1) * clamp(1 - (mean - 40) / 2600, 0, 1);
}

/** Drop every cached cell. Called when a new world is created so a fresh seed
 *  really does give a fresh world. */
export function clearPlaceCaches(): void {
  airportCache.clear();
  cityCache.clear();
}

export function airportInCell(cx: number, cz: number, seed: number): Airport | null {
  // The seed is part of the key. Without it a second run with a different seed
  // silently gets the first run's airfields back out of the cache.
  return airportCache.get(`${seed}:${cx},${cz}`, () => {
    const h = hash2i(cx, cz, seed + 5501);
    const x = (cx + 0.18 + rand2i(cx, cz, seed + 21) * 0.64) * AIRPORT_CELL;
    const z = (cz + 0.18 + rand2i(cx, cz, seed + 22) * 0.64) * AIRPORT_CELL;

    // Bigger fields need flatter, larger ground, so test at the size we want
    // and fall back down the tiers rather than refusing to build anything.
    const roll = rand2i(cx, cz, seed + 23);
    let tier = roll > 0.93 ? 2 : roll > 0.66 ? 1 : 0;
    const spans = [620, 1300, 2100];
    let q = 0;
    for (; tier >= 0; tier--) {
      q = siteQuality(x, z, seed, spans[tier]!, 10);
      if (q > 0.3) break;
    }
    if (tier < 0) return null;
    // The centre itself must be dry land, not just the ring around it.
    if (baseElevation(x, z, seed) < 6) return null;

    const lengths = [820, 1750, 3300];
    const widths = [23, 40, 60];
    const elev = baseElevation(x, z, seed);
    return {
      key: `${cx},${cz}`,
      icao: icaoFrom(h),
      name: `${nameFrom(h)} ${['Airstrip', 'Regional', 'International'][tier]}`,
      x, z, elev,
      tier,
      runway: {
        heading: (hash2i(cx, cz, seed + 24) % 36) * (Math.PI / 18),
        length: lengths[tier]! * lerp(0.92, 1.08, rand2i(cx, cz, seed + 25)),
        width: widths[tier]!,
      },
      apronSide: rand2i(cx, cz, seed + 26) > 0.5 ? 1 : -1,
    };
  });
}

/** Every airport whose flattening or scenery could touch this point. */
export function airportsNear(x: number, z: number, seed: number, rings = 1): Airport[] {
  const cx = Math.floor(x / AIRPORT_CELL), cz = Math.floor(z / AIRPORT_CELL);
  const out: Airport[] = [];
  for (let dz = -rings; dz <= rings; dz++) {
    for (let dx = -rings; dx <= rings; dx++) {
      const a = airportInCell(cx + dx, cz + dz, seed);
      if (a) out.push(a);
    }
  }
  return out;
}

export function cityInCell(cx: number, cz: number, seed: number): City | null {
  return cityCache.get(`${seed}:${cx},${cz}`, () => {
    const x = (cx + 0.15 + rand2i(cx, cz, seed + 31) * 0.7) * CITY_CELL;
    const z = (cz + 0.15 + rand2i(cx, cz, seed + 32) * 0.7) * CITY_CELL;
    const elev = baseElevation(x, z, seed);
    if (elev < 9 || elev > 1500) return null;
    if (slopeAt(x, z, seed, baseElevation, 120) > 0.16) return null;

    // A regional habitability field, so towns cluster into populated belts and
    // leave genuine empty country between them, instead of tiling the map at
    // uniform spacing.
    const habitability = fbm(x / 120000, z / 120000, 3, seed + 33) * 0.5 + 0.5;
    const coastal = 1 - Math.abs(continentMask(x, z, seed) - 0.62) * 1.5;
    const chance = clamp(habitability * 0.85 + coastal * 0.3, 0, 1);
    if (rand2i(cx, cz, seed + 34) > chance) return null;

    // Settlement sizes follow a power law: thousands of hamlets, a handful of
    // cities. A uniform distribution gives every town the same size, which is
    // the thing that makes procedural worlds read as fake from the air.
    const u = Math.max(1e-4, rand2i(cx, cz, seed + 35));
    const population = clamp(420 * Math.pow(1 / u, 1.16) * lerp(0.7, 1.5, habitability), 260, 3_600_000);
    const radius = clamp(250 * Math.sqrt(population / 1000), 190, 13000);

    return { key: `${cx},${cz}`, name: nameFrom(hash2i(cx, cz, seed + 36)), x, z, elev, population, radius };
  });
}

export function citiesNear(x: number, z: number, seed: number, radiusMetres: number): City[] {
  const rings = Math.ceil(radiusMetres / CITY_CELL) + 1;
  const cx = Math.floor(x / CITY_CELL), cz = Math.floor(z / CITY_CELL);
  const out: City[] = [];
  for (let dz = -rings; dz <= rings; dz++) {
    for (let dx = -rings; dx <= rings; dx++) {
      const c = cityInCell(cx + dx, cz + dz, seed);
      if (!c) continue;
      if (Math.hypot(c.x - x, c.z - z) - c.radius > radiusMetres) continue;
      out.push(c);
    }
  }
  return out;
}

/** Runway-local coordinates: u along the centreline, v across it. */
export function toRunwayLocal(a: Airport, x: number, z: number): { u: number; v: number } {
  const s = Math.sin(a.runway.heading), c = Math.cos(a.runway.heading);
  const dx = x - a.x, dz = z - a.z;
  // Heading 0 points to -Z (north), so the along-runway axis is (sin, -cos).
  return { u: dx * s - dz * c, v: dx * c + dz * s };
}

/** How strongly the airport forces the ground to its own elevation here.
 *  1 on the movement area, easing to 0 across a graded margin. */
export function airportFlatten(a: Airport, x: number, z: number): number {
  const { u, v } = toRunwayLocal(a, x, z);
  const halfLen = a.runway.length / 2 + 90;
  const halfWid = a.runway.width / 2 + (a.tier === 0 ? 40 : 150);
  const blend = a.tier === 0 ? 130 : 300;
  const du = Math.max(0, Math.abs(u) - halfLen);
  const dv = Math.max(0, Math.abs(v) - halfWid);
  const d = Math.hypot(du, dv);
  if (d >= blend) return 0;
  const t = 1 - d / blend;
  return t * t * (3 - 2 * t);
}

/** Runway designator, e.g. "09/27", from the magnetic heading. */
export function runwayDesignators(a: Airport): [string, string] {
  const deg = ((a.runway.heading * 180) / Math.PI + 360) % 360;
  const n1 = Math.round(deg / 10) % 36 || 36;
  const n2 = ((n1 + 17) % 36) + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return [pad(n1), pad(n2)];
}

/** A field to start at: a paved runway on land, as close to the world origin
 *  as the search can find. Spawning somewhere sensible is not a nicety — the
 *  whole world is procedural, so without this a run can open over open water. */
export function findSpawnAirport(seed: number, minTier = 1): Airport {
  let best: Airport | null = null;
  let bestD = Infinity;
  for (let ring = 0; ring < 14 && !best; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const a = airportInCell(dx, dz, seed);
        if (!a || a.tier < minTier) continue;
        const d = Math.hypot(a.x, a.z);
        if (d < bestD) { bestD = d; best = a; }
      }
    }
  }
  return best ?? findSpawnAirport(seed, 0);
}
