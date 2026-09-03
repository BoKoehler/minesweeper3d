import {
  AmbientLight, BoxGeometry, CanvasTexture, Color, DirectionalLight, Group, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3,
  Quaternion, DoubleSide, RepeatWrapping, SRGBColorSpace,
} from 'three';
import { rand2i } from '../world/noise';
import { PANEL_W, PANEL_H, drawPanel, type PanelInput } from './instruments';
import type { AircraftConfig } from '../sim/aircraft';
import type { Controls } from '../sim/dynamics';

/** Moulded vinyl grain. Interior plastics are the one surface a player stares
 *  at for an entire flight, and an untextured matte box is what makes a cockpit
 *  look like a placeholder. */
function grainTexture(size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#8a8a8a';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 5200; i++) {
    const x = rand2i(i, 1, 31) * size, y = rand2i(i, 2, 37) * size;
    const v = rand2i(i, 3, 41);
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.05 + v * 0.07})` : `rgba(0,0,0,${0.05 + v * 0.09})`;
    g.fillRect(x, y, 1 + v * 1.6, 1 + v * 1.6);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(5, 5);
  return tex;
}

const GRAIN = grainTexture();
// Standard, not Lambert: interior surfaces need a specular roll-off to read as
// mouldings. Lambert gives every panel the same dead matte value.
const SHELL = new MeshStandardMaterial({ color: new Color('#33383d'), roughness: 0.86, metalness: 0.04, map: GRAIN });
const TRIM = new MeshStandardMaterial({ color: new Color('#1e2226'), roughness: 0.78, metalness: 0.06, map: GRAIN });
const METAL = new MeshStandardMaterial({ color: new Color('#6a7178'), roughness: 0.38, metalness: 0.65 });

/** The cockpit is drawn in its own pass with its own camera.
 *
 *  The world needs a 200 km far plane; a shared depth buffer at that range has
 *  nothing left for objects half a metre from the eye, and the panel z-fights
 *  itself. Two passes give the interior its own near/far and let the head look
 *  around inside a shell that stays put while the aeroplane moves under it. */
export class Cockpit {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private yoke = new Group();
  private throttleLever = new Group();
  private shell = new Group();
  private lastDraw = -1;
  /** Pilot sits left of the cabin centreline; the shell shifts, not the panel. */
  private readonly shellOffset = 0.235;

  constructor(private config: AircraftConfig) {
    this.camera = new PerspectiveCamera(70, 1, 0.02, 40);

    this.canvas = document.createElement('canvas');
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;

    // Skylight through the windscreen from ahead and above, a dim bounce from
    // the panel below, and a cool fill from the side windows.
    this.scene.add(new AmbientLight(0xc4d2e0, 0.34));
    const sky = new DirectionalLight(0xf2f7ff, 1.05);
    sky.position.set(0.25, 1, -0.9);
    this.scene.add(sky);
    const bounce = new DirectionalLight(0x8fa2b4, 0.30);
    bounce.position.set(-0.6, -1, 0.3);
    this.scene.add(bounce);
    this.scene.add(this.shell);
    this.build();
    // Sit in the left seat. The six primary instruments are on the pilot's
    // side of a real panel, so the shell moves right rather than the panel
    // being re-arranged into something no aeroplane looks like.
    this.shell.position.x = this.shellOffset;
  }

  private build(): void {
    // Sized from the eye: the panel fills the lower third of the view and its
    // top edge sits just under the glareshield, the way it does when you are
    // actually sitting in one. Too small and it reads as a picture on a wall.
    const jet = this.config.engine.kind === 'jet';
    const panelW = jet ? 1.60 : 1.48;
    const panelH = panelW / (PANEL_W / PANEL_H);
    const panelZ = jet ? -0.76 : -0.68;
    // Panel top sits about 15 degrees below the sightline, which is where it
    // is in a real cockpit. Any higher and the aeroplane has no forward view;
    // any lower and the instruments fall out of the bottom of the screen.
    const panelY = -0.300;

    const panel = new Mesh(
      new PlaneGeometry(panelW, panelH),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    panel.position.set(0, panelY, panelZ);
    panel.rotation.x = 0.26;
    this.shell.add(panel);

    // Panel surround, glareshield and coaming.
    // The moulding runs the full width of the cabin, not just around the
    // instruments. Stopping it at the panel edge leaves a band of open scenery
    // between the panel and the side wall, right where the pilot's knee is.
    const surround = new Mesh(new BoxGeometry(panelW + 1.20, panelH + 0.10, 0.10), TRIM);
    surround.position.set(-this.shellOffset, panelY, panelZ - 0.06);
    surround.rotation.x = 0.26;
    this.shell.add(surround);

    // Thin, and set back: a deep glareshield eats the view over the nose,
    // which on final approach is the only view that matters.
    const glare = new Mesh(new BoxGeometry(panelW + 1.20, 0.030, 0.20), SHELL);
    glare.position.set(-this.shellOffset, panelY + panelH * 0.5 + 0.040, panelZ + 0.13);
    glare.rotation.x = -0.12;
    this.shell.add(glare);

    // Lower console and side walls, so the eye is inside a box rather than
    // floating behind a floating rectangle.
    // Kick panel below the instruments. Without it you can see the runway
    // through the footwell, and the panel reads as a screen floating in space
    // rather than the front of a cabin you are sitting in.
    // Wide enough to meet the side walls: a gap here shows the runway through
    // the footwell as a bright wedge at the corner of the screen.
    const kick = new Mesh(new BoxGeometry(panelW + 1.15, 0.86, 0.12), TRIM);
    kick.position.set(-this.shellOffset, panelY - panelH * 0.5 - 0.40, panelZ + 0.06);
    this.shell.add(kick);

    const console_ = new Mesh(new BoxGeometry(panelW * 0.40, 0.44, 0.46), TRIM);
    console_.position.set(0, panelY - panelH * 0.5 - 0.24, panelZ + 0.36);
    this.shell.add(console_);

    // Structure is pushed out to the edges of vision. A windscreen you are
    // peering through is a cockpit; one you are peering out of is a letterbox.
    for (const s of [-1, 1]) {
      const wall = new Mesh(new BoxGeometry(0.12, 1.3, 1.6), SHELL);
      wall.position.set(-this.shellOffset + s * (panelW / 2 + 0.42), -0.20, 0.10);
      this.shell.add(wall);

      const pillar = new Mesh(new BoxGeometry(0.055, 1.00, 0.07), SHELL);
      pillar.position.set(s * (panelW / 2 + 0.11), 0.26, panelZ + 0.10);
      pillar.rotation.z = s * 0.19;
      pillar.rotation.x = -0.22;
      this.shell.add(pillar);
    }

    const post = new Mesh(new BoxGeometry(0.032, 0.66, 0.05), SHELL);
    post.position.set(0, 0.30, panelZ + 0.06);
    post.rotation.x = -0.24;
    this.shell.add(post);

    const roof = new Mesh(new BoxGeometry(panelW + 0.90, 0.10, 1.1), SHELL);
    roof.position.set(-this.shellOffset, 0.80, 0.10);
    this.shell.add(roof);

    // Windscreen glass: a faint tint that darkens toward the top, plus the
    // green cast of laminated glass. Nearly invisible, and its absence is why
    // an open frame reads as a hole rather than a window.
    const glass = new Mesh(
      new PlaneGeometry(panelW + 0.62, 1.15),
      new MeshBasicMaterial({
        color: new Color('#9fc3c8'), transparent: true, opacity: 0.055,
        depthWrite: false, side: DoubleSide,
      }),
    );
    glass.position.set(-this.shellOffset, 0.16, panelZ - 0.02);
    glass.rotation.x = -0.22;
    glass.renderOrder = 8;
    this.shell.add(glass);

    const floor = new Mesh(new BoxGeometry(panelW + 0.90, 0.08, 1.8), TRIM);
    floor.position.set(-this.shellOffset, -1.05, -0.05);
    this.shell.add(floor);

    // Control column: moves with the stick, which is most of what sells a
    // cockpit as a place you are sitting in rather than a picture of one.
    const column = new Mesh(new BoxGeometry(0.045, 0.045, 0.34), METAL);
    column.position.set(0, -0.06, 0.17);
    column.rotation.x = Math.PI / 2 - 0.35;
    this.yoke.add(column);
    const bar = new Mesh(new BoxGeometry(0.34, 0.035, 0.035), TRIM);
    bar.position.set(0, 0.055, 0.06);
    this.yoke.add(bar);
    for (const s of [-1, 1]) {
      const horn = new Mesh(new BoxGeometry(0.035, 0.12, 0.035), TRIM);
      horn.position.set(s * 0.17, 0.01, 0.06);
      this.yoke.add(horn);
    }
    this.yoke.position.set(0, panelY - 0.10, panelZ + 0.46);
    this.shell.add(this.yoke);

    // Throttle quadrant on the console.
    const quadrant = new Mesh(new BoxGeometry(0.16, 0.05, 0.24), METAL);
    quadrant.position.set(jet ? 0.26 : 0.21, panelY - 0.24, panelZ + 0.40);
    this.shell.add(quadrant);
    const lever = new Mesh(new BoxGeometry(0.032, 0.15, 0.032), new MeshStandardMaterial({ color: new Color('#1b1d20'), roughness: 0.6, metalness: 0.2 }));
    lever.position.set(0, 0.08, 0);
    this.throttleLever.add(lever);
    const knob = new Mesh(new BoxGeometry(0.06, 0.045, 0.05), new MeshStandardMaterial({ color: new Color('#c8c2b4'), roughness: 0.45, metalness: 0.15 }));
    knob.position.set(0, 0.15, 0);
    this.throttleLever.add(knob);
    this.throttleLever.position.copy(quadrant.position);
    this.shell.add(this.throttleLever);
  }

  /** Panel redraw is throttled: 20 Hz is past the point where a needle looks
   *  anything but smooth, and it halves the texture upload cost. */
  update(input: PanelInput, controls: Controls, headYaw: number, headPitch: number, dt: number): void {
    this.lastDraw += dt;
    if (this.lastDraw > 1 / 20) {
      this.lastDraw = 0;
      drawPanel(this.ctx, input);
      this.texture.needsUpdate = true;
    }

    this.yoke.rotation.x = -controls.pitch * 0.16;
    this.yoke.rotation.z = -controls.roll * 0.42;
    this.yoke.position.z = (this.config.engine.kind === 'jet' ? -0.76 : -0.68) + 0.46 - controls.pitch * 0.05;
    this.throttleLever.rotation.x = -0.5 + controls.throttle * 0.9;

    const q = new Quaternion();
    q.setFromAxisAngle(new Vector3(0, 1, 0), headYaw);
    const p = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), headPitch);
    this.camera.quaternion.copy(q.multiply(p));
    this.camera.position.set(0, 0, 0);
  }

  setVisible(v: boolean): void { this.shell.visible = v; }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.texture.dispose();
    this.shell.traverse((o) => { const m = o as Mesh; if (m.geometry) m.geometry.dispose(); });
  }
}
