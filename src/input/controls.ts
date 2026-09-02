/** Pilot input from keyboard, mouse and gamepad, blended into one set of axes.
 *
 *  Keyboard axes are ramped rather than switched. A key that slams the stick to
 *  full deflection makes an aeroplane unflyable — real controls move at the
 *  speed of an arm, and the ramp is what makes a keyboard feel like a stick. */

export interface InputAxes {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  brakes: number;
  headYaw: number;
  headPitch: number;
}

export interface InputEdges {
  toggleGear: boolean;
  flapsDown: boolean;
  flapsUp: boolean;
  toggleAutopilot: boolean;
  toggleParkingBrake: boolean;
  cycleView: boolean;
  trimUp: boolean;
  trimDown: boolean;
  pause: boolean;
  resetView: boolean;
}

const RAMP = 2.6;        // stick travel per second
const CENTRE = 3.4;      // return-to-centre rate when nothing is pressed
const THROTTLE_RATE = 0.55;

function approach(current: number, target: number, rate: number, dt: number): number {
  const d = target - current;
  const step = rate * dt;
  if (Math.abs(d) <= step) return target;
  return current + Math.sign(d) * step;
}

const DEAD = 0.12;
/** Squared response near centre: fine control where it matters, full authority
 *  still available at the stops. */
function shape(v: number): number {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  const t = (a - DEAD) / (1 - DEAD);
  return Math.sign(v) * t * t;
}

export class InputManager {
  readonly axes: InputAxes = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brakes: 0, headYaw: 0, headPitch: 0 };
  readonly edges: InputEdges = {
    toggleGear: false, flapsDown: false, flapsUp: false, toggleAutopilot: false,
    toggleParkingBrake: false, cycleView: false, trimUp: false, trimDown: false,
    pause: false, resetView: false,
  };
  gamepadConnected = false;
  gamepadName = '';
  /** True when the last input came from a gamepad, so the UI can say so. */
  lastDeviceGamepad = false;
  invertPitch = false;

  private keys = new Set<string>();
  private pressed = new Set<string>();
  private mouseLook = false;
  private headTarget = { yaw: 0, pitch: 0 };
  private prevButtons: boolean[] = [];
  private target = { element: null as HTMLElement | null };

  attach(element: HTMLElement): void {
    this.target.element = element;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepadconnected', this.onGamepad);
    window.addEventListener('gamepaddisconnected', this.onGamepadGone);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('gamepadconnected', this.onGamepad);
    window.removeEventListener('gamepaddisconnected', this.onGamepadGone);
  }

  private onGamepad = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    this.gamepadConnected = true;
    this.gamepadName = gp.id.replace(/\s*\([^)]*\)\s*/g, '').trim() || 'Gamepad';
  };
  private onGamepadGone = (): void => { this.gamepadConnected = false; };
  private onBlur = (): void => { this.keys.clear(); };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const code = e.code;
    if (!this.keys.has(code)) this.pressed.add(code);
    this.keys.add(code);
    this.lastDeviceGamepad = false;
    // Stop the browser scrolling the page out from under the aeroplane.
    if (code.startsWith('Arrow') || code === 'Space' || code === 'Tab') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) { this.mouseLook = true; e.preventDefault(); }
  };
  private onMouseUp = (e: MouseEvent): void => { if (e.button === 2) this.mouseLook = false; };
  private onMouseMove = (e: MouseEvent): void => {
    if (!this.mouseLook) return;
    this.headTarget.yaw = Math.max(-2.5, Math.min(2.5, this.headTarget.yaw - e.movementX * 0.004));
    this.headTarget.pitch = Math.max(-1.1, Math.min(1.1, this.headTarget.pitch - e.movementY * 0.004));
  };

  private held(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  private hit(...codes: string[]): boolean {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  private readGamepad(dt: number): boolean {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) { this.gamepadConnected = false; return false; }
    this.gamepadConnected = true;
    if (!this.gamepadName) this.gamepadName = gp.id.replace(/\s*\([^)]*\)\s*/g, '').trim() || 'Gamepad';

    const ax = gp.axes;
    const roll = shape(ax[0] ?? 0);
    const pitch = shape(ax[1] ?? 0) * (this.invertPitch ? -1 : 1);
    const lookX = shape(ax[2] ?? 0);
    const lookY = shape(ax[3] ?? 0);

    const btn = (i: number): number => gp.buttons[i]?.value ?? 0;
    const down = (i: number): boolean => gp.buttons[i]?.pressed ?? false;

    // Right trigger is the throttle, left is the brakes: the most direct
    // mapping there is, and it leaves both sticks for flying and looking.
    const rt = btn(7), lt = btn(6);
    const active = Math.abs(roll) + Math.abs(pitch) + rt + lt + Math.abs(lookX) + Math.abs(lookY);
    if (active > 0.02) this.lastDeviceGamepad = true;

    this.axes.roll = roll;
    this.axes.pitch = pitch;
    this.axes.throttle = rt;
    this.axes.brakes = lt;
    this.axes.yaw = (down(5) ? 1 : 0) - (down(4) ? 1 : 0);

    if (Math.abs(lookX) > 0 || Math.abs(lookY) > 0) {
      this.headTarget.yaw = Math.max(-2.5, Math.min(2.5, this.headTarget.yaw - lookX * 2.6 * dt));
      this.headTarget.pitch = Math.max(-1.1, Math.min(1.1, this.headTarget.pitch - lookY * 2.0 * dt));
    }

    const edge = (i: number): boolean => {
      const now = down(i);
      const was = this.prevButtons[i] ?? false;
      this.prevButtons[i] = now;
      return now && !was;
    };
    if (edge(0)) this.edges.toggleGear = true;
    if (edge(2)) this.edges.flapsDown = true;
    if (edge(3)) this.edges.flapsUp = true;
    if (edge(1)) this.edges.toggleAutopilot = true;
    if (edge(9)) this.edges.pause = true;
    if (edge(8)) this.edges.cycleView = true;
    if (edge(10)) this.edges.resetView = true;
    if (edge(12)) this.edges.trimUp = true;
    if (edge(13)) this.edges.trimDown = true;
    for (let i = 0; i < 16; i++) this.prevButtons[i] = down(i);
    return true;
  }

  update(dt: number): void {
    for (const k of Object.keys(this.edges) as (keyof InputEdges)[]) this.edges[k] = false;

    const usingPad = this.readGamepad(dt);
    const kbPitch = (this.held('KeyS', 'ArrowDown') ? 1 : 0) - (this.held('KeyW', 'ArrowUp') ? 1 : 0);
    const kbRoll = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const kbYaw = (this.held('KeyE') ? 1 : 0) - (this.held('KeyQ') ? 1 : 0);
    const keyboardActive = kbPitch !== 0 || kbRoll !== 0 || kbYaw !== 0;

    if (!usingPad || (!this.lastDeviceGamepad && keyboardActive)) {
      const p = kbPitch * (this.invertPitch ? -1 : 1);
      this.axes.pitch = approach(this.axes.pitch, p, p === 0 ? CENTRE : RAMP, dt);
      this.axes.roll = approach(this.axes.roll, kbRoll, kbRoll === 0 ? CENTRE : RAMP, dt);
      this.axes.yaw = approach(this.axes.yaw, kbYaw, kbYaw === 0 ? CENTRE : RAMP, dt);
      const thr = (this.held('ShiftLeft', 'ShiftRight', 'PageUp') ? 1 : 0) - (this.held('ControlLeft', 'ControlRight', 'PageDown') ? 1 : 0);
      if (thr !== 0) this.axes.throttle = Math.max(0, Math.min(1, this.axes.throttle + thr * THROTTLE_RATE * dt));
      this.axes.brakes = this.held('KeyB') ? 1 : 0;
    } else if (keyboardActive) {
      // Both devices in play: take whichever is asking for more.
      this.axes.pitch = Math.abs(kbPitch) > Math.abs(this.axes.pitch) ? kbPitch : this.axes.pitch;
      this.axes.roll = Math.abs(kbRoll) > Math.abs(this.axes.roll) ? kbRoll : this.axes.roll;
    }

    if (this.held('Digit0')) this.axes.throttle = 0;
    if (this.held('Minus')) this.axes.throttle = Math.max(0, this.axes.throttle - THROTTLE_RATE * dt);
    if (this.held('Equal')) this.axes.throttle = Math.min(1, this.axes.throttle + THROTTLE_RATE * dt);

    if (this.hit('KeyG')) this.edges.toggleGear = true;
    if (this.hit('KeyF')) this.edges.flapsDown = true;
    if (this.hit('KeyV')) this.edges.flapsUp = true;
    if (this.hit('Tab')) this.edges.toggleAutopilot = true;
    if (this.hit('KeyP')) this.edges.toggleParkingBrake = true;
    if (this.hit('KeyC')) this.edges.cycleView = true;
    if (this.hit('Escape')) this.edges.pause = true;
    if (this.hit('KeyH')) this.edges.resetView = true;
    if (this.hit('Comma')) this.edges.trimUp = true;
    if (this.hit('Period')) this.edges.trimDown = true;

    // Head look springs back unless it is being held off-centre.
    if (!this.mouseLook && !this.lastDeviceGamepad) {
      this.headTarget.yaw = approach(this.headTarget.yaw, 0, 2.2, dt);
      this.headTarget.pitch = approach(this.headTarget.pitch, 0, 2.2, dt);
    }
    if (this.held('Numpad4')) this.headTarget.yaw = Math.min(2.5, this.headTarget.yaw + 1.8 * dt);
    if (this.held('Numpad6')) this.headTarget.yaw = Math.max(-2.5, this.headTarget.yaw - 1.8 * dt);
    if (this.held('Numpad8')) this.headTarget.pitch = Math.min(1.1, this.headTarget.pitch + 1.4 * dt);
    if (this.held('Numpad2')) this.headTarget.pitch = Math.max(-1.1, this.headTarget.pitch - 1.4 * dt);
    if (this.edges.resetView) { this.headTarget.yaw = 0; this.headTarget.pitch = 0; }

    this.axes.headYaw += (this.headTarget.yaw - this.axes.headYaw) * Math.min(1, dt * 12);
    this.axes.headPitch += (this.headTarget.pitch - this.axes.headPitch) * Math.min(1, dt * 12);

    this.pressed.clear();
  }
}
