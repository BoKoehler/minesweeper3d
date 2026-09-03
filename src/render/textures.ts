import { CanvasTexture, RepeatWrapping, DataTexture, RGBAFormat, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { fbm, ridged, rand2i } from '../world/noise';

/** Procedural textures, generated once at start-up. Nothing is loaded from
 *  disk: the whole simulator is still a single script with no assets. */

/** Cumulus-ish cloud sheet. Two thresholds of fBm — a soft body and a harder
 *  core — give the puffy edge a single threshold never produces. */
export function cloudTexture(size = 512, coverage = 0.46, seed = 4001): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sample on a torus so the sheet tiles without a visible seam.
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      const nx = Math.cos(u) * 1.6, ny = Math.sin(u) * 1.6;
      const nz = Math.cos(v) * 1.6, nw = Math.sin(v) * 1.6;
      const a = fbm(nx + nz * 0.7, ny + nw * 0.7, 5, seed);
      const b = fbm(nz * 1.9 - ny * 0.4, nw * 1.9 + nx * 0.4, 4, seed + 91);
      const d = (a * 0.65 + b * 0.35) * 0.5 + 0.5;
      const body = Math.max(0, d - (1 - coverage)) / Math.max(1e-3, coverage);
      const core = Math.pow(Math.max(0, body - 0.28) / 0.72, 0.8);
      const alpha = Math.min(1, body * 0.85 + core * 0.7);
      const i = (y * size + x) * 4;
      const lit = 236 + core * 19;
      img.data[i] = lit;
      img.data[i + 1] = lit;
      img.data[i + 2] = Math.min(255, lit + 6);
      img.data[i + 3] = Math.round(alpha * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Ripple normal map for the sea. Small amplitude on purpose — the point is to
 *  break the sun's specular into a glitter path, not to build waves. */
export function waterNormalTexture(size = 256, seed = 5501): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const h = (x: number, y: number): number => {
    const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
    return ridged(Math.cos(u) * 3.2 + Math.cos(v) * 0.6, Math.sin(u) * 3.2 + Math.sin(v) * 0.6, 3, seed)
      + fbm(Math.cos(v) * 5.1, Math.sin(v) * 5.1, 3, seed + 17) * 0.4;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = 1.6;
      const dx = (h((x + 1) % size, y) - h((x - 1 + size) % size, y)) * s;
      const dy = (h(x, (y + 1) % size) - h(x, (y - 1 + size) % size)) * s;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Street plan for a town, drawn under the buildings.
 *
 *  From two thousand feet the thing that says "town" is not the buildings, it
 *  is the grid they sit in: roads, blocks, a green space, an edge that frays
 *  into fields. Painting that on the ground does more for the read than any
 *  number of extra boxes. */
export function townTexture(seed: number, population: number, size = 512): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const big = population > 40000;

  g.clearRect(0, 0, size, size);
  // Built ground, darker toward the middle where the blocks are dense.
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, 'rgba(96,92,86,0.95)');
  grad.addColorStop(0.55, 'rgba(104,100,92,0.85)');
  grad.addColorStop(0.85, 'rgba(112,110,96,0.45)');
  grad.addColorStop(1, 'rgba(120,118,100,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(size / 2, size / 2, size * 0.5, 0, Math.PI * 2);
  g.fill();

  // Block grid, rotated so towns are not all axis-aligned.
  g.save();
  g.translate(size / 2, size / 2);
  g.rotate(rand2i(1, 2, seed) * Math.PI);
  const cells = big ? 16 : 9;
  const step = size / cells;
  g.strokeStyle = 'rgba(58,56,54,0.85)';
  for (let i = -cells; i <= cells; i++) {
    const jitter = (rand2i(i, 7, seed) - 0.5) * step * 0.35;
    g.lineWidth = i % 4 === 0 ? 4.5 : 2.2;
    g.beginPath();
    g.moveTo(i * step + jitter, -size);
    g.lineTo(i * step + jitter, size);
    g.stroke();
    const j2 = (rand2i(i, 11, seed) - 0.5) * step * 0.35;
    g.beginPath();
    g.moveTo(-size, i * step + j2);
    g.lineTo(size, i * step + j2);
    g.stroke();
  }
  // A park or two, and a square in the middle of the bigger places.
  g.fillStyle = 'rgba(64,92,52,0.9)';
  for (let k = 0; k < (big ? 3 : 1); k++) {
    const px = (rand2i(k, 21, seed) - 0.5) * size * 0.6;
    const pz = (rand2i(k, 22, seed) - 0.5) * size * 0.6;
    const w = step * (1 + rand2i(k, 23, seed) * 1.6);
    g.fillRect(px, pz, w, w * (0.7 + rand2i(k, 24, seed) * 0.8));
  }
  g.restore();

  // Fray the rim so the town does not end on a perfect circle.
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(size / 2, size / 2, size * 0.22, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.8, 'rgba(0,0,0,0.85)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Window grid for building sides. One texture, tinted per instance. */
export function facadeTexture(size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  const cols = 8, rows = 8;
  const w = size / cols, h = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = rand2i(c, r, 77);
      g.fillStyle = `rgba(28,32,38,${0.35 + v * 0.4})`;
      g.fillRect(c * w + w * 0.22, r * h + h * 0.24, w * 0.56, h * 0.46);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Fine ground grain, tiled over the terrain at a few tens of metres.
 *
 *  Vertex colours vary at the resolution of the mesh, which near the ground is
 *  metres per vertex at best and hundreds at altitude. Without a tiling detail
 *  map the ground under the wheels is a smooth gradient, and smooth gradients
 *  are what "shoddy" looks like on approach. */
export function groundDetailTexture(size = 256, seed = 7717): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
      const a = fbm(Math.cos(u) * 2.4, Math.sin(u) * 2.4 + Math.cos(v) * 2.4, 4, seed);
      const b = fbm(Math.sin(v) * 6.1 + Math.cos(u) * 1.2, Math.cos(v) * 6.1, 3, seed + 53);
      // Centred near white. A colour map multiplies the vertex colour, and
      // sRGB 128 is linear 0.22 — a mid-grey detail map does not add grain, it
      // cuts the whole terrain to a fifth of its brightness.
      const t = (a * 0.62 + b * 0.38) * 0.5 + 0.5;
      const c = Math.round(232 + t * 23);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}
