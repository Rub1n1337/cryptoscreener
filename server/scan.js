// Candles and channel analyses for the Supabase bot (POST /scan). The bot function is started fresh every minute, so it can't
// keep candles between runs: it used to download ~450 bars of hundreds of coins each minute. This service keeps them in
// memory, tops them up with the newest 3 bars, and answers with the analyses (math.js, the same file the site and the bot use)
// — a few hundred KB instead of tens of MB of candles. The bot falls back to doing it all itself when this doesn't answer.
const MATH_URL = process.env.MATH_URL || 'https://cryptoscreener-topaz.vercel.app/supabase/functions/_shared/math.js';
const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];
const LIMIT = 450;   // bars kept per coin and timeframe (what the bot's channels need)
const FRESH = 20e3;  // a series refreshed less than this long ago counts as current
// how stale notify-only series may be (the bot marks them lazy): a signal stays enterable for 5 candles
const LAZY = {'5m':0, '15m':0, '1h':3 * 60e3, '4h':5 * 60e3, '1d':15 * 60e3};
const MAX_SERIES = 3000, MAX_SYMS = 600, MAX_TASKS = 40;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[scan]', ...a);

// math.js comes from the site, so a site deploy updates it here too. The bot sends its own copy's fingerprint
// (M.fingerprint: how the math behaves on fixed candles); a mismatch — one side deployed before the other — makes the bot
// compute itself rather than trade on analyses made by different rules
let M = null, mathText = '', mathAt = 0, FP = '';
async function math() {
  if (M && Date.now() - mathAt < 10 * 60e3) return M;
  try {
    const t = await (await fetch(MATH_URL, {signal:AbortSignal.timeout(10e3)})).text();
    if (t !== mathText) { M = await import('data:text/javascript;base64,' + Buffer.from(t).toString('base64')); mathText = t; FP = M.fingerprint?.() || ''; log('math.js loaded, fingerprint', FP); }
    mathAt = Date.now();
  } catch (e) { if (!M) throw e; mathAt = Date.now() - 9 * 60e3; log('math.js reload failed:', e.message); }   // keep the old one, retry in a minute
  return M;
}

// Binance: a deadline per request, and a pause after "too many requests" / a ban instead of asking again
const PAUSE = {};
async function api(path) {
  let err;
  for (const b of BASES) {
    if (Date.now() < (PAUSE[b] || 0)) { err = new Error('paused ' + b); continue; }
    try {
      const r = await fetch(b + path, {signal:AbortSignal.timeout(8e3)});
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status === 418) PAUSE[b] = Date.now() + Math.min(600, Math.max(30, +r.headers.get('retry-after') || 60)) * 1e3;
      err = new Error(`HTTP ${r.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({length:n}, async () => { while (i < items.length) await fn(items[i++]); })); }
const compact = K => K.map(k => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);

// series "SYM|tf" → {K, at: last refresh, used: last asked for, lazy: only ever asked for notifications, an: analyses of this K}
const SER = new Map();
function refresh(key) {
  const s = SER.get(key);
  if (s?.busy) return s.busy;
  const [sym, tf] = key.split('|'), tfms = M.TFMS[tf];
  const job = (async () => {
    if (s?.K.length && Date.now() - s.K[s.K.length - 1][0] < 2 * tfms) {
      const N = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=3`));
      if (N.length && N[0][0] <= s.K[s.K.length - 1][0]) { s.K = s.K.filter(k => k[0] < N[0][0]).concat(N).slice(-LIMIT); s.at = Date.now(); s.an = new Map(); return; }
    }
    const K = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${LIMIT}`));
    SER.set(key, {K, at:Date.now(), used:s?.used || Date.now(), lazy:s?.lazy ?? true, an:new Map()});
  })().finally(() => { const x = SER.get(key); if (x) x.busy = null; });
  if (s) s.busy = job;
  return job;
}
const stale = (s, tf, lazy) => !s?.K.length || Date.now() - s.at > Math.max(FRESH, lazy ? LAZY[tf] || 0 : 0) || Date.now() - s.K[s.K.length - 1][0] >= M.TFMS[tf];

// keep what the bot trades on warm: at ~:50 of each minute the series it asked for in the last 5 minutes are topped up,
// so the request at the top of the minute finds them current; series nobody asked for in 5 minutes are dropped
let warming = false;
setInterval(async () => {
  const sec = new Date().getSeconds();
  if (!M || warming || sec < 48 || sec > 53) return;
  warming = true;
  try {
    const now = Date.now(), keys = [];
    for (const [k, s] of SER) { if (now - s.used > 5 * 60e3) SER.delete(k); else if (!s.lazy && now - s.at > 15e3) keys.push(k); }
    await pool(keys, 10, k => refresh(k).catch(() => {}));
  } finally { warming = false; }
}, 3e3);

// body: {fp, now, tasks:[{tf, method, N, k, syms:[...], lazy}]} → {fp, rows:[{sym: analysis | null}, …] one per task}
export async function scan(body) {
  const m = await math(), t0 = Date.now();
  if (!FP || body?.fp !== FP) return {error:'math mismatch', fp:FP};
  const now = +body.now || Date.now(), tasks = (Array.isArray(body.tasks) ? body.tasks : []).slice(0, MAX_TASKS)
    .filter(t => t && m.TFMS[t.tf] && t.tf !== '1w' && Array.isArray(t.syms))
    .map(t => ({...t, syms:t.syms.slice(0, MAX_SYMS).filter(s => typeof s === 'string' && /^[A-Z0-9]{2,20}USDT$/.test(s))}));
  const want = new Map();   // key → lazy: a series any task needs for trading is kept fresh
  for (const t of tasks) for (const s of t.syms) { const k = s + '|' + t.tf; want.set(k, (want.get(k) ?? true) && !!t.lazy); }
  if (want.size > MAX_SERIES) return {error:'too many series'};
  const todo = [...want].filter(([k, lazy]) => stale(SER.get(k), k.split('|')[1], lazy)).map(([k]) => k);
  await pool(todo, 20, k => refresh(k).catch(() => {}));
  for (const [k, lazy] of want) { const s = SER.get(k); if (s) { s.used = Date.now(); s.lazy = lazy; } }
  const t1 = Date.now(), minute = Math.floor(now / 60e3);
  const rows = tasks.map(t => {
    const out = {}, S = {method:t.method, N:+t.N, k:+t.k, tf:t.tf}, ck = `${S.method}|${S.N}|${S.k}`;
    for (const sym of t.syms) {
      const s = SER.get(sym + '|' + t.tf);
      if (!s?.K.length) { out[sym] = null; continue; }
      // the same candles and settings within a minute give the same answer (volume is projected by `now`): reuse it
      if (s.anMin !== minute) { s.an = new Map(); s.anMin = minute; }
      if (!s.an.has(ck)) s.an.set(ck, m.analyze(sym, s.K, {...S, N:t.tf === '1d' ? Math.max(20, Math.min(S.N, s.K.length - 20)) : S.N}, now, true));
      out[sym] = s.an.get(ck);
    }
    return out;
  });
  return {fp:FP, rows, refreshed:todo.length, series:SER.size, ms:{fetch:t1 - t0, calc:Date.now() - t1}};
}
// non-finite numbers (T½ = ∞) don't survive JSON: they travel as "__Infinity" / "__NaN" and the bot turns them back
export const encode = obj => JSON.stringify(obj, (k, v) => typeof v === 'number' && !Number.isFinite(v) ? '__' + v : v);
