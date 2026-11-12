// Market-wide funding as a «no new longs» filter for the bot (docs/RESEARCH-FUNDING-FILTER.md; rules written before the run).
// In the preview (localhost:8765, a page without the site's CSP, e.g. /research/funding-filter.js itself):
//   const F = await import('/research/funding-filter.js?' + Date.now()); F.start('sw4h');   then poll F.S; F.report('sw4h')
//   F.start('rev1h') the same way. F.cutCheck('sw4h', <ms>) — the market index rebuilt on candles and rates cut at <ms> gives
//   the same decisions before the cut (no look-ahead in the index).
// Funding: research/data/funding.json (research/funding-fetch.ps1). Candles: stored history (history.js, R2), pools and years as
// research/stage05.js. Trades: math.js backtest() unchanged; the filter strikes out the base run's longs. Nothing is written anywhere.
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';
export { S };

const DAY = 864e5, WIN = 90 * DAY, MIN_HIST = 30 * DAY, RUNS = 300, END = Date.UTC(2026, 10, 13);
const BASE = { method: 'log', N: 210, k: 3.5, minScore: 60, rr: 2, risk: 0.01, lev: 3, minWidth: 0, maxHL: 0, longOnly: false, coinErMax: 0, timeStop: 48, maxOpen: 3, regimeSrc: 'majors', regimeOnly: 'any' };
export const PROFILES = {
  sw4h: { ...BASE, tf: '4h', strategy: 'switch', erMax: 0.25, maxHL: 20 },   // SHARED_TESTED (index.html)
  rev1h: { ...BASE, tf: '1h', strategy: 'revert' },
};
export const VARIANTS = [{ id: 'top20 p90', src: 'top20', p: 0.9 }, { id: 'top20 p80', src: 'top20', p: 0.8 }, { id: 'BTC p90', src: 'btc', p: 0.9 }];
export const out = {};   // profile -> {years: [{label, trades, idx: {src: {T: [Fm, ...]}}, ...}]}
let FUND = null;
async function funding() {
  if (FUND) return FUND;
  const r = await fetch('/research/data/funding.json?' + Date.now());
  if (!r.ok) throw new Error('no research/data/funding.json: run research/funding-fetch.ps1 first');
  return FUND = await r.json();
}
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// F24 of a coin at each bar close (t[i] + tfms): the sum of rates paid in (T − 24 h, T]; NaN while its perpetual is younger than a day
function f24Of(fr, t, tfms, cut) {
  const n = t.length, f = new Float64Array(n).fill(NaN);
  if (!fr?.t?.length) return f;
  const ft = fr.t.map(x => Math.floor(x / 6e4) * 6e4), r = fr.r;
  let a = 0, b = 0, sum = 0;
  const last = ft[ft.length - 1] + 9 * 36e5;   // after the last payment of the file (end of the download, or a delisted perpetual): unknown
  for (let i = 0; i < n; i++) {
    const T = t[i] + tfms;
    if (T > cut || T > last) break;
    while (b < ft.length && ft[b] <= T) sum += r[b++];
    while (a < b && ft[a] <= T - DAY) sum -= r[a++];
    if (ft[0] <= T - DAY) f[i] = sum;
  }
  return f;
}
// the market index at every bar close T of the loaded candles: {top20: Map(T -> Fm), btc: Map(T -> F24 of BTC)}
export function marketIndex(hist, F, tfms, cut = Infinity) {
  const day = Math.max(1, Math.round(DAY / tfms)), C = [];
  for (const [s, K] of Object.entries(hist)) {
    if (!F[s]?.p) continue;
    const t = K.map(k => k[0]).filter(x => x + tfms <= cut), n = t.length, q = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) q[i + 1] = q[i] + +K[i][6];
    C.push({ s, t, ix: new Map(t.map((x, i) => [x, i])), q, f: f24Of(F[s], t, tfms, cut), day });
  }
  const times = [...new Set(C.flatMap(c => c.t))].sort((a, b) => a - b), top20 = new Map(), btc = new Map();
  const B = C.find(c => c.s === 'BTCUSDT');
  for (const t of times) {
    const row = [];
    for (const c of C) { const i = c.ix.get(t); if (i == null || !(c.f[i] === c.f[i])) continue; row.push([c.q[i + 1] - c.q[Math.max(0, i + 1 - day)], c.f[i]]); }
    row.sort((a, b) => b[0] - a[0]);
    const top = row.slice(0, 20), w = top.reduce((a, x) => a + x[0], 0);
    if (top.length >= 10 && w > 0) top20.set(t + tfms, top.reduce((a, x) => a + x[0] * x[1], 0) / w);
    if (B) { const i = B.ix.get(t); if (i != null && B.f[i] === B.f[i]) btc.set(t + tfms, B.f[i]); }
  }
  return { top20, btc };
}
// blocked(T) for a percentile p: Fm(T) ≥ the p-quantile of Fm over the bars of (T − 90 d, T), with at least 30 days of them
export function blocker(idx, p) {
  const T = [...idx.keys()].sort((a, b) => a - b), sorted = [], res = new Map();
  let a = 0;
  const ins = v => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = lo + hi >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } sorted.splice(lo, 0, v); };
  const del = v => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = lo + hi >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } sorted.splice(lo, 1); };
  for (let k = 0; k < T.length; k++) {
    while (T[a] <= T[k] - WIN) del(idx.get(T[a++]));
    if (k > 0 && T[k] - T[a] >= MIN_HIST && sorted.length) res.set(T[k], idx.get(T[k]) >= sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
    ins(idx.get(T[k]));
  }
  return res;
}

export async function start(prof, opt = {}) {
  const set = PROFILES[prof], tfms = M.TFMS[set.tf];
  Object.assign(S, { phase: 'funding', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const run = out[prof] = { set, years: [] };
  try {
    const F = await funding(), years = yearsBack(END), pl = await pools(years);
    for (const [yi, [y0, y1]] of years.entries()) {
      if (opt.only != null && opt.only !== yi) continue;
      const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`;
      const syms = [...new Set([...pl[yi], ...M.MAJORS])], warm = Math.max(450 * tfms, WIN + 5 * DAY), hist = {};
      S.phase = `${prof} ${label}`; S.total = syms.length; S.done = 0;
      await pool(syms, opt.par ?? 6, async s => { try { const K = await klines(s, set.tf, y0 - warm, y1); if (K.length) hist[s] = K; } catch (e) { S.note = s + ': ' + (e.message || e); } S.done++; });
      S.phase += ' · бэктест';
      await new Promise(r => setTimeout(r, 0));
      const bt = M.backtest(hist, set, { from: y0, top: 50 });
      S.phase += ' · индекс';
      const idx = marketIndex(hist, F, tfms), blk = {};
      for (const v of VARIANTS) blk[v.id] = blocker(idx[v.src], v.p);
      const trades = bt.trades.map(x => ({ sym: x.sym, side: x.side, r: x.r, time: x.time, tclose: x.tclose, dec: x.time + 1, block: Object.fromEntries(VARIANTS.map(v => [v.id, blk[v.id].get(x.time + 1) ?? null])) }));
      const share = Object.fromEntries(VARIANTS.map(v => { const m = [...blk[v.id]].filter(([T]) => T >= y0 && T < y1); return [v.id, m.length ? m.filter(x => x[1]).length / m.length : null]; }));
      run.years.push({ label, y0, y1, pool: syms.length, loaded: Object.keys(hist).length, trades, share, idx: { top20: [...idx.top20].filter(([T]) => T >= y0 - WIN && T < y1), btc: [...idx.btc].filter(([T]) => T >= y0 - WIN && T < y1) } });
    }
    S.phase = 'done';
  } catch (e) { S.err = String(e.message || e); S.phase = 'error'; console.error(e); }
}

const sumR = tr => tr.reduce((a, x) => a + x.r, 0);
function ddR(tr) { let c = 0, pk = 0, dd = 0; for (const x of tr) { c += x.r; pk = Math.max(pk, c); dd = Math.max(dd, pk - c); } return dd; }
const f2 = x => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2), pc = x => x == null ? '—' : Math.round(x * 100) + '%';

// one row per profile × year × variant: base and filtered R / drawdown, skipped longs, ranks against random skipping
export function rows(prof) {
  const R = [];
  for (const y of out[prof].years) {
    const tr = y.trades.filter(x => x.r != null && isFinite(x.r)).sort((a, b) => a.tclose - b.tclose), longs = tr.filter(x => x.side === 'LONG');
    for (const v of VARIANTS) {
      const skip = new Set(longs.filter(x => x.block[v.id] === true)), kept = tr.filter(x => !skip.has(x)), k = skip.size;
      const g = rng(1), rD = [], rR = [];
      for (let n = 0; n < RUNS; n++) {
        const pick = new Set(), L = longs.length;
        while (pick.size < Math.min(k, L)) pick.add(longs[Math.floor(g() * L)]);
        const kk = tr.filter(x => !pick.has(x)); rD.push(ddR(kk)); rR.push(sumR(kk));
      }
      const dF = ddR(kept), sF = sumR(kept), sk = [...skip], kl = longs.filter(x => !skip.has(x));
      R.push({ prof, year: y.label, v: v.id, n: tr.length, longs: longs.length, skipped: k, share: y.share[v.id],
        baseR: sumR(tr), baseDD: ddR(tr), R: sF, DD: dF,
        rankDD: rD.filter(d => d >= dF).length / RUNS, rankR: rR.filter(s => s <= sF).length / RUNS,
        skippedMean: k ? sumR(sk) / k : null, keptLongMean: kl.length ? sumR(kl) / kl.length : null,
        perTrade: tr.length ? sumR(tr) / tr.length : null });
    }
  }
  return R;
}
export function report(prof) {
  const lines = [`| Год | Вариант | Сделок (лонгов) | Пропущено лонгов | Доля свечей под фильтром | Итог R: база → фильтр | Просадка R: база → фильтр | Ранг просадки | Ранг итога | R пропущенных / оставшихся лонгов |`, '|---|---|---|---|---|---|---|---|---|---|'];
  for (const x of rows(prof)) lines.push(`| ${x.year} | ${x.v} | ${x.n} (${x.longs}) | ${x.skipped} | ${pc(x.share)} | ${f2(x.baseR)} → ${f2(x.R)} | ${x.baseDD.toFixed(1)} → ${x.DD.toFixed(1)} | ${pc(x.rankDD)} | ${pc(x.rankR)} | ${f2(x.skippedMean)} / ${f2(x.keptLongMean)} |`);
  return lines.join('\n');
}
export function verdict() {
  const ok = x => x.DD < x.baseDD && x.R >= x.baseR && x.rankDD >= 0.9 && x.rankR >= 0.9;
  const res = {};
  for (const v of VARIANTS) res[v.id] = Object.keys(out).map(p => rows(p).filter(x => x.v === v.id)).flat().map(x => `${x.prof} ${x.year}: ${ok(x) ? 'да' : 'нет'}`);
  return res;
}
// no look-ahead in the index: rebuilt on candles and rates cut at `cut`, every decision before the cut must be the same
export async function cutCheck(prof, cut, yi = 2) {
  const set = PROFILES[prof], tfms = M.TFMS[set.tf], F = await funding(), years = yearsBack(END), pl = await pools(years), [y0] = years[yi];
  const syms = [...new Set([...pl[yi], ...M.MAJORS])], warm = Math.max(450 * tfms, WIN + 5 * DAY), full = {}, part = {};
  S.phase = 'cut'; S.total = syms.length; S.done = 0;
  await pool(syms, 6, async s => { try { const K = await klines(s, set.tf, y0 - warm, Math.min(cut + 30 * DAY, END)); if (K.length) { full[s] = K; part[s] = K.filter(k => k[0] + tfms <= cut); } } catch {} S.done++; });
  const Fc = Object.fromEntries(Object.entries(F).map(([s, f]) => { const keep = f.t.map((t, i) => Math.floor(t / 6e4) * 6e4 <= cut ? i : -1).filter(i => i >= 0); return [s, { p: f.p, t: keep.map(i => f.t[i]), r: keep.map(i => f.r[i]) }]; }));
  const A = marketIndex(full, F, tfms), B = marketIndex(part, Fc, tfms, cut), bad = [];
  for (const v of VARIANTS) {
    const a = blocker(A[v.src], v.p), b = blocker(B[v.src], v.p);
    for (const [T, x] of b) if (T <= cut && a.get(T) !== x) bad.push([v.id, T]);
    for (const [T, x] of A[v.src]) if (T <= cut && B[v.src].has(T) && Math.abs(B[v.src].get(T) - x) > 1e-12) bad.push([v.id, 'Fm', T]);
  }
  S.phase = 'done';
  return { checked: [...B.top20.keys()].length, bad: bad.slice(0, 20), nBad: bad.length };
}
