# Chondrite

A fully 3D minesweeper for the web. Minesweeper as an excavation, rebuilt from
the loop up so that the third dimension carries the puzzle instead of
decorating it.

TypeScript · Three.js · Vite. No backend, no assets, static deploy.

```bash
npm install
npm run dev      # play at localhost:5173
npm test         # 34 unit tests over the headless core
npm run build    # typecheck + production bundle into dist/
```

## The rules

- **A number counts mines among its six face-neighbours.** Not twenty-six. The
  constraint set is a cross along the axes — a shape you can name in full
  without rotating the camera, even when four arms are buried.
- **You can only dig cells that touch open space.** The diggable set is always
  the visible skin of your own excavation, so occlusion can never hide a legal
  move.
- **Extract the cores to win.** You never have to clear the board. Cores glow
  through the rock from the first frame; the safe route to one does not.
- **A mine costs hull, not the run.** A detonation destroys its cell and its six
  faces and chains through mines it catches. You get three hull points. A blast
  that takes a core ends the run.
- **Sonar reads one axis.** Spend a charge to learn how many mines lie on the
  axis-aligned line through a cell — a nonogram-style global constraint layered
  over the local crosses. It always fires along the axis you are sighting down,
  so snapping the camera *is* how you aim it.
- **The six cells touching a core are always clean.** That is what gives a route
  its last step.

## Controls

| | Mouse & keyboard | Touch |
|---|---|---|
| Orbit / zoom | drag / wheel | drag / pinch |
| Dig | left click | tap |
| Flag | right click, shift-click, or `F` | long press |
| Sonar | `S`, then click a cell | Sonar button, then tap |
| Sight down an axis | `1` `2` `3` | — |
| Peel outer layers | `[` `]` | — |
| X-ray | hold `space`, or `X` | X-ray button |
| Hint (provably safe, −100) | `H` | Hint button |

## Why six neighbours

Every 3D minesweeper counts the surrounding 3×3×3 shell of 26. That reliably
isn't fun, and the reason is not that the numbers get big. Minesweeper
deduction is *visual set overlap* — you watch two rings intersect and the
answer falls out. In a solid, a 26-cell constraint set is mostly buried behind
other covered cells: the set is not merely hard to read, it has no pixels.

Six-connectivity keeps the constraint set nameable, and collapses the pattern
vocabulary to three cases:

| Two readings are… | Cells they share |
|---|---|
| face-adjacent | 0 — but each is *inside* the other's set |
| two apart along an axis | 1, the cell between them |
| a diagonal step apart | 2 — the workhorse, this game's `1-2-1` |
| a body diagonal apart | 0 |

It also hands you a hard density floor for free. Zero-cells flood by face
adjacency, and 3D site percolation puts the threshold near `p_c ≈ 0.3116`
zero-cells; `(1-p)^6 = 0.3116` gives a minimum mine density of **17.7%**.
Measured, the knee lands exactly there: at 16% density one dig opens 55% of the
rock, at 18% it opens 14%. A test enforces the floor.

[`DESIGN.md`](DESIGN.md) has the full argument, the measurements, and what was
deliberately left unbuilt.

## Layout

```
src/
  core/     pure TypeScript, zero Three.js imports, unit-tested
    rng · grid · board · generate · solver
  game/     state machine over core: hull, charges, cores, scoring
  render/   scene · digits (instanced billboard atlas) · pick (voxel DDA)
  main.ts   input, HUD wiring, frame loop
scripts/
  measure.ts   percolation and generation tables (npx tsx scripts/measure.ts)
  smoke.mjs    drives the real game in Chromium and asserts on board state
```

Keeping `core/` free of Three.js is the load-bearing decision: it is what lets
the solver be tested headless in CI.

Picking is a voxel DDA march rather than an `InstancedMesh` raycast — `O(grid
dimension)` instead of `O(instances)`, and it has a property the design leans
on. DDA advances one axis at a time, so the cell before a hit is always
face-adjacent to it; the first solid cell a ray reaches is therefore *always* a
legal dig. Picking and the frontier rule agree by construction rather than by
check, and a property test pins it.

## Deploying

`.github/workflows/deploy.yml` tests, builds and publishes `dist/` to GitHub
Pages on every push. It needs Pages enabled once, with **Settings → Pages →
Source → GitHub Actions**. The bundle uses a relative base, so the same build
works on a project site, a user site, or `npm run preview` locally.
