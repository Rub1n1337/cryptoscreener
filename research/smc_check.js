// Check of the SMC round done with DeepSeek (07.11, research/smc_multi.js): its order-block filter raised the win rate of the
// band bounce from ~38% to ~45%. There an order block counts from its source candle (the extreme before the structure break),
// but it only exists once the break happens — often after the entry, sometimes after the trade is over. Here the same signals
// and the same trade model, with the order block counted three ways:
//   ds     — as smc_multi.js (from the source candle, either side);
//   honest — from the break bar on, and only an order block on the trade's side;
//   late   — the trades ds keeps only because of a break that came after the entry (the look-ahead part).
// Each with smc_multi's fixed take (2R) and with its trailing stop (break-even at +1R, then 1 ATR behind the best price).
// Consecutive signal bars of one touch count once (smc_multi counted each bar).
// In the preview (localhost:8765):
//   const C = await import('/research/smc_check.js?' + Date.now()); C.start();   then poll C.S; the result is C.res
import * as M from '../supabase/functions/_shared/math.js';
import { S, klines, pool, pools, yearsBack } from './stage05.js';

const DAY = 864e5, HOLD = 48;
export { S };
export let res = null;

// smc_multi's swings and breaks, with the bar the order block appears on
function analyze(K) {
  const n = K.length, obs = [];
  let ph = { p: -Infinity, i: -1 }, pl = { p: Infinity, i: -1 }, trend = 0;
  for (let i = 20; i < n; i++) {
    const c = i - 10;
    let hi = true, lo = true;
    for (let j = c - 10; j <= i; j++) { if (K[j][2] > K[c][2]) hi = false; if (K[j][3] < K[c][3]) lo = false; }
    if (hi) ph = { p: K[c][2], i: c };
    if (lo) pl = { p: K[c][3], i: c };
    const close = K[i][4];
    if (ph.i !== -1 && pl.i !== -1) {
      if (close > ph.p && trend !== 1) {
        trend = 1; let o = pl.i; for (let j = pl.i; j <= i; j++) if (K[j][3] < K[o][3]) o = j;
        obs.push({ top: K[o][2], bot: K[o][3], side: 'LONG', src: o, made: i, end: -1 });
      } else if (close < pl.p && trend !== -1) {
        trend = -1; let o = ph.i; for (let j = ph.i; j <= i; j++) if (K[j][2] > K[o][2]) o = j;
        obs.push({ top: K[o][2], bot: K[o][3], side: 'SHORT', src: o, made: i, end: -1 });
      }
    }
    for (const ob of obs) if (ob.end === -1 && ob.made < i) {
      if (ob.side === 'LONG' && close < ob.bot) ob.end = i;
      if (ob.side === 'SHORT' && close > ob.top) ob.end = i;
    }
  }
  return obs;
}

// smc_multi's trade: entry at the signal bar's close, stop max(1.5 ATR, 0.8%), take 2R or the trailing stop, 48 bars at most
function trade(K, i, side, atr, trail) {
  const e = K[i][4], d = Math.max(atr * 1.5 / e, 0.008), L = side === 'LONG';
  const sl0 = L ? e * (1 - d) : e * (1 + d), tp = L ? e * (1 + 2 * d) : e * (1 - 2 * d);
  let sl = sl0, best = e, x = null;
  for (let j = i + 1; j < Math.min(K.length, i + HOLD); j++) {
    if (L ? K[j][3] <= sl : K[j][2] >= sl) { x = L ? sl * (1 - M.SLIP) : sl * (1 + M.SLIP); break; }
    if (!trail && (L ? K[j][2] >= tp : K[j][3] <= tp)) { x = tp; break; }
    best = L ? Math.max(best, K[j][2]) : Math.min(best, K[j][3]);
    if (trail) {
      const go = L ? best - e : e - best;
      if (go >= e * d) sl = L ? Math.max(sl, e) : Math.min(sl, e);
      if (go >= e * d * 1.5) sl = L ? Math.max(sl, best - atr) : Math.min(sl, best + atr);
    }
  }
  if (x == null) x = K[Math.min(K.length - 1, i + HOLD)][4] * (L ? 1 - M.SLIP : 1 + M.SLIP);
  return ((L ? x - e : e - x) - (e + x) * M.FEE) / Math.abs(e - sl0);
}

const near = (ob, z) => ob.top >= z * 0.99 && ob.bot <= z * 1.01;
const sum = a => {
  if (!a.length) return { n: 0 };
  const w = a.filter(r => r > 0).length, m = a.reduce((s, r) => s + r, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, r) => s + (r - m) ** 2, 0) / a.length);
  return { n: a.length, win: Math.round(w / a.length * 100) + '%', avgR: +m.toFixed(3), se: +(sd / Math.sqrt(a.length)).toFixed(3) };
};

export async function start(opt = {}) {
  Object.assign(S, { phase: 'ticker', done: 0, total: 0, note: '', err: null, t0: Date.now() });
  res = null;
  const years = yearsBack(), pl = await pools(years);
  const set = { method: 'log', N: 210, k: 3.5, tf: '1h', minScore: 60 };
  const R = {}, hours = {};
  for (const [yi, [y0, y1]] of years.entries()) {
    const y = new Date(y0).toISOString().slice(0, 7) + '…' + new Date(y1).toISOString().slice(0, 7);
    const T = R[y] = { base: [[], []], ds: [[], []], honest: [[], []], late: [[], []] };
    const H = hours[y] = Array.from({ length: 24 }, () => []);
    S.phase = y; S.total = pl[yi].length; S.done = 0;
    await pool(pl[yi].slice(0, opt.limit ?? Infinity), opt.par ?? 6, async sym => {
      try {
        const K = await klines(sym, '1h', y0 - 30 * DAY, y1);
        if (K.length < 300) return;
        const Q = M.prepare(K, set), obs = analyze(K);
        let prev = null;
        for (let i = 210; i < K.length - HOLD; i++) {
          if (K[i][0] < y0) continue;
          const r = M.signalAt(Q, i, sym, K[i][0] + 36e5, true);
          const key = r && r.rev && r.score >= 60 ? r.side : null;
          if (!key || key === prev) { prev = key; continue; }
          prev = key;
          const side = key === 'low' ? 'LONG' : 'SHORT', z = key === 'low' ? r.lo : r.up;
          const out = [trade(K, i, side, Q.A[i], false), trade(K, i, side, Q.A[i], true)];
          const live = ob => ob.end === -1 || ob.end > i;
          const ds = obs.some(ob => ob.src <= i && live(ob) && near(ob, z));
          const honest = obs.some(ob => ob.made <= i && live(ob) && ob.side === side && near(ob, z));
          const dsNow = obs.some(ob => ob.made <= i && live(ob) && near(ob, z));
          for (const k of [0, 1]) {
            T.base[k].push(out[k]);
            if (ds) T.ds[k].push(out[k]);
            if (honest) T.honest[k].push(out[k]);
            if (ds && !dsNow) T.late[k].push(out[k]);
          }
          H[new Date(K[i][0]).getUTCHours()].push(out[0]);
        }
      } catch (e) { S.err = sym + ': ' + e.message; }
      S.done++;
    });
  }
  const table = {};
  for (const [y, T] of Object.entries(R)) for (const [k, v] of Object.entries(T)) {
    table[`${y} ${k} fixed`] = sum(v[0]); table[`${y} ${k} trail`] = sum(v[1]);
  }
  // hours: the 8 best hours of the first two years, then the same hours in the third
  const ys = Object.keys(hours), h12 = Array.from({ length: 24 }, (_, h) => [h, sum([...hours[ys[0]][h], ...hours[ys[1]][h]]).avgR]);
  const best = h12.sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]).sort((a, b) => a - b);
  const pick = (y, inSet) => sum(hours[y].flatMap((a, h) => best.includes(h) === inSet ? a : []));
  const hourTest = { best, inSample: pick(ys[0], true), inSample2: pick(ys[1], true), outBest: pick(ys[2], true), outRest: pick(ys[2], false) };
  S.phase = 'done';
  res = { table, hourTest, sec: Math.round((Date.now() - S.t0) / 1000) };
  return res;
}
