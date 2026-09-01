import { describe, it, expect } from 'vitest';
import { Grid, COVERED, REVEALED, DESTROYED, FLAGGED } from '../src/core/grid';
import { makeRng, hashSeed } from '../src/core/rng';
import { reveal, blast, isDiggable, recomputeCounts, toggleFlag, type Board } from '../src/core/board';
import { deduceAll, makeKnown, deduceOnce, SAFE, MINE } from '../src/core/solver';
import { generate } from '../src/core/generate';
import { pickCell } from '../src/render/pick';
import { Game } from '../src/game/game';
import { TIERS, tierById } from '../src/game/tiers';

function box(n: number): Board {
  const grid = new Grid(n);
  const hull = new Uint8Array(grid.size).fill(1);
  const hullCells = [...Array(grid.size).keys()];
  return {
    grid, hull, hullCells,
    depth: new Uint8Array(grid.size),
    mine: new Uint8Array(grid.size),
    core: new Uint8Array(grid.size),
    count: new Uint8Array(grid.size),
    state: new Uint8Array(grid.size),
    cores: [], entry: 0, mineTotal: 0,
  };
}

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = makeRng(12345), b = makeRng(12345);
    expect([...Array(20)].map(() => a.next())).toEqual([...Array(20)].map(() => b.next()));
  });
  it('differs across seeds and hashes strings stably', () => {
    expect(makeRng(1).next()).not.toEqual(makeRng(2).next());
    expect(hashSeed('bennu')).toBe(hashSeed('bennu'));
    expect(hashSeed('bennu')).not.toBe(hashSeed('ryugu'));
  });
});

describe('grid', () => {
  it('gives interior cells exactly six neighbours and surface cells fewer', () => {
    const g = new Grid(5);
    const count = (i: number) => [...Array(6).keys()].filter((f) => g.neighbour[i * 6 + f]! >= 0).length;
    expect(count(g.idx(2, 2, 2))).toBe(6);
    expect(count(g.idx(0, 2, 2))).toBe(5);
    expect(count(g.idx(0, 0, 0))).toBe(3);
  });
  it('round-trips coordinates', () => {
    const g = new Grid(7);
    for (const [x, y, z] of [[0, 0, 0], [6, 6, 6], [3, 1, 5]] as const) {
      const i = g.idx(x, y, z);
      expect([g.x(i), g.y(i), g.z(i)]).toEqual([x, y, z]);
    }
  });
  it('is symmetric — a is b\'s neighbour iff b is a\'s', () => {
    const g = new Grid(4);
    for (let i = 0; i < g.size; i++) {
      for (let f = 0; f < 6; f++) {
        const j = g.neighbour[i * 6 + f]!;
        if (j < 0) continue;
        expect([...Array(6).keys()].some((k) => g.neighbour[j * 6 + k] === i)).toBe(true);
      }
    }
  });
});

describe('counts', () => {
  it('counts only the six faces, never edges or corners', () => {
    const b = box(3);
    const g = b.grid;
    const centre = g.idx(1, 1, 1);
    const faces = [...Array(6).keys()].map((f) => g.neighbour[centre * 6 + f]!);
    // Mine every one of the 26 surrounding cells except the six faces.
    for (let i = 0; i < g.size; i++) if (i !== centre && !faces.includes(i)) b.mine[i] = 1;
    recomputeCounts(b);
    expect(b.count[centre]).toBe(0);
    // Turning on one face, and only a face, moves the number.
    b.mine[faces[0]!] = 1;
    recomputeCounts(b);
    expect(b.count[centre]).toBe(1);
  });
});

describe('reveal', () => {
  it('floods through zero cells and stops at numbers', () => {
    const b = box(5);
    const g = b.grid;
    b.mine[g.idx(4, 4, 4)] = 1;
    recomputeCounts(b);
    const opened = reveal(b, g.idx(0, 0, 0));
    // Everything but the mine itself: the flood stops on the three numbered
    // cells that touch it, but those are still revealed.
    expect(opened.length).toBe(125 - 1);
    expect(b.state[g.idx(4, 4, 4)]).toBe(COVERED);
    expect(b.state[g.idx(3, 4, 4)]).toBe(REVEALED);
  });
  it('reveals a single cell when it carries a number', () => {
    const b = box(3);
    const g = b.grid;
    b.mine[g.idx(2, 1, 1)] = 1;
    recomputeCounts(b);
    expect(reveal(b, g.idx(1, 1, 1)).length).toBe(1);
  });
});

describe('percolation floor', () => {
  // Zero-cells flood by face adjacency, so the fraction of them decides
  // whether one dig opens a pocket or unzips the whole rock. Site percolation
  // on the cubic lattice puts the threshold near 0.3116 zero-cells, which
  // (1-p)^6 = 0.3116 turns into a mine-density floor of ~17.7%.
  const largestPocket = (density: number, seed: number): number => {
    const b = box(14);
    const rng = makeRng(seed);
    for (let i = 0; i < b.grid.size; i++) if (rng.next() < density) b.mine[i] = 1;
    recomputeCounts(b);
    const zeros: number[] = [];
    for (let i = 0; i < b.grid.size; i++) if (b.mine[i] === 0 && b.count[i] === 0) zeros.push(i);
    if (!zeros.length) return 0;
    rng.shuffle(zeros);
    const saved = b.state.slice();
    let max = 0;
    for (const s of zeros.slice(0, 25)) {
      b.state.set(saved);
      max = Math.max(max, reveal(b, s).length);
    }
    return max / b.grid.size;
  };
  const avg = (d: number) => [1, 2, 3].map((s) => largestPocket(d, s)).reduce((a, c) => a + c) / 3;

  it('runs away below the floor', () => {
    expect(avg(0.12)).toBeGreaterThan(0.5);
  });
  it('stays local above the floor', () => {
    expect(avg(0.23)).toBeLessThan(0.15);
  });
  it('every shipped tier sits above the floor', () => {
    for (const t of TIERS) expect(t.density).toBeGreaterThan(0.177);
  });
});

describe('blast', () => {
  it('takes the cell and its six faces', () => {
    const b = box(5);
    const g = b.grid;
    const o = g.idx(2, 2, 2);
    b.mine[o] = 1;
    recomputeCounts(b);
    const r = blast(b, o, 2);
    expect(r.destroyed.length).toBe(7);
    expect(b.state[o]).toBe(DESTROYED);
    expect(b.state[g.idx(2, 2, 3)]).toBe(DESTROYED);
    expect(b.state[g.idx(2, 2, 4)]).toBe(COVERED);
  });

  it('chains through mines but stops at the depth limit', () => {
    const b = box(9);
    const g = b.grid;
    for (let x = 4; x <= 8; x++) b.mine[g.idx(x, 4, 4)] = 1;
    recomputeCounts(b);
    const r = blast(b, g.idx(4, 4, 4), 1);
    // Depth 0 detonates and takes x=5; x=5 is a mine so it detonates at depth
    // 1 and takes x=6; x=6 is at the limit and is defused, not detonated.
    expect(r.detonated.length).toBe(2);
    expect(b.state[g.idx(6, 4, 4)]).toBe(DESTROYED);
    expect(b.state[g.idx(7, 4, 4)]).toBe(COVERED);
    expect(b.mine[g.idx(7, 4, 4)]).toBe(1);
  });

  it('is bounded even in solid mine', () => {
    const b = box(11);
    b.mine.fill(1);
    recomputeCounts(b);
    const r = blast(b, b.grid.idx(5, 5, 5), 2);
    expect(r.destroyed.length).toBeLessThanOrEqual(1 + 6 + 6 * 6 + 6 * 6 * 6);
    expect(r.destroyed.length).toBeGreaterThan(7);
  });

  it('reports cores lost in the wave', () => {
    const b = box(5);
    const g = b.grid;
    const o = g.idx(2, 2, 2);
    b.mine[o] = 1;
    b.core[g.idx(2, 3, 2)] = 1;
    b.cores = [g.idx(2, 3, 2)];
    recomputeCounts(b);
    expect(blast(b, o, 1).coresLost).toEqual([g.idx(2, 3, 2)]);
  });

  it('leaves counts consistent afterwards', () => {
    const b = box(7);
    const rng = makeRng(9);
    for (let i = 0; i < b.grid.size; i++) if (rng.next() < 0.25) b.mine[i] = 1;
    recomputeCounts(b);
    blast(b, b.grid.idx(3, 3, 3), 2);
    const before = b.count.slice();
    recomputeCounts(b);
    expect([...b.count]).toEqual([...before]);
  });
});

describe('diggability', () => {
  it('exposes only the skin, then grows with the dig', () => {
    const b = box(5);
    const g = b.grid;
    recomputeCounts(b);
    expect(isDiggable(b, g.idx(2, 2, 2))).toBe(false);
    expect(isDiggable(b, g.idx(0, 2, 2))).toBe(true);
    b.state[g.idx(1, 2, 2)] = REVEALED;
    expect(isDiggable(b, g.idx(2, 2, 2))).toBe(true);
  });
  it('does not treat a flagged neighbour as open', () => {
    const b = box(5);
    const g = b.grid;
    b.state[g.idx(1, 2, 2)] = FLAGGED;
    expect(isDiggable(b, g.idx(2, 2, 2))).toBe(false);
  });
  it('toggles flags only on covered cells', () => {
    const b = box(3);
    expect(toggleFlag(b, 0)).toBe(true);
    expect(b.state[0]).toBe(FLAGGED);
    expect(toggleFlag(b, 0)).toBe(true);
    expect(b.state[0]).toBe(COVERED);
    b.state[1] = REVEALED;
    expect(toggleFlag(b, 1)).toBe(false);
  });
});

describe('solver', () => {
  it('clears everything around a zero', () => {
    const b = box(3);
    const g = b.grid;
    b.mine[g.idx(0, 0, 0)] = 1;
    recomputeCounts(b);
    b.state[g.idx(2, 2, 2)] = REVEALED;
    const d = deduceAll(b, []);
    expect(d.safe).toContain(g.idx(1, 2, 2));
    expect(d.mine).toHaveLength(0);
  });

  it('fills a constraint that is saturated', () => {
    const b = box(3);
    const g = b.grid;
    const c = g.idx(0, 0, 0);
    // Corner cell has three faces; make all three mines.
    for (const j of [g.idx(1, 0, 0), g.idx(0, 1, 0), g.idx(0, 0, 1)]) b.mine[j] = 1;
    recomputeCounts(b);
    b.state[c] = REVEALED;
    const d = deduceAll(b, []);
    expect(d.mine.sort()).toEqual([g.idx(1, 0, 0), g.idx(0, 1, 0), g.idx(0, 0, 1)].sort());
  });

  it('uses the subset rule on a diagonal pair', () => {
    // Two readings a diagonal step apart share exactly two cells. That overlap
    // is the workhorse pattern of the whole game, so pin the geometry.
    const g = new Grid(4);
    const A = g.idx(1, 1, 0), B = g.idx(2, 2, 0);
    const nbrs = (i: number) => [...Array(6).keys()].map((f) => g.neighbour[i * 6 + f]!).filter((j) => j >= 0);
    const shared = nbrs(A).filter((j) => nbrs(B).includes(j));
    expect(shared.sort()).toEqual([g.idx(2, 1, 0), g.idx(1, 2, 0)].sort());
    // Face-adjacent readings share nothing; body diagonals share nothing.
    expect(nbrs(A).filter((j) => nbrs(g.idx(2, 1, 0)).includes(j))).toHaveLength(0);
    expect(nbrs(A).filter((j) => nbrs(g.idx(2, 2, 1)).includes(j))).toHaveLength(0);
    // Two apart along an axis share exactly the cell between them.
    expect(nbrs(A).filter((j) => nbrs(g.idx(3, 1, 0)).includes(j))).toEqual([g.idx(2, 1, 0)]);
  });

  it('solves a case that only exact enumeration reaches', () => {
    // Two diagonal readings give constraints a+b+c = 1 and b+c+d = 2. Neither
    // is trivial and neither variable set contains the other, so the subset
    // rule cannot fire — but b+c <= 1 forces d to be a mine and a to be safe.
    const b = box(5);
    const g = b.grid;
    const R1 = g.idx(1, 1, 1), R2 = g.idx(2, 2, 1);
    const a = g.idx(1, 0, 1), vb = g.idx(2, 1, 1), c = g.idx(1, 2, 1), d = g.idx(2, 2, 2);
    b.mine[vb] = 1;
    b.mine[d] = 1;
    b.mineTotal = 2;
    recomputeCounts(b);
    // Reveal both readings, and enough of their other faces that R1 is left
    // with exactly {a, b, c} unknown and R2 with exactly {b, c, d}.
    for (const i of [R1, R2, g.idx(0, 1, 1), g.idx(1, 1, 0), g.idx(1, 1, 2),
                     g.idx(3, 2, 1), g.idx(2, 3, 1), g.idx(2, 2, 0)]) b.state[i] = REVEALED;
    expect(b.count[R1]).toBe(1);
    expect(b.count[R2]).toBe(2);

    const d2 = deduceAll(b, []);
    expect(d2.mine).toContain(d);
    expect(d2.safe).toContain(a);
    // And it stops there: exactly one of b, c is a mine, which is not decidable.
    expect(d2.mine).not.toContain(vb);
    expect(d2.safe).not.toContain(c);
  });

  it('never claims a mine is safe or a safe cell is a mine', () => {
    const b = box(6);
    const rng = makeRng(4242);
    for (let i = 0; i < b.grid.size; i++) if (rng.next() < 0.22) b.mine[i] = 1;
    recomputeCounts(b);
    b.mineTotal = [...b.mine].reduce((a: number, c) => a + c, 0);
    let start = -1;
    for (let i = 0; i < b.grid.size && start < 0; i++) if (b.count[i] === 0 && b.mine[i] === 0) start = i;
    reveal(b, start);
    const d = deduceAll(b, []);
    expect(d.safe.length + d.mine.length).toBeGreaterThan(0);
    for (const i of d.safe) expect(b.mine[i]).toBe(0);
    for (const i of d.mine) expect(b.mine[i]).toBe(1);
  });

  it('reads sonar as a line constraint', () => {
    const b = box(5);
    const g = b.grid;
    b.mineTotal = 0;
    // A clean line: sonar reports zero, so the whole line is provably safe.
    const k = makeKnown(b);
    const d = deduceOnce(b, k, [{ cell: g.idx(2, 2, 2), axis: 0 }]);
    expect(d.safe.length).toBe(5);
    for (const i of d.safe) expect(k[i]).toBe(SAFE);
  });

  it('reads a saturated sonar line as all mines', () => {
    const b = box(4);
    const g = b.grid;
    for (let x = 0; x < 4; x++) b.mine[g.idx(x, 1, 1)] = 1;
    recomputeCounts(b);
    b.mineTotal = 4;
    const k = makeKnown(b);
    const d = deduceOnce(b, k, [{ cell: g.idx(0, 1, 1), axis: 0 }]);
    expect(d.mine.length).toBe(4);
    for (const i of d.mine) expect(k[i]).toBe(MINE);
  });
});

describe('generation', () => {
  it('produces a playable rock for every tier', () => {
    for (const tier of TIERS) {
      const { board } = generate({ tier, seed: 1234, budgetMs: 500 });
      expect(board.hullCells.length).toBeGreaterThan(20);
      expect(board.cores.length).toBe(tier.cores);
      // The opening dig always breaks a pocket.
      expect(board.count[board.entry]).toBe(0);
      expect(board.mine[board.entry]).toBe(0);
      // Cores are never mines, and sit in clean matrix by rule.
      for (const c of board.cores) {
        expect(board.mine[c]).toBe(0);
        for (let f = 0; f < 6; f++) {
          const j = board.grid.neighbour[c * 6 + f]!;
          if (j >= 0 && board.hull[j] === 1) expect(board.mine[j]).toBe(0);
        }
      }
      // Density stays above the percolation floor.
      expect(board.mineTotal / board.hullCells.length).toBeGreaterThan(0.17);
    }
  });

  it('is reproducible from a seed', () => {
    const t = tierById('prospect');
    const a = generate({ tier: t, seed: 777, budgetMs: 400 });
    const b = generate({ tier: t, seed: 777, budgetMs: 400 });
    expect([...a.board.mine]).toEqual([...b.board.mine]);
    expect(a.board.entry).toBe(b.board.entry);
    expect(a.board.cores).toEqual(b.board.cores);
  });

  it('opens a pocket at the entry rather than a single cell', () => {
    const { board } = generate({ tier: tierById('deepcore'), seed: 99, budgetMs: 500 });
    const revealed = [...board.state].filter((s) => s === REVEALED).length;
    expect(revealed).toBeGreaterThan(4);
  });
});

describe('picking', () => {
  const ray = (o: [number, number, number], d: [number, number, number]) => {
    const len = Math.hypot(...d);
    return { ox: o[0], oy: o[1], oz: o[2], dx: d[0] / len, dy: d[1] / len, dz: d[2] / len };
  };

  it('hits the near face of a solid block', () => {
    const b = box(5);
    const g = b.grid;
    // Cell (0,2,2) is centred at (-2, 0, 0) with n=5.
    expect(pickCell(b, ray([-10, 0, 0], [1, 0, 0]))).toBe(g.idx(0, 2, 2));
    expect(pickCell(b, ray([10, 0, 0], [-1, 0, 0]))).toBe(g.idx(4, 2, 2));
    expect(pickCell(b, ray([0, 0, 10], [0, 0, -1]))).toBe(g.idx(2, 2, 4));
  });

  it('passes through open space and stops at the first solid cell', () => {
    const b = box(5);
    const g = b.grid;
    b.state[g.idx(0, 2, 2)] = REVEALED;
    b.state[g.idx(1, 2, 2)] = DESTROYED;
    expect(pickCell(b, ray([-10, 0, 0], [1, 0, 0]))).toBe(g.idx(2, 2, 2));
  });

  it('treats a flagged cell as solid so a flag cannot be dug through', () => {
    const b = box(5);
    const g = b.grid;
    b.state[g.idx(0, 2, 2)] = FLAGGED;
    expect(pickCell(b, ray([-10, 0, 0], [1, 0, 0]))).toBe(g.idx(0, 2, 2));
  });

  it('misses when the ray does not meet the lattice', () => {
    const b = box(5);
    expect(pickCell(b, ray([-10, 40, 0], [1, 0, 0]))).toBe(-1);
    expect(pickCell(b, ray([-10, 0, 0], [-1, 0, 0]))).toBe(-1);
  });

  it('always returns a diggable cell — picking and the frontier rule agree', () => {
    // The property the design leans on: because DDA steps one axis at a time,
    // the first solid cell a ray reaches is necessarily face-adjacent to the
    // open cell before it, so it is always a legal dig.
    const { board } = generate({ tier: tierById('prospect'), seed: 31337, budgetMs: 400 });
    const rng = makeRng(5);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const d: [number, number, number] = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
      if (Math.hypot(...d) < 0.2) continue;
      const len = Math.hypot(...d);
      const o: [number, number, number] = [-d[0] / len * 40, -d[1] / len * 40, -d[2] / len * 40];
      const i = pickCell(board, ray(o, d));
      if (i < 0) continue;
      hits++;
      expect(isDiggable(board, i) || board.state[i] === FLAGGED).toBe(true);
    }
    expect(hits).toBeGreaterThan(100);
  });
});

describe('a full run', () => {
  // The smoke test proves a run can be lost. This proves one can be won:
  // drive the game with nothing but provably safe digs and check it reaches
  // every core without ever touching a mine.
  const playByDeduction = (tierId: string, seed: string) => {
    const g = new Game(tierId, seed);
    let steps = 0;
    while (g.phase === 'playing' && steps < 4000) {
      steps++;
      const cell = g.hint();
      if (cell === null) break;
      const out = g.dig(cell);
      if (out.kind === 'detonated') throw new Error('a provably safe dig hit a mine');
      if (out.kind === 'illegal') break;
    }
    return { game: g, steps };
  };

  it('can be won on every tier without a single guess', () => {
    for (const [tier, seed] of [['survey', 'ida-11'], ['prospect', 'bennu-4242'], ['deepcore', 'vesta-2210']] as const) {
      const { game } = playByDeduction(tier, seed);
      expect(game.generatedClean).toBe(true);
      expect(game.phase).toBe('won');
      expect(game.coresExtracted).toBe(game.coresTotal);
      expect(game.hull).toBe(game.tier.hull);
      expect(game.revealedCount).toBeGreaterThan(20);
    }
  });

  it('wins without needing to clear the whole rock', () => {
    // The point of extracting cores rather than clearing: a win leaves most
    // of the volume untouched, so the game is routing, not exhaustion.
    const { game } = playByDeduction('deepcore', 'vesta-2210');
    expect(game.phase).toBe('won');
    expect(game.revealedCount).toBeLessThan(game.board.hullCells.length * 0.9);
  });

  it('ends the run when the hull is gone', () => {
    const g = new Game('survey', 'ida-11');
    for (let i = 0; i < g.board.hullCells.length && g.phase === 'playing'; i++) {
      const cell = g.board.hullCells[i]!;
      if (g.board.mine[cell] === 1 && isDiggable(g.board, cell)) g.dig(cell);
    }
    expect(g.phase).toBe('lost');
    expect(g.hull).toBeLessThanOrEqual(0);
  });
});
