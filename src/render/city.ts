import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3, CircleGeometry, Mesh, DoubleSide } from 'three';
import { citiesNear, type City } from '../world/places';
import { elevation } from '../world/ground';
import { rand2i } from '../world/noise';

/** Buildings are generated for the ground near the camera, not for whole
 *  cities: a million-person metro covers 400 km2 and nobody can see most of it.
 *  The near ring is drawn building by building, the far ring in coarser blocks
 *  that stand for a whole street each. */
const NEAR_RADIUS = 2600;
const FAR_RADIUS = 9000;
const NEAR_SPACING = 27;
const FAR_SPACING = 76;
const MAX_NEAR = 14000;
const MAX_FAR = 9000;

const PALETTE = [
  new Color('#b9b2a6'), new Color('#a8a094'), new Color('#8f8880'), new Color('#9d8b78'),
  new Color('#7e7a76'), new Color('#c4bcae'), new Color('#6f7d86'), new Color('#8a6f60'),
];
const GLASS = new Color('#63788a');

/** Height at the centre of town, from population. A hamlet is single-storey
 *  and a metro has a core — using one height everywhere is the thing that makes
 *  procedural cities read as a circuit board. */
function coreHeight(city: City): number {
  return 4 + Math.max(0, Math.log10(city.population) - 2.6) * 22;
}

function densityAt(t: number): number {
  // t is 0 at the centre, 1 at the edge. Dense core, thinning suburbs.
  return 0.86 * Math.pow(1 - t, 0.75) + 0.06;
}

export interface CityStats { near: number; far: number; cities: number }

export class CityRenderer {
  readonly group = new Group();
  readonly stats: CityStats = { near: 0, far: 0, cities: 0 };
  private near: InstancedMesh;
  private far: InstancedMesh;
  private pads = new Map<string, Mesh>();
  private padGroup = new Group();
  private lastBuild = new Vector3(Infinity, 0, Infinity);
  private origin = new Vector3();

  constructor(private seed: number) {
    const geo = new BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);        // sit on the ground rather than through it
    // NOT vertexColors: an InstancedMesh colours itself through instanceColor,
    // and asking for vertex colours makes the shader look for a per-vertex
    // colour attribute the box geometry does not have — every building black.
    const mat = new MeshLambertMaterial({});
    this.near = new InstancedMesh(geo, mat, MAX_NEAR);
    this.far = new InstancedMesh(geo, mat, MAX_FAR);
    this.near.frustumCulled = false;
    this.far.frustumCulled = false;
    this.near.count = 0;
    this.far.count = 0;
    this.group.add(this.padGroup, this.far, this.near);
  }

  setOrigin(o: Vector3): void {
    this.origin.copy(o);
    this.lastBuild.set(Infinity, 0, Infinity);
    for (const [key, pad] of this.pads) {
      const [x, y, z] = key.split(':').map(Number);
      pad.position.set(x! - o.x, y! - o.y, z! - o.z);
    }
  }

  update(cameraWorld: Vector3): void {
    if (this.lastBuild.distanceTo(cameraWorld) < 260) return;
    this.lastBuild.copy(cameraWorld);
    const cities = citiesNear(cameraWorld.x, cameraWorld.z, this.seed, FAR_RADIUS);
    this.stats.cities = cities.length;
    this.buildPads(cities);
    this.buildBuildings(cities, cameraWorld);
  }

  /** A tinted disc under each town so built-up ground reads as built-up from
   *  far higher than any building is worth drawing. */
  private buildPads(cities: City[]): void {
    const want = new Set<string>();
    for (const c of cities) {
      const key = `${c.x}:${c.elev}:${c.z}`;
      want.add(key);
      if (this.pads.has(key)) continue;
      // The pad follows the ground rather than lying flat. A flat disc over
      // rolling terrain either floats at one edge or sinks at the other, and
      // that single wrong silhouette is what makes a town read as a decal.
      const geo = new CircleGeometry(c.radius * 1.05, 30, 0, Math.PI * 2);
      const pos = geo.attributes.position!;
      for (let i = 0; i < pos.count; i++) {
        const vx = pos.getX(i), vy = pos.getY(i);
        pos.setXYZ(i, vx, elevation(c.x + vx, c.z + vy, this.seed) - c.elev + 0.6, vy);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      const shade = 0.40 + Math.min(0.20, Math.log10(c.population) * 0.04);
      const mesh = new Mesh(geo, new MeshLambertMaterial({
        color: new Color(shade * 1.04, shade * 0.99, shade * 0.90), side: DoubleSide,
        transparent: true, opacity: 0.7, depthWrite: false,
      }));
      mesh.position.set(c.x - this.origin.x, c.elev - this.origin.y, c.z - this.origin.z);
      mesh.renderOrder = 1;
      this.pads.set(key, mesh);
      this.padGroup.add(mesh);
    }
    for (const [key, pad] of this.pads) {
      if (want.has(key)) continue;
      this.padGroup.remove(pad);
      pad.geometry.dispose();
      this.pads.delete(key);
    }
  }

  private buildBuildings(cities: City[], cam: Vector3): void {
    const m = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scale = new Vector3();
    const col = new Color();
    let nNear = 0, nFar = 0;

    for (const ring of [0, 1] as const) {
      const radius = ring === 0 ? NEAR_RADIUS : FAR_RADIUS;
      const spacing = ring === 0 ? NEAR_SPACING : FAR_SPACING;
      const inner = ring === 0 ? 0 : NEAR_RADIUS;
      const mesh = ring === 0 ? this.near : this.far;
      const cap = ring === 0 ? MAX_NEAR : MAX_FAR;

      const gx0 = Math.floor((cam.x - radius) / spacing);
      const gx1 = Math.ceil((cam.x + radius) / spacing);
      const gz0 = Math.floor((cam.z - radius) / spacing);
      const gz1 = Math.ceil((cam.z + radius) / spacing);

      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          let count = ring === 0 ? nNear : nFar;
          if (count >= cap) break;
          const jx = rand2i(gx, gz, this.seed + 601);
          const jz = rand2i(gx, gz, this.seed + 602);
          const wx = (gx + 0.5 + (jx - 0.5) * 0.7) * spacing;
          const wz = (gz + 0.5 + (jz - 0.5) * 0.7) * spacing;

          const dc = Math.hypot(wx - cam.x, wz - cam.z);
          if (dc > radius || dc < inner) continue;

          let host: City | null = null;
          let t = 1;
          for (const c of cities) {
            const d = Math.hypot(wx - c.x, wz - c.z);
            if (d < c.radius) { const tt = d / c.radius; if (tt < t) { t = tt; host = c; } }
          }
          if (!host) continue;

          const roll = rand2i(gx, gz, this.seed + 603);
          if (roll > densityAt(t)) continue;

          const hh = rand2i(gx, gz, this.seed + 604);
          const core = coreHeight(host);
          // Tall in the middle, low at the edges, with a long tail so a few
          // buildings stand well above their neighbours.
          const h = Math.max(4, core * (0.22 + 0.78 * Math.pow(1 - t, 1.7)) * (0.55 + 1.75 * Math.pow(hh, 2.6)));
          const w = ring === 0
            ? 9 + rand2i(gx, gz, this.seed + 605) * (h > 40 ? 26 : 13)
            : spacing * (0.45 + rand2i(gx, gz, this.seed + 605) * 0.4);
          const d2 = ring === 0
            ? 9 + rand2i(gx, gz, this.seed + 606) * (h > 40 ? 26 : 13)
            : w * (0.7 + rand2i(gx, gz, this.seed + 606) * 0.6);

          const ground = elevation(wx, wz, this.seed);
          pos.set(wx - this.origin.x, ground - 0.5 - this.origin.y, wz - this.origin.z);
          quat.setFromAxisAngle(new Vector3(0, 1, 0), rand2i(gx, gz, this.seed + 607) * 0.4 - 0.2);
          scale.set(w, h, d2);
          m.compose(pos, quat, scale);
          mesh.setMatrixAt(count, m);

          const tall = Math.min(1, h / 70);
          col.copy(PALETTE[Math.floor(rand2i(gx, gz, this.seed + 608) * PALETTE.length)]!)
            .lerp(GLASS, tall * 0.7)
            .multiplyScalar(0.82 + rand2i(gx, gz, this.seed + 609) * 0.3);
          mesh.setColorAt(count, col);

          count++;
          if (ring === 0) nNear = count; else nFar = count;
        }
      }
    }

    this.near.count = nNear;
    this.far.count = nFar;
    this.near.instanceMatrix.needsUpdate = true;
    this.far.instanceMatrix.needsUpdate = true;
    if (this.near.instanceColor) this.near.instanceColor.needsUpdate = true;
    if (this.far.instanceColor) this.far.instanceColor.needsUpdate = true;
    this.stats.near = nNear;
    this.stats.far = nFar;
  }

  dispose(): void {
    this.near.geometry.dispose();
    (this.near.material as MeshLambertMaterial).dispose();
    for (const pad of this.pads.values()) pad.geometry.dispose();
  }
}
