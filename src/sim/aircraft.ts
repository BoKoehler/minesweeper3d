/** Aircraft definitions. The dynamics never special-case a type: an aeroplane
 *  is a mass, an inertia tensor, a set of lifting surfaces, an engine and some
 *  legs. Stall, spin, adverse yaw and pitch stability are consequences of the
 *  geometry below rather than rules written anywhere. */

export interface Surface {
  name: string;
  /** Aerodynamic centre in body axes relative to the CG. x right, y up, z aft. */
  pos: [number, number, number];
  /** Direction of positive lift in body axes. */
  liftAxis: [number, number, number];
  area: number;
  aspectRatio: number;
  /** Lift-curve slope, per radian. Thin-aerofoil theory gives about 2*PI. */
  clAlpha: number;
  cl0: number;
  /** Angle of attack where flow separates, radians. */
  alphaStall: number;
  cd0: number;
  /** Built-in rigging angle, radians. */
  incidence: number;
  /** Which control moves it, and how many radians of effective angle of attack
   *  full deflection is worth. */
  control?: 'pitch' | 'roll' | 'yaw' | 'flaps';
  controlGain?: number;
  /** Flaps add camber and drag on the wing panels only. */
  flapLift?: number;
  flapDrag?: number;
  /** Wing panels stall from the root first when they carry a washout twist,
   *  which keeps the ailerons flying a little past the break. */
  washout?: number;
}

export interface GearLeg {
  name: string;
  pos: [number, number, number];
  /** Spring rate N/m and damping N/(m/s). */
  spring: number;
  damper: number;
  travel: number;
  steerable: boolean;
  braked: boolean;
}

export interface Engine {
  kind: 'prop' | 'jet';
  /** Prop: shaft power in watts at sea level. Jet: static thrust in newtons. */
  rating: number;
  /** Seconds to spool from idle to full. Jets are famously slow. */
  spool: number;
  /** Propeller efficiency, or jet thrust lapse exponent with density. */
  efficiency: number;
  /** Prop only: thrust is capped near zero airspeed by disc loading. */
  staticThrust?: number;
  maxRpm?: number;
  idleRpm?: number;
  fuelBurn: number;
}

export interface AircraftConfig {
  id: string;
  name: string;
  role: string;
  mass: number;
  fuelCapacity: number;
  /** Moments of inertia about the body x (roll), y (yaw), z (pitch) axes.
   *  Body axes here are Three.js style: x right, y up, z aft, nose along -z. */
  inertia: [number, number, number];
  surfaces: Surface[];
  gear: GearLeg[];
  engine: Engine;
  engines: number;
  /** Fuel is carried in kilograms and burns off, so the aeroplane gets lighter
   *  and climbs better as the flight goes on. `mass` excludes it. */
  /** Reference speeds in knots indicated, for the panel and the checklists. */
  speeds: { stall: number; stallFlaps: number; rotate: number; approach: number; cruise: number; never: number; gearMax: number; flapMax: number };
  /** Equivalent flat-plate drag area in m2 along body x (side), y (vertical)
   *  and z (fore-aft). Total CD0 is this plus the surfaces' own cd0, so these
   *  are checkable against a published drag polar rather than invented. */
  parasite: [number, number, number];
  /** Extra fore-aft flat-plate area with the gear extended, m2. */
  gearDrag: number;
  /** Best rate of climb, m/s. The autopilot will not ask for more than this. */
  maxClimb: number;
  /** Eye position in body axes, and where the panel sits relative to it. */
  eye: [number, number, number];
  serviceCeiling: number;
}

const WING = (side: -1 | 1, area: number, ar: number, x: number, z: number): Surface => ({
  name: side < 0 ? 'wing-left' : 'wing-right',
  pos: [side * x, -0.1, z],
  liftAxis: [0, 1, 0],
  area, aspectRatio: ar,
  clAlpha: 5.7, cl0: 0.18, alphaStall: 0.28, cd0: 0.011,
  incidence: 0.026,
  // Positive roll banks right, so the LEFT panel gets the extra angle of
  // attack. Signing this off the panel's own side gets it backwards.
  control: 'roll', controlGain: -side * 0.050,
  flapLift: 0.62, flapDrag: 0.055,
  washout: 0.035,
});

/** A four-seat piston single. Forgiving, slow enough to sightsee, and it will
 *  fit on the short strips the world is full of. */
export const SKYLARK: AircraftConfig = {
  id: 'skylark',
  name: 'Skylark 180',
  role: 'Piston single · 180 hp · short-field capable',
  mass: 995,
  fuelCapacity: 110,
  inertia: [1285, 2667, 1825],
  surfaces: [
    WING(-1, 8.1, 7.4, 2.55, 0.12),
    WING(1, 8.1, 7.4, 2.55, 0.12),
    {
      name: 'h-stab', pos: [0, 0.35, 4.25], liftAxis: [0, 1, 0],
      area: 2.0, aspectRatio: 4.1, clAlpha: 4.3, cl0: 0, alphaStall: 0.34, cd0: 0.012,
      incidence: -0.028, control: 'pitch', controlGain: -0.42,
    },
    {
      name: 'v-stab', pos: [0, 0.6, 4.35], liftAxis: [1, 0, 0],
      area: 1.15, aspectRatio: 2.2, clAlpha: 3.6, cl0: 0, alphaStall: 0.36, cd0: 0.013,
      incidence: 0, control: 'yaw', controlGain: -0.40,
    },
  ],
  gear: [
    { name: 'nose', pos: [0, -1.05, -1.35], spring: 30000, damper: 4200, travel: 0.30, steerable: true, braked: false },
    { name: 'main-left', pos: [-1.35, -1.15, 0.55], spring: 52000, damper: 6200, travel: 0.24, steerable: false, braked: true },
    { name: 'main-right', pos: [1.35, -1.15, 0.55], spring: 52000, damper: 6200, travel: 0.24, steerable: false, braked: true },
  ],
  engine: {
    kind: 'prop', rating: 134000, spool: 0.9, efficiency: 0.80,
    staticThrust: 3400, maxRpm: 2700, idleRpm: 650, fuelBurn: 7.8e-8,
  },
  engines: 1,
  speeds: { stall: 48, stallFlaps: 40, rotate: 55, approach: 65, cruise: 120, never: 163, gearMax: 999, flapMax: 85 },
  // CD0 ~0.032 on 16.2 m2 of wing: 0.22 from the surfaces, 0.20 fuselage,
  // 0.10 for the fixed gear and struts.
  parasite: [1.45, 1.9, 0.20],
  gearDrag: 0.10,
  maxClimb: 4.6,
  eye: [0, 0.42, -0.15],
  serviceCeiling: 4300,
};

/** A light business jet: fast, slippery, and unforgiving of a rushed approach.
 *  Same physics, different numbers. */
export const VECTOR: AircraftConfig = {
  id: 'vector',
  name: 'Vector 400',
  role: 'Light jet · twin turbofan · FL410',
  mass: 4300,
  fuelCapacity: 1600,
  inertia: [8100, 15400, 11200],
  surfaces: [
    { ...WING(-1, 14.6, 8.2, 3.4, 0.35), controlGain: 0.030, clAlpha: 5.4, alphaStall: 0.245, cd0: 0.0082, flapLift: 0.5, flapDrag: 0.06 },
    { ...WING(1, 14.6, 8.2, 3.4, 0.35), controlGain: -0.030, clAlpha: 5.4, alphaStall: 0.245, cd0: 0.0082, flapLift: 0.5, flapDrag: 0.06 },
    {
      name: 'h-stab', pos: [0, 1.9, 6.6], liftAxis: [0, 1, 0],
      area: 4.4, aspectRatio: 4.4, clAlpha: 4.4, cl0: 0, alphaStall: 0.32, cd0: 0.010,
      incidence: -0.022, control: 'pitch', controlGain: -0.36,
    },
    {
      name: 'v-stab', pos: [0, 1.5, 6.7], liftAxis: [1, 0, 0],
      area: 3.1, aspectRatio: 1.6, clAlpha: 3.2, cl0: 0, alphaStall: 0.38, cd0: 0.011,
      incidence: 0, control: 'yaw', controlGain: -0.34,
    },
  ],
  gear: [
    { name: 'nose', pos: [0, -1.35, -3.1], spring: 120000, damper: 16000, travel: 0.36, steerable: true, braked: false },
    { name: 'main-left', pos: [-2.0, -1.45, 0.9], spring: 240000, damper: 28000, travel: 0.30, steerable: false, braked: true },
    { name: 'main-right', pos: [2.0, -1.45, 0.9], spring: 240000, damper: 28000, travel: 0.30, steerable: false, braked: true },
  ],
  engine: { kind: 'jet', rating: 13800, spool: 3.4, efficiency: 0.72, fuelBurn: 1.0e-5 },
  engines: 2,
  speeds: { stall: 92, stallFlaps: 78, rotate: 118, approach: 128, cruise: 400, never: 340, gearMax: 200, flapMax: 175 },
  // CD0 ~0.021 on 29.2 m2: a clean airframe, which is why it wants so much
  // runway to slow down and so little power to stay fast.
  parasite: [2.6, 3.2, 0.29],
  gearDrag: 0.33,
  maxClimb: 16,
  eye: [0, 0.55, -2.2],
  serviceCeiling: 12500,
};

export const AIRCRAFT: AircraftConfig[] = [SKYLARK, VECTOR];
export const aircraftById = (id: string): AircraftConfig => AIRCRAFT.find((a) => a.id === id) ?? SKYLARK;
