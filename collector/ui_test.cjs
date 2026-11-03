// End-to-end UI test on the real published data (runs in GitHub Actions).
// node collector/ui_test.cjs <siteDir> <outDir>
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, devices } = require('playwright');
const site = path.resolve(process.argv[2] || 't'), out = path.resolve(process.argv[3] || 'out');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(8099);
const log = [];
const p = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'], locale: 'he-IL' });
  const page = await ctx.newPage();
  page.on('pageerror', e => p('PAGE ERROR', e.message));
  // home address lookup: the real Nominatim answer for Ganei Tikva center (kept offline for a stable test)
  await page.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ lat: '32.0597', lon: '34.8735', display_name: 'גני תקווה, מחוז המרכז, ישראל' }]) }));
  await page.route('**/overpass-api.de/**', r => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));
  page.on('dialog', d => d.accept('הסופרים הקבועים שלי'));
  await page.goto('http://localhost:8099/');
  await page.waitForFunction(() => !/טוען/.test(document.querySelector('#dataStatus').textContent));
  p('STATUS', (await page.textContent('#dataStatus')).replace(/\s+/g, ' '));

  const list = ['חלב 3%', 'קוטג׳ 5%', '2 חבילות פסטה', 'קילו עגבניות', 'קילו מלפפונים', 'חזה עוף 1.5 ק"ג', 'שמן זית', 'ביצים L', 'קפה עלית', 'קורנפלקס', 'נייר טואלט'];
  await page.fill('#listText', list.join('\n'));
  await page.fill('#address', 'גני תקווה');

  // ---- manual mode
  await page.click('#modeChips button[data-m="manual"]');
  const wanted = [['רמי לוי', 'קריית אונו'], ['שופרסל דיל', 'גבעת שמואל'], ['יוחננוף', 'פתח תקווה'], ['ויקטורי', 'קריית אונו'], ['קרפור', 'יהוד'], ['טיב טעם', 'קריית אונו'], ['רמי לוי', 'גבעת שמואל'], ['שופרסל דיל', 'פתח תקווה']];
  for (const [c, a] of wanted) {
    await page.fill('#bChain', c); await page.fill('#bAddr', a); await page.click('#bFind');
    await page.waitForFunction(() => !/מחפש/.test(document.querySelector('#bResults').textContent));
    const cands = await page.$$eval('#bResults .cand', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
    p(`SEARCH "${c}" / "${a}" -> ${cands.length - 1} candidates`); cands.slice(0, 4).forEach(t => p('   ', t));
    const add = await page.$('#bResults button[data-i]:not([disabled])');
    if (add) await add.click(); else await page.click('#bResults button[data-custom]');
  }
  await page.screenshot({ path: path.join(out, '1-branches.png'), fullPage: true });
  p('SELECTED:'); (await page.$$eval('#bSelected li', els => els.map(e => e.innerText.replace(/\s+/g, ' ')))).forEach(t => p('   ', t));

  // save as "הסופרים הקבועים שלי"
  await page.click('#saveBranchesBtn');
  p('MSG', await page.textContent('#msg'));

  await page.click('#compareBtn');
  await page.waitForSelector('#matrixCard:not([hidden]) table', { timeout: 60000 });
  await page.waitForTimeout(500);
  p('SUMMARY', (await page.innerText('#summary')).replace(/\s+/g, ' '));
  const matrix = await page.$$eval('#matrixCard table tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim()).join(' || ')));
  p('MATRIX:'); matrix.forEach(r => p('   ', r));
  p('RANK', (await page.innerText('#matrixCard .rank-list')).replace(/\n/g, ' | '));
  p('SPLIT', (await page.innerText('#splitCard')).replace(/\s+/g, ' ').slice(0, 400));
  await page.screenshot({ path: path.join(out, '2-results.png'), fullPage: true });
  const mc = await page.$('#matrixCard'); await mc.screenshot({ path: path.join(out, '3-matrix.png') });

  // ---- saved set survives reload
  await page.reload();
  await page.waitForFunction(() => !/טוען/.test(document.querySelector('#dataStatus').textContent));
  await page.evaluate(() => { localStorage.removeItem('sk_branches'); });
  await page.reload();
  await page.waitForFunction(() => !/טוען/.test(document.querySelector('#dataStatus').textContent));
  const opts = await page.$$eval('#savedBranchSets option', os => os.map(o => [o.value, o.textContent]));
  p('SAVED SETS', JSON.stringify(opts));
  await page.selectOption('#savedBranchSets', opts[1][0]);
  p('AFTER LOAD selected count', await page.$$eval('#bSelected li', l => l.length));

  // ---- remove one branch
  await page.click('#bSelected li button.x');
  p('AFTER REMOVE selected count', await page.$$eval('#bSelected li', l => l.length));

  // ---- existing radius mode still works
  await page.click('#modeChips button[data-m="radius"]');
  await page.click('#radiusChips button[data-r="3"]');
  await page.click('#compareBtn');
  await page.waitForSelector('#rankCard:not([hidden]) #rankTable tr.click', { timeout: 60000 });
  p('RADIUS SUMMARY', (await page.innerText('#summary')).replace(/\s+/g, ' '));
  p('RADIUS TOP3', (await page.$$eval('#rankTable tr.click', t => t.slice(0, 3).map(r => r.innerText.replace(/\s+/g, ' ')))).join(' | '));
  await page.screenshot({ path: path.join(out, '4-radius.png'), fullPage: true });

  fs.writeFileSync(path.join(out, 'ui_test.txt'), log.join('\n'));
  await b.close(); srv.close();
})().catch(e => { console.error(e); fs.writeFileSync(path.join(out, 'ui_test.txt'), log.join('\n') + '\nFAILED: ' + e.stack); process.exit(1); });
