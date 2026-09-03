import './style.css';
import { ACESFilmicToneMapping, PerspectiveCamera, Quaternion, Vector3, WebGLRenderer, Group } from 'three';
import { AIRCRAFT, aircraftById, type AircraftConfig } from './sim/aircraft';
import { advance, createAircraft, placeOnRunway, trimLevel, type AircraftState, type GroundQuery } from './sim/dynamics';
import { Autopilot } from './sim/autopilot';
import { MS_TO_KT, M_TO_FT, KT_TO_MS } from './sim/atmosphere';
import { elevation, groundNormal } from './world/ground';
import { airportsNear, citiesNear, findSpawnAirport, runwayDesignators, clearPlaceCaches, type Airport } from './world/places';
import { hashSeed } from './world/noise';
import { WorldRenderer } from './render/world';
import { Cockpit } from './render/cockpit';
import { buildAircraftModel } from './render/aircraftModel';
import { InputManager } from './input/controls';

declare global {
  interface Window { __sierraBooted?: boolean; __sierraFail?: (t: string, b: string, d?: string) => void; sierra?: unknown }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const menu = $('menu'), busy = $('busy'), paused = $('paused'), hud = $('hud'), msgEl = $('msg');
const card = $('controls-card');

/** The controls card is available from the menu, from the pause screen and on
 *  F1 in flight. A reference you can only reach before taking off is a
 *  reference you read once and then guess at. */
function showCard(show: boolean): void {
  card.hidden = !show;
  if (show && sim && !sim.paused) { sim.paused = true; sim.pausedByCard = true; }
  else if (!show && sim?.pausedByCard) { sim.paused = false; sim.pausedByCard = false; }
}
$('card-close').addEventListener('click', () => showCard(false));
$('menu-controls').addEventListener('click', () => showCard(true));
$('show-controls').addEventListener('click', () => showCard(true));
window.addEventListener('keydown', (e) => {
  if (e.code === 'F1' || (e.code === 'Slash' && e.shiftKey)) {
    e.preventDefault();
    showCard(card.hidden === true);
  } else if (e.code === 'Escape' && !card.hidden) {
    e.preventDefault();
    showCard(false);
  }
});

const fail = (t: string, b: string, d?: string): void => window.__sierraFail?.(t, b, d);

function webglUnavailable(): string | null {
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') ?? c.getContext('webgl'))) return 'The browser returned no WebGL context.';
    return null;
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}

type View = 'cockpit' | 'chase' | 'tower';

interface Sim {
  seed: number;
  seedText: string;
  aircraft: AircraftState;
  autopilot: Autopilot;
  world: WorldRenderer;
  cockpit: Cockpit;
  model: { group: Group; gear: Group; prop: import('three').Mesh | null };
  ground: GroundQuery;
  camera: PerspectiveCamera;
  view: View;
  time: number;
  altimeter: number;
  paused: boolean;
  /** Paused because the reference card is open, so closing it resumes. */
  pausedByCard: boolean;
  spawn: Airport;
}

let sim: Sim | null = null;
let selectedAircraft = 'skylark';
let startMode: 'runway' | 'air' = 'runway';
const input = new InputManager();

let renderer: WebGLRenderer | null = null;

/* ---------------- menu ---------------- */

const pickAircraft = $('pick-aircraft');
for (const cfg of AIRCRAFT) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'opt';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(cfg.id === selectedAircraft));
  b.innerHTML = `<b>${cfg.name}</b><span>${cfg.role} · stall ${cfg.speeds.stall} kt · cruise ${cfg.speeds.cruise} kt</span>`;
  b.addEventListener('click', () => {
    selectedAircraft = cfg.id;
    for (const el of pickAircraft.children) el.setAttribute('aria-checked', String(el === b));
  });
  pickAircraft.appendChild(b);
}
for (const el of $('pick-start').children) {
  el.addEventListener('click', () => {
    startMode = (el as HTMLElement).dataset.start as 'runway' | 'air';
    for (const o of $('pick-start').children) o.setAttribute('aria-checked', String(o === el));
  });
}

$('start').addEventListener('click', () => start());
$('resume').addEventListener('click', () => { if (sim) { sim.paused = false; paused.hidden = true; } });
$('quit').addEventListener('click', () => {
  paused.hidden = true;
  card.hidden = true;
  hud.hidden = true;
  menu.hidden = false;
  if (sim) sim.paused = true;
});

function message(text: string, kind: 'info' | 'warn' | 'bad' | 'good' = 'info', ms = 3200): void {
  msgEl.textContent = text;
  msgEl.className = `msg ${kind === 'info' ? '' : kind}`;
  msgEl.hidden = false;
  window.clearTimeout((message as unknown as { t?: number }).t);
  (message as unknown as { t?: number }).t = window.setTimeout(() => { msgEl.hidden = true; }, ms);
}

/* ---------------- start ---------------- */

function start(): void {
  card.hidden = true;
  const why = webglUnavailable();
  if (why) {
    fail('This browser cannot run WebGL',
      'Sierra draws the world with WebGL and this browser or machine will not give the page a 3D context. Hardware acceleration switched off is the usual cause.',
      why);
    return;
  }
  menu.hidden = true;
  busy.hidden = false;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      buildSim();
      busy.hidden = true;
      hud.hidden = false;
    } catch (e) {
      fail('The world could not be built',
        'Generation or the renderer threw while starting. Reloading usually clears it; the seed is on the menu screen if it does not.',
        e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
    }
  }));
}

function buildSim(): void {
  const seedText = ($<HTMLInputElement>('seed').value || 'sierra').trim();
  const seed = hashSeed(seedText);
  const cfg: AircraftConfig = aircraftById(selectedAircraft);
  clearPlaceCaches();

  if (!renderer) {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.autoClear = false;
    // Filmic tone mapping. Without it the sun clips to flat white, bright sky
    // washes out and everything sits in the same narrow band of grey — which
    // is most of what "flat" looks like in a real-time scene.
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    input.attach(canvas);
  }

  const ground: GroundQuery = {
    elevation: (x, z) => elevation(x, z, seed),
    normal: (out, x, z) => groundNormal(out, x, z, seed),
  };

  const world = new WorldRenderer(seed);
  const spawn = findSpawnAirport(seed);
  const aircraft = createAircraft(cfg);

  const heading = spawn.runway.heading;
  if (startMode === 'runway') {
    // At the threshold, lined up, brakes on.
    const back = spawn.runway.length / 2 - 60;
    placeOnRunway(
      aircraft,
      spawn.x - Math.sin(heading) * back,
      spawn.elev + 1.4,
      spawn.z + Math.cos(heading) * back,
      heading,
    );
  } else {
    // On a straight-in, far enough out to see the field ahead. Both runway
    // directions are checked and the one over land wins: a procedural coast
    // will happily put the downwind leg five miles out to sea.
    const d = 5200;
    const score = (hdg: number): number => {
      let land = 0;
      for (let f = 0.2; f <= 1; f += 0.2) {
        const px = spawn.x - Math.sin(hdg) * d * f, pz = spawn.z + Math.cos(hdg) * d * f;
        if (elevation(px, pz, seed) > 2) land++;
      }
      return land;
    };
    const approach = score(heading) >= score(heading + Math.PI) ? heading : heading + Math.PI;
    const alt = spawn.elev + 900;
    aircraft.position.set(spawn.x - Math.sin(approach) * d, alt, spawn.z + Math.cos(approach) * d);
    trimLevel(aircraft, alt, cfg.speeds.cruise * KT_TO_MS * 0.8, approach);
    aircraft.controls.throttle = 0.62;
    aircraft.power = 0.62;
  }

  const camera = new PerspectiveCamera(70, 1, 1.2, 220000);
  world.setViewDistance(220000);
  const cockpit = new Cockpit(cfg);
  const model = buildAircraftModel(cfg);
  world.scene.add(model.group);

  sim = {
    seed, seedText, aircraft, autopilot: new Autopilot(), world, cockpit, model, ground,
    camera, view: 'cockpit', time: 0, altimeter: 29.92, paused: false, pausedByCard: false, spawn,
  };
  window.sierra = sim;

  applyTimeOfDay(Number($<HTMLInputElement>('tod').value));
  world.warmUp(aircraft.position, 3000);
  resize();
  const [d1] = runwayDesignators(spawn);
  message(startMode === 'runway'
    ? `${spawn.icao} — ${spawn.name}. Runway ${d1}, elevation ${Math.round(spawn.elev * M_TO_FT)} ft. Release the parking brake with P.`
    : `Airborne near ${spawn.icao} ${spawn.name}, 4,000 ft. Autopilot on Tab.`, 'good', 7000);
}

function applyTimeOfDay(v: number): void {
  if (!sim) return;
  // 0 = pre-dawn, 50 = noon, 100 = dusk.
  const t = v / 100;
  const elev = Math.sin(t * Math.PI) * 1.15 - 0.06;
  sim.world.setSun(elev, Math.PI * (0.25 + t * 1.1));
}
$('tod').addEventListener('input', (e) => applyTimeOfDay(Number((e.target as HTMLInputElement).value)));

/* ---------------- per-frame ---------------- */

function resize(): void {
  if (!renderer || !sim) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  sim.camera.aspect = w / h;
  sim.camera.updateProjectionMatrix();
  sim.cockpit.resize(w / h);
}
window.addEventListener('resize', resize);

const _eye = new Vector3();
const _look = new Quaternion();
const _tmp = new Vector3();

function applyInput(s: Sim): void {
  const c = s.aircraft.controls;
  const a = input.axes;
  const e = input.edges;

  if (e.pause && card.hidden) {
    s.paused = !s.paused;
    s.pausedByCard = false;
    paused.hidden = !s.paused;
    if (s.paused) fillPauseStats(s);
  }
  if (s.paused) return;

  // Any stick movement drops the autopilot, the way a real one disconnects.
  if (s.autopilot.state.master && (Math.abs(a.pitch) > 0.15 || Math.abs(a.roll) > 0.15)) {
    s.autopilot.disengage('pilot input');
    message('Autopilot disconnected.', 'warn');
  }

  if (!s.autopilot.state.master) {
    c.pitch = a.pitch;
    c.roll = a.roll;
    c.yaw = a.yaw;
  }
  c.throttle = a.throttle;
  c.brakes = Math.max(a.brakes, 0);

  if (e.toggleGear) {
    if (s.aircraft.config.speeds.gearMax > 900) message('This aeroplane has fixed gear.', 'warn');
    else if (!c.gear && s.aircraft.telemetry.indicatedAirspeed * MS_TO_KT > s.aircraft.config.speeds.gearMax) {
      message(`Too fast for gear — below ${s.aircraft.config.speeds.gearMax} kt.`, 'bad');
    } else {
      c.gear = !c.gear;
      message(c.gear ? 'Gear down.' : 'Gear up.');
    }
  }
  if (e.flapsDown) {
    if (s.aircraft.telemetry.indicatedAirspeed * MS_TO_KT > s.aircraft.config.speeds.flapMax) {
      message(`Too fast for flaps — below ${s.aircraft.config.speeds.flapMax} kt.`, 'bad');
    } else { c.flaps = Math.min(1, c.flaps + 1 / 3); message(`Flaps ${Math.round(c.flaps * 100)}%.`); }
  }
  if (e.flapsUp) { c.flaps = Math.max(0, c.flaps - 1 / 3); message(`Flaps ${Math.round(c.flaps * 100)}%.`); }
  if (e.toggleParkingBrake) {
    c.parkingBrake = !c.parkingBrake;
    message(c.parkingBrake ? 'Parking brake set.' : 'Parking brake released.', c.parkingBrake ? 'warn' : 'good');
  }
  if (e.trimUp) { c.trim = Math.min(1, c.trim + 0.08); message(`Trim ${c.trim > 0 ? 'nose up' : 'nose down'} ${Math.abs(c.trim).toFixed(2)}`); }
  if (e.trimDown) { c.trim = Math.max(-1, c.trim - 0.08); message(`Trim ${c.trim > 0 ? 'nose up' : 'nose down'} ${Math.abs(c.trim).toFixed(2)}`); }
  if (e.toggleAutopilot) {
    if (s.autopilot.state.master) { s.autopilot.disengage('pilot'); s.autopilot.release(s.aircraft); message('Autopilot off.', 'warn'); }
    else if (s.aircraft.telemetry.onGround) message('Autopilot needs to be airborne.', 'bad');
    else { s.autopilot.engage(s.aircraft); message(`Autopilot on — holding ${Math.round(s.autopilot.state.targetAltitude * M_TO_FT)} ft.`, 'good'); }
  }
  if (e.cycleView) {
    s.view = s.view === 'cockpit' ? 'chase' : s.view === 'chase' ? 'tower' : 'cockpit';
    message(`View: ${s.view}.`);
  }
}

function fillPauseStats(s: Sim): void {
  const t = s.aircraft.telemetry;
  const rows: [string, string][] = [
    ['Altitude', `${Math.round(t.altitude * M_TO_FT).toLocaleString()} ft`],
    ['Indicated', `${Math.round(t.indicatedAirspeed * MS_TO_KT)} kt`],
    ['Heading', `${String(Math.round((t.heading * 180) / Math.PI)).padStart(3, '0')}°`],
    ['Fuel', `${Math.round(t.fuel)} kg`],
    ['Distance flown', `${(Math.hypot(s.aircraft.position.x - s.spawn.x, s.aircraft.position.z - s.spawn.z) / 1852).toFixed(1)} nm`],
    ['Seed', s.seedText],
  ];
  $('pause-title').textContent = t.onGround ? 'On the ground' : 'In flight';
  $('pause-stats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function updateCamera(s: Sim): void {
  const cfg = s.aircraft.config;
  _look.setFromAxisAngle(new Vector3(0, 1, 0), input.axes.headYaw)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), input.axes.headPitch));

  if (s.view === 'cockpit') {
    _eye.set(cfg.eye[0], cfg.eye[1], cfg.eye[2]).applyQuaternion(s.aircraft.orientation).add(s.aircraft.position);
    s.camera.position.copy(_eye).sub(s.world.origin);
    s.camera.quaternion.copy(s.aircraft.orientation).multiply(_look);
    s.model.group.visible = false;
    s.cockpit.setVisible(true);
  } else if (s.view === 'chase') {
    // Stand off by the aeroplane's own size, or the tail fills the frame.
    const jet = cfg.engine.kind === 'jet';
    _tmp.set(0, jet ? 6.5 : 3.6, jet ? 38 : 22).applyQuaternion(s.aircraft.orientation).add(s.aircraft.position);
    s.camera.position.copy(_tmp).sub(s.world.origin);
    s.camera.quaternion.copy(s.aircraft.orientation).multiply(_look);
    s.model.group.visible = true;
    s.cockpit.setVisible(false);
  } else {
    // Fixed point off the wing, looking at the aeroplane.
    _tmp.copy(s.aircraft.position).add(new Vector3(70, 22, 70));
    s.camera.position.copy(_tmp).sub(s.world.origin);
    s.camera.lookAt(_tmp.copy(s.aircraft.position).sub(s.world.origin));
    s.model.group.visible = true;
    s.cockpit.setVisible(false);
  }

  s.model.group.position.copy(s.aircraft.position).sub(s.world.origin);
  s.model.group.quaternion.copy(s.aircraft.orientation);
  s.model.gear.visible = s.aircraft.controls.gear;
  if (s.model.prop) s.model.prop.rotation.z += s.aircraft.power * 2.2 + 0.4;
}

let fpsAcc = 0, fpsCount = 0, fpsShown = 0, hudAcc = 0;

function updateHud(s: Sim, dt: number): void {
  hudAcc += dt;
  fpsAcc += dt; fpsCount++;
  if (fpsAcc > 0.5) { fpsShown = fpsCount / fpsAcc; fpsAcc = 0; fpsCount = 0; }
  if (hudAcc < 0.25) return;
  hudAcc = 0;

  const t = s.aircraft.telemetry;
  $('hud-aircraft').textContent = `${s.aircraft.config.name} · ${s.view}`;
  $('hud-pos').textContent = `${(s.aircraft.position.x / 1000).toFixed(1)}, ${(s.aircraft.position.z / 1000).toFixed(1)} km`;

  let best: Airport | null = null, bestD = Infinity;
  for (const a of airportsNear(s.aircraft.position.x, s.aircraft.position.z, s.seed, 2)) {
    const d = Math.hypot(a.x - s.aircraft.position.x, a.z - s.aircraft.position.z);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (best) {
    const brg = ((Math.atan2(best.x - s.aircraft.position.x, -(best.z - s.aircraft.position.z)) * 180) / Math.PI + 360) % 360;
    $('hud-airport').textContent = `${best.icao} ${(bestD / 1852).toFixed(1)} nm ${String(Math.round(brg)).padStart(3, '0')}°`;
  } else $('hud-airport').textContent = '—';

  const towns = citiesNear(s.aircraft.position.x, s.aircraft.position.z, s.seed, 2500);
  $('hud-place').textContent = towns.length
    ? `${towns[0]!.name} (${Math.round(towns[0]!.population).toLocaleString()})`
    : t.altitude < 1 ? 'water' : 'open country';

  $('hud-fps').textContent = fpsShown.toFixed(0);
  const w = s.world.stats;
  $('hud-terrain').textContent = `${w.terrainNodes} tiles · ${(w.terrainTris / 1000).toFixed(0)}k tri`;
  $('hud-buildings').textContent = `${(w.buildingsNear + w.buildingsFar).toLocaleString()} · ${w.cities} towns`;
  $('hud-input').textContent = input.gamepadConnected
    ? `${input.gamepadName}${input.lastDeviceGamepad ? ' (active)' : ''}`
    : 'Keyboard';
}

let last = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!sim || !renderer) return;
  const s = sim;

  input.update(dt);
  applyInput(s);
  if (s.paused) return;

  s.time += dt;
  s.autopilot.update(s.aircraft, dt);
  advance(s.aircraft, dt, s.ground);
  s.world.update(s.aircraft.position, 5, dt);
  updateCamera(s);

  s.cockpit.update({
    telemetry: s.aircraft.telemetry,
    config: s.aircraft.config,
    autopilot: s.autopilot.state,
    altimeterSetting: s.altimeter,
    flaps: s.aircraft.controls.flaps,
    gearDown: s.aircraft.controls.gear,
    parkingBrake: s.aircraft.controls.parkingBrake,
    time: s.time,
  }, s.aircraft.controls, input.axes.headYaw, input.axes.headPitch, dt);

  renderer.clear();
  renderer.render(s.world.scene, s.camera);
  if (s.view === 'cockpit') {
    // Second pass with its own depth range, so panel detail half a metre away
    // is not crushed by a 220 km far plane.
    renderer.clearDepth();
    renderer.render(s.cockpit.scene, s.cockpit.camera);
  }

  updateHud(s, dt);
}

requestAnimationFrame(frame);
window.__sierraBooted = true;
