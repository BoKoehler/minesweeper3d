/** Offline measurements backing the numbers in DESIGN.md. Run with
 *  `npx tsx scripts/measure.ts`. Deliberately not part of `npm test` — this is
 *  evidence for the design, not a gate on the build. */
import { Grid } from '../src/core/grid';
import { makeRng } from '../src/core/rng';
import { reveal, recomputeCounts, type Board } from '../src/core/board';
import { generate } from '../src/core/generate';
import { TIERS } from '../src/game/tiers';

function box(n: number): Board {
  const grid = new Grid(n);
  return {
    grid, hull: new Uint8Array(grid.size).fill(1), hullCells: [...Array(grid.size).keys()],
    depth: new Uint8Array(grid.size), mine: new Uint8Array(grid.size), core: new Uint8Array(grid.size),
    count: new Uint8Array(grid.size), state: new Uint8Array(grid.size), cores: [], entry: 0, mineTotal: 0,
  };
}

/** Biggest pocket a single dig can open, sampled over many starting zeros. */
export function largestCluster(density: number, seed: number, n = 18, samples = 40): number {
  const b = box(n);
  const rng = makeRng(seed);
  for (let i = 0; i < b.grid.size; i++) if (rng.next() < density) b.mine[i] = 1;
  recomputeCounts(b);
  const zeros: number[] = [];
  for (let i = 0; i < b.grid.size; i++) if (b.mine[i] === 0 && b.count[i] === 0) zeros.push(i);
  if (!zeros.length) return 0;
  rng.shuffle(zeros);
  const saved = b.state.slice();
  let max = 0;
  for (const s of zeros.slice(0, samples)) {
    b.state.set(saved);
    max = Math.max(max, reveal(b, s).length);
  }
  return max / b.grid.size;
}

console.log('density  zero-cells  largest single-dig pocket');
for (const d of [0.08, 0.12, 0.16, 0.18, 0.20, 0.23, 0.25]) {
  const avg = [1, 2, 3].map((s) => largestCluster(d, s)).reduce((a, c) => a + c) / 3;
  console.log(`  ${(d * 100).toFixed(0)}%      ${((1 - d) ** 6 * 100).toFixed(1).padStart(5)}%      ${(avg * 100).toFixed(1).padStart(5)}% of the rock`);
}

console.log('\ntier        cells  mines  attempts  guess-free  gen ms');
for (const tier of TIERS) {
  let clean = 0, ms = 0, att = 0, cells = 0, mines = 0;
  const runs = 8;
  for (let s = 0; s < runs; s++) {
    const t0 = Date.now();
    const r = generate({ tier, seed: 1000 + s * 97, budgetMs: 1400 });
    ms += Date.now() - t0;
    att += r.attempts;
    if (r.clean) clean++;
    cells = r.board.hullCells.length;
    mines = r.board.mineTotal;
  }
  console.log(`${tier.name.padEnd(11)} ${String(cells).padStart(5)} ${String(mines).padStart(6)} ${(att / runs).toFixed(1).padStart(9)} ${`${clean}/${runs}`.padStart(11)} ${(ms / runs).toFixed(0).padStart(7)}`);
}
