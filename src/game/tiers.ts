export interface Tier {
  id: string;
  name: string;
  blurb: string;
  n: number;
  /** Mine density. Must stay above ~0.18: below the 3D site-percolation
   *  threshold the zero-cells connect and one dig unzips the whole rock. */
  density: number;
  cores: number;
  pings: number;
  hull: number;
  chainDepth: number;
}

export const TIERS: Tier[] = [
  { id: 'survey',   name: 'Survey',    blurb: 'Learn the cross.',            n: 8,  density: 0.19, cores: 2, pings: 4, hull: 3, chainDepth: 1 },
  { id: 'prospect', name: 'Prospect',  blurb: 'Sonar starts to matter.',     n: 12, density: 0.21, cores: 3, pings: 5, hull: 3, chainDepth: 2 },
  { id: 'deepcore', name: 'Deep Core', blurb: 'The tier it is designed at.', n: 16, density: 0.23, cores: 4, pings: 6, hull: 3, chainDepth: 2 },
  { id: 'abyssal',  name: 'Abyssal',   blurb: 'Two hull points. Good luck.', n: 20, density: 0.25, cores: 5, pings: 6, hull: 2, chainDepth: 2 },
];

export function tierById(id: string): Tier {
  return TIERS.find((t) => t.id === id) ?? TIERS[2]!;
}
