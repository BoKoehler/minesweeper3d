import type { AircraftState } from './dynamics';
import { KT_TO_MS } from './atmosphere';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A small PI controller with anti-windup. Integral terms matter here: a pure
 *  proportional altitude hold settles with a permanent error, which shows up as
 *  an aeroplane that quietly descends all the way to the ground. */
class PI {
  private i = 0;
  constructor(private kp: number, private ki: number, private limit: number) {}
  step(error: number, dt: number): number {
    const raw = this.kp * error + this.ki * this.i;
    // Only accumulate while the output is not saturated.
    if (Math.abs(raw) < this.limit) this.i += error * dt;
    return clamp(this.kp * error + this.ki * this.i, -this.limit, this.limit);
  }
  reset(): void { this.i = 0; }
}

export interface AutopilotState {
  master: boolean;
  altitudeHold: boolean;
  headingHold: boolean;
  speedHold: boolean;
  targetAltitude: number;
  targetHeading: number;
  targetSpeed: number;
  /** Set when the pilot moves a control, so the autopilot lets go. */
  disengagedReason: string;
}

export function newAutopilot(): AutopilotState {
  return {
    master: false, altitudeHold: true, headingHold: true, speedHold: false,
    targetAltitude: 1000, targetHeading: 0, targetSpeed: 60, disengagedReason: '',
  };
}

/** Shortest signed angular difference, radians. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Autopilot {
  readonly state = newAutopilot();
  // Inner loops are deliberately soft with strong rate damping. A stiff
  // proportional gain on bank saturates the ailerons, and full aileron for two
  // seconds is 120 degrees of roll — the autopilot rolls the aeroplane onto its
  // back chasing a heading change.
  private vsToPitch = new PI(0.030, 0.011, 0.30);
  private pitchToElev = new PI(3.2, 0.9, 0.85);
  private bankToAil = new PI(1.5, 0.22, 0.8);
  private speedToThr = new PI(0.075, 0.020, 1);

  engage(a: AircraftState): void {
    const s = this.state;
    s.master = true;
    s.disengagedReason = '';
    s.targetAltitude = Math.round(a.position.y / 30.48) * 30.48;
    s.targetHeading = a.telemetry.heading;
    s.targetSpeed = a.telemetry.indicatedAirspeed;
    this.vsToPitch.reset();
    this.pitchToElev.reset();
    this.bankToAil.reset();
    this.speedToThr.reset();
  }

  disengage(reason = 'disconnected'): void {
    this.state.master = false;
    this.state.disengagedReason = reason;
  }

  /** Hand the surfaces back neutral. Leaving the last commanded deflection on
   *  the elevator after a disconnect is how an autopilot fault becomes a
   *  crash. */
  release(a: AircraftState): void {
    a.controls.pitch = 0;
    a.controls.roll = 0;
    a.controls.yaw = 0;
  }

  /** Writes directly into the aircraft's controls. Cascaded: altitude sets a
   *  vertical speed, vertical speed sets a pitch attitude, pitch sets the
   *  elevator. Each stage is clamped, so the autopilot cannot command an
   *  attitude the aeroplane would not survive. */
  update(a: AircraftState, dt: number): void {
    const s = this.state;
    if (!s.master) return;
    const t = a.telemetry;

    if (t.stalled || Math.abs(t.bank) > 1.2) {
      this.disengage('flight envelope');
      this.release(a);
      return;
    }

    if (s.altitudeHold) {
      // Never demand a climb the aeroplane cannot sustain. Asking a 180 hp
      // single for 12 m/s means full nose-up, a decaying airspeed and a stall
      // — the autopilot flying it into the ground while holding the target.
      const cap = a.config.maxClimb;
      const vsWanted = clamp((s.targetAltitude - a.position.y) * 0.09, -cap * 1.4, cap);
      let pitchWanted = this.vsToPitch.step(vsWanted - t.verticalSpeed, dt);

      // Envelope protection: as speed decays toward the stall, the climb
      // demand gives way to keeping the wing flying.
      const safe = a.config.speeds.stall * KT_TO_MS * 1.3;
      const margin = (t.indicatedAirspeed - safe) / safe;
      if (margin < 0) pitchWanted = Math.min(pitchWanted, margin * 1.6);

      a.controls.pitch = clamp(this.pitchToElev.step(pitchWanted - t.pitch, dt) - a.omega.x * 2.2, -1, 1);
    }

    if (s.headingHold) {
      const err = angleDelta(s.targetHeading, t.heading);
      const bankWanted = clamp(err * 1.2, -0.44, 0.44);
      a.controls.roll = clamp(this.bankToAil.step(bankWanted - t.bank, dt) + a.omega.z * 1.25, -1, 1);
      // Keep the ball centred; an uncoordinated autopilot feels like a bus.
      a.controls.yaw = clamp(-t.beta * 3.2 - a.omega.y * 0.4, -1, 1);
    }

    if (s.speedHold) {
      const err = s.targetSpeed - t.indicatedAirspeed;
      a.controls.throttle = clamp(0.5 + this.speedToThr.step(err, dt), 0, 1);
    }
  }
}

/** Wings-level, hold-this-heading stabilisation used by the bench and by the
 *  gentle "assist" flight mode. Separate from the autopilot because it is a
 *  damper, not a pilot: it never commands an altitude. */
export function stabilise(a: AircraftState, dt: number, targetPitch = 0): void {
  const t = a.telemetry;
  a.controls.pitch = clamp((targetPitch - t.pitch) * 4.0 - a.omega.x * 1.7, -1, 1);
  a.controls.roll = clamp(-t.bank * 3.0 + a.omega.z * 0.4, -1, 1);
  a.controls.yaw = clamp(-t.beta * 3.0, -1, 1);
  void dt;
}
