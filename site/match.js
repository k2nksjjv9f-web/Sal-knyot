// Shopping-list parsing, product matching and basket math.
// Pure functions (no DOM) so they can be tested in Node.
// Item row layout (from collector/collect.py):
// 0 code, 1 name, 2 manufacturer, 3 quantity, 4 unit_qty, 5 unit_of_measure,
// 6 is_weighted, 7 price, 8 unit_price, 9 updated, 10 is_barcoded, 11 promo
// promo = [unit_promo_price|null, description, end, min_qty, kind("unit"|"info")]

export const I = { code: 0, name: 1, man: 2, qty: 3, uq: 4, uom: 5, w: 6, price: 7, up: 8, upd: 9, bc: 10, promo: 11 };

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[״"׳'`’‘”“„]/g, '')
    .replace(/[ךםןףץ]/g, c => FINALS[c])
    .replace(/(\d)\s+%/g, '$1%')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[^א-תa-z0-9%.\s]/g, ' ')
    .replace(/(^|\s)\.|\.(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stem(t) {
  if (t.length > 4) return t.replace(/(יות|ות|ימ|יה)$/, '');
  if (t.length > 3) return t.replace(/(ות|ימ|ה|י)$/, '');
  return t;
}

const COUNT_WORDS = 'יחידות|יחידה|יח|חבילות|חבילה|חבילת|בקבוקים|בקבוק|קרטונים|קרטון|שקיות|שקית|מארזים|מארז|פחיות|פחית|קופסאות|קופסה|קופסא|גלילים|ארגזים|ארגז|זוגות|אריזות|אריזה';
const COUNT_RE = new RegExp(`(^|\\s)(${COUNT_WORDS})(?=\\s|$)`, 'g');

// Words that change what a product *is*; penalised when absent from the request.
const MODIFIERS = ['טעמ', 'בטעמ', 'משקה', 'רסק', 'מיצ', 'ממרח', 'חטיפ', 'מרק', 'רוטב', 'אבקת', 'תבלינ', 'שוקו',
  'מעדנ', 'גלידה', 'סויה', 'שקדימ', 'שיבולת', 'קוקוס', 'לקטוז', 'דיאט', 'לייט', 'קפוא', 'קפואה', 'שימורימ',
  'ממולא', 'מתובל', 'מעושנ', 'שניצל', 'קציצות', 'פירורי', 'עוגיות', 'עוגת', 'חטיפי', 'סבונ', 'מגבונימ',
  'ממתיק', 'קרמ', 'יוגורט', 'פודינג', 'ריבה', 'סלט', 'מאודה', 'מבושל', 'צלוי', 'שיפודי', 'נקניק', 'פרוס'];

/** Parse one free-text line ("2 חבילות פסטה", "חזה עוף 1.5 ק"ג"). */
export function parseLine(raw) {
  let s = String(raw || '').trim()
    .replace(/^[\s*•\-–·]+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[״"׳'’‘”“„`]/g, '');
  const out = { raw: String(raw || '').trim(), count: 1, wantKg: null, size: null, assumed: null };
  let m;
  if ((m = s.match(/חצי\s*(קילו|קג)/))) { out.wantKg = 0.5; s = s.replace(m[0], ' '); }
  if (!out.wantKg && (m = s.match(/(\d+(?:[.,]\d+)?)\s*(קילוגרם|קילו|קג|kg)(?=\s|$)/i))) {
    out.wantKg = parseFloat(m[1].replace(',', '.')); s = s.replace(m[0], ' ');
  }
  if (!out.wantKg && (m = s.match(/(^|\s)(קילו|קג)(?=\s|$)/))) { out.wantKg = 1; s = s.replace(m[0], ' '); }
  if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*(גרם|גר|g)(?=\s|$)/i))) {
    out.size = { base: 'g', amount: parseFloat(m[1].replace(',', '.')) }; s = s.replace(m[0], ' ');
  } else if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*(ליטר|ליטרים)(?=\s|$)/))) {
    out.size = { base: 'ml', amount: parseFloat(m[1].replace(',', '.')) * 1000 }; s = s.replace(m[0], ' ');
  } else if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*(מל|מיליליטר|ml)(?=\s|$)/i))) {
    out.size = { base: 'ml', amount: parseFloat(m[1].replace(',', '.')) }; s = s.replace(m[0], ' ');
  }
  // counts: "2 חבילות", leading "3 ", "x2", "2x"
  if ((m = s.match(new RegExp(`(\\d+)\\s*(${COUNT_WORDS})(?=\\s|$)`)))) {
    out.count = parseInt(m[1], 10); s = s.replace(m[0], ' ');
  } else if ((m = s.match(/^\s*(\d+)\s+(?!%)/))) {
    out.count = parseInt(m[1], 10); s = s.replace(m[0], ' ');
  } else if ((m = s.match(/(?:[x×*]\s*(\d+)|(\d+)\s*[x×*])\s*$/i))) {
    out.count = parseInt(m[1] || m[2], 10); s = s.replace(m[0], ' ');
  }
  s = s.replace(COUNT_RE, ' ');
  // eggs: "12 ביצים" means a pack of 12, not 12 packs
  if (/ביצ/.test(s) && [6, 10, 12, 18, 20, 30].includes(out.count)) {
    out.size = { base: 'u', amount: out.count }; out.count = 1;
  }
  if (!out.count || out.count < 1) out.count = 1;
  if (out.count > 50) out.count = 50;
  out.query = s.replace(/\s+/g, ' ').trim();
  out.tokens = norm(out.query).split(' ').filter(t => t && t !== 'של');
  return out;
}

function unitBase(str) {
  const u = norm(str);
  if (!u) return null;
  if (/קילו|קג|^kg/.test(u)) return ['g', 1000];
  if (/מיליליטר|מל|^ml/.test(u)) return ['ml', 1];
  if (/ליטר|^ל$|^l$|ltr/.test(u)) return ['ml', 1000];
  if (/גרמ|גר|^ג$|^g$|gr/.test(u)) return ['g', 1];
  if (/יח|יחיד|unit/.test(u)) return ['u', 1];
  return null;
}

/** Package size of an item in base units (g / ml / units), or null. */
export function itemSize(it) {
  if (it._size !== undefined) return it._size;
  let res = null;
  const q = Number(it[I.qty]);
  const b = unitBase(it[I.uq]) || unitBase(it[I.uom]);
  if (q > 0 && b) res = { base: b[0], amount: q * b[1] };
  if (!res || (res.base === 'u' && res.amount <= 1)) {
    const n = norm(it[I.name]);
    let m;
    if ((m = n.match(/(\d+(?:\.\d+)?)\s*(קג|קילו)(\s|$)/))) res = { base: 'g', amount: parseFloat(m[1]) * 1000 };
    else if ((m = n.match(/(\d+(?:\.\d+)?)\s*(גרמ|גר|ג)(\s|$)/))) res = { base: 'g', amount: parseFloat(m[1]) };
    else if ((m = n.match(/(\d+(?:\.\d+)?)\s*(ליטר|ל)(\s|$)/))) res = { base: 'ml', amount: parseFloat(m[1]) * 1000 };
    else if ((m = n.match(/(\d+(?:\.\d+)?)\s*(מל)(\s|$)/))) res = { base: 'ml', amount: parseFloat(m[1]) };
  }
  if (res && !(res.amount > 0)) res = null;
  it._size = res;
  return res;
}

export function sizeLabel(sz) {
  if (!sz) return '';
  const a = sz.amount;
  if (sz.base === 'g') return a >= 1000 ? `${+(a / 1000).toFixed(2)} ק"ג` : `${+a.toFixed(0)} גרם`;
  if (sz.base === 'ml') return a >= 1000 ? `${+(a / 1000).toFixed(2)} ליטר` : `${+a.toFixed(0)} מ"ל`;
  return `${+a.toFixed(0)} יח'`;
}

function tokensOf(it) {
  if (!it._t) {
    it._t = norm(it[I.name]).split(' ').filter(Boolean);
    it._m = norm(it[I.man]).split(' ').filter(Boolean);
  }
  return it._t;
}

function tokMatch(q, t) {
  if (q === t) return true;
  if (q.length >= 3 && t.length >= 3) {
    if (stem(q) === stem(t)) return true;
    if (t.startsWith(q)) return true;
    if (q.startsWith(t) && t.length >= q.length - 2 && t.length >= 3) return true;
  }
  return false;
}

/** Score an item for a parsed line. Returns {score, full} or null. */
export function scoreItem(line, it) {
  const qt = line.tokens;
  if (!qt.length) return null;
  const nt = tokensOf(it);
  const mt = it._m;
  let got = 0, firstPos = -1, usedName = 0;
  for (let i = 0; i < qt.length; i++) {
    const q = qt[i];
    const pos = nt.findIndex(t => tokMatch(q, t));
    if (pos >= 0) { got += 1; usedName++; if (i === 0) firstPos = pos; continue; }
    if (mt.some(t => tokMatch(q, t))) { got += 0.9; continue; }
    if (/^\d/.test(q) && nt.some(t => t.replace('%', '') === q.replace('%', ''))) { got += 0.7; continue; }
  }
  const cov = got / qt.length;
  if (cov < 0.5) return null;
  let score = cov;
  if (firstPos === 0) score += 0.35; else if (firstPos === 1) score += 0.15;
  score -= Math.min(0.3, 0.025 * Math.max(0, nt.length - usedName));
  const joined = nt.join(' ');
  const qj = qt.join(' ');
  for (const w of MODIFIERS) {
    if (joined.includes(w) && !qj.includes(w)) score -= 0.22;
  }
  const weighted = !!it[I.w];
  if (line.wantKg && weighted) score += 0.35;
  if (line.size) {
    const sz = itemSize(it);
    if (sz && sz.base === line.size.base) {
      const r = sz.amount / line.size.amount;
      score += (r > 0.97 && r < 1.03) ? 0.3 : (r > 0.6 && r < 1.6 ? 0.08 : -0.05);
    }
  }
  if (it[I.bc]) score += 0.04;
  return { score, full: cov >= 0.99 };
}

export function effPrice(it, usePromos) {
  const p = it[I.price];
  const pr = it[I.promo];
  if (usePromos && pr && pr[4] === 'unit' && pr[0] && pr[0] < p) return { price: pr[0], promo: pr };
  return { price: p, promo: null };
}

function bestInStore(line, store, opts = {}) {
  let best = null;
  for (const it of store.items) {
    const s = scoreItem(line, it);
    if (!s) continue;
    if (opts.fullOnly && !s.full) continue;
    if (!best || s.score > best.s.score) best = { it, s };
  }
  return best;
}

/** Choose a reference product for a line across all stores. */
export function chooseReference(line, stores, pinCode) {
  if (pinCode) {
    for (const st of stores) {
      const it = st.byCode.get(pinCode);
      if (it) return { mode: 'barcode', code: pinCode, item: it, pinned: true };
    }
  }
  const agg = new Map();
  let bestName = null;
  for (const st of stores) {
    // top few candidates per store
    const cands = [];
    for (const it of st.items) {
      const s = scoreItem(line, it);
      if (!s || !s.full) continue;
      cands.push({ it, s });
    }
    cands.sort((a, b) => b.s.score - a.s.score);
    for (const c of cands.slice(0, 8)) {
      if (c.it[I.bc]) {
        const a = agg.get(c.it[I.code]) || { code: c.it[I.code], item: c.it, best: -9, n: 0 };
        a.best = Math.max(a.best, c.s.score); a.n += 1;
        agg.set(c.it[I.code], a);
      } else if (!bestName || c.s.score > bestName.s.score) bestName = c;
    }
  }
  const N = Math.max(1, stores.length);
  let ref = null;
  for (const a of agg.values()) {
    a.rank = a.best + 0.45 * (a.n / N);
    if (!ref || a.rank > ref.rank) ref = a;
  }
  if (bestName && (!ref || bestName.s.score > ref.best + 0.25)) {
    return { mode: 'name', item: bestName.it };
  }
  if (ref) return { mode: 'barcode', code: ref.code, item: ref.item };
  return { mode: 'none' };
}

function lineCost(line, it, usePromos) {
  const { price, promo } = effPrice(it, usePromos);
  const notes = [];
  let units = line.count, cost;
  if (it[I.w]) {
    let kg = line.wantKg;
    if (!kg) {
      if (line.size && line.size.base === 'g') kg = line.size.amount / 1000;
      else { kg = 1; notes.push('הונח 1 ק"ג'); }
    }
    kg = kg * (line.wantKg ? 1 : line.count);
    cost = price * kg;
    return { cost, unitPrice: price, qtyLabel: `${+kg.toFixed(2)} ק"ג`, promo, notes };
  }
  if (line.wantKg) {
    const sz = itemSize(it);
    if (sz && sz.base === 'g') {
      units = Math.max(1, Math.round((line.wantKg * 1000) / sz.amount));
      if (units > 1 || Math.abs(sz.amount - line.wantKg * 1000) > 1) notes.push(`${units} אריזות של ${sizeLabel(sz)} לפי ${line.wantKg} ק"ג`);
    } else notes.push('גודל האריזה לא ידוע – חושבה אריזה אחת');
  }
  cost = price * units;
  return { cost, unitPrice: price, qtyLabel: `${units} יח'`, promo, notes };
}

/** Resolve every line in one store. ref: output of chooseReference. */
export function resolveLine(line, ref, store, usePromos) {
  if (ref.mode === 'none') return { status: 'missing', reason: 'לא נמצא מוצר מתאים באף סניף' };
  if (ref.mode === 'barcode') {
    const it = store.byCode.get(ref.code);
    if (it) return { status: 'exact', item: it, ...lineCost(line, it, usePromos) };
  }
  // alternative / name-based match
  const b = bestInStore(line, store, { fullOnly: true });
  if (!b) return { status: 'missing', reason: 'המוצר לא נמצא בקובץ המחירים של הסניף' };
  const it = b.it;
  if (ref.mode === 'name') {
    return { status: it[I.bc] ? 'alt' : 'name', item: it, ...lineCost(line, it, usePromos) };
  }
  // barcode reference missing here -> alternative, normalised to reference size
  const refIt = ref.item;
  if (!!it[I.w] !== !!refIt[I.w]) {
    if (it[I.w]) return { status: 'alt', item: it, ...lineCost(line, it, usePromos), altNote: 'חלופה במשקל' };
  }
  const rs = itemSize(refIt), as = itemSize(it);
  const base = lineCost(line, it, usePromos);
  if (rs && as && rs.base === as.base) {
    const ratio = rs.amount / as.amount;
    if (Math.abs(ratio - 1) < 0.02) return { status: 'alt', item: it, ...base };
    const units = line.wantKg ? 1 : line.count;
    const cost = (base.unitPrice / as.amount) * rs.amount * units;
    return {
      status: 'alt', item: it, cost, unitPrice: base.unitPrice, qtyLabel: base.qtyLabel, promo: base.promo,
      notes: [...base.notes, `גודל שונה (${sizeLabel(as)} מול ${sizeLabel(rs)}) – חושב לפי מחיר ליחידת ${as.base === 'g' ? 'משקל' : as.base === 'ml' ? 'נפח' : 'כמות'}`],
      normalized: true,
    };
  }
  if (!rs && !as) return { status: 'alt', item: it, ...base, notes: [...base.notes, 'גודל אריזה לא ידוע בשני המוצרים'] };
  return { status: 'missing', reason: `נמצאה חלופה (${it[I.name]}) אך לא ניתן להשוות גדלים`, altItem: it };
}

export function computeBaskets(lines, stores, refs, usePromos) {
  return stores.map(st => {
    const res = lines.map((ln, i) => resolveLine(ln, refs[i], st, usePromos));
    const total = res.reduce((s, r) => s + (r.status === 'missing' ? 0 : r.cost), 0);
    const missing = res.filter(r => r.status === 'missing').length;
    const alts = res.filter(r => r.status === 'alt' || r.status === 'name').length;
    return { store: st, res, total, missing, alts };
  });
}

export function rankBaskets(baskets) {
  return [...baskets].sort((a, b) => a.missing - b.missing || a.total - b.total);
}

/** Best two-store split vs the best single store, on the same set of lines. */
export function bestSplit(ranked, home, distFn, opts = {}) {
  const minAbs = opts.minAbs ?? 15, minPct = opts.minPct ?? 0.05;
  if (ranked.length < 2) return null;
  const best = ranked[0];
  const covered = best.res.map(r => r.status !== 'missing');
  const pool = ranked.slice(0, 25);
  let top = null;
  for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
    const A = pool[a], B = pool[b];
    let total = 0, ok = true, fromA = 0, fromB = 0;
    const pick = [];
    for (let i = 0; i < covered.length; i++) {
      if (!covered[i]) { pick.push(null); continue; }
      const ra = A.res[i], rb = B.res[i];
      const ca = ra.status === 'missing' ? Infinity : ra.cost;
      const cb = rb.status === 'missing' ? Infinity : rb.cost;
      if (!isFinite(ca) && !isFinite(cb)) { ok = false; break; }
      if (ca <= cb) { total += ca; fromA++; pick.push('A'); } else { total += cb; fromB++; pick.push('B'); }
    }
    if (!ok || !fromA || !fromB) continue;
    if (!top || total < top.total) top = { A, B, total, pick, fromA, fromB };
  }
  if (!top) return null;
  const single = best.total;
  const saving = single - top.total;
  const dA = distFn(home, top.A.store), dB = distFn(home, top.B.store), dAB = distFn(top.A.store, top.B.store);
  const route = dA + dAB + dB;
  const singleRoute = 2 * distFn(home, best.store);
  const extraKm = Math.max(0, route - singleRoute);
  const threshold = Math.max(minAbs, single * minPct);
  return { ...top, single, best, saving, extraKm, route, threshold, worth: saving >= threshold };
}
