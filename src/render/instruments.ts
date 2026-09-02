import type { Telemetry } from '../sim/dynamics';
import type { AircraftConfig } from '../sim/aircraft';
import { MS_TO_KT, M_TO_FT, altimeterReading, atmosphere } from '../sim/atmosphere';
import type { AutopilotState } from '../sim/autopilot';

/** The panel is wide and shallow on purpose.
 *
 *  Below the glareshield there is only about 20 degrees of view before the
 *  bottom of the screen. A classic 3x2 six-pack needs roughly 30, so half of it
 *  falls off the display. Spreading the same six instruments into one row keeps
 *  every one of them visible without moving your head — which is what the
 *  panel is for. */
export const PANEL_W = 1792;
export const PANEL_H = 300;

const FACE = '#0f1214';
const BEZEL = '#26292d';
const INK = '#e6e9ec';
const DIM = '#8b949b';

const TAU = Math.PI * 2;

function bezel(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, label: string): void {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r + 7, 0, TAU);
  g.fillStyle = BEZEL;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fillStyle = FACE;
  g.fill();
  g.strokeStyle = '#3a3f45';
  g.lineWidth = 1.5;
  g.stroke();
  g.restore();
  g.fillStyle = DIM;
  g.font = '600 11px ui-monospace, Menlo, monospace';
  g.textAlign = 'center';
  g.fillText(label, cx, cy + r + 21);
}

function needle(g: CanvasRenderingContext2D, cx: number, cy: number, angle: number, len: number, width: number, color: string, tail = 0.22): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(0, len * tail);
  g.lineTo(-width, 0);
  g.lineTo(0, -len);
  g.lineTo(width, 0);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.restore();
}

function hub(g: CanvasRenderingContext2D, cx: number, cy: number, r = 6): void {
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fillStyle = '#4a5057';
  g.fill();
}

/** Airspeed indicator with the real coloured arcs: white is the flap range,
 *  green the normal operating band, yellow caution, and the red line is the
 *  speed past which the wings are on their own. */
function airspeed(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, kt: number, cfg: AircraftConfig): void {
  bezel(g, cx, cy, r, 'AIRSPEED KT');
  const s = cfg.speeds;
  const top = s.never * 1.12;
  const ang = (v: number) => -Math.PI * 0.78 + (v / top) * Math.PI * 1.56;

  const arc = (from: number, to: number, color: string, radius: number, width: number) => {
    g.beginPath();
    g.arc(cx, cy, radius, ang(from) - Math.PI / 2, ang(to) - Math.PI / 2);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  };
  arc(s.stallFlaps, s.flapMax, '#f2f4f6', r - 16, 7);
  arc(s.stall, s.never * 0.82, '#3fbf6a', r - 7, 7);
  arc(s.never * 0.82, s.never, '#e8c33c', r - 7, 7);
  arc(s.never, top, '#e2483c', r - 7, 7);

  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.font = '600 13px ui-monospace, monospace';
  const stepFor = top > 250 ? 50 : 20;
  for (let v = 0; v <= top; v += stepFor) {
    const a = ang(v) - Math.PI / 2;
    const c = Math.cos(a), sn = Math.sin(a);
    g.beginPath();
    g.lineWidth = 2;
    g.moveTo(cx + c * (r - 20), cy + sn * (r - 20));
    g.lineTo(cx + c * (r - 10), cy + sn * (r - 10));
    g.stroke();
    if (v % (stepFor * 2) === 0 && v > 0) g.fillText(String(v), cx + c * (r - 33), cy + sn * (r - 33) + 5);
  }
  needle(g, cx, cy, ang(Math.max(0, Math.min(top, kt))), r - 14, 5, INK);
  hub(g, cx, cy);
}

/** Attitude indicator. Sky and ground rotate with bank and slide with pitch,
 *  the aeroplane symbol stays put — the single most important instrument when
 *  the windows show nothing but cloud. */
function attitude(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, pitch: number, bank: number): void {
  bezel(g, cx, cy, r, 'ATTITUDE');
  g.save();
  g.beginPath();
  g.arc(cx, cy, r - 2, 0, TAU);
  g.clip();
  g.translate(cx, cy);
  g.rotate(-bank);
  const pxPerDeg = r / 26;
  const off = (pitch * 180 / Math.PI) * pxPerDeg;
  g.fillStyle = '#3f7fbf';
  g.fillRect(-r * 2, -r * 2 + off, r * 4, r * 2);
  g.fillStyle = '#6b4a2c';
  g.fillRect(-r * 2, off, r * 4, r * 2);
  g.strokeStyle = '#f0f3f5';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-r * 1.4, off);
  g.lineTo(r * 1.4, off);
  g.stroke();

  g.font = '600 10px ui-monospace, monospace';
  g.textAlign = 'center';
  g.fillStyle = '#eef1f3';
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const y = off - d * pxPerDeg;
    const w = d % 20 === 0 ? r * 0.5 : r * 0.28;
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(-w, y);
    g.lineTo(w, y);
    g.stroke();
    if (d % 20 === 0) {
      g.fillText(String(Math.abs(d)), -w - 13, y + 4);
      g.fillText(String(Math.abs(d)), w + 13, y + 4);
    }
  }
  g.restore();

  // Bank scale and pointer.
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = INK;
  g.lineWidth = 2;
  for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = (d * Math.PI) / 180 - Math.PI / 2;
    const len = d % 30 === 0 ? 11 : 6;
    g.beginPath();
    g.moveTo(Math.cos(a) * (r - 2), Math.sin(a) * (r - 2));
    g.lineTo(Math.cos(a) * (r - 2 - len), Math.sin(a) * (r - 2 - len));
    g.stroke();
  }
  g.rotate(-bank);
  g.fillStyle = '#ffcf3f';
  g.beginPath();
  g.moveTo(0, -r + 3);
  g.lineTo(-7, -r + 16);
  g.lineTo(7, -r + 16);
  g.closePath();
  g.fill();
  g.restore();

  // Fixed aeroplane symbol.
  g.strokeStyle = '#ffcf3f';
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(cx - r * 0.55, cy);
  g.lineTo(cx - r * 0.18, cy);
  g.moveTo(cx + r * 0.18, cy);
  g.lineTo(cx + r * 0.55, cy);
  g.moveTo(cx, cy - 4);
  g.lineTo(cx, cy + 4);
  g.stroke();
}

/** Altimeter: a hundreds needle plus a digital thousands drum. Easier to read
 *  at a glance than the classic three-pointer, and harder to misread by 1000
 *  feet, which is the classic's famous failure. */
function altimeter(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, feet: number, setting: number): void {
  bezel(g, cx, cy, r, 'ALTITUDE FT');
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.font = '600 13px ui-monospace, monospace';
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU - Math.PI / 2;
    const c = Math.cos(a), s = Math.sin(a);
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(cx + c * (r - 18), cy + s * (r - 18));
    g.lineTo(cx + c * (r - 7), cy + s * (r - 7));
    g.stroke();
    g.fillText(String(i), cx + c * (r - 31), cy + s * (r - 31) + 5);
    for (let j = 1; j < 5; j++) {
      const a2 = ((i + j / 5) / 10) * TAU - Math.PI / 2;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a2) * (r - 13), cy + Math.sin(a2) * (r - 13));
      g.lineTo(cx + Math.cos(a2) * (r - 7), cy + Math.sin(a2) * (r - 7));
      g.stroke();
    }
  }
  const thousands = Math.floor(Math.max(0, feet) / 1000);
  g.fillStyle = '#05070a';
  g.fillRect(cx - 40, cy + r * 0.30, 80, 26);
  g.strokeStyle = '#454b52';
  g.lineWidth = 1;
  g.strokeRect(cx - 40, cy + r * 0.30, 80, 26);
  g.fillStyle = INK;
  g.font = '700 18px ui-monospace, monospace';
  g.fillText(`${thousands.toString().padStart(2, '0')},${Math.floor(Math.abs(feet) % 1000).toString().padStart(3, '0')}`, cx, cy + r * 0.30 + 19);

  g.fillStyle = '#05070a';
  g.fillRect(cx + r * 0.18, cy - 13, 58, 22);
  g.fillStyle = '#9fd8a0';
  g.font = '600 13px ui-monospace, monospace';
  g.fillText(setting.toFixed(2), cx + r * 0.18 + 29, cy + 3);

  needle(g, cx, cy, ((feet % 1000) / 1000) * TAU, r - 12, 5, INK);
  hub(g, cx, cy);
}

/** Vertical speed. Lags slightly in a real aeroplane; here it is honest. */
function vsi(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, fpm: number, scale: number): void {
  bezel(g, cx, cy, r, 'VERT SPEED');
  const ang = (v: number) => (Math.max(-scale, Math.min(scale, v)) / scale) * Math.PI * 0.78;
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.font = '600 12px ui-monospace, monospace';
  for (let v = -scale; v <= scale; v += scale / 5) {
    const a = ang(v) - Math.PI / 2;
    const c = Math.cos(a), s = Math.sin(a);
    g.lineWidth = Math.abs(v) % (scale / 5 * 2) < 1 ? 2.4 : 1.3;
    g.beginPath();
    g.moveTo(cx + c * (r - 16), cy + s * (r - 16));
    g.lineTo(cx + c * (r - 7), cy + s * (r - 7));
    g.stroke();
    if (Math.round(v) % Math.round(scale / 2.5) === 0) {
      g.fillText(String(Math.abs(v / 1000)), cx + c * (r - 29), cy + s * (r - 29) + 4);
    }
  }
  g.fillStyle = DIM;
  g.font = '600 10px ui-monospace, monospace';
  g.fillText('x1000 FPM', cx, cy + r * 0.55);
  needle(g, cx, cy, ang(fpm), r - 12, 4.5, fpm > 0 ? '#8fe0a2' : '#e8a08f');
  hub(g, cx, cy);
}

/** Heading indicator: a rotating card under a fixed lubber line. */
function heading(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, hdg: number, apHdg: number | null): void {
  bezel(g, cx, cy, r, 'HEADING');
  g.save();
  g.beginPath();
  g.arc(cx, cy, r - 2, 0, TAU);
  g.clip();
  g.translate(cx, cy);
  g.rotate(-hdg);
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.textAlign = 'center';
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180 - Math.PI / 2;
    const major = d % 30 === 0;
    g.lineWidth = major ? 2.4 : 1.2;
    g.beginPath();
    g.moveTo(Math.cos(a) * (r - (major ? 17 : 11)), Math.sin(a) * (r - (major ? 17 : 11)));
    g.lineTo(Math.cos(a) * (r - 4), Math.sin(a) * (r - 4));
    g.stroke();
    if (major) {
      const label = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
      g.save();
      g.translate(Math.cos(a) * (r - 31), Math.sin(a) * (r - 31));
      g.rotate(hdg);
      g.font = d % 90 === 0 ? '700 15px ui-monospace, monospace' : '600 12px ui-monospace, monospace';
      g.fillText(label, 0, 5);
      g.restore();
    }
  }
  if (apHdg !== null) {
    const a = apHdg - Math.PI / 2;
    g.strokeStyle = '#e8c33c';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(Math.cos(a) * (r - 22), Math.sin(a) * (r - 22));
    g.lineTo(Math.cos(a) * (r - 4), Math.sin(a) * (r - 4));
    g.stroke();
  }
  g.restore();
  g.fillStyle = '#ffcf3f';
  g.beginPath();
  g.moveTo(cx, cy - r + 2);
  g.lineTo(cx - 6, cy - r + 14);
  g.lineTo(cx + 6, cy - r + 14);
  g.closePath();
  g.fill();
  g.strokeStyle = '#ffcf3f';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(cx - 12, cy);
  g.lineTo(cx + 12, cy);
  g.moveTo(cx, cy - 8);
  g.lineTo(cx, cy + 8);
  g.stroke();
}

/** Turn coordinator and slip ball: rate of turn on the little aeroplane,
 *  coordination on the ball. Step on the ball to centre it. */
function turnCoordinator(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, turnRate: number, slip: number): void {
  bezel(g, cx, cy, r, 'TURN / SLIP');
  const bank = Math.max(-1.6, Math.min(1.6, turnRate / 0.0524)) * 0.28;
  g.save();
  g.translate(cx, cy - r * 0.12);
  g.rotate(bank);
  g.strokeStyle = '#e8eef2';
  g.lineWidth = 3.4;
  g.beginPath();
  g.moveTo(-r * 0.62, 0);
  g.lineTo(r * 0.62, 0);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, 6, 0, TAU);
  g.stroke();
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -r * 0.24);
  g.stroke();
  g.restore();
  g.strokeStyle = '#8fe0a2';
  g.lineWidth = 2.4;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * r * 0.42, cy - r * 0.30);
    g.lineTo(cx + s * r * 0.42, cy - r * 0.02);
    g.stroke();
  }
  // Inclinometer.
  const by = cy + r * 0.56;
  g.fillStyle = '#0a0d10';
  g.beginPath();
  g.roundRect(cx - r * 0.62, by - 12, r * 1.24, 24, 12);
  g.fill();
  g.strokeStyle = '#4b5157';
  g.lineWidth = 1.5;
  g.stroke();
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * 11, by - 11);
    g.lineTo(cx + s * 11, by + 11);
    g.stroke();
  }
  g.beginPath();
  g.arc(cx + Math.max(-1, Math.min(1, slip * 4.5)) * r * 0.46, by, 8.5, 0, TAU);
  g.fillStyle = '#1a1c1e';
  g.fill();
  g.strokeStyle = '#c8ced4';
  g.lineWidth = 1.2;
  g.stroke();
}

function tape(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, label: string, value: string, color: string): void {
  g.fillStyle = '#0a0d10';
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#333940';
  g.lineWidth = 1;
  g.strokeRect(x, y, w, h);
  g.fillStyle = color;
  const fh = Math.max(0, Math.min(1, frac)) * (h - 4);
  g.fillRect(x + 2, y + h - 2 - fh, w - 4, fh);
  g.fillStyle = DIM;
  g.font = '600 10px ui-monospace, monospace';
  g.textAlign = 'center';
  g.fillText(label, x + w / 2, y - 5);
  g.fillStyle = INK;
  g.font = '700 12px ui-monospace, monospace';
  g.fillText(value, x + w / 2, y + h + 14);
}

function lamp(g: CanvasRenderingContext2D, x: number, y: number, w: number, text: string, on: boolean, color: string): void {
  g.fillStyle = on ? color : '#191d21';
  g.beginPath();
  g.roundRect(x, y, w, 24, 4);
  g.fill();
  g.strokeStyle = on ? color : '#2e343a';
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = on ? '#0a0d10' : '#555d64';
  g.font = '700 11px ui-monospace, monospace';
  g.textAlign = 'center';
  g.fillText(text, x + w / 2, y + 16);
}

export interface PanelInput {
  telemetry: Telemetry;
  config: AircraftConfig;
  autopilot: AutopilotState;
  altimeterSetting: number;
  flaps: number;
  gearDown: boolean;
  parkingBrake: boolean;
  /** Seconds since the run started, for the flashing warnings. */
  time: number;
}

/** Draws the whole panel. Called every frame the panel is visible; the canvas
 *  is uploaded as a texture, which is one upload rather than a mesh per needle. */
export function drawPanel(g: CanvasRenderingContext2D, input: PanelInput): void {
  const { telemetry: t, config: cfg, autopilot: ap } = input;
  g.fillStyle = '#15181b';
  g.fillRect(0, 0, PANEL_W, PANEL_H);
  g.fillStyle = '#1b1f23';
  g.fillRect(0, 0, PANEL_W, 8);

  const r = 74;
  const gy = 100;
  const gx = [92, 250, 408, 566, 724, 882];

  airspeed(g, gx[0]!, gy, r, t.indicatedAirspeed * MS_TO_KT, cfg);
  attitude(g, gx[1]!, gy, r, t.pitch, t.bank);
  const press = atmosphere(t.altitude).pressure;
  altimeter(g, gx[2]!, gy, r, altimeterReading(press, input.altimeterSetting) * M_TO_FT, input.altimeterSetting);
  turnCoordinator(g, gx[3]!, gy, r, -Math.sin(t.bank) * 9.81 / Math.max(20, t.trueAirspeed), Math.sin(t.beta));
  heading(g, gx[4]!, gy, r, t.heading, ap.master && ap.headingHold ? ap.targetHeading : null);
  vsi(g, gx[5]!, gy, r, t.verticalSpeed * M_TO_FT * 60, cfg.id === 'vector' ? 4000 : 2000);

  // Engine and fuel stack.
  const ex = 1012;
  if (cfg.engine.kind === 'prop') {
    tape(g, ex, 32, 38, 104, t.rpm / (cfg.engine.maxRpm ?? 2700), 'RPM', String(Math.round(t.rpm)), '#7fb8e8');
  } else {
    tape(g, ex, 32, 38, 104, t.n1 / 100, 'N1 %', t.n1.toFixed(0), '#7fb8e8');
  }
  tape(g, ex + 54, 32, 38, 104, t.fuel / cfg.fuelCapacity, 'FUEL', `${Math.round(t.fuel)}kg`,
    t.fuel / cfg.fuelCapacity < 0.12 ? '#e2483c' : '#8fe0a2');
  tape(g, ex + 108, 32, 38, 104, Math.max(0, Math.min(1, (t.loadFactor + 1) / 5)), 'LOAD G', t.loadFactor.toFixed(1),
    Math.abs(t.loadFactor) > 3.5 ? '#e2483c' : '#c8ced4');

  // Digital readouts a pilot actually wants: groundspeed, height above ground,
  // true airspeed and angle of attack.
  const readouts: [string, string][] = [
    ['GS', `${Math.round(t.groundSpeed * MS_TO_KT)} kt`],
    ['TAS', `${Math.round(t.trueAirspeed * MS_TO_KT)} kt`],
    ['AGL', `${Math.round(t.radarAltitude * M_TO_FT)} ft`],
    ['AOA', `${(t.alpha * 180 / Math.PI).toFixed(1)}°`],
  ];
  readouts.forEach(([k, v], i) => {
    const x = 1178, y = 26 + i * 30;
    g.fillStyle = DIM;
    g.font = '600 11px ui-monospace, monospace';
    g.textAlign = 'left';
    g.fillText(k, x, y + 15);
    g.fillStyle = INK;
    g.font = '700 15px ui-monospace, monospace';
    g.textAlign = 'right';
    g.fillText(v, x + 148, y + 15);
  });

  // Annunciators.
  const blink = Math.floor(input.time * 3) % 2 === 0;
  const ax = 1352;
  const low = t.fuel / cfg.fuelCapacity < 0.12;
  lamp(g, ax, 30, 118, 'STALL', t.stalled && blink, '#e2483c');
  lamp(g, ax + 126, 30, 118, 'GEAR DN', input.gearDown, '#8fe0a2');
  lamp(g, ax + 252, 30, 118, 'AP', ap.master, '#7fb8e8');
  lamp(g, ax, 60, 118, `FLAPS ${Math.round(input.flaps * 100)}`, input.flaps > 0.01, '#e8c33c');
  lamp(g, ax + 126, 60, 118, 'PARK BRK', input.parkingBrake, '#e8c33c');
  lamp(g, ax + 252, 60, 118, low ? 'FUEL LOW' : 'FUEL OK', low ? blink : true, low ? '#e2483c' : '#3d4a44');
  lamp(g, ax, 90, 370, 'OVERSPEED', t.indicatedAirspeed * MS_TO_KT > cfg.speeds.never && blink, '#e2483c');

  // Autopilot mode line.
  g.fillStyle = '#0a0d10';
  g.fillRect(ax, 126, 370, 84);
  g.strokeStyle = '#333940';
  g.strokeRect(ax, 126, 370, 84);
  g.textAlign = 'left';
  g.fillStyle = ap.master ? '#7fb8e8' : DIM;
  g.font = '700 13px ui-monospace, monospace';
  g.fillText(ap.master ? 'AUTOPILOT ENGAGED' : 'AUTOPILOT OFF', ax + 12, 146);
  g.font = '600 12px ui-monospace, monospace';
  g.fillStyle = INK;
  g.fillText(`ALT ${Math.round(ap.targetAltitude * M_TO_FT)} ft`, ax + 12, 170);
  g.fillText(`HDG ${String(Math.round((ap.targetHeading * 180) / Math.PI)).padStart(3, '0')}°`, ax + 150, 170);
  g.fillText(`SPD ${Math.round(ap.targetSpeed * MS_TO_KT)} kt${ap.speedHold ? ' HOLD' : ''}`, ax + 12, 194);

  // A real angle-of-attack indexer: the thing that actually says how close the
  // wing is to giving up, which airspeed alone never tells you in a turn.
  const my = 224;
  g.fillStyle = '#0a0d10';
  g.fillRect(ax, my, 370, 22);
  const margin = Math.max(0, Math.min(1, t.stallMargin));
  g.fillStyle = margin > 0.9 ? '#e2483c' : margin > 0.72 ? '#e8c33c' : '#8fe0a2';
  g.fillRect(ax + 2, my + 2, (370 - 4) * margin, 18);
  g.fillStyle = '#0a0d10';
  g.font = '700 10px ui-monospace, monospace';
  g.textAlign = 'left';
  g.fillText('ANGLE OF ATTACK', ax + 6, my + 15);

  g.fillStyle = DIM;
  g.font = '600 11px ui-monospace, monospace';
  g.textAlign = 'right';
  g.fillText(cfg.name.toUpperCase(), PANEL_W - 16, PANEL_H - 12);
}
