import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const routes = ['/', '/today', '/fill', '/clients', '/schedule'];
for (const r of routes) {
  try {
    await p.goto('http://localhost:4173' + (r === '/' ? '/index.html' : '/index.html#' + r), { waitUntil: 'networkidle', timeout: 15000 });
    await p.waitForTimeout(1500);
    const txt = (await p.innerText('body')).replace(/\s+/g, ' ').slice(0, 120);
    console.log(r, '->', txt);
  } catch (e) { console.log(r, 'ERR', e.message.slice(0,80)); }
}
await b.close();
