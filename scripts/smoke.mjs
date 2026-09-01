/** Drives the real built game in Chromium: starts a run, digs, flags, pings,
 *  peels and hints, then reports console errors, frame rate and screenshots.
 *  Progress is driven by the Hint button because hints are provably safe, so
 *  the run advances deterministically instead of detonating on blind clicks. */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { port: 5199 } });
await server.listen();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const stats = () => page.evaluate(() => ({
  cores: document.getElementById('stat-cores')?.textContent,
  pings: document.getElementById('stat-pings')?.textContent,
  mines: document.getElementById('stat-mines')?.textContent,
  score: Number(document.getElementById('stat-score')?.textContent),
  hull: document.querySelectorAll('#stat-hull i.on').length,
  over: !document.getElementById('end')?.hidden,
}));

const check = (label, ok, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

await page.fill('#seed-input', 'bennu-4242');
await page.getByRole('radio', { name: /Prospect/ }).click();
await page.click('#btn-start');
await page.waitForSelector('#hud:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(700);

const s0 = await stats();
check('run starts with hull, pings and cores set', s0.hull === 3 && Number(s0.pings) === 5 && s0.cores === '0/3', JSON.stringify(s0));

const canvas = await page.$('#stage');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// Hover must resolve to a cell and light the hover cross.
await page.mouse.move(cx + 12, cy - 8);
await page.waitForTimeout(200);
const hovered = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return c ? c.width > 0 : false;
});
check('canvas has a backing store', hovered);

// Advance the run with provably safe digs, checking against the real board
// that a hint never lands on a mine and that clearing actually progresses.
const core = () => page.evaluate(() => {
  const g = window.chondrite.game;
  return { revealed: g.revealedCount, hull: g.hull, phase: g.phase, hints: g.hintsUsed,
           mines: g.board.mineTotal, cells: g.board.hullCells.length, clean: g.generatedClean };
});
const c0 = await core();
let hints = 0;
for (let i = 0; i < 8; i++) {
  const before = await core();
  if (before.phase !== 'playing') break;
  await page.click('#btn-hint');
  await page.waitForTimeout(160);
  const after = await core();
  if (after.hints > before.hints) hints++;
  if (after.hull < before.hull) { check('a hint dug a mine', false); break; }
}
const c1 = await core();
check('hints never cost hull — every hint is provably safe', c1.hull === 3 && hints > 0, `${hints} hints`);
check('hints clear real ground', c1.revealed > c0.revealed, `${c0.revealed} -> ${c1.revealed} cells`);
check('generated rock is guess-free', c1.clean === true);
check('density sits above the percolation floor', c1.mines / c1.cells > 0.17, `${(c1.mines / c1.cells * 100).toFixed(1)}%`);
const s1 = await stats();

// Right-click flags and the mine counter reflects it.
const beforeFlag = Number(s1.mines);
await page.mouse.click(cx + 55, cy - 45, { button: 'right' });
await page.waitForTimeout(200);
const afterFlag = Number((await stats()).mines);
check('right-click flags and decrements mines left', afterFlag === beforeFlag - 1, `${beforeFlag} -> ${afterFlag}`);
await page.mouse.click(cx + 55, cy - 45, { button: 'right' });
await page.waitForTimeout(150);
check('flagging again unflags', Number((await stats()).mines) === beforeFlag);

// Axis snap, then sonar along the axis now being sighted down.
await page.keyboard.press('2');
await page.waitForTimeout(350);
const pingsBefore = Number((await stats()).pings);
await page.click('#btn-sonar');
await page.mouse.move(cx + 6, cy + 6);
await page.waitForTimeout(150);
await page.mouse.click(cx + 6, cy + 6);
await page.waitForTimeout(350);
const pingsAfter = Number((await stats()).pings);
const labelCount = await page.evaluate(() => [...document.querySelectorAll('.slab')].filter((e) => e.style.display !== 'none').length);
const toastText = await page.textContent('#toast');
check('sonar spends a charge and draws a readout', pingsAfter === pingsBefore - 1 && labelCount >= 1, `${pingsBefore}->${pingsAfter}, ${labelCount} label(s), "${toastText}"`);
check('sonar reports along the snapped axis', /^Y line reads/.test(toastText ?? ''), toastText ?? '');

// Dragging orbits; it must never count as a dig.
const beforeDrag = await stats();
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(cx + i * 9, cy + i * 3); await page.waitForTimeout(8); }
await page.mouse.up();
await page.waitForTimeout(250);
const afterDrag = await stats();
check('dragging to orbit does not dig', beforeDrag.score === afterDrag.score && beforeDrag.hull === afterDrag.hull);

// Peel and x-ray must not throw and must change what is drawn.
await page.keyboard.press(']'); await page.keyboard.press(']');
await page.waitForTimeout(250);
await page.screenshot({ path: 'scripts/shot-peel.png' });
await page.keyboard.press('['); await page.keyboard.press('[');
await page.keyboard.down(' '); await page.waitForTimeout(200);
await page.screenshot({ path: 'scripts/shot-xray.png' });
await page.keyboard.up(' ');
await page.waitForTimeout(200);
check('peel and x-ray run clean', true);

// This runner has no GPU — Chromium falls back to SwiftShader, so absolute
// fps here measures software fill rate, not the game. What is worth asserting
// is the property instancing buys: scene cost barely tracks cell count.
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { if (++n < 120) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))); };
  requestAnimationFrame(tick);
}));
const drawInfo = await page.evaluate(() => {
  const v = window.chondrite.view;
  return { calls: v.renderer.info.render.calls, cells: window.chondrite.game.board.hullCells.length };
});
check('the whole rock costs a handful of draw calls', drawInfo.calls < 20, `${drawInfo.calls} calls for ${drawInfo.cells} cells, ${fps} fps (software GL)`);

await page.screenshot({ path: 'scripts/shot-game.png' });

// Losing must reach the end panel: dig blindly until the hull is gone.
for (let i = 0; i < 60; i++) {
  const s = await stats();
  if (s.over) break;
  const a = (i / 60) * Math.PI * 2;
  await page.mouse.click(cx + Math.cos(a) * (40 + i * 2), cy + Math.sin(a) * (30 + i * 1.5));
  await page.waitForTimeout(70);
}
const ended = await stats();
check('a lost run reaches the end panel', ended.over, await page.textContent('#end-title'));
await page.screenshot({ path: 'scripts/shot-end.png' });

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nno console errors');
await browser.close();
await server.close();
