import {
  BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial, Vector3, FrontSide,
} from 'three';
import { elevation } from '../world/ground';
import { surfaceColor, slopeAt } from '../world/terrain';

/** Cells across one node. Every node has the same vertex count regardless of
 *  how much ground it covers — that is the whole point of a quadtree LOD. */
const N = 22;
const VERTS = (N + 1) * (N + 1);
/** A node splits when the camera is closer than this many node-widths. */
const SPLIT = 1.35;

export interface TerrainStats { nodes: number; built: number; triangles: number; queued: number }

interface Node {
  key: string;
  depth: number;
  /** World coordinates of the node's minimum corner, and its span in metres. */
  x: number; z: number; size: number;
  children: Node[] | null;
  mesh: Mesh | null;
}

/** Shared topology: the grid, plus a skirt around the rim.
 *
 *  Neighbouring nodes at different depths do not share edge vertices, so the
 *  seam between them opens a hairline crack straight through to the sky. The
 *  skirt is a band of geometry hanging below each node's edge that fills the
 *  gap without needing the neighbours to agree about anything. */
function buildIndices(): Uint32Array {
  const idx: number[] = [];
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const a = z * (N + 1) + x, b = a + 1, c = a + (N + 1), d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Four skirt strips, one per edge, each duplicating that edge's vertices.
  let base = VERTS;
  const strip = (get: (i: number) => number, flip: boolean) => {
    for (let i = 0; i < N; i++) {
      const t0 = get(i), t1 = get(i + 1);
      const s0 = base + i, s1 = base + i + 1;
      if (flip) idx.push(t0, s0, t1, t1, s0, s1);
      else idx.push(t0, t1, s0, t1, s1, s0);
    }
    base += N + 1;
  };
  strip((i) => i, true);                                  // north edge, z = 0
  strip((i) => N * (N + 1) + i, false);                   // south edge
  strip((i) => i * (N + 1), false);                       // west edge
  strip((i) => i * (N + 1) + N, true);                    // east edge
  return new Uint32Array(idx);
}

const SKIRT_VERTS = 4 * (N + 1);
const INDICES = buildIndices();

export class TerrainRenderer {
  readonly group = new Group();
  readonly stats: TerrainStats = { nodes: 0, built: 0, triangles: 0, queued: 0 };
  private root: Node;
  private cache = new Map<string, Mesh>();
  private live = new Set<string>();
  private origin = new Vector3();
  private material: MeshLambertMaterial;
  private maxDepth: number;

  constructor(private seed: number, rootSize = 4194304, maxDepth = 13) {
    this.maxDepth = maxDepth;
    this.root = { key: '0', depth: 0, x: -rootSize / 2, z: -rootSize / 2, size: rootSize, children: null, mesh: null };
    this.material = new MeshLambertMaterial({ vertexColors: true, side: FrontSide });
    this.group.matrixAutoUpdate = false;
  }

  /** Shift every mesh when the floating origin moves. Rendering relative to a
   *  nearby origin keeps float precision usable a thousand kilometres out. */
  setOrigin(o: Vector3): void {
    this.origin.copy(o);
    for (const [key, mesh] of this.cache) {
      const p = key.split(':');
      mesh.position.set(Number(p[1]) - o.x, 0, Number(p[2]) - o.z);
    }
  }

  update(cameraWorld: Vector3, budgetMs = 6): void {
    this.live.clear();
    let nodes = 0;
    // Tiles that are wanted but not yet built, with their distance, so the
    // budget is spent on the ground under the aeroplane rather than on
    // whichever corner of the quadtree the traversal happened to reach first.
    const pending: { node: Node; key: string; dist: number }[] = [];

    const visit = (node: Node): void => {
      const cx = node.x + node.size / 2, cz = node.z + node.size / 2;
      const dx = cameraWorld.x - cx, dz = cameraWorld.z - cz;
      const dist = Math.max(0, Math.hypot(dx, dz) - node.size * 0.5);

      if (node.depth < this.maxDepth && dist < node.size * SPLIT) {
        if (!node.children) {
          const h = node.size / 2;
          node.children = [
            { key: `${node.key}0`, depth: node.depth + 1, x: node.x, z: node.z, size: h, children: null, mesh: null },
            { key: `${node.key}1`, depth: node.depth + 1, x: node.x + h, z: node.z, size: h, children: null, mesh: null },
            { key: `${node.key}2`, depth: node.depth + 1, x: node.x, z: node.z + h, size: h, children: null, mesh: null },
            { key: `${node.key}3`, depth: node.depth + 1, x: node.x + h, z: node.z + h, size: h, children: null, mesh: null },
          ];
        }
        for (const c of node.children) visit(c);
        return;
      }

      nodes++;
      const key = `${node.depth}:${node.x}:${node.z}:${node.size}`;
      this.live.add(key);
      const mesh = this.cache.get(key);
      if (!mesh) { pending.push({ node, key, dist }); return; }
      mesh.visible = true;
    };

    visit(this.root);

    pending.sort((a, b) => a.dist - b.dist);
    const deadline = performance.now() + budgetMs;
    let built = 0;
    for (const p of pending) {
      if (built > 0 && performance.now() > deadline) break;
      this.build(p.node, p.key).visible = true;
      built++;
    }

    // Hide anything not wanted this frame; keep it cached for when the
    // aeroplane turns back.
    for (const [key, mesh] of this.cache) if (!this.live.has(key)) mesh.visible = false;
    if (this.cache.size > 900) this.evict();

    this.stats.nodes = nodes;
    this.stats.built = built;
    this.stats.queued = pending.length - built;
    this.stats.triangles = nodes * N * N * 2;
  }

  /** Build the near field before the flight starts, so the first frame is a
   *  landscape rather than an empty sea with a town floating on it. Returns
   *  when nothing is outstanding or the time is spent. */
  warmUp(cameraWorld: Vector3, maxMs = 2500): number {
    const t0 = performance.now();
    let passes = 0;
    do {
      this.update(cameraWorld, 120);
      passes++;
    } while (this.stats.queued > 0 && performance.now() - t0 < maxMs);
    return passes;
  }

  private evict(): void {
    for (const [key, mesh] of this.cache) {
      if (this.live.has(key)) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.cache.delete(key);
      if (this.cache.size <= 700) break;
    }
  }

  /** Milliseconds spent meshing, for the performance report. */
  buildMs = 0;

  private build(node: Node, key: string): Mesh {
    const t0 = performance.now();
    const step = node.size / N;
    const total = VERTS + SKIRT_VERTS;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const heights = new Float32Array(VERTS);
    const c = { r: 0, g: 0, b: 0 };

    for (let z = 0; z <= N; z++) {
      for (let x = 0; x <= N; x++) {
        const i = z * (N + 1) + x;
        const wx = node.x + x * step, wz = node.z + z * step;
        const h = elevation(wx, wz, this.seed);
        heights[i] = h;
        pos[i * 3] = x * step;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z * step;
      }
    }

    // Normals and colour from the sampled field rather than from the triangles,
    // so a coarse node still shades like the ground it stands for.
    for (let z = 0; z <= N; z++) {
      for (let x = 0; x <= N; x++) {
        const i = z * (N + 1) + x;
        const wx = node.x + x * step, wz = node.z + z * step;
        const hl = x > 0 ? heights[i - 1]! : elevation(wx - step, wz, this.seed);
        const hr = x < N ? heights[i + 1]! : elevation(wx + step, wz, this.seed);
        const hd = z > 0 ? heights[i - (N + 1)]! : elevation(wx, wz - step, this.seed);
        const hu = z < N ? heights[i + (N + 1)]! : elevation(wx, wz + step, this.seed);
        const ex = hl - hr, ez = hd - hu;
        const len = Math.hypot(ex, 2 * step, ez);
        nor[i * 3] = ex / len; nor[i * 3 + 1] = (2 * step) / len; nor[i * 3 + 2] = ez / len;

        const slope = Math.hypot(hr - hl, hu - hd) / (2 * step);
        surfaceColor(c, wx, wz, this.seed, heights[i]!, slope);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
    }

    // Skirt: copy each edge vertex and drop it, hiding the seam with the
    // neighbouring node's different resolution.
    const drop = Math.max(6, step * 2.2);
    let s = VERTS;
    const edge = (get: (i: number) => number) => {
      for (let i = 0; i <= N; i++, s++) {
        const src = get(i);
        pos[s * 3] = pos[src * 3];
        pos[s * 3 + 1] = pos[src * 3 + 1] - drop;
        pos[s * 3 + 2] = pos[src * 3 + 2];
        nor[s * 3] = nor[src * 3]; nor[s * 3 + 1] = nor[src * 3 + 1]; nor[s * 3 + 2] = nor[src * 3 + 2];
        col[s * 3] = col[src * 3]; col[s * 3 + 1] = col[src * 3 + 1]; col[s * 3 + 2] = col[src * 3 + 2];
      }
    };
    edge((i) => i);
    edge((i) => N * (N + 1) + i);
    edge((i) => i * (N + 1));
    edge((i) => i * (N + 1) + N);

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setIndex(new BufferAttribute(INDICES, 1));
    geo.computeBoundingSphere();

    const mesh = new Mesh(geo, this.material);
    mesh.position.set(node.x - this.origin.x, 0, node.z - this.origin.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this.cache.set(key, mesh);
    this.buildMs += performance.now() - t0;
    return mesh;
  }

  dispose(): void {
    for (const mesh of this.cache.values()) mesh.geometry.dispose();
    this.cache.clear();
    this.material.dispose();
  }
}

/** Steepness used by the scenery placer; re-exported so callers do not have to
 *  know which layer owns it. */
export { slopeAt };
