/** Measures the generated world so density claims are checked, not asserted.
 *  Run: npx tsx scripts/worldstats.ts */
import { baseElevation, continentMask, biomeAt, BIOME, slopeAt } from '../src/world/terrain';
import { elevation } from '../src/world/ground';
import { airportInCell, cityInCell, AIRPORT_CELL, CITY_CELL, citiesNear, airportsNear, findSpawnAirport } from '../src/world/places';

const SEED = 20260902;
const NAMES = ['ocean', 'beach', 'grass', 'forest', 'rock', 'snow'];

// Sample a 600 km square of world.
const SPAN = 600_000, N = 260;
let land = 0;
const biomeHits = new Array(6).fill(0);
let hMin = Infinity, hMax = -Infinity, hSum = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const x = (i / N - 0.5) * SPAN, z = (j / N - 0.5) * SPAN;
    const h = baseElevation(x, z, SEED);
    hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); hSum += h;
    if (h > 0) land++;
    biomeHits[biomeAt(x, z, SEED, h, slopeAt(x, z, SEED))]++;
  }
}
const cells = N * N;
console.log('=== terrain over a 600 km square ===');
console.log(`land: ${(land / cells * 100).toFixed(1)}%   elevation ${hMin.toFixed(0)}m .. ${hMax.toFixed(0)}m   mean ${(hSum / cells).toFixed(0)}m`);
console.log('surface: ' + biomeHits.map((v, i) => `${NAMES[i]} ${(v / cells * 100).toFixed(1)}%`).join('  '));

console.log('\n=== airports ===');
let built = 0; const tiers = [0, 0, 0]; let tested = 0;
const R = Math.ceil(SPAN / AIRPORT_CELL / 2);
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
  tested++;
  const a = airportInCell(cx, cz, SEED);
  if (a) { built++; tiers[a.tier]++; }
}
const areaKm2 = (2 * R + 1) ** 2 * (AIRPORT_CELL / 1000) ** 2;
console.log(`${built} airports in ${tested} cells (${(built / tested * 100).toFixed(0)}% of cells)`);
console.log(`density: 1 per ${(areaKm2 / Math.max(1, built)).toFixed(0)} km2  ->  typical spacing ${Math.sqrt(areaKm2 / Math.max(1, built)).toFixed(0)} km`);
console.log(`tiers: strip ${tiers[0]}  regional ${tiers[1]}  international ${tiers[2]}`);

console.log('\n=== settlements ===');
let towns = 0; const pops: number[] = [];
const CR = Math.ceil(SPAN / CITY_CELL / 2);
let cityCells = 0;
for (let cz = -CR; cz <= CR; cz++) for (let cx = -CR; cx <= CR; cx++) {
  cityCells++;
  const c = cityInCell(cx, cz, SEED);
  if (c) { towns++; pops.push(c.population); }
}
pops.sort((a, b) => b - a);
const cityArea = (2 * CR + 1) ** 2 * (CITY_CELL / 1000) ** 2;
const landArea = cityArea * (land / cells);
console.log(`${towns} settlements in ${cityCells} cells (${(towns / cityCells * 100).toFixed(0)}% of cells)`);
console.log(`density over land: 1 per ${(landArea / Math.max(1, towns)).toFixed(0)} km2  ->  spacing ~${Math.sqrt(landArea / Math.max(1, towns)).toFixed(0)} km`);
const band = (lo: number, hi: number) => pops.filter((p) => p >= lo && p < hi).length;
console.log(`sizes: hamlet <2k ${band(0, 2000)}   town 2-20k ${band(2000, 20000)}   city 20-200k ${band(20000, 200000)}   metro 200k+ ${band(200000, 1e9)}`);
console.log(`largest: ${pops.slice(0, 5).map((p) => Math.round(p).toLocaleString()).join(', ')}`);
console.log(`total population: ${Math.round(pops.reduce((a, b) => a + b, 0)).toLocaleString()} over ${landArea.toFixed(0)} km2 land -> ${(pops.reduce((a, b) => a + b, 0) / landArea).toFixed(0)}/km2`);

console.log('\n=== what a real 250 km leg crosses, from the spawn field ===');
const spawn = findSpawnAirport(SEED);
console.log(`spawn: ${spawn.icao} ${spawn.name} at ${(spawn.x / 1000).toFixed(0)},${(spawn.z / 1000).toFixed(0)} km, elev ${spawn.elev.toFixed(0)}m`);
for (const [label, dirX, dirZ] of [['east', 1, 0], ['north', 0, -1], ['north-east', 0.7071, -0.7071]] as const) {
  let overLand = 0, nearTown = 0, townsSeen = new Set<string>(), fields = new Set<string>(), steps = 0;
  for (let d = 0; d <= 250_000; d += 2500) {
    steps++;
    const x = spawn.x + dirX * d, z = spawn.z + dirZ * d;
    if (baseElevation(x, z, SEED) > 0) overLand++;
    const cs = citiesNear(x, z, SEED, 12000);
    if (cs.length) nearTown++;
    for (const c of cs) townsSeen.add(c.key);
    for (const a of airportsNear(x, z, SEED, 1)) if (Math.hypot(a.x - x, a.z - z) < 15000) fields.add(a.key);
  }
  console.log(`  ${label.padEnd(11)} land ${(overLand / steps * 100).toFixed(0)}%   within 12km of a town ${(nearTown / steps * 100).toFixed(0)}% of the way   ${townsSeen.size} settlements  ${fields.size} airfields`);
}

console.log('\n=== airport flattening actually works ===');
outer: for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) {
  const a = airportInCell(cx, cz, SEED);
  if (!a || a.tier < 1) continue;
  let lo = Infinity, hi = -Infinity;
  for (let t = -0.45; t <= 0.45; t += 0.05) {
    const px = a.x + Math.sin(a.runway.heading) * a.runway.length * t;
    const pz = a.z - Math.cos(a.runway.heading) * a.runway.length * t;
    const h = elevation(px, pz, SEED);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  console.log(`${a.icao} ${a.name} tier ${a.tier}: elev ${a.elev.toFixed(0)}m, runway ${a.runway.length.toFixed(0)}m, height spread along centreline ${(hi - lo).toFixed(2)}m`);
  break outer;
}
