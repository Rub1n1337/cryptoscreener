// The nightly sync of the stored candle history (docs/PLAN-HISTORY.md, format in history.js). No Node APIs: Node 22 runs it
// through scripts/history-sync.mjs (R2 over the S3 API), and the preview can dry-run it with a store kept in memory:
//   const J = await import('/scripts/history-job.js?' + Date.now()); const mem = new Map();
//   await J.sync({store: J.memStore(mem), only: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], tfs: ['1h', '4h']});
// Each run: daily candles of every USDT pair in the ticker (1 request a pair; the first run takes the whole range) → the pool
// (every pair that was ever in the daily top-75 by quote volume since `from`, delisted ones kept, plus the majors, no stables:
// research/stage05.js pools()) → for each pool coin and timeframe the months from the first candle not stored yet. Past months
// are written once; a file is rewritten only when it gets new candles; the index goes last.
import * as H from '../history.js';
import { STABLE, MAJORS } from '../supabase/functions/_shared/math.js';

// 15m since the first run (09.11): 1h + 4h took ~0.3 GB, 15m adds ~1 GB — far under the free 10 GB
export const DEFAULT_TFS = ['1h', '4h', '15m'];
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api-gcp.binance.com'];
const DAY = H.DAY, POOL_N = 75, SPAN = 3 * 365 + 120;   // three years and the warm-up of a 4h run before them
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IMMUTABLE = 'public, max-age=31536000, immutable', FRESH = 'no-cache';

export function memStore(map) {
  return { async get(k) { return map.has(k) ? map.get(k).body : null; }, async put(k, body, meta) { map.set(k, { body, ...meta }); } };
}

export async function sync({ store, tfs = DEFAULT_TFS, now = Date.now(), log = console.log, deadline = Infinity, only = null, rate = 15, par = 8, checks = 30 }) {
  const st = { started: new Date(now).toISOString(), finished: null, done: false, host: null, hosts: [], tfs, pairs: 0, pool: 0,
    daily: { written: 0, failed: [] }, series: { added: 0, updated: 0, unchanged: 0, nodata: 0, failed: 0, left: 0 },
    files: 0, bytes: 0, requests: 0, pauses: 0, storage: {}, errors: [] };
  const err = (where, e) => { const m = `${where}: ${e?.message || e}`; if (st.errors.length < 50) st.errors.push(m); log('! ' + m); };

  // ---- Binance: the first host that serves klines from here; ≤ `rate` requests a second (weight 2 each: ~30% of the limit)
  let host = null, nextAt = 0;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + '/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2', { signal: AbortSignal.timeout(15000) });
      const ok = r.ok && (await r.json()).length === 2;
      st.hosts.push(`${h} ${r.status}`);
      if (ok) { host = h; break; }
    } catch (e) { st.hosts.push(`${h} ${e.message || e}`); }
  }
  st.host = host;
  if (!host) { err('binance', 'no host serves klines from this runner'); return finish(); }
  async function bget(path) {
    let last;
    for (let a = 0; a < 6; a++) {
      const wait = nextAt - Date.now(); nextAt = Math.max(Date.now(), nextAt) + 1000 / rate;
      if (wait > 0) await sleep(wait);
      try {
        st.requests++;
        const r = await fetch(host + path, { signal: AbortSignal.timeout(30000) });
        if (r.ok) return await r.json();
        if (r.status === 429 || r.status === 418) { st.pauses++; nextAt = Date.now() + (+r.headers.get('retry-after') || 60) * 1000; last = 'HTTP ' + r.status; continue; }
        if (r.status === 400) return [];   // a symbol unknown for the period
        last = 'HTTP ' + r.status;
      } catch (e) { last = e.message || e; }
      await sleep(2000 * (a + 1));
    }
    throw new Error(`${path.split('&')[0]}: ${last}`);
  }
  // closed candles of [from, to), rows as history.js
  async function klines(sym, tf, from, to) {
    const ms = H.TFS[tf], out = [];
    for (let t = from; t < to;) {
      const K = await bget(`/api/v3/klines?symbol=${sym}&interval=${tf}&startTime=${t}&endTime=${to - 1}&limit=1000`);
      if (!K.length) break;
      for (const k of K) if (k[0] + ms <= now) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
      t = K[K.length - 1][0] + ms;
      if (K.length < 1000) break;
    }
    return out;
  }
  async function put(key, obj, cache) {
    const body = await H.gzip(JSON.stringify(obj));
    await store.put(key, body, { type: 'application/gzip', cache });
    st.files++; st.bytes += body.byteLength;
    return body.byteLength;
  }
  async function getJson(key, gz) {
    const b = await store.get(key);
    return b ? JSON.parse(gz ? await H.gunzip(b) : new TextDecoder().decode(b)) : null;
  }
  const saveIndex = async () => {
    idx.updated = new Date().toISOString();
    await store.put('index.json', new TextEncoder().encode(JSON.stringify(idx)), { type: 'application/json', cache: FRESH });
  };
  async function finish() {
    st.finished = new Date().toISOString();
    try { await store.put('status.json', new TextEncoder().encode(JSON.stringify(st, null, 1)), { type: 'application/json', cache: FRESH }); } catch (e) { log('! status: ' + (e.message || e)); }
    return st;
  }

  // ---- the index
  const today = Math.floor(now / DAY) * DAY, lastDay = today - DAY;
  let idx = null;
  try { idx = await getJson('index.json'); } catch (e) { err('index', e); return finish(); }
  if (idx && idx.v !== H.FMT) { err('index', `format ${idx.v}, this job writes ${H.FMT}`); return finish(); }
  idx ??= { v: H.FMT, from: H.monthOf(today - SPAN * DAY), created: new Date(now).toISOString(), s: {}, pool: [], poolDay: null, d: null, dsyms: [], bytes: {} };
  const F = H.monthStart(idx.from);

  // ---- daily candles of the ticker's USDT pairs: known pairs from the first day not stored yet, new pairs from `from`
  const tk = await bget('/api/v3/ticker/24hr').catch(e => { err('ticker', e); return null; });
  if (!tk) return finish();
  let syms = tk.map(x => x.symbol).filter(s => s.endsWith('USDT') && !STABLE.has(s.slice(0, -4)));
  if (only) syms = syms.filter(s => only.includes(s));
  st.pairs = syms.length;
  const known = new Set(idx.dsyms), dFrom = idx.d ? H.monthOf(Math.min(idx.d.last + DAY, lastDay)) : idx.from;
  const got = {};   // sym → rows
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }
  await pool(syms, par, async s => { try { got[s] = await klines(s, '1d', known.has(s) ? H.monthStart(dFrom) : F, today); } catch (e) { st.daily.failed.push(s); } });
  for (const s of st.daily.failed.splice(0)) { try { got[s] = await klines(s, '1d', known.has(s) ? H.monthStart(dFrom) : F, today); } catch (e) { st.daily.failed.push(s); err('daily ' + s, e); } }
  // months to write: from dFrom on, and older ones where a pair new to the set has candles (a relisting); each over its file
  const byMonth = {};
  for (const [s, rows] of Object.entries(got)) for (const r of rows) ((byMonth[H.monthOf(r[0])] ??= {})[s] ??= []).push(r);
  let rev = false;
  try {
    for (const m of [...new Set([...Object.keys(byMonth), ...H.monthsBetween(dFrom, H.monthOf(lastDay))])].sort()) {
      const key = H.fileKey('1d', '', m), raw = await store.get(key), old = raw ? JSON.parse(await H.gunzip(raw)) : null, bySym = {};
      if (old?.s) for (const [s, o] of Object.entries(old.s)) bySym[s] = H.unpackSeries(o, '1d', m);
      Object.assign(bySym, byMonth[m] || {});
      if (!Object.keys(bySym).length) continue;
      const obj = H.packDaily(m, bySym);
      if (old && JSON.stringify(old) === JSON.stringify(obj)) continue;
      if (old && m < dFrom) rev = true;   // a past month changed: readers drop their copies (cached by rev)
      // daily files stay revalidated: a relisted pair can still change a past month (readers cache them by rev, not by HTTP)
      const n = await put(key, obj, FRESH);
      idx.bytes['1d'] = (idx.bytes['1d'] || 0) + n - (raw?.byteLength || 0); st.daily.written++;
    }
    for (const s of Object.keys(got)) known.add(s);
    idx.dsyms = [...known].sort();
    // the daily set counts as stored up to lastDay only if no pair it knows failed tonight
    if (!st.daily.failed.some(s => known.has(s))) idx.d = { m0: idx.from, m1: H.monthOf(lastDay), last: lastDay, rev: (idx.d?.rev || 0) + (rev ? 1 : 0) };
  } catch (e) { err('daily files', e); }

  // ---- the pool: every pair in the daily top-75 of each new day, added to the pool so far
  const qv = {};
  for (const [s, rows] of Object.entries(got)) qv[s] = new Map(rows.map(r => [r[0], r[6]]));
  const p0 = idx.poolDay != null ? idx.poolDay + DAY : F;
  const add = H.topEver(qv, p0, lastDay + DAY, POOL_N, only ? MAJORS.filter(s => only.includes(s)) : MAJORS);
  idx.pool = [...new Set([...idx.pool, ...add])].sort((a, b) => (MAJORS.includes(b) - MAJORS.includes(a)) || (a < b ? -1 : 1));
  if (!st.daily.failed.length) idx.poolDay = lastDay;
  st.pool = idx.pool.length;
  await saveIndex();

  // ---- the series: months from the first candle not stored yet
  async function series(sym, tf) {
    const ms = H.TFS[tf], ser = idx.s[sym]?.[tf];
    let rows, p, prevSize = 0, M;
    if (!ser) {   // the whole range, and the candle right before it as p of the first month
      rows = await klines(sym, tf, F - ms, now);
      p = rows.length && rows[0][0] < F ? rows.shift()[0] : null;
      if (!rows.length) { st.series.nodata++; return; }
      M = H.monthOf(rows[0][0]);
    } else {
      const [, m1, last, p1, size1] = ser;
      M = H.monthOf(last + ms);   // the last month, or the next one on the month's first night
      rows = await klines(sym, tf, H.monthStart(M), now);
      if (!rows.length || rows[rows.length - 1][0] === last) { st.series.unchanged++; return; }
      if (rows[0][0] <= last && M > m1) throw new Error('overlap');
      p = M === m1 ? p1 : last;
      if (M === m1) prevSize = size1 || 0;
    }
    const by = {};
    for (const r of rows) (by[H.monthOf(r[0])] ??= []).push(r);
    const months = H.monthsBetween(M, H.monthOf(rows[rows.length - 1][0])), m1 = months[months.length - 1];
    const empty = [...(ser?.[5] || [])], files = [];
    let p1 = p;
    for (const m of months) {
      const R = by[m];
      if (!R) { if (ser || m > H.monthOf(rows[0][0])) empty.push(m); continue; }
      p1 = p;
      files.push([m, H.packMonth(sym, tf, m, R, p)]);
      p = R[R.length - 1][0];
    }
    const sizes = {};   // six uploads at a time: a backfill writes ~40 files a series
    await pool(files, 6, async ([m, obj]) => { sizes[m] = await put(H.fileKey(tf, sym, m), obj, m === m1 ? FRESH : IMMUTABLE); });
    const size = sizes[m1];
    idx.bytes[tf] = (idx.bytes[tf] || 0) + Object.values(sizes).reduce((a, b) => a + b, 0) - prevSize;
    const e = [ser?.[0] ?? H.monthOf(rows[0][0]), m1, rows[rows.length - 1][0], p1, size];
    if (empty.length) e.push([...new Set(empty)].sort());
    (idx.s[sym] ??= {})[tf] = e;
    st.series[ser ? 'updated' : 'added']++;
  }
  const work = idx.pool.filter(s => !only || only.includes(s));
  let n = 0, saving = null;
  await pool(work, par, async sym => {
    if (Date.now() > deadline) { st.series.left++; return; }
    for (const tf of tfs) { try { await series(sym, tf); } catch (e) { st.series.failed++; err(`${sym} ${tf}`, e); } }
    if (++n % 25 === 0) { await saving; saving = saveIndex().catch(e => err('index', e)); log(`${n}/${work.length} coins, ${st.files} files, ${(st.bytes / 1e6).toFixed(1)} MB`); }
  });
  await saving;
  try { await saveIndex(); } catch (e) { err('index', e); }

  // ---- the spot check: random stored past months downloaded again from Binance must be the same candle for candle.
  // A difference is an error: the run fails and GitHub mails the owner (readers would still be right where joins break,
  // but not where a whole month is wrong in a consistent way)
  st.check = { files: 0, same: 0 };
  const stored = Object.entries(idx.s).flatMap(([s, o]) => Object.entries(o).filter(([tf]) => tfs.includes(tf)).map(([tf, e]) => [s, tf, e]));
  for (let k = 0; k < checks && stored.length && Date.now() < deadline; k++) {
    const [sym, tf, [m0, m1, , , , empty]] = stored[Math.floor(Math.random() * stored.length)];
    const months = H.monthsBetween(m0, m1).filter(m => m < m1 && !empty?.includes(m));
    if (!months.length) continue;
    const m = months[Math.floor(Math.random() * months.length)];
    try {
      const raw = await store.get(H.fileKey(tf, sym, m));
      const mine = raw ? H.unpackMonth(JSON.parse(await H.gunzip(raw)), sym, tf, m).rows : null;
      const theirs = await klines(sym, tf, H.monthStart(m), H.monthStart(H.nextMonth(m)));
      st.check.files++;
      if (JSON.stringify(mine) === JSON.stringify(theirs)) st.check.same++;
      else err(`check ${sym} ${tf} ${m}`, `stored ${mine?.length ?? 'none'} candles, Binance ${theirs.length}, not the same`);
    } catch (e) { err(`check ${sym} ${tf} ${m}`, e); }
  }
  st.storage = { ...idx.bytes };
  st.done = !st.series.left && !st.series.failed && !st.errors.length;
  return finish();
}
