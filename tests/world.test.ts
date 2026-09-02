import { describe, it, expect } from 'vitest';
import { simplex2, ridged, rand2i, hash2i, hashSeed, smoothstep, clamp, lerp } from '../src/world/noise';
import { baseElevation, continentMask, biomeAt, BIOME, slopeAt, surfaceColor } from '../src/world/terrain';
import { elevation, groundNormal, groundSlope } from '../src/world/ground';
import {
  airportInCell, cityInCell, airportsNear, citiesNear, findSpawnAirport,
  airportFlatten, toRunwayLocal, runwayDesignators, clearPlaceCaches, AIRPORT_CELL, CITY_CELL,
} from '../src/world/places';

const SEED = 20260902;

describe('noise', () => {
  it('is deterministic and seed-dependent', () => {
    expect(simplex2(1.5, -2.25, 7)).toBe(simplex2(1.5, -2.25, 7));
    expect(simplex2(1.5, -2.25, 7)).not.toBe(simplex2(1.5, -2.25, 8));
    expect(hash2i(3, 4, 1)).toBe(hash2i(3, 4, 1));
    expect(hashSeed('sierra')).toBe(hashSeed('sierra'));
    expect(hashSeed('sierra')).not.toBe(hashSeed('sierrb'));
  });

  it('stays in range and is not constant', () => {
    let lo = Infinity, hi = -Infinity, sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = simplex2(i * 0.137, i * 0.071, SEED);
      lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
    }
    expect(lo).toBeGreaterThan(-1.01);
    expect(hi).toBeLessThan(1.01);
    expect(hi - lo).toBeGreaterThan(0.8);
    expect(Math.abs(sum / N)).toBeLessThan(0.1);   // roughly zero-mean
  });

  it('is continuous — neighbouring samples do not jump', () => {
    let worst = 0;
    for (let i = 0; i < 800; i++) {
      const x = i * 0.31, y = i * 0.17;
      worst = Math.max(worst, Math.abs(simplex2(x, y, SEED) - simplex2(x + 0.001, y, SEED)));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('gives uniform-ish integers from the lattice hash', () => {
    const buckets = new Array(10).fill(0);
    for (let x = 0; x < 100; x++) for (let y = 0; y < 100; y++) buckets[Math.floor(rand2i(x, y, SEED) * 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(700);
  });

  it('ridged noise stays positive, which is what makes crests not troughs', () => {
    for (let i = 0; i < 400; i++) expect(ridged(i * 0.21, i * 0.13, 5, SEED)).toBeGreaterThanOrEqual(0);
  });

  it('has working helpers', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(0, 1, -3)).toBe(0);
  });
});

describe('terrain', () => {
  it('has both land and sea, weighted toward land', () => {
    let land = 0;
    const N = 90;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (baseElevation((i / N - 0.5) * 500000, (j / N - 0.5) * 500000, SEED) > 0) land++;
    }
    const frac = land / (N * N);
    expect(frac).toBeGreaterThan(0.5);
    expect(frac).toBeLessThan(0.95);
  });

  it('reaches real mountain heights and real ocean depths', () => {
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < 240; i++) for (let j = 0; j < 240; j++) {
      const h = baseElevation((i / 240 - 0.5) * 600000, (j / 240 - 0.5) * 600000, SEED);
      hi = Math.max(hi, h); lo = Math.min(lo, h);
    }
    expect(hi).toBeGreaterThan(2000);
    expect(hi).toBeLessThan(6000);
    expect(lo).toBeLessThan(-100);
  });

  it('is continuous: no cliffs between adjacent samples', () => {
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const x = i * 37.1, z = i * 53.7;
      worst = Math.max(worst, Math.abs(baseElevation(x, z, SEED) - baseElevation(x + 1, z, SEED)));
    }
    // A metre of ground should never change height by more than a couple of metres.
    expect(worst).toBeLessThan(4);
  });

  it('puts snow high, ocean low, and forest in between', () => {
    expect(biomeAt(0, 0, SEED, -50, 0)).toBe(BIOME.OCEAN);
    expect(biomeAt(0, 0, SEED, 3, 0)).toBe(BIOME.BEACH);
    expect(biomeAt(0, 0, SEED, 3000, 0.1)).toBe(BIOME.SNOW);
    expect(biomeAt(0, 0, SEED, 400, 0.9)).toBe(BIOME.ROCK);
  });

  it('colours the surface in range and differently for sea and snow', () => {
    const sea = { r: 0, g: 0, b: 0 }, snow = { r: 0, g: 0, b: 0 };
    surfaceColor(sea, 100, 100, SEED, -40, 0);
    surfaceColor(snow, 100, 100, SEED, 3200, 0.1);
    for (const c of [sea, snow]) for (const k of ['r', 'g', 'b'] as const) {
      expect(c[k]).toBeGreaterThanOrEqual(0);
      expect(c[k]).toBeLessThanOrEqual(1);
    }
    expect(snow.r + snow.g + snow.b).toBeGreaterThan(sea.r + sea.g + sea.b + 1);
  });

  it('reports slope: flat where flat, steep on a mountainside', () => {
    let steepest = 0, flattest = Infinity;
    for (let i = 0; i < 70; i++) for (let j = 0; j < 70; j++) {
      const sl = slopeAt((i / 70 - 0.5) * 400000, (j / 70 - 0.5) * 400000, SEED);
      steepest = Math.max(steepest, sl);
      flattest = Math.min(flattest, sl);
    }
    expect(steepest).toBeGreaterThan(0.3);
    expect(flattest).toBeLessThan(0.02);
    expect(continentMask(0, 0, SEED)).toBeGreaterThanOrEqual(0);
    expect(continentMask(0, 0, SEED)).toBeLessThanOrEqual(1);
  });
});

describe('airports', () => {
  const cells: { cx: number; cz: number }[] = [];
  for (let cz = -9; cz <= 9; cz++) for (let cx = -9; cx <= 9; cx++) cells.push({ cx, cz });
  const built = cells.map((c) => airportInCell(c.cx, c.cz, SEED)).filter((a) => a !== null);

  it('sites a useful number of them', () => {
    expect(built.length).toBeGreaterThan(cells.length * 0.06);
    expect(built.length).toBeLessThan(cells.length * 0.6);
  });

  it('never puts one in the sea', () => {
    for (const a of built) {
      expect(a.elev).toBeGreaterThan(0);
      // And the whole runway is on dry ground, not just the midpoint.
      for (let t = -0.5; t <= 0.5; t += 0.1) {
        const px = a.x + Math.sin(a.runway.heading) * a.runway.length * t;
        const pz = a.z - Math.cos(a.runway.heading) * a.runway.length * t;
        expect(elevation(px, pz, SEED)).toBeGreaterThan(0);
      }
    }
  });

  it('flattens the ground it stands on to within a few centimetres', () => {
    const paved = built.filter((a) => a.tier > 0);
    expect(paved.length).toBeGreaterThan(0);
    for (const a of paved.slice(0, 12)) {
      let lo = Infinity, hi = -Infinity;
      for (let t = -0.45; t <= 0.45; t += 0.05) {
        for (const v of [-0.4, 0, 0.4]) {
          const u = a.runway.length * t, w = a.runway.width * v;
          const s = Math.sin(a.runway.heading), c = Math.cos(a.runway.heading);
          const h = elevation(a.x + u * s + w * c, a.z - u * c + w * s, SEED);
          lo = Math.min(lo, h); hi = Math.max(hi, h);
        }
      }
      expect(hi - lo).toBeLessThan(0.05);
    }
  });

  it('blends back into the terrain rather than leaving a cliff', () => {
    const a = built.find((x) => x!.tier > 0)!;
    const s = Math.sin(a.runway.heading), c = Math.cos(a.runway.heading);
    let worst = 0, prev = elevation(a.x, a.z, SEED);
    for (let d = 0; d < 1400; d += 10) {
      const h = elevation(a.x + d * c, a.z + d * s, SEED);
      worst = Math.max(worst, Math.abs(h - prev));
      prev = h;
    }
    expect(worst).toBeLessThan(12);
  });

  it('is deterministic and cached consistently', () => {
    const cell = cells.find((c) => airportInCell(c.cx, c.cz, SEED) !== null)!;
    const a = airportInCell(cell.cx, cell.cz, SEED)!;
    expect(a).not.toBeNull();
    // Same call returns the identical cached object; a different seed does not.
    expect(airportInCell(cell.cx, cell.cz, SEED)).toBe(a);
    // A different seed must produce a different world, not the cached one.
    const other = airportInCell(cell.cx, cell.cz, SEED + 977);
    expect(other === null || other.icao !== a.icao || other.x !== a.x).toBe(true);
    // And clearing the cache does not change what a given seed produces.
    clearPlaceCaches();
    const again = airportInCell(cell.cx, cell.cz, SEED)!;
    expect(again.icao).toBe(a.icao);
    expect(again.x).toBe(a.x);
  });

  it('has sane runway geometry and designators', () => {
    for (const a of built) {
      expect(a.runway.length).toBeGreaterThan(500);
      expect(a.runway.length).toBeLessThan(4200);
      expect(a.runway.width).toBeGreaterThan(15);
      const [d1, d2] = runwayDesignators(a);
      expect(d1).toMatch(/^\d\d$/);
      expect(d2).toMatch(/^\d\d$/);
      expect(d1).not.toBe(d2);
    }
  });

  it('maps runway-local coordinates so along-track is the runway axis', () => {
    const a = built[0]!;
    const along = toRunwayLocal(a, a.x + Math.sin(a.runway.heading) * 100, a.z - Math.cos(a.runway.heading) * 100);
    expect(along.u).toBeCloseTo(100, 3);
    expect(Math.abs(along.v)).toBeLessThan(1e-6);
    expect(airportFlatten(a, a.x, a.z)).toBeCloseTo(1, 5);
    expect(airportFlatten(a, a.x + 40000, a.z)).toBe(0);
  });

  it('finds a paved field to start from near the origin', () => {
    const spawn = findSpawnAirport(SEED);
    expect(spawn.tier).toBeGreaterThan(0);
    expect(spawn.elev).toBeGreaterThan(0);
    expect(airportsNear(spawn.x, spawn.z, SEED, 1).some((a) => a.key === spawn.key)).toBe(true);
  });
});

describe('settlements', () => {
  const cells: ReturnType<typeof cityInCell>[] = [];
  for (let cz = -22; cz <= 22; cz++) for (let cx = -22; cx <= 22; cx++) cells.push(cityInCell(cx, cz, SEED));
  const towns = cells.filter((c) => c !== null);

  it('exists at a believable density', () => {
    const frac = towns.length / cells.length;
    expect(frac).toBeGreaterThan(0.05);
    expect(frac).toBeLessThan(0.6);
  });

  it('never sits in the sea', () => {
    for (const c of towns) expect(c!.elev).toBeGreaterThan(0);
  });

  it('follows a power law: mostly hamlets, a few cities', () => {
    const pops = towns.map((c) => c!.population).sort((a, b) => a - b);
    const median = pops[Math.floor(pops.length / 2)]!;
    const largest = pops[pops.length - 1]!;
    // A uniform distribution would put the largest within a few times the
    // median; a real settlement hierarchy is orders of magnitude apart.
    expect(largest / median).toBeGreaterThan(40);
    expect(pops.filter((p) => p < 2000).length / pops.length).toBeGreaterThan(0.4);
  });

  it('grows its radius with population', () => {
    const sorted = towns.slice().sort((a, b) => a!.population - b!.population);
    expect(sorted[sorted.length - 1]!.radius).toBeGreaterThan(sorted[0]!.radius * 5);
  });

  it('finds the towns around a point', () => {
    const spawn = findSpawnAirport(SEED);
    const near = citiesNear(spawn.x, spawn.z, SEED, 25000);
    expect(near.length).toBeGreaterThan(0);
    for (const c of near) expect(Math.hypot(c.x - spawn.x, c.z - spawn.z) - c.radius).toBeLessThan(25001);
  });
});

describe('ground queries', () => {
  it('gives an upward unit normal', () => {
    const n = { x: 0, y: 0, z: 0 };
    for (const [x, z] of [[0, 0], [12345, -6789], [-99000, 44000]] as const) {
      groundNormal(n, x, z, SEED);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it('is flat on a runway, so the gear does not fight a slope', () => {
    const a = findSpawnAirport(SEED);
    expect(groundSlope(a.x, a.z, SEED, 20)).toBeLessThan(0.002);
    const n = { x: 0, y: 0, z: 0 };
    groundNormal(n, a.x, a.z, SEED);
    expect(n.y).toBeGreaterThan(0.9999);
  });

  it('agrees with itself: the same coordinate always gives the same height', () => {
    for (let i = 0; i < 200; i++) {
      const x = (i * 977) % 50000, z = (i * 613) % 50000;
      expect(elevation(x, z, SEED)).toBe(elevation(x, z, SEED));
    }
  });

  it('uses cell sizes that keep the world coherent', () => {
    expect(AIRPORT_CELL).toBeGreaterThan(CITY_CELL);
  });
});
