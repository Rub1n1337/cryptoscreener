// Trend over weeks (docs/RESEARCH-EDGE.md, part 2): every Monday hold the coins of the honest top-50 that rose the most
// over the last L days — does it beat holding the whole top-50 equally, BTC, the coins that rose the least, and random picks?
// In the preview (localhost:8765, any page without the site's CSP, e.g. /research/trend.js itself):
//   const T = await import('/research/trend.js?' + Date.now()); await T.load(); T.report()   (~10 s once the day files are cached)
//   T.cutCheck()   — the same decisions on data cut inside the third year (no look-ahead)
// Data: the stored daily candles of every USDT pair of the ticker (history.js daily(): one file a month for all pairs, delisted
// ones included), Binance for pairs the store doesn't know. Nothing is written anywhere.
//
// Rules, fixed before the first run (docs/RESEARCH-EDGE.md):
// - Rebalance every Monday 00:00 UTC, decided on the Sunday daily candle (closed at 00:00). Top: the 50 pairs with the highest
//   turnover of that candle (24 h), without stablecoins and gold, with a close L days earlier.
// - Score: close / close L days earlier − 1. Hold the n best, long, equal weights, to the next Monday (the next Sunday's close);
//   a pair whose candles stop in the week is out at its last close.
// - Costs: fee + slippage (math.js FEE, SLIP) on every pair that enters or leaves the set, as a share of its 1/n weight; pairs that
//   stay are not re-weighted. No borrowing (long only).
// - Variants L 14 / 28 × n 5 / 10, the main one L 28, n 10. Benchmarks: the whole top-50 equally (same cost rule), BTC held,
//   placebo — the n pairs that rose the least, random — n random pairs of the top-50 every week (300 runs, seed 1).
import * as M from '../supabase/functions/_shared/math.js';
import * as HS from '../history.js';
import { get, binanceKlines, pool, yearsBack } from './stage05.js';

const DAY = 864e5, WEEK = 7 * DAY, TOPN = 50, RUNS = 300;
export const VARIANTS = [[28, 10], [28, 5], [14, 10], [14, 5]];   // [L, n]; the first is the main one
export const S = { phase: 'idle', note: '' };
let D = null;   // {d0, nd, syms, c: [Float64Array], q: [Float64Array]} — close and quote volume by day since d0 (NaN: no candle)

export async function load(opt = {}) {
  const years = yearsBack(), d0 = years[0][0] - 60 * DAY, end = years[2][1];
  S.phase = 'ticker';
  const tk = await get('/ticker/24hr');
  let syms = tk.map(x => x.symbol).filter(s => s.endsWith('USDT') && !M.STABLE.has(s.slice(0, -4)));
  const rows = {}, H = await HS.daily(syms, d0, end);
  if (H) { Object.assign(rows, H.rows); syms = H.miss; }
  S.phase = 'daily from Binance: ' + syms.length;
  await pool(syms, 6, async s => { try { const K = await binanceKlines(s, '1d', d0, end); if (K.length) rows[s] = K; } catch (e) { S.note = s + ': ' + e.message; } });
  const nd = Math.round((end - d0) / DAY), all = Object.keys(rows).sort(), c = [], q = [];
  for (const s of all) {
    const C = new Float64Array(nd).fill(NaN), Q = new Float64Array(nd).fill(NaN);
    for (const k of rows[s]) { const i = Math.round((k[0] - d0) / DAY); if (i >= 0 && i < nd) { C[i] = k[4]; Q[i] = k[6]; } }
    c.push(C); q.push(Q);
  }
  D = { d0, nd, syms: all, c, q, years, end };
  S.phase = 'loaded';
  return { pairs: all.length, fromBinance: syms.length, from: new Date(d0).toISOString().slice(0, 10) };
}

// a fixed random sequence (mulberry32)
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// the weeks: for each Monday, the top-50 (pair indexes), each one's L-day score per L, and each one's return over the week;
// cut: data from that time on is treated as unknown (candles opening at or after it are dropped)
function weeks(cut = Infinity) {
  const { d0, nd, c, q, syms, years, end } = D, B = syms.indexOf('BTCUSDT'), out = [];
  const known = i => d0 + i * DAY < cut;   // the candle of day i opened before the cut
  for (let Mo = Math.ceil((years[0][0] - 4 * DAY) / WEEK) * WEEK + 4 * DAY; Mo + WEEK <= Math.min(end, cut); Mo += WEEK) {   // 1970-01-05 was a Monday
    if (Mo < years[0][0]) continue;
    const yi = years.findIndex(([a, b]) => Mo >= a && Mo < b); if (yi < 0) continue;
    const sd = Math.round((Mo - DAY - d0) / DAY);   // the Sunday whose candle closes at Mo
    const cand = [];
    for (let p = 0; p < syms.length; p++) { const v = q[p][sd], x = c[p][sd]; if (known(sd) && v > 0 && x > 0) cand.push([p, v]); }
    cand.sort((a, b) => b[1] - a[1]);
    const top = [];
    for (const [p] of cand.slice(0, TOPN)) {
      const sc = {}; let ok = true;
      for (const L of [14, 28]) { const o = c[p][sd - L]; sc[L] = o > 0 ? c[p][sd] / o - 1 : NaN; if (!(o > 0)) ok = false; }
      // the week: the last close up to the next Sunday (a pair delisted in the week is out at its last close)
      let ex = NaN; for (let i = sd + 7; i > sd; i--) if (i < nd && known(i) && c[p][i] > 0) { ex = c[p][i]; break; }
      top.push({ p, sc, ok, r: ex > 0 ? ex / c[p][sd] - 1 : 0 });
    }
    const bi = c[B][sd + 7], b0 = c[B][sd];
    out.push({ Mo, yi, top, btc: bi > 0 && b0 > 0 ? bi / b0 - 1 : 0 });
  }
  return out;
}

// weekly net returns of a rule that picks pair indexes from a week (pick(w) → [p…]); costs on entries and exits as above
function run(W, pick) {
  const C = M.FEE + M.SLIP, res = []; let prev = new Set(), held = 0;
  for (const w of W) {
    const set = pick(w), n = set.length, byP = new Map(w.top.map(x => [x.p, x]));
    if (!n) { res.push({ yi: w.yi, r: -prev.size * C / Math.max(1, held), n: 0, set }); prev = new Set(); held = 0; continue; }
    const now = new Set(set);
    let turn = 0; for (const p of now) if (!prev.has(p)) turn += 1 / n;   // entries, a 1/n weight each
    for (const p of prev) if (!now.has(p)) turn += 1 / held;             // exits, at their old weight
    let g = 0; for (const p of set) g += byP.get(p).r / n;
    res.push({ yi: w.yi, r: g - turn * C, g, n, set });
    prev = now; held = n;
  }
  return res;
}
const rules = {
  best: (L, n) => w => w.top.filter(x => x.ok).sort((a, b) => b.sc[L] - a.sc[L]).slice(0, n).map(x => x.p),
  worst: (L, n) => w => w.top.filter(x => x.ok).sort((a, b) => a.sc[L] - b.sc[L]).slice(0, n).map(x => x.p),
  all: () => w => w.top.map(x => x.p),
};
function stat(rs) {
  const n = rs.length; if (!n) return null;
  let s = 0, s2 = 0, eq = 1, pk = 1, dd = 0, h = 0;
  for (const x of rs) { s += x.r; s2 += x.r * x.r; eq *= 1 + x.r; if (eq > pk) pk = eq; dd = Math.max(dd, 1 - eq / pk); h += x.n; }
  const m = s / n;
  return { weeks: n, mean: m, se: Math.sqrt(Math.max(0, s2 / n - m * m) / n), year: eq - 1, dd, held: h };
}
const byYear = rs => [0, 1, 2].map(y => stat(rs.filter(x => x.yi === y)));
const meanOf = rs => rs.reduce((a, x) => a + x.r, 0) / (rs.length || 1);

export function compute(cut = Infinity) {
  const W = weeks(cut), res = { variants: {} };
  res.all = byYear(run(W, rules.all()));
  res.btc = byYear(W.map(w => ({ yi: w.yi, r: w.btc, n: 1 })));
  for (const [L, n] of VARIANTS) {
    const best = run(W, rules.best(L, n)), worst = run(W, rules.worst(L, n));
    // random: n random pairs of the week's top (those with an L-day close, as the rule), RUNS runs, seed 1
    const R = rng(1), rnd = [];
    for (let k = 0; k < RUNS; k++) {
      const rr = run(W, w => { const a = w.top.filter(x => x.ok).map(x => x.p); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); });
      rnd.push([0, 1, 2].map(y => meanOf(rr.filter(x => x.yi === y))).concat(meanOf(rr)));
    }
    const mine = [0, 1, 2].map(y => meanOf(best.filter(x => x.yi === y))).concat(meanOf(best));
    const rank = mine.map((m, j) => rnd.filter(x => x[j] < m).length / RUNS);
    res.variants[`L${L} n${n}`] = { best: byYear(best), worst: byYear(worst), rank, all3: stat(best), allTop3: stat(run(W, rules.all())), sets: best.map(x => x.set.join(',')), W: W.map(w => w.Mo) };
  }
  return res;
}

const f = x => x == null ? '—' : (x < 0 ? '−' : '+') + Math.abs(x * 100).toFixed(2) + '%';
export function report(raw = false) {
  const r = compute(); if (raw) return r;
  const lab = D.years.map(([a, b]) => `${new Date(a).toISOString().slice(0, 10)}…${new Date(b).toISOString().slice(0, 10)}`);
  const row = st => st.map(x => x ? `${f(x.mean)} ±${(1.64 * x.se * 100).toFixed(2)} · год ${f(x.year)} · DD ${(x.dd * 100).toFixed(0)}% · ${x.weeks} нед · ${x.held} мон.-нед` : '—');
  const out = { years: lab, 'топ-50 поровну': row(r.all), BTC: row(r.btc) };
  for (const [k, v] of Object.entries(r.variants)) {
    out[k] = row(v.best); out[k + ' · плацебо (худшие)'] = row(v.worst);
    out[k + ' · ранг против случайного'] = v.rank.map(x => (x * 100).toFixed(0) + '%').join(' / ') + ' (годы / три года)';
    const net = v.best.every(x => x?.mean > 0), beat = v.best.every((x, y) => x?.mean > r.all[y]?.mean && x?.mean > v.worst[y]?.mean);
    out[k + ' · вердикт'] = `> 0 во всех годах: ${net ? 'да' : 'нет'}; выше топа и плацебо во всех годах: ${beat ? 'да' : 'нет'}; ранг: ${v.rank.slice(0, 3).every(x => x > 0.5) && v.rank[3] >= 0.95 ? 'да' : 'нет'}; три года: ${f(v.all3.mean)} против топа ${f(v.allTop3.mean)}`;
  }
  return out;
}

// no look-ahead: decisions on data cut at `at` (inside the third year) must equal those of the full run for every week that ended by then
export function cutCheck(at = D.years[2][0] + 180 * DAY) {
  const a = compute(), b = compute(at), bad = [];
  for (const k of Object.keys(a.variants)) {
    const A = a.variants[k], B = b.variants[k];
    B.W.forEach((Mo, i) => { const j = A.W.indexOf(Mo); if (j < 0 || A.sets[j] !== B.sets[i]) bad.push(`${k} ${new Date(Mo).toISOString().slice(0, 10)}`); });
  }
  return { cut: new Date(at).toISOString().slice(0, 10), weeksChecked: b.variants['L28 n10'].W.length, bad };
}
export const _t = { weeks, run, rules, data: () => D };   // for checks in the console
