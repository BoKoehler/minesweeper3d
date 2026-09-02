import {
  BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Group, InstancedMesh, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, Object3D, Points, PointsMaterial, Color,
  BoxGeometry, PlaneGeometry, Vector3, AdditiveBlending,
} from 'three';
import { type Airport, runwayDesignators } from '../world/places';
import { rand2i } from '../world/noise';

/** Runway markings drawn to a canvas rather than built from geometry.
 *
 *  Threshold bars, touchdown zone, aiming point, centreline and the designator
 *  numbers are all flat paint on asphalt, so paint is what they should be. One
 *  texture replaces a few hundred coplanar quads that would z-fight anyway. */
function runwayTexture(a: Airport): CanvasTexture {
  const W = 256;
  const L = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = L;
  const g = canvas.getContext('2d')!;
  const [near, far] = runwayDesignators(a);

  g.fillStyle = '#3b3d40';
  g.fillRect(0, 0, W, L);
  // Weathered patches so it does not read as a flat grey ribbon from the air.
  for (let i = 0; i < 220; i++) {
    const r = rand2i(i, 7, 991);
    g.fillStyle = `rgba(${r > 0.5 ? '90,92,95' : '46,48,51'},${0.05 + r * 0.10})`;
    g.fillRect(rand2i(i, 1, 3) * W, rand2i(i, 2, 5) * L, 8 + r * 60, 20 + r * 220);
  }
  // Rubber deposits in the touchdown zones.
  for (const zone of [0.13, 0.87]) {
    const grad = g.createLinearGradient(0, L * (zone - 0.05), 0, L * (zone + 0.05));
    grad.addColorStop(0, 'rgba(20,20,22,0)');
    grad.addColorStop(0.5, 'rgba(20,20,22,0.5)');
    grad.addColorStop(1, 'rgba(20,20,22,0)');
    g.fillStyle = grad;
    g.fillRect(0, L * (zone - 0.05), W, L * 0.1);
  }

  g.fillStyle = '#e9ecee';
  // Edge stripes.
  g.fillRect(10, 0, 7, L);
  g.fillRect(W - 17, 0, 7, L);
  // Centreline: 30 m stripe, 20 m gap, to scale against the runway length.
  const perMetre = L / a.runway.length;
  const dash = 30 * perMetre, gap = 20 * perMetre;
  for (let y = L * 0.06; y < L * 0.94; y += dash + gap) {
    g.fillRect(W / 2 - 4, y, 8, Math.min(dash, L * 0.94 - y));
  }
  // Threshold bars at both ends.
  const barLen = Math.min(L * 0.035, 46 * perMetre);
  for (const end of [0, 1]) {
    const y0 = end ? L - barLen - L * 0.012 : L * 0.012;
    for (let i = 0; i < 8; i++) {
      const x = 26 + i * ((W - 52) / 8);
      g.fillRect(x, y0, (W - 52) / 8 - 8, barLen);
    }
  }
  // Aiming point blocks and the touchdown-zone ladder.
  for (const end of [0, 1]) {
    const dir = end ? -1 : 1;
    const base = end ? L : 0;
    const at = (m: number) => base + dir * m * perMetre;
    g.fillRect(W / 2 - 46, at(300), 30, 45 * perMetre);
    g.fillRect(W / 2 + 16, at(300), 30, 45 * perMetre);
    for (const [m, pairs] of [[150, 3], [450, 2], [600, 1]] as const) {
      for (let p = 0; p < pairs; p++) {
        const off = 60 + p * 22;
        g.fillRect(W / 2 - off - 14, at(m), 12, 22 * perMetre);
        g.fillRect(W / 2 + off + 2, at(m), 12, 22 * perMetre);
      }
    }
  }

  // Designators, read from the approach end so each is upright to its own.
  g.save();
  g.font = 'bold 108px "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.translate(W / 2, L * 0.055);
  g.rotate(Math.PI);
  g.fillText(near, 0, 0);
  g.restore();
  g.save();
  g.translate(W / 2, L * 0.945);
  g.font = 'bold 108px "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(far, 0, 0);
  g.restore();

  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

const GRASS_STRIP = new Color('#6a6a4a');

/** Everything visible at one airfield: the paved surfaces, the buildings and
 *  the lights. Built once per airport and cached by the scenery manager. */
export function buildAirport(a: Airport, origin: Vector3): Group {
  const group = new Group();
  const heading = a.runway.heading;
  const L = a.runway.length, W = a.runway.width;

  const place = (obj: Object3D, u: number, v: number, y: number) => {
    // u runs along the runway, v across it.
    const s = Math.sin(heading), c = Math.cos(heading);
    obj.position.set(a.x + u * s + v * c - origin.x, a.elev + y - origin.y, a.z - u * c + v * s - origin.z);
    obj.rotation.y = -heading;
  };

  if (a.tier === 0) {
    // A grass strip: mown grass, a windsock, nothing else.
    const strip = new Mesh(new PlaneGeometry(W, L), new MeshLambertMaterial({ color: GRASS_STRIP }));
    strip.rotation.x = -Math.PI / 2;
    const holder = new Group();
    holder.add(strip);
    place(holder, 0, 0, 0.10);
    group.add(holder);
  } else {
    const tex = runwayTexture(a);
    const surface = new Mesh(new PlaneGeometry(W, L), new MeshLambertMaterial({ map: tex }));
    surface.rotation.x = -Math.PI / 2;
    const holder = new Group();
    holder.add(surface);
    place(holder, 0, 0, 0.12);
    group.add(holder);

    // Taxiway down one side, and an apron with a terminal on it.
    const taxi = new MeshLambertMaterial({ color: 0x4a4c50 });
    const side = a.apronSide;
    const twy = new Mesh(new BoxGeometry(14, 0.2, L * 0.82), taxi);
    place(twy, 0, side * (W / 2 + 60), 0.1);
    group.add(twy);
    for (const u of [-L * 0.42, 0, L * 0.42]) {
      const link = new Mesh(new BoxGeometry(W + 120, 0.2, 16), taxi);
      place(link, u, side * 30, 0.1);
      group.add(link);
    }
    const apronW = a.tier === 2 ? 320 : 170;
    const apron = new Mesh(new BoxGeometry(apronW, 0.2, a.tier === 2 ? 260 : 140), taxi);
    place(apron, -L * 0.1, side * (W / 2 + 60 + apronW / 2), 0.11);
    group.add(apron);

    const termH = a.tier === 2 ? 22 : 11;
    const terminal = new Mesh(
      new BoxGeometry(a.tier === 2 ? 210 : 96, termH, a.tier === 2 ? 62 : 28),
      new MeshLambertMaterial({ color: 0xbfc4c8 }),
    );
    place(terminal, -L * 0.1, side * (W / 2 + 60 + apronW + 40), termH / 2);
    group.add(terminal);

    const hangar = new MeshLambertMaterial({ color: 0x8e969c });
    for (let i = 0; i < (a.tier === 2 ? 4 : 2); i++) {
      const h = new Mesh(new BoxGeometry(52, 14, 40), hangar);
      place(h, L * 0.16 + i * 62, side * (W / 2 + 130), 7);
      group.add(h);
    }
  }

  // Runway lights. Edge lights white, threshold green on the approach side and
  // red on the stop side, exactly as a real field is lit.
  const pts: number[] = [];
  const cols: number[] = [];
  const push = (u: number, v: number, y: number, r: number, g2: number, b: number) => {
    const s = Math.sin(heading), c = Math.cos(heading);
    pts.push(a.x + u * s + v * c - origin.x, a.elev + y - origin.y, a.z - u * c + v * s - origin.z);
    cols.push(r, g2, b);
  };
  const spacing = a.tier === 0 ? 90 : 60;
  for (let u = -L / 2; u <= L / 2; u += spacing) {
    push(u, -W / 2 - 2, 0.5, 1, 0.95, 0.8);
    push(u, W / 2 + 2, 0.5, 1, 0.95, 0.8);
  }
  for (let i = -3; i <= 3; i++) {
    push(-L / 2, (i * W) / 7, 0.5, 0.15, 1, 0.3);
    push(L / 2, (i * W) / 7, 0.5, 1, 0.15, 0.15);
  }
  if (a.tier > 0) {
    // Approach lead-in and a PAPI beside the touchdown zone.
    for (let d = 60; d <= 600; d += 60) {
      push(-L / 2 - d, 0, 0.6, 1, 1, 0.95);
      push(L / 2 + d, 0, 0.6, 1, 1, 0.95);
    }
    for (let i = 0; i < 4; i++) {
      push(-L / 2 + 300, -W / 2 - 18 - i * 9, 0.7, 1, 0.3, 0.2);
      push(L / 2 - 300, W / 2 + 18 + i * 9, 0.7, 1, 0.3, 0.2);
    }
  }

  const lightGeo = new BufferGeometry();
  lightGeo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  lightGeo.setAttribute('color', new BufferAttribute(new Float32Array(cols), 3));
  const lights = new Points(lightGeo, new PointsMaterial({
    size: 9, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95,
    blending: AdditiveBlending, depthWrite: false,
  }));
  lights.frustumCulled = false;
  lights.renderOrder = 3;
  group.add(lights);

  // A windsock, which is the only instrument a grass strip gives you.
  const pole = new Mesh(new BoxGeometry(0.4, 7, 0.4), new MeshBasicMaterial({ color: 0xdddddd }));
  place(pole, 0, -W / 2 - 26, 3.5);
  group.add(pole);
  const sock = new Mesh(new BoxGeometry(1.6, 1.6, 5), new MeshBasicMaterial({ color: 0xff6a22, side: DoubleSide }));
  place(sock, 0, -W / 2 - 26, 6.6);
  group.add(sock);

  group.matrixAutoUpdate = false;
  group.updateMatrix();
  return group;
}

/** A single instanced mesh of every hangar-sized object is not worth it, but
 *  approach lighting benefits from being one object; exported for the tests. */
export const AIRPORT_LIGHT_MATERIAL = PointsMaterial;
export { InstancedMesh };
