// Single source of truth for the strategy math.
// Used by the site (index.html imports it as an ES module) and by the shared bot (Supabase Edge Function).
// Any change here changes both — the site picks it up on the next Vercel deploy, the bot on the next function deploy.

export const TFMS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5 };
export const STABLE = new Set(['USDC','FDUSD','TUSD','BUSD','DAI','USDP','AEUR','EUR','EURI','USDE','USD1','BFUSD','XUSD','PYUSD','RLUSD','UST','USTC','SUSD']);
export const FEE = 0.00075;   // exchange fee per side (taker, with BNB discount)
export const SLIP = 0.0005;   // slippage on market fills: entry, stop and time-stop exits (TP is a limit order — no slippage)
export const MAX_OPEN = 3;    // max simultaneous positions
export const RISK = 0.02;     // share of balance lost if the stop is hit
export const TIME_STOP = 48;  // bars until a forced market exit
export const COOLDOWN = 4;    // bars before re-entering the same coin

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
  for (let i = N - 1; i < n; i++) {
    const w = c.slice(i - N + 1, i + 1); let mu, s;
    if (m === 'robust') { mu = median(w); s = 1.4826 * median(w.map(x => Math.abs(x - mu))); }
    else { mu = w.reduce((p, x) => p + x, 0) / N; s = Math.sqrt(w.reduce((p, x) => p + (x - mu) ** 2, 0) / N); }
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
// cheap pre-check used by the backtest: any band touch in the last 5 bars?
export function touchedAt(P, i) {
  for (let j = i; j >= i - 4 && j >= 0; j--) if (P.l[j] <= P.B.lo[j] || P.h[j] >= P.B.up[j]) return true;
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
export function analyze(sym, K, S, now = Date.now()) {
  if (K.length < S.N + 10) return null;
  const P = prepare(K, S);
  return signalAt(P, P.n - 1, sym, now);
}
export function signalAt(P, i, sym, now) {
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
  for (let j = i; j >= i - 4; j--) {
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
  let label = '', cls = '', kind = '';
  if (touch && rev) { kind = 'sig'; label = touch.side === 'low' ? '▲ сигнал LONG' : '▼ сигнал SHORT'; cls = touch.side === 'low' ? 'loc' : 'upc'; }
  else if (outUp || outLo) { kind = 'out'; label = outUp ? 'за каналом ↑' : 'за каналом ↓'; cls = outUp ? 'uo' : 'lout'; }
  else if (touch) { kind = 'touch'; label = touch.side === 'low' ? 'касание низа' : 'касание верха'; cls = touch.side === 'low' ? 'lo' : 'up'; }
  else if (squeeze) { kind = 'sq'; label = 'сжатие'; cls = 'sq'; }
  return { sym, price: c[i], pB, z: B.z[i], rsi: r, hl, squeeze, comp, touch, touchTime: touch ? t[touch.j] : null, rev, score, comps, checks, exc, volX, volZ,
           label, cls, kind, mid: B.mid[i], up: B.up[i], lo: B.lo[i], atr: P.A[i], side: touch?.side, slope, brk, er, erCh };
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

// ---------- strategies ----------
// S.strategy: 'revert' (bounce off a band back to the centre, default), 'revert_trend' (bounce only in the direction
// of the channel's trend), 'breakout' (trade in the direction of a fresh close beyond a band). S.longOnly skips shorts.
export const STRATEGIES = { revert: 'Отскок от полосы', revert_trend: 'Отскок по тренду', breakout: 'Пробой полосы', switch: 'Переключатель по режиму рынка' };
// 'switch': BTC flat → bounce off a band; BTC trending up → breakout, LONG only; BTC trending down → stay out
export function modeOf(r, S) {
  const st = S.strategy || 'revert';
  if (st !== 'switch') return st;
  const reg = regimeOf(r.mkt, S);
  return reg === 'up' ? 'breakout_long' : reg === 'down' ? 'none' : 'revert';
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
                       regimeOnly: S.regimeOnly || (S.flatOnly ? 'flat' : 'any'), regimeSrc: S.regimeSrc || 'btc', coinErMax: S.coinErMax || 0 } };
}

// ---------- trading rules ----------
export function planEntry(r, balance, S, now) {
  const side = wants(r, S);
  if (!side) return null;
  const sg = side === 'LONG' ? 1 : -1, brk = modeOf(r, S).startsWith('breakout');
  const e = r.price * (1 + sg * SLIP);   // market entry pays slippage
  const slD = clamp(1.5 * r.atr / e, 0.008, 0.025);
  // take profit: S.rr > 0 — fixed reward:risk (TP = rr × stop distance);
  // otherwise bounce → the centre (1–3%), breakout → 2× the stop (1–5%)
  const tpD = S.rr > 0 ? S.rr * slD : brk ? clamp(2 * slD, 0.01, 0.05) : clamp(Math.abs(r.mid - e) / e, 0.01, 0.03);
  if (!(S.rr > 0) && tpD < 0.8 * slD) return null;
  // size: lose S.risk of the balance at the stop, but never exceed the leverage cap
  // (S.lev × balance shared by MAX_OPEN slots; default 1× → each position ≤ ⅓ of the balance)
  const risk = S.risk ?? RISK, lev = S.lev ?? 1;
  const qty = Math.min(balance * risk / (e * slD), balance * lev / MAX_OPEN / e);
  if (!(qty > 0)) return null;
  const sl = e * (1 - sg * slD);
  return { id: now + r.sym, sym: r.sym, side, entry: e, last: e, tp: e * (1 + sg * tpD), sl, qty, time: now, tfms: TFMS[S.tf],
           risk: Math.abs(e - sl) * qty, snap: { ...snapshot(r, S), lev: e * qty / balance, riskPct: Math.abs(e - sl) * qty / balance * 100 },
           note: `${brk ? (sg > 0 ? 'пробой вверх' : 'пробой вниз') : r.side === 'low' ? 'отскок от низа' : 'откат от верха'} · сила ${r.score}` };
}
// returns {exit, reason} or null; updates p.last
export function checkExit(p, K, now) {
  const sg = p.side === 'LONG' ? 1 : -1;
  const start = Math.floor(p.time / p.tfms) * p.tfms + p.tfms;   // bars fully after the entry
  for (const k of K) {
    if (k[0] < start) continue;
    const hi = +k[2], lo = +k[3];
    // if one bar touched both levels we assume the stop came first (pessimistic)
    if (p.side === 'LONG' ? lo <= p.sl : hi >= p.sl) return { exit: p.sl * (1 - sg * SLIP), reason: 'стоп' };
    if (p.side === 'LONG' ? hi >= p.tp : lo <= p.tp) return { exit: p.tp, reason: 'тейк' };
  }
  const c = +K[K.length - 1][4]; p.last = c;
  if (p.side === 'LONG' ? c <= p.sl : c >= p.sl) return { exit: c * (1 - sg * SLIP), reason: 'стоп' };
  if (p.side === 'LONG' ? c >= p.tp : c <= p.tp) return { exit: p.tp, reason: 'тейк' };
  if (now - p.time > TIME_STOP * p.tfms) return { exit: c * (1 - sg * SLIP), reason: 'тайм-стоп' };
  return null;
}
export function closeTrade(p, exit, reason, now) {
  const sg = p.side === 'LONG' ? 1 : -1;
  const gross = sg * (exit - p.entry) * p.qty, fee = (p.entry + exit) * p.qty * FEE, pnl = gross - fee;
  const risk = p.risk || Math.abs(p.entry - p.sl) * p.qty;
  return { id: p.id, sym: p.sym, side: p.side, entry: p.entry, exit, tp: p.tp, sl: p.sl, qty: p.qty, time: p.time, tclose: now,
           reason, fee, gross, pnl, r: risk ? pnl / risk : null, note: p.note, snap: p.snap ?? null };
}
// one bot step: manage exits, then open new positions. Pure — the caller persists the result.
export function botTick({ rows, klines, open, recentSyms, balance, S, now, allowEntries = true, market }) {
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
    // market regime for every signal comes from the BTC/ETH/SOL rows (or a regime passed in by the caller)
    const mkt = market !== undefined ? market : marketOf(s => { const x = rows.find(r => r.sym === s); return x ? { er: x.er, ch: x.erCh } : null; });
    for (const r of rows) r.mkt = mkt;
    const cool = new Set([...recentSyms, ...closed.map(x => x.sym)]);
    const cands = rows.filter(r => wants(r, S) && !stillOpen.some(p => p.sym === r.sym) && !cool.has(r.sym)).sort((a, b) => b.score - a.score);
    for (const r of cands) {
      if (stillOpen.length + opened.length >= MAX_OPEN) break;
      const p = planEntry(r, balance, S, now);
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
// hist: {sym: klines[]} (closed bars, same tf, warm-up of at least N+100 bars before `from`).
// Steps bar by bar through time over all pairs with the live rules: a signal is evaluated at the close of a bar,
// entry at that close (+slippage), exits checked on the following bars (stop first if both are hit), time stop, cooldown, slot limit.
export function backtest(hist, S, { start = 10000, from = 0, only = null } = {}) {
  const tfms = TFMS[S.tf], P = {};
  for (const [sym, K] of Object.entries(hist)) {
    if (K.length < S.N + 20) continue;
    const Q = prepare(K, S); Q.idx = new Map(Q.t.map((t, i) => [t, i])); P[sym] = Q;
  }
  // BTC/ETH/SOL drive the market regime; they may be loaded only for that (`only` = coins that are actually traded)
  const BTC = P.BTCUSDT, regS = {};
  for (const s of MAJORS) if (P[s]) regS[s] = erSeries(P[s].c, erBars(S.tf));
  const regAt = (s, T) => { const Q = P[s], i = Q ? Q.idx.get(T) : null; return i != null ? regS[s][i] : null; };
  const tradable = only ? Object.keys(P).filter(s => only.includes(s)) : Object.keys(P);
  const times = [...new Set(Object.values(P).flatMap(Q => Q.t))].filter(t => t >= from).sort((a, b) => a - b);
  let balance = start;
  const open = [], trades = [], equity = [], lastClose = {};
  const close = (p, exit, reason, T) => {
    const t = closeTrade(p, exit, reason, T + tfms - 1);
    balance += t.pnl; trades.push(t); open.splice(open.indexOf(p), 1); lastClose[p.sym] = T;
  };
  for (const T of times) {
    for (const p of [...open]) {
      const Q = P[p.sym], j = Q.idx.get(T);
      if (j == null || j <= p.ei) continue;
      const sg = p.side === 'LONG' ? 1 : -1;
      if (p.side === 'LONG' ? Q.l[j] <= p.sl : Q.h[j] >= p.sl) close(p, p.sl * (1 - sg * SLIP), 'стоп', T);
      else if (p.side === 'LONG' ? Q.h[j] >= p.tp : Q.l[j] <= p.tp) close(p, p.tp, 'тейк', T);
      else if (j - p.ei >= TIME_STOP) close(p, Q.c[j] * (1 - sg * SLIP), 'тайм-стоп', T);
    }
    if (open.length < MAX_OPEN) {
      const cands = [], mkt = BTC ? marketOf(s => regAt(s, T)) : null;
      for (const sym of tradable) {
        const Q = P[sym], i = Q.idx.get(T);
        if (i == null || !touchedAt(Q, i) || open.some(p => p.sym === sym)) continue;
        if (lastClose[sym] != null && T - lastClose[sym] < COOLDOWN * tfms) continue;
        const r = signalAt(Q, i, sym, T + tfms);   // bar fully elapsed
        if (r) r.mkt = mkt;
        if (wants(r, S)) { r.i = i; cands.push(r); }
      }
      cands.sort((a, b) => b.score - a.score);
      for (const r of cands) {
        if (open.length >= MAX_OPEN) break;
        const p = planEntry(r, balance, S, T + tfms - 1);
        if (p) { p.ei = r.i; p.id = `${T}${r.sym}`; open.push(p); }
      }
    }
    equity.push([T, balance]);
  }
  for (const p of [...open]) { const Q = P[p.sym]; const j = Q.n - 1; close(p, Q.c[j] * (1 - (p.side === 'LONG' ? 1 : -1) * SLIP), 'конец теста', Q.t[j]); }
  return { trades, equity, balance, start, from: times[0], to: times[times.length - 1], pairs: tradable.length };
}
