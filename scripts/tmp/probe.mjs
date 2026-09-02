import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5311 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('ERR', e.message.slice(0, 120)));
await page.goto('http://localhost:5311/', { waitUntil: 'networkidle' });
await page.locator('[data-start="air"]').click();
await page.click('#start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const s = window.sierra;
  const meshes = [];
  s.world.terrain.group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const vis = meshes.filter((m) => m.visible);
  // Where is the nearest visible terrain mesh relative to the camera?
  const cam = s.camera.position;
  let best = null, bd = Infinity;
  for (const m of vis) {
    const d = Math.hypot(m.position.x - cam.x, m.position.z - cam.z);
    if (d < bd) { bd = d; best = m; }
  }
  const box = best ? { x: best.position.x, y: best.position.y, z: best.position.z, verts: best.geometry.attributes.position.count } : null;
  // Sample the y of the first few vertices of the nearest tile.
  let ys = [];
  if (best) { const p = best.geometry.attributes.position; for (let i = 0; i < 6; i++) ys.push(Math.round(p.getY(i * 37))); }
  return {
    terrainMeshes: meshes.length, visible: vis.length,
    camera: { x: Math.round(cam.x), y: Math.round(cam.y), z: Math.round(cam.z) },
    origin: { x: s.world.origin.x, z: s.world.origin.z },
    nearestTile: box, nearestDist: Math.round(bd), sampleHeights: ys,
    waterY: s.world.water.position.y, waterVisible: s.world.water.visible,
  };
});
console.log(JSON.stringify(info, null, 1));

await page.evaluate(() => { window.sierra.world.water.visible = false; document.getElementById('msg').hidden = true; });
await page.waitForTimeout(900);
await page.screenshot({ path: 'scripts/tmp/nowater.png' });
await browser.close(); await server.close();
