import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' ) p = '/index.html';
  const file = path.join('dist', p);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, {'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(5301,r));
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--disable-dev-shm-usage'] });

// What a player with no WebGL sees after pressing Begin survey.
const page = await browser.newPage({ viewport:{width:900,height:620} });
const errs = [];
page.on('pageerror', e => errs.push(e.message.split('\n')[0].slice(0,110)));
await page.addInitScript(() => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...a) {
    if (String(t).includes('webgl')) return null;      // no WebGL, 2d still works
    return real.call(this, t, ...a);
  };
});
await page.goto('http://localhost:5301/', { waitUntil:'networkidle' });
await page.click('#btn-start');
await page.waitForTimeout(2500);
const s = await page.evaluate(() => ({
  busyShown: !document.getElementById('busy').hidden,
  hudShown: !document.getElementById('hud').hidden,
  menuShown: !document.getElementById('menu').hidden,
  visibleText: (document.getElementById('busy')?.innerText || '').trim().slice(0,60),
}));
console.log('no-WebGL after pressing Begin survey:', JSON.stringify(s));
console.log('page errors:', errs.length ? errs.join(' | ') : 'none');
await page.screenshot({ path:'scripts/diag-F-nowebgl-start.png' });
await browser.close(); server.close();
