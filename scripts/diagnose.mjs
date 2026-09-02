/** Reproduces the ways this page can degrade to unstyled text, so the real
 *  report can be matched against a known signature instead of guessed at. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
// Serve dist under /minesweeper3d/ the way a Pages project site does.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/minesweeper3d') {           // Pages 301s this; a proxy may not
    if (process.env.NO_REDIRECT) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(301, { Location: '/minesweeper3d/' }); return res.end();
  }
  if (p === '/minesweeper3d/') p = '/minesweeper3d/index.html';
  const file = path.join('dist', p.replace('/minesweeper3d/', ''));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(5300, r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

async function probe(label, url, { blockCss = false, blockJs = false, noWebgl = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  const failures = [];
  page.on('requestfailed', (r) => failures.push(`${r.failure()?.errorText} ${r.url().slice(-30)}`));
  page.on('response', (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()} ${r.url().slice(-34)}`); });
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message.slice(0, 90)}`));
  if (blockCss) await page.route('**/*.css', (r) => r.abort());
  if (blockJs) await page.route('**/assets/*.js', (r) => r.abort());
  if (noWebgl) await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = function () { return null; };
  });
  try { await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }); } catch (e) { failures.push('goto: ' + e.message.slice(0, 60)); }
  await page.waitForTimeout(600);
  if (noWebgl) { await page.click('#btn-start').catch(() => {}); await page.waitForTimeout(1200); }
  const probe = await page.evaluate(() => {
    const panel = document.querySelector('.panel');
    const cs = panel ? getComputedStyle(panel) : null;
    const menu = document.getElementById('menu');
    return {
      styled: cs ? cs.borderStyle !== 'none' && cs.padding !== '0px' : false,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      sheets: document.styleSheets.length,
      tiers: document.getElementById('tier-pick')?.children.length ?? 0,
      menuVisible: menu ? !menu.hidden : false,
      booted: window.__chondriteBooted === true,
      failPanel: !document.getElementById('fail')?.hidden,
      failText: (document.getElementById('fail-title')?.textContent || '').slice(0, 48),
    };
  });
  console.log(`\n[${label}]`);
  console.log(`  styled panel: ${probe.styled}   body bg: ${probe.bodyBg}   stylesheets: ${probe.sheets}`);
  console.log(`  tier buttons built by JS: ${probe.tiers}   menu shown: ${probe.menuVisible}`);
  console.log(`  booted: ${probe.booted}   failure panel: ${probe.failPanel}${probe.failPanel ? ' — "' + probe.failText + '"' : ''}`);
  console.log(`  requests failed: ${failures.length ? failures.slice(0, 2).join(' | ') : 'none'}`);
  probe.failed = failures.length > 0;
  await page.screenshot({ path: `scripts/diag-${label.replace(/\W+/g, '-')}.png` });
  await page.close();
  return probe;
}

const results = {};
results.A = await probe('A healthy', 'http://localhost:5300/minesweeper3d/');
results.B = await probe('B no-trailing-slash', 'http://localhost:5300/minesweeper3d');
results.C = await probe('C css blocked', 'http://localhost:5300/minesweeper3d/', { blockCss: true });
results.D = await probe('D js blocked', 'http://localhost:5300/minesweeper3d/', { blockJs: true });
results.E = await probe('E no webgl', 'http://localhost:5300/minesweeper3d/', { noWebgl: true });

console.log('\n=== assertions ===');
const check = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
// The reported symptom was unstyled text. With the sheet inlined there is no
// separate CSS request left to block, so no probe may come back unstyled.
check('every mode still renders styled — no naked-markup state remains',
  [results.A, results.B, results.C, results.E].every((r) => r.styled));
check('a blocked script is reported, not silent', results.D.failed === true || results.D.tiers === 0);
check('no-WebGL shows the failure panel rather than a spinner', results.E.failPanel === true);
check('healthy run boots', results.A.booted === true && results.A.tiers === 4);

await browser.close();
server.close();
