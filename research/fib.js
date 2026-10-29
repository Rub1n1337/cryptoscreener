// Fibonacci retracements (docs/RESEARCH-2026-10.md, 29.10): after a completed impulse, does a pullback into the golden
// pocket 0.5–0.618 pay — and pay better than the same trade at levels that are not Fibonacci (placebo)?
// In the preview (localhost:8765):
//   const R = await import('/research/fib.js?' + Date.now()); R.start({par: 16});   then poll R.S; R.report('1h'), R.report('4h') when done
// (16 requests at a time: Binance takes ~2.3 s to answer for old 1h candles; ~800 of the 6000 weight a minute; ~9 minutes)
// Data, pools and the honest top-50 by 24 h turnover: as research/stage05.js, whose loaders it reuses. Only 1h candles are
// loaded; 4h bars are built from them (Binance's 4h bars start at 00:00 UTC, as these). Nothing is written anywhere.
//
// Rules, fixed before the first run:
// - Impulse: a ZigZag swing with a threshold of k × ATR(14) at the bar (k = 3; k = 2 as a robustness check). A swing point
//   is known at the close of the bar in which the price has gone the threshold away from it, not before. An impulse up is
//   a swing low followed by a swing high, known when the high is.
// - Entry (a long after an impulse up, a short mirrored): from that bar on, the first bar whose range meets the zone; in at
//   its close (+ slippage) if the pair is in the top-50 at that bar. One event per impulse and zone. No trade if the price
//   reaches the 0.786 level first or in that bar, goes past the impulse's end, or the next swing point is confirmed.
// - Zones, as a retracement of the impulse (0 its end, 1 its start): golden pocket 0.5–0.618; placebo 0.40–0.45,
//   0.55–0.60, 0.70–0.75 and a random level 0.35–0.75 for each impulse (± 0.025 around it).
// - Exit: stop at the 0.786 level; target at level 0 (the impulse's end) or at the 1.272 extension — two separate trades;
//   time stop at the close of bar 48. Stop and target in one bar — the stop. Costs as math.js: fee on both sides, slippage
//   on the entry and on a stop or time exit (the target is a limit order), borrowing for a short.
// - R = result / (entry − stop) after costs; G — the same before costs (in at the close, out exactly at the levels).
//   The year is the entry bar's; drawdown — on the running sum of R in entry order (every trade risking 1R).
// Fibonacci counts only if 0.5–0.618 beats every placebo in each of the three years, both in R and in G.
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';
export { S };

const DAY = 864e5, H1 = 36e5, H4 = 4 * H1, BARS = 48, STOP = 0.786, WARM = 30 * DAY, TAIL = 9 * DAY;
export const ZONES = { 'GP 0.5–0.618': [0.5, 0.618], 'P 0.40–0.45': [0.40, 0.45], 'P 0.55–0.60': [0.55, 0.60], 'P 0.70–0.75': [0.70, 0.75], 'P случайный': null };
const ZN = Object.keys(ZONES), NZ = ZN.length;
const TARGETS = { 'цель 0': 0, 'цель 1.272': -0.272 };   // as a retracement: the 1.272 extension lies 0.272 beyond the end
export const out = {};   // tf -> { ks, years: [{label, pool, loaded, imp}], tr: {'k|zone|target': {y, m, R, G, s, c}} }

// a fixed pseudo-random number in [0, 1) for a string: the same impulse gets the same random level on every run
const rnd = s => {
  let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); return ((h ^ h >>> 16) >>> 0) / 4294967296;
};
// rows [openTime, o, h, l, c, volume, quoteVolume] of 1h -> of 4h
const four = K => {
  const o = []; let b = null;
  for (const k of K) {
    const T = Math.floor(k[0] / H4) * H4;
    if (!b || b[0] !== T) o.push(b = [T, k[1], k[2], k[3], k[4], k[5], k[6]]);
    else { if (k[2] > b[2]) b[2] = k[2]; if (k[3] < b[3]) b[3] = k[3]; b[4] = k[4]; b[5] += k[5]; b[6] += k[6]; }
  }
  return o;
};
function series(K, tf) {
  const n = K.length, t = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) { const k = K[i]; t[i] = k[0]; h[i] = k[2]; l[i] = k[3]; c[i] = k[4]; cum[i] = (i ? cum[i - 1] : 0) + k[6]; }
  return { t, h, l, c, cum, n, tf, a: M.atrSeries(h, l, c, 14) };
}
const below = (t, T) => { let a = 0, b = t.length - 1; while (a < b) { const m = (a + b + 1) >> 1; if (t[m] <= T) a = m; else b = m - 1; } return a; };

// swing points: {dir: 1 a high / −1 a low, p: its price, i: its bar, c: the bar whose close confirms it,
// x: the furthest price reached away from it by then}
function zigzag(Q, k) {
  const { h, l, a, n } = Q, sw = [];
  let dir = 1, ext = h[0], ei = 0, opp = Infinity, oi = 0;   // the extreme being tracked, the furthest price since it
  for (let i = 1; i < n; i++) {
    if (dir > 0) {
      if (h[i] > ext) { ext = h[i]; ei = i; opp = Infinity; continue; }   // inside one bar the order of high and low is unknown
      if (l[i] < opp) { opp = l[i]; oi = i; }
      if (ext - opp >= k * a[i]) {
        sw.push({ dir: 1, p: ext, i: ei, c: i, x: opp });
        dir = -1; ext = opp; ei = oi; opp = -Infinity;
        for (let j = ei + 1; j <= i; j++) if (h[j] > opp) { opp = h[j]; oi = j; }
      }
    } else {
      if (l[i] < ext) { ext = l[i]; ei = i; opp = -Infinity; continue; }
      if (h[i] > opp) { opp = h[i]; oi = i; }
      if (opp - ext >= k * a[i]) {
        sw.push({ dir: -1, p: ext, i: ei, c: i, x: opp });
        dir = 1; ext = opp; ei = oi; opp = Infinity;
        for (let j = ei + 1; j <= i; j++) if (l[j] < opp) { opp = l[j]; oi = j; }
      }
    }
  }
  return sw;
}

// one trade from the close of bar j (sg 1 a long, −1 a short; E the impulse's end, D its size; tr the target as a
// retracement): [R, G], or null when our data window ends before the trade does (a pair delisted in the trade is out at its last close)
function trade(Q, j, sg, E, D, tr, edge) {
  const px = r => E - sg * r * D, sl = px(STOP), tp = px(tr), c0 = Q.c[j], e = c0 * (1 + sg * M.SLIP), risk = sg * (e - sl);
  if (!(risk > 0)) return null;
  let ex0 = null, k = 1, slip = M.SLIP;
  for (; k <= BARS && j + k < Q.n; k++) {
    const i = j + k;
    if (sg > 0 ? Q.l[i] <= sl : Q.h[i] >= sl) { ex0 = sl; break; }
    if (sg > 0 ? Q.h[i] >= tp : Q.l[i] <= tp) { ex0 = tp; slip = 0; break; }
  }
  if (ex0 == null) {
    if (k > BARS) { k = BARS; ex0 = Q.c[j + BARS]; }
    else if (Q.t[Q.n - 1] >= edge) return null;
    else { k = Q.n - 1 - j; ex0 = Q.c[Q.n - 1]; }
  }
  const ex = ex0 * (1 - sg * slip), fin = sg < 0 ? e * M.BORROW_DAY * k * Q.tf / DAY : 0;
  return [(sg * (ex - e) - (e + ex) * M.FEE - fin) / risk, sg * (ex0 - c0) / (sg * (c0 - sl))];
}

// the events of one pair on one timeframe, appended to C by 9: key, decision hour m, turnover, side, at the confirming bar, R0, G0, R1, G1
function events(Q, sym, ks, y0, y1, edge, at, C, imp) {
  for (const [kx, k] of ks.entries()) {
    const sw = zigzag(Q, k);
    for (let q = 1; q < sw.length; q++) {
      const A = sw[q - 1], B = sw[q], sg = B.dir, E = B.p, D = sg * (E - A.p), until = q + 1 < sw.length ? sw[q + 1].c : Q.n - 1;
      if (!(D > 0) || Q.t[until] < y0 || Q.t[B.c] >= y1) continue;
      if (Q.t[B.c] >= y0) imp[k] = (imp[k] || 0) + 1;
      const rr = p => sg * (E - p) / D;
      if (rr(B.x) >= STOP) continue;   // past 0.786 before the impulse was known
      for (const [zi, zn] of ZN.entries()) {
        const x = ZONES[zn] ? 0 : 0.35 + 0.4 * rnd(`${sym}:${Q.tf}:${k}:${Q.t[B.i]}`), [z0, z1] = ZONES[zn] ?? [x - 0.025, x + 0.025];
        let hit = -1;
        for (let j = B.c; j <= until; j++) {
          const deep = rr(sg > 0 ? Q.l[j] : Q.h[j]), near = rr(sg > 0 ? Q.h[j] : Q.l[j]);
          if (deep >= STOP || near < 0) break;
          if (near <= z1 && deep >= z0) { hit = j; break; }
        }
        if (hit < 0 || Q.t[hit] < y0 || Q.t[hit] >= y1) continue;
        const r0 = trade(Q, hit, sg, E, D, TARGETS['цель 0'], edge), r1 = trade(Q, hit, sg, E, D, TARGETS['цель 1.272'], edge);
        if (!r0 && !r1) continue;
        const [m, tv] = at(hit);
        C.push(kx * NZ + zi, m, tv, sg, hit === B.c ? 1 : 0, ...(r0 ?? [NaN, NaN]), ...(r1 ?? [NaN, NaN]));
      }
    }
  }
}

export async function start(opt = {}) {
  const ks = opt.ks ?? [3, 2];
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  for (const tf of ['1h', '4h']) out[tf] = { tf, ks, years: [], tr: {} };
  try {
    const years = yearsBack(), pl = await pools(years);
    for (const [yi, [y0, y1]] of years.entries()) await year(pl[yi], yi, y0, y1, years[2][1], ks, opt);
    S.phase = 'done';
  } catch (e) { S.err = String(e.message || e); S.phase = 'error'; }
}

async function year(syms, yi, y0, y1, end, ks, opt) {
  const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`, nT = Math.round((y1 - y0) / H1);
  const wEnd = Math.min(y1 + TAIL, end), G = [], C = { '1h': [], '4h': [] }, imp = { '1h': {}, '4h': {} };
  let loaded = 0;
  S.phase = label; S.total = syms.length; S.done = 0;
  await pool(syms, opt.par ?? 6, async s => {
    try {
      const K = await klines(s, '1h', y0 - WARM, wEnd);
      if (K.length > 50) {
        const Q1 = series(K, H1), Q4 = series(four(K), H4);
        const turn = i => Math.fround(Q1.cum[i] - (i >= 24 ? Q1.cum[i - 24] : 0));   // 24 h, as the top is ranked
        const g = new Float32Array(nT).fill(NaN);
        for (let i = 0; i < Q1.n; i++) { const m = (Q1.t[i] - y0) / H1; if (m >= 0 && m < nT) g[m] = turn(i); }
        G.push(g);
        events(Q1, s, ks, y0, y1, wEnd - 2 * H1, j => [(Q1.t[j] - y0) / H1, turn(j)], C['1h'], imp['1h']);
        // a 4h bar is decided at its close, which is the close of its last hour
        events(Q4, s, ks, y0, y1, wEnd - 2 * H4, j => { const T = Q4.t[j] + 3 * H1; return [(T - y0) / H1, turn(below(Q1.t, T))]; }, C['4h'], imp['4h']);
        loaded++;
      }
    } catch (e) { S.note = s + ': ' + (e.message || e); }
    S.done++;
  });
  // the turnover of the 50th pair at each hour: a pair is in the top-50 when its own is not lower
  S.phase += ' · топ';
  const thr = new Float32Array(nT), buf = new Float32Array(G.length);
  for (let m = 0; m < nT; m++) { let q = 0; for (const g of G) { const v = g[m]; if (v === v) buf[q++] = v; } thr[m] = q > 50 ? buf.subarray(0, q).sort()[q - 50] : 0; }
  for (const tf of ['1h', '4h']) {
    const run = out[tf], c = C[tf];
    run.years.push({ label, pool: syms.length, loaded, imp: imp[tf], events: c.length / 9 });
    for (let q = 0; q < c.length; q += 9) {
      if (c[q + 2] < thr[c[q + 1]]) continue;
      const key = `${ks[Math.floor(c[q] / NZ)]}|${ZN[c[q] % NZ]}`;
      for (const [n, tg] of Object.keys(TARGETS).entries()) {
        const R = c[q + 5 + 2 * n]; if (R !== R) continue;
        const b = run.tr[`${key}|${tg}`] ??= { y: [], m: [], R: [], G: [], s: [], c: [] };
        b.y.push(yi); b.m.push(c[q + 1]); b.R.push(R); b.G.push(c[q + 6 + 2 * n]); b.s.push(c[q + 3]); b.c.push(c[q + 4]);
      }
    }
  }
}

export const _t = { zigzag, trade, events, series, four };   // for checks in the console

// ---------- report: by year, for each k, target and zone
const sgn = x => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(2), pct = x => (x * 100).toFixed(0) + '%';
function stat(b, yi) {
  const ix = []; for (let q = 0; q < b.y.length; q++) if (b.y[q] === yi) ix.push(q);
  ix.sort((p, q) => b.m[p] - b.m[q]);
  let w = 0, s = 0, s2 = 0, g = 0, pos = 0, neg = 0, eq = 0, pk = 0, dd = 0, atc = 0, sh = 0;
  for (const q of ix) {
    const r = b.R[q]; s += r; s2 += r * r; g += b.G[q]; atc += b.c[q]; sh += b.s[q] < 0;
    if (r > 0) { w++; pos += r; } else neg -= r;
    eq += r; if (eq > pk) pk = eq; if (pk - eq > dd) dd = pk - eq;
  }
  const n = ix.length, R = s / n;
  return { n, win: w / n, R, se: Math.sqrt(Math.max(0, s2 / n - R * R) / n), G: g / n, PF: pos / neg, DD: dd, atC: atc / n, short: sh / n };
}
export function report(tf = '1h', raw = false) {
  const run = out[tf], Y = run.years.map((_, i) => i);
  const res = { tf, years: run.years.map(y => `${y.label}: пул ${y.pool}, загружено ${y.loaded}, импульсов ${JSON.stringify(y.imp)}, касаний ${y.events}`), rows: {}, verdict: {} };
  const all = {};
  for (const k of run.ks) for (const tg of Object.keys(TARGETS)) {
    const st = {};
    for (const zn of ZN) {
      const b = run.tr[`${k}|${zn}|${tg}`]; st[zn] = Y.map(yi => b ? stat(b, yi) : null);
      res.rows[`k${k} · ${tg} · ${zn}`] = st[zn].map(x => x?.n ? `${sgn(x.R)}R ±${(1.64 * x.se).toFixed(2)} · до изд. ${sgn(x.G)} · n ${x.n} · ${pct(x.win)} · PF ${x.PF.toFixed(2)} · DD ${x.DD.toFixed(0)}R · на подтв. ${pct(x.atC)}` : '—');
    }
    all[`k${k} · ${tg}`] = st;
    const gp = st[ZN[0]], pl = ZN.slice(1).map(z => st[z]);
    const net = Y.every(yi => gp[yi]?.R > 0), beat = Y.every(yi => pl.every(p => gp[yi]?.R > p[yi]?.R && gp[yi]?.G > p[yi]?.G));
    res.verdict[`k${k} · ${tg}`] = `R > 0 во всех годах: ${net ? 'да' : 'нет'}; лучше всех плацебо во всех годах (R и до издержек): ${beat ? 'да' : 'нет'}`;
  }
  return raw ? all : res;
}
