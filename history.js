// Stored candle history (docs/PLAN-HISTORY.md): a copy of Binance's public candles in Cloudflare R2, one gzip-JSON file per
// coin / timeframe / UTC month, written every night by .github/workflows/history.yml (scripts/history-job.js).
// Read by the site's backtest (fetchHistory) and the research scripts (research/stage05.js klines / pools): stored months from
// R2, the tail after the last stored candle from Binance through the caller's own loader (the old path), which also takes over
// whole whenever anything about the stored part doesn't check out. No dependencies: runs in browsers and in Node 22 (the job).
//
// Rows are [openTime, open, high, low, close, volume, quoteVolume] — numbers, as research/stage05.js klines() returns them.
// A JSON number restores the double that `+string` gave bit for bit, so stored rows equal freshly downloaded ones.

export const FMT = 1;   // format version: in every file and in index.json; another version means "not for this reader"
export const BASE = 'https://pub-edb3115ccf904c00bd02f3372a9cb8d9.r2.dev';
export const TFS = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
export const DAY = 864e5;
const COLS = ['o', 'h', 'l', 'c', 'vo', 'q'];

// ---------- months (UTC, 'YYYY-MM': compared as strings) ----------
export const monthOf = t => new Date(t).toISOString().slice(0, 7);
export const monthStart = m => Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1);
export const nextMonth = m => monthOf(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1));
export function monthsBetween(a, b) { const out = []; for (let m = a; m <= b; m = nextMonth(m)) out.push(m); return out; }
export const fileKey = (tf, sym, m) => tf === '1d' ? `v${FMT}/1d/${m}.json.gz` : `v${FMT}/${tf}/${sym}/${m}.json.gz`;

// ---------- files ----------
// one series' rows of one month → columns; t = offsets from the month's start in candles; p = open time of the series' candle
// before this month as the writer saw it at Binance (null: none) — a gap where two months meet is accepted only if p says so
export function packSeries(rows, tf, m, p) {
  const t0 = monthStart(m), ms = TFS[tf], o = { p: p ?? null, t: rows.map(r => (r[0] - t0) / ms) };
  COLS.forEach((c, j) => { o[c] = rows.map(r => r[j + 1]); });
  return o;
}
export const packMonth = (sym, tf, m, rows, p) => ({ v: FMT, s: sym, tf, m, ...packSeries(rows, tf, m, p) });
// daily candles of every pair in one file per month: {v, tf:'1d', m, s: {SYM: columns}}
export const packDaily = (m, bySym) => ({ v: FMT, tf: '1d', m, s: Object.fromEntries(Object.keys(bySym).sort().map(s => [s, packSeries(bySym[s], '1d', m, null)])) });

// columns → rows, with the strict checks: a broken or foreign file throws (the caller falls back to Binance)
export function unpackSeries(o, tf, m) {
  const ms = TFS[tf], t0 = monthStart(m), cap = Math.round((monthStart(nextMonth(m)) - t0) / ms), n = o?.t?.length;
  if (!n || !COLS.every(c => Array.isArray(o[c]) && o[c].length === n)) throw new Error('history: columns');
  if (o.p != null && !(Number.isInteger(o.p) && o.p < t0 && o.p % ms === 0)) throw new Error('history: p');
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = o.t[i];
    if (!Number.isInteger(k) || k < 0 || k >= cap || (i && k <= o.t[i - 1])) throw new Error('history: time');
    const r = [t0 + k * ms];
    for (const c of COLS) { const v = o[c][i]; if (typeof v !== 'number' || !isFinite(v)) throw new Error('history: value'); r.push(v); }
    rows[i] = r;
  }
  return rows;
}
export function unpackMonth(o, sym, tf, m) {
  if (o?.v !== FMT || o.s !== sym || o.tf !== tf || o.m !== m) throw new Error('history: header');
  return { rows: unpackSeries(o, tf, m), p: o.p };
}

export async function gzip(text) {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}

// every pair that was in the daily top-n by quote volume on some day of [d0, d1), plus `add` (the majors) — the pool of
// research/stage05.js pools(); qv: {SYM: Map(day open time → quote volume)}
// first: a Map filled with the first day each pair made the top (the site's backtest loads a coin from a while before it)
export function topEver(qv, d0, d1, n = 75, add = [], first = null) {
  const syms = Object.keys(qv), inPool = new Set();
  for (let d = d0; d < d1; d += DAY) {
    const day = syms.map(s => [s, qv[s].get(d) || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
    for (const [s] of day) { inPool.add(s); if (first && !first.has(s)) first.set(s, d); }
  }
  for (const s of add) inPool.add(s);
  return [...inPool];
}

// ---------- reading ----------
// fetch: replaceable for a dry run against a store in memory (scripts/history-job.js memStore); off: the stored history is not
// used at all — everything the old way from Binance (the site's ?history=off, to compare a backtest both ways)
const cfg = { base: BASE, cap: 300e6, par: 8, off: false, log: (...a) => console.warn(...a), fetch: (...a) => fetch(...a) };
export function config(o) { Object.assign(cfg, o); idxAt = 0; capAt = 0; }
export const isOff = () => cfg.off;

// index.json: {v, from, updated, s: {SYM: {tf: [first month, last month, last open time, p of the last month, its bytes,
// empty months?]}}, d: {m0, m1, last, rev}, dsyms: [...]}; kept 5 min in memory, a failure is remembered for a minute
let idx = null, idxAt = 0, idxP = null;
export async function index() {
  if (Date.now() - idxAt < (idx ? 3e5 : 6e4)) return idx;
  return idxP ??= (async () => {
    let got = null;
    try {
      const r = await limited(() => cfg.fetch(cfg.base + '/index.json', { cache: 'no-cache', signal: AbortSignal.timeout(10000) }));
      if (r.ok) { const o = await r.json(); if (o?.v === FMT && typeof o.from === 'string' && o.s && typeof o.s === 'object') got = o; }
      if (!got) cfg.log(`history: index.json unusable (HTTP ${r.status}), everything from Binance`);
    } catch (e) { cfg.log(`history: no index.json (${e.message || e}; the page's CSP connect-src must list ${cfg.base}), everything from Binance`); }
    idx = got; idxAt = Date.now(); idxP = null;
    return idx;
  })();
}

// at most cfg.par requests to R2 at a time. r2.dev throttles a busy bucket with 429 (Cloudflare: from "hundreds of requests a
// second"; in a browser it shows as a failed fetch — the 429 has no CORS header): after a failure every request waits a little,
// longer while failures go on, so the throttle passes instead of each coin falling back to Binance whole
let busy = 0, pauseUntil = 0, fails = 0; const waiting = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function limited(fn) {
  if (busy >= cfg.par) await new Promise(r => waiting.push(r));
  busy++;
  try { const w = pauseUntil - Date.now(); if (w > 0) await sleep(w); return await fn(); } finally { busy--; waiting.shift()?.(); }
}
async function getFile(key, fresh) {
  let err;
  for (let a = 0; a < 5; a++) {
    try {
      const r = await limited(() => cfg.fetch(`${cfg.base}/${key}`, { cache: fresh ? (a ? 'reload' : 'no-cache') : 'default', signal: AbortSignal.timeout(20000) }));
      if (r.ok) { fails = 0; return new Uint8Array(await r.arrayBuffer()); }
      err = new Error(`history: HTTP ${r.status} ${key}`);
      if (r.status === 404) break;
    } catch (e) { err = e; }
    fails++; pauseUntil = Math.max(pauseUntil, Date.now() + Math.min(8000, 500 * fails));
    await sleep(1000 * 2 ** a);   // 1, 2, 4, 8 s
  }
  throw err;
}

// one month of a series: the browser's IndexedDB first, then R2. A month before the series' last one never changes and is
// kept until evicted (cached with last = Infinity); the last one is good while its last candle reaches `want` (the index's
// last candle). A copy cached while its month was still the last one is never taken for the finished month
async function loadMonth(sym, tf, m, want) {
  const key = fileKey(tf, sym, m);
  const hit = await cacheGet(key);
  if (hit && (want == null ? hit.last === Infinity : hit.last >= want)) {
    try { return unpackMonth(JSON.parse(await gunzip(hit.buf)), sym, tf, m); } catch { cacheDel(key); }
  }
  for (let a = 0; a < 2; a++) {
    const buf = await getFile(key, want != null || a > 0);
    const f = unpackMonth(JSON.parse(await gunzip(buf)), sym, tf, m), last = f.rows[f.rows.length - 1][0];
    if (want != null && last < want) continue;   // older than the index: a stale copy on the way — once more past caches
    cachePut(key, buf, want == null ? Infinity : last);
    return f;
  }
  throw new Error(`history: ${key} is behind the index`);
}

// candles of [start, end) that have closed by `now`: stored months + Binance before / after them. opt.api(sym, tf, start, end)
// is the caller's Binance loader (rows as above); opt.stop() throws to cut a download short (site backtest)
export async function candles(sym, tf, start, end, opt = {}) {
  const now = opt.now ?? Date.now(), ms = TFS[tf], api = opt.api;
  const keep = rows => rows.filter(r => r[0] >= start && r[0] < end && r[0] + ms <= now);
  const old = async () => keep(await api(sym, tf, start, end));
  let plan = null;
  try { if (ms && tf !== '1d' && !cfg.off) plan = await stored(sym, tf, start, end, opt); }
  catch (e) { opt.stop?.(); cfg.log(`history: ${sym} ${tf} from Binance (${e.message || e})`); plan = null; }
  if (!plan) return old();
  const { head0, rows, top, p0 } = plan;
  // Binance before the stored range (a coin trading before it) and after the last stored candle
  const head = head0 < Math.min(end, plan.lo) ? keep(await api(sym, tf, head0, Math.min(end, plan.lo))) : [];
  opt.stop?.();
  const tail = end > top + ms ? keep(await api(sym, tf, top + ms, end)) : [];
  const out = keep(head.concat(rows, tail));
  // the joins: strictly increasing; Binance's part right before the stored months ends where their first file says it does
  let ok = !head.length || !rows.length || p0 == null || head[head.length - 1][0] === p0;
  for (let i = 1; ok && i < out.length; i++) if (out[i][0] <= out[i - 1][0]) ok = false;
  if (ok) return out;
  cfg.log(`history: ${sym} ${tf} joins don't match, from Binance`);
  return old();
}

// the stored part: rows of [max(start, from), min(end, last + tf)), checked where months meet
async function stored(sym, tf, start, end, opt) {
  const I = await index(), ser = I?.s?.[sym]?.[tf], ms = TFS[tf];
  if (!Array.isArray(ser)) return null;
  const [m0, m1, last, , , empty] = ser, F = monthStart(I.from);
  if (!(typeof m0 === 'string' && typeof m1 === 'string' && Number.isInteger(last) && m0 <= m1)) throw new Error('index entry');
  // before F the series is unknown here: Binance, unless the coin started trading inside the stored range
  const lo = Math.max(start, F), hi = Math.min(end, last + ms), head0 = start < F && m0 === I.from ? start : Infinity;
  if (lo >= hi) return { head0, lo, rows: [], top: Math.max(last, start - ms), p0: null };
  const a = monthOf(lo) > m0 ? monthOf(lo) : m0, b = monthOf(hi - 1) < m1 ? monthOf(hi - 1) : m1;
  const months = a <= b ? monthsBetween(a, b).filter(m => !empty?.includes(m)) : [];
  const files = await Promise.all(months.map(m => { opt.stop?.(); return loadMonth(sym, tf, m, m === m1 ? last : null); }));
  opt.stop?.();
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (i) {   // where two months meet: the second continues from the first's last candle (or from a gap Binance has)
      const prev = files[i - 1].rows, pl = prev[prev.length - 1][0];
      if (f.p !== pl || f.rows[0][0] - pl < ms) throw new Error(`join ${months[i - 1]}/${months[i]}`);
    }
    for (const r of f.rows) rows.push(r);
  }
  // a last month newer than the index (the job wrote it after we read the index): its candles count, the tail starts after them
  const top = files.length && months[months.length - 1] === m1 ? Math.max(last, rows[rows.length - 1][0]) : last;
  return { head0, lo, rows: rows.filter(r => r[0] >= lo && r[0] < end), top, p0: files[0]?.p ?? null };
}

// daily candles of `syms` over [from, to) from the daily files, or null when they don't cover it all (to after the last
// stored day, from before the first) — the caller then loads it the old way. Pairs the files don't know come back missing:
// res.miss lists the asked ones the daily set has never had (load those from Binance)
export async function daily(syms, from, to) {
  try {
    if (cfg.off) return null;
    const I = await index(), d = I?.d;
    if (!d || !Array.isArray(I.dsyms) || from < monthStart(d.m0) || to > d.last + DAY) return null;
    const months = monthsBetween(monthOf(from), monthOf(to - 1));
    const files = await Promise.all(months.map(async m => {
      const key = fileKey('1d', '', m), ck = `${key}@${d.rev ?? 0}`, hit = await cacheGet(ck);
      let buf = hit?.buf;
      if (!buf) { buf = await getFile(key, m === d.m1); if (m !== d.m1) cachePut(ck, buf, Infinity); }
      const o = JSON.parse(await gunzip(buf));
      if (o?.v !== FMT || o.tf !== '1d' || o.m !== m || !o.s) throw new Error('daily header ' + m);
      return o;
    }));
    const known = new Set(I.dsyms), out = {};
    for (const s of syms) {
      if (!known.has(s)) continue;
      const rows = [];
      for (let i = 0; i < files.length; i++) if (files[i].s[s]) for (const r of unpackSeries(files[i].s[s], '1d', months[i])) rows.push(r);
      for (let i = 1; i < rows.length; i++) if (rows[i][0] <= rows[i - 1][0]) throw new Error('daily order ' + s);
      const k = rows.filter(r => r[0] >= from && r[0] < to);
      if (k.length) out[s] = k;
    }
    return { rows: out, miss: syms.filter(s => !known.has(s)) };
  } catch (e) { cfg.log('history: daily from Binance', e.message || e); return null; }
}

// ---------- the browser's cache: IndexedDB «sigma-history», the files' gzip bytes ----------
// data: key → bytes; meta: key → {size, used, last}. Past ~cap bytes the files read longest ago go. Every call is wrapped:
// storage can be missing (Node, private windows) or wiped by the browser at any time (Safari) — then it's just a miss
let dbP = null, total = null;
const touched = new Map(); let touchT = 0;
function db() {
  return dbP ??= new Promise(res => {
    try {
      if (typeof indexedDB === 'undefined') return res(null);
      const r = indexedDB.open('sigma-history', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('data'); r.result.createObjectStore('meta'); };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbP = null; }; d.onclose = () => { dbP = null; }; res(d); };
      r.onerror = r.onblocked = () => res(null);
    } catch { res(null); }
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

async function cacheGet(key) {
  try {
    const d = await db(); if (!d) return null;
    const tx = d.transaction(['data', 'meta']), [buf, meta] = await Promise.all([req(tx.objectStore('data').get(key)), req(tx.objectStore('meta').get(key))]);
    if (!buf || !meta) return null;
    if (Date.now() - meta.used > DAY) { touched.set(key, meta); if (!touchT) touchT = setTimeout(flushTouch, 2000); }
    return { buf: new Uint8Array(buf), last: meta.last };
  } catch { return null; }
}
// a touch updates only a row that is still there: one flushed after a clear or an eviction must not bring it back
async function flushTouch() {
  touchT = 0;
  const list = [...touched]; touched.clear();
  try {
    const d = await db(); if (!d) return;
    const tx = d.transaction('meta', 'readwrite'), st = tx.objectStore('meta');
    for (const [k] of list) { const g = st.get(k); g.onsuccess = () => { if (g.result) st.put({ ...g.result, used: Date.now() }, k); }; }
    await done(tx);
  } catch {}
}
async function sizeNow(d) {
  if (total == null) {
    const tx = d.transaction('meta'), all = await req(tx.objectStore('meta').getAll());
    total = all.reduce((a, m) => a + (m.size || 0), 0);
  }
  return total;
}
// writes are not awaited by the readers; clearCache waits for the ones on the way
const putting = new Set();
function cachePut(key, buf, last) {
  const p = cachePut0(key, buf, last).finally(() => putting.delete(p));
  putting.add(p);
  return p;
}
async function cachePut0(key, buf, last) {
  try {
    const d = await db(); if (!d) return;
    await sizeNow(d);
    const tx = d.transaction(['data', 'meta'], 'readwrite'), meta = tx.objectStore('meta');
    const old = await req(meta.get(key));
    tx.objectStore('data').put(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), key);
    meta.put({ size: buf.byteLength, used: Date.now(), last }, key);
    await done(tx);
    total += buf.byteLength - (old?.size || 0);
    if (total > await capNow()) await evict(d);
  } catch (e) { if (e?.name === 'QuotaExceededError') try { const d = await db(); if (d) await evict(d, 0.5); } catch {} }
}
async function cacheDel(key) {
  try { const d = await db(); if (!d) return; const tx = d.transaction(['data', 'meta'], 'readwrite'); tx.objectStore('data').delete(key); tx.objectStore('meta').delete(key); await done(tx); total = null; } catch {}
}
let capAt = 0, capV = 0;
async function capNow() {
  if (Date.now() - capAt < 6e4) return capV;
  let q = Infinity; try { q = (await navigator.storage.estimate()).quota || Infinity; } catch {}
  capAt = Date.now(); capV = Math.min(cfg.cap, q * 0.3);
  return capV;
}
// drop the files read longest ago until the cache is down to `share` of the cap
let evicting = null;
function evict(d, share = 0.85) {
  return evicting ??= (async () => {
    try {
      const cap = await capNow(), tx = d.transaction('meta'), st = tx.objectStore('meta');
      const [keys, vals] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
      const list = keys.map((k, i) => [k, vals[i]]).sort((a, b) => a[1].used - b[1].used);
      let t = vals.reduce((a, m) => a + (m.size || 0), 0); const del = [];
      for (const [k, m] of list) { if (t <= cap * share) break; del.push(k); t -= m.size || 0; }
      const w = d.transaction(['data', 'meta'], 'readwrite');
      for (const k of del) { w.objectStore('data').delete(k); w.objectStore('meta').delete(k); }
      await done(w); total = t;
    } catch { total = null; }
    evicting = null;
  })();
}
// what the cache holds now (bytes, files) and its clearing — the «Очистить кэш истории» control
export async function cacheStats() {
  try { const d = await db(); if (!d) return null; const n = await req(d.transaction('meta').objectStore('meta').count()); return { bytes: await sizeNow(d), files: n }; } catch { return null; }
}
export async function clearCache() {
  idx = null; idxAt = 0;
  touched.clear(); clearTimeout(touchT); touchT = 0;
  await Promise.allSettled([...putting]);   // the last run's files still on their way to the cache land first, then go
  try { const d = await db(); if (!d) return false; const tx = d.transaction(['data', 'meta'], 'readwrite'); tx.objectStore('data').clear(); tx.objectStore('meta').clear(); await done(tx); total = 0; return true; } catch { return false; }
}
