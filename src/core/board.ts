import { Grid, COVERED, FLAGGED, REVEALED, DESTROYED, EXTRACTED } from './grid';

export interface Board {
  grid: Grid;
  /** 1 where the asteroid has matrix; 0 is open space outside the rock. */
  hull: Uint8Array;
  mine: Uint8Array;
  core: Uint8Array;
  /** Mines among the six face-neighbours. Cells outside the hull hold none. */
  count: Uint8Array;
  state: Uint8Array;
  /** Cells from the hull surface, for the peel control. 0 is the outer skin. */
  depth: Uint8Array;
  hullCells: number[];
  cores: number[];
  entry: number;
  mineTotal: number;
}

/** Open space: outside the rock, or matrix that has been dug out. */
export function isOpen(b: Board, i: number): boolean {
  return b.hull[i] === 0 || b.state[i]! >= REVEALED;
}

/** Solid enough to block a pick ray and hide what is behind it. */
export function isSolid(b: Board, i: number): boolean {
  return b.hull[i] === 1 && b.state[i]! <= FLAGGED;
}

/** The frontier rule: a covered cell is diggable exactly when it touches open
 *  space. Every diggable cell is therefore on the visible skin of the dig, so
 *  occlusion can never hide a legal move. */
export function isDiggable(b: Board, i: number): boolean {
  if (b.hull[i] !== 1 || b.state[i] !== COVERED) return false;
  const nb = b.grid.neighbour;
  for (let f = 0; f < 6; f++) {
    const j = nb[i * 6 + f]!;
    if (j < 0 || isOpen(b, j)) return true;
  }
  return false;
}

/** True when a covered cell touches open space regardless of flag state —
 *  used for rendering, where a flagged cell still needs to be drawn. */
export function isExposed(b: Board, i: number): boolean {
  if (b.hull[i] !== 1 || b.state[i]! > FLAGGED) return false;
  const nb = b.grid.neighbour;
  for (let f = 0; f < 6; f++) {
    const j = nb[i * 6 + f]!;
    if (j < 0 || isOpen(b, j)) return true;
  }
  return false;
}

export function recomputeCounts(b: Board): void {
  const nb = b.grid.neighbour;
  b.count.fill(0);
  for (const i of b.hullCells) {
    let c = 0;
    for (let f = 0; f < 6; f++) {
      const j = nb[i * 6 + f]!;
      if (j >= 0 && b.mine[j] === 1) c++;
    }
    b.count[i] = c;
  }
}

/** Flood fill through zero-cells by face adjacency. Returns every cell newly
 *  revealed, so the renderer and the score both know what changed. */
export function reveal(b: Board, start: number): number[] {
  if (b.hull[start] !== 1 || b.state[start] !== COVERED) return [];
  const out: number[] = [];
  const stack = [start];
  const nb = b.grid.neighbour;
  while (stack.length) {
    const i = stack.pop()!;
    if (b.hull[i] !== 1 || b.state[i] !== COVERED) continue;
    b.state[i] = REVEALED;
    out.push(i);
    if (b.count[i] !== 0) continue;
    for (let f = 0; f < 6; f++) {
      const j = nb[i * 6 + f]!;
      if (j >= 0 && b.hull[j] === 1 && b.state[j] === COVERED) stack.push(j);
    }
  }
  return out;
}

export interface BlastResult {
  destroyed: number[];
  detonated: number[];
  coresLost: number[];
}

/** A detonation removes its cell and its six faces. Mines caught in the wave
 *  detonate in turn, but only down to `chainDepth` — at 20%+ density an
 *  unbounded chain is supercritical and would take the whole rock. */
export function blast(b: Board, origin: number, chainDepth: number): BlastResult {
  const destroyed: number[] = [];
  const detonated: number[] = [];
  const coresLost: number[] = [];
  const nb = b.grid.neighbour;
  const seen = new Set<number>();
  let wave = [origin];

  for (let d = 0; wave.length && d <= chainDepth; d++) {
    const nextWave: number[] = [];
    for (const i of wave) {
      if (seen.has(i)) continue;
      seen.add(i);
      detonated.push(i);
      for (let f = -1; f < 6; f++) {
        const j = f < 0 ? i : nb[i * 6 + f]!;
        if (j < 0 || b.hull[j] !== 1) continue;
        if (b.state[j] === DESTROYED || b.state[j] === EXTRACTED) continue;
        if (b.core[j] === 1) coresLost.push(j);
        if (b.mine[j] === 1 && !seen.has(j) && d < chainDepth) nextWave.push(j);
        b.state[j] = DESTROYED;
        b.mine[j] = 0;
        b.core[j] = 0;
        destroyed.push(j);
      }
    }
    wave = nextWave;
  }
  recomputeCounts(b);
  return { destroyed, detonated, coresLost };
}

export function toggleFlag(b: Board, i: number): boolean {
  if (b.hull[i] !== 1) return false;
  if (b.state[i] === COVERED) { b.state[i] = FLAGGED; return true; }
  if (b.state[i] === FLAGGED) { b.state[i] = COVERED; return true; }
  return false;
}

/** Mines on one axis-aligned line through a cell, inside the hull. The line
 *  ignores what has already been dug out — sonar reads the rock, not the void. */
export function sonarLine(b: Board, cell: number, axis: 0 | 1 | 2): number[] {
  const g = b.grid;
  const x = g.x(cell), y = g.y(cell), z = g.z(cell);
  const out: number[] = [];
  for (let t = 0; t < g.n; t++) {
    const i = axis === 0 ? g.idx(t, y, z) : axis === 1 ? g.idx(x, t, z) : g.idx(x, y, t);
    if (b.hull[i] === 1) out.push(i);
  }
  return out;
}
