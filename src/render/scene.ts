import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COVERED, FLAGGED, REVEALED, EXTRACTED } from '../core/grid';
import { isExposed } from '../core/board';
import type { Game } from '../game/game';
import { DigitField } from './digits';
import { pickCell, centreOffset, type Ray } from './pick';

const ROCK_NEAR = new THREE.Color('#9aa7ac');
const ROCK_DEEP = new THREE.Color('#6b4f3a');
const ORE = new THREE.Color('#ee7238');
const CORE = new THREE.Color('#f0c249');
const SONAR = new THREE.Color('#54c1d3');

export interface SonarLabel { x: number; y: number; text: string; visible: boolean }

/** Everything WebGL. Reads game state and rebuilds its instance buffers on
 *  change; it never mutates the board itself. */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  peel = 0;
  xray = false;
  hovered = -1;
  sonarPreview: { cell: number; axis: 0 | 1 | 2 } | null = null;

  private game: Game;
  private covered!: THREE.InstancedMesh;
  private flags!: THREE.InstancedMesh;
  private coreMesh!: THREE.InstancedMesh;
  private coreGlow!: THREE.InstancedMesh;
  private digits!: DigitField;
  private group = new THREE.Group();
  private hover = new THREE.Group();
  private beams = new THREE.Group();
  private shockwaves: { mesh: THREE.Mesh; t: number; life: number }[] = [];
  private dirty = true;
  private shake = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly beamGeo = new THREE.BoxGeometry(1, 1, 1);
  private key!: THREE.DirectionalLight;
  private corePositions: THREE.Vector3[] = [];

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x080d11, 1);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.enablePan = false;

    this.scene.add(this.group, this.hover, this.beams);
    this.scene.fog = new THREE.Fog(0x080d11, 40, 160);
    this.addLights();
    this.addStars();
    this.buildHover();
    this.setGame(game);
  }

  private addLights(): void {
    this.scene.add(new THREE.AmbientLight(0x707a80, 0.42));
    this.scene.add(new THREE.HemisphereLight(0xa8bcc6, 0x35291f, 0.5));

    // The key rides the camera. A fixed sun looks right until the player
    // orbits, or until a run opens on the far side of the rock and the whole
    // board arrives in shadow — which is exactly what a random entry does.
    this.key = new THREE.DirectionalLight(0xfff1dc, 2.0);
    this.camera.add(this.key);
    this.scene.add(this.camera);

    // One fixed cool rim, so the rock still has a consistent "down" and does
    // not read as a flat sticker when the camera swings.
    const rim = new THREE.DirectionalLight(0x5b93b5, 0.7);
    rim.position.set(-1, -0.7, -0.9);
    this.scene.add(rim);
  }

  private addStars(): void {
    const n = 1200;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(180 + Math.random() * 120);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fa6b4, size: 0.9, sizeAttenuation: false, transparent: true, opacity: 0.65, fog: false }));
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  private buildHover(): void {
    const edges = (s: number, colour: number, w = 1) => {
      const box = new THREE.BoxGeometry(s, s, s);
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(box),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: w, fog: false, depthTest: false }),
      );
      box.dispose();
      return line;
    };
    // The picked cell, plus the six cells its number would talk about. Showing
    // the cross is how the game teaches its one deduction shape.
    const main = edges(1.06, 0xffffff, 0.9);
    main.name = 'main';
    this.hover.add(main);
    for (let f = 0; f < 6; f++) {
      const n = edges(0.42, 0x54c1d3, 0.55);
      n.name = `n${f}`;
      this.hover.add(n);
    }
    this.hover.renderOrder = 6;
    this.hover.visible = false;
  }

  setGame(game: Game): void {
    this.game = game;
    this.group.clear();
    const b = game.board;
    const cap = b.hullCells.length;

    const boxGeo = new THREE.BoxGeometry(0.94, 0.94, 0.94);
    const smallGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const coreGeo = new THREE.OctahedronGeometry(0.42, 0);

    this.covered = new THREE.InstancedMesh(boxGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.06, flatShading: true }), cap);
    this.flags = new THREE.InstancedMesh(smallGeo,
      new THREE.MeshStandardMaterial({ color: ORE, emissive: ORE, emissiveIntensity: 0.5, roughness: 0.5 }), cap);
    this.coreMesh = new THREE.InstancedMesh(coreGeo,
      new THREE.MeshBasicMaterial({ color: CORE, transparent: true, opacity: 0.98, depthTest: false, fog: false }), 16);
    this.coreGlow = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.95, 0),
      new THREE.MeshBasicMaterial({ color: CORE, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }), 16);
    this.coreGlow.frustumCulled = false;
    this.coreGlow.renderOrder = 5;

    this.covered.frustumCulled = false;
    this.flags.frustumCulled = false;
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 5;

    this.digits = new DigitField(cap);
    this.group.add(this.covered, this.flags, this.coreGlow, this.coreMesh, this.digits.mesh);

    const r = b.grid.n;
    this.controls.minDistance = r * 0.75;
    this.controls.maxDistance = r * 4.5;
    // Open on the entry crater. The rock is a sphere, so a fixed start angle
    // leaves the player staring at unbroken rock with their own dig behind it.
    const eye = new THREE.Vector3();
    this.worldOf(b.entry, eye);
    if (eye.lengthSq() < 1e-4) eye.set(1, 0.6, 1);
    eye.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(eye, up);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    eye.multiplyScalar(0.88).addScaledVector(side, 0.30).addScaledVector(up, 0.26);
    this.camera.position.copy(eye.normalize().multiplyScalar(r * 2.0));
    this.key.position.set(r * 1.1, r * 1.5, r * 0.35);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.peel = 0;
    this.beams.clear();
    this.markDirty();
  }

  markDirty(): void { this.dirty = true; }

  private worldOf(i: number, v: THREE.Vector3): THREE.Vector3 {
    const g = this.game.board.grid;
    const c = centreOffset(g.n);
    return v.set(g.x(i) - c, g.y(i) - c, g.z(i) - c);
  }

  /** Rebuild every instance buffer from board state. Cheap enough to do on
   *  each change: a few thousand matrix writes is well under a frame. */
  private rebuild(): void {
    const b = this.game.board;
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const col = new THREE.Color();
    const maxDepth = Math.max(1, b.grid.n / 3.2);

    let nc = 0, nf = 0, ncore = 0;
    this.digits.begin();

    for (const i of b.hullCells) {
      const st = b.state[i]!;
      const depth = b.depth[i]!;
      if (depth < this.peel) continue;
      this.worldOf(i, v);

      if (st <= FLAGGED) {
        // With no peel, interior rock is fully hidden by its own neighbours,
        // so only the exposed skin is worth drawing.
        if (this.peel === 0 && !isExposed(b, i)) continue;
        m.makeTranslation(v.x, v.y, v.z);
        this.covered.setMatrixAt(nc, m);
        col.copy(ROCK_NEAR).lerp(ROCK_DEEP, Math.min(1, depth / maxDepth));
        // Stable per-cell jitter in value and warmth. Uniform grey reads as
        // untextured plastic; a little grain reads as matrix.
        const h = Math.sin(i * 12.9898) * 43758.5453;
        const j = (h - Math.floor(h)) - 0.5;
        col.offsetHSL(j * 0.035, j * 0.09, j * 0.085);
        this.covered.setColorAt(nc, col);
        nc++;
        if (st === FLAGGED) {
          this.flags.setMatrixAt(nf++, m);
        }
      } else if (st === REVEALED || st === EXTRACTED) {
        // Draw the boundary of the void, not its volume. A revealed cell with
        // no solid neighbour sits deep inside cleared space where it adds
        // transparent overdraw and nothing a player can read.
        // A number whose neighbours are all settled is a satisfied
        // constraint: noise, and in a volume noise is fatal.
        const count = b.count[i]!;
        if (count > 0 && this.hasUnknownNeighbour(i)) this.digits.add(v.x, v.y, v.z, count);
      }
    }

    this.corePositions.length = 0;
    for (const c of b.cores) {
      if (b.state[c] !== COVERED && b.state[c] !== FLAGGED) continue;
      this.worldOf(c, v);
      this.corePositions.push(v.clone());
      m.makeTranslation(v.x, v.y, v.z);
      this.coreMesh.setMatrixAt(ncore++, m);
    }

    this.covered.count = nc;
    this.flags.count = nf;
    this.coreMesh.count = ncore;
    this.coreGlow.count = ncore;
    this.covered.instanceMatrix.needsUpdate = true;
    this.flags.instanceMatrix.needsUpdate = true;
    this.coreMesh.instanceMatrix.needsUpdate = true;
    this.coreGlow.instanceMatrix.needsUpdate = true;
    if (this.covered.instanceColor) this.covered.instanceColor.needsUpdate = true;
    this.digits.end();

    const mat = this.covered.material as THREE.MeshStandardMaterial;
    mat.transparent = this.xray;
    mat.opacity = this.xray ? 0.22 : 1;
    mat.depthWrite = !this.xray;
    mat.needsUpdate = true;

    this.rebuildBeams();
    this.dirty = false;
  }

  private hasUnknownNeighbour(i: number): boolean {
    const b = this.game.board;
    for (let f = 0; f < 6; f++) {
      const j = b.grid.neighbour[i * 6 + f]!;
      if (j >= 0 && b.hull[j] === 1 && b.state[j]! <= FLAGGED) return true;
    }
    return false;
  }

  private rebuildBeams(): void {
    this.beams.clear();
    const b = this.game.board;
    const n = b.grid.n;
    const c = centreOffset(n);
    const draw = (cell: number, axis: 0 | 1 | 2, opacity: number) => {
      const g = b.grid;
      const p = new THREE.Vector3(g.x(cell) - c, g.y(cell) - c, g.z(cell) - c);
      const mesh = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({
        color: SONAR, transparent: true, opacity, depthWrite: false, fog: false,
      }));
      const len = n + 2;
      mesh.scale.set(axis === 0 ? len : 0.09, axis === 1 ? len : 0.09, axis === 2 ? len : 0.09);
      mesh.position.copy(p);
      if (axis === 0) mesh.position.x = 0;
      if (axis === 1) mesh.position.y = 0;
      if (axis === 2) mesh.position.z = 0;
      mesh.renderOrder = 3;
      this.beams.add(mesh);
    };
    for (const s of this.game.sonar) draw(s.cell, s.axis, 0.5);
    if (this.sonarPreview) draw(this.sonarPreview.cell, this.sonarPreview.axis, 0.22);
  }

  /** Screen-space anchors for the sonar readouts, which are DOM so that
   *  multi-digit values stay crisp at any zoom. */
  sonarLabels(): SonarLabel[] {
    const b = this.game.board;
    const g = b.grid;
    const c = centreOffset(g.n);
    const v = new THREE.Vector3();
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return this.game.sonar.map((s) => {
      const along = new THREE.Vector3(s.axis === 0 ? 1 : 0, s.axis === 1 ? 1 : 0, s.axis === 2 ? 1 : 0);
      v.set(g.x(s.cell) - c, g.y(s.cell) - c, g.z(s.cell) - c);
      if (s.axis === 0) v.x = 0; if (s.axis === 1) v.y = 0; if (s.axis === 2) v.z = 0;
      // Push the label to whichever end of the beam is nearer the camera.
      const dot = along.dot(this.camera.position.clone().sub(v));
      v.addScaledVector(along, (dot > 0 ? 1 : -1) * (g.n / 2 + 1.4));
      const p = v.clone().project(this.camera);
      return {
        x: (p.x * 0.5 + 0.5) * w,
        y: (-p.y * 0.5 + 0.5) * h,
        text: String(this.sonarReading(s)),
        visible: p.z < 1,
      };
    });
  }

  private sonarReading(s: { cell: number; axis: 0 | 1 | 2 }): number {
    const b = this.game.board;
    const g = b.grid;
    const x = g.x(s.cell), y = g.y(s.cell), z = g.z(s.cell);
    let total = 0;
    for (let t = 0; t < g.n; t++) {
      const i = s.axis === 0 ? g.idx(t, y, z) : s.axis === 1 ? g.idx(x, t, z) : g.idx(x, y, t);
      if (b.hull[i] === 1 && b.mine[i] === 1) total++;
    }
    return total;
  }

  /** The axis the camera is most nearly sighting down. Sonar always fires
   *  along it, which is what makes axis-snap a real control rather than a
   *  convenience. */
  cameraAxis(): 0 | 1 | 2 {
    const d = this.camera.getWorldDirection(new THREE.Vector3());
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  }

  snapToAxis(axis: 0 | 1 | 2): void {
    const dist = this.camera.position.length();
    const p = new THREE.Vector3(axis === 0 ? dist : 0, axis === 1 ? dist : 0, axis === 2 ? dist : 0);
    // Nudge off the pole so the orbit control keeps a stable up vector.
    if (axis === 1) p.z = dist * 0.02;
    this.camera.position.copy(p);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  cellAt(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const ray: Ray = { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
    return pickCell(this.game.board, ray);
  }

  setHover(i: number): void {
    if (i === this.hovered) return;
    this.hovered = i;
    if (i < 0) { this.hover.visible = false; return; }
    const b = this.game.board;
    const v = new THREE.Vector3();
    this.worldOf(i, v);
    this.hover.position.copy(v);
    this.hover.visible = true;
    for (let f = 0; f < 6; f++) {
      const child = this.hover.getObjectByName(`n${f}`)!;
      const j = b.grid.neighbour[i * 6 + f]!;
      const inside = j >= 0 && b.hull[j] === 1;
      child.visible = inside;
      if (inside) {
        const w = new THREE.Vector3();
        this.worldOf(j, w);
        child.position.copy(w.sub(v));
      }
    }
  }

  /** An expanding shell at a detonation. Bounded, brief, and it reads at any
   *  camera angle, which a particle burst inside a solid does not. */
  addShockwave(cell: number): void {
    const v = new THREE.Vector3();
    this.worldOf(cell, v);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: ORE, transparent: true, opacity: 0.7, wireframe: true, depthWrite: false, fog: false }),
    );
    mesh.position.copy(v);
    mesh.renderOrder = 7;
    this.scene.add(mesh);
    this.shockwaves.push({ mesh, t: 0, life: 0.55 });
    this.shake = Math.min(1, this.shake + 0.8);
  }

  resize(): void {
    const el = this.renderer.domElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(dt: number): void {
    if (this.dirty) this.rebuild();
    this.controls.update();

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i]!;
      s.t += dt;
      const k = s.t / s.life;
      if (k >= 1) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
        this.shockwaves.splice(i, 1);
        continue;
      }
      s.mesh.scale.setScalar(0.4 + k * 4.2);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
    }

    if (this.shake > 0.001) {
      this.shake *= Math.pow(0.02, dt);
      const a = this.shake * 0.28;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
    }

    const t = performance.now() * 0.001;
    if (this.corePositions.length) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(t * 0.5) * 0.35, t * 0.7, 0));
      const scale = new THREE.Vector3().setScalar(1 + Math.sin(t * 2.2) * 0.06);
      const m = new THREE.Matrix4();
      const pulse = new THREE.Vector3().setScalar(1 + Math.sin(t * 1.7) * 0.13);
      this.corePositions.forEach((p, i) => {
        this.coreMesh.setMatrixAt(i, m.compose(p, q, scale));
        this.coreGlow.setMatrixAt(i, m.compose(p, q, pulse));
      });
      this.coreMesh.instanceMatrix.needsUpdate = true;
      this.coreGlow.instanceMatrix.needsUpdate = true;
    this.coreGlow.instanceMatrix.needsUpdate = true;
    }
    this.digits.size = 0.78;

    this.renderer.render(this.scene, this.camera);
  }
}
