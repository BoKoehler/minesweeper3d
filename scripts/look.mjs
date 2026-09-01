import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5202 } });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
await page.goto('http://localhost:5202/', { waitUntil: 'networkidle' });
await page.fill('#seed-input', process.argv[2] ?? 'vesta-2210');
await page.getByRole('radio', { name: /Deep Core/ }).click();
await page.click('#btn-start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(600);
// Open the rock up with provably safe digs so there is something to look at.
for (let i = 0; i < 12; i++) { await page.click('#btn-hint'); await page.waitForTimeout(90); }
await page.evaluate(() => { document.getElementById('toast').hidden = true; });
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/shot-look.png' });
await browser.close(); await server.close();
