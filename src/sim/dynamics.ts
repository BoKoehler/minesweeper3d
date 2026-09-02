import { Vector3, Quaternion } from 'three';
import { atmosphere, indicatedAirspeed, G, RHO_SL, type AirState } from './atmosphere';
import type { AircraftConfig, Surface } from './aircraft';

/** Body axes follow Three.js so the render transform is the physics transform:
 *  +x right, +y up, +z aft, nose along -z. Roll right is negative z-rate,
 *  pitch up is positive x-rate, yaw right is negative y-rate. */
const FWD = new Vector3(0, 0, -1);

export interface Controls {
  /** Positive is nose up (stick back). */
  pitch: number;
  /** Positive rolls right. */
  roll: number;
  /** Positive yaws right. */
  yaw: number;
  throttle: number;
  flaps: number;
  brakes: number;
  gear: boolean;
  /** Nose-up trim, holds an attitude hands-off. */
  trim: number;
  parkingBrake: boolean;
}

export function newControls(): Controls {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brakes: 0, gear: true, trim: 0, parkingBrake: true };
}

export interface Telemetry {
  /** Speeds in m/s unless named otherwise. */
  trueAirspeed: number;
  indicatedAirspeed: number;
  groundSpeed: number;
  verticalSpeed: number;
  altitude: number;
  radarAltitude: number;
  /** Radians. */
  alpha: number;
  beta: number;
  pitch: number;
  bank: number;
  heading: number;
  loadFactor: number;
  mach: number;
  density: number;
  stalled: boolean;
  /** Fraction of the stall angle currently being used, for the stall warner. */
  stallMargin: number;
  onGround: boolean;
  gearCompression: number[];
  thrust: number;
  rpm: number;
  n1: number;
  fuel: number;
  wow: boolean;
}

export interface AircraftState {
  config: AircraftConfig;
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  /** Body-frame angular rate, rad/s. */
  omega: Vector3;
  controls: Controls;
  /** 0..1 actual engine output, lagging the throttle lever. */
  power: number;
  fuel: number;
  crashed: boolean;
  crashReason: string;
  telemetry: Telemetry;
}

function emptyTelemetry(): Telemetry {
  return {
    trueAirspeed: 0, indicatedAirspeed: 0, groundSpeed: 0, verticalSpeed: 0, altitude: 0, radarAltitude: 0,
    alpha: 0, beta: 0, pitch: 0, bank: 0, heading: 0, loadFactor: 1, mach: 0, density: RHO_SL,
    stalled: false, stallMargin: 0, onGround: false, gearCompression: [], thrust: 0, rpm: 0, n1: 0, fuel: 0, wow: false,
  };
}

export function createAircraft(config: AircraftConfig): AircraftState {
  return {
    config,
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    omega: new Vector3(),
    controls: newControls(),
    power: 0,
    fuel: config.fuelCapacity,
    crashed: false,
    crashReason: '',
    telemetry: emptyTelemetry(),
  };
}

/** Lift coefficient with a real stall.
 *
 *  Below the break the surface follows the linear lift curve. Past it, flow
 *  separates and the surface behaves like a flat plate — lift collapses and
 *  keeps collapsing as the nose comes further up, which is what makes a stall
 *  recoverable by lowering the angle of attack and nothing else. The sigmoid
 *  blends the two so there is no discontinuity to trip the integrator. */
export function liftCoefficient(alpha: number, s: Surface, flapLift: number): number {
  const stall = s.alphaStall;
  // The blend is centred a little past the break so the peak of the curve
  // lands at alphaStall. Centring it on the break itself halves CLmax right
  // where it matters and puts the stall speed 20% high.
  const blend = 1 / (1 + Math.exp(-24 * (Math.abs(alpha) - stall - 0.055)));
  const attached = s.cl0 + flapLift + s.clAlpha * alpha;
  const plate = 2 * Math.sign(alpha) * Math.sin(alpha) * Math.sin(alpha) * Math.cos(alpha);
  return (1 - blend) * attached + blend * plate;
}

const OSWALD = 0.78;

export interface SurfaceForce { force: Vector3; torque: Vector3; alpha: number; cl: number }

const _vl = new Vector3();
const _r = new Vector3();
const _axis = new Vector3();
const _force = new Vector3();

/** Force and moment from one lifting surface, in body axes.
 *
 *  The surface samples the airflow at its own position, which already includes
 *  the aircraft's rotation (v + omega x r). That single term is where roll
 *  damping, pitch damping, spin resistance and the yaw-roll coupling all come
 *  from — none of them are modelled directly. */
export function surfaceForce(
  s: Surface, velocityBody: Vector3, omega: Vector3, density: number,
  controls: Controls, trimGain: number, out: SurfaceForce,
): SurfaceForce {
  _r.set(s.pos[0], s.pos[1], s.pos[2]);
  _vl.copy(velocityBody).add(_axis.copy(omega).cross(_r));
  _axis.set(s.liftAxis[0], s.liftAxis[1], s.liftAxis[2]);

  const f = _vl.dot(FWD);
  const l = _vl.dot(_axis);
  const v2 = f * f + l * l;
  out.alpha = 0; out.cl = 0;
  out.force.set(0, 0, 0);
  out.torque.set(0, 0, 0);
  if (v2 < 1e-6) return out;
  const v = Math.sqrt(v2);

  let deflection = 0;
  if (s.control === 'pitch') deflection = (controls.pitch + controls.trim * trimGain) * (s.controlGain ?? 0);
  else if (s.control === 'roll') deflection = controls.roll * (s.controlGain ?? 0);
  else if (s.control === 'yaw') deflection = controls.yaw * (s.controlGain ?? 0);

  const flapLift = (s.flapLift ?? 0) * controls.flaps;
  // Washout twists the tip down relative to the root, so the wing root gives up
  // first and the ailerons keep biting a little past the break.
  const alpha = Math.atan2(-l, f) + s.incidence + deflection - (s.washout ?? 0);
  out.alpha = alpha;

  const cl = liftCoefficient(alpha, s, flapLift);
  out.cl = cl;
  const cd = s.cd0 + (s.flapDrag ?? 0) * controls.flaps
    + (cl * cl) / (Math.PI * OSWALD * s.aspectRatio);

  const q = 0.5 * density * v2 * s.area;
  // In-plane basis: drag opposes the local wind, lift is perpendicular to it.
  const liftComp = q * cl;
  const dragComp = q * cd;
  const fx = (liftComp * -l + dragComp * -f) / v;   // along FWD
  const fy = (liftComp * f + dragComp * -l) / v;    // along liftAxis

  out.force.copy(FWD).multiplyScalar(fx).addScaledVector(_axis, fy);
  out.torque.copy(_r).cross(out.force);
  return out;
}

/** Thrust in newtons.
 *
 *  A propeller converts shaft power to thrust, so its thrust is highest at low
 *  speed and decays as the aeroplane accelerates — that is why a light single
 *  leaps off the runway and then runs out of climb. A turbofan is closer to
 *  constant thrust with speed but loses it with density. */
export function engineThrust(config: AircraftConfig, power: number, trueAirspeed: number, density: number): number {
  const e = config.engine;
  const ratio = density / RHO_SL;
  if (e.kind === 'jet') {
    return e.rating * config.engines * power * Math.pow(ratio, e.efficiency);
  }
  const shaft = e.rating * power * ratio;
  const v = Math.max(trueAirspeed, 1);
  const ideal = (shaft * e.efficiency) / v;
  return Math.min(ideal, (e.staticThrust ?? 3000) * config.engines * (0.35 + 0.65 * power) * ratio);
}

const _q = new Quaternion();
const _qi = new Quaternion();
const _vb = new Vector3();
const _accum = new Vector3();
const _torque = new Vector3();
const _tmp = new Vector3();
const _gearWorld = new Vector3();
const _gearVel = new Vector3();
const _sf: SurfaceForce = { force: new Vector3(), torque: new Vector3(), alpha: 0, cl: 0 };
const _air: AirState = { temperature: 0, pressure: 0, density: 0, soundSpeed: 0 };
const _normal = new Vector3();

export interface GroundQuery {
  elevation(x: number, z: number): number;
  normal(out: { x: number; y: number; z: number }, x: number, z: number): void;
}

/** One physics step. Called at a fixed rate from a fixed-step accumulator so
 *  the aeroplane behaves identically regardless of frame rate. */
export function stepAircraft(a: AircraftState, dt: number, ground: GroundQuery): void {
  const cfg = a.config;
  const c = a.controls;

  atmosphere(a.position.y, _air);
  const density = _air.density;

  // Engine lag. A lever is not a throttle: the engine takes time to follow.
  const demand = a.fuel > 0 ? c.throttle : 0;
  const rate = dt / Math.max(0.05, cfg.engine.spool);
  a.power += (demand - a.power) * Math.min(1, rate);

  const speed = a.velocity.length();
  const thrust = engineThrust(cfg, a.power, speed, density);
  a.fuel = Math.max(0, a.fuel - cfg.engine.fuelBurn * cfg.engine.rating * cfg.engines * a.power * dt);

  // World velocity into body axes.
  _qi.copy(a.orientation).invert();
  _vb.copy(a.velocity).applyQuaternion(_qi);

  _accum.set(0, 0, 0);
  _torque.set(0, 0, 0);

  let worstMargin = 0;
  let stalled = false;
  for (let i = 0; i < cfg.surfaces.length; i++) {
    const s = cfg.surfaces[i]!;
    surfaceForce(s, _vb, a.omega, density, c, 0.5, _sf);
    _accum.add(_sf.force);
    _torque.add(_sf.torque);
    if (s.liftAxis[1] === 1) {
      const m = Math.abs(_sf.alpha) / s.alphaStall;
      if (m > worstMargin) worstMargin = m;
      if (m >= 1) stalled = true;
    }
  }

  // Fuselage: parasite drag plus a little side area, which is what makes a
  // slip actually cost you something.
  const q = 0.5 * density;
  const par = cfg.parasite;
  _accum.x -= q * par[0] * _vb.x * Math.abs(_vb.x);
  _accum.y -= q * par[1] * _vb.y * Math.abs(_vb.y);
  _accum.z -= q * (par[2] + (c.gear ? cfg.gearDrag : 0)) * _vb.z * Math.abs(_vb.z);

  _accum.z -= thrust;   // thrust acts along -z, the nose

  // Aerodynamic damping in roll and yaw. The surfaces already give most of it;
  // this is the residual from the fuselage and is what stops a light aeroplane
  // rolling forever after a stick input.
  _torque.x -= a.omega.x * 900 * density * Math.max(1, speed) * cfg.mass * 4e-6;
  _torque.y -= a.omega.y * 1400 * density * Math.max(1, speed) * cfg.mass * 4e-6;
  _torque.z -= a.omega.z * 700 * density * Math.max(1, speed) * cfg.mass * 4e-6;

  // Gear: a spring-damper per leg, with tyre friction split along and across
  // the wheel. Sideways grip is what lets you taxi and what bites in a
  // crosswind landing.
  const compression: number[] = [];
  let anyContact = false;
  for (let i = 0; i < cfg.gear.length; i++) {
    const leg = cfg.gear[i]!;
    const retracted = !c.gear && cfg.speeds.gearMax < 900;
    _tmp.set(leg.pos[0], leg.pos[1], leg.pos[2]);
    _gearWorld.copy(_tmp).applyQuaternion(a.orientation).add(a.position);
    const gh = ground.elevation(_gearWorld.x, _gearWorld.z);
    const pen = gh - _gearWorld.y;
    compression.push(retracted ? 0 : Math.max(0, Math.min(leg.travel, pen)));
    if (retracted || pen <= 0) continue;
    anyContact = true;

    ground.normal(_normal, _gearWorld.x, _gearWorld.z);
    // Velocity of this leg, including the rotation of the airframe.
    _gearVel.copy(a.omega).cross(_tmp).applyQuaternion(a.orientation).add(a.velocity);
    const vn = _gearVel.dot(_normal);
    const springF = leg.spring * Math.min(pen, leg.travel * 2) - leg.damper * vn;
    if (springF <= 0) continue;

    _force.copy(_normal).multiplyScalar(springF);

    // Tyre friction: roll freely fore-aft unless braking, resist sideways.
    _tmp.set(0, 0, -1).applyQuaternion(a.orientation);
    _tmp.addScaledVector(_normal, -_tmp.dot(_normal)).normalize();
    const along = _gearVel.dot(_tmp);
    const lateralV = _gearVel.clone().addScaledVector(_normal, -vn).addScaledVector(_tmp, -along);

    const braking = leg.braked ? Math.max(c.brakes, c.parkingBrake ? 1 : 0) : 0;
    const rollMu = 0.022 + 0.62 * braking;
    _force.addScaledVector(_tmp, -Math.sign(along) * Math.min(Math.abs(along) * 400, springF * rollMu));
    const sideMu = 0.75;
    const lat = lateralV.length();
    if (lat > 1e-4) _force.addScaledVector(lateralV, -Math.min(springF * sideMu, lat * 900) / lat);

    // Nosewheel steering, blending out as the rudder takes over with speed.
    if (leg.steerable && speed < 60) {
      _tmp.set(1, 0, 0).applyQuaternion(a.orientation);
      _force.addScaledVector(_tmp, -c.yaw * springF * 0.55 * (1 - speed / 60));
    }

    _accum.add(_force.clone().applyQuaternion(_qi));
    _torque.add(new Vector3(leg.pos[0], leg.pos[1], leg.pos[2]).cross(_force.clone().applyQuaternion(_qi)));
  }

  // Gravity, in body axes.
  _tmp.set(0, -G * cfg.mass, 0).applyQuaternion(_qi);
  _accum.add(_tmp);

  const mass = cfg.mass + a.fuel;
  const accelBody = _accum.divideScalar(mass);

  // Euler's equations: the gyroscopic term is what makes a fast roll want to
  // pitch, and what makes a spin something you have to recover from.
  const I = cfg.inertia;
  const wx = a.omega.x, wy = a.omega.y, wz = a.omega.z;
  const domega = new Vector3(
    (_torque.x - (I[2] - I[1]) * wy * wz) / I[0],
    (_torque.y - (I[0] - I[2]) * wz * wx) / I[1],
    (_torque.z - (I[1] - I[0]) * wx * wy) / I[2],
  );
  a.omega.addScaledVector(domega, dt);

  // Semi-implicit Euler: integrate velocity first, then position with the new
  // velocity. Stable at the step sizes a stiff undercarriage needs.
  _tmp.copy(accelBody).applyQuaternion(a.orientation);
  a.velocity.addScaledVector(_tmp, dt);
  a.position.addScaledVector(a.velocity, dt);

  _q.set(a.omega.x * 0.5 * dt, a.omega.y * 0.5 * dt, a.omega.z * 0.5 * dt, 1);
  a.orientation.multiply(_q).normalize();

  // Hard floor: never let the airframe tunnel through terrain in one step.
  const gh = ground.elevation(a.position.x, a.position.z);
  const minY = gh + 0.4;
  if (a.position.y < minY) {
    a.position.y = minY;
    if (a.velocity.y < 0) a.velocity.y *= -0.05;
  }

  updateTelemetry(a, _air.density, _air.soundSpeed, accelBody, thrust, compression, anyContact, stalled, worstMargin, ground);
}

const _euler = new Vector3();

function updateTelemetry(
  a: AircraftState, density: number, soundSpeed: number, accelBody: Vector3, thrust: number,
  compression: number[], contact: boolean, stalled: boolean, margin: number, ground: GroundQuery,
): void {
  const t = a.telemetry;
  const cfg = a.config;
  _qi.copy(a.orientation).invert();
  _vb.copy(a.velocity).applyQuaternion(_qi);

  t.trueAirspeed = a.velocity.length();
  t.indicatedAirspeed = indicatedAirspeed(t.trueAirspeed, density);
  t.groundSpeed = Math.hypot(a.velocity.x, a.velocity.z);
  t.verticalSpeed = a.velocity.y;
  t.altitude = a.position.y;
  t.radarAltitude = a.position.y - ground.elevation(a.position.x, a.position.z);
  t.density = density;
  t.mach = t.trueAirspeed / soundSpeed;

  const f = -_vb.z;
  t.alpha = Math.abs(f) < 0.2 ? 0 : Math.atan2(-_vb.y, f);
  t.beta = t.trueAirspeed < 0.5 ? 0 : Math.asin(Math.max(-1, Math.min(1, _vb.x / t.trueAirspeed)));

  // Attitude straight off the orientation, no Euler-angle bookkeeping.
  _tmp.set(0, 0, -1).applyQuaternion(a.orientation);
  t.pitch = Math.asin(Math.max(-1, Math.min(1, _tmp.y)));
  t.heading = (Math.atan2(_tmp.x, -_tmp.z) + Math.PI * 2) % (Math.PI * 2);
  _euler.set(0, 1, 0).applyQuaternion(a.orientation);
  const right = new Vector3(1, 0, 0).applyQuaternion(a.orientation);
  t.bank = Math.atan2(right.y, _euler.y) * -1;

  t.loadFactor = contact ? 1 : (accelBody.y + G * Math.cos(t.pitch) * Math.cos(t.bank)) / G;
  t.stalled = stalled;
  t.stallMargin = margin;
  t.onGround = contact;
  t.wow = contact;
  t.gearCompression = compression;
  t.thrust = thrust;
  t.fuel = a.fuel;
  const e = cfg.engine;
  if (e.kind === 'prop') {
    t.rpm = (e.idleRpm ?? 600) + ((e.maxRpm ?? 2700) - (e.idleRpm ?? 600)) * a.power;
    t.n1 = 0;
  } else {
    t.rpm = 0;
    t.n1 = 22 + 78 * a.power;
  }
}

/** Advance by wall-clock time using fixed sub-steps, so the simulation is
 *  frame-rate independent: the same input produces the same flight path on a
 *  144 Hz monitor and a struggling laptop. */
export function advance(a: AircraftState, elapsed: number, ground: GroundQuery, hz = 240): number {
  const dt = 1 / hz;
  let remaining = Math.min(elapsed, 0.25);
  let steps = 0;
  while (remaining > 1e-6) {
    const h = Math.min(dt, remaining);
    stepAircraft(a, h, ground);
    remaining -= h;
    if (++steps > 200) break;
  }
  return steps;
}

/** Put the aeroplane on a runway, stopped, pointing down the centreline. */
export function placeOnRunway(a: AircraftState, x: number, y: number, z: number, headingRad: number): void {
  a.position.set(x, y, z);
  a.velocity.set(0, 0, 0);
  a.omega.set(0, 0, 0);
  a.orientation.setFromAxisAngle(new Vector3(0, 1, 0), -headingRad);
  a.power = 0;
  a.crashed = false;
  a.crashReason = '';
  a.controls = newControls();
}

/** Trim for level flight at a given speed and altitude: used to start a run in
 *  the air, and by the tests to check the aeroplane can actually hold a cruise. */
export function trimLevel(a: AircraftState, altitude: number, trueAirspeed: number, headingRad: number): void {
  a.position.set(a.position.x, altitude, a.position.z);
  a.orientation.setFromAxisAngle(new Vector3(0, 1, 0), -headingRad);
  a.velocity.set(0, 0, -trueAirspeed).applyQuaternion(a.orientation);
  a.omega.set(0, 0, 0);
  a.controls.gear = false;
  a.controls.parkingBrake = false;
  a.controls.throttle = 0.75;
  a.power = 0.75;
}
