// Real-data smoke test: runs the app's own matching code on the collected data.
// Usage: node collector/test_basket.mjs _site
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const site = process.argv[2] || '_site';
const M = await import(pathToFileURL(path.resolve(site, 'match.js')).href);
const ix = JSON.parse(fs.readFileSync(path.join(site, 'data/index.json'), 'utf8'));
const home = { lat: 32.0597, lon: 34.8735 }; // Ganei Tikva center
const R = 3;
const hv = (a, b) => { const t = x => x * Math.PI / 180, dl = t(b.lat - a.lat), dn = t(b.lon - a.lon); const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dn / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const list = ['חלב 3%', 'קוטג׳ 5%', '2 חבילות פסטה', 'קילו עגבניות', 'קילו מלפפונים', 'חזה עוף 1.5 ק"ג', 'שמן זית', 'ביצים L', 'קפה עלית', 'קורנפלקס', 'נייר טואלט'];
const lines = list.map(M.parseLine);
const metas = ix.stores.filter(s => s.file).map(s => ({ ...s, dist: hv(home, s) })).filter(s => s.dist <= R);
const stores = metas.map(m => { const j = JSON.parse(fs.readFileSync(path.join(site, 'data', m.file), 'utf8')); return { ...j.meta, dist: m.dist, items: j.items, byCode: new Map(j.items.map(i => [i[0], i])) }; });
const out = [];
const p = (...a) => out.push(a.join(' '));
p(`data generated ${ix.generated_at}; stores within ${R}km of Ganei Tikva: ${stores.length}`);
const refs = lines.map(l => M.chooseReference(l, stores));
refs.forEach((r, i) => p(`REF ${list[i]} -> ${r.mode} ${r.item ? r.item[1] + ' | ' + r.item[2] + ' | ' + (r.code || '') + ' in ' + stores.filter(s => r.code && s.byCode.has(r.code)).length + ' stores' : ''}`));
const ranked = M.rankBaskets(M.computeBaskets(lines, stores, refs, true));
ranked.forEach((b, i) => p(`#${i + 1} ${b.store.chain_he} | ${b.store.name} | ${b.store.address} | ${b.store.dist.toFixed(1)}km | total ${b.total.toFixed(2)} | missing ${b.missing} | alts ${b.alts} | file ${b.store.price_file_time}`));
for (const b of ranked.slice(0, 3)) {
  p(`--- detail ${b.store.chain_he} ${b.store.name}`);
  b.res.forEach((r, i) => p(`   ${list[i]} :: ${r.status} :: ${r.item ? r.item[1] + ' (' + r.item[2] + ') price ' + r.item[7] + ' upd ' + r.item[9] : r.reason} :: cost ${r.cost != null ? r.cost.toFixed(2) : '-'} ${(r.notes || []).join('; ')}`));
}
const sp = M.bestSplit(ranked, home, hv);
if (sp) p(`SPLIT single ${sp.single.toFixed(2)} split ${sp.total.toFixed(2)} saving ${sp.saving.toFixed(2)} extraKm ${sp.extraKm.toFixed(1)} worth ${sp.worth} A=${sp.A.store.chain_he} ${sp.A.store.name} B=${sp.B.store.chain_he} ${sp.B.store.name}`);
const txt = out.join('\n');
console.log(txt);
fs.writeFileSync(path.join(site, 'data', 'test_report.txt'), txt);
