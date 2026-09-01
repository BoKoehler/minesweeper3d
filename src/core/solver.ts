import { type Board, isDiggable } from './board';
import { COVERED, FLAGGED, REVEALED, DESTROYED, EXTRACTED } from './grid';

export const UNKNOWN = 0;
export const SAFE = 1;
export const MINE = 2;

export interface Sonar { cell: number; axis: 0 | 1 | 2 }

interface Constraint { vars: number[]; sum: number }

/** Largest component the exact enumerator will take on, and the ceiling on
 *  solutions it will count before giving up on that component. Both exist to
 *  keep generation inside its time budget rather than to bound correctness. */
const MAX_ENUM_VARS = 20;
const MAX_SOLUTIONS = 120_000;

/** What a player provably knows before making any deduction: revealed cells
 *  are safe, cores are visible so they are safe, and the six cells touching a
 *  core carry no mines. Player flags are deliberately NOT trusted — a hint
 *  built on a wrong flag would be worse than no hint. */
export function makeKnown(b: Board): Int8Array {
  const k = new Int8Array(b.grid.size);
  const nb = b.grid.neighbour;
  for (const i of b.hullCells) {
    const s = b.state[i]!;
    if (s === REVEALED || s === EXTRACTED || s === DESTROYED) k[i] = SAFE;
  }
  for (const c of b.cores) {
    if (b.state[c] === DESTROYED) continue;
    k[c] = SAFE;
    for (let f = 0; f < 6; f++) {
      const j = nb[c * 6 + f]!;
      if (j >= 0 && b.hull[j] === 1 && b.state[j]! <= FLAGGED) k[j] = SAFE;
    }
  }
  return k;
}

function isVariable(b: Board, k: Int8Array, i: number): boolean {
  return b.hull[i] === 1 && b.state[i]! <= FLAGGED && k[i] === UNKNOWN;
}

/** Live mine total on a sonar line. A ping is a live beam, not a snapshot, so
 *  a later detonation that clears mines off the line is reflected here rather
 *  than leaving the player with a stale reading that contradicts the rock. */
export function sonarValue(b: Board, s: Sonar): number {
  const g = b.grid;
  const x = g.x(s.cell), y = g.y(s.cell), z = g.z(s.cell);
  let total = 0;
  for (let t = 0; t < g.n; t++) {
    const i = s.axis === 0 ? g.idx(t, y, z) : s.axis === 1 ? g.idx(x, t, z) : g.idx(x, y, t);
    if (b.hull[i] === 1 && b.mine[i] === 1) total++;
  }
  return total;
}

function buildConstraints(b: Board, k: Int8Array, sonar: Sonar[]): Constraint[] {
  const cons: Constraint[] = [];
  const nb = b.grid.neighbour;

  for (const i of b.hullCells) {
    if (b.state[i] !== REVEALED) continue;
    const vars: number[] = [];
    let sum = b.count[i]!;
    for (let f = 0; f < 6; f++) {
      const j = nb[i * 6 + f]!;
      if (j < 0 || b.hull[j] !== 1 || b.state[j]! > FLAGGED) continue;
      if (k[j] === MINE) sum--;
      else if (k[j] === UNKNOWN) vars.push(j);
    }
    if (vars.length) cons.push({ vars, sum });
  }

  const g = b.grid;
  for (const s of sonar) {
    const x = g.x(s.cell), y = g.y(s.cell), z = g.z(s.cell);
    const vars: number[] = [];
    let sum = sonarValue(b, s);
    for (let t = 0; t < g.n; t++) {
      const i = s.axis === 0 ? g.idx(t, y, z) : s.axis === 1 ? g.idx(x, t, z) : g.idx(x, y, t);
      if (b.hull[i] !== 1 || b.state[i]! > FLAGGED) continue;
      if (k[i] === MINE) sum--;
      else if (k[i] === UNKNOWN) vars.push(i);
    }
    if (vars.length) cons.push({ vars, sum });
  }
  return cons;
}

/** Rule 1: a constraint whose sum is 0 clears everything in it; one whose sum
 *  equals its variable count fills everything in it. */
function applyTrivial(c: Constraint, k: Int8Array, safe: number[], mine: number[]): boolean {
  if (c.sum <= 0 && c.vars.length) {
    for (const v of c.vars) if (k[v] === UNKNOWN) { k[v] = SAFE; safe.push(v); }
    return true;
  }
  if (c.sum === c.vars.length && c.vars.length) {
    for (const v of c.vars) if (k[v] === UNKNOWN) { k[v] = MINE; mine.push(v); }
    return true;
  }
  return false;
}

/** Rule 2: where one constraint's variables sit entirely inside another's, the
 *  difference is its own constraint. Under 6-connectivity these come from the
 *  axis pairs (one shared cell) and diagonal pairs (two) — the whole pattern
 *  vocabulary of the game. */
function applySubset(cons: Constraint[], k: Int8Array, safe: number[], mine: number[]): boolean {
  const byVar = new Map<number, number[]>();
  cons.forEach((c, ci) => {
    for (const v of c.vars) {
      let l = byVar.get(v);
      if (!l) byVar.set(v, (l = []));
      l.push(ci);
    }
  });

  let progress = false;
  const seen = new Set<number>();
  for (let ai = 0; ai < cons.length; ai++) {
    const A = cons[ai]!;
    if (A.vars.length > 10) continue;
    seen.clear();
    for (const v of A.vars) for (const bi of byVar.get(v)!) if (bi !== ai) seen.add(bi);
    const aset = new Set(A.vars);
    for (const bi of seen) {
      const B = cons[bi]!;
      if (B.vars.length <= A.vars.length || B.vars.length > 28) continue;
      let contained = true;
      for (const v of A.vars) if (!B.vars.includes(v)) { contained = false; break; }
      if (!contained) continue;
      const diff = B.vars.filter((v) => !aset.has(v));
      if (applyTrivial({ vars: diff, sum: B.sum - A.sum }, k, safe, mine)) progress = true;
    }
  }
  return progress;
}

/** Rule 3: exact enumeration over a small connected component. Any cell that
 *  is a mine in every consistent assignment, or in none, is forced — this is
 *  what catches the deductions no local pattern reaches. */
function applyEnumeration(cons: Constraint[], k: Int8Array, safe: number[], mine: number[]): boolean {
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(a) !== r) { const nx = parent.get(a)!; parent.set(a, r); a = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const c of cons) for (const v of c.vars) if (!parent.has(v)) parent.set(v, v);
  for (const c of cons) for (let i = 1; i < c.vars.length; i++) union(c.vars[0]!, c.vars[i]!);

  const groups = new Map<number, { vars: Set<number>; cons: Constraint[] }>();
  for (const c of cons) {
    const r = find(c.vars[0]!);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { vars: new Set(), cons: [] }));
    g.cons.push(c);
    for (const v of c.vars) g.vars.add(v);
  }

  let progress = false;
  for (const g of groups.values()) {
    if (g.vars.size > MAX_ENUM_VARS) continue;
    const vars = [...g.vars];
    const local = new Map<number, number>();
    vars.forEach((v, i) => local.set(v, i));
    const cvars = g.cons.map((c) => c.vars.map((v) => local.get(v)!));
    const csum = g.cons.map((c) => c.sum);
    const varCons: number[][] = vars.map(() => []);
    cvars.forEach((vs, ci) => { for (const v of vs) varCons[v]!.push(ci); });

    const assigned = new Int32Array(g.cons.length);
    const left = new Int32Array(g.cons.length);
    cvars.forEach((vs, ci) => { left[ci] = vs.length; });

    const hits = new Int32Array(vars.length);
    const cur = new Int8Array(vars.length);
    let solutions = 0;
    let aborted = false;

    const dfs = (pos: number): void => {
      if (aborted) return;
      if (pos === vars.length) {
        solutions++;
        if (solutions > MAX_SOLUTIONS) { aborted = true; return; }
        for (let i = 0; i < vars.length; i++) if (cur[i]) hits[i]!++;
        return;
      }
      for (let val = 0 as 0 | 1; val <= 1; val++) {
        cur[pos] = val;
        let ok = true;
        for (const ci of varCons[pos]!) {
          assigned[ci]! += val;
          left[ci]!--;
          if (assigned[ci]! > csum[ci]! || assigned[ci]! + left[ci]! < csum[ci]!) ok = false;
        }
        if (ok) dfs(pos + 1);
        for (const ci of varCons[pos]!) { assigned[ci]! -= val; left[ci]!++; }
        if (aborted) return;
      }
    };
    dfs(0);

    if (aborted || solutions === 0) continue;
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i]!;
      if (k[v] !== UNKNOWN) continue;
      if (hits[i] === 0) { k[v] = SAFE; safe.push(v); progress = true; }
      else if (hits[i] === solutions) { k[v] = MINE; mine.push(v); progress = true; }
    }
  }
  return progress;
}

export interface Deduction { safe: number[]; mine: number[] }

/** One full round of every rule, cheapest first. Mutates `known`. */
export function deduceOnce(b: Board, k: Int8Array, sonar: Sonar[]): Deduction {
  const safe: number[] = [];
  const mine: number[] = [];
  const cons = buildConstraints(b, k, sonar);

  let hit = false;
  for (const c of cons) if (applyTrivial(c, k, safe, mine)) hit = true;
  if (hit) return { safe, mine };

  if (applySubset(cons, k, safe, mine)) return { safe, mine };

  // Global budget: when every remaining mine is already accounted for, the
  // whole rest of the rock is safe. Only ever useful at the endgame.
  let remaining = b.mineTotal;
  const unknowns: number[] = [];
  for (const i of b.hullCells) {
    if (k[i] === MINE) remaining--;
    else if (isVariable(b, k, i)) unknowns.push(i);
  }
  if (remaining <= 0 && unknowns.length) {
    for (const v of unknowns) { k[v] = SAFE; safe.push(v); }
    return { safe, mine };
  }
  if (remaining === unknowns.length && unknowns.length) {
    for (const v of unknowns) { k[v] = MINE; mine.push(v); }
    return { safe, mine };
  }

  applyEnumeration(cons, k, safe, mine);
  return { safe, mine };
}

/** Run every rule to a fixpoint against the board as it stands. */
export function deduceAll(b: Board, sonar: Sonar[]): Deduction {
  const k = makeKnown(b);
  const safe: number[] = [];
  const mine: number[] = [];
  for (let round = 0; round < 400; round++) {
    const d = deduceOnce(b, k, sonar);
    if (!d.safe.length && !d.mine.length) break;
    safe.push(...d.safe);
    mine.push(...d.mine);
  }
  return {
    safe: safe.filter((i) => b.state[i]! <= FLAGGED),
    mine: mine.filter((i) => b.state[i]! <= FLAGGED),
  };
}

/** The next provably safe cell a stuck player could dig.
 *
 *  A core that has become reachable comes first: cores are known safe from the
 *  opening frame, so they are never *deduced* and would otherwise never be
 *  offered — yet digging one is always the best available move. After that,
 *  prefer a cell that opens a pocket over one that reveals a single number. */
export function findHint(b: Board, sonar: Sonar[]): number | null {
  for (const c of b.cores) {
    if (b.state[c] === COVERED && isDiggable(b, c)) return c;
  }
  const d = deduceAll(b, sonar);
  const cand = d.safe.filter((i) => b.state[i] === COVERED);
  if (!cand.length) return null;
  cand.sort((a, c) => b.count[a]! - b.count[c]!);
  return cand[0]!;
}
