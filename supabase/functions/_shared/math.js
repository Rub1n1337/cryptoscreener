// Single source of truth for the strategy math.
// Used by the site (index.html imports it as an ES module) and by the shared bot (Supabase Edge Function).
// Any change here changes both — the site picks it up on the next Vercel deploy, the bot on the next function deploy.

export const TFMS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5 };
// stablecoins, gold tokens and wrapped coins: their price follows the dollar, gold or another coin, so a "signal" on them means nothing
export const STABLE = new Set(['USDC','FDUSD','TUSD','BUSD','DAI','USDP','AEUR','EUR','EURI','USDE','USD1','BFUSD','XUSD','PYUSD','RLUSD','UST','USTC','SUSD','U','PAXG','XAUT','WBTC','WBETH','BNSOL']);
export const FEE = 0.00075;   // exchange fee per side (taker, with BNB discount)
export const SLIP = 0.0005;   // slippage on market fills: entry, stop and time-stop exits (TP is a limit order — no slippage)
export const MAX_OPEN = 3;    // simultaneous positions by default; a profile may set its own (S.maxOpen, 1–10)
export const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const slotsOf = S => Math.min(10, Math.max(1, Math.round(+S?.maxOpen || MAX_OPEN)));
export const RISK = 0.02;     // share of balance lost if the stop is hit
export const TIME_STOP = 48;  // bars until a forced market exit
export const COOLDOWN = 4;    // bars before re-entering the same coin
export const MIN_ROOM = 0.8;    // a bounce needs at least this × the stop distance left to the centre (see planEntry)
// borrowing: a short on spot borrows the whole position, a leveraged long borrows what exceeds its share of the balance
// (balance / slots). Interest per day on the borrowed amount — an estimate (Binance margin: USDT ~5–10% a year, altcoins
// for shorts often more). Before 2.33 it was not counted at all, which flattered shorts and leverage.
export const BORROW_DAY = 0.0003;

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

// ---------- indicators ----------
// returns {mid, up, lo, z}; z = deviation of the price from the centre in sigma units of the model
export function bands(c, N, k, m) {
  const n = c.length, mid = Array(n).fill(NaN), up = Array(n).fill(NaN), lo = Array(n).fill(NaN), z = Array(n).fill(NaN);
  if (m === 'log') {
    const r = bands(c.map(Math.log), N, k, 'classic');
    return { mid: r.mid.map(Math.exp), up: r.up.map(Math.exp), lo: r.lo.map(Math.exp), z: r.z };
  }
  if (m === 'ewma') {
    const a = 2 / (N + 1); let mu = c[0], v = 0;
    for (let i = 0; i < n; i++) {
      const d = c[i] - mu; mu += a * d; v = (1 - a) * (v + a * d * d);
      if (i >= N - 1) { const s = Math.sqrt(v); mid[i] = mu; up[i] = mu + k*s; lo[i] = mu - k*s; z[i] = s ? (c[i] - mu) / s : 0; }
    }
    return { mid, up, lo, z };
  }
  if (m === 'robust') {
    for (let i = N - 1; i < n; i++) {
      const w = c.slice(i - N + 1, i + 1), mu = median(w), s = 1.4826 * median(w.map(x => Math.abs(x - mu)));
      mid[i] = mu; up[i] = mu + k*s; lo[i] = mu - k*s; z[i] = s ? (c[i] - mu) / s : 0;
    }
    return { mid, up, lo, z };
  }
  // classic: running sums over the window instead of re-adding all N values at every bar (the scanner and the bots run this
  // for hundreds of coins a minute). Values are shifted by the first one so the variance keeps its precision, and the sums are
  // recomputed from scratch every 512 bars so rounding never piles up: the result matches summing each window to ~1e-12.
  const c0 = c[0]; let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const x = c[i] - c0; s1 += x; s2 += x * x;
    if (i >= N) { const y = c[i - N] - c0; s1 -= y; s2 -= y * y; }
    if (i < N - 1) continue;
    if (i % 512 === 0) { s1 = 0; s2 = 0; for (let j = i - N + 1; j <= i; j++) { const y = c[j] - c0; s1 += y; s2 += y * y; } }
    const m1 = s1 / N, s = Math.sqrt(Math.max(0, s2 / N - m1 * m1)), mu = m1 + c0;
    mid[i] = mu; up[i] = mu + k*s; lo[i] = mu - k*s; z[i] = s ? (c[i] - mu) / s : 0;
  }
  return { mid, up, lo, z };
}
export function rsi(c, p = 14) {
  const r = Array(c.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i-1], G = Math.max(d, 0), L = Math.max(-d, 0);
    if (i <= p) { g += G; l += L; if (i === p) { g /= p; l /= p; r[i] = l ? 100 - 100/(1 + g/l) : 100; } }
    else { g = (g*(p-1) + G)/p; l = (l*(p-1) + L)/p; r[i] = l ? 100 - 100/(1 + g/l) : 100; }
  }
  return r;
}
export function atr(h, l, c, p = 14) {
  let a = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1]));
    a = i <= p ? (isNaN(a) ? tr : a + (tr - a) / i) : (a*(p-1) + tr)/p;
  }
  return a;
}
// half-life of the deviation from the centre via AR(1): x_t = phi * x_{t-1}
export function halfLife(c, mid) {
  const x = []; for (let i = 0; i < c.length; i++) if (isFinite(mid[i]) && mid[i] > 0) x.push(Math.log(c[i]) - Math.log(mid[i]));
  const xs = x.slice(-150); let num = 0, den = 0;
  for (let i = 1; i < xs.length; i++) { num += xs[i]*xs[i-1]; den += xs[i-1]*xs[i-1]; }
  const phi = den ? num/den : 1;
  return phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : Infinity;
}
export function parse(K) {
  return { t: K.map(x => x[0]), o: K.map(x => +x[1]), h: K.map(x => +x[2]), l: K.map(x => +x[3]), c: K.map(x => +x[4]), v: K.map(x => +x[5]) };
}

export function atrSeries(h, l, c, p = 14) {
  const out = Array(c.length).fill(NaN); let a = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1]));
    a = i <= p ? (isNaN(a) ? tr : a + (tr - a) / i) : (a*(p-1) + tr)/p;
    out[i] = a;
  }
  return out;
}

// ---------- signal ----------
// prepare() computes the series once; signalAt() evaluates bar i as if it were the current (forming) bar.
// The live scanner calls signalAt on the last bar, the backtest on every bar — same code, same result.
export function prepare(K, S) {
  const d = parse(K), n = d.c.length, c = d.c;
  const B = bands(c, S.N, S.k, S.method);
  const lr = [NaN]; for (let j = 1; j < n; j++) lr.push(Math.log(c[j] / c[j-1]));
  const x = c.map((ci, i) => isFinite(B.mid[i]) && B.mid[i] > 0 ? Math.log(ci) - Math.log(B.mid[i]) : NaN);
  return { ...d, n, B, R: rsi(c), A: atrSeries(d.h, d.l, c), lr, x, S };
}
// a band touch counts for this many bars, the touch bar included: the window for an entry, not for holding a position
// (a year of history: 10 or 20 bars made every tested setup worse — late entries; see docs/RESEARCH-2026-10.md)
export const TOUCH_BARS = 5;
// cheap pre-check used by the backtest: any band touch in the last TOUCH_BARS bars?
export function touchedAt(P, i) {
  for (let j = i; j > i - TOUCH_BARS && j >= 0; j--) if (P.l[j] <= P.B.lo[j] || P.h[j] >= P.B.up[j]) return true;
  return false;
}
function halfLifeAt(P, i) {
  let num = 0, den = 0, prev = NaN, cnt = 0;
  for (let j = Math.max(0, i - 149); j <= i; j++) {
    const xj = P.x[j]; if (!isFinite(xj)) continue;
    if (cnt++ > 0) { num += xj * prev; den += prev * prev; }
    prev = xj;
  }
  const phi = den ? num / den : 1;
  return phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : Infinity;
}
function sdRange(a, from, to) {
  let s = 0, n = 0; for (let j = Math.max(1, from); j <= to; j++) { s += a[j]; n++; }
  if (!n) return 0; const m = s / n; let q = 0;
  for (let j = Math.max(1, from); j <= to; j++) q += (a[j] - m) ** 2;
  return Math.sqrt(q / n);
}
// S = {method, N, k, tf}
// lite: skip the display-only extras — the bots only need what they trade on
// atClose: the last closed bar judged exactly as the backtest judges it (bar fully elapsed). The bots enter on that one, not on
// the forming bar, so a live entry happens when the backtest's would: a bar after the reversal candle, if the price held in the
// channel to its close. Before 2.31 the bots entered as soon as the reversal candle closed, a bar earlier than every backtest.
// null when there is no forming bar (the last bar is already closed: the row itself is that judgement); false when the closed
// bar gives nothing to judge.
export function analyze(sym, K, S, now = Date.now(), lite = false) {
  if (K.length < S.N + 10) return null;
  const P = prepare(K, S), i = P.n - 1, r = signalAt(P, i, sym, now, lite);
  if (r) r.atClose = P.t[i] + TFMS[S.tf] <= now ? null : (i - 1 >= S.N + 9 && signalAt(P, i - 1, sym, P.t[i], true)) || false;
  return r;
}
// the row the bots trade on: the closed-bar judgement at the current price (an entry is filled now, not at the last close).
// A row without atClose (an older collector) is traded as it is.
export const tradeRow = r => !r || r.atClose === false ? null : r.atClose == null ? r
  : { ...r.atClose, price: r.price, mkt: r.mkt, barHi: r.barHi, barLo: r.barLo };
// history kept per coin and timeframe by the bots and the collector: one length, so indicators that depend on where the series
// starts (RSI, EWMA) give the same strength everywhere
export const BARS = 450;
export function signalAt(P, i, sym, now, lite = false) {   // lite: skip the display-only extras (backtest)
  const { t, o, h, l, c, v, B, S } = P, p = i - 1;
  if (i < S.N + 9) return null;
  if (!isFinite(B.mid[i]) || B.up[i] <= B.lo[i]) return null;
  const pB = (c[i] - B.lo[i]) / (B.up[i] - B.lo[i]);
  const r = P.R[i], hl = halfLifeAt(P, i);
  // squeeze: volatility compression = sigma of log-returns over last 20 bars / sigma over last N bars
  const vlong = sdRange(P.lr, i - S.N + 1, i), comp = vlong ? sdRange(P.lr, i - 19, i) / vlong : 1;
  const squeeze = comp < 0.5;
  // volume: the forming bar is projected to a full bar, then robust z-score of ln(volume) vs ~96 earlier bars
  const elapsed = clamp((now - t[i]) / TFMS[S.tf], 0.25, 1);
  const va = j => j === i ? v[i] / elapsed : v[j];
  const baseV = v.slice(Math.max(0, i - 99), i - 3).filter(x => x > 0).map(Math.log);
  const vm = median(baseV), vmad = 1.4826 * median(baseV.map(x => Math.abs(x - vm))) || 1;
  const vz = x => x > 0 && isFinite(vm) ? (Math.log(x) - vm) / vmad : 0;

  let touch = null;
  for (let j = i; j > i - TOUCH_BARS; j--) {
    if (l[j] <= B.lo[j]) { touch = { side: 'low', j }; break; }
    if (h[j] >= B.up[j]) { touch = { side: 'up', j }; break; }
  }
  // volume shown: for a touch — the strongest bar since the touch, otherwise the last closed bar
  let vRef = va(p);
  if (touch) { vRef = 0; for (let q = touch.j; q <= i; q++) vRef = Math.max(vRef, va(q)); }
  const volZ = vz(vRef), volX = isFinite(vm) ? vRef / Math.exp(vm) : null;

  let score = null, rev = false, comps = null, checks = null, exc = 0;
  if (touch) {
    const j = touch.j, half = (B.up[j] - B.lo[j]) / (2 * S.k), low = touch.side === 'low';
    exc = Math.max(0, low ? (B.lo[j] - l[j]) / half : (h[j] - B.up[j]) / half);
    checks = {
      closed: j <= p,
      candle: j <= p && (low ? c[p] > o[p] : c[p] < o[p]),
      inside: low ? c[p] > B.lo[p] && c[i] > B.lo[i] : c[p] < B.up[p] && c[i] < B.up[i],
      volume: volZ >= 1,
    };
    rev = checks.closed && checks.candle && checks.inside && checks.volume;
    comps = {
      D: 1 - Math.exp(-2 * exc),
      V: clamp(volZ / 3, 0, 1),
      R: clamp(low ? (35 - r) / 20 : (r - 65) / 20, 0, 1),
      C: rev ? 1 : 0,
      M: isFinite(hl) ? clamp(1 - hl / 40, 0, 1) : 0,
    };
    score = Math.round(100 * (0.25*comps.D + 0.25*comps.V + 0.15*comps.R + 0.20*comps.C + 0.15*comps.M));
  }
  // channel trend: slope of the centre over the last 20 bars (in % of price)
  const slope = isFinite(B.mid[i - 20]) ? (B.mid[i] / B.mid[i - 20] - 1) * 100 : 0;
  // breakout: the last closed bar closed beyond a band (the bar before it was inside) on above-normal volume
  let brk = null;
  if (p >= 1 && isFinite(B.up[p - 1])) {
    const bz = vz(v[p]);
    if (c[p] > B.up[p] && c[p - 1] <= B.up[p - 1] && bz >= 1) brk = { side: 'long', volZ: bz };
    else if (c[p] < B.lo[p] && c[p - 1] >= B.lo[p - 1] && bz >= 1) brk = { side: 'short', volZ: bz };
  }
  // efficiency ratio over ~7 days (capped at 300 bars): |net move| / path length; ≈0 — range, ≈1 — clean trend
  const L = Math.min(erBars(S.tf), i);
  let path = 0; for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
  const er = path ? Math.abs(c[i] - c[i - L]) / path : 0, erCh = c[i] / c[i - L] - 1;
  const outUp = c[i] > B.up[i], outLo = c[i] < B.lo[i];
  // display only (the bots trade on `rev`): the reversal was confirmed on an earlier bar since this touch and only the last
  // candle went against it — the site shows such a signal as weakened instead of dropping it until the next candle
  let wasRev = false;
  if (touch && !rev && !lite) for (let q = i - 1; q > touch.j && !wasRev; q--) { const x = signalAt(P, q, sym, t[q] + TFMS[S.tf], true); wasRev = !!(x?.rev && x.touch.j === touch.j); }
  let label = '', cls = '', kind = '';
  if (touch && rev) { kind = 'sig'; label = touch.side === 'low' ? '▲ сигнал LONG' : '▼ сигнал SHORT'; cls = touch.side === 'low' ? 'loc' : 'upc'; }
  else if (outUp || outLo) { kind = 'out'; label = outUp ? 'за каналом ↑' : 'за каналом ↓'; cls = outUp ? 'uo' : 'lout'; }
  else if (touch) { kind = 'touch'; label = touch.side === 'low' ? 'касание низа' : 'касание верха'; cls = touch.side === 'low' ? 'lo' : 'up'; }
  else if (squeeze) { kind = 'sq'; label = 'сжатие'; cls = 'sq'; }
  return { sym, price: c[i], pB, z: B.z[i], rsi: r, hl, squeeze, comp, touch, touchTime: touch ? t[touch.j] : null, age: touch ? i - touch.j : null, wasRev, rev, score, comps, checks, exc, volX, volZ,
           label, cls, kind, mid: B.mid[i], up: B.up[i], lo: B.lo[i], atr: P.A[i], side: touch?.side, slope, brk, er, erCh,
           barHi: h[i], barLo: l[i] };   // the bar's range so far: a position remembers it at entry (see checkExit)
}
// a fingerprint of how the signal math behaves: the same synthetic candles through every channel model, hashed.
// The bot compares it with the collector's copy (server/scan.js) before trusting analyses computed there.
// The candles swing, fade into a quiet stretch (a squeeze) and get sharp drops, jumps and rebounds through the bands, so
// touches, confirmed reversals and breakouts of both sides happen and the strength formula is in the hash too. The extra
// volumes of those bars are picked so that some sit just above and some just below the volume thresholds of a reversal and a
// breakout, and the fade crosses the squeeze threshold: moving any of them either way changes the fingerprint.
// Before 2.35 the price never reached a band, and a change of the strength weights or of these rules went unnoticed.
const FP_EVENTS = { 236: [0.9, 900], 237: [1.05, 350], 238: [1.04, 1400], 240: [1, 60], 258: [1.11, 700], 259: [0.95, 250], 260: [0.96, 2200],
  280: [0.93, 900], 281: [1.05, 3000], 300: [1.08, 300], 301: [0.955, 1100], 318: [0.94, 950], 319: [1.05, 500], 343: [1.07, 400],
  344: [0.95, 1600], 396: [0.9, 1800], 397: [1.02, 700], 398: [1.03, 1200] };   // bar: [price factor, extra volume]
export function fingerprint() {
  const K = []; let p = 100;
  for (let i = 0; i < 400; i++) {
    const o = p, [ev, xv] = FP_EVENTS[i] || [1, 0], calm = i < 302 ? 1 : i < 332 ? 1 - 0.8 * (i - 302) / 30 : i < 390 ? 0.2 : 1;
    p *= (1 + calm * (0.01 * Math.sin(i * 0.37) + 0.004 * Math.cos(i * 1.7))) * ev;
    K.push([i * 36e5, o, Math.max(o, p) * (1 + calm * 0.003 * (1 + Math.sin(i))), Math.min(o, p) * (1 - calm * 0.003 * (1 + Math.cos(i * 0.5))), p,
      1000 + 500 * Math.sin(i * 0.11) + (i % 17 ? 0 : 4000) + xv]);
  }
  // every channel model on 1h, plus the timeframes and band widths the bots use, mid-bar and after a bar's close
  // (with and without the closed-bar judgement atClose): a change in any of these branches changes the fingerprint
  const at = tf => K.map(k => [k[0] / 36e5 * TFMS[tf], k[1], k[2], k[3], k[4], k[5]]), last = (Q, tf, f) => Q[Q.length - 1][0] + f * TFMS[tf];
  const run = (method, N, k, tf, f) => { const Q = at(tf); return analyze('X', Q, { method, N, k, tf }, last(Q, tf, f), true); };
  // and every bar from the first sharp move on, judged as the backtest judges it, in brief: the touch, the strength and its
  // parts, the checks, the breakout
  const sweep = (method, N, k, tf) => {
    const P = prepare(at(tf), { method, N, k, tf }), rows = [];
    for (let i = Math.max(N + 9, 225); i < P.n; i++) {
      const r = signalAt(P, i, 'X', P.t[i] + TFMS[tf], true);
      rows.push(r && [r.touch?.side, r.age, r.score, r.rev, r.checks, r.comps, r.brk?.side, r.kind, r.squeeze]);
    }
    return rows;
  };
  const out = [...['log', 'classic', 'robust', 'ewma'].map(m => run(m, 210, 2, '1h', 0.5)),
    run('log', 210, 3.5, '4h', 0.5), run('log', 210, 3, '4h', 1.5), run('log', 120, 2.5, '1d', 0.25), run('robust', 60, 3, '15m', 0.9),
    sweep('log', 210, 2, '1h'), sweep('robust', 60, 3, '15m'), sweep('classic', 120, 2.5, '1d')];
  const s = JSON.stringify(out, (k, v) => typeof v === 'number' ? (Number.isFinite(v) ? +v.toPrecision(10) : String(v)) : v);
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + TOUCH_BARS;
}
export const erBars = tf => Math.min(300, Math.round(7 * 864e5 / TFMS[tf]));
export function erSeries(c, L) {
  const out = Array(c.length).fill(null);
  for (let i = L; i < c.length; i++) {
    let path = 0; for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
    out[i] = { er: path ? Math.abs(c[i] - c[i - L]) / path : 0, ch: c[i] / c[i - L] - 1 };
  }
  return out;
}
export const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
// market regime: flat when BTC (or, with S.regimeSrc = 'majors', each of BTC/ETH/SOL) has ER below the threshold;
// otherwise an impulse — up or down by the direction of BTC
export function regimeOf(mkt, S) {
  if (!mkt) return null;
  const thr = S.erMax ?? 0.15;
  const flat = S.regimeSrc === 'majors' && mkt.majors?.length ? mkt.majors.every(m => m.er < thr) : mkt.er < thr;
  return flat ? 'flat' : mkt.ch > 0 ? 'up' : 'down';
}
// builds the market-regime object from per-coin {er, ch} values keyed by symbol
export const marketOf = get => { const b = get('BTCUSDT'); if (!b) return null; return { er: b.er, ch: b.ch, majors: MAJORS.map(get).filter(Boolean) }; };
// the market regime on a timeframe exactly as the backtest sees it: ER of BTC, ETH and SOL over erBars(tf) bars (7 days, at most
// 300 bars) at the last closed bar. closesOf(sym) → closes of closed bars, oldest first. Every bot decides by the regime of its own
// timeframe: before 2.34 the personal bots always used 1h candles, and on 4h that disagreed with the backtest ~30% of the time.
// by: each major's {er, ch}; tf: the timeframe it was measured on
export function marketOn(closesOf, tf) {
  const L = erBars(tf), by = {};
  for (const s of MAJORS) {
    const c = closesOf(s); if (!c || c.length <= L) continue;
    const i = c.length - 1; let path = 0;
    for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
    by[s] = { er: path ? Math.abs(c[i] - c[i - L]) / path : 0, ch: c[i] / c[i - L] - 1 };
  }
  const m = marketOf(s => by[s] || null);
  if (m) { m.by = by; m.tf = tf; }
  return m;
}
// closes of the candles that have closed by `now` (rows [openTime, o, h, l, c, …], numbers or Binance's strings)
export const closedCloses = (K, tf, now) => K.filter(k => +k[0] + TFMS[tf] <= now).map(k => +k[4]);

// ---------- strategies ----------
// S.strategy: 'revert' (bounce off a band back to the centre, default), 'revert_trend' (bounce only in the direction
// of the channel's trend), 'breakout' (trade in the direction of a fresh close beyond a band). S.longOnly skips shorts.
export const STRATEGIES = { revert: 'Отскок от полосы', revert_trend: 'Отскок по тренду', breakout: 'Пробой полосы', switch: 'Переключатель по режиму рынка' };
// 'switch': BTC flat → bounce off a band; BTC trending up → breakout, LONG only; BTC trending down → stay out.
// An unknown regime (BTC's candles did not load) stays out too: no data is not a flat market. Before 2.37 it traded bounces then.
// The backtest always has the regime (BTC is loaded with enough history), so its results do not change
export function modeOf(r, S) {
  const st = S.strategy || 'revert';
  if (st !== 'switch') return st;
  const reg = regimeOf(r.mkt, S);
  return reg === 'up' ? 'breakout_long' : reg === 'flat' ? 'revert' : 'none';
}
// returns 'LONG' / 'SHORT' if this signal is tradable under S, else null
export function wants(r, S) {
  if (!r || r.score == null || r.score < S.minScore) return null;
  let st = modeOf(r, S);
  if (st === 'none') return null;
  // optional market filter for any strategy: only in a flat market / only in an impulse
  const reg = regimeOf(r.mkt, S), only = S.regimeOnly || (S.flatOnly ? 'flat' : 'any');
  if (only === 'flat' && reg !== 'flat') return null;
  if (only === 'impulse' && (reg == null || reg === 'flat')) return null;
  // optional filter on the coin itself: skip bounces on a coin that is trending on its own (ER of the coin ≥ coinErMax)
  if (S.coinErMax && st !== 'breakout' && st !== 'breakout_long' && r.er >= S.coinErMax) return null;
  const longOnly = S.longOnly || st === 'breakout_long';
  if (st === 'breakout_long') st = 'breakout';
  let side = null;
  if (st === 'breakout') side = r.brk ? (r.brk.side === 'long' ? 'LONG' : 'SHORT') : null;
  else if (r.rev) {
    side = r.side === 'low' ? 'LONG' : 'SHORT';
    if (st === 'revert_trend' && !(side === 'LONG' ? r.slope > 0 : r.slope < 0)) side = null;
  }
  if (side === 'SHORT' && longOnly) return null;
  // optional channel-width filter: a wider channel leaves more room for the move back to the centre
  if (side && S.minWidth && !((r.up - r.lo) / r.mid * 100 >= S.minWidth)) return null;
  // optional trend filter for bounces: only coins that revert to the centre fast enough (T½ ≤ maxHL bars)
  if (side && st !== 'breakout' && S.maxHL && !(isFinite(r.hl) && r.hl <= S.maxHL)) return null;
  return side;
}

// what the bot saw at the moment of entry — stored with the trade
export function snapshot(r, S) {
  return { score: r.score, comps: r.comps, checks: r.checks, z: r.z, pB: r.pB, rsi: r.rsi, hl: isFinite(r.hl) ? r.hl : null,
           exc: r.exc, volX: r.volX, volZ: r.volZ, mid: r.mid, up: r.up, lo: r.lo, atr: r.atr,
           slope: r.slope, brk: r.brk, er: r.er, mkt: r.mkt ?? null, regime: regimeOf(r.mkt, S),
           settings: { method: S.method, N: S.N, k: S.k, tf: S.tf, minScore: S.minScore, strategy: S.strategy || 'revert', longOnly: !!S.longOnly, maxHL: S.maxHL || 0,
                       rr: S.rr || 0, risk: S.risk ?? RISK, lev: S.lev ?? 1, minWidth: S.minWidth || 0, erMax: S.erMax ?? 0.15,
                       regimeOnly: S.regimeOnly || (S.flatOnly ? 'flat' : 'any'), regimeSrc: S.regimeSrc || 'btc', coinErMax: S.coinErMax || 0, timeStop: S.timeStop ?? TIME_STOP, maxOpen: slotsOf(S),
                       ...(S.fixedRisk ? { fixedRisk: true } : {}) } };
}

// ---------- trading rules ----------
// entry, stop and take profit for a signal on this side — what planEntry trades, and what a signal message shows for trading
// by hand; null when there is too little left to earn
export function levels(r, S, side = r.side === 'low' ? 'LONG' : 'SHORT') {
  const sg = side === 'LONG' ? 1 : -1, brk = modeOf(r, S).startsWith('breakout');
  const e = r.price * (1 + sg * SLIP);   // market entry pays slippage
  const slD = clamp(1.5 * r.atr / e, 0.008, 0.025);
  // a bounce is a bet on the way back to the centre: when the price has already covered most of it (a wick touched the band
  // and the next candle fell straight to the middle), there is nothing left to earn — skip unless at least minRoom × the stop remains
  const room = sg * (r.mid - e) / e;
  if (!brk && room < (S.minRoom ?? MIN_ROOM) * slD) return null;
  // take profit: S.rr > 0 — fixed reward:risk (TP = rr × stop distance);
  // otherwise bounce → exactly the centre (at most 3%; no artificial floor that would put it past the centre), breakout → 2× the stop (1–5%)
  const tpD = S.rr > 0 ? S.rr * slD : brk ? clamp(2 * slD, 0.01, 0.05) : Math.min(room, 0.03);
  if (!(S.rr > 0) && tpD < 0.8 * slD) return null;
  return { side, sg, brk, e, slD, tpD, sl: e * (1 - sg * slD), tp: e * (1 + sg * tpD) };
}
export function planEntry(r, balance, S, now, start = balance) {
  const side = wants(r, S);
  if (!side) return null;
  const L = levels(r, S, side);
  if (!L) return null;
  const { sg, brk, e, slD, tpD } = L;
  // size: lose S.risk of the money at stake at the stop, but never exceed the leverage cap
  // (S.lev × balance shared by the profile's slots; default 1× and 3 slots → each position ≤ ⅓ of the balance).
  // The money at stake is the balance (compounding: the stop grows and shrinks with it) or, with S.fixedRisk, the starting
  // balance: at 1% of $10 000 every stop is $100 however the balance has moved. The cap stays on the balance: no more can go
  // into a position than there is
  const risk = S.risk ?? RISK, lev = S.lev ?? 1, stake = S.fixedRisk && start > 0 ? start : balance;
  const qty = Math.min(stake * risk / (e * slD), balance * lev / slotsOf(S) / e);
  if (!(qty > 0)) return null;
  const sl = L.sl;
  return { id: now + r.sym, sym: r.sym, side, entry: e, last: e, tp: e * (1 + sg * tpD), sl, qty, time: now, tfms: TFMS[S.tf], ts: S.timeStop ?? TIME_STOP,
           ...(isFinite(r.barHi) && isFinite(r.barLo) ? { bh: r.barHi, bl: r.barLo } : {}),
           risk: Math.abs(e - sl) * qty, snap: { ...snapshot(r, S), lev: e * qty / balance, riskPct: Math.abs(e - sl) * qty / balance * 100 },
           note: `${brk ? (sg > 0 ? 'пробой вверх' : 'пробой вниз') : r.side === 'low' ? 'отскок от низа' : 'откат от верха'} · сила ${r.score}` };
}
// returns {exit, reason} or null; updates p.last
export function checkExit(p, K, now) {
  const sg = p.side === 'LONG' ? 1 : -1;
  const bar0 = Math.floor(p.time / p.tfms) * p.tfms, start = bar0 + p.tfms;   // the bar of the entry; bars fully after it
  for (const k of K) {
    if (k[0] < bar0) continue;
    let hi = +k[2], lo = +k[3];
    // the bar the bot entered on: a bar's high only rises and its low only falls, so whatever goes beyond the range it had at the
    // entry (bh / bl, kept by planEntry) happened after it. Before 2.34 this bar was skipped and a wick to the stop or the take
    // between two checks went unseen; positions without bh / bl still skip it
    if (k[0] < start) {
      if (p.bh == null || p.bl == null) continue;
      hi = hi > p.bh ? hi : -Infinity; lo = lo < p.bl ? lo : Infinity;
    }
    // if one bar touched both levels we assume the stop came first (pessimistic)
    if (p.side === 'LONG' ? lo <= p.sl : hi >= p.sl) return { exit: p.sl * (1 - sg * SLIP), reason: 'стоп' };
    if (p.side === 'LONG' ? hi >= p.tp : lo <= p.tp) return { exit: p.tp, reason: 'тейк' };
  }
  const c = +K[K.length - 1][4]; p.last = c;
  if (p.closeReq) return { exit: c * (1 - sg * SLIP), reason: 'вручную' };   // the owner asked to close it at market
  if (p.side === 'LONG' ? c <= p.sl : c >= p.sl) return { exit: c * (1 - sg * SLIP), reason: 'стоп' };
  if (p.side === 'LONG' ? c >= p.tp : c <= p.tp) return { exit: p.tp, reason: 'тейк' };
  // time stop in bars, set per position at entry (S.timeStop; 0 = off); older positions without it use the default
  const ts = p.ts ?? TIME_STOP;
  if (ts > 0 && now - p.time > ts * p.tfms) return { exit: c * (1 - sg * SLIP), reason: 'тайм-стоп' };
  return null;
}
// borrowed amount of a position (see BORROW_DAY): from what it stored at entry, so positions already open are priced too
// (snap.lev = position / balance at entry, snap.settings.maxOpen = slots); a position without them borrows nothing extra
export function borrowedOf(p) {
  const size = p.entry * p.qty;
  if (p.side === 'SHORT') return size;
  const lev = +p.snap?.lev, slots = +p.snap?.settings?.maxOpen || MAX_OPEN;
  return lev > 0 ? Math.max(0, size - size / lev / slots) : 0;
}
export function closeTrade(p, exit, reason, now) {
  const sg = p.side === 'LONG' ? 1 : -1;
  // fee: the exchange's commission plus the interest on what was borrowed for the time in the trade (fin, shown apart)
  const fin = borrowedOf(p) * BORROW_DAY * Math.max(0, now - p.time) / 864e5;
  const gross = sg * (exit - p.entry) * p.qty, fee = (p.entry + exit) * p.qty * FEE + fin, pnl = gross - fee;
  const risk = p.risk || Math.abs(p.entry - p.sl) * p.qty;
  return { id: p.id, sym: p.sym, side: p.side, entry: p.entry, exit, tp: p.tp, sl: p.sl, qty: p.qty, time: p.time, tclose: now,
           reason, fee, fin, gross, pnl, r: risk ? pnl / risk : null, note: p.note, snap: p.snap ?? null };
}
// one bot step: manage exits, then open new positions. Pure — the caller persists the result.
// start: the starting balance, the stake of S.fixedRisk (without it the stake is the balance, see planEntry)
export function botTick({ rows, klines, open, recentSyms, balance, S, now, allowEntries = true, market, start }) {
  const closed = [], stillOpen = [];
  for (const p of open) {
    const K = klines[p.sym];
    const x = K ? checkExit(p, K, now) : null;
    if (!x) { stillOpen.push(p); continue; }
    const t = closeTrade(p, x.exit, x.reason, now);
    balance += t.pnl; closed.push(t);
  }
  const opened = [];
  if (allowEntries) {
    // market regime for every signal: passed in by the caller (marketOn on the profile's timeframe), or else from the BTC/ETH/SOL
    // rows — at their last closed bar, as the backtest and the entries themselves (tradeRow)
    const mkt = market !== undefined ? market : marketOf(s => { const x = tradeRow(rows.find(r => r.sym === s)); return x ? { er: x.er, ch: x.erCh } : null; });
    for (const r of rows) r.mkt = mkt;
    const cool = new Set([...recentSyms, ...closed.map(x => x.sym)]);
    // entries are decided on the last closed bar, like the backtest (see analyze, tradeRow)
    const cands = rows.map(tradeRow).filter(r => r && wants(r, S) && !stillOpen.some(p => p.sym === r.sym) && !cool.has(r.sym)).sort((a, b) => b.score - a.score);
    for (const r of cands) {
      if (stillOpen.length + opened.length >= slotsOf(S)) break;
      const p = planEntry(r, balance, S, now, start);
      if (p) opened.push(p);
    }
  }
  return { closed, stillOpen, opened, balance };
}
export function pickSymbols(ticker, top, extra, now) {
  const list = ticker.filter(x => x.symbol.endsWith('USDT') && !STABLE.has(x.symbol.slice(0, -4)) && +x.quoteVolume > 0 && x.closeTime > now - 864e5)
    .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, top).map(x => x.symbol);
  for (const s of extra) if (!list.includes(s)) list.push(s);
  return list;
}

// ---------- journal statistics ----------
// fills fields missing in trades recorded before fees/R were stored separately
export function normTrade(x) {
  const fee = x.fee ?? (x.entry + x.exit) * x.qty * FEE;
  const reason = x.reason ?? String(x.note || '').split(' · ')[0];
  const risk = Math.abs(x.entry - x.sl) * x.qty;
  return { ...x, fee, gross: x.gross ?? x.pnl + fee, reason, r: x.r ?? (risk ? x.pnl / risk : null), size: x.entry * x.qty, hold: x.tclose - x.time };
}
export function journalStats(start, closed) {
  const cl = closed.map(normTrade), n = cl.length;
  const wins = cl.filter(x => x.pnl > 0), losses = cl.filter(x => x.pnl <= 0);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const gw = sum(wins, x => x.pnl), gl = -sum(losses, x => x.pnl);
  const rs = cl.map(x => x.r).filter(x => x != null && isFinite(x));
  // max drawdown of net equity, chronological
  let eq = start, peak = start, dd = 0;
  for (const x of [...cl].sort((a, b) => a.tclose - b.tclose)) { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return {
    n, win: wins.length, loss: losses.length, wr: n ? wins.length / n * 100 : null,
    gross: sum(cl, x => x.gross), fees: sum(cl, x => x.fee), net: sum(cl, x => x.pnl),
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    expR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    pf: gl ? gw / gl : null, maxDD: dd * 100, avgHold: n ? sum(cl, x => x.hold) / n : null,
    pnl24: sum(cl.filter(x => now() - x.tclose < 864e5), x => x.pnl),
    // how much of the risk the fee takes per trade, and the average position size relative to the balance
    feeR: n ? sum(cl, x => { const rk = Math.abs(x.entry - x.sl) * x.qty; return rk ? x.fee / rk : 0; }) / n : null,
    lev: (() => { const l = cl.map(x => x.snap?.lev).filter(v => v > 0); return l.length ? l.reduce((a, b) => a + b, 0) / l.length : null; })(),
  };
}
const now = () => Date.now();

// ---------- backtest ----------
// ---------- study ideas: popular rules shown in the backtest only (docs/PLAN-UNTANGLE-backtest.md) ----------
// They are not in STRATEGIES on purpose: profiles and the bot (cleanProfile on the site, oneOf in bot/index.ts) accept only
// STRATEGIES, so a study idea can never be traded. wants / planEntry / botTick / checkExit don't know them; backtest() and
// randomSetup() do. Every level is known at the close of the bar it is used on — tests/backtest-audit.js cut() checks it.
export const STUDY = { fib: 'Откат по Фибоначчи', smc_ob: 'SMC: ордер-блок', smc_fvg: 'SMC: разрыв (FVG)' };
export const isStudy = S => !!STUDY[S?.strategy];
export const FIB_ZONES = { '0.382': [0.382, 0.5], '0.5': [0.5, 0.618], '0.618': [0.618, 0.705] };
// the study settings with their defaults (the ones the research checked: docs/RESEARCH-2026-10.md 29.10, docs/RESEARCH-SMC.md)
export function studyOf(S) {
  const st = S.strategy;
  if (st === 'fib') return { fibK: [2, 3, 4, 5].includes(+S.fibK) ? +S.fibK : 3, fibZone: FIB_ZONES[S.fibZone] ? S.fibZone : '0.5',
    fibStop: [0.786, 0.886, 1].includes(+S.fibStop) ? +S.fibStop : 0.786, fibTarget: +S.fibTarget === 1.272 ? 1.272 : 0 };
  if (st === 'smc_ob') return { obEntry: S.obEntry === 'zone' ? 'zone' : 'bounce', obSwing: [5, 10, 20].includes(+S.obSwing) ? +S.obSwing : 10 };
  if (st === 'smc_fvg') return { fvgMin: [0, 0.5, 1].includes(+S.fvgMin) ? +S.fvgMin : 0.5, fvgLife: [24, 48, 96].includes(+S.fvgLife) ? +S.fvgLife : 48 };
  return {};
}
// ZigZag swing points with a threshold of k × ATR at the bar (research/fib.js): {dir: 1 a high / −1 a low, p: its price,
// i: its bar, c: the bar whose close confirms it, x: the furthest price reached away from it by then}
export function zigzag(h, l, a, k) {
  const n = h.length, sw = [];
  let dir = 1, ext = h[0], ei = 0, opp = Infinity, oi = 0;
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
// Fibonacci pullbacks (research/fib.js): after an impulse (a swing low then a swing high for a long, known when the high is
// confirmed), the close of the first bar that meets the zone; none if the price reached the stop level first or in that bar,
// went past the impulse's end, or the next swing was confirmed. Stop at the stop level, target the impulse's end (or 1.272)
export function fibEvents(Q, S) {
  const { fibK, fibZone, fibStop, fibTarget } = studyOf(S), [z0, z1] = FIB_ZONES[fibZone], tr = fibTarget ? 1 - fibTarget : 0;
  const { h, l, c, A } = Q, n = c.length, sw = zigzag(h, l, A, fibK), out = [];
  for (let q = 1; q < sw.length; q++) {
    const a = sw[q - 1], b = sw[q], sg = b.dir, E = b.p, D = sg * (E - a.p), until = q + 1 < sw.length ? sw[q + 1].c : n - 1;
    if (!(D > 0)) continue;
    const rr = p => sg * (E - p) / D, px = r => E - sg * r * D;
    if (rr(b.x) >= fibStop) continue;   // past the stop level before the impulse was known
    for (let j = b.c; j <= until; j++) {
      const deep = rr(sg > 0 ? l[j] : h[j]), near = rr(sg > 0 ? h[j] : l[j]);
      if (deep >= fibStop || near < 0) break;
      if (near <= z1 && deep >= z0) {
        out.push({ i: j, side: sg > 0 ? 'LONG' : 'SHORT', sl: px(fibStop), tp: px(tr), info: { kind: 'fib', from: a.p, to: E, known: b.c },
                   note: `откат ${fibZone}–${z1} импульса` });
        break;
      }
    }
  }
  return out;
}
// SMC order blocks (research/smc_check.js): swing points are the extreme of L bars on each side, known L bars later; a close
// beyond the last swing against the trend is a break of structure; the block is the extreme candle before the break. It exists
// from the break bar on (made) — counting it from its own candle was the look-ahead of the first round (docs/RESEARCH-SMC.md) —
// and lives until a close beyond its far edge (end, −1 while alive)
export function obBlocks(Q, L = 10) {
  const { h, l, c } = Q, n = c.length, obs = [], live = [];
  let ph = { p: -Infinity, i: -1 }, pl = { p: Infinity, i: -1 }, trend = 0;
  for (let i = 2 * L; i < n; i++) {
    const m = i - L;
    let hi = true, lo = true;
    for (let j = m - L; j <= i; j++) { if (h[j] > h[m]) hi = false; if (l[j] < l[m]) lo = false; }
    if (hi) ph = { p: h[m], i: m };
    if (lo) pl = { p: l[m], i: m };
    for (let q = live.length - 1; q >= 0; q--) {   // a block made before this bar dies on a close beyond its far edge
      const ob = live[q];
      if (ob.side === 'LONG' ? c[i] < ob.bot : c[i] > ob.top) { ob.end = i; live.splice(q, 1); }
    }
    if (ph.i !== -1 && pl.i !== -1) {
      let ob = null;
      if (c[i] > ph.p && trend !== 1) { trend = 1; let o = pl.i; for (let j = pl.i; j <= i; j++) if (l[j] < l[o]) o = j; ob = { top: h[o], bot: l[o], side: 'LONG', src: o, made: i, end: -1 }; }
      else if (c[i] < pl.p && trend !== -1) { trend = -1; let o = ph.i; for (let j = ph.i; j <= i; j++) if (h[j] > h[o]) o = j; ob = { top: h[o], bot: l[o], side: 'SHORT', src: o, made: i, end: -1 }; }
      if (ob) { obs.push(ob); live.push(ob); }
    }
  }
  return obs;
}
// a live block of this side at bar i within 1 % of the price z (the band the bounce starts from), as smc_check.js «honest»
export const obNear = (obs, i, side, z) => obs.some(ob => ob.made <= i && (ob.end === -1 || ob.end > i) && ob.side === side && ob.top >= z * 0.99 && ob.bot <= z * 1.01);
// the first return into a zone [bot, top] after bar i0 (up to bar i1): a long when the low comes down into it without going
// through its bottom (stop at the bottom), a short mirrored; a bar through the far edge ends the zone without a trade
function zoneEntry(Q, i0, i1, side, bot, top, rr, info, note) {
  const { h, l } = Q, L = side === 'LONG';
  for (let j = i0 + 1; j <= Math.min(i1, Q.c.length - 1); j++) {
    if (!(L ? l[j] <= top : h[j] >= bot)) continue;
    if (L ? l[j] <= bot : h[j] >= top) return null;
    const sl = L ? bot : top, e = Q.c[j], d = Math.abs(e - sl);
    return { i: j, side, sl, tp: e + (L ? 1 : -1) * rr * d, info, note };
  }
  return null;
}
// entries at the return into a block, from the bar after its break on, while it lives; stop beyond the block, take rr × the stop
export function obEvents(Q, S, obs = obBlocks(Q, studyOf(S).obSwing)) {
  const rr = S.rr > 0 ? S.rr : 2, out = [];
  for (const ob of obs) {
    const x = zoneEntry(Q, ob.made, ob.end === -1 ? Infinity : ob.end, ob.side, ob.bot, ob.top, rr, { kind: 'ob', top: ob.top, bot: ob.bot, known: ob.made }, 'возврат в ордер-блок');
    if (x) out.push(x);
  }
  return out;
}
// fair value gaps: the gap between the high of bar i−2 and the low of bar i (a bullish one), known at the close of bar i, at
// least fvgMin × ATR; a long at the first return into it within fvgLife bars, stop beyond its far edge; a bearish one mirrored
export function fvgEvents(Q, S) {
  const { fvgMin, fvgLife } = studyOf(S), rr = S.rr > 0 ? S.rr : 2, { h, l, A } = Q, out = [];
  for (let i = 2; i < Q.c.length; i++) {
    const min = fvgMin * (A[i] || 0);
    if (l[i] > h[i - 2] && l[i] - h[i - 2] >= min && l[i] - h[i - 2] > 0) {
      const x = zoneEntry(Q, i, i + fvgLife, 'LONG', h[i - 2], l[i], rr, { kind: 'fvg', top: l[i], bot: h[i - 2], known: i }, 'возврат в разрыв');
      if (x) out.push(x);
    } else if (h[i] < l[i - 2] && l[i - 2] - h[i] >= min && l[i - 2] - h[i] > 0) {
      const x = zoneEntry(Q, i, i + fvgLife, 'SHORT', h[i], l[i - 2], rr, { kind: 'fvg', top: l[i - 2], bot: h[i], known: i }, 'возврат в разрыв');
      if (x) out.push(x);
    }
  }
  return out;
}
// the entries of a study idea on one coin, by bar: Map bar → [{side, sl, tp, info, note}]; null for the order-block filter of
// the band bounce (its entries are the bounce's, see backtest)
export function studyEvents(Q, S) {
  const st = S.strategy, list = st === 'fib' ? fibEvents(Q, S) : st === 'smc_fvg' ? fvgEvents(Q, S) : st === 'smc_ob' && studyOf(S).obEntry === 'zone' ? obEvents(Q, S) : null;
  if (!list) return null;
  const m = new Map();
  for (const x of list) { const a = m.get(x.i); if (a) a.push(x); else m.set(x.i, [x]); }
  return m;
}
// a study entry at the close of its bar: market in (+ slippage), sized as planEntry sizes (risk of the stake at the stop, the
// leverage cap shared by the slots); null when the stop or the target is not on the right side of the entry
function studyEntry(ev, Q, sym, balance, S, now, start, mkt) {
  const sg = ev.side === 'LONG' ? 1 : -1, e = Q.c[ev.i] * (1 + sg * SLIP), sl = ev.sl, tp = ev.tp;
  if (!(sg * (e - sl) > 0 && sg * (tp - e) > 0)) return null;
  const slD = Math.abs(e - sl) / e, risk = S.risk ?? RISK, lev = S.lev ?? 1, stake = S.fixedRisk && start > 0 ? start : balance;
  const qty = Math.min(stake * risk / (e * slD), balance * lev / slotsOf(S) / e);
  if (!(qty > 0)) return null;
  const snap = snapshot({ mkt }, S);
  snap.score = null; snap.atr = Q.A[ev.i]; snap.study = { ...ev.info, knownT: Q.t[ev.info.known] }; Object.assign(snap.settings, studyOf(S));
  return { id: now + sym, sym, side: ev.side, entry: e, last: e, tp, sl, qty, time: now, tfms: TFMS[S.tf], ts: S.timeStop ?? TIME_STOP,
           risk: Math.abs(e - sl) * qty, snap: { ...snap, lev: e * qty / balance, riskPct: Math.abs(e - sl) * qty / balance * 100 }, note: ev.note };
}
// the filters that apply to a study entry: only LONG and the market regime (as wants)
function studyWants(side, S, mkt) {
  if (side === 'SHORT' && S.longOnly) return false;
  const reg = regimeOf(mkt, S), only = S.regimeOnly || 'any';
  if (only === 'flat' && reg !== 'flat') return false;
  if (only === 'impulse' && (reg == null || reg === 'flat')) return false;
  return true;
}

// hist: {sym: klines[]} (closed bars, same tf, warm-up of at least N+100 bars before `from`).
// Steps bar by bar through time over all pairs with the live rules: a signal is evaluated at the close of a bar,
// entry at that close (+slippage), exits checked on the following bars (stop first if both are hit), time stop, cooldown, slot limit.
// top: trade only the `top` coins with the largest turnover over the previous 24 h at each moment, out of the loaded pool —
// what the live bot does with Binance's 24 h ticker. Today's top applied to the whole past would know which coins later grew.
export function backtest(hist, S, { start = 10000, from = 0, only = null, top = 0 } = {}) {
  const tfms = TFMS[S.tf], P = {}, slots = slotsOf(S);
  // a study idea: its own entries by bar (ev), or for the order-block filter of the bounce the coin's blocks (ob)
  const study = isStudy(S), obFilter = S.strategy === 'smc_ob' && studyOf(S).obEntry === 'bounce';
  for (const [sym, K] of Object.entries(hist)) {
    if (K.length < S.N + 20) continue;
    const Q = prepare(K, S); Q.idx = new Map(Q.t.map((t, i) => [t, i])); P[sym] = Q;
    if (study) { if (obFilter) Q.ob = obBlocks(Q, studyOf(S).obSwing); else Q.ev = studyEvents(Q, S); }
  }
  // BTC/ETH/SOL drive the market regime; they may be loaded only for that (`only` = coins that are actually traded)
  const BTC = P.BTCUSDT, regS = {};
  for (const s of MAJORS) if (P[s]) regS[s] = erSeries(P[s].c, erBars(S.tf));
  const regAt = (s, T) => { const Q = P[s], i = Q ? Q.idx.get(T) : null; return i != null ? regS[s][i] : null; };
  const tradable = only ? Object.keys(P).filter(s => only.includes(s)) : Object.keys(P);
  const times = [...new Set(Object.values(P).flatMap(Q => Q.t))].filter(t => t >= from).sort((a, b) => a - b);
  // running sums of quote turnover (volume × close) per coin, for the 24 h window ending with the bar being decided on.
  // The top is ranked over every loaded coin, also one with fewer than N + 20 candles in all: a coin listed shortly before the
  // end of the period is in the live bot's top from its first candles, and leaving it out made the top depend on how many
  // candles came after (a run cut earlier ranked another coin in its place, 2.107). It is traded only from its bar N + 19
  // (below), so whether it trades never depends on later candles either
  const day = Math.max(1, Math.round(864e5 / tfms)), QV = {};
  const ranked = (only ? Object.keys(hist).filter(s => only.includes(s)) : Object.keys(hist)).filter(s => hist[s]?.length);
  if (top) for (const s of ranked) {
    const K = hist[s], n = K.length, q = new Float64Array(n + 1), ix = P[s]?.idx || new Map(K.map((k, i) => [k[0], i]));
    for (let i = 0; i < n; i++) q[i + 1] = q[i] + +K[i][5] * +K[i][4];
    QV[s] = { q, ix };
  }
  const turnover = (s, T) => { const R = QV[s], i = R.ix.get(T); return i == null ? 0 : R.q[i + 1] - R.q[Math.max(0, i + 1 - day)]; };
  let active = tradable, activeHour = -1;
  let balance = start;
  const open = [], trades = [], equity = [], lastClose = {};
  const close = (p, exit, reason, T) => {
    const t = closeTrade(p, exit, reason, T + tfms - 1);
    balance += t.pnl; trades.push(t); open.splice(open.indexOf(p), 1); lastClose[p.sym] = T;
  };
  for (const T of times) {
    for (const p of [...open]) {
      const Q = P[p.sym], j = Q.idx.get(T), sg = p.side === 'LONG' ? 1 : -1;
      // the time stop counts time, as the bot's does (checkExit), not the coin's own candles. A coin that stops trading (delisted,
      // halted) has no candle at T: its position used to stay open and hold a slot until the end of the test, however long
      // that was. Now it is closed at the coin's last price once its time is up, as the bot closes it
      const late = p.ts > 0 && T - Q.t[p.ei] >= p.ts * tfms;
      if (j == null) { if (late) close(p, Q.c[p.lj ?? p.ei] * (1 - sg * SLIP), 'тайм-стоп', T); continue; }
      if (j <= p.ei) continue;
      p.lj = j;
      if (p.side === 'LONG' ? Q.l[j] <= p.sl : Q.h[j] >= p.sl) close(p, p.sl * (1 - sg * SLIP), 'стоп', T);
      else if (p.side === 'LONG' ? Q.h[j] >= p.tp : Q.l[j] <= p.tp) close(p, p.tp, 'тейк', T);
      else if (late) close(p, Q.c[j] * (1 - sg * SLIP), 'тайм-стоп', T);
    }
    if (top && Math.floor(T / 36e5) !== activeHour) {   // the ranking is refreshed hourly, like a ticker read now and then
      activeHour = Math.floor(T / 36e5);
      active = ranked.map(s => [s, turnover(s, T)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, top).map(x => x[0]);
    }
    if (open.length < slots) {
      const cands = [], mkt = BTC ? marketOf(s => regAt(s, T)) : null;
      for (const sym of active) {
        const Q = P[sym], i = Q?.idx.get(T);   // a coin of the top too short to trade in all (not in P) only holds its place
        // not before the coin's bar N + 19: a coin is traded only with N + 20 candles in all (above), so an entry on a younger bar
        // would depend on the coin still trading later — a cut at that bar drops it (backtest-audit cut(), 2.106 / 2.107)
        if (i == null || i < S.N + 19 || open.some(p => p.sym === sym)) continue;
        if (lastClose[sym] != null && T - lastClose[sym] < COOLDOWN * tfms) continue;
        if (Q.ev) {   // a study idea with entries of its own: no strength, in the order of the top (by turnover)
          for (const ev of Q.ev.get(i) || []) if (studyWants(ev.side, S, mkt)) { cands.push({ sym, i, ev, score: 0 }); break; }
          continue;
        }
        if (study && !Q.ob) continue;
        if (!touchedAt(Q, i)) continue;
        const r = signalAt(Q, i, sym, T + tfms, true);   // bar fully elapsed
        if (r) r.mkt = mkt;
        // the order-block filter: the bounce's own rules, and a live block of the trade's side at the band it bounces from
        if (wants(r, S) && (!Q.ob || obNear(Q.ob, i, r.side === 'low' ? 'LONG' : 'SHORT', r.side === 'low' ? r.lo : r.up))) { r.i = i; cands.push(r); }
      }
      cands.sort((a, b) => b.score - a.score);
      for (const r of cands) {
        if (open.length >= slots) break;
        const p = r.ev ? studyEntry(r.ev, P[r.sym], r.sym, balance, S, T + tfms - 1, start, mkt) : planEntry(r, balance, S, T + tfms - 1, start);
        if (p) { p.ei = r.i; p.id = `${T}${r.sym}`; if (study && !r.ev) Object.assign(p.snap.settings, studyOf(S)); open.push(p); }
      }
    }
    equity.push([T, balance]);
  }
  for (const p of [...open]) { const Q = P[p.sym]; const j = Q.n - 1; close(p, Q.c[j] * (1 - (p.side === 'LONG' ? 1 : -1) * SLIP), 'конец теста', Q.t[j]); }
  return { trades, equity, balance, start, from: times[0], to: times[times.length - 1], pairs: top || tradable.length, pool: tradable.length };
}

// ---------- random entries: can a backtest result be told apart from luck? ----------
// The same coins (at each moment the same top by 24 h turnover as backtest(), refreshed hourly), the same period, as many trades
// as the strategy made and its exits — stop 1.5 ATR within 0.8–2.5 %, the take at the strategy's own take : stop (S.rr, or else
// the ratio of one of its trades drawn at random), the time stop, size by risk and leverage, fee, slippage and borrowing
// (closeTrade) — but the moment, the coin and the side are drawn at random. Random trades are independent: no slots, cooldown or
// compounding (the stake is the start; R does not depend on the balance). run(k) is repeatable: run k of a seed draws the same
// trades whatever order the runs go in, so a caller may count them in chunks. backtest(), botTick and the analysis are untouched.
// Returns null when there is nothing to compare (no trades with R, no coin with candles in the period)
const rngOf = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
export const RANDOM_RUNS = 300;
export function randomSetup(hist, S, trades, { from = 0, only = null, top = 0, start = 10000, seed = 1 } = {}) {
  const rs = trades.map(x => x.r).filter(r => r != null && isFinite(r));
  if (!rs.length) return null;
  const tfms = TFMS[S.tf], slots = slotsOf(S), risk = S.risk ?? RISK, lev = S.lev ?? 1, ts = S.timeStop ?? TIME_STOP;
  const ratios = trades.map(x => Math.abs(x.tp - x.entry) / Math.abs(x.entry - x.sl)).filter(x => x > 0 && isFinite(x));
  // a study idea's stops are its levels (0.786 of an impulse, the edge of a block or a gap), not 1.5 ATR: its random trades take
  // the stop distance and the take : stop of one of its own trades, drawn at random. The ideas of STRATEGIES draw as before
  const own = isStudy(S) ? trades.map(x => [Math.abs(x.entry - x.sl) / x.entry, Math.abs(x.tp - x.entry) / Math.abs(x.entry - x.sl)]).filter(([d, k]) => d > 0 && k > 0 && isFinite(d) && isFinite(k)) : null;
  // per coin: plain arrays of the candles and running sums of quote turnover (volume × close, as backtest()); a year of a wide
  // pool is millions of candles, so no Map or Set over them — a bar is found by its distance from the first one (candles come
  // one interval apart; a gap falls back to a binary search)
  const C = {};
  let t0 = Infinity, t1 = -Infinity;
  for (const [sym, K] of Object.entries(hist)) {
    if (!K.length || (only && !only.includes(sym))) continue;
    // as backtest(): every coin holds its place in the top, one with fewer than N + 20 candles in all is never traded (ok)
    const n = K.length, ok = n >= S.N + 20, t = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), q = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const k = K[i]; t[i] = +k[0]; h[i] = +k[2]; l[i] = +k[3]; c[i] = +k[4]; q[i + 1] = q[i] + k[5] * k[4]; }
    C[sym] = { n, ok, t, h, l, c, q, A: atrSeries(h, l, c) };
    if (ok && t[n - 1] >= from) { t1 = Math.max(t1, t[n - 1]); for (let i = 0; i < n; i++) if (t[i] >= from) { t0 = Math.min(t0, t[i]); break; } }
  }
  const syms = Object.keys(C), okSyms = syms.filter(s => C[s].ok);
  if (!(t1 >= t0)) return null;
  const at = (Q, T) => {
    let i = Math.round((T - Q.t[0]) / tfms);
    if (i >= 0 && i < Q.n && Q.t[i] === T) return i;
    let lo = 0, hi = Q.n - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (Q.t[m] === T) return m; if (Q.t[m] < T) lo = m + 1; else hi = m - 1; }
    return -1;
  };
  // the period's bars: one interval apart from the first to the last (a moment no coin has a candle at is drawn again)
  const steps = Math.round((t1 - t0) / tfms) + 1, day = Math.max(1, Math.round(864e5 / tfms)), hours = new Map();
  const turnover = (Q, T) => { const i = at(Q, T); return i < 0 ? 0 : Q.q[i + 1] - Q.q[Math.max(0, i + 1 - day)]; };
  // the coins open to trading at T: the top of the hour, ranked at its first bar that has candles, as backtest() ranks it
  const activeAt = T => {
    if (!top) return okSyms;
    const hr = Math.floor(T / 36e5);
    let a = hours.get(hr);
    if (!a) {
      a = [];
      for (let T0 = Math.max(t0, t0 + Math.ceil((hr * 36e5 - t0) / tfms) * tfms); !a.length && T0 < (hr + 1) * 36e5 && T0 <= t1; T0 += tfms)
        a = syms.map(s => [s, turnover(C[s], T0)]).filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, top).map(x => x[0]);
      hours.set(hr, a);
    }
    return a;
  };
  const one = R => {
    let Q = null, i = null, T = 0, sym = '';
    for (let tries = 0; tries < 200 && i == null; tries++) {
      T = t0 + Math.floor(R() * steps) * tfms;
      const a = activeAt(T);
      if (!a.length) continue;
      for (let k = 0; k < 20; k++) { const s = a[Math.floor(R() * a.length)], q = C[s], j = at(q, T); if (q.ok && j >= S.N + 19 && isFinite(q.A[j])) { Q = q; i = j; sym = s; break; } }
    }
    if (i == null) return null;
    const sg = R() < 0.5 ? 1 : -1, e = Q.c[i] * (1 + sg * SLIP), o = own?.length ? own[Math.floor(R() * own.length)] : null;
    const slD = o ? o[0] : clamp(1.5 * Q.A[i] / e, 0.008, 0.025);
    const tpD = (o ? o[1] : S.rr > 0 ? S.rr : ratios.length ? ratios[Math.floor(R() * ratios.length)] : 1) * slD;
    const sl = e * (1 - sg * slD), tp = e * (1 + sg * tpD), qty = Math.min(start * risk / (e * slD), start * lev / slots / e);
    const p = { id: `${T}${sym}`, sym, side: sg > 0 ? 'LONG' : 'SHORT', entry: e, sl, tp, qty, time: T + tfms - 1, risk: Math.abs(e - sl) * qty,
                snap: { lev: e * qty / start, settings: { maxOpen: slots } } };
    let exit = null, reason = '', Tc = 0;
    for (let j = i + 1; j < Q.n && exit == null; j++) {   // stop first if one bar hits both, then the take, then the time
      Tc = Q.t[j];
      if (sg > 0 ? Q.l[j] <= sl : Q.h[j] >= sl) { exit = sl * (1 - sg * SLIP); reason = 'стоп'; }
      else if (sg > 0 ? Q.h[j] >= tp : Q.l[j] <= tp) { exit = tp; reason = 'тейк'; }
      else if (ts > 0 && Q.t[j] - Q.t[i] >= ts * tfms) { exit = Q.c[j] * (1 - sg * SLIP); reason = 'тайм-стоп'; }
    }
    if (exit == null) {   // the coin's candles ran out: its time stop by time (delisted), or else the end of the test
      const due = Q.t[i] + ts * tfms;
      if (ts > 0 && due <= t1) { Tc = t0 + Math.ceil((due - t0) / tfms) * tfms; reason = 'тайм-стоп'; } else { Tc = Q.t[Q.n - 1]; reason = 'конец теста'; }
      exit = Q.c[Q.n - 1] * (1 - sg * SLIP);
    }
    return closeTrade(p, exit, reason, Tc + tfms - 1);
  };
  const n = rs.length;
  return {
    n, ref: rs.reduce((a, b) => a + b, 0) / n,
    // run k: n random trades; their mean R (and the trades themselves with keep)
    run(k, keep = false) {
      const R = rngOf(Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(k + 1, 0x85EBCA77)), out = keep ? [] : null;
      let s = 0, m = 0;
      for (let j = 0; j < n; j++) { const x = one(R); if (!x) continue; s += x.r; m++; if (out) out.push(x); }
      return { mean: m ? s / m : null, n: m, trades: out };
    },
  };
}
// where the strategy's mean R stands among the random runs: pct — the share of runs it beat (a tie counts half), mean — their mean
export function randomRank(ref, means) {
  const ms = means.filter(x => x != null && isFinite(x));
  if (!ms.length) return null;
  let below = 0; for (const m of ms) below += m < ref ? 1 : m === ref ? 0.5 : 0;
  return { pct: below / ms.length * 100, mean: ms.reduce((a, b) => a + b, 0) / ms.length, runs: ms.length };
}
// all at once (tests, scripts); the site counts the runs in chunks between frames
export function randomTest(hist, S, trades, opts = {}) {
  const X = randomSetup(hist, S, trades, opts);
  if (!X) return null;
  const means = [];
  for (let k = 0; k < (opts.runs ?? RANDOM_RUNS); k++) means.push(X.run(k).mean);
  return { ...randomRank(X.ref, means), ref: X.ref, n: X.n };
}

// ---------- order book: walls — one definition for the coin card, «Графики» (beta.js) and the bot (docs/PLAN-WALLS.md) ----------
// A wall is a price bin holding WALL.x times the typical bin's dollars and at least WALL.min, the WALL.n biggest per side,
// within ±WALL.range % of the middle. «Графики» lets each be changed (sr_bcfg: wallX, wallMin, wallN, domRange).
export const WALL = { x: 5, min: 2e4, n: 2, range: 8 };
// a "nice" step ≈ share of the price (1, 2, 2.5 or 5 × 10ⁿ); the book's bins are bookStep(price) ≈ 0.05 % of it
export const niceStep = (p, share) => { const raw = p * share, m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].find(x => x * m >= raw) * m; };
export const bookStep = p => niceStep(p, 0.0005);
// dollars per bin within ±range (a share) of the middle m: {m, step, bid: Map(bin → $), ask}. bids and asks are [price, qty]
// pairs: a Map, or Binance's REST pairs of strings
export function bookBins(bids, asks, m, range, step) {
  const bid = new Map(), ask = new Map();
  for (const [p0, q] of bids) { const p = +p0; if (p >= m * (1 - range)) { const k = Math.round(p / step); bid.set(k, (bid.get(k) || 0) + p * q); } }
  for (const [p0, q] of asks) { const p = +p0; if (p <= m * (1 + range)) { const k = Math.round(p / step); ask.set(k, (ask.get(k) || 0) + p * q); } }
  return { m, step, bid, ask };
}
// how far a snapshot reaches from the middle on its shorter side (a share): 1000 levels of BTC are ~0.2–1 %, of a small coin more
export const bookReach = (bids, asks, m) => Math.min(m / +bids[bids.length - 1][0] - 1, +asks[asks.length - 1][0] / m - 1);
// dollars resting within each share of the middle, per side: {bid: [...], ask: [...]} in the order of shares (beyond the reach
// a sum is only what the snapshot holds)
export function bookSums(bids, asks, m, shares) {
  const side = (L, inside) => shares.map((s) => { let v = 0; for (const [p0, q] of L) { const p = +p0; if (inside(p, s)) v += p * q; } return v; });
  return { bid: side(bids, (p, s) => p >= m * (1 - s)), ask: side(asks, (p, s) => p <= m * (1 + s)) };
}
// the typical bin of both sides (the upper middle one, as «Графики» have always taken it)
export const binMedian = bk => { const a = [...bk.bid.values(), ...bk.ask.values()].sort((x, y) => x - y); return a[a.length >> 1] || 0; };
// the walls, biggest first on each side: [{price, usd, side: 'ask' | 'bid'}]. med: the typical bin, when it must not count
// bins added to bk afterwards («Графики» add the server's far book)
export function wallsOf(bk, med = binMedian(bk), { x = WALL.x, min = WALL.min, n = WALL.n } = {}) {
  const pick = (m, side) => [...m].filter(([, v]) => v >= med * x && v >= min).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ price: k * bk.step, usd: v, side }));
  return [...pick(bk.ask, 'ask'), ...pick(bk.bid, 'bid')];
}
