/** Cell state. Order matters: anything <= FLAGGED is solid rock that blocks
 *  a pick ray; anything >= REVEALED is open space that exposes its neighbours. */
export const COVERED = 0;
export const FLAGGED = 1;
export const REVEALED = 2;
export const DESTROYED = 3;
export const EXTRACTED = 4;

export const FACES: readonly [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/** Fixed-size cubic lattice with a precomputed 6-neighbour table.
 *  The table costs n^3 * 6 ints and removes all bounds arithmetic from the
 *  hot loops in the solver, which runs thousands of times during generation. */
export class Grid {
  readonly n: number;
  readonly size: number;
  /** neighbour[i * 6 + f] is the index across face f, or -1 outside the box. */
  readonly neighbour: Int32Array;

  constructor(n: number) {
    this.n = n;
    this.size = n * n * n;
    this.neighbour = new Int32Array(this.size * 6).fill(-1);
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = this.idx(x, y, z);
          for (let f = 0; f < 6; f++) {
            const [dx, dy, dz] = FACES[f]!;
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= n || ny >= n || nz >= n) continue;
            this.neighbour[i * 6 + f] = this.idx(nx, ny, nz);
          }
        }
      }
    }
  }

  idx(x: number, y: number, z: number): number {
    return (z * this.n + y) * this.n + x;
  }

  x(i: number): number { return i % this.n; }
  y(i: number): number { return Math.floor(i / this.n) % this.n; }
  z(i: number): number { return Math.floor(i / (this.n * this.n)); }

  /** Squared distance between two cells, in cells. */
  dist2(a: number, b: number): number {
    const dx = this.x(a) - this.x(b);
    const dy = this.y(a) - this.y(b);
    const dz = this.z(a) - this.z(b);
    return dx * dx + dy * dy + dz * dz;
  }
}
