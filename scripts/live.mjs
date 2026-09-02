/** Loads the deployed GitHub Pages site and plays a few moves against it. */
import { chromium } from 'playwright';
const URL = 'https://bokoehler.github.io/minesweeper3d/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('requestfailed', (r) => { if (!r.url().includes('fonts.g')) errs.push(`failed: ${r.url()}`); });
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
console.log('title:', await page.title());
await page.fill('#seed-input', 'ryugu-808');
await page.getByRole('radio', { name: /Prospect/ }).click();
await page.click('#btn-start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(800);
for (let i = 0; i < 10; i++) { await page.click('#btn-hint'); await page.waitForTimeout(110); }
const s = await page.evaluate(() => {
  const g = window.chondrite.game;
  return { cells: g.board.hullCells.length, revealed: g.revealedCount, hull: g.hull, cores: `${g.coresExtracted}/${g.coresTotal}`, clean: g.generatedClean };
});
console.log('live game state:', JSON.stringify(s));
await page.evaluate(() => { document.getElementById('toast').hidden = true; });
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/shot-live.png' });
console.log(errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no load errors');
await browser.close();
