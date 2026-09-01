# Chondrite

A fully 3D minesweeper for the web — minesweeper as an excavation, rebuilt from
the loop up so that the third dimension is the point rather than the gimmick.

**Status: design only. No code yet.**

Read [`DESIGN.md`](DESIGN.md) for the full plan. The short version:

- **Numbers count six face-neighbours, not twenty-six.** A 26-cell constraint
  set is invisible inside a solid, and minesweeper deduction is visual set
  overlap. A six-armed cross is nameable at any camera angle.
- **Only exposed cells are diggable**, so every clickable cell is on the
  visible skin of your own excavation. Occlusion is solved by construction.
- **You extract cores, you don't clear the board.** Cores are visible from the
  start; the safe route to one is not. The volume becomes a routing problem.
- **A mine costs hull, not the run.** Detonations destroy their six neighbours
  and chain — destructive rather than terminal.
- **Sonar pings an axis** and reports the mines on that line, layering a
  nonogram-style global constraint over the local ones.

Planned stack: TypeScript + Vite + Three.js, no backend, seeded and shareable,
static deploy.
