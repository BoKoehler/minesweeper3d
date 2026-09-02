import { elevation } from '../../src/world/ground';
import { baseElevation } from '../../src/world/terrain';
import { citiesNear, findSpawnAirport } from '../../src/world/places';
import { hashSeed } from '../../src/world/noise';
const seed = hashSeed('sierra');
const spawn = findSpawnAirport(seed);
console.log('spawn', spawn.icao, spawn.name, 'at', (spawn.x/1000).toFixed(1), (spawn.z/1000).toFixed(1), 'km elev', spawn.elev.toFixed(0));
const near = citiesNear(spawn.x, spawn.z, seed, 12000);
console.log('towns within 12km of the field:', near.length);
for (const c of near.slice(0, 6)) {
  // How much of the town's footprint is actually above water?
  let land = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (let a = 0; a < 12; a++) for (const f of [0.35, 0.7, 1.0]) {
    const px = c.x + Math.cos(a / 12 * 6.283) * c.radius * f;
    const pz = c.z + Math.sin(a / 12 * 6.283) * c.radius * f;
    const h = elevation(px, pz, seed);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
    if (h > 0) land++;
    n++;
  }
  console.log(`  ${c.name.padEnd(12)} pop ${String(Math.round(c.population)).padStart(7)} r=${c.radius.toFixed(0).padStart(5)}m centre elev ${c.elev.toFixed(1).padStart(6)}m  footprint ${lo.toFixed(0)}..${hi.toFixed(0)}m  ${(land/n*100).toFixed(0)}% above water`);
}
