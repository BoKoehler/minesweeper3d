import {
  BackSide, Color, DirectionalLight, DoubleSide, FogExp2, Group, HemisphereLight, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, PlaneGeometry, Scene, ShaderMaterial, SphereGeometry,
  Vector3, AmbientLight, Vector2,
} from 'three';
import { cloudTexture, waterNormalTexture } from './textures';
import { TerrainRenderer } from './terrain';
import { CityRenderer } from './city';
import { buildAirport } from './airport';
import { airportsNear, type Airport } from '../world/places';

/** Sky as a gradient dome with a sun in it. Cheap, and at flight-sim
 *  distances an analytic scattering model buys nothing a good gradient and
 *  matching fog do not. */
const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const SKY_FRAG = `
  uniform vec3 uSun;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunTint;
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    vec3 sun = normalize(uSun);
    float up = clamp(d.y, -1.0, 1.0);
    float t = clamp(up, 0.0, 1.0);

    // Rayleigh-ish vertical gradient. The low exponent keeps a tight, bright
    // band right on the horizon, which is what reads as distance from the air.
    vec3 col = mix(uHorizon, uZenith, pow(t, 0.42));

    float cosT = max(dot(d, sun), 0.0);
    // Mie forward scattering: the sky warms and brightens toward the sun, most
    // strongly low down where the air is thickest.
    col += uSunTint * pow(cosT, 7.0) * (1.0 - t * 0.75) * 0.55;
    // Broad glow, then the disc itself with a soft limb.
    col += uSunTint * pow(cosT, 260.0) * 1.7;
    col += vec3(1.0, 0.97, 0.90) * smoothstep(0.99955, 0.99992, cosT) * 14.0;
    // Opposite the sun the sky is deeper and cooler.
    col *= 1.0 - 0.10 * pow(max(-dot(d, sun), 0.0), 2.0);

    col = mix(col, uGround, clamp(-up * 4.5, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
  }`;

export interface WorldStats {
  terrainNodes: number; terrainTris: number; terrainBuilt: number;
  buildingsNear: number; buildingsFar: number; cities: number; airports: number;
}

/** Owns everything outside the cockpit, and the floating origin that keeps it
 *  all in single-precision range. */
export class WorldRenderer {
  readonly scene = new Scene();
  readonly stats: WorldStats = {
    terrainNodes: 0, terrainTris: 0, terrainBuilt: 0,
    buildingsNear: 0, buildingsFar: 0, cities: 0, airports: 0,
  };
  /** World position the scene is drawn relative to. */
  readonly origin = new Vector3();

  readonly terrain: TerrainRenderer;
  private cities: CityRenderer;
  private airportGroup = new Group();
  private airports = new Map<string, Group>();
  private sky: Mesh;
  readonly water: Mesh;
  private clouds: Mesh[] = [];
  private cloudGroup = new Group();
  private waterNormal = waterNormalTexture();
  private elapsed = 0;
  private sun = new DirectionalLight(0xfff2dc, 2.1);
  private hemi = new HemisphereLight(0xbcd6f0, 0x4a4436, 0.55);
  private sunDir = new Vector3(0.45, 0.62, 0.35).normalize();
  private fog: FogExp2;

  constructor(private seed: number) {
    this.terrain = new TerrainRenderer(seed);
    this.cities = new CityRenderer(seed);

    const horizon = new Color('#b9cfe2');
    this.fog = new FogExp2(horizon.getHex(), 0.0000050);
    this.scene.fog = this.fog;

    this.sky = new Mesh(
      new SphereGeometry(1, 32, 20),
      new ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide,
        depthWrite: false, depthTest: false, fog: false,
        uniforms: {
          uSun: { value: this.sunDir.clone() },
          uZenith: { value: new Color('#2f6bb4') },
          uHorizon: { value: horizon },
          uGround: { value: new Color('#7d8794') },
          uSunTint: { value: new Color('#ffc98a') },
        },
      }),
    );
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Sea level is y = 0 by definition of the terrain field, so the water is a
    // plane that follows the aeroplane.
    //
    // It is tessellated, and that is not cosmetic. A logarithmic depth buffer
    // computes depth per vertex and interpolates across the triangle, so a
    // 400 km quad with four corners interpolates depth wildly wrong and the sea
    // draws itself over mountains twenty kilometres nearer the camera.
    // Standard rather than Lambert: the sun's specular path on the sea is most
    // of what makes water read as water, and Lambert has no specular at all.
    this.waterNormal.repeat.set(900, 900);
    this.water = new Mesh(
      new PlaneGeometry(400000, 400000, 140, 140),
      new MeshStandardMaterial({
        color: new Color('#0e2c3e'),
        roughness: 0.14,
        metalness: 0.0,
        normalMap: this.waterNormal,
        normalScale: new Vector2(0.35, 0.35),
      }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.renderOrder = 0;
    this.scene.add(this.water);

    this.buildClouds();

    this.sun.position.copy(this.sunDir).multiplyScalar(1000);
    this.scene.add(this.sun, this.sun.target, this.hemi, new AmbientLight(0x8fa4b8, 0.25));
    this.scene.add(this.terrain.group, this.cities.group, this.airportGroup, this.cloudGroup);
  }

  /** Three sheets at different heights and scales. One plane looks like a
   *  painted ceiling the moment you climb toward it; three at different
   *  altitudes give parallax, something to fly between, and a top surface to
   *  come out above. */
  private buildClouds(): void {
    const layers: [number, number, number, number][] = [
      // altitude, span, texture repeat, opacity. The lowest deck sits above a
      // light single's usual cruise so you fly under it rather than inside it.
      [2100, 280000, 6, 0.52],
      [3400, 320000, 4, 0.60],
      [6800, 400000, 2.4, 0.34],
    ];
    layers.forEach(([alt, span, rep, opacity], i) => {
      // Low coverage leaves real holes; a solid sheet is an overcast lid.
      const tex = cloudTexture(512, i === 2 ? 0.26 : 0.34, 4001 + i * 137);
      tex.repeat.set(rep, rep);
      // Unlit. A Lambert sheet seen from below is lit from behind and goes
      // near-black, which reads as an overcast ceiling rather than cloud; a
      // real underside is bright grey. The tint is set from the sun instead.
      const mesh = new Mesh(
        new PlaneGeometry(span, span, 1, 1),
        new MeshBasicMaterial({
          map: tex, transparent: true, opacity, depthWrite: false,
          side: DoubleSide, fog: true,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = alt;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      mesh.userData.alt = alt;
      mesh.userData.drift = 0.0006 + i * 0.0004;
      this.clouds.push(mesh);
      this.cloudGroup.add(mesh);
    });
  }

  /** Sun elevation in radians above the horizon, and compass bearing. */
  setSun(elevation: number, bearing: number): void {
    this.sunDir.set(
      Math.cos(elevation) * Math.sin(bearing),
      Math.sin(elevation),
      -Math.cos(elevation) * Math.cos(bearing),
    ).normalize();
    (this.sky.material as ShaderMaterial).uniforms.uSun!.value.copy(this.sunDir);
    this.sun.position.copy(this.sunDir).multiplyScalar(1000);

    // Warm and dim the light as the sun gets low, and pull the sky down with it.
    const t = Math.max(0, Math.min(1, Math.sin(elevation)));
    this.sun.intensity = 0.35 + 1.85 * t;
    const horizon = new Color().setHSL(0.09 + 0.5 * t * 0.09, 0.55 - 0.25 * t, 0.30 + 0.52 * t);
    const zenith = new Color().setHSL(0.60, 0.55, 0.10 + 0.42 * t);
    const mat = this.sky.material as ShaderMaterial;
    mat.uniforms.uHorizon!.value.copy(horizon);
    mat.uniforms.uZenith!.value.copy(zenith);
    this.fog.color.copy(horizon);
    (this.water.material as MeshLambertMaterial).color.setHSL(0.556, 0.52, 0.05 + 0.11 * t);
    this.hemi.intensity = 0.15 + 0.5 * t;
  }

  /** Re-base the scene when the aeroplane has flown far enough that single
   *  precision would start to show as jitter in the terrain. */
  private rebase(aircraft: Vector3): boolean {
    const step = 2048;
    const nx = Math.round(aircraft.x / step) * step;
    const nz = Math.round(aircraft.z / step) * step;
    if (nx === this.origin.x && nz === this.origin.z) return false;
    this.origin.set(nx, 0, nz);
    this.terrain.setOrigin(this.origin);
    this.cities.setOrigin(this.origin);
    for (const [key, group] of this.airports) {
      this.airportGroup.remove(group);
      group.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); });
      this.airports.delete(key);
    }
    return true;
  }

  /** Scene-space position for a world coordinate. */
  toScene(out: Vector3, world: Vector3): Vector3 {
    return out.copy(world).sub(this.origin);
  }

  update(aircraftWorld: Vector3, budgetMs = 6, dt = 0): void {
    this.elapsed += dt;
    this.rebase(aircraftWorld);
    this.terrain.update(aircraftWorld, budgetMs);
    this.cities.update(aircraftWorld);

    const scenePos = aircraftWorld.clone().sub(this.origin);
    this.sky.position.copy(scenePos);
    this.water.position.set(scenePos.x, -this.origin.y, scenePos.z);
    this.sun.target.position.copy(scenePos);
    this.sun.position.copy(scenePos).addScaledVector(this.sunDir, 2000);

    // Cloud sheets follow the aeroplane and drift, so they never run out and
    // never sit still.
    for (const c of this.clouds) {
      c.position.set(scenePos.x, c.userData.alt as number, scenePos.z);
      const tex = (c.material as MeshBasicMaterial).map!;
      const drift = c.userData.drift as number;
      tex.offset.set(
        (aircraftWorld.x / 260000) * (tex.repeat.x / 12) + this.elapsed * drift,
        (aircraftWorld.z / 260000) * (tex.repeat.y / 12) + this.elapsed * drift * 0.4,
      );
    }
    this.waterNormal.offset.set(this.elapsed * 0.004, this.elapsed * 0.0026);

    // Airfields within sight, built once and kept until the origin moves.
    const want = new Set<string>();
    const near: Airport[] = airportsNear(aircraftWorld.x, aircraftWorld.z, this.seed, 2);
    for (const a of near) {
      if (Math.hypot(a.x - aircraftWorld.x, a.z - aircraftWorld.z) > 34000) continue;
      want.add(a.key);
      if (this.airports.has(a.key)) continue;
      const g = buildAirport(a, this.origin);
      this.airports.set(a.key, g);
      this.airportGroup.add(g);
    }
    for (const [key, group] of this.airports) {
      if (want.has(key)) continue;
      this.airportGroup.remove(group);
      group.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); });
      this.airports.delete(key);
    }

    this.stats.terrainNodes = this.terrain.stats.nodes;
    this.stats.terrainTris = this.terrain.stats.triangles;
    this.stats.terrainBuilt = this.terrain.stats.built;
    this.stats.buildingsNear = this.cities.stats.near;
    this.stats.buildingsFar = this.cities.stats.far;
    this.stats.cities = this.cities.stats.cities;
    this.stats.airports = this.airports.size;
  }

  /** Populate the near field before the first frame is shown. */
  warmUp(aircraftWorld: Vector3, maxMs = 2500): void {
    this.rebase(aircraftWorld);
    this.terrain.warmUp(aircraftWorld, maxMs);
    this.cities.update(aircraftWorld);
  }

  /** Keep the sky sphere just inside the far plane. */
  setViewDistance(far: number): void {
    this.sky.scale.setScalar(far * 0.94);
  }

  dispose(): void {
    this.terrain.dispose();
    this.cities.dispose();
  }
}
