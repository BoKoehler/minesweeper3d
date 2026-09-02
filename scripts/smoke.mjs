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
/** A tap plus enough time for the frame loop to consume the edge. This runner
 *  manages about 3 fps under software GL, so a press checked immediately has
 *  not been read yet. */
const tap = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(800); };
/** Wait for a condition, so timing-sensitive checks are not fixed sleeps. */
const until = async (fn, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn(await state())) return true; await page.waitForTimeout(200); }
  return false;
};

await page.goto('http://localhost:5320/', { waitUntil: 'networkidle' });
await page.click('#start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 90000 });
await page.waitForTimeout(1200);

let s = await state();
check('starts on the runway at a real airfield', s.onGround && s.ias < 1 && s.brake === true, `${s.spawn}, ${Math.round(s.alt)} m`);
check('world is populated before the first frame', s.tiles > 100 && s.towns > 0, `${s.tiles} tiles, ${s.buildings} buildings, ${s.towns} towns, ${s.airports} fields`);

// Controls move the surfaces, and ramp rather than snapping to the stops.
await page.keyboard.down('KeyS');
await page.waitForTimeout(90);
const early = (await state()).ctlPitch;
await page.waitForTimeout(500);
const later = (await state()).ctlPitch;
await page.keyboard.up('KeyS');
check('keyboard pitch ramps like a stick, not a switch', later > early && early < 0.9, `${early.toFixed(2)} -> ${later.toFixed(2)}`);
await page.waitForTimeout(700);
check('stick returns to centre when released', Math.abs((await state()).ctlPitch) < 0.15);
await hold('KeyD', 350);
check('right stick commands right aileron', (await state()).ctlRoll > 0.1);
await page.waitForTimeout(700);

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
await hold('KeyD', 600);
await page.waitForTimeout(300);
check('a stick input disconnects the autopilot', (await state()).ap === false);
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
