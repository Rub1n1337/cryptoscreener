// Stage 0.5 of docs/PLAN-WALLS.md: does anything known at the moment of entry tell a bounce that works from one that fails —
// the same way in each of three years? If nothing does, an order-book filter has little to build on.
// In the preview (localhost:8765):
//   const R = await import('/research/stage05.js?' + Date.now()); R.start({tf: '1h'});   then poll R.S; R.analyze('1h') when done
// Data: Binance public API (klines), 6 requests at a time (well under the weight limit; no timers between them: a hidden
// preview pane throttles timers). Nothing is written anywhere.
//
// Events: every band touch with a confirmed reversal (math.js signalAt, judged at the bar's close, as the backtest), on the
// honest top-50 by 24 h turnover at that bar, from a pool of every coin that was ever in the daily top-75 of that year —
// delisted ones included (as the 19.10 three-year check). One event per touch. No profile filters: all of them.
// Outcome: from the close of the signal bar, which comes first — the price 1 stop distance in the trade's favour (win) or
// against it (loss); stop distance as math.js levels(); both in one bar counts as a loss; unresolved in 48 bars is left out.
import * as M from '../supabase/functions/_shared/math.js';

const API = 'https://data-api.binance.vision/api/v3', DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function get(path) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(API + path, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status === 418) { S.note = 'Binance: пауза'; await sleep(60000); continue; }
      if (r.status === 400) return [];   // unknown symbol for the period
    } catch { /* retry */ }
    await sleep(1500 * (a + 1));
  }
  throw new Error('fetch failed ' + path);
}
// rows [openTime, o, h, l, c, volume, quoteVolume]
export async function klines(sym, tf, start, end) {
  const out = [];
  for (let t = start; t < end;) {
    const K = await get(`/klines?symbol=${sym}&interval=${tf}&startTime=${t}&endTime=${end - 1}&limit=1000`);
    if (!K.length) break;
    for (const k of K) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
    t = K[K.length - 1][0] + M.TFMS[tf];
    if (K.length < 1000) break;
  }
  return out;
}
export async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

export const S = { phase: 'idle', done: 0, total: 0, note: '', err: null, t0: 0 };
export const out = {};   // tf -> {set, years, events}
let QV = null;   // daily turnover of every pair (sym -> Map(day -> quote volume)), kept between runs

// three years back from today's midnight (UTC), oldest first
export const yearsBack = (end = Math.floor(Date.now() / DAY) * DAY) => [0, 1, 2].map(y => [end - (3 - y) * 365 * DAY, end - (2 - y) * 365 * DAY]);
// daily turnover of every pair over the three years, delisted ones included (the ticker still lists them):
// the pool of each year is what was ever in its daily top-75, plus the majors
export async function pools(years) {
  if (!QV) {
    const tk = await get('/ticker/24hr');
    const syms = tk.map(x => x.symbol).filter(s => s.endsWith('USDT') && !M.STABLE.has(s.slice(0, -4)));
    S.phase = 'daily'; S.total = syms.length; S.done = 0;
    const qv = {};
    await pool(syms, 6, async s => { try { const K = await klines(s, '1d', years[0][0] - 2 * DAY, years[2][1]); if (K.length) qv[s] = new Map(K.map(k => [k[0], k[6]])); } catch {} S.done++; });
    QV = qv;
  }
  return years.map(([y0, y1]) => {
    const inPool = new Set();
    for (let d = y0; d < y1; d += DAY) {
      const day = Object.keys(QV).map(s => [s, QV[s].get(d) || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 75);
      for (const [s] of day) inPool.add(s);
    }
    for (const s of M.MAJORS) inPool.add(s);
    return [...inPool];
  });
}

export async function start(opt = {}) {
  const tf = opt.tf ?? '1h', set = { method: 'log', N: 210, k: opt.k ?? 3.5, tf, minScore: 0 };
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  const run = out[tf] = { set, years: [], events: [] };
  try {
    const years = yearsBack(), pl = await pools(years);
    for (const [n, [y0, y1]] of years.entries()) await yearEvents(pl[n], y0, y1, set, run);
    S.phase = 'done';
  } catch (e) { S.err = String(e.message || e); S.phase = 'error'; }
}

async function yearEvents(syms, y0, y1, set, run) {
  const label = `${new Date(y0).toISOString().slice(0, 10)}…${new Date(y1).toISOString().slice(0, 10)}`, TF = set.tf, TFMS = M.TFMS[TF];
  S.phase = `${TF} ${label}`; S.total = syms.length; S.done = 0;
  const P = {}, warm = 450 * TFMS, day = Math.round(DAY / TFMS);
  await pool(syms, 6, async s => {
    try { const K = await klines(s, TF, y0 - warm, y1); if (K.length >= set.N + 30) { const Q = M.prepare(K, set); Q.idx = new Map(Q.t.map((t, i) => [t, i])); Q.qv = K.map(k => k[6]); P[s] = Q; } } catch {}
    S.done++;
  });
  S.phase += ' · события';
  const B = P.BTCUSDT, majors = M.MAJORS.filter(s => P[s]), erL = M.erBars(TF);
  const erAt = (Q, i) => { if (i < erL) return null; let path = 0; for (let j = i - erL + 1; j <= i; j++) path += Math.abs(Q.c[j] - Q.c[j - 1]); return { er: path ? Math.abs(Q.c[i] - Q.c[i - erL]) / path : 0, ch: Q.c[i] / Q.c[i - erL] - 1 }; };
  const times = [...new Set(Object.values(P).flatMap(Q => Q.t))].filter(t => t >= y0 && t < y1).sort((a, b) => a - b);
  const turn = (Q, i) => { let s = 0; for (let j = Math.max(0, i - day + 1); j <= i; j++) s += Q.qv[j]; return s; };   // 24 h
  const seen = new Set(), ev = [];
  for (const T of times) {
    const top = Object.keys(P).map(s => { const Q = P[s], i = Q.idx.get(T); return i == null ? null : [s, turn(Q, i), i]; }).filter(Boolean)
      .sort((a, b) => b[1] - a[1]).slice(0, 50);
    let reg = null;
    for (const [rank0, [s, , i]] of top.entries()) {
      const Q = P[s];
      if (!M.touchedAt(Q, i)) continue;
      const r = M.signalAt(Q, i, s, T + TFMS, true);
      if (!r?.rev || r.side == null) continue;
      const key = s + ':' + r.touchTime; if (seen.has(key)) continue; seen.add(key);
      const sg = r.side === 'low' ? 1 : -1, e = Q.c[i], slD = M.clamp(1.5 * r.atr / e, 0.008, 0.025);
      if (i + 48 > Q.n - 1) continue;   // the last two days of data: no full window
      // the 48 bars after entry in stop distances: move in the trade's favour, against it, close (for the stop/target grid)
      const path = new Float32Array(144);
      let res = 0;
      for (let k = 0; k < 48; k++) {
        const j = i + 1 + k, f = sg > 0 ? Q.h[j] / e - 1 : 1 - Q.l[j] / e, a = sg > 0 ? 1 - Q.l[j] / e : Q.h[j] / e - 1;
        path[3 * k] = f / slD; path[3 * k + 1] = a / slD; path[3 * k + 2] = sg * (Q.c[j] / e - 1) / slD;
        if (!res) res = a >= slD ? -1 : f >= slD ? 1 : 0;
      }
      if (reg === null) {   // the market regime at this bar, as the shared bot's border (0.25) reads BTC, ETH and SOL
        const m = majors.map(x => { const q = P[x], k = q.idx.get(T); return k == null ? null : erAt(q, k); });
        reg = m.every(Boolean) ? (m.every(x => x.er < 0.25) ? 'flat' : m[0].ch > 0 ? 'up' : 'down') : '';
      }
      const bi = B?.idx.get(T), bret = n => bi != null && bi >= n ? sg * (B.c[bi] / B.c[bi - n] - 1) : null;
      const at = new Date(T + TFMS), hr = at.getUTCHours();
      ev.push({ year: label, week: Math.floor((T - y0) / (7 * DAY)), win: res ? res > 0 : null, side: sg > 0 ? 'LONG' : 'SHORT', score: r.score, rank: rank0 + 1,
        slD, path, width: (r.up - r.lo) / r.mid, er: r.er, trend: sg * r.erCh, btc1d: bret(day), btc7d: bret(7 * day), volZ: r.volZ,
        rsiX: sg > 0 ? 100 - r.rsi : r.rsi,   // higher — more stretched against the trade's direction (oversold for a long)
        hl: isFinite(r.hl) ? r.hl : 999,
        room: sg * (r.mid - e) / e / slD, regime: reg, dow: at.getUTCDay(), session: hr < 8 ? 'Азия' : hr < 16 ? 'Европа' : 'США' });
    }
  }
  run.events.push(...ev);
  const done = ev.filter(x => x.win != null);
  run.years.push({ label, pool: syms.length, loaded: Object.keys(P).length, events: done.length, open48: ev.length - done.length, win: done.filter(x => x.win).length / (done.length || 1) });
}

// ---------- analysis: for each feature, the win rate of its low / middle / high third (thresholds on all events), by year,
// and the difference high − low with a 90% interval from resampling weeks (signals come in clusters, so not by event)
// group B's win rate minus group A's: the 90% interval from resampling whole weeks
function boot(ev, inA, inB, it = 400) {
  const weeks = [...new Set(ev.map(x => x.week))], by = new Map(weeks.map(w => [w, ev.filter(x => x.week === w)])), d = [];
  for (let k = 0; k < it; k++) {
    const smp = []; for (let n = 0; n < weeks.length; n++) smp.push(...by.get(weeks[Math.floor(Math.random() * weeks.length)]));
    const a = smp.filter(inA), b = smp.filter(inB);
    if (a.length > 4 && b.length > 4) d.push(b.filter(x => x.win).length / b.length - a.filter(x => x.win).length / a.length);
  }
  d.sort((x, y) => x - y);
  return d.length ? [d[Math.floor(d.length * 0.05)], d[Math.floor(d.length * 0.95)]] : [NaN, NaN];
}
const pct = x => (x * 100).toFixed(0) + '%', rate = s => s.length ? `${pct(s.filter(x => x.win).length / s.length)}/${s.length}` : '—';
const ci = c => `${(c[0] * 100).toFixed(0)}…${(c[1] * 100).toFixed(0)}`;
// a finding: the interval is on the same side of zero in each year
const verdict = cs => cs.every(c => c[0] > 0) || cs.every(c => c[1] < 0) ? 'ДА' : 'нет';
export function analyze(tf = '1h') {
  const run = out[tf], E = run.events.filter(x => x.win != null), years = run.years.map(y => y.label);
  const num = ['score', 'rank', 'width', 'er', 'trend', 'btc1d', 'btc7d', 'volZ', 'rsiX', 'hl', 'room'];
  const res = { tf, base: run.years.map(y => `${y.label}: ${y.events} событий, выигрыш ${pct(y.win)}`), numeric: {}, split: {} };
  for (const f of num) {
    const v = E.map(x => x[f]).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    const lo = v[Math.floor(v.length / 3)], hi = v[Math.floor(v.length * 2 / 3)];
    const cs = years.map(y => boot(E.filter(x => x.year === y && x[f] != null), x => x[f] <= lo, x => x[f] > hi));
    res.numeric[f] = { cut: [+lo.toFixed(3), +hi.toFixed(3)], finding: verdict(cs), years: years.map((y, k) => {
      const e = E.filter(x => x.year === y && x[f] != null);
      return `${rate(e.filter(x => x[f] <= lo))} | ${rate(e.filter(x => x[f] > lo && x[f] <= hi))} | ${rate(e.filter(x => x[f] > hi))} · B−A ${ci(cs[k])}`;
    }) };
  }
  for (const [name, inA, inB] of [['LONG → SHORT', x => x.side === 'LONG', x => x.side === 'SHORT'],
    ['не боковик → боковик', x => x.regime !== 'flat', x => x.regime === 'flat'], ['выходные → будни', x => x.dow % 6 === 0, x => x.dow % 6 !== 0],
    ['Азия+США → Европа', x => x.session !== 'Европа', x => x.session === 'Европа']]) {
    const cs = years.map(y => boot(E.filter(x => x.year === y), inA, inB));
    res.split[name] = { finding: verdict(cs), years: years.map((y, k) => { const e = E.filter(x => x.year === y); return `${rate(e.filter(inA))} → ${rate(e.filter(inB))} · B−A ${ci(cs[k])}`; }) };
  }
  return res;
}
// "the stop is a little too close": every event traded with a stop of m and a target of t base stop distances, a forced exit at
// the close of bar 48, costs as math.js (fee both sides, slippage on the entry and on a stop or forced exit, borrowing for a
// short). The mean result in R (R = the stop of that row). Both levels in one bar count as the stop.
// rebound: of the trades stopped at m = 1, how many reached +2 after the stop within the 48 bars.
export function grid(tf = '1h', ms = [1, 1.5, 2, 3], ts = [1, 2, 3]) {
  const run = out[tf], E = run.events, years = run.years.map(y => y.label), barDays = M.TFMS[tf] / DAY, rows = {};
  for (const m of ms) for (const t of ts) rows[`стоп ${m} · цель ${t}`] = years.map(y => {
    let sum = 0, n = 0, w = 0;
    for (const x of E) {
      if (x.year !== y) continue;
      const p = x.path; let mv = null, k = 0, slip = M.SLIP;
      for (; k < 48 && mv == null; k++) { if (p[3 * k + 1] >= m) mv = -m; else if (p[3 * k] >= t) { mv = t; slip = 0; } }
      if (mv == null) mv = p[3 * 47 + 2];
      const cost = 2 * M.FEE + M.SLIP + slip + (x.side === 'SHORT' ? M.BORROW_DAY * k * barDays : 0);
      sum += (mv * x.slD - cost) / (m * x.slD); n++; if (mv > 0) w++;
    }
    return `${(sum / n).toFixed(2)}R (${pct(w / n)})`;
  });
  const rebound = years.map(y => {
    const L = E.filter(x => x.year === y && x.win === false);
    const back = L.filter(x => { const p = x.path; let k = 0; while (k < 48 && p[3 * k + 1] < 1) k++; for (k++; k < 48; k++) if (p[3 * k] >= 2) return true; return false; });
    return `${back.length}/${L.length} (${pct(back.length / (L.length || 1))})`;
  });
  return { tf, rows, rebound };
}
