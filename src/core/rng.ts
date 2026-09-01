/** Deterministic PRNG. A seed reproduces a run exactly, which is what makes
 *  shareable seeds and a daily challenge possible with no backend. */
export interface Rng {
  next(): number;
  int(n: number): number;
  range(lo: number, hi: number): number;
  shuffle<T>(a: T[]): T[];
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    range: (lo, hi) => lo + next() * (hi - lo),
    shuffle<T>(a: T[]): T[] {
      for (let i = a.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
      }
      return a;
    },
  };
}

/** Stable string -> 32-bit seed, so "chondrite" always means the same rock. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const WORDS = [
  'ceres', 'vesta', 'pallas', 'juno', 'iris', 'flora', 'metis', 'hygiea',
  'eros', 'ida', 'gaspra', 'mathilde', 'bennu', 'ryugu', 'itokawa', 'psyche',
  'lutetia', 'steins', 'braille', 'annefrank', 'kleopatra', 'davida',
];

/** Pronounceable seed strings beat raw integers when people share runs. */
export function randomSeedWord(): string {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)]!;
  return `${w}-${Math.floor(Math.random() * 9000 + 1000)}`;
}
