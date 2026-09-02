/** Flight-model bench. Flies the aeroplane the way a test pilot would and
 *  reports numbers you can check against the real machine it is modelled on.
 *  Run: npx tsx scripts/flighttest.ts */
import { Vector3 } from 'three';
import { SKYLARK, VECTOR, type AircraftConfig } from '../src/sim/aircraft';
import {
  createAircraft, advance, placeOnRunway, trimLevel, surfaceForce,
  type AircraftState, type GroundQuery,
} from '../src/sim/dynamics';
import { atmosphere, MS_TO_KT, M_TO_FT, KT_TO_MS } from '../src/sim/atmosphere';
import { Autopilot, stabilise } from '../src/sim/autopilot';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const flat = (h: number): GroundQuery => ({
  elevation: () => h,
  normal: (out) => { out.x = 0; out.y = 1; out.z = 0; },
});

/** Total body-axis aero force at a given airspeed and angle of attack. */
function aeroAt(cfg: AircraftConfig, tas: number, alpha: number, flaps: number, density: number): Vector3 {
  const vb = new Vector3(0, -Math.sin(alpha) * tas, -Math.cos(alpha) * tas);
  const total = new Vector3();
  const out = { force: new Vector3(), torque: new Vector3(), alpha: 0, cl: 0 };
  const ctl = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps, brakes: 0, gear: false, trim: 0, parkingBrake: false };
  for (const s of cfg.surfaces) {
    surfaceForce(s, vb, new Vector3(), density, ctl, 0.5, out);
    total.add(out.force);
  }
  return total;
}

/** Lowest speed at which the wing can still hold the aeroplane up. */
function stallSpeed(cfg: AircraftConfig, flaps: number, altitude = 0): number {
  const density = atmosphere(altitude).density;
  const weight = (cfg.mass + cfg.fuelCapacity) * 9.80665;
  for (let kt = 25; kt < 220; kt += 0.25) {
    const tas = kt * KT_TO_MS;
    let best = -Infinity;
    for (let a = 0; a < 0.45; a += 0.004) {
      const lift = aeroAt(cfg, tas, a, flaps, density).y;
      if (lift > best) best = lift;
    }
    if (best >= weight) return kt;
  }
  return NaN;
}

/** Hold an altitude with the elevator and let the speed settle where thrust
 *  and drag balance. Flown, not clamped: pinning the altitude by hand distorts
 *  the trim state and reports a speed the aeroplane never actually reaches. */
function cruiseSpeed(cfg: AircraftConfig, altitude: number, throttle: number): { kt: number; ktIAS: number; fpm: number } {
  const a = createAircraft(cfg);
  trimLevel(a, altitude, cfg.speeds.cruise * KT_TO_MS * 0.75, 0);
  a.controls.throttle = throttle;
  a.power = throttle;
  const ground = flat(0);
  const ap = new Autopilot();
  advance(a, 1 / 60, ground);
  ap.engage(a);
  ap.state.targetAltitude = altitude;
  for (let t = 0; t < 600; t += 1 / 60) {
    ap.update(a, 1 / 60);
    a.controls.throttle = throttle;
    advance(a, 1 / 60, ground);
  }
  return {
    kt: a.telemetry.trueAirspeed * MS_TO_KT,
    ktIAS: a.telemetry.indicatedAirspeed * MS_TO_KT,
    fpm: a.velocity.y * M_TO_FT * 60,
  };
}

/** Idle power, wings level, and the nose eased up until the break — the way a
 *  stall is actually demonstrated. Hand-flown, because the autopilot's
 *  envelope protection exists precisely to stop this happening. */
function stallTest(cfg: AircraftConfig, flaps: number): { kt: number; alphaDeg: number; recovers: boolean; dropped: number } {
  const a = createAircraft(cfg);
  const alt = 3000;
  trimLevel(a, alt, cfg.speeds.cruise * KT_TO_MS * 0.7, 0);
  a.controls.throttle = 0.02;
  a.power = 0.02;
  a.controls.flaps = flaps;
  const ground = flat(0);
  let kt = NaN, alphaDeg = NaN, target = 0.02;
  for (let t = 0; t < 240; t += 1 / 120) {
    target = clamp(target + (0 - a.telemetry.verticalSpeed) * 0.0018, -0.1, 0.42);
    a.controls.pitch = clamp((target - a.telemetry.pitch) * 4 - a.omega.x * 1.8, -1, 1);
    a.controls.roll = clamp(-a.telemetry.bank * 3 + a.omega.z * 0.8, -1, 1);
    a.controls.yaw = clamp(-a.telemetry.beta * 3, -1, 1);
    a.controls.throttle = 0.02;
    a.controls.flaps = flaps;
    advance(a, 1 / 120, ground);
    if (a.telemetry.stalled) { kt = a.telemetry.indicatedAirspeed * MS_TO_KT; alphaDeg = (a.telemetry.alpha * 180) / Math.PI; break; }
  }
  if (!isFinite(kt)) return { kt: NaN, alphaDeg: NaN, recovers: false, dropped: 0 };
  const yAtStall = a.position.y;
  a.controls.throttle = 1;
  for (let t = 0; t < 20; t += 1 / 120) {
    a.controls.pitch = clamp((-0.06 - a.telemetry.pitch) * 3 - a.omega.x, -1, 1);
    a.controls.roll = clamp(-a.telemetry.bank * 3 + a.omega.z * 0.8, -1, 1);
    advance(a, 1 / 120, ground);
  }
  return { kt, alphaDeg, recovers: !a.telemetry.stalled, dropped: yAtStall - a.position.y };
}


/** Full-power takeoff from a standing start on a level runway. */
function takeoff(cfg: AircraftConfig): { roll: number; climbFpm: number; liftoffKt: number; ok: boolean } {
  const a = createAircraft(cfg);
  const ground = flat(0);
  placeOnRunway(a, 0, 1.2, 0, 0);
  a.controls.parkingBrake = false;
  a.controls.throttle = 1;
  a.controls.flaps = 0.35;
  const vr = cfg.speeds.rotate * KT_TO_MS;
  let roll = 0, liftoffKt = 0, airborneAt = -1;
  for (let t = 0; t < 120; t += 1 / 120) {
    const ias = a.telemetry.indicatedAirspeed;
    a.controls.pitch = ias > vr ? clamp((0.14 - a.telemetry.pitch) * 4 - a.omega.x * 1.2, -1, 1) : 0;
    a.controls.yaw = clamp(-a.telemetry.heading * 2, -1, 1);
    a.controls.roll = clamp(-a.telemetry.bank * 2.4, -1, 1);
    advance(a, 1 / 120, ground);
    if (airborneAt < 0 && a.telemetry.radarAltitude > 2.0) {
      airborneAt = t; roll = Math.abs(a.position.z); liftoffKt = ias * MS_TO_KT;
      a.controls.gear = false;
    }
    if (airborneAt > 0 && t - airborneAt > 12) break;
  }
  return { roll, climbFpm: a.velocity.y * M_TO_FT * 60, liftoffKt, ok: airborneAt > 0 };
}

/** Disturb the trimmed attitude and watch the oscillation decay.
 *
 *  A fixed "is it level after N seconds" check is the wrong test: the phugoid
 *  of a clean jet has a period near a minute, so a perfectly stable aeroplane
 *  fails it. What matters is whether successive peaks get smaller — the
 *  short-period mode should damp in seconds, the phugoid slowly. */
function stability(cfg: AircraftConfig): {
  shortPeriodDamps: boolean; phugoidDamps: boolean; firstPeakDeg: number; latePeakDeg: number; rollDamps: boolean;
} {
  const ground = flat(0);
  const a = createAircraft(cfg);
  trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
  const ap = new Autopilot();
  advance(a, 1 / 120, ground);
  ap.engage(a);
  ap.state.targetAltitude = 3000;
  for (let t = 0; t < 25; t += 1 / 120) { ap.update(a, 1 / 120); advance(a, 1 / 120, ground); }
  const trimmedElevator = a.controls.pitch;

  // Hands off, holding the trimmed elevator, then a pitch-rate nudge.
  ap.disengage();
  a.controls.roll = 0; a.controls.yaw = 0;
  a.omega.x = 0.15;
  let peakEarly = 0, peakLate = 0, peakRate = 0, rateAfter = 0;
  for (let t = 0; t < 80; t += 1 / 120) {
    a.controls.pitch = trimmedElevator;
    advance(a, 1 / 120, ground);
    const p = Math.abs(a.telemetry.pitch);
    if (t < 6) { peakEarly = Math.max(peakEarly, p); peakRate = Math.max(peakRate, Math.abs(a.omega.x)); }
    if (t > 6 && t < 12) rateAfter = Math.max(rateAfter, Math.abs(a.omega.x));
    if (t > 45) peakLate = Math.max(peakLate, p);
  }

  const b = createAircraft(cfg);
  trimLevel(b, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
  for (let t = 0; t < 4; t += 1 / 120) { stabilise(b, 1 / 120); advance(b, 1 / 120, ground); }
  b.controls.roll = 0.6;
  for (let t = 0; t < 1.2; t += 1 / 120) advance(b, 1 / 120, ground);
  b.controls.roll = 0;
  const rateAtRelease = Math.abs(b.omega.z);
  for (let t = 0; t < 3; t += 1 / 120) advance(b, 1 / 120, ground);

  return {
    // The pitch-rate oscillation must decay: that is the short-period mode.
    shortPeriodDamps: rateAfter < peakRate * 0.5,
    phugoidDamps: peakLate <= peakEarly * 1.05,
    firstPeakDeg: (peakEarly * 180) / Math.PI,
    latePeakDeg: (peakLate * 180) / Math.PI,
    rollDamps: Math.abs(b.omega.z) < rateAtRelease * 0.4,
  };
}

/** Time to roll through 60 degrees of bank with full aileron. */
function handling(cfg: AircraftConfig): { rollRate: number } {
  const ground = flat(0);
  const a = createAircraft(cfg);
  trimLevel(a, 3000, cfg.speeds.cruise * KT_TO_MS, 0);
  for (let t = 0; t < 3; t += 1 / 120) { stabilise(a, 1 / 120); advance(a, 1 / 120, ground); }
  a.controls.roll = 1; a.controls.pitch = 0;
  let elapsed = 0;
  while (Math.abs(a.telemetry.bank) < Math.PI / 3 && elapsed < 10) { advance(a, 1 / 120, ground); elapsed += 1 / 120; }
  return { rollRate: 60 / Math.max(elapsed, 1e-3) };
}

for (const cfg of [SKYLARK, VECTOR]) {
  console.log(`\n================ ${cfg.name} — ${cfg.role} ================`);
  const vs0 = stallSpeed(cfg, 0);
  const vs1 = stallSpeed(cfg, 1);
  console.log(`stall clean    ${vs0.toFixed(0)} kt   (spec ${cfg.speeds.stall})`);
  console.log(`stall flaps    ${vs1.toFixed(0)} kt   (spec ${cfg.speeds.stallFlaps})`);
  const alt = cfg.id === 'vector' ? 9000 : 2500;
  const cr = cruiseSpeed(cfg, alt, 0.75);
  console.log(`cruise @${alt}m  ${cr.kt.toFixed(0)} kt true / ${cr.ktIAS.toFixed(0)} kt indicated, holding ${cr.fpm.toFixed(0)} fpm  (spec ${cfg.speeds.cruise} kt)`);
  const sf = stallTest(cfg, 0);
  console.log(`stall, flown   breaks at ${sf.kt.toFixed(0)} kt IAS, ${sf.alphaDeg.toFixed(1)} deg AoA, lost ${sf.dropped.toFixed(0)} m; recovers: ${sf.recovers}`);
  const endurance = (cfg.fuelCapacity / (cfg.engine.fuelBurn * cfg.engine.rating * cfg.engines * 0.65)) / 3600;
  console.log(`endurance      ${endurance.toFixed(1)} h at 65% power  (fuel ${cfg.fuelCapacity} kg)`);
  const to = takeoff(cfg);
  console.log(`takeoff        ${to.ok ? `${to.roll.toFixed(0)} m roll, off at ${to.liftoffKt.toFixed(0)} kt, climbing ${to.climbFpm.toFixed(0)} fpm` : 'FAILED TO FLY'}`);
  const st = stability(cfg);
  console.log(`pitch damping  short period damps: ${st.shortPeriodDamps}   phugoid decays: ${st.phugoidDamps} (${st.firstPeakDeg.toFixed(0)} deg -> ${st.latePeakDeg.toFixed(0)} deg)`);
  console.log(`roll damping   rate decays after release: ${st.rollDamps}`);
  const hd = handling(cfg);
  console.log(`roll rate      ${hd.rollRate.toFixed(0)} deg/s to 60 deg of bank`);
}
