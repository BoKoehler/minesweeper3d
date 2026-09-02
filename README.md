# Sierra

A flight simulator for the browser. Six-degree-of-freedom flight model, flown
from a working cockpit, over terrain, towns and airfields that are generated as
you reach them.

TypeScript · Three.js · Vite. No backend, no assets, static deploy.

**Live: https://bokoehler.github.io/minesweeper3d/**

```bash
npm install
npm run dev      # fly at localhost:5173
npm test         # 63 unit tests over the flight model and the world
npm run build    # typecheck + production bundle
```

## What is actually simulated

**The flight model is per-surface, not a set of rules.** Each wing panel, the
tailplane and the fin sample the airflow at their own position — including the
airframe's rotation, `v + ω × r`. That one term is where roll damping, pitch
damping, adverse yaw and spin resistance come from; none of them are written
anywhere. Stall is a sigmoid blend from the linear lift curve to flat-plate
behaviour, so it is recoverable by lowering the angle of attack and nothing
else. Gear legs are spring-dampers with separate rolling and lateral tyre
friction, which is what lets you taxi, and what bites on a crosswind landing.

Both aeroplanes match the machines they are modelled on. `npx tsx
scripts/flighttest.ts` reproduces this:

| | stall | cruise | takeoff roll | climb | endurance |
|---|---|---|---|---|---|
| Skylark 180 — piston single | 52 kt | 124 kt | 326 m | 867 fpm | 4.5 h |
| Vector 400 — light jet | 96 kt | 399 kt | 555 m | 3013 fpm | 2.5 h |

Air density comes from the standard atmosphere, so indicated airspeed falls
away from true with height, climb rate decays toward the ceiling, and the same
approach speed on the dial is a faster groundspeed at a mountain field.

The autopilot has envelope protection: it will not demand a climb the aeroplane
cannot sustain, gives way to airspeed near the stall, and releases the surfaces
to neutral on disconnect rather than leaving the elevator pinned.

## The world

Every part of it is a pure function of position and seed, so nothing is stored
and any coordinate can be evaluated on demand — by the terrain mesher, by the
landing-gear contact test and by the airport placer alike, which is why they
cannot disagree about where the ground is.

Measured over a 600 km square with `npx tsx scripts/worldstats.ts`:

- **Airfields every ~47 km**, from grass strips to international runways, each
  one flattened into the terrain to within a few centimetres along its length.
- **Settlements every ~13 km over land**, sized by a power law — hundreds of
  hamlets, a handful of cities. A uniform size distribution is the single thing
  that makes procedural towns read as fake from the air.
- A 250 km leg from the spawn field passes **30 settlements and 14 airfields**.

Terrain is a quadtree with skirted tiles, meshed nearest-first and warmed up
before the first frame. Cities are instanced: a near ring drawn building by
building, a far ring in coarser blocks that stand for a street each. Runway
markings — threshold bars, touchdown zone, aiming point, centreline and the
designator numbers — are painted onto a canvas, because that is what they are.

## Controls

| | Keyboard | Gamepad |
|---|---|---|
| Pitch / roll | `W` `S` / `A` `D` | Left stick |
| Rudder | `Q` `E` | `LB` `RB` |
| Throttle | `Shift` / `Ctrl` | `RT` |
| Brakes | `B`, `P` parking | `LT` |
| Gear, flaps | `G`, `F` / `V` | `A`, `X` / `Y` |
| Autopilot | `Tab` | `B` |
| Look around | right-drag, numpad | Right stick |
| View, centre head | `C`, `H` | `Back`, `R3` |
| Pause | `Esc` | `Start` |

Keyboard axes ramp rather than switch. A key that slams the stick to full
deflection makes an aeroplane unflyable; the ramp is what makes a keyboard feel
like a stick.

## Layout

```
src/
  world/    pure: noise, terrain field, airports, towns, ground queries
  sim/      pure: atmosphere, aircraft definitions, 6-DOF dynamics, autopilot
  render/   terrain quadtree, cities, airports, sky, cockpit, instruments
  input/    keyboard, mouse and gamepad blended into one set of axes
  main.ts   game loop, camera, HUD
scripts/
  flighttest.ts   flies the aeroplanes and reports against published figures
  worldstats.ts   measures terrain, airfield and settlement density
  smoke.mjs       drives the real simulator in Chromium
  look.mjs        screenshots a flight
```

`world/` and `sim/` import nothing from Three.js except its vector maths, so
the flight model and the world are tested headless in CI.

The cockpit is drawn in a second pass with its own near and far planes: the
world needs a 220 km depth range and that leaves nothing for a panel half a
metre from the eye.

## Deploying

`ci.yml` runs the tests and the build on every branch; `deploy.yml` publishes
to GitHub Pages. Pages must be switched on once by a repo admin under
*Settings → Pages → Source → GitHub Actions*.

The stylesheet is inlined into `index.html` at build time, so a missing CSS
request cannot reduce the page to unstyled markup, and a boot watchdog reports
why the simulator did not start rather than sitting on a spinner. WebGL is
probed before a world is generated.

---

This repository previously held *Chondrite*, a 3D minesweeper. Its design notes
are in [`docs/minesweeper/DESIGN.md`](docs/minesweeper/DESIGN.md) and the code
is in the history.
