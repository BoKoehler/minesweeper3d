/** Starts a flight in real Chromium and screenshots it. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5310 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 740 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0].slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('fonts.g')) errs.push('console: ' + m.text().slice(0, 140)); });

const mode = process.argv[2] ?? 'runway';
const craft = process.argv[3] ?? 'Skylark';
const seconds = Number(process.argv[4] ?? 0);

await page.goto('http://localhost:5310/', { waitUntil: 'networkidle' });
await page.getByRole('radio', { name: new RegExp(craft) }).click();
if (mode === 'air') await page.locator('[data-start="air"]').click();
await page.click('#start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(2500);

if (seconds > 0) {
  // Fly: full power, hold the runway, rotate, climb away.
  await page.keyboard.press('KeyP');
  await page.keyboard.down('ShiftLeft');
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const st = await page.evaluate(() => {
      const s = window.sierra;
      return { ias: s.aircraft.telemetry.indicatedAirspeed * 1.94384, agl: s.aircraft.telemetry.radarAltitude };
    });
    if (st.ias > 60 && st.agl < 200) await page.keyboard.down('KeyS');
    else await page.keyboard.up('KeyS');
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('KeyS');
  await page.keyboard.up('ShiftLeft');
  await page.waitForTimeout(400);
}

const state = await page.evaluate(() => {
  const s = window.sierra;
  const t = s.aircraft.telemetry;
  return {
    alt: Math.round(t.altitude), agl: Math.round(t.radarAltitude), ias: Math.round(t.indicatedAirspeed * 1.94384),
    onGround: t.onGround, tiles: s.world.stats.terrainNodes, tris: s.world.stats.terrainTris,
    buildings: s.world.stats.buildingsNear + s.world.stats.buildingsFar, towns: s.world.stats.cities,
    airports: s.world.stats.airports, spawn: s.spawn.icao + ' ' + s.spawn.name,
  };
});
console.log(JSON.stringify(state));
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { if (++n < 60) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))); };
  requestAnimationFrame(tick);
}));
console.log('fps (software GL):', fps);
await page.evaluate(() => { document.getElementById('msg').hidden = true; });
await page.screenshot({ path: `scripts/shot-${mode}.png` });
console.log(errs.length ? 'ERRORS: ' + [...new Set(errs)].join(' | ') : 'no errors');
await browser.close(); await server.close();
