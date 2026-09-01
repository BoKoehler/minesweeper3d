import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('requestfailed', (r) => { if (!r.url().includes('fonts.g')) errs.push(`404? ${r.url()}`); });
await page.goto('http://localhost:5210/minesweeper3d/', { waitUntil: 'networkidle' });
await page.click('#btn-start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(800);
const ok = await page.evaluate(() => !!window.chondrite?.game?.board?.hullCells?.length);
console.log(ok ? 'PASS  production build runs from a /minesweeper3d/ sub-path' : 'FAIL  sub-path build broken');
console.log(errs.length ? 'errors: ' + errs.join(' | ') : 'no load errors');
await browser.close();
