# Chondrite — design plan

A fully 3D minesweeper for the web, rebuilt from the loop up.

**Status:** design, not yet implemented. Nothing in this repo runs.

---

## 1. Why the obvious port fails

Almost every "3D minesweeper" is a cube of cells where a number counts mines
among the 26 cells in the surrounding 3×3×3 shell. It reliably isn't fun, for
four reasons that compound:

1. **Occlusion.** Interior cells have no pixels. You cannot click what you
   cannot see, so these games bolt on layer sliders and the game becomes a
   file browser.
2. **The constraint set is unrenderable.** This is the real killer. In 2D, a
   `2` refers to eight cells that are all on screen, arranged in a ring you
   recognise instantly. In 3D, a `7` refers to 26 cells, most of which are
   buried behind other covered cells. Minesweeper deduction is *visual set
   overlap* — you see two rings intersect and the answer falls out. Take away
   the ability to see the set and what's left is mental bookkeeping.
3. **Clearing everything is a chore.** Expert 2D is 480 cells. A 16³ volume is
   4,096. Exhaustive clearing at that scale is work, not play.
4. **No edges.** 2D minesweeper openings lean on walls and corners. A solid
   interior gives you nothing to push off.

Rendering tricks fix (1). Nothing fixes (2) except changing the rule.

## 2. The rule change: 6-connectivity

**A revealed cell counts mines among its six face-adjacent neighbours only.**
Numbers run 0–6. The constraint set is a six-armed cross along the axes — a
shape you can name in full without rotating the camera, even when four of the
arms are buried.

This is not a simplification, it's a different and equally deep puzzle, because
the overlap structure changes into something small and learnable:

| Two revealed cells... | Cells their constraints share |
|---|---|
| face-adjacent (distance 1) | 0 — but each is *in* the other's set |
| two apart along an axis | exactly 1 (the cell between them) |
| a diagonal step apart (√2) | exactly 2 |
| a body diagonal apart (√3) | 0 |

So the whole pattern vocabulary is `0 / 1 / 2`. The 3D equivalent of the 2D
`1-2-1` is **the diagonal pair**: two readings a diagonal step apart constrain
exactly two shared cells. That's teachable in one tutorial beat and stays
useful for the whole game.

### Density has a hard floor

Flood-fill spreads through zero-cells via face adjacency. Site percolation on
the simple cubic lattice has a threshold around `p_c ≈ 0.3116`. If the fraction
of zero-cells exceeds that, zero-regions connect and a single click can unzip
the entire asteroid.

Fraction of zero-cells at mine density `p` is `(1-p)^6`. Setting that equal to
`p_c`:

```
(1 - p)^6 = 0.3116   →   p ≈ 0.177
```

**Mine density must stay above ~18%** or cascades run away. Convenient: that's
the same neighbourhood as classic minesweeper (Expert is 20.6%). At `p = 0.20`
the number distribution is `0: 26% · 1: 39% · 2: 25% · 3: 8%` — dominated by
1s and 2s, exactly like the 2D game.

(The threshold is for an infinite lattice; our hull is finite and irregular, so
treat ~18% as a floor to verify by simulation, not a proof.)

## 3. The other five rules

**Only exposed cells are diggable.** A cell can be dug if it is face-adjacent
to open space — excavated void or the outside. The diggable set is therefore
always the visible skin of your own excavation. Occlusion is solved by
construction, not by UI.

**You are not clearing the board, you are extracting cores.** Some cells are
cores. You win when every core is extracted. Nothing else needs to be dug. The
volume becomes a *routing* problem — choose an approach vector, tunnel toward
a target — which is a genuinely three-dimensional skill and the thing 2D
minesweeper cannot do.

**Cores are visible from the start; the route is not.** Cores render as marked
positions floating inside the rock. You always know where you're going. You
never know how to get there safely. This is the entire tension of the game in
one sentence, and it's legible in the first three seconds of looking at it.

**A mine costs hull, not the run.** You have 3 hull points. Detonating a mine
destroys that cell and its six face-neighbours, chain-reacting through any
mines caught in the blast. Losing the run to a single misclick after ten
minutes is minesweeper's worst property; three lives plus spectacular chain
detonations converts it into risk management. A blast that destroys a core
loses that core permanently — so recklessness near a target is punished
precisely where it should be.

**Sonar is the second information source.** Spend a charge to ping an
axis-aligned line through a chosen cell; it reports the total mines on that
line inside the hull. Charges are earned by clearing cells. Line sums layer a
global, nonogram-style constraint over the local cross constraints, and reading
them is natural in 3D — you sight down an axis, which is a camera move, not a
menu. This is the move that could not exist in the 2D game.

## 4. The loop

```
sight down an axis  →  ping  →  read the crosses  →  deduce  →  dig toward a core
       ↑                                                              │
       └──────────  the blast reshapes the frontier  ←── extract ─────┘
```

**First ninety seconds, concretely.** A rock hangs in space. Four brass markers
glow somewhere inside it. You click the surface; a pocket of cells dissolves
and leaves a small crater ringed with numbers. You snap the camera down the Z
axis, spend a ping, and learn there are 3 mines on the line running straight at
the nearest core. You flag two you're sure of, dig the third cell wrong, and a
chain detonation blows a cavity four cells deep — which is bad (hull 2 of 3)
and also useful, because the new frontier is much closer to the core than
anything you'd have dug by hand.

That "my mistake opened a shortcut" moment is the thing to build toward.

## 5. Tuning

Hulls are rough ellipsoids inscribed in the box, so cell count ≈ `(π/6)·n³`.

| Tier | Box | Hull cells | Density | Mines | Cores | Pings | Hull pts |
|---|---|---|---|---|---|---|---|
| Survey | 8³ | ~268 | 19% | 51 | 2 | 4 | 3 |
| Prospect | 12³ | ~905 | 21% | 190 | 3 | 5 | 3 |
| Deep Core | 16³ | ~2,145 | 23% | 493 | 4 | 6 | 3 |
| Abyssal | 20³ | ~4,189 | 25% | 1,047 | 5 | 6 | 2 |

Every tier stays above the 18% floor. Charges regenerate at 1 per 40 cells
cleared.

## 6. The quality bar: no forced guesses

Minesweeper is only fun when deduction is always available. This is the single
highest-risk item in the project and it gets built before any rendering.

**Generator loop.** Seeded RNG places mines and cores → the solver attempts a
full solve using only rules a human has → if it hits a forced guess, perturb
and retry → after N failures, reduce density and restart.

**Solver rules** (in escalating cost order):
1. **Trivial.** Count equals unknown neighbours → all mines. Count satisfied →
   all remaining safe.
2. **Subset.** For constraints `A ⊆ B`, `B\A` holds `n(B) - n(A)` mines;
   resolve when that equals `|B\A|` or `0`. With 6-connectivity these arise
   from the axis-pair and diagonal-pair overlaps in §2.
3. **Line sums.** Sonar readings enter the same constraint pool as ordinary
   linear constraints over 0/1 variables.
4. **Global count.** Total remaining mines constrains the whole frontier.
5. **Bounded enumeration.** Split the frontier into connected components; for
   components under ~22 unknowns, enumerate all consistent assignments exactly.
   Any cell that is a mine in 0% or 100% of them is forced.

**Additional guarantees.** First dig is always a zero-cell (opens a real
pocket). At generation time, at least one core is reachable by a
deduction-only route. Sonar is *sufficient but not required* — a tier should be
solvable without spending every charge, so charges stay a strategic resource
rather than a tax.

## 7. Architecture

Vite + TypeScript + Three.js (pinned), vanilla — no framework. HUD is a DOM
overlay. Vitest for the core. Static build, no backend, GitHub Pages.

```
src/
  core/      # pure TS, zero Three.js imports, fully unit-tested
    rng.ts        seeded PRNG (xoshiro128**) — a seed reproduces a run exactly
    grid.ts       hull shape, indexing, 6-neighbour iteration
    generate.ts   mine + core placement, retry loop
    solver.ts     the five rules in §6
    reveal.ts     flood fill, exposure/frontier maintenance
    blast.ts      detonation and chain resolution
  game/      # state machine over core: hull points, charges, scoring, phases
  render/    # three.js
    scene.ts, instances.ts, digits.ts, pick.ts, fx.ts
  ui/        # HUD, menus, seed share strings, tutorial
  main.ts
```

Keeping `core/` free of Three.js is the load-bearing decision: it is what makes
the solver testable in CI and lets generation run in a Worker.

### Performance budget

Worst case ~4,200 cells at 60fps on integrated graphics.

- **Instancing.** One `InstancedMesh` per visual class (covered, revealed,
  flagged, core). ~4 draw calls for the whole rock instead of 4,000.
- **Digits.** A 7-glyph atlas (0–6) on instanced quads, one draw call, drawn
  only on *exposed faces of revealed cells* — a few hundred, not thousands.
  Billboarded and depth-faded so they stay readable.
- **Picking.** Do **not** raycast the `InstancedMesh` — that's O(instances).
  March a DDA voxel ray through the grid instead: O(grid dimension), ~20–40
  steps, exact, and allocation-free.
- **Generation** runs in a Web Worker; the retry loop can take a while on
  Abyssal and must not block the frame.
- Target: <2 MB initial payload.

### Controls

| Action | Mouse / keyboard | Touch |
|---|---|---|
| Orbit / zoom | drag / wheel | one-finger drag / pinch |
| Dig | left click | tap |
| Flag | right click *or* shift-click | long press |
| Sonar ping | `S`, then click a cell and drag along an axis | ping button, then drag |
| Snap camera to axis | `1` `2` `3` | axis buttons |
| Peel outer layers | `[` `]` | slider |
| X-ray revealed cells | hold `Space` | toggle |

Axis snap is not a convenience — line sums are unreadable without it.

### Accessibility

Colourblind-safe digit palette *plus* distinct glyph weight, so colour is never
the only channel. Flags and cores differ in silhouette, not just hue. Full
keyboard play: the cursor walks the exposed frontier cell by cell.
`prefers-reduced-motion` disables camera shake and shortens dissolves.

## 8. Build order

| # | Milestone | Done when |
|---|---|---|
| 0 | Scaffold | Vite + TS + Vitest, CI, Pages deploy of a spinning cube |
| 1 | **Core, headless** | grid, RNG, generation, reveal, blast — no rendering, tests green |
| 2 | **Solver + generator** | seeded runs are provably guess-free; the retry loop terminates |
| 3 | Renderer | instanced voxels, DDA picking, orbit camera, hover highlight |
| 4 | Readability | digits, billboarding, x-ray, peel, axis snap |
| 5 | **Game layer** | cores, hull points, chain blasts, win/lose, sonar economy |
| 6 | **Playtest gate** | play it. Is it fun? Tune density, blast radius, charges *before* juice |
| 7 | Juice | shaders, dissolve, particles, shake, audio |
| 8 | Meta | daily seed, share strings, stats, tutorial, mobile pass |

Milestones 2 and 6 are the two places this project can quietly fail. 2 is
technical and 6 is honest — if the loop isn't fun at 6, the fix is design, not
more shaders.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Solver can't guarantee guess-free boards at Abyssal size | high | Build it at M2, before rendering. Fall back to per-component enumeration with a smaller cap and accept a lower tier ceiling |
| Interior state still unreadable despite peel/x-ray | high | Prototype readability at M4 with a throwaway scene before committing to the visual style |
| Cascades percolate anyway on irregular hulls | medium | Simulate zero-cluster sizes across seeds at M1; raise the density floor empirically |
| Digit rendering tanks framerate | medium | Atlas + instancing + exposed-face culling from the start; never `troika-three-text` per cell |
| Scope creep in juice | medium | M7 is timeboxed and comes after the playtest gate |
| The loop just isn't fun | high | That's what M6 is for, and it's early enough to change the design |

## 10. Open calls

1. **6-connectivity vs 18.** This plan commits to 6. 18 gives richer local
   constraints at the cost of the readable cross silhouette. Worth a one-day
   spike at M6 if 6 feels thin.
2. **Real-time pressure?** Extracting a core could destabilise the rock and
   start a countdown. Great for a climax, but it turns a pure puzzle into a
   pressure game. Currently out of scope; prototype at M6.
3. **Art direction.** Clean instrument/survey aesthetic, or chunky stylised
   voxel. Affects the shader budget in M7, nothing before it.
