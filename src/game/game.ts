import { COVERED, FLAGGED, REVEALED, DESTROYED, EXTRACTED } from '../core/grid';
import {
  type Board, type BlastResult, blast, isDiggable, reveal, toggleFlag,
} from '../core/board';
import { generate } from '../core/generate';
import { findHint, sonarValue, type Sonar } from '../core/solver';
import { hashSeed } from '../core/rng';
import { type Tier, tierById } from './tiers';

export type Phase = 'playing' | 'won' | 'lost';

export type DigOutcome =
  | { kind: 'illegal' }
  | { kind: 'opened'; cells: number[] }
  | { kind: 'extracted'; cell: number; cells: number[] }
  | { kind: 'detonated'; blast: BlastResult };

const CELLS_PER_CHARGE = 40;
/** A hint costs twenty cells of digging: enough to sting, not enough to end
 *  the run's scoring on a rock that has genuinely stalled. */
const HINT_COST = 100;

export class Game {
  readonly tier: Tier;
  readonly seedText: string;
  readonly board: Board;
  readonly sonar: Sonar[] = [];
  readonly generatedClean: boolean;

  phase: Phase = 'playing';
  hull: number;
  charges: number;
  revealedCount = 0;
  hintsUsed = 0;
  startedAt = performance.now();
  finishedAt: number | null = null;
  /** Why the run ended, for the end-of-run panel. */
  endReason = '';

  private chargeProgress = 0;

  constructor(tierId: string, seedText: string) {
    this.tier = tierById(tierId);
    this.seedText = seedText;
    const result = generate({ tier: this.tier, seed: hashSeed(seedText) });
    this.board = result.board;
    this.generatedClean = result.clean;
    this.hull = this.tier.hull;
    this.charges = this.tier.pings;
    this.revealedCount = this.countRevealed();
  }

  private countRevealed(): number {
    let n = 0;
    for (const i of this.board.hullCells) if (this.board.state[i]! >= REVEALED) n++;
    return n;
  }

  get coresExtracted(): number {
    return this.board.cores.filter((c) => this.board.state[c] === EXTRACTED).length;
  }

  get coresLost(): number {
    return this.board.cores.filter((c) => this.board.state[c] === DESTROYED).length;
  }

  get coresTotal(): number { return this.board.cores.length; }

  get flagsPlaced(): number {
    let n = 0;
    for (const i of this.board.hullCells) if (this.board.state[i] === FLAGGED) n++;
    return n;
  }

  get minesLeft(): number { return this.board.mineTotal - this.flagsPlaced; }

  get elapsedMs(): number { return (this.finishedAt ?? performance.now()) - this.startedAt; }

  /** Live score. Hull and unspent charges only pay out on a win, so playing
   *  safe is not rewarded unless you actually finish. */
  get score(): number {
    const base = this.revealedCount * 5 + this.coresExtracted * 1000 - this.hintsUsed * HINT_COST;
    const bonus = this.phase === 'won' ? this.hull * 500 + this.charges * 100 : 0;
    return Math.max(0, base + bonus);
  }

  private earnCharges(cells: number): void {
    this.chargeProgress += cells;
    while (this.chargeProgress >= CELLS_PER_CHARGE) {
      this.chargeProgress -= CELLS_PER_CHARGE;
      this.charges++;
    }
  }

  dig(i: number): DigOutcome {
    if (this.phase !== 'playing' || !isDiggable(this.board, i)) return { kind: 'illegal' };
    const b = this.board;

    if (b.mine[i] === 1) {
      const r = blast(b, i, this.tier.chainDepth);
      this.hull--;
      if (r.coresLost.length) {
        this.phase = 'lost';
        this.endReason = r.coresLost.length === 1
          ? 'A core went up with the blast.'
          : `${r.coresLost.length} cores went up with the blast.`;
      } else if (this.hull <= 0) {
        this.phase = 'lost';
        this.endReason = 'Hull integrity gone.';
      }
      return { kind: 'detonated', blast: r };
    }

    const isCore = b.core[i] === 1;
    const cells = reveal(b, i);
    this.revealedCount += cells.length;
    this.earnCharges(cells.length);

    if (isCore) {
      b.state[i] = EXTRACTED;
      this.charges += 2;
      if (this.coresExtracted === this.coresTotal) {
        this.phase = 'won';
        this.finishedAt = performance.now();
        this.endReason = 'Every core extracted.';
      }
      return { kind: 'extracted', cell: i, cells };
    }
    return { kind: 'opened', cells };
  }

  flag(i: number): boolean {
    if (this.phase !== 'playing') return false;
    if (this.board.state[i] === COVERED && !isDiggable(this.board, i)) return false;
    return toggleFlag(this.board, i);
  }

  /** Sonar reads the rock along one axis. Repeating a ping is free — it
   *  already told you what it knows. */
  ping(cell: number, axis: 0 | 1 | 2): number | null {
    if (this.phase !== 'playing' || this.board.hull[cell] !== 1) return null;
    const existing = this.sonar.find((s) => this.sameLine(s, cell, axis));
    if (existing) return sonarValue(this.board, existing);
    if (this.charges <= 0) return null;
    this.charges--;
    const s: Sonar = { cell, axis };
    this.sonar.push(s);
    return sonarValue(this.board, s);
  }

  private sameLine(s: Sonar, cell: number, axis: 0 | 1 | 2): boolean {
    if (s.axis !== axis) return false;
    const g = this.board.grid;
    if (axis === 0) return g.y(s.cell) === g.y(cell) && g.z(s.cell) === g.z(cell);
    if (axis === 1) return g.x(s.cell) === g.x(cell) && g.z(s.cell) === g.z(cell);
    return g.x(s.cell) === g.x(cell) && g.y(s.cell) === g.y(cell);
  }

  /** A provably safe dig, for when the rock has genuinely stalled. Costs
   *  score rather than being free, so it stays a rescue and not a strategy. */
  hint(): number | null {
    if (this.phase !== 'playing') return null;
    const cell = findHint(this.board, this.sonar);
    if (cell === null) return null;
    this.hintsUsed++;
    return cell;
  }

  /** Checked after a detonation resolves, so the loss lands after the effect. */
  settle(): void {
    if (this.phase !== 'playing') return;
    if (this.hull <= 0 || this.coresLost > 0) {
      this.phase = 'lost';
      this.finishedAt = performance.now();
    }
  }
}
