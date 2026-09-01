import { Grid, COVERED, FLAGGED } from './grid';
import { makeRng, type Rng } from './rng';
import { type Board, isDiggable, recomputeCounts, reveal } from './board';
import { deduceAll } from './solver';
import type { Tier } from '../game/tiers';

/** A lumpy ellipsoid rather than a sphere, so the rock reads as a rock and the
 *  surface curvature varies enough that no two approaches feel the same. */
function buildHull(g: Grid, rng: Rng): Uint8Array {
  const hull = new Uint8Array(g.size);
  const c = (g.n - 1) / 2;
  const r = g.n / 2;
  const p = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
  const a = [rng.range(0.06, 0.13), rng.range(0.06, 0.13), rng.range(0.06, 0.13)];
  const s = [rng.range(0.92, 1.08), rng.range(0.92, 1.08), rng.range(0.92, 1.08)];
  for (let i = 0; i < g.size; i++) {
    const dx = (g.x(i) - c) / (r * s[0]!);
    const dy = (g.y(i) - c) / (r * s[1]!);
    const dz = (g.z(i) - c) / (r * s[2]!);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) { hull[i] = 1; continue; }
    const lump =
      1 +
      a[0]! * Math.sin(3.1 * dx + p[0]!) * Math.cos(2.3 * dy + p[1]!) +
      a[1]! * Math.sin(2.7 * dy + p[1]!) * Math.cos(3.3 * dz + p[2]!) +
      a[2]! * Math.sin(2.9 * dz + p[2]!) * Math.cos(2.1 * dx + p[0]!);
    if (d <= 0.94 * lump) hull[i] = 1;
  }
  return hull;
}

/** Cells from the outer skin, by face adjacency. Drives the peel control and
 *  keeps cores from being placed where they would poke out of the surface. */
function buildDepth(g: Grid, hull: Uint8Array): Uint8Array {
  const depth = new Uint8Array(g.size).fill(255);
  const queue: number[] = [];
  for (let i = 0; i < g.size; i++) {
    if (hull[i] !== 1) continue;
    for (let f = 0; f < 6; f++) {
      const j = g.neighbour[i * 6 + f]!;
      if (j < 0 || hull[j] !== 1) { depth[i] = 0; queue.push(i); break; }
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h]!;
    for (let f = 0; f < 6; f++) {
      const j = g.neighbour[i * 6 + f]!;
      if (j >= 0 && hull[j] === 1 && depth[j] === 255) {
        depth[j] = Math.min(254, depth[i]! + 1);
        queue.push(j);
      }
    }
  }
  return depth;
}

function emptyBoard(g: Grid, hull: Uint8Array, depth: Uint8Array): Board {
  const hullCells: number[] = [];
  for (let i = 0; i < g.size; i++) if (hull[i] === 1) hullCells.push(i);
  return {
    grid: g, hull, depth, hullCells,
    mine: new Uint8Array(g.size),
    core: new Uint8Array(g.size),
    count: new Uint8Array(g.size),
    state: new Uint8Array(g.size),
    cores: [], entry: hullCells[0] ?? 0, mineTotal: 0,
  };
}

export interface PlayReport { revealed: number; coresReached: number }

/** Play the board using nothing but the solver, to see how far pure deduction
 *  gets. This is the score generation optimises against. */
export function simulatePlay(b: Board): PlayReport {
  const saved = b.state.slice();
  b.state.fill(COVERED);
  let revealed = reveal(b, b.entry).length;
  const reachedCores = new Set<number>();

  for (let round = 0; round < 500; round++) {
    for (const c of b.cores) if (isDiggable(b, c)) { reachedCores.add(c); revealed += reveal(b, c).length; }
    const d = deduceAll(b, []);
    const diggable = d.safe.filter((i) => isDiggable(b, i));
    if (!diggable.length) break;
    for (const i of diggable) revealed += reveal(b, i).length;
  }
  for (const c of b.cores) if (isDiggable(b, c)) reachedCores.add(c);

  b.state.set(saved);
  return { revealed, coresReached: reachedCores.size };
}

function placeCores(b: Board, rng: Rng, want: number): number[] {
  const g = b.grid;
  const pool = b.hullCells.filter((i) => b.depth[i]! >= 2);
  rng.shuffle(pool);
  const minSep = Math.max(9, Math.round((g.n * g.n) / 9));
  const chosen: number[] = [];
  for (const i of pool) {
    if (chosen.length >= want) break;
    if (g.dist2(i, b.entry) < minSep) continue;
    if (chosen.some((c) => g.dist2(c, i) < minSep)) continue;
    chosen.push(i);
  }
  // Relax separation rather than return too few cores on a small rock.
  for (const i of pool) {
    if (chosen.length >= want) break;
    if (!chosen.includes(i) && i !== b.entry) chosen.push(i);
  }
  return chosen;
}

function placeMines(b: Board, rng: Rng, density: number): void {
  const g = b.grid;
  const blocked = new Set<number>([b.entry]);
  const block = (i: number) => {
    blocked.add(i);
    for (let f = 0; f < 6; f++) {
      const j = g.neighbour[i * 6 + f]!;
      if (j >= 0 && b.hull[j] === 1) blocked.add(j);
    }
  };
  // The entry is forced to a zero so the opening dig always breaks a pocket
  // rather than a single square. Cores sit in clean matrix by rule, which is
  // what gives a route its last step.
  block(b.entry);
  for (const c of b.cores) block(c);

  const pool = b.hullCells.filter((i) => !blocked.has(i));
  rng.shuffle(pool);
  const want = Math.min(pool.length, Math.round(b.hullCells.length * density));
  b.mine.fill(0);
  for (let i = 0; i < want; i++) b.mine[pool[i]!] = 1;
  b.mineTotal = want;
  recomputeCounts(b);
}

export interface GenerateResult {
  board: Board;
  attempts: number;
  report: PlayReport;
  /** True when pure deduction reaches every core with no guess required. */
  clean: boolean;
}

export interface GenerateOptions {
  tier: Tier;
  seed: number;
  /** Wall-clock ceiling for the search, in ms. Generation adapts to the
   *  machine instead of hard-coding an attempt count. */
  budgetMs?: number;
}

/** Best-of-K under a time budget, scored by how far the solver gets and
 *  whether it reaches every core without guessing. Boards where it does are
 *  accepted immediately; otherwise the best candidate found is returned and
 *  the hint button covers the difference. */
export function generate(opts: GenerateOptions): GenerateResult {
  const { tier, seed } = opts;
  const budget = opts.budgetMs ?? 1400;
  const t0 = Date.now();
  const g = new Grid(tier.n);

  let best: Board | null = null;
  let bestReport: PlayReport = { revealed: -1, coresReached: -1 };
  let bestScore = -Infinity;
  let attempts = 0;

  for (let attempt = 0; attempt < 200; attempt++) {
    if (attempt > 0 && Date.now() - t0 > budget) break;
    attempts++;
    const rng = makeRng(seed + attempt * 0x9e37);
    const hull = attempt === 0 || !best ? buildHull(g, rng) : best.hull;
    const depth = attempt === 0 || !best ? buildDepth(g, hull) : best.depth;
    const b = emptyBoard(g, hull, depth);
    if (b.hullCells.length < 20) continue;

    const skin = b.hullCells.filter((i) => b.depth[i] === 0);
    b.entry = skin[rng.int(skin.length)] ?? b.hullCells[0]!;
    b.cores = placeCores(b, rng, tier.cores);
    b.core.fill(0);
    for (const c of b.cores) b.core[c] = 1;
    placeMines(b, rng, tier.density);

    const report = simulatePlay(b);
    const score = report.coresReached * 100000 + report.revealed;
    if (score > bestScore) { bestScore = score; best = b; bestReport = report; }
    if (report.coresReached === b.cores.length) break;
  }

  const board = best!;
  board.state.fill(COVERED);
  reveal(board, board.entry);
  return {
    board,
    attempts,
    report: bestReport,
    clean: bestReport.coresReached === board.cores.length,
  };
}

export { COVERED, FLAGGED };
