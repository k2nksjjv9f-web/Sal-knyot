import * as M from './match.js';
const { I } = M;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ils = n => `${n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₪`;
const km = n => n == null || isNaN(n) ? '—' : `${n.toLocaleString('he-IL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ק"מ`;

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem('sk_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sk_' + k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem('sk_' + k); } catch { } },
};

const state = {
  index: null, home: store.get('home', null), radius: store.get('radius', 3),
  pins: store.get('pins', {}), // normalized line -> item code
  storeCache: new Map(), last: null,
  mode: store.get('mode', 'radius'), branches: store.get('branches', []), directory: null,
};

function haversine(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function msg(text, err = false) { const m = $('#msg'); m.textContent = text || ''; m.className = 'msg' + (err ? ' err' : ''); }

// ---------------------------------------------------------------- init
async function loadIndex() {
  try {
    const r = await fetch('data/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    state.index = await r.json();
    const ix = state.index;
    const withPrices = ix.stores.filter(s => s.file).length;
    $('#dataStatus').innerHTML = `עדכון אחרון: ${esc(ix.generated_at)}<br>${withPrices} סניפים עם מחירים · אזור: ${esc(ix.area.label)}`;
  } catch (e) {
    $('#dataStatus').textContent = 'נתוני המחירים עדיין לא זמינים';
    msg('נתוני המחירים עוד לא נאספו. האיסוף רץ אוטומטית כל 4 שעות.', true);
  }
}

function initUI() {
  if (state.home) { $('#address').value = state.home.text; $('#addrResult').textContent = '✓ ' + (state.home.label || ''); }
  document.querySelectorAll('#radiusChips button').forEach(b => {
    b.classList.toggle('on', +b.dataset.r === state.radius);
    b.onclick = () => {
      state.radius = +b.dataset.r; store.set('radius', state.radius);
      document.querySelectorAll('#radiusChips button').forEach(x => x.classList.toggle('on', x === b));
    };
  });
  $('#listText').value = store.get('current', '');
  $('#listText').addEventListener('input', () => store.set('current', $('#listText').value));
  $('#usePromos').checked = store.get('promos', true);
  $('#usePromos').onchange = () => { store.set('promos', $('#usePromos').checked); if (state.last) (state.last.manual ? runManualCompare() : runCompare()); };
  $('#addLineBtn').onclick = addLine;
  $('#addLine').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addLine(); } });
  $('#locateBtn').onclick = () => geocode(true);
  $('#address').addEventListener('change', () => { state.home = null; $('#addrResult').textContent = ''; });
  $('#compareBtn').onclick = () => state.mode === 'manual' ? runManualCompare() : runCompare();
  $('#saveListBtn').onclick = saveList;
  $('#delListBtn').onclick = deleteList;
  $('#savedLists').onchange = loadList;
  $('#dlgClose').onclick = () => $('#storeDlg').close();
  $('#pickClose').onclick = () => $('#pickDlg').close();
  renderSavedLists();
  initBranchUI();
}

function addLine() {
  const v = $('#addLine').value.trim();
  if (!v) return;
  const t = $('#listText');
  t.value = (t.value.trim() ? t.value.replace(/\s*$/, '') + '\n' : '') + v;
  $('#addLine').value = '';
  store.set('current', t.value);
}

// ---------------------------------------------------------------- saved lists
function lists() { return store.get('lists', []); }
function renderSavedLists() {
  const sel = $('#savedLists');
  sel.innerHTML = '<option value="">רשימות שמורות…</option>' +
    lists().map(l => `<option value="${esc(l.id)}">${esc(l.name)} (${esc(l.updated)})</option>`).join('');
}
function saveList() {
  const text = $('#listText').value.trim();
  if (!text) return msg('הרשימה ריקה', true);
  const cur = $('#savedLists').value;
  const all = lists();
  const existing = all.find(l => l.id === cur);
  const name = prompt('שם לרשימה:', existing ? existing.name : 'קנייה שבועית');
  if (!name) return;
  const today = new Date().toLocaleDateString('he-IL');
  if (existing && existing.name === name) { existing.text = text; existing.updated = today; }
  else all.unshift({ id: String(Date.now()), name, text, updated: today });
  store.set('lists', all);
  renderSavedLists();
  msg('הרשימה נשמרה במכשיר');
}
function loadList() {
  const l = lists().find(x => x.id === $('#savedLists').value);
  if (l) { $('#listText').value = l.text; store.set('current', l.text); msg(`נטענה הרשימה "${l.name}" – אפשר לערוך ולהשוות מחדש`); }
}
function deleteList() {
  const id = $('#savedLists').value;
  if (!id) return msg('בחר רשימה שמורה כדי למחוק', true);
  store.set('lists', lists().filter(l => l.id !== id));
  renderSavedLists();
  msg('הרשימה נמחקה');
}

// ---------------------------------------------------------------- geocoding
async function geocode(explicit) {
  const text = $('#address').value.trim();
  if (!text) { msg('יש להזין כתובת', true); return null; }
  if (state.home && state.home.text === text) return state.home;
  $('#addrResult').textContent = 'מאתר…';
  try {
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.search = new URLSearchParams({ q: text, format: 'jsonv2', limit: 1, countrycodes: 'il', 'accept-language': 'he' });
    const r = await fetch(u);
    const j = await r.json();
    if (!j.length) { $('#addrResult').textContent = ''; msg('הכתובת לא נמצאה. נסה לכתוב רחוב, מספר ועיר.', true); return null; }
    const label = j[0].display_name.split(',').slice(0, 3).join(',');
    state.home = { text, lat: +j[0].lat, lon: +j[0].lon, label };
    if ($('#saveAddr').checked) store.set('home', state.home); else store.del('home');
    $('#addrResult').textContent = '✓ ' + label;
    if (explicit) msg('');
    return state.home;
  } catch (e) {
    $('#addrResult').textContent = '';
    msg('שירות איתור הכתובות לא זמין כרגע. נסה שוב בעוד רגע.', true);
    return null;
  }
}

// ---------------------------------------------------------------- data
async function loadStore(meta) {
  if (state.storeCache.has(meta.id)) return state.storeCache.get(meta.id);
  const r = await fetch('data/' + meta.file);
  if (!r.ok) throw new Error('store ' + meta.id);
  const j = await r.json();
  const st = { ...j.meta, items: j.items, byCode: new Map(j.items.map(it => [it[I.code], it])) };
  state.storeCache.set(meta.id, st);
  return st;
}

async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k]().catch(e => ({ error: e })); } }));
  return out;
}

// ---------------------------------------------------------------- compare
async function runCompare() {
  const btn = $('#compareBtn');
  if (!state.index) return msg('נתוני המחירים עוד לא זמינים', true);
  const home = await geocode(false);
  if (!home) return;
  const lines = $('#listText').value.split('\n').map(s => s.trim()).filter(Boolean).map(M.parseLine).filter(l => l.tokens.length);
  if (!lines.length) return msg('יש להזין לפחות מוצר אחד', true);

  const ix = state.index;
  const dFromArea = haversine(home, ix.area);
  if (dFromArea + state.radius > ix.area.radius_km + 0.5) {
    msg(`שים לב: הכתובת רחוקה ${km(dFromArea)} ממרכז אזור האיסוף (${ix.area.label}). ייתכן שחלק מהסניפים לא נאספו.`, true);
  }
  const near = ix.stores.map(s => ({ ...s, dist: haversine(home, s) })).filter(s => s.dist <= state.radius).sort((a, b) => a.dist - b.dist);
  const withData = near.filter(s => s.file);
  if (!withData.length) {
    msg('לא נמצאו סניפים עם נתוני מחירים ברדיוס שנבחר. נסה רדיוס גדול יותר.', true);
    $('#results').hidden = true; return;
  }
  btn.disabled = true; btn.textContent = `טוען מחירים מ-${withData.length} סניפים…`;
  try {
    const loaded = (await pool(withData.map(m => () => loadStore(m).then(st => Object.assign(st, { dist: m.dist }))), 6)).filter(x => x && !x.error);
    const usePromos = $('#usePromos').checked;
    const refs = lines.map(l => M.chooseReference(l, loaded, state.pins[M.norm(l.raw)]));
    const baskets = M.rankBaskets(M.computeBaskets(lines, loaded, refs, usePromos));
    const split = M.bestSplit(baskets, home, (a, b) => haversine(a, b));
    state.last = { lines, loaded, refs, baskets, split, near, home };
    render();
    msg('');
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    findNoDataSupermarkets(home, near);
  } catch (e) {
    console.error(e);
    msg('שגיאה בטעינת נתוני המחירים: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'השווה מחירים';
  }
}

function storeName(s) { return `${s.chain_he} – ${s.name || s.store_id}`; }
function staleTag(s) { return s.stale ? `<span class="tag stale" title="הנתון מהאיסוף הקודם">ישן: ${esc(s.price_file_time)}</span>` : ''; }

function render() {
  const { lines, baskets, split } = state.last;
  showCards(false);
  const minMissing = baskets[0].missing;
  const group = baskets.filter(b => b.missing === minMissing);
  const cheap = group[0], exp = group[group.length - 1];
  const diff = exp.total - cheap.total;
  const pct = exp.total > 0 ? diff / exp.total * 100 : 0;

  $('#summary').innerHTML = `
    <div class="stat good"><div class="k">הסופר הזול ביותר</div><div class="v">${ils(cheap.total)}</div><div class="s">${esc(storeName(cheap.store))} · ${km(cheap.store.dist)}</div></div>
    <div class="stat"><div class="k">הסופר היקר ביותר</div><div class="v">${ils(exp.total)}</div><div class="s">${esc(storeName(exp.store))}</div></div>
    <div class="stat"><div class="k">הפרש</div><div class="v">${ils(diff)}</div><div class="s">בין הזול ליקר</div></div>
    <div class="stat"><div class="k">חיסכון</div><div class="v">${pct.toFixed(1)}%</div><div class="s">${group.length} סניפים עם ${minMissing ? minMissing + ' חסרים' : 'סל מלא'}</div></div>`;

  $('#rankNote').innerHTML = `${lines.length} מוצרים · ${baskets.length} סניפים עם נתונים ברדיוס ${state.radius} ק"מ (מרחק אווירי). הדירוג: קודם לפי מספר המוצרים החסרים, ואחר כך לפי מחיר, כדי לא להציג כזול סופר שפשוט חסרים בו מוצרים. ההשוואה בין הזול ליקר נעשית רק בין סניפים עם אותו מספר חסרים. לחיצה על שורה פותחת את הפירוט המלא.`;

  $('#rankTable').innerHTML = `<thead><tr><th>#</th><th>רשת וסניף</th><th>מרחק</th><th>מחיר הסל</th><th>חסרים</th><th class="hide-m">חלופות</th></tr></thead><tbody>` +
    baskets.map((b, i) => `<tr class="click ${i === 0 ? 'first' : ''}" data-i="${i}">
      <td>${i + 1}</td>
      <td><b>${esc(b.store.chain_he)}</b><div class="sub">${esc(b.store.name)}${b.store.address ? ' · ' + esc(b.store.address) : ''}</div>${staleTag(b.store)}${b.store.loc_quality === 'city' ? '<span class="tag alt">מיקום משוער</span>' : ''}</td>
      <td class="num">${km(b.store.dist)}</td>
      <td class="num price">${ils(b.total)}</td>
      <td class="num ${b.missing ? 'bad' : 'ok'}">${b.missing}</td>
      <td class="num hide-m">${b.alts}</td></tr>`).join('') + '</tbody>';
  document.querySelectorAll('#rankTable tr.click').forEach(tr => tr.onclick = () => openStore(baskets[+tr.dataset.i]));

  renderSplit(split);
  renderLineRefs();
  renderCoverage();
}

function renderSplit(sp) {
  const el = $('#splitCard');
  if (!sp) { el.innerHTML = '<h2>קנייה מפוצלת</h2><p class="muted">לא נמצא שילוב של שני סניפים שמכסה את אותם מוצרים בזול יותר.</p>'; return; }
  const items = (side) => state.last.lines.filter((_, i) => sp.pick[i] === side).map(l => esc(l.raw)).join(', ');
  el.innerHTML = `<h2>קנייה מפוצלת בין שני סופרים</h2>
    <div class="split-grid">
      <div class="stat"><div class="k">סופר אחד</div><div class="v">${ils(sp.single)}</div><div class="s">${esc(storeName(sp.best.store))}</div></div>
      <div class="stat"><div class="k">מפוצל</div><div class="v">${ils(sp.total)}</div><div class="s">2 סניפים</div></div>
      <div class="stat ${sp.worth ? 'good' : ''}"><div class="k">חיסכון</div><div class="v">${ils(Math.max(0, sp.saving))}</div><div class="s">${(sp.saving / sp.single * 100).toFixed(1)}%</div></div>
      <div class="stat"><div class="k">נסיעה נוספת</div><div class="v">${sp.noDist ? '—' : km(sp.extraKm)}</div><div class="s">${sp.noDist ? 'הזן כתובת לחישוב מרחק' : 'מסלול בית ← א ← ב ← בית'}</div></div>
    </div>
    <p class="small"><b>א: ${esc(storeName(sp.A.store))}</b> – ${items('A')}<br><b>ב: ${esc(storeName(sp.B.store))}</b> – ${items('B')}</p>
    <div class="verdict ${sp.worth ? 'yes' : 'no'}">${sp.worth
      ? `מומלץ לפצל: חוסכים ${ils(sp.saving)}${sp.noDist ? '' : `, בתוספת נסיעה של כ-${km(sp.extraKm)}`}.`
      : `לא מומלץ לפצל: החיסכון (${ils(Math.max(0, sp.saving))}) נמוך מהסף (${ils(sp.threshold)}, הגבוה מבין 15 ₪ ל-5% מהסל), ולא מצדיק את הטרחה.`}</div>`;
}

function renderLineRefs() {
  const { lines, refs, loaded } = state.last;
  $('#lineRefs').innerHTML = lines.map((l, i) => {
    const r = refs[i];
    let what;
    if (r.mode === 'none') what = '<span class="tag missing">לא נמצא</span>';
    else if (r.mode === 'name') what = `${esc(r.item[I.name])} <span class="tag name">התאמה לפי שם</span><div class="sub">מוצר ללא ברקוד אחיד (למשל ירקות או בשר במשקל), ולכן בכל סניף נבחר הפריט המתאים ביותר בשמו</div>`;
    else {
      const sz = M.itemSize(r.item);
      const n = loaded.filter(s => s.byCode.has(r.code)).length;
      what = `${esc(r.item[I.name])}${r.item[I.man] ? ' · ' + esc(r.item[I.man]) : ''}${sz ? ' · ' + M.sizeLabel(sz) : ''} ${r.pinned ? '<span class="tag exact">נבחר ידנית</span>' : ''}<div class="sub">ברקוד ${esc(r.code)} · נמצא ב-${n} מתוך ${loaded.length} סניפים</div>`;
    }
    return `<div class="lineref"><div><b>${esc(l.raw)}</b><div class="small">${what}</div></div><button class="btn ghost sm" data-i="${i}">החלף</button></div>`;
  }).join('');
  document.querySelectorAll('#lineRefs button').forEach(b => b.onclick = () => openPicker(+b.dataset.i));
}

function openPicker(i) {
  const { lines, loaded } = state.last;
  const l = lines[i];
  const seen = new Map();
  for (const st of loaded) for (const it of st.items) {
    const s = M.scoreItem(l, it);
    if (!s) continue;
    const key = it[I.bc] ? it[I.code] : 'n:' + it[I.name];
    const cur = seen.get(key) || { it, score: s.score, n: 0, min: Infinity, max: 0 };
    cur.n++; cur.min = Math.min(cur.min, it[I.price]); cur.max = Math.max(cur.max, it[I.price]);
    cur.score = Math.max(cur.score, s.score);
    seen.set(key, cur);
  }
  const top = [...seen.values()].filter(c => c.it[I.bc]).sort((a, b) => (b.score + 0.3 * b.n / loaded.length) - (a.score + 0.3 * a.n / loaded.length)).slice(0, 25);
  $('#pickTitle').textContent = `בחירת מוצר: ${l.raw}`;
  const key = M.norm(l.raw);
  $('#pickBody').innerHTML = (state.pins[key] ? `<div class="pick"><div>חזרה לבחירה אוטומטית</div><button class="btn ghost sm" data-c="">אוטומטי</button></div>` : '') +
    (top.length ? top.map(c => {
      const sz = M.itemSize(c.it);
      return `<div class="pick"><div><b>${esc(c.it[I.name])}</b><div class="sub">${esc(c.it[I.man])}${sz ? ' · ' + M.sizeLabel(sz) : ''} · ברקוד ${esc(c.it[I.code])} · ב-${c.n} סניפים · ${ils(c.min)}${c.max > c.min ? '–' + ils(c.max) : ''}</div></div><button class="btn ghost sm" data-c="${esc(c.it[I.code])}">בחר</button></div>`;
    }).join('') : '<p class="muted">לא נמצאו מוצרים עם ברקוד שמתאימים לשורה הזו. נסה לנסח אחרת ברשימה.</p>');
  $('#pickBody').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.c) state.pins[key] = b.dataset.c; else delete state.pins[key];
    store.set('pins', state.pins);
    $('#pickDlg').close();
    state.last && state.last.manual ? runManualCompare() : runCompare();
  });
  $('#pickDlg').showModal();
}

function openStore(b) {
  const s = b.store, { lines } = state.last;
  $('#dlgTitle').textContent = storeName(s);
  $('#dlgSub').innerHTML = `${esc(s.address)}${s.city ? ', ' + esc(s.city) : ''} · ${km(s.dist)} · סה"כ ${ils(b.total)} · ${b.missing} חסרים<br>
    מקור: קובץ ${esc(s.price_file)} (פורסם ${esc(s.price_file_time)})${s.promo_file ? ` · מבצעים: ${esc(s.promo_file)}` : ''} · נאסף ${esc(s.fetched_at)} ${staleTag(s)}`;
  const label = { exact: 'מדויק', alt: 'חלופה', name: 'לפי שם', missing: 'חסר מידע' };
  $('#dlgBody').innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>ביקשת</th><th>מוצר בסניף</th><th>אריזה</th><th>מחיר</th><th>כמות</th><th>סה"כ</th><th>עודכן</th></tr></thead><tbody>` +
    b.res.map((r, i) => {
      if (r.status === 'missing') return `<tr><td>${esc(lines[i].raw)}</td><td colspan="6"><span class="tag missing">חסר מידע</span> <span class="sub">${esc(r.reason)}</span></td></tr>`;
      const it = r.item, sz = M.itemSize(it);
      const promo = r.promo ? `<span class="tag promo">מבצע: ${esc(r.promo[1])}${r.promo[2] ? ' עד ' + esc(r.promo[2].slice(0, 10)) : ''}</span><div class="sub">מחיר מדף ${ils(it[I.price])}</div>` :
        (it[I.promo] && it[I.promo][4] === 'info' ? `<div class="sub">מבצע שלא נכלל בחישוב: ${esc(it[I.promo][1])}</div>` : '');
      return `<tr><td>${esc(lines[i].raw)}</td>
        <td>${esc(it[I.name])} <span class="tag ${r.status}">${label[r.status]}</span><div class="sub">${esc(it[I.man])}${it[I.bc] ? ' · ' + esc(it[I.code]) : ''}</div>${(r.notes || []).map(n => `<div class="sub warn">${esc(n)}</div>`).join('')}</td>
        <td class="num">${it[I.w] ? 'לק"ג' : (sz ? M.sizeLabel(sz) : '—')}</td>
        <td class="num">${ils(r.unitPrice)}${promo}</td>
        <td class="num">${esc(r.qtyLabel)}</td>
        <td class="num price">${ils(r.cost)}</td>
        <td class="num sub">${esc(it[I.upd] || '')}</td></tr>`;
    }).join('') + '</tbody></table></div>';
  $('#storeDlg').showModal();
}

function renderCoverage() {
  const ix = state.index;
  const label = { ok: '<span class="ok">✓ נאסף</span>', partial: '<span class="warn">חלקי</span>', error: '<span class="bad">✗ לא נגיש</span>' };
  const chains = [...ix.chains].sort((a, b) => (b.stores_in_area - a.stores_in_area));
  $('#coverageCard').innerHTML = `<h2>מקורות המידע וכיסוי</h2>
    <p class="small muted">${esc(ix.source)}. האיסוף האחרון: ${esc(ix.generated_at)}. כל מחיר מוצג עם שם הקובץ הרשמי שממנו נלקח ועם מועד העדכון שלו.</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>רשת</th><th>סטטוס</th><th>סניפים באזור האיסוף</th><th>עם מחירים</th></tr></thead><tbody>` +
    chains.map(c => `<tr><td>${esc(c.name)}</td><td>${label[c.status] || esc(c.status)}${c.detail ? `<div class="sub">${esc(friendlyErr(c))}</div>` : ''}</td><td class="num">${c.status === 'error' ? '—' : c.stores_in_area}</td><td class="num">${c.stores_with_prices}</td></tr>`).join('') +
    '</tbody></table></div>';
}

function friendlyErr(c) {
  const d = c.detail || '';
  if (d.startsWith('geo-blocked') || ['carrefour', 'victory', 'mahsanei-hashuk', 'het-cohen', 'hatzi-hinam'].includes(c.slug))
    return 'הפורטל של הרשת עונה רק לכתובות IP מישראל, ושרת האיסוף נמצא מחוץ לישראל. הרשת לא נכללת בהשוואה.';
  if (/timed out|timeout|Timeout/.test(d)) return 'הפורטל של הרשת לא הגיב בזמן בריצה האחרונה. ייאסף שוב בריצה הבאה.';
  if (/^דילוג/.test(d)) return d;
  return 'שגיאה בקריאת הפורטל: ' + d;
}

// independents / chains without data, from OpenStreetMap
async function findNoDataSupermarkets(home, near) {
  const el = $('#noDataCard');
  el.innerHTML = '<h2>סופרים נוספים באזור ללא נתוני מחירים</h2><p class="muted small">מחפש במפה…</p>';
  try {
    const R = Math.round(state.radius * 1000);
    const q = `[out:json][timeout:25];(node["shop"="supermarket"](around:${R},${home.lat},${home.lon});way["shop"="supermarket"](around:${R},${home.lat},${home.lon}););out center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await r.json();
    const covered = near.filter(s => s.file);
    const rows = j.elements.map(e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, name: e.tags?.['name:he'] || e.tags?.name || 'סופרמרקט', brand: e.tags?.brand || '', street: [e.tags?.['addr:street'], e.tags?.['addr:housenumber']].filter(Boolean).join(' ') }))
      .filter(x => x.lat && !covered.some(s => haversine(s, x) < 0.15))
      .map(x => ({ ...x, dist: haversine(home, x) })).sort((a, b) => a.dist - b.dist);
    el.innerHTML = `<h2>סופרים נוספים באזור ללא נתוני מחירים</h2>
      <p class="muted small">סניפים שמופיעים במפה הפתוחה (OpenStreetMap) ברדיוס שבחרת, אבל אין עבורם קובץ מחירים באיסוף. בדרך כלל אלה סופרים עצמאיים שלא חייבים לפרסם מחירים, או רשתות שהפורטל שלהן חסום. הם לא נכללים בהשוואה.</p>` +
      (rows.length ? `<div class="table-wrap"><table class="tbl"><tbody>${rows.map(x => `<tr><td>${esc(x.name)}${x.brand && x.brand !== x.name ? ` <span class="sub">(${esc(x.brand)})</span>` : ''}<div class="sub">${esc(x.street)}</div></td><td class="num">${km(x.dist)}</td><td><span class="tag missing">אין נתוני מחירים</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="small">לא נמצאו סופרים נוספים במפה.</p>');
  } catch (e) {
    el.innerHTML = '<h2>סופרים נוספים באזור</h2><p class="muted small">שירות המפה לא זמין כרגע.</p>';
  }
}

// ================================================================
// Manual branch selection ("סניפים שבחרתי")
// ================================================================
function showCards(manual) {
  $('#matrixCard').hidden = !manual;
  $('#rankCard').hidden = manual;
  $('#noDataCard').hidden = manual;
}

function setMode(m) {
  state.mode = m; store.set('mode', m);
  document.querySelectorAll('#modeChips button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('#radiusBlock').hidden = m === 'manual';
  $('#branchBlock').hidden = m !== 'manual';
  $('#addrLabel').textContent = m === 'manual' ? 'כתובת הבית (לא חובה – לחישוב מרחקים)' : 'כתובת';
  $('#compareBtn').textContent = 'השווה מחירים';
  if (m === 'manual') loadDirectory();
}

function initBranchUI() {
  document.querySelectorAll('#modeChips button').forEach(b => b.onclick = () => setMode(b.dataset.m));
  $('#bFind').onclick = findBranchUI;
  ['#bChain', '#bAddr'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findBranchUI(); } }));
  $('#saveBranchesBtn').onclick = saveBranchSet;
  $('#delBranchesBtn').onclick = deleteBranchSet;
  $('#savedBranchSets').onchange = loadBranchSet;
  renderBranchSets();
  renderSelected();
  setMode(state.mode);
  importPresets();
}

async function loadDirectory() {
  if (state.directory) return state.directory;
  try {
    const r = await fetch('data/directory.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    state.directory = (await r.json()).stores;
  } catch {
    // older deployment without a directory: fall back to branches that have prices
    state.directory = state.index ? state.index.stores.map(s => ({ ...s })) : [];
  }
  const names = new Set([...(state.index?.chains || []).map(c => c.name), ...state.directory.map(d => d.chain_he)]);
  for (const d of state.directory) if (d.sub_chain && d.sub_chain !== d.chain_he && d.sub_chain.length < 25) names.add(d.sub_chain);
  $('#chainList').innerHTML = [...names].sort().map(n => `<option value="${esc(n)}">`).join('');
  return state.directory;
}

function chainInfo(slug) { return (state.index?.chains || []).find(c => c.slug === slug); }

/** Why a selected branch has (or lacks) prices. Never substitutes another branch. */
function branchStatus(sel) {
  if (sel.note) return { ok: false, reason: sel.note };
  if (sel.chain) {
    const chx = chainInfo(sel.chain);
    if (chx && chx.status === 'error' && (!sel.id || !state.index?.stores.some(s => s.id === sel.id && s.file))) return { ok: false, reason: friendlyErr(chx) };
  }
  if (!sel.id) return { ok: false, reason: 'הסניף לא זוהה ברשימת הסניפים הרשמית של הרשת, ולכן אין לו נתוני מחירים' };
  const meta = state.index?.stores.find(s => s.id === sel.id);
  if (meta && meta.file) return { ok: true, meta };
  const ch = chainInfo(sel.chain);
  if (ch && ch.status === 'error') return { ok: false, reason: friendlyErr(ch) };
  if (meta) return { ok: false, reason: 'הרשת לא פרסמה קובץ מחירים לסניף הזה באיסוף האחרון' };
  const a = state.index?.area;
  return { ok: false, reason: `הסניף מחוץ לאזור האיסוף (עד ${a ? a.radius_km : 7} ק"מ מ${a ? a.label : 'מרכז האזור'}), ולכן מחיריו לא נאספו` };
}

function branchLine(b) {
  return `<b>${esc(b.chain_he)}</b> – ${esc(b.name || '')}<div class="sub">${esc([b.address, b.city].filter(Boolean).join(', '))}</div>`;
}

async function findBranchUI() {
  const chain = $('#bChain').value.trim(), addr = $('#bAddr').value.trim();
  const el = $('#bResults');
  if (!chain && !addr) { el.innerHTML = '<p class="small bad">יש להקליד שם רשת או כתובת</p>'; return; }
  el.innerHTML = '<p class="small muted">מחפש…</p>';
  const dir = await loadDirectory();
  const priced = new Set((state.index?.stores || []).filter(x => x.file).map(x => x.id));
  const found = M.findBranches(chain, addr, dir, addr ? 12 : 40, { priority: b => priced.has(b.id) ? 1 : 0 });
  const chosen = new Set(state.branches.map(b => b.id).filter(Boolean));
  let html = '';
  if (found.length) {
    html = found.map((b, i) => {
      const st = branchStatus(b);
      const info = st.ok ? `<span class="tag exact">יש מחירים</span> <span class="sub">קובץ מ-${esc(st.meta.price_file_time)}</span>` : `<span class="tag missing">אין נתוני מחירים</span>`;
      return `<div class="cand"><div>${branchLine(b)}<div>${info}</div></div>
        <button class="btn ghost sm" data-i="${i}" ${chosen.has(b.id) ? 'disabled' : ''}>${chosen.has(b.id) ? 'נבחר' : 'הוסף'}</button></div>`;
    }).join('');
  } else {
    html = `<p class="small">לא נמצא סניף תואם ברשימות הסניפים הרשמיות שהרשתות מפרסמות. נסה לכתוב רק את שם העיר או את שם הרחוב.</p>`;
  }
  // allow adding an unrecognised branch explicitly (shown as "no price data", never priced from another branch)
  if (chain) html += `<div class="cand"><div class="small muted">הסניף שחיפשת לא ברשימה? אפשר להוסיף אותו כמו שהקלדת. הוא יוצג בטבלה עם הסימון "אין נתוני מחירים".</div><button class="btn ghost sm" data-custom="1">הוסף כמו שהוקלד</button></div>`;
  el.innerHTML = html;
  el.querySelectorAll('button[data-i]').forEach(btn => btn.onclick = () => {
    const b = found[+btn.dataset.i];
    addBranch({ id: b.id, chain: b.chain, chain_he: b.chain_he, store_id: b.store_id, name: b.name, address: b.address, city: b.city });
    btn.disabled = true; btn.textContent = 'נבחר';
  });
  const cb = el.querySelector('button[data-custom]');
  if (cb) cb.onclick = () => {
    addBranch({ id: null, chain: null, chain_he: chain, name: 'סניף לא מזוהה', address: addr, city: '' });
    el.innerHTML = '';
  };
}

function addBranch(b) {
  if (b.id && state.branches.some(x => x.id === b.id)) return;
  state.branches.push(b);
  store.set('branches', state.branches);
  renderSelected();
}

function renderSelected() {
  const ol = $('#bSelected');
  if (!state.branches.length) { ol.innerHTML = ''; return; }
  ol.innerHTML = state.branches.map((b, i) => {
    const st = state.index ? branchStatus(b) : { ok: true };
    return `<li><div class="li-row"><div>${branchLine(b)}${st.ok ? '' : `<div class="sub warn">אין נתוני מחירים: ${esc(st.reason)}</div>`}</div>
      <button class="x" data-i="${i}" title="הסר" aria-label="הסר סניף">✕</button></div></li>`;
  }).join('');
  ol.querySelectorAll('button.x').forEach(btn => btn.onclick = () => {
    state.branches.splice(+btn.dataset.i, 1);
    store.set('branches', state.branches);
    renderSelected();
  });
}

async function importPresets() {
  try {
    const r = await fetch('presets.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const pr = await r.json();
    const done = store.get('presetsVersion', 0);
    if (pr.version <= done) return;
    const all = branchSets();
    for (const set of pr.sets) {
      const same = all.find(x => x.name === set.name);
      if (same) {
        // add preset branches that aren't already in the user's saved set
        for (const b of set.branches) if (!same.branches.some(x => (x.id && x.id === b.id) || (!x.id && !b.id && x.chain_he === b.chain_he && x.city === b.city))) same.branches.push(b);
      } else all.unshift({ id: 'preset-' + Date.now(), name: set.name, branches: set.branches });
    }
    store.set('branchSets', all);
    store.set('presetsVersion', pr.version);
    renderBranchSets();
  } catch { }
}

function branchSets() { return store.get('branchSets', []); }
function renderBranchSets() {
  $('#savedBranchSets').innerHTML = '<option value="">הסופרים הקבועים שלי…</option>' +
    branchSets().map(x => `<option value="${esc(x.id)}">${esc(x.name)} (${x.branches.length} סניפים)</option>`).join('');
}
function saveBranchSet() {
  if (!state.branches.length) return msg('לא נבחרו סניפים לשמירה', true);
  const all = branchSets();
  const cur = all.find(x => x.id === $('#savedBranchSets').value);
  const name = prompt('שם לרשימת הסניפים:', cur ? cur.name : 'הסופרים הקבועים שלי');
  if (!name) return;
  const same = all.find(x => x.name === name);
  if (same) same.branches = [...state.branches];
  else all.unshift({ id: String(Date.now()), name, branches: [...state.branches] });
  store.set('branchSets', all);
  renderBranchSets();
  msg(`נשמר: "${name}" (${state.branches.length} סניפים)`);
}
function loadBranchSet() {
  const x = branchSets().find(v => v.id === $('#savedBranchSets').value);
  if (!x) return;
  state.branches = [...x.branches];
  store.set('branches', state.branches);
  renderSelected();
  msg(`נטענה הרשימה "${x.name}". אפשר להשוות מחירים`);
}
function deleteBranchSet() {
  const id = $('#savedBranchSets').value;
  if (!id) return msg('בחר רשימת סניפים שמורה כדי למחוק', true);
  store.set('branchSets', branchSets().filter(x => x.id !== id));
  renderBranchSets();
  msg('רשימת הסניפים נמחקה');
}

async function runManualCompare() {
  const btn = $('#compareBtn');
  if (!state.index) return msg('נתוני המחירים עוד לא זמינים', true);
  if (!state.branches.length) return msg('יש לבחור לפחות סניף אחד להשוואה', true);
  const lines = $('#listText').value.split('\n').map(s => s.trim()).filter(Boolean).map(M.parseLine).filter(l => l.tokens.length);
  if (!lines.length) return msg('יש להזין לפחות מוצר אחד', true);
  const home = $('#address').value.trim() ? await geocode(false) : null;
  msg('');
  // branches with prices first (more readable on a phone); order otherwise as chosen
  const cols = state.branches.map(sel => ({ sel, ...branchStatus(sel) })).sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0));
  const withData = cols.filter(c => c.ok);
  btn.disabled = true; btn.textContent = `טוען מחירים מ-${withData.length} סניפים…`;
  try {
    const res = await pool(withData.map(c => () => loadStore(c.meta).then(st => { c.store = st; st.dist = home ? haversine(home, st) : null; })), 6);
    for (const c of withData) if (!c.store) { c.ok = false; c.reason = 'שגיאה בטעינת קובץ המחירים של הסניף'; }
    const loaded = cols.filter(c => c.ok).map(c => c.store);
    const refs = lines.map(l => M.chooseReference(l, loaded, state.pins[M.norm(l.raw)]));
    const baskets = loaded.length ? M.computeBaskets(lines, loaded, refs, $('#usePromos').checked) : [];
    cols.forEach(c => { if (c.ok) c.basket = baskets[loaded.indexOf(c.store)]; });
    const ranked = M.rankBaskets(baskets);
    let split = null;
    if (ranked.length >= 2) {
      split = M.bestSplit(ranked, home || {}, (a, b) => (home && a.lat != null && b.lat != null) ? haversine(a, b) : 0);
      if (split && !home) split.noDist = true;
    }
    state.last = { manual: true, lines, loaded, refs, baskets: ranked, split, home, cols };
    renderManual();
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    msg('שגיאה בהשוואה: ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'השווה מחירים';
  }
}

const shortDate = t => { const m = String(t || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : ''; };

function renderManual() {
  const { lines, baskets, split, cols } = state.last;
  showCards(true);
  const rankOf = new Map(baskets.map((b, i) => [b, i + 1]));
  const sum = $('#summary');
  if (baskets.length) {
    const minMissing = baskets[0].missing;
    const group = baskets.filter(b => b.missing === minMissing);
    const cheap = group[0], exp = group[group.length - 1];
    const diff = exp.total - cheap.total, pct = exp.total > 0 ? diff / exp.total * 100 : 0;
    sum.innerHTML = `
      <div class="stat good"><div class="k">הסניף הזול ביותר</div><div class="v">${ils(cheap.total)}</div><div class="s">${esc(storeName(cheap.store))}</div></div>
      <div class="stat"><div class="k">הסניף היקר ביותר</div><div class="v">${ils(exp.total)}</div><div class="s">${esc(storeName(exp.store))}</div></div>
      <div class="stat"><div class="k">הפרש</div><div class="v">${ils(diff)}</div><div class="s">בין הזול ליקר</div></div>
      <div class="stat"><div class="k">חיסכון</div><div class="v">${pct.toFixed(1)}%</div><div class="s">${group.length} סניפים עם ${minMissing ? minMissing + ' חסרים' : 'סל מלא'}</div></div>`;
  } else sum.innerHTML = '';

  const label = { exact: 'מדויק', alt: 'חלופה', name: 'לפי שם' };
  const head = cols.map((c, ci) => {
    const b = c.sel;
    if (!c.ok) return `<th class="nd">${branchLine(b)}<span class="tag missing">אין נתוני מחירים</span><div class="sub">${esc(c.reason)}</div></th>`;
    const st = c.store;
    return `<th><div class="click" data-c="${ci}">${branchLine(st)}</div>${st.dist != null ? `<div class="sub">${km(st.dist)} מהבית</div>` : ''}<div class="sub">קובץ מחירים: ${esc(st.price_file_time)}</div>${staleTag(st)}</th>`;
  }).join('');
  // cheapest cell per row (among branches with a price)
  const rowMin = lines.map((_, i) => Math.min(...cols.filter(c => c.ok && c.basket.res[i].status !== 'missing').map(c => c.basket.res[i].cost)));
  const body = lines.map((l, i) => `<tr><td><b>${esc(l.raw)}</b></td>` + cols.map(c => {
    if (!c.ok) return '<td class="nd">—</td>';
    const r = c.basket.res[i];
    if (r.status === 'missing') return `<td><span class="tag missing">חסר מידע</span><div class="sub">${esc(r.reason)}</div></td>`;
    const best = Math.abs(r.cost - rowMin[i]) < 0.005 && cols.filter(x => x.ok).length > 1;
    return `<td class="${best ? 'best' : ''}"><span class="price num">${ils(r.cost)}</span>${r.status !== 'exact' ? `<span class="tag ${r.status}">${label[r.status]}</span>` : ''}${r.promo ? '<span class="tag promo">מבצע</span>' : ''}
      <div class="sub">${esc(r.item[I.name])}</div>${(r.notes || []).map(n => `<div class="sub warn">${esc(n)}</div>`).join('')}<div class="sub">מחיר מ-${esc(shortDate(r.item[I.upd]) || '—')}</div></td>`;
  }).join('') + '</tr>').join('');
  const foot = (title, f, cls = '') => `<tr class="${cls}"><td>${title}</td>` + cols.map(c => c.ok ? `<td class="num">${f(c.basket)}</td>` : '<td class="nd">—</td>').join('') + '</tr>';
  const n = lines.length;
  $('#matrixCard').innerHTML = `<h2>השוואה בין הסניפים שבחרת</h2>
    <p class="muted small">כל עמודה היא סניף מסוים וכל שורה היא מוצר. המחירים לקוחים רק מקובץ המחירים של אותו סניף, ולעולם לא מסניף אחר של הרשת. בכל תא מופיע התאריך שבו נקבע המחיר הנוכחי, ובראש העמודה מועד קובץ המחירים. התא הזול ביותר בכל שורה מודגש בירוק. לחיצה על שם סניף פותחת פירוט מלא.</p>
    <div class="table-wrap"><table class="tbl matrix"><thead><tr><th>מוצר</th>${head}</tr></thead><tbody>${body}</tbody>
    <tfoot>${foot('מחיר כולל', b => `<b>${ils(b.total)}</b>`, 'total')}${foot('נמצאו', b => `${n - b.missing} מתוך ${n}`)}${foot('חסרי מחיר', b => `<span class="${b.missing ? 'bad' : 'ok'}">${b.missing}</span>`)}${foot('דירוג', b => `<b>${rankOf.get(b)}</b> מתוך ${baskets.length}`)}</tfoot></table></div>
    ${baskets.length ? `<h3 style="margin-top:14px">דירוג מהזול ליקר</h3>
    <ol class="rank-list">${baskets.map(b => `<li>${esc(storeName(b.store))} – <b>${ils(b.total)}</b>${b.missing ? ` <span class="bad small">(${b.missing} חסרים)</span>` : ''}</li>`).join('')}</ol>
    <p class="small muted">הדירוג נקבע קודם לפי מספר המוצרים החסרים ואחר כך לפי המחיר, כדי שסניף שחסרים בו מוצרים לא ייראה זול רק בגלל זה. ההפרש מחושב בין הזול ליקר מבין הסניפים עם אותו מספר חסרים.</p>` : '<p class="bad">לאף אחד מהסניפים שבחרת אין נתוני מחירים.</p>'}`;
  $('#matrixCard').querySelectorAll('[data-c]').forEach(el => el.onclick = () => openStore(cols[+el.dataset.c].basket));

  if (baskets.length >= 2) renderSplit(split); else $('#splitCard').innerHTML = '<h2>קנייה מפוצלת</h2><p class="muted">צריך לפחות שני סניפים עם נתוני מחירים.</p>';
  if (baskets.length) renderLineRefs(); else $('#lineRefs').innerHTML = '';
  renderCoverage();
}

initUI();
loadIndex().then(() => { renderSelected(); if (state.mode === 'manual') loadDirectory(); });
