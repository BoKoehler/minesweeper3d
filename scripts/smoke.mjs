/** Drives the real simulator in Chromium and asserts against live sim state. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5320 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0].slice(0, 130)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('fonts.g')) errs.push('console: ' + m.text().slice(0, 120)); });

const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};
const state = () => page.evaluate(() => {
  const s = window.sierra, t = s.aircraft.telemetry, c = s.aircraft.controls;
  return {
    ias: t.indicatedAirspeed * 1.94384, alt: t.altitude, agl: t.radarAltitude, onGround: t.onGround,
    pitch: t.pitch, bank: t.bank, heading: t.heading, stalled: t.stalled, fuel: t.fuel,
    ctlPitch: c.pitch, ctlRoll: c.roll, throttle: c.throttle, flaps: c.flaps, brake: c.parkingBrake, gear: c.gear,
    ap: s.autopilot.state.master, view: s.view, paused: s.paused,
    tiles: s.world.stats.terrainNodes, buildings: s.world.stats.buildingsNear + s.world.stats.buildingsFar,
    towns: s.world.stats.cities, airports: s.world.stats.airports,
    seed: s.seedText, spawn: s.spawn.icao,
  };
});
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
/** A tap, then wait for the simulation clock to actually advance.
 *
 *  Fixed sleeps are the wrong tool here: this runner manages about one frame a
 *  second under software GL, so any wall-clock guess is either flaky or slow.
 *  Waiting on sim time makes the check independent of frame rate. */
const tap = async (key) => {
  const t0 = await page.evaluate(() => window.sierra?.time ?? 0);
  await page.keyboard.press(key);
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => window.sierra?.time ?? 0)) > t0 + 0.12) return;
    await page.waitForTimeout(150);
  }
};
/** Wait for a condition, so timing-sensitive checks are not fixed sleeps. */
const until = async (fn, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn(await state())) return true; await page.waitForTimeout(200); }
  return false;
};

await page.goto('http://localhost:5320/', { waitUntil: 'networkidle' });

// The controls card must be reachable before flying and while flying.
await page.click('#menu-controls');
await page.waitForTimeout(300);
const cardRows = await page.evaluate(() => document.querySelectorAll('#controls-card dd').length);
check('controls card opens from the menu and lists the bindings', !(await page.locator('#controls-card').getAttribute('hidden')) && cardRows >= 14, `${cardRows} bindings`);
await page.click('#card-close');
await page.waitForTimeout(200);
check('controls card closes', (await page.locator('#controls-card').getAttribute('hidden')) !== null);

await page.click('#start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 90000 });
await page.waitForTimeout(1200);

// Wait for the gear to settle rather than assuming a frame has run: this
// runner manages about one frame a second under software GL.
const settled = await until((x) => x.onGround, 20000);
let s = await state();
check('starts on the runway at a real airfield', settled && s.ias < 2 && s.brake === true,
  `${s.spawn}, ${Math.round(s.alt)} m · settled=${settled} ias=${s.ias.toFixed(1)} brake=${s.brake}`);
check('world is populated before the first frame', s.tiles > 100 && s.towns > 0, `${s.tiles} tiles, ${s.buildings} buildings, ${s.towns} towns, ${s.airports} fields`);

// Controls move the surfaces, and ramp rather than snapping to the stops.
// Sample the ramp across sim time, not wall time: one frame a second means a
// 90 ms wall-clock sample can land before any frame has run at all.
await page.keyboard.down('KeyS');
await until((x) => x.ctlPitch > 0.02, 12000);
const early = (await state()).ctlPitch;
await page.waitForTimeout(1600);
const later = (await state()).ctlPitch;
await page.keyboard.up('KeyS');
check('keyboard pitch ramps like a stick, not a switch', later > early && early < 0.9, `${early.toFixed(2)} -> ${later.toFixed(2)}`);
check('stick returns to centre when released', await until((x) => Math.abs(x.ctlPitch) < 0.15, 12000));
await page.keyboard.down('KeyD');
check('right stick commands right aileron', await until((x) => x.ctlRoll > 0.1, 12000));
await page.keyboard.up('KeyD');
await until((x) => Math.abs(x.ctlRoll) < 0.15, 12000);

// F1 opens the card in flight and holds the simulation while it is up.
await page.keyboard.press('F1');
await page.waitForTimeout(700);
const cardOpen = (await page.locator('#controls-card').getAttribute('hidden')) === null;
check('F1 opens the card in flight and pauses', cardOpen && (await state()).paused === true);
await page.keyboard.press('F1');
await page.waitForTimeout(700);
check('closing the card resumes', (await state()).paused === false);

// Systems.
await tap('KeyP');
check('parking brake releases', (await state()).brake === false);
await tap('KeyF');
check('flaps extend a stage', (await state()).flaps > 0.3);
await tap('KeyV');
check('flaps retract a stage', (await state()).flaps < 0.01);
await tap('KeyC');
check('view changes to chase', (await state()).view === 'chase');
await tap('KeyC'); await tap('KeyC');
check('view cycles back to the cockpit', (await state()).view === 'cockpit');

// Full power gets it rolling. The physics of a takeoff is proven in the unit
// tests, which run thousands of times faster than a browser without a GPU;
// what matters here is that the keyboard actually reaches the throttle.
await page.keyboard.down('ShiftLeft');
const gotPower = await until((x) => x.throttle > 0.9, 25000);
check('throttle key drives the lever to full', gotPower, `throttle ${(await state()).throttle.toFixed(2)}`);
const rolling = await until((x) => x.ias > 15, 40000);
await page.keyboard.up('ShiftLeft');
s = await state();
check('full power accelerates it down the runway', rolling, `${s.ias.toFixed(0)} kt`);
check('fuel is being burned', s.fuel < 110, `${s.fuel.toFixed(1)} kg left`);

// Airborne checks need to start airborne: at software-GL frame rates the
// fixed-step simulation runs in slow motion and a real takeoff takes minutes.
await tap('Escape');
await page.click('#quit');
await page.locator('[data-start="air"]').click();
await page.fill('#seed', 'checkflight');
await page.click('#start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 90000 });
await page.waitForTimeout(1500);
s = await state();
check('restarting with a new seed builds a different world', s.seed === 'checkflight' && !s.onGround, `${s.spawn}, ${Math.round(s.agl)} m AGL`);

await tap('Tab');
check('autopilot engages in flight', (await state()).ap === true);
// Hold the stick until the autopilot lets go, rather than for a fixed time:
// the disconnect needs the ramp to pass its threshold inside a frame.
await page.keyboard.down('KeyD');
const dropped = await until((x) => x.ap === false, 20000);
await page.keyboard.up('KeyD');
check('a stick input disconnects the autopilot', dropped);
await page.waitForTimeout(1200);

await tap('Escape');
check('pause stops the simulation', (await state()).paused === true);
const before = (await state()).alt;
await page.waitForTimeout(900);
check('nothing moves while paused', Math.abs((await state()).alt - before) < 0.001);
await tap('Escape');
check('resume restarts it', (await state()).paused === false);

const fps = await page.evaluate(() => new Promise((r) => {
  let n = 0; const t = performance.now();
  const tick = () => { if (++n < 40) requestAnimationFrame(tick); else r(Math.round(n / ((performance.now() - t) / 1000))); };
  requestAnimationFrame(tick);
}));
console.log(`\nsoftware-GL frame rate: ${fps} fps (this runner has no GPU; absolute numbers are not the game)`);
await page.evaluate(() => { document.getElementById('msg').hidden = true; });
await page.screenshot({ path: 'scripts/shot-flight.png' });

console.log(errs.length ? `\nERRORS:\n${[...new Set(errs)].join('\n')}` : '\nno page errors');
await browser.close(); await server.close();
