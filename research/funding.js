// Funding (docs/RESEARCH-EDGE.md, part 1): after the futures' funding rate has been extreme for a day — the crowd paying to
// hold one side — does the price go against the crowd more often than chance?
// First: powershell -File research/funding-fetch.ps1 (writes research/data/funding.json, not committed). Then in the preview
// (localhost:8765, a page without the site's CSP, e.g. /research/funding.js itself):
//   const F = await import('/research/funding.js?' + Date.now()); F.start({par: 8});   then poll F.S; F.report() when done
//   await F.start({cut: <ms>}); F.cutCheck() — the same decisions on data cut inside the third year (no look-ahead);
//   F.start({peek: 3 * 864e5}) then with the cut: a deliberate 3-day look-ahead in F24, which cutCheck must report
// Candles: spot 4h from the stored history (history.js, R2), pools and years as research/stage05.js. Nothing is written anywhere.
//
// Rules, fixed before the first run (docs/RESEARCH-EDGE.md):
// - F24 at the close T of a 4h bar: the sum of the funding rates paid in (T − 24 h, T] (a rate is known when it is paid).
// - Entry: the first close where F24 ≥ +θ (a short: the crowd is long) or ≤ −θ (a long), the previous close not; the pair in
//   the honest top-50 by 24 h spot turnover at that bar; its perpetual paying funding for at least a day. In at the close +
//   slippage. While a trade of the pair with the same θ and horizon is open, no new one.
// - Exit: at the close H later (24 h, 72 h, 7 days); no stop, no target. A pair delisted in the trade is out at its last close.
// - Costs as math.js: FEE both sides, SLIP on entry and exit, BORROW_DAY for a short. Funding received or paid is not counted.
// - θ 0.10 % / 0.20 % × H 24 h / 72 h / 7 d; the main one θ 0.10 %, H 72 h.
// - Placebo: the same pair and side 14 days before the signal, if it was in the top-50 then and F24 not past θ that way.
// - Random: for every signal trade a random (pair, bar) of the year's top-50 with a perpetual, same side and horizon; 300 runs, seed 1.
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';
export { S };

const DAY = 864e5, H4 = 4 * 36e5, WARM = 10 * DAY, TAIL = 8 * DAY, PLACEBO = 14 * 6, RUNS = 300;
export const THETAS = [0.001, 0.002], HS = [6, 18, 42];   // θ per 24 h; horizons in 4h bars (24 h, 72 h, 7 days)
export const out = {};   // key 'full' or 'cut' -> {years: [...], tr: {'θ|H': [trade…]}, rnd: {'θ|H': [ranks…]}}
let FUND = null;

async function funding() {
  if (FUND) return FUND;
  const r = await fetch('/research/data/funding.json?' + Date.now());
  if (!r.ok) throw new Error('no research/data/funding.json: run research/funding-fetch.ps1 first');
  return FUND = await r.json();
}
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export async function start(opt = {}) {
  const key = opt.cut ? 'cut' : 'full', cut = opt.cut ?? Infinity;
  Object.assign(S, { phase: 'funding', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const run = out[key] = { cut, years: [], tr: {}, rnd: {} };
  try {
    const F = await funding(), years = yearsBack(), pl = await pools(years);
    for (const [yi, [y0, y1]] of years.entries()) if (y0 < cut) await year(F, pl[yi], yi, y0, y1, years[2][1], cut, run, opt);
    S.phase = 'done';
  } catch (e) { S.err = String(e.message || e); S.phase = 'error'; }
}

// one trade from the close of bar i, sg 1 a long / −1 a short, h bars: {R net, G gross, exit time} or null when the data window
// ends before it does (edge: the window's last bar; a pair whose candles stop earlier was delisted — out at its last close)
function trade(Q, i, sg, h, edge) {
  let j = i + h, k = h;
  if (j >= Q.n) { if (Q.t[Q.n - 1] >= edge) return null; j = Q.n - 1; k = j - i; }
  if (Q.t[j] - Q.t[i] !== k * H4) { // a gap in the candles: take the last bar not later than the horizon
    const T = Q.t[i] + h * H4; while (j > i && Q.t[j] > T) j--; k = Math.round((Q.t[j] - Q.t[i]) / H4);
  }
  if (j <= i) return null;
  const c0 = Q.c[i], c1 = Q.c[j], e = c0 * (1 + sg * M.SLIP), ex = c1 * (1 - sg * M.SLIP), fin = sg < 0 ? e * M.BORROW_DAY * k * H4 / DAY : 0;
  return { R: (sg * (ex - e) - (e + ex) * M.FEE - fin) / e, G: sg * (c1 / c0 - 1), x: Q.t[j] + H4 };
}

async function year(F, syms, yi, y0, y1, end, cut, run, opt) {
  const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`, nT = Math.round((y1 - y0) / H4);
  const wEnd = Math.min(y1 + TAIL, end, cut), P = [];
  S.phase = label; S.total = syms.length; S.done = 0;
  await pool(syms, opt.par ?? 8, async s => {
    try {
      const K = (await klines(s, '4h', y0 - WARM, wEnd)).filter(k => k[0] + H4 <= wEnd);
      if (K.length > 12) {
        const n = K.length, t = new Float64Array(n), c = new Float64Array(n), tv = new Float64Array(n), f24 = new Float64Array(n).fill(NaN);
        let cum = 0; const cs = new Float64Array(n);
        for (let i = 0; i < n; i++) { t[i] = K[i][0]; c[i] = K[i][4]; cum += K[i][6]; cs[i] = cum; }
        for (let i = 0; i < n; i++) { let a = i; while (a > 0 && t[a - 1] > t[i] - DAY + 1) a--; tv[i] = cs[i] - (a ? cs[a - 1] : 0); }   // 24 h turnover
        const fr = F[s];
        if (fr?.t?.length) {   // F24 at each close; a rate counts from its payment time (rounded to the minute: Binance stamps it a few ms late)
          const ft = fr.t.map(x => Math.floor(x / 6e4) * 6e4), r = fr.r;
          let a = 0, b = 0, sum = 0;
          for (let i = 0; i < n; i++) {
            const T = t[i] + H4 + (opt.peek ?? 0);   // peek: a deliberate look-ahead, only to see that cutCheck catches one
            if (T >= cut) break;
            while (b < ft.length && ft[b] <= T) sum += r[b++];
            while (a < b && ft[a] <= T - DAY) sum -= r[a++];
            if (ft[0] <= T - DAY) f24[i] = sum;   // the perpetual paid for at least a day
          }
        }
        P.push({ s, t, c, tv, f24, n });
      }
    } catch (e) { S.note = s + ': ' + (e.message || e); }
    S.done++;
  });
  // the 50th turnover at each 4h close of the year
  S.phase += ' · топ';
  const thr = new Float64Array(nT), buf = [];
  const at = Q => { const m = new Int32Array(nT).fill(-1); for (let i = 0; i < Q.n; i++) { const k = Math.round((Q.t[i] - y0) / H4); if (k >= 0 && k < nT) m[k] = i; } return m; };
  for (const Q of P) Q.m = at(Q);
  for (let k = 0; k < nT; k++) { buf.length = 0; for (const Q of P) { const i = Q.m[k]; if (i >= 0) buf.push(Q.tv[i]); } buf.sort((a, b) => b - a); thr[k] = buf.length >= 50 ? buf[49] : 0; }
  const inTop = (Q, i) => { const k = Math.round((Q.t[i] - y0) / H4); return k >= 0 && k < nT && Q.tv[i] >= thr[k]; };
  // the random pool: every (pair, bar) of the year in the top-50 with a known F24, decided before the cut
  const cand = [];
  for (const [qi, Q] of P.entries()) for (let i = 0; i < Q.n; i++) if (Q.t[i] >= y0 && Q.t[i] < y1 && Q.t[i] + H4 < cut && Q.f24[i] === Q.f24[i] && inTop(Q, i)) cand.push(qi, i);
  const edge = wEnd - 2 * H4;
  let sigs = 0;
  for (const th of THETAS) for (const h of HS) {
    const key = `${th}|${h}`, T = run.tr[key] ??= [];
    const mine = [];
    for (const Q of P) {
      let busy = -Infinity;
      for (let i = 1; i < Q.n; i++) {
        const T0 = Q.t[i];
        if (T0 < y0 || T0 >= y1 || T0 + H4 >= cut) continue;
        const f = Q.f24[i], p = Q.f24[i - 1];
        if (f !== f) continue;
        const sg = f >= th && !(p >= th) ? -1 : f <= -th && !(p <= -th) ? 1 : 0;
        if (!sg || T0 < busy || !inTop(Q, i)) continue;
        const r = trade(Q, i, sg, h, edge); if (!r) continue;
        if (r.x > cut) continue;
        busy = r.x - H4;
        // placebo: the same pair and side 14 days before
        const j = i - PLACEBO; let pl = null;
        if (j > 0 && Q.t[i] - Q.t[j] === PLACEBO * H4 && Q.f24[j] === Q.f24[j] && !(sg < 0 ? Q.f24[j] >= th : Q.f24[j] <= -th) && inTop(Q, j)) pl = trade(Q, j, sg, h, edge);
        const tr = { yi, s: Q.s, t: T0 + H4, sg, f, R: r.R, G: r.G, x: r.x, pR: pl?.R ?? null, pG: pl?.G ?? null };
        T.push(tr); mine.push(tr); sigs++;
      }
    }
    // random entries: same sides and horizon, random (pair, bar) of the year's top
    const R = rng(1 + yi), nc = cand.length / 2, means = [];
    if (nc) for (let k = 0; k < RUNS; k++) {
      let s = 0, n = 0;
      for (const tr of mine) {
        for (let a = 0; a < 20; a++) { const z = Math.floor(R() * nc), Q = P[cand[2 * z]], r = trade(Q, cand[2 * z + 1], tr.sg, h, edge); if (r && r.x <= cut) { s += r.R; n++; break; } }
      }
      means.push(n ? s / n : NaN);
    }
    (run.rnd[key] ??= [])[yi] = means;
  }
  run.years.push({ label, pool: syms.length, loaded: P.length, withPerp: P.filter(Q => Q.f24.some(x => x === x)).length, randomPool: cand.length / 2, signals: sigs });
}

// ---------- report
const sgn = x => x == null || x !== x ? '—' : (x < 0 ? '−' : '+') + Math.abs(x * 100).toFixed(2) + '%';
function stat(a, k = 'R') {
  const v = a.map(x => x[k]).filter(x => x != null && x === x), n = v.length; if (!n) return null;
  const m = v.reduce((p, x) => p + x, 0) / n, s2 = v.reduce((p, x) => p + x * x, 0) / n;
  return { n, m, se: Math.sqrt(Math.max(0, s2 - m * m) / n), win: v.filter(x => x > 0).length / n };
}
export function report(key = 'full') {
  const run = out[key], res = { years: run.years, rows: {}, verdict: {} };
  for (const th of THETAS) for (const h of HS) {
    const k = `${th}|${h}`, T = run.tr[k] ?? [], name = `θ ${(th * 100).toFixed(2)}% · ${h * 4} ч`;
    const per = [0, 1, 2].map(yi => {
      const a = T.filter(x => x.yi === yi), st = stat(a), g = stat(a, 'G'), withP = a.filter(x => x.pR != null), p = stat(withP, 'pR'), pm = stat(withP);
      const rnd = run.rnd[k]?.[yi] ?? [], rank = st ? rnd.filter(x => x < st.m).length / (rnd.length || 1) : NaN;
      const L = stat(a.filter(x => x.sg > 0)), Sh = stat(a.filter(x => x.sg < 0));
      return { st, g, p, pm, rank, L, Sh };
    });
    res.rows[name] = per.map(y => y.st ? `${sgn(y.st.m)} ±${(164 * y.st.se).toFixed(2)} · до изд. ${sgn(y.g.m)} · n ${y.st.n} (лонг ${y.L?.n ?? 0} ${sgn(y.L?.m)}, шорт ${y.Sh?.n ?? 0} ${sgn(y.Sh?.m)}) · ${(y.st.win * 100).toFixed(0)}% · плацебо ${sgn(y.p?.m)} против ${sgn(y.pm?.m)} (n ${y.p?.n ?? 0}) · ранг ${(y.rank * 100).toFixed(0)}%` : '—');
    // three years together: the rank of the pooled mean against pooled random runs (each run: the trade-weighted mean of its years)
    const n3 = per.map(y => y.st?.n ?? 0), m3 = per.reduce((s, y, i) => s + (y.st?.m ?? 0) * n3[i], 0) / (n3.reduce((a, b) => a + b, 0) || 1);
    const R3 = Array.from({ length: RUNS }, (_, r) => per.reduce((s, y, i) => s + (run.rnd[k]?.[i]?.[r] ?? 0) * n3[i], 0) / (n3.reduce((a, b) => a + b, 0) || 1));
    const rank3 = R3.filter(x => x < m3).length / RUNS;
    res.verdict[name] = `> 0 во всех годах: ${per.every(y => y.st?.m > 0) ? 'да' : 'нет'}; лучше плацебо во всех: ${per.every(y => y.p && y.pm && y.pm.m > y.p.m) ? 'да' : 'нет'}; ранг > 50% во всех: ${per.every(y => y.rank > 0.5) ? 'да' : 'нет'}; три года ${sgn(m3)}, ранг ${(rank3 * 100).toFixed(0)}%`;
  }
  return res;
}

// no look-ahead: every trade of the cut run must be in the full run, the same; every full-run trade that ended by the cut — in the cut run
export function cutCheck() {
  const A = out.full, B = out.cut, bad = []; let n = 0;
  for (const k of Object.keys(A.tr)) {
    const id = x => `${x.s}|${x.t}|${x.sg}|${x.R.toFixed(10)}`, a = new Set(A.tr[k].filter(x => x.x <= B.cut).map(id)), b = new Set((B.tr[k] ?? []).map(id));
    for (const x of a) if (!b.has(x)) bad.push('нет в обрезанном: ' + k + ' ' + x);
    for (const x of b) if (!a.has(x)) bad.push('лишняя в обрезанном: ' + k + ' ' + x);
    n += b.size;
  }
  return { cut: new Date(B.cut).toISOString().slice(0, 10), trades: n, bad: bad.slice(0, 20), badCount: bad.length };
}
export const _t = { trade };
