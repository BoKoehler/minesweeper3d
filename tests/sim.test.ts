import { describe, it, expect } from 'vitest';
import { atmosphere, indicatedAirspeed, MS_TO_KT, KT_TO_MS, M_TO_FT, RHO_SL } from '../src/sim/atmosphere';
import { SKYLARK, VECTOR, AIRCRAFT } from '../src/sim/aircraft';
import { createAircraft, advance, trimLevel, placeOnRunway, liftCoefficient, engineThrust, type GroundQuery } from '../src/sim/dynamics';
import { Autopilot, stabilise, angleDelta } from '../src/sim/autopilot';

const flat: GroundQuery = { elevation: () => 0, normal: (o) => { o.x = 0; o.y = 1; o.z = 0; } };

describe('atmosphere', () => {
  it('matches the standard atmosphere at sea level', () => {
    const a = atmosphere(0);
    expect(a.temperature).toBeCloseTo(288.15, 2);
    expect(a.pressure).toBeCloseTo(101325, 0);
    expect(a.density).toBeCloseTo(1.225, 3);
    expect(a.soundSpeed).toBeCloseTo(340.29, 1);
  });

  it('matches published values through the troposphere', () => {
    // ISA at 5000 m: 255.65 K, 54020 Pa, 0.7364 kg/m3.
    const a = atmosphere(5000);
    expect(a.temperature).toBeCloseTo(255.65, 1);
    expect(a.pressure / 54020).toBeCloseTo(1, 2);
    expect(a.density / 0.7364).toBeCloseTo(1, 2);
    // Above the tropopause the lapse stops.
    expect(atmosphere(14000).temperature).toBeCloseTo(216.65, 1);
  });

  it('separates indicated from true airspeed', () => {
    expect(indicatedAirspeed(100, RHO_SL)).toBeCloseTo(100, 6);
    // High and fast: the dial reads far less than the aeroplane is doing.
    const high = indicatedAirspeed(200, atmosphere(10000).density);
    expect(high).toBeLessThan(130);
    expect(high).toBeGreaterThan(110);
  });
});

describe('lift curve', () => {
  const wing = SKYLARK.surfaces[0]!;

  it('is linear below the stall', () => {
    const a = liftCoefficient(0.1, wing, 0);
    const b = liftCoefficient(0.2, wing, 0);
    expect((b - a) / 0.1).toBeCloseTo(wing.clAlpha, 0);
  });

  it('peaks near the stall angle and collapses past it', () => {
    let peak = -Infinity, peakAt = 0;
    for (let al = 0; al < 0.8; al += 0.002) {
      const cl = liftCoefficient(al, wing, 0);
      if (cl > peak) { peak = cl; peakAt = al; }
    }
    expect(peakAt).toBeGreaterThan(wing.alphaStall * 0.85);
    expect(peakAt).toBeLessThan(wing.alphaStall * 1.5);
    // A real aerofoil peaks around 1.4-1.7 and drops sharply after.
    expect(peak).toBeGreaterThan(1.25);
    expect(peak).toBeLessThan(1.85);
    expect(liftCoefficient(peakAt + 0.25, wing, 0)).toBeLessThan(peak * 0.75);
  });

  it('is antisymmetric enough to fly inverted, badly', () => {
    expect(liftCoefficient(-0.15, wing, 0)).toBeLessThan(0);
  });

  it('gains lift from flaps', () => {
    expect(liftCoefficient(0.05, wing, wing.flapLift!)).toBeGreaterThan(liftCoefficient(0.05, wing, 0) + 0.4);
  });
});

describe('engines', () => {
  it('gives a propeller most thrust at low speed', () => {
    const slow = engineThrust(SKYLARK, 1, 15, RHO_SL);
    const fast = engineThrust(SKYLARK, 1, 60, RHO_SL);
    expect(slow).toBeGreaterThan(fast);
    expect(slow).toBeLessThan(4000);
  });

  it('gives a turbofan roughly constant thrust with speed but less with height', () => {
    const low = engineThrust(VECTOR, 1, 120, RHO_SL);
    const fastLow = engineThrust(VECTOR, 1, 240, RHO_SL);
    expect(fastLow / low).toBeCloseTo(1, 1);
    expect(engineThrust(VECTOR, 1, 240, atmosphere(10000).density)).toBeLessThan(low * 0.6);
  });

  it('produces nothing without fuel', () => {
    const a = createAircraft(SKYLARK);
    trimLevel(a, 1000, 60, 0);
    a.fuel = 0;
    a.controls.throttle = 1;
    for (let i = 0; i < 600; i++) advance(a, 1 / 60, flat);
    expect(a.power).toBeLessThan(0.05);
  });
});

describe.each(AIRCRAFT.map((c) => [c.name, c] as const))('%s', (_name, cfg) => {
  it('holds a cruise close to its published speed', () => {
    const a = createAircraft(cfg);
    const alt = cfg.id === 'vector' ? 9000 : 2500;
    trimLevel(a, alt, cfg.speeds.cruise * KT_TO_MS * 0.75, 0);
    a.controls.throttle = 0.75;
    a.power = 0.75;
    const ap = new Autopilot();
    advance(a, 1 / 60, flat);
    ap.engage(a);
    ap.state.targetAltitude = alt;
    for (let t = 0; t < 400; t += 1 / 60) {
      ap.update(a, 1 / 60);
      a.controls.throttle = 0.75;
      advance(a, 1 / 60, flat);
    }
    const kt = a.telemetry.trueAirspeed * MS_TO_KT;
    expect(kt).toBeGreaterThan(cfg.speeds.cruise * 0.85);
    expect(kt).toBeLessThan(cfg.speeds.cruise * 1.25);
    // And it is actually holding the altitude, not mushing down.
    expect(Math.abs(a.position.y - alt)).toBeLessThan(120);
  });

  it('takes off, climbs, and does it in a sane distance', () => {
    const a = createAircraft(cfg);
    placeOnRunway(a, 0, 1.2, 0, 0);
    a.controls.parkingBrake = false;
    a.controls.throttle = 1;
    a.controls.flaps = 0.35;
    const vr = cfg.speeds.rotate * KT_TO_MS;
    let roll = -1;
    for (let t = 0; t < 90; t += 1 / 120) {
      a.controls.pitch = a.telemetry.indicatedAirspeed > vr
        ? Math.max(-1, Math.min(1, (0.14 - a.telemetry.pitch) * 4 - a.omega.x * 1.2)) : 0;
      a.controls.roll = Math.max(-1, Math.min(1, -a.telemetry.bank * 2.4));
      a.controls.yaw = Math.max(-1, Math.min(1, -a.telemetry.heading * 2));
      advance(a, 1 / 120, flat);
      if (roll < 0 && a.telemetry.radarAltitude > 2) { roll = Math.abs(a.position.z); a.controls.gear = false; }
      if (roll > 0 && a.telemetry.radarAltitude > 150) break;
    }
    expect(roll).toBeGreaterThan(80);
    expect(roll).toBeLessThan(1600);
    expect(a.telemetry.radarAltitude).toBeGreaterThan(150);
    expect(a.velocity.y).toBeGreaterThan(2);
  });

  it('stalls when slowed down, and recovers when the wing is unloaded', () => {
    // Hand-flown on purpose: the autopilot's envelope protection will not let
    // the aeroplane stall, which is the point of it.
    const a = createAircraft(cfg);
    trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS * 0.7, 0);
    a.controls.throttle = 0.02;
    a.power = 0.02;
    let stalledKt = 0;
    let target = 0.02;
    for (let t = 0; t < 240; t += 1 / 120) {
      // Hold height while the speed bleeds off: that is what drives the angle
      // of attack up to the break.
      target = Math.max(-0.1, Math.min(0.42, target + (0 - a.telemetry.verticalSpeed) * 0.0018));
      a.controls.pitch = Math.max(-1, Math.min(1, (target - a.telemetry.pitch) * 4 - a.omega.x * 1.8));
      a.controls.roll = Math.max(-1, Math.min(1, -a.telemetry.bank * 3 + a.omega.z * 0.8));
      a.controls.yaw = Math.max(-1, Math.min(1, -a.telemetry.beta * 3));
      a.controls.throttle = 0.02;
      advance(a, 1 / 120, flat);
      if (a.telemetry.stalled) { stalledKt = a.telemetry.indicatedAirspeed * MS_TO_KT; break; }
    }
    expect(stalledKt).toBeGreaterThan(cfg.speeds.stall * 0.8);
    expect(stalledKt).toBeLessThan(cfg.speeds.stall * 1.35);

    a.controls.throttle = 1;
    for (let t = 0; t < 25; t += 1 / 120) {
      a.controls.pitch = Math.max(-1, Math.min(1, (-0.06 - a.telemetry.pitch) * 3 - a.omega.x));
      a.controls.roll = Math.max(-1, Math.min(1, -a.telemetry.bank * 3));
      advance(a, 1 / 120, flat);
    }
    expect(a.telemetry.stalled).toBe(false);
  });

  it('damps a pitch disturbance instead of diverging', () => {
    const a = createAircraft(cfg);
    trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
    const ap = new Autopilot();
    advance(a, 1 / 120, flat);
    ap.engage(a);
    ap.state.targetAltitude = 3000;
    for (let t = 0; t < 25; t += 1 / 120) { ap.update(a, 1 / 120); advance(a, 1 / 120, flat); }
    const trimmed = a.controls.pitch;
    ap.disengage();
    a.omega.x = 0.15;
    let earlyRate = 0, lateRate = 0;
    for (let t = 0; t < 14; t += 1 / 120) {
      a.controls.pitch = trimmed;
      advance(a, 1 / 120, flat);
      if (t < 5) earlyRate = Math.max(earlyRate, Math.abs(a.omega.x));
      if (t > 8) lateRate = Math.max(lateRate, Math.abs(a.omega.x));
    }
    // The short-period oscillation must decay; that is static stability.
    expect(lateRate).toBeLessThan(earlyRate * 0.6);
  });

  it('damps roll rate once the stick is centred', () => {
    const a = createAircraft(cfg);
    trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
    for (let t = 0; t < 4; t += 1 / 120) { stabilise(a, 1 / 120); advance(a, 1 / 120, flat); }
    a.controls.roll = 0.7;
    for (let t = 0; t < 1.2; t += 1 / 120) advance(a, 1 / 120, flat);
    const atRelease = Math.abs(a.omega.z);
    expect(atRelease).toBeGreaterThan(0.15);
    a.controls.roll = 0;
    for (let t = 0; t < 3; t += 1 / 120) advance(a, 1 / 120, flat);
    expect(Math.abs(a.omega.z)).toBeLessThan(atRelease * 0.5);
  });

  it('sits still on the ground with the parking brake set', () => {
    const a = createAircraft(cfg);
    placeOnRunway(a, 0, 0, 0, 0);
    a.position.y = 3;
    for (let t = 0; t < 12; t += 1 / 120) advance(a, 1 / 120, flat);
    expect(a.telemetry.onGround).toBe(true);
    expect(a.telemetry.groundSpeed).toBeLessThan(0.6);
    // Resting on its gear, not sunk into the ground or bouncing.
    expect(Math.abs(a.telemetry.pitch)).toBeLessThan(0.2);
    expect(a.position.y).toBeGreaterThan(0.3);
  });

  it('burns fuel at a rate that gives a believable endurance', () => {
    const hours = cfg.fuelCapacity / (cfg.engine.fuelBurn * cfg.engine.rating * cfg.engines * 0.65) / 3600;
    expect(hours).toBeGreaterThan(1.5);
    expect(hours).toBeLessThan(9);
  });
});

describe('autopilot', () => {
  it('captures and holds a new altitude', () => {
    const a = createAircraft(SKYLARK);
    trimLevel(a, 1000, SKYLARK.speeds.cruise * KT_TO_MS, 0);
    a.controls.throttle = 0.8;
    a.power = 0.8;
    const ap = new Autopilot();
    advance(a, 1 / 60, flat);
    ap.engage(a);
    ap.state.targetAltitude = 1600;
    ap.state.targetHeading = Math.PI / 2;
    for (let t = 0; t < 300; t += 1 / 60) {
      ap.update(a, 1 / 60);
      a.controls.throttle = 0.8;
      advance(a, 1 / 60, flat);
    }
    expect(Math.abs(a.position.y - 1600)).toBeLessThan(80);
    expect(Math.abs(angleDelta(a.telemetry.heading, Math.PI / 2))).toBeLessThan(0.12);
  });

  it('lets go rather than fighting a stall', () => {
    const a = createAircraft(SKYLARK);
    trimLevel(a, 2000, 40 * KT_TO_MS, 0);
    const ap = new Autopilot();
    advance(a, 1 / 60, flat);
    ap.engage(a);
    a.controls.throttle = 0;
    for (let t = 0; t < 60 && ap.state.master; t += 1 / 60) { ap.update(a, 1 / 60); advance(a, 1 / 60, flat); }
    expect(ap.state.master).toBe(false);
  });
});

describe('angle helpers', () => {
  it('wraps the short way round', () => {
    expect(angleDelta(0.1, 6.2)).toBeCloseTo(0.1 + Math.PI * 2 - 6.2, 5);
    expect(angleDelta(6.2, 0.1)).toBeCloseTo(6.2 - Math.PI * 2 - 0.1, 5);
    expect(M_TO_FT).toBeCloseTo(3.2808, 3);
  });
});

describe('control sign conventions', () => {
  // These caught a real inversion: the ailerons were signed off each panel's
  // own side, so positive roll banked left and the autopilot rolled the
  // aeroplane onto its back chasing a right turn.
  const settle = (cfg: typeof SKYLARK, apply: (a: ReturnType<typeof createAircraft>) => void) => {
    const a = createAircraft(cfg);
    trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
    for (let t = 0; t < 1; t += 1 / 240) advance(a, 1 / 240, flat);
    apply(a);
    for (let t = 0; t < 1.5; t += 1 / 240) advance(a, 1 / 240, flat);
    return a;
  };

  it.each(AIRCRAFT.map((c) => [c.name, c] as const))('%s: right stick banks right', (_n, cfg) => {
    expect(settle(cfg, (a) => { a.controls.roll = 1; }).telemetry.bank).toBeGreaterThan(0.2);
    expect(settle(cfg, (a) => { a.controls.roll = -1; }).telemetry.bank).toBeLessThan(-0.2);
  });

  it.each(AIRCRAFT.map((c) => [c.name, c] as const))('%s: back stick pitches up', (_n, cfg) => {
    expect(settle(cfg, (a) => { a.controls.pitch = 1; }).telemetry.pitch).toBeGreaterThan(0.2);
    expect(settle(cfg, (a) => { a.controls.pitch = -1; }).telemetry.pitch).toBeLessThan(-0.2);
  });

  it.each(AIRCRAFT.map((c) => [c.name, c] as const))('%s: right rudder yaws right', (_n, cfg) => {
    const h = settle(cfg, (a) => { a.controls.yaw = 1; }).telemetry.heading;
    expect(h > Math.PI ? h - Math.PI * 2 : h).toBeGreaterThan(0.05);
  });

  it('is stable in yaw: a sideslip weathervanes back to centre', () => {
    const a = createAircraft(SKYLARK);
    trimLevel(a, 3000, SKYLARK.speeds.cruise * KT_TO_MS, 0);
    for (let t = 0; t < 1; t += 1 / 240) advance(a, 1 / 240, flat);
    a.controls.yaw = 0.7;
    for (let t = 0; t < 1.5; t += 1 / 240) advance(a, 1 / 240, flat);
    const slip = Math.abs(a.telemetry.beta);
    expect(slip).toBeGreaterThan(0.01);
    a.controls.yaw = 0;
    for (let t = 0; t < 6; t += 1 / 240) advance(a, 1 / 240, flat);
    expect(Math.abs(a.telemetry.beta)).toBeLessThan(slip * 0.6);
  });
});
