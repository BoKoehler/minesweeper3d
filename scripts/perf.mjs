import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5201 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const measure = async (w, h, tier) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto('http://localhost:5201/', { waitUntil: 'networkidle' });
  await page.fill('#seed-input', 'psyche-77');
  await page.getByRole('radio', { name: new RegExp(tier) }).click();
  await page.click('#btn-start');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { if (++n < 100) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))); };
    requestAnimationFrame(tick);
  }));
  const info = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { px: c.width * c.height };
  });
  await page.close();
  return { fps: r, px: info.px };
};
for (const [w, h, tier] of [[320, 240, 'Prospect'], [640, 480, 'Prospect'], [1280, 800, 'Prospect'], [1280, 800, 'Abyssal']]) {
  const r = await measure(w, h, tier);
  console.log(`${tier.padEnd(9)} ${String(w).padStart(4)}x${h}  ${(r.px / 1e6).toFixed(2)}Mpx  ${String(r.fps).padStart(4)} fps`);
}
await browser.close(); await server.close();
