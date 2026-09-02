import { elevation } from '../../src/world/ground';
import { findSpawnAirport, citiesNear } from '../../src/world/places';
import { hashSeed } from '../../src/world/noise';
const seed = hashSeed('sierra');
const spawn = findSpawnAirport(seed);
const heading = spawn.runway.heading;
const d = 5200;
const score = (hdg: number) => {
  let land = 0;
  for (let f = 0.2; f <= 1; f += 0.2) {
    const px = spawn.x - Math.sin(hdg) * d * f, pz = spawn.z + Math.cos(hdg) * d * f;
    if (elevation(px, pz, seed) > 2) land++;
  }
  return land;
};
console.log('runway heading', (heading * 57.3).toFixed(0), 'deg; land score', score(heading), 'vs reciprocal', score(heading + Math.PI));
const approach = score(heading) >= score(heading + Math.PI) ? heading : heading + Math.PI;
const ax = spawn.x - Math.sin(approach) * d, az = spawn.z + Math.cos(approach) * d;
console.log('start position', (ax/1000).toFixed(1), (az/1000).toFixed(1), 'km  elevation there:', elevation(ax, az, seed).toFixed(1), 'm');
console.log('elevation along the approach:');
for (let f = 0; f <= 1.001; f += 0.125) {
  const px = spawn.x - Math.sin(approach) * d * f, pz = spawn.z + Math.cos(approach) * d * f;
  console.log(`  ${(f*d/1000).toFixed(1)} km out: ${elevation(px, pz, seed).toFixed(1)} m`);
}
console.log('towns within 2.5 km of the start:', citiesNear(ax, az, seed, 2500).map(c => c.name).join(', ') || 'none');
