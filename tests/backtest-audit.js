// Independent checks of M.backtest on the candles of a real run (window.__sr.btHist, its settings in btHist.S) and a replay
// of the bot (M.botTick) on the same candles — written in the Fable audit, part C (docs/AUDIT-FABLE-C.md).
// Use: run a backtest on the site («Бэктест»), then in the console of that tab:
//   const A = await import('/tests/backtest-audit.js?' + Date.now());
//   await A.recount()   — every trade recounted by code of its own (log / classic channel): bad = [] when all match
//   await A.cut()       — the same run on candles cut at 60 %: sameEntries and sameClosed true = no look-ahead
//   await A.replay()    — the bot's steps on the same candles: entries the backtest has not (steps > 1 needs loadSub)
//   await A.historyChecks() — history.js against tampered bucket files: each ends on Binance's candles (same: true),
//                             except a candle missing inside a month or first in a month — accepted by design (the nightly check)
// which: 'cur' = the working copy of math.js, 'ref' = tests/_ref/math.js
const load = which => import(which === 'ref' ? './_ref/math.js?' + Date.now() : '../supabase/functions/_shared/math.js?' + Date.now());
const FEE = 0.00075, SLIP = 0.0005, BORROW = 0.0003, DAY = 864e5;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1e-12, Math.abs(a), Math.abs(b));

// ---------- 1. every trade recounted with code of its own (log / classic channel) ----------
function ownBands(c, i, N, k, log) {
  let s = 0, q = 0;
  for (let j = i - N + 1; j <= i; j++) { const x = log ? Math.log(c[j]) : c[j]; s += x; q += x * x; }
  const m = s / N, sd = Math.sqrt(Math.max(0, q / N - m * m)), f = log ? Math.exp : x => x;
  return { mid: f(m), up: f(m + k * sd), lo: f(m - k * sd) };
}
function ownAtr(K, i, p = 14) {
  let a = 0;
  for (let j = 1; j <= i; j++) {
    const tr = Math.max(K[j][2] - K[j][3], Math.abs(K[j][2] - K[j - 1][4]), Math.abs(K[j][3] - K[j - 1][4]));
    if (j <= p) { a += tr; if (j === p) a /= p; } else a = (a * (p - 1) + tr) / p;
  }
  return i < p ? a / i : a;
}
const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function recount(which = 'cur', opt = {}) {
  const M = await load(which), H = window.__sr.btHist, S = opt.S || H.S, tfms = M.TFMS[S.tf];
  const res = M.backtest(H.hist, S, { start: S.start, from: H.from, only: H.only, top: H.top });
  const slots = M.slotsOf(S), risk = S.risk ?? 0.02, lev = S.lev ?? 1, ts = S.timeStop ?? 48, log = S.method === 'log';
  const bad = [], sample = [], tr = res.trades, lastT = res.to;
  const idx = {}; for (const [s, K] of Object.entries(H.hist)) idx[s] = new Map(K.map((k, i) => [k[0], i]));
  // 24 h turnover (volume × close) of every pool coin at bar T, from candles up to T only
  // (since 2.107 every loaded coin holds its place in the top, also one too short to trade: fewer than N + 20 candles in all)
  const pool = Object.keys(H.hist).filter(s => H.only.includes(s) && H.hist[s].length), day = Math.round(DAY / tfms);
  const turn = (s, T) => { const i = idx[s].get(T); if (i == null) return 0; let v = 0; for (let j = Math.max(0, i + 1 - day); j <= i; j++) v += H.hist[s][j][5] * H.hist[s][j][4]; return v; };
  const byClose = [...tr].sort((a, b) => a.tclose - b.tclose);
  // the loan at entry (2.110): a SHORT borrows its size; a LONG what the free cash lacks — the balance at entry less the own money
  // (size less loan) of the LONGs open then. Entries on one bar go in an order the trades do not keep, so with another LONG
  // entered on the same bar the loan is checked within the range [without it, with it]; the others' loans are their snap.bor,
  // each checked the same way in its turn
  const balAt = time => { let b = S.start; for (const x of byClose) if (x.reason !== 'конец теста' && x.tclose <= time) b += x.pnl; return b; };
  const loanRange = t => {
    const size = t.entry * t.qty;
    if (t.side === 'SHORT') return [size, size];
    let lo = 0, hi = 0;
    for (const x of tr) if (x !== t && x.side === 'LONG' && x.time <= t.time && x.tclose > t.time) {
      const own = Math.max(0, x.entry * x.qty - (x.snap?.bor ?? 0));
      hi += own; if (x.time < t.time) lo += own;
    }
    const bal = balAt(t.time), of = own => Math.max(0, size - Math.max(0, bal - own));
    return [of(lo), of(hi)];
  };
  for (const t of tr) {
    const K = H.hist[t.sym], T = t.time - tfms + 1, i = idx[t.sym].get(T), sg = t.side === 'LONG' ? 1 : -1, e = [], c = K.map(k => k[4]);
    const say = (what, got, want) => e.push(`${what}: ${got} ≠ ${want}`);
    if (i == null) { bad.push({ id: t.id, e: ['нет свечи входа'] }); continue; }
    // a coin trades only with N + 20 candles in all and from its bar N + 19 (an entry on a younger bar would depend on later candles)
    if (K.length < S.N + 20 || i < S.N + 19) say('молодая монета', `свеча ${i} из ${K.length}`, `≥ ${S.N + 19}`);
    // levels
    const B = log || S.method === 'classic' ? ownBands(c, i, S.N, S.k, log) : null, atr = ownAtr(K, i);
    const entry = K[i][4] * (1 + sg * SLIP), slD = clamp(1.5 * atr / entry, 0.008, 0.025), sl = entry * (1 - sg * slD);
    if (!near(t.entry, entry)) say('вход', t.entry, entry);
    if (!near(t.sl, sl, 1e-7)) say('стоп', t.sl, sl);
    const brk = t.note.startsWith('пробой');
    if (B) {
      const room = sg * (B.mid - entry) / entry, tpD = S.rr > 0 ? S.rr * slD : brk ? clamp(2 * slD, 0.01, 0.05) : Math.min(room, 0.03);
      if (!near(t.tp, entry * (1 + sg * tpD), 1e-7)) say('тейк', t.tp, entry * (1 + sg * tpD));
      if (!brk) {   // the bounce itself: touch within 5 bars, reversal candle, back inside, volume
        const Bp = ownBands(c, i - 1, S.N, S.k, log); let tj = null;
        for (let j = i; j > i - 5 && tj == null; j--) { const Bj = ownBands(c, j, S.N, S.k, log); if (sg > 0 ? K[j][3] <= Bj.lo : K[j][2] >= Bj.up) tj = j; }
        if (tj == null || tj > i - 1) say('касание', tj, '≤ ' + (i - 1));
        if (!(sg > 0 ? K[i - 1][4] > K[i - 1][1] : K[i - 1][4] < K[i - 1][1])) say('свеча разворота', 'нет', 'да');
        if (!(sg > 0 ? K[i - 1][4] > Bp.lo && K[i][4] > B.lo : K[i - 1][4] < Bp.up && K[i][4] < B.up)) say('внутри канала', 'нет', 'да');
        if (tj != null) {
          const base = K.slice(Math.max(0, i - 99), i - 3).map(k => k[5]).filter(x => x > 0).map(Math.log), vm = med(base), mad = 1.4826 * med(base.map(x => Math.abs(x - vm))) || 1;
          let vr = 0; for (let j = tj; j <= i; j++) vr = Math.max(vr, K[j][5]);
          if (!((Math.log(vr) - vm) / mad >= 1)) say('объём', ((Math.log(vr) - vm) / mad).toFixed(2), '≥ 1');
        }
        if (room < 0.8 * slD) say('запас до центра', room / slD, '≥ 0.8');
      }
    }
    // size: balance = start + everything closed by the entry bar (end-of-test closes are booked after the loop)
    let bal = S.start; for (const x of byClose) if (x.reason !== 'конец теста' && x.tclose <= t.time) bal += x.pnl;
    const stake = S.fixedRisk ? S.start : bal, qty = Math.min(stake * risk / (entry * slD), bal * lev / slots / entry);
    if (!near(t.qty, qty, 1e-7)) say('количество', t.qty, qty);
    // exit: the first later bar that reaches the stop (first) or the take, else the close of bar `ts`
    let exit = null, reason = null, tc = null;
    for (let j = i + 1; j < K.length; j++) {
      if (sg > 0 ? K[j][3] <= t.sl : K[j][2] >= t.sl) { exit = t.sl * (1 - sg * SLIP); reason = 'стоп'; }
      else if (sg > 0 ? K[j][2] >= t.tp : K[j][3] <= t.tp) { exit = t.tp; reason = 'тейк'; }
      else if (ts > 0 && j - i >= ts) { exit = K[j][4] * (1 - sg * SLIP); reason = 'тайм-стоп'; }
      if (reason) { tc = K[j][0] + tfms - 1; break; }
    }
    if (!reason) { const j = K.length - 1; exit = K[j][4] * (1 - sg * SLIP); reason = 'конец теста'; tc = K[j][0] + tfms - 1; }
    if (t.reason !== reason) say('причина выхода', t.reason, reason);
    if (!near(t.exit, exit)) say('выход', t.exit, exit);
    if (t.tclose !== tc) say('время выхода', t.tclose, tc);
    // money
    const [blo, bhi] = loanRange(t), tol = 1e-6 * Math.max(1, t.entry * t.qty), got = t.snap?.bor;
    if (!(got >= blo - tol && got <= bhi + tol)) say('заём', got, blo === bhi ? blo : `${blo}…${bhi}`);
    const borrowed = got >= blo - tol && got <= bhi + tol ? got : blo, fin = borrowed * BORROW * (tc - t.time) / DAY;
    const gross = sg * (exit - entry) * qty, fee = (entry + exit) * qty * FEE + fin, pnl = gross - fee, r = pnl / (Math.abs(entry - sl) * qty);
    if (!near(t.pnl, pnl, 1e-6)) say('PnL', t.pnl, pnl);
    if (!near(t.r, r, 1e-6)) say('R', t.r, r);
    // the coin was in the top-N by the 24 h before the entry bar's close
    if (H.top) { const rank = pool.map(s => [s, turn(s, T)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, H.top).map(x => x[0]); if (!rank.includes(t.sym)) say('топ', 'вне топ-' + H.top, 'в топе'); }
    if (e.length) bad.push({ id: t.id, e });
    if (sample.length < (opt.sample ?? 4) && tr.indexOf(t) % Math.max(1, Math.floor(tr.length / (opt.sample ?? 4))) === 0) sample.push({ sym: t.sym, side: t.side, bar: new Date(T).toISOString().slice(0, 16), close: K[i][4], mid: B?.mid, lo: B?.lo, up: B?.up, atr, entry, slD, sl, tp: t.tp, bal, qty, size: entry * qty, borrowed, exitBar: new Date(tc - tfms + 1).toISOString().slice(0, 16), reason, exit, gross, fee, fin, pnl, r, engine: { entry: t.entry, sl: t.sl, tp: t.tp, qty: t.qty, exit: t.exit, pnl: t.pnl, r: t.r, reason: t.reason } });
  }
  // invariants: slots, one position a coin, cooldown, stuck positions
  const inv = { slots: 0, dup: 0, cool: 0, stuck: [] };
  const openAt = (t, x) => x !== t && (x.time < t.time || (x.time === t.time && tr.indexOf(x) < tr.indexOf(t))) && (x.reason === 'конец теста' || x.tclose > t.time);
  for (const t of tr) {
    const o = tr.filter(x => openAt(t, x));
    if (o.length >= slots) inv.slots++;
    if (o.some(x => x.sym === t.sym)) inv.dup++;
    const prev = tr.filter(x => x.sym === t.sym && x.tclose <= t.time && x.reason !== 'конец теста').sort((a, b) => b.tclose - a.tclose)[0];
    if (prev && (t.time - prev.tclose) / tfms < M.COOLDOWN) inv.cool++;
    if (t.reason === 'конец теста' && t.tclose < lastT + tfms - 1) inv.stuck.push({ sym: t.sym, opened: new Date(t.time).toISOString().slice(0, 16), lastBar: new Date(t.tclose).toISOString().slice(0, 16), barsHeld: Math.round((lastT - (t.time - tfms + 1)) / tfms) });
  }
  // metrics, plainly
  const pn = tr.map(x => x.pnl), wins = pn.filter(x => x > 0), loss = pn.filter(x => x <= 0), st = M.journalStats(S.start, tr);
  let eq = S.start, pk = S.start, dd = 0; for (const x of byClose) { eq += x.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); }
  const own = { n: tr.length, wr: wins.length / tr.length * 100, pf: wins.reduce((a, b) => a + b, 0) / -loss.reduce((a, b) => a + b, 0), net: pn.reduce((a, b) => a + b, 0), expR: tr.reduce((a, x) => a + x.r, 0) / tr.length, maxDD: dd * 100 };
  const metricsOk = near(own.wr, st.wr) && near(own.pf, st.pf) && near(own.net, st.net, 1e-7) && near(own.expR, st.expR) && near(own.maxDD, st.maxDD) && near(res.balance, S.start + own.net, 1e-7);
  // drawdown marked to market at every bar's close (open positions at the close, exit costs not counted)
  let mpk = S.start, mdd = 0;
  const ev = res.equity;
  for (const [T, balR] of ev) {
    let u = 0;
    for (const t of tr) { if (!(t.time < T + tfms - 1 && (t.reason === 'конец теста' ? true : t.tclose > T + tfms - 1))) continue; const i = idx[t.sym].get(T); if (i == null) continue; u += (t.side === 'LONG' ? 1 : -1) * (H.hist[t.sym][i][4] - t.entry) * t.qty; }
    const m = balR + u; mpk = Math.max(mpk, m); mdd = Math.max(mdd, (mpk - m) / mpk);
  }
  return { trades: tr.length, bad, inv, own, engine: { wr: st.wr, pf: st.pf, net: st.net, expR: st.expR, maxDD: st.maxDD, balance: res.balance }, metricsOk, ddMarked: mdd * 100, sample };
}

// ---------- 2. no look-ahead: the same run on candles cut at a moment must make the same decisions before it ----------
export async function cut(which = 'cur', share = 0.6, opt = {}) {
  const M = await load(which), H = window.__sr.btHist, S = opt.S || H.S, tfms = M.TFMS[S.tf];
  const full = M.backtest(H.hist, S, { start: S.start, from: H.from, only: H.only, top: H.top });
  const X = Math.floor((H.from + (full.to - H.from) * share) / tfms) * tfms, hist = {};
  for (const [s, K] of Object.entries(H.hist)) hist[s] = K.filter(k => k[0] <= X);
  const part = M.backtest(hist, S, { start: S.start, from: H.from, only: H.only, top: H.top });
  const key = t => [t.id, t.side, t.entry, t.sl, t.tp, t.qty].join('|'), done = t => [key(t), t.exit, t.reason, t.tclose, t.pnl].join('|');
  const a = full.trades.filter(t => t.time <= X + tfms - 1), b = part.trades;
  const entries = a.map(key).sort().join() === b.map(key).sort().join();
  const closedA = a.filter(t => t.tclose <= X + tfms - 1 && t.reason !== 'конец теста'), closedB = b.filter(t => t.reason !== 'конец теста');
  return { cutAt: new Date(X).toISOString(), entriesBefore: a.length, entriesInCut: b.length, sameEntries: entries, sameClosed: closedA.map(done).sort().join() === closedB.map(done).sort().join(), closed: closedA.length };
}

// ---------- 3. the bot on the same candles ----------
// One M.botTick per step, fed as supabase/functions/bot feeds it: 450 candles a coin ending with the forming one, rows from
// M.analyze, the regime from M.marketOn on closed candles, the cooldown from the trades of the last COOLDOWN bars.
// steps: 1 — one step right at each bar's close (the forming bar has only its open); n > 1 — n steps a bar, the forming bar
// built from `sub` candles (rows [t, o, h, l, c, v] of tf / n). The coin list of each step is the backtest's own top.
export async function replay(which = 'cur', opt = {}) {
  const M = await load(which), H = window.__sr.btHist, S = opt.S || H.S, tfms = M.TFMS[S.tf], steps = opt.steps || 1, sub = opt.sub || null, subMs = tfms / steps;
  const bt = M.backtest(H.hist, S, { start: S.start, from: H.from, only: H.only, top: H.top });
  const idx = {}; for (const [s, K] of Object.entries(H.hist)) idx[s] = new Map(K.map((k, i) => [k[0], i]));
  const sidx = {}; if (sub) for (const [s, K] of Object.entries(sub)) sidx[s] = new Map(K.map((k, i) => [k[0], i]));
  const pool = Object.keys(H.hist).filter(s => H.only.includes(s) && H.hist[s].length >= S.N + 20), day = Math.max(1, Math.round(DAY / tfms));
  const QV = {}; for (const s of pool) { const K = H.hist[s], q = new Float64Array(K.length + 1); for (let i = 0; i < K.length; i++) q[i + 1] = q[i] + K[i][5] * K[i][4]; QV[s] = q; }
  const turn = (s, T) => { const i = idx[s].get(T); return i == null ? 0 : QV[s][i + 1] - QV[s][Math.max(0, i + 1 - day)]; };
  const times = [...new Set(Object.values(H.hist).flatMap(K => K.map(k => k[0])))].filter(t => t >= H.from).sort((a, b) => a - b);
  // candles as the bot gets them at `now`: closed ones up to bar T, then the forming bar T + tfms
  const kOf = (s, T, now, k) => {
    const K = H.hist[s], i = idx[s]?.get(T); if (i == null) return null;
    const out = K.slice(Math.max(0, i - 448), i + 1), nx = K[i + 1];
    if (!nx || nx[0] !== T + tfms) return out;   // no next candle (the end, a gap): the bot sees closed candles only
    if (steps === 1 || !sub) { out.push([nx[0], nx[1], nx[1], nx[1], nx[1], 0]); return out; }
    const SK = sub[s], j0 = sidx[s]?.get(T + tfms); if (j0 == null) { out.push([nx[0], nx[1], nx[1], nx[1], nx[1], 0]); return out; }
    if (k === 0) { out.push([nx[0], nx[1], nx[1], nx[1], nx[1], 0]); return out; }
    let o = SK[j0][1], h = -Infinity, l = Infinity, c = o, v = 0;
    for (let j = j0; j < j0 + k && j < SK.length && SK[j][0] < now; j++) { h = Math.max(h, SK[j][2]); l = Math.min(l, SK[j][3]); c = SK[j][4]; v += SK[j][5]; }
    out.push([nx[0], o, h, l, c, v]); return out;
  };
  let balance = S.start, open = [], active = pool, activeHour = -1; const trades = [], stepOf = new Map(), why0 = new Map(); let tick = 0;
  for (const T of times) {
    if (H.top && Math.floor(T / 36e5) !== activeHour) { activeHour = Math.floor(T / 36e5); active = pool.map(s => [s, turn(s, T)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, H.top).map(x => x[0]); }
    for (let k = 0; k < steps; k++) {
      const now = T + tfms + k * subMs + (opt.jitter ? ++tick : 0), KC = new Map(), getK = s => { if (!KC.has(s)) KC.set(s, kOf(s, T, now, k)); return KC.get(s); };
      const rows = []; for (const s of active) { const K = getK(s); if (!K) continue; const r = M.analyze(s, K, S, now, true); if (r) rows.push(r); }
      const klines = {}; for (const p of open) { const K = getK(p.sym); if (K) klines[p.sym] = K; }
      const C = {}; for (const s of M.MAJORS) { const K = getK(s); if (K) C[s] = M.closedCloses(K, S.tf, now); }
      const market = M.marketOn(s => C[s] || null, S.tf) ?? undefined;
      const recent = trades.filter(x => x.tclose > now - M.COOLDOWN * tfms).map(x => x.sym);
      const res = M.botTick({ rows, klines, open, recentSyms: recent, balance, start: S.start, S, now, market });
      for (const p of res.opened) stepOf.set(p.id, k);
      if (k === 0) { const took = new Set(res.opened.map(p => p.sym)), full = res.stillOpen.length + res.opened.length >= M.slotsOf(S); for (const r of rows) { const x = M.tradeRow(r); if (!x || !M.wants(x, S)) continue; why0.set(r.sym + '|' + T, took.has(r.sym) ? 'in' : open.some(p => p.sym === r.sym) ? 'held' : recent.includes(r.sym) || res.closed.some(c => c.sym === r.sym) ? 'cool' : full ? 'slots' : 'levels'); } }
      trades.push(...res.closed); open = [...res.stillOpen, ...res.opened]; balance = res.balance;
    }
  }
  // match by coin and judged bar: the backtest's entry is at that bar's close, the bot's within the next bar
  const kb = t => t.sym + '|' + (t.time - tfms + 1), kbot = t => t.sym + '|' + (Math.floor(t.time / tfms) * tfms - tfms);
  const A = new Map(bt.trades.filter(t => t.reason !== 'конец теста').map(t => [kb(t), t])), all = [...trades, ...open], B = new Map(all.map(t => [kbot(t), t]));
  const both = [...A.keys()].filter(x => B.has(x)), onlyBt = [...A.keys()].filter(x => !B.has(x)), onlyBot = trades.filter(t => !A.has(kbot(t)));
  let sameExit = 0, entryGap = 0; const diff = [];
  for (const x of both) {
    const a = A.get(x), b = B.get(x); entryGap = Math.max(entryGap, Math.abs(b.entry / a.entry - 1));
    if (b.reason === a.reason && Math.floor((b.tclose - 5001) / tfms) === Math.floor((a.tclose) / tfms)) sameExit++; else diff.push({ k: x, bt: [a.reason, new Date(a.tclose).toISOString().slice(5, 16)], bot: [b.reason ?? 'открыта', b.tclose ? new Date(b.tclose).toISOString().slice(5, 16) : null], lv: { side: a.side, e: [a.entry, b.entry], sl: [a.sl, b.sl], tp: [a.tp, b.tp], exit: [a.exit, b.exit], r: [a.r, b.r] } });
  }
  const sumR = L => L.length ? L.reduce((a, t) => a + (t.r ?? 0), 0) / L.length : null;
  return { steps, bt: { n: bt.trades.length, balance: bt.balance, expR: sumR(bt.trades) }, bot: { n: trades.length, open: open.length, balance, expR: sumR(trades) },
    both: both.length, sameExit, entryGapMax: entryGap, onlyBt, onlyBot: onlyBot.map(t => ({ k: kbot(t), step: stepOf.get(t.id) ?? null, why0: why0.get(kbot(t)) ?? 'not wanted', at: new Date(t.time).toISOString().slice(5, 16), r: +(t.r ?? 0).toFixed(2), reason: t.reason })), onlyBotR: sumR(onlyBot), diff: diff.slice(0, 12), diffN: diff.length };
}

// candles of a smaller timeframe for every coin of the run, from Binance through the site's own loader (kept in window.__sub)
export async function loadSub(subTf = '15m', say = () => {}) {
  const H = window.__sr.btHist, api = window.__sr.kit.api, ms = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5 }[subTf], syms = Object.keys(H.hist), out = {}; let i = 0, done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < syms.length) {
      const s = syms[i++], rows = [];
      try {
        for (let t = H.from; t < H.endT;) {
          const K = await api(`/api/v3/klines?symbol=${s}&interval=${subTf}&startTime=${t}&endTime=${H.endT - 1}&limit=1000`);
          if (!K.length) break;
          for (const k of K) rows.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
          t = K[K.length - 1][0] + ms; if (K.length < 1000) break;
        }
        out[s] = rows;
      } catch (e) { out[s] = null; }
      say(++done + '/' + syms.length);
    }
  }));
  return window.__sub = { tf: subTf, ms, rows: out };
}

// ---------- 4. history.js: a stored file that doesn't check out must end in Binance's candles ----------
// Run on a page of this origin with /r2/ passing the bucket through. IndexedDB is switched off for this module copy, so nothing
// tampered can reach the cache.
export async function historyChecks(sym = 'ETHUSDT', tf = '1h', base = null) {
  try { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); } catch {}
  const HS = await import('../history.js?t=' + Date.now()), ms = HS.TFS[tf];
  base ||= location.port === '8765' ? HS.BASE : location.origin + '/r2';   // the bucket answers 8765 itself; elsewhere a /r2/ pass-through
  const end = Math.floor(Date.now() / ms) * ms, start = HS.monthStart(HS.monthOf(end - 70 * 864e5)) + 5 * 864e5;
  let calls = 0;
  const api = async (s, t, a, b) => {
    calls++; const out = [];
    for (let x = a; x < b;) {
      const K = await (await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=${t}&startTime=${x}&endTime=${b - 1}&limit=1000`)).json();
      if (!K.length) break; for (const k of K) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
      x = K[K.length - 1][0] + ms; if (K.length < 1000) break;
    }
    return out;
  };
  const now = Date.now(), B = (await api(sym, tf, start, end)).filter(r => r[0] + ms <= now), same = R => JSON.stringify(R) === JSON.stringify(B);
  const months = HS.monthsBetween(HS.monthOf(start), HS.monthOf(end - 1)), mid = months[1], res = {};
  // edit(key, obj) → obj | null (404); idx(o) → o
  const run = async (name, edit, idxEdit) => {
    const logs = [];
    HS.config({ base, off: false, log: (...a) => logs.push(a.join(' ').slice(0, 90)), fetch: async (url, o) => {
      const key = url.slice(base.length + 1), r = await fetch(url, o);
      if (!r.ok) return r;
      if (key === 'index.json') { const j = await r.json(); const e = idxEdit ? idxEdit(j) : j; return e ? new Response(JSON.stringify(e)) : new Response('', { status: 503 }); }
      if (!edit) return r;
      const obj = JSON.parse(await HS.gunzip(new Uint8Array(await r.arrayBuffer()))), e = edit(key, obj);
      return e ? new Response(await HS.gzip(JSON.stringify(e))) : new Response('', { status: 404 });
    } });
    calls = 0; const t0 = performance.now();
    let R, err = null; try { R = await HS.candles(sym, tf, start, end, { api, now }); } catch (e) { err = String(e.message || e); }
    res[name] = { same: R ? same(R) : false, rows: R?.length, binanceCalls: calls, ms: Math.round(performance.now() - t0), log: logs.slice(0, 2), err };
  };
  const isMid = k => k.endsWith(`/${sym}/${mid}.json.gz`), cut = (o, f) => { const keep = o.t.map((_, i) => f(i, o.t.length)); const n = { ...o }; for (const c of ['t', 'o', 'h', 'l', 'c', 'vo', 'q']) n[c] = o[c].filter((_, i) => keep[i]); return n; };
  await run('как есть');
  await run('нет последней свечи месяца (стык)', (k, o) => isMid(k) ? cut(o, (i, n) => i !== n - 1) : o);
  await run('нет первой свечи следующего месяца', (k, o) => k.endsWith(`/${sym}/${months[2]}.json.gz`) ? cut(o, i => i !== 0) : o);
  await run('время повторяется', (k, o) => isMid(k) ? { ...o, t: o.t.map((x, i) => i === 10 ? o.t[9] : x) } : o);
  await run('чужая монета в файле', (k, o) => isMid(k) ? { ...o, s: 'BTCUSDT' } : o);
  await run('цена не число', (k, o) => isMid(k) ? { ...o, c: o.c.map((x, i) => i === 5 ? null : x) } : o);
  await run('файла нет (404)', (k, o) => isMid(k) ? null : o);
  await run('последний месяц отстаёт от индекса', (k, o) => k.endsWith(`/${sym}/${months[months.length - 1]}.json.gz`) ? cut(o, (i, n) => i < n - 3) : o);
  await run('индекса нет', null, () => null);
  await run('другая версия формата', null, j => ({ ...j, v: 2 }));
  // not caught by the reader (only by the nightly spot check): a candle missing inside a month
  await run('нет свечи в середине месяца', (k, o) => isMid(k) ? cut(o, i => i !== 100) : o);
  return { sym, tf, from: new Date(start).toISOString(), to: new Date(end).toISOString(), binanceRows: B.length, res };
}
