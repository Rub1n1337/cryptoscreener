// Sigma Radar collector: runs around the clock (Railway) and gives the Beta tab what a browser cannot get on its own.
//  - full order books: the REST snapshot covers only the nearest 5000 levels, but the diff stream reports changes on
//    every level, so a book kept for hours knows the far levels too (a browser tab only knows them since it opened)
//  - liquidity heatmap history: the book folded into price bins once every 10 s, kept for a day by the minute
//  - trade clusters (footprint): market buys / sells by price bin, per minute, kept for a day
// Data comes from Binance spot and USDⓈ-M futures market streams; nothing is traded and no keys are needed.
// Every coin exists twice: spot ("BTCUSDT") and futures ("F:BTCUSDT"); the HTTP API picks futures with &mkt=fut.
// Binance refuses connections from US IP addresses: deploy in an EU or Asia region.
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { scan, encode } from './scan.js';

const PORT = +process.env.PORT || 8080;
const TOP = +process.env.TOP || 20;                       // how many of the most traded USDT pairs to follow
const TOP_FUT = +(process.env.TOP_FUT ?? TOP);            // and how many USDT perpetual futures (0 = spot only)
const ONLY = (process.env.SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const KEEP_MIN = +process.env.KEEP_MIN || 1440;           // minutes of heatmap / cluster history per coin
const HEAT_RANGE = 0.12;                                  // heatmap: ±12% around the price (far walls show up too)
const BOOK_RANGE = 0.25;                                  // book served up to ±25% (far levels beyond are dropped)
const REST = {spot:['https://data-api.binance.vision', 'https://api.binance.com'], fut:['https://fapi.binance.com']};
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=';
// futures split their streams: the order book on /public, trades on /market
const WSF_PUB = 'wss://fstream.binance.com/public/stream?streams=', WSF_MKT = 'wss://fstream.binance.com/market/stream?streams=';
const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|USD1|XUSD|PAXG|XAUT|RLUSD|USDE|USDS|PYUSD|EURI|WBTC|WBETH|BFUSD|BNSOL)USDT$/;   // stablecoins, gold and wrapped tokens: no point charting them

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a "nice" price bin ≈ 0.05% of the price, fixed per coin so the history lines up over time
const niceStep = (p, share = 0.0005) => { const raw = p * share, m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].find(x => x * m >= raw) * m; };

async function api(path, mkt = 'spot') {
  let err;
  for (const b of REST[mkt]) {
    try { const r = await fetch(b + path); if (r.ok) return await r.json(); err = new Error(`HTTP ${r.status} ${path}`); if (r.status === 418 || r.status === 429) await sleep(60e3); }
    catch (e) { err = e; }
  }
  throw err;
}

// ---------- disk (a Railway Volume): history and the known book survive restarts ----------
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached; without one everything stays in memory as before.
// Heatmap / cluster minutes are appended as binary records (t, k0, n, values…); the book is saved every 5 minutes.
const DATA = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || '';
const disk = {
  // futures files get ".f" (BTCUSDT.f.heat.bin); liquidations exist on futures only and keep their old name
  file: (c, kind) => path.join(DATA, `${c.sym}${c.mkt === 'fut' && kind !== 'liq' ? '.f' : ''}.${kind}.bin`),
  bookFile: c => path.join(DATA, `${c.sym}${c.mkt === 'fut' ? '.f' : ''}.book.json`),
  kinds: c => c.mkt === 'fut' ? ['heat', 'fp', 'liq'] : ['heat', 'fp'],
  encode(kind, r) {
    const arrs = kind === 'heat' ? [r.v] : [r.buy, r.sell], n = arrs[0].length, b = Buffer.alloc(16 + arrs.length * n * 4);
    b.writeDoubleLE(r.t, 0); b.writeInt32LE(r.k0, 8); b.writeInt32LE(n, 12);
    arrs.forEach((a, j) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(b, 16 + j * n * 4));
    return b;
  },
  decode(kind, buf) {
    const out = [], parts = kind === 'heat' ? 1 : 2;
    for (let o = 0; o + 16 <= buf.length;) {
      const t = buf.readDoubleLE(o), k0 = buf.readInt32LE(o + 8), n = buf.readInt32LE(o + 12), end = o + 16 + parts * n * 4;
      if (n < 0 || end > buf.length) break;   // a record cut short by a crash: stop there
      const arr = j => new Float32Array(buf.buffer.slice(buf.byteOffset + o + 16 + j * n * 4, buf.byteOffset + o + 16 + (j + 1) * n * 4));
      out.push(kind === 'heat' ? {t, k0, v:arr(0)} : {t, k0, buy:arr(0), sell:arr(1)}); o = end;
    }
    return out;
  },
  append(c, kind, r) { if (!DATA) return; try { fs.appendFileSync(this.file(c, kind), this.encode(kind, r)); } catch (e) { log('disk append failed:', e.message); } },
  load(c) {
    if (!DATA) return;
    try { fs.mkdirSync(DATA, {recursive:true}); } catch {}
    const since = Date.now() - KEEP_MIN * 6e4;
    for (const kind of this.kinds(c)) {
      try { c[kind] = this.decode(kind, fs.readFileSync(this.file(c, kind))).filter(r => r.t >= since).slice(-KEEP_MIN); } catch {}
    }
    try {   // the far levels learned before the restart; the snapshot taken after it refreshes the near ones
      const b = JSON.parse(fs.readFileSync(this.bookFile(c), 'utf8'));
      if (Date.now() - b.t < 6 * 3600e3) { c.base = b.base; c.book = {bids:new Map(b.bids), asks:new Map(b.asks), id:0, ok:false, live:false}; }
    } catch {}
    if (c.heat.length || c.book) log(c.id, 'restored:', c.heat.length, 'heat min,', c.fp.length, 'cluster min,', c.book ? c.book.bids.size + c.book.asks.size : 0, 'levels');
  },
  saveBook(c) {
    if (!DATA || !c.book?.live) return;
    const tmp = this.bookFile(c) + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({t:Date.now(), base:c.base, bids:[...c.book.bids], asks:[...c.book.asks]})); fs.renameSync(tmp, this.bookFile(c)); }
    catch (e) { log('book save failed:', e.message); }
  },
  compact(c) {   // the append-only files are rewritten with just the kept minutes
    if (!DATA) return;
    for (const kind of this.kinds(c)) {
      const tmp = this.file(c, kind) + '.tmp';
      try { fs.writeFileSync(tmp, Buffer.concat(c[kind].map(r => this.encode(kind, r)))); fs.renameSync(tmp, this.file(c, kind)); } catch (e) { log('compact failed:', e.message); }
    }
  },
};
// what is on the volume (for /health): the folder and the size of the saved files
function diskInfo() { if (!DATA) return null; try { const fl = fs.readdirSync(DATA); return {path:DATA, files:fl.length, mb:+(fl.reduce((s, x) => s + fs.statSync(path.join(DATA, x)).size, 0) / 1048576).toFixed(1)}; } catch (e) { return {path:DATA, error:e.message}; } }

// ---------- coins ----------
const coins = new Map();   // id ("BTCUSDT" spot, "F:BTCUSDT" futures) -> state
const cid = (sym, mkt) => mkt === 'fut' ? 'F:' + sym : sym;
function coin(sym, mkt = 'spot') {
  return {sym, mkt, id:cid(sym, mkt), base:0, book:null, buffer:[], syncing:false, fails:0, last:0,
    heat:[], heatCur:null,            // heat: [{t, k0, v:Float32Array}] one per minute; heatCur: Map bin -> max $ in the current minute
    fp:[], fpCur:null, fpT:0,         // fp: [{t, k0, buy:Float32Array, sell:Float32Array}]; fpCur: Map bin -> [buy $, sell $]
    liq:[], liqCur:null, liqT:0};     // futures liquidations by price bin per minute: buy = shorts closed by force, sell = longs
}
async function pickSymbols() {
  if (ONLY.length) return ONLY;
  const t = await api('/api/v3/ticker/24hr');
  return t.filter(x => x.symbol.endsWith('USDT') && !STABLE.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP).map(x => x.symbol);
}
// futures: the most traded USDT perpetuals that are trading now (with SYMBOLS set: the same list, where a perpetual exists)
async function pickFutures() {
  if (!TOP_FUT) return [];
  const info = await api('/fapi/v1/exchangeInfo', 'fut'), perp = new Set(info.symbols.filter(x => x.contractType === 'PERPETUAL' && x.status === 'TRADING' && x.quoteAsset === 'USDT').map(x => x.symbol));
  if (ONLY.length) return ONLY.filter(s => perp.has(s));
  const t = await api('/fapi/v1/ticker/24hr', 'fut');
  return t.filter(x => perp.has(x.symbol) && !STABLE.test(x.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP_FUT).map(x => x.symbol);
}

// ---------- order books: snapshot + diff stream (Binance's procedure) ----------
// snapshots are expensive (spot: weight 250 of 6000 per minute; futures: 20 of 2400): one at a time per market, at least 3 s apart
const gateAt = {spot:0, fut:0};
const snapGate = mkt => { const now = Date.now(), at = Math.max(now, gateAt[mkt]); gateAt[mkt] = at + 3000; return sleep(at - now); };
// spot: each event continues the last one (U = previous u + 1); futures: each event names the previous one (pu = previous u)
function applyDepth(b, ev, fut) {
  if (fut ? ev.u < b.id : ev.u <= b.id) return true;
  if (!b.ok) { if (ev.U > (fut ? b.id : b.id + 1)) return false; b.ok = true; }
  else if (fut ? ev.pu !== b.id : ev.U !== b.id + 1) return false;
  for (const [p, q] of ev.b) +q ? b.bids.set(+p, +q) : b.bids.delete(+p);
  for (const [p, q] of ev.a) +q ? b.asks.set(+p, +q) : b.asks.delete(+p);
  b.id = ev.u; return true;
}
async function resync(c) {
  if (c.syncing) return;
  c.syncing = true;
  try {
    await snapGate(c.mkt);
    // futures give 1000 levels (about ±0.15% for BTC): the rest of their book is learned from the stream over time
    const s = c.mkt === 'fut' ? await api(`/fapi/v1/depth?symbol=${c.sym}&limit=1000`, 'fut') : await api(`/api/v3/depth?symbol=${c.sym}&limit=5000`);
    const minB = +s.bids[s.bids.length - 1][0], maxA = +s.asks[s.asks.length - 1][0];
    const b = {bids:new Map(s.bids.map(([p, q]) => [+p, +q])), asks:new Map(s.asks.map(([p, q]) => [+p, +q])), id:s.lastUpdateId, ok:false, minB, maxA};
    // far levels learned from the stream before this snapshot are still valid: the snapshot just doesn't reach them
    if (c.book) { for (const [p, q] of c.book.bids) if (p < minB) b.bids.set(p, q); for (const [p, q] of c.book.asks) if (p > maxA) b.asks.set(p, q); }
    for (const ev of c.buffer.splice(0)) if (!applyDepth(b, ev, c.mkt === 'fut')) throw new Error('snapshot older than the stream');
    b.live = true; c.book = b; c.fails = 0;
    // the futures twin takes the spot coin's bin, so both histories line up (and liquidations kept from before still fit)
    if (!c.base) c.base = (c.mkt === 'fut' && coins.get(c.sym)?.base) || niceStep((+s.bids[0][0] + +s.asks[0][0]) / 2);
  } catch (e) {
    c.fails++; log(c.id, 'snapshot failed:', e.message); if (c.book) c.book.live = false;
    setTimeout(() => resync(c), Math.min(120e3, 3000 * 2 ** c.fails));
  } finally { c.syncing = false; }
}
function onDepth(c, ev) {
  // until a snapshot is in place (or while a new one is being taken) the diff events wait in the buffer
  if (!c.book?.live || c.syncing) { c.buffer.push(ev); if (c.buffer.length > 5000) c.buffer.shift(); return; }
  if (!applyDepth(c.book, ev, c.mkt === 'fut')) { c.buffer.length = 0; c.buffer.push(ev); c.book.live = false; resync(c); }
}
const best = c => { let bb = 0, ba = Infinity; for (const p of c.book.bids.keys()) if (p > bb) bb = p; for (const p of c.book.asks.keys()) if (p < ba) ba = p; return {bb, ba, mid:(bb + ba) / 2}; };
function prune(c) {   // drop levels too far from the price (they only cost memory)
  const {mid} = best(c); if (!mid) return;
  for (const p of c.book.bids.keys()) if (p < mid * (1 - BOOK_RANGE)) c.book.bids.delete(p);
  for (const p of c.book.asks.keys()) if (p > mid * (1 + BOOK_RANGE)) c.book.asks.delete(p);
}

// ---------- trades -> clusters ----------
function onTrade(c, x) {
  c.last = +x.p; if (!c.base) return;
  const t = Math.floor(x.T / 6e4) * 6e4;
  if (c.fpT !== t) { closeFp(c); c.fpT = t; c.fpCur = new Map(); }
  const k = Math.floor(+x.p / c.base), r = c.fpCur.get(k) || [0, 0], usd = +x.p * +x.q;
  r[x.m ? 1 : 0] += usd; c.fpCur.set(k, r);   // m = buyer is the maker -> a market sell
}
function closeFp(c) {
  if (!c.fpCur?.size) return;
  const ks = [...c.fpCur.keys()], k0 = Math.min(...ks), n = Math.max(...ks) - k0 + 1, buy = new Float32Array(n), sell = new Float32Array(n);
  for (const [k, [b, s]] of c.fpCur) { buy[k - k0] = b; sell[k - k0] = s; }
  const rec = {t:c.fpT, k0, buy, sell}; c.fp.push(rec); if (c.fp.length > KEEP_MIN) c.fp.shift();
  disk.append(c, 'fp', rec);
}

// ---------- futures liquidations (one stream for the whole market) -> a liquidation heatmap ----------
const LIQ_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
function onLiq(o) {
  const c = coins.get(cid(o.s, 'fut')); if (!c || !c.base) return;   // liquidations belong to the futures twin
  const p = +o.ap || +o.p, usd = p * (+o.z || +o.q); if (!usd) return;
  const t = Math.floor(+o.T / 6e4) * 6e4;
  if (c.liqT !== t) { closeLiq(c); c.liqT = t; c.liqCur = new Map(); }
  const k = Math.floor(p / c.base), r = c.liqCur.get(k) || [0, 0];
  r[o.S === 'SELL' ? 1 : 0] += usd; c.liqCur.set(k, r);   // SELL: a long was liquidated
}
function closeLiq(c) {
  if (!c.liqCur?.size) return;
  const ks = [...c.liqCur.keys()], k0 = Math.min(...ks), n = Math.max(...ks) - k0 + 1, buy = new Float32Array(n), sell = new Float32Array(n);
  for (const [k, [b, s]] of c.liqCur) { buy[k - k0] = b; sell[k - k0] = s; }
  const rec = {t:c.liqT, k0, buy, sell}; c.liq.push(rec); if (c.liq.length > KEEP_MIN) c.liq.shift();
  c.liqCur = null; disk.append(c, 'liq', rec);
}
function liqStream(attempt = 0) {
  const ws = new WebSocket(LIQ_URL); let opened = false;
  ws.on('open', () => { opened = true; log('liquidation stream open'); });
  ws.on('message', buf => { let m; try { m = JSON.parse(buf); } catch { return; } if (m.o) onLiq(m.o); });
  ws.on('error', e => log('liquidation stream error', e.message));
  ws.on('close', () => { const wait = Math.min(60e3, 2000 * 2 ** (opened ? 0 : attempt)); setTimeout(() => liqStream(opened ? 0 : attempt + 1), wait); });
  setTimeout(() => ws.close(), 23 * 3600e3);
}
// ---------- heatmap: every 10 s the book is folded into bins, the max per bin over the minute is kept ----------
function sampleHeat(c) {
  if (!c.book?.ok || !c.base) return;
  const {mid} = best(c); if (!mid) return;
  const t = Math.floor(Date.now() / 6e4) * 6e4;
  if (!c.heatCur || c.heatCur.t !== t) { closeHeat(c); c.heatCur = {t, m:new Map()}; }
  const bins = new Map();
  for (const [p, q] of c.book.bids) if (p >= mid * (1 - HEAT_RANGE)) { const k = Math.floor(p / c.base); bins.set(k, (bins.get(k) || 0) + p * q); }
  for (const [p, q] of c.book.asks) if (p <= mid * (1 + HEAT_RANGE)) { const k = Math.floor(p / c.base); bins.set(k, (bins.get(k) || 0) + p * q); }
  for (const [k, v] of bins) if (v > (c.heatCur.m.get(k) || 0)) c.heatCur.m.set(k, v);
}
function closeHeat(c) {
  const h = c.heatCur; if (!h?.m.size) return;
  const ks = [...h.m.keys()], k0 = Math.min(...ks), v = new Float32Array(Math.max(...ks) - k0 + 1);
  for (const [k, x] of h.m) v[k - k0] = x;
  const rec = {t:h.t, k0, v}; c.heat.push(rec); if (c.heat.length > KEEP_MIN) c.heat.shift();
  disk.append(c, 'heat', rec);
}

// ---------- streams: one connection per 10 coins, reconnect with growing pauses ----------
// spot: book and trades on one connection; futures: the book on /public and trades on /market (what = 'depth' | 'trade' | 'both')
function stream(group, mkt = 'spot', what = 'both', attempt = 0) {
  const names = group.flatMap(s => [...(what !== 'trade' ? [`${s.toLowerCase()}@depth@100ms`] : []), ...(what !== 'depth' ? [`${s.toLowerCase()}@aggTrade`] : [])]);
  const ws = new WebSocket((mkt === 'fut' ? (what === 'depth' ? WSF_PUB : WSF_MKT) : WS_URL) + names.join('/'));
  let opened = false;
  ws.on('open', () => {
    opened = true; attempt = 0; log('stream open', mkt, what, group.join(','));
    if (what !== 'trade') for (const s of group) { const c = coins.get(cid(s, mkt)); c.buffer.length = 0; if (c.book) c.book.live = false; resync(c); }
  });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    const c = coins.get(cid(m.data?.s, mkt)); if (!c) return;
    if (m.stream.endsWith('@aggTrade')) onTrade(c, m.data); else onDepth(c, m.data);
  });
  ws.on('error', e => log('stream error', e.message));
  ws.on('close', () => { const wait = Math.min(60e3, 2000 * 2 ** (opened ? 0 : attempt)); log('stream closed, reconnecting in', wait / 1000, 's'); setTimeout(() => stream(group, mkt, what, opened ? 0 : attempt + 1), wait); });
  // Binance drops connections after 24 h: reconnect a bit earlier on our own
  setTimeout(() => ws.close(), 23 * 3600e3);
}

// ---------- HTTP API for the Beta tab ----------
const round = x => Math.round(x);
// compression runs off the main thread (gzipSync of a long history would stall the Binance streams for everyone)
function send(req, res, code, obj, extra = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj), gz = /gzip/.test(req.headers['accept-encoding'] || '') && body.length > 1024;
  const head = {'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*', 'cache-control':'no-store', ...extra};
  if (!gz) { res.writeHead(code, head); return res.end(body); }
  zlib.gzip(body, (err, z) => { if (err) { res.writeHead(code, head); return res.end(body); } res.writeHead(code, {...head, 'content-encoding':'gzip'}); res.end(z); });
}
// ---------- protection ----------
// per-address limit: the Beta tab asks ~20 times a minute per chart (the far book every 3 s); 300 leaves room for a few charts and tabs
const RATE = 300, HITS = new Map();
// Railway's proxy puts the caller's address in X-Real-IP; X-Forwarded-For can be started by the caller, so it is only a fallback
const clientIp = req => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const SCAN_TOKEN = process.env.SCAN_TOKEN || '';
if (!SCAN_TOKEN) console.log('SCAN_TOKEN is not set: POST /scan is closed (503) until it is (set it to bot_secret.scan from Supabase)');
function allowed(req) {
  const ip = clientIp(req), now = Date.now(), h = HITS.get(ip);
  if (!h || now - h.t > 60e3) { HITS.set(ip, {n:1, t:now}); return true; }
  return ++h.n <= RATE;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of HITS) if (now - h.t > 60e3) HITS.delete(ip); }, 60e3);
// every open chart asks for the same far book every 3 s: answer from a 2-second cache instead of re-binning the whole book
const CACHE = new Map(), CACHE_MS = {'/book':2000, '/symbols':10000, '/health':5000};
setInterval(() => { const now = Date.now(); for (const [k, v] of CACHE) if (now - v.t > 30e3) CACHE.delete(k); }, 30e3);
// heatmap history is the biggest answer we give (a day of BTC by the minute was ~4 MB of JSON, built anew for every chart
// opened). With ?tf= the minutes are folded into that timeframe's bars (max per bin, as the Beta tab does) and values go in
// units of `u` dollars, about three significant digits for a typical bin. One answer per coin, timeframe and starting bar,
// built and gzipped once per new minute of history: all charts of one timeframe opened within that minute share it
const TFMS = {'1m':6e4, '5m':3e5, '15m':9e5, '30m':18e5, '1h':36e5, '4h':144e5, '1d':864e5};
const HEAT_CACHE = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of HEAT_CACHE) if (now - v.t > 120e3) HEAT_CACHE.delete(k); }, 60e3);
function heatAnswer(c, q) {
  const fold = q.has('tf'), tf = TFMS[q.get('tf')] || 6e4, first = c.heat[0]?.t || 0, last = c.heat[c.heat.length - 1]?.t || 0;
  const since = Math.floor(Math.max(+q.get('since') || 0, first) / tf) * tf, key = `${c.id}|${fold ? tf : 'm'}|${since}`, ver = `${c.heat.length}|${last}`;
  const hit = HEAT_CACHE.get(key); if (hit?.ver === ver) return hit;
  const groups = [];   // the minutes of each bar
  for (const h of c.heat) {
    if (h.t < since) continue;
    const bar = fold ? Math.floor(h.t / tf) * tf : h.t, g = groups[groups.length - 1];
    if (g?.t === bar) g.list.push(h); else groups.push({t:bar, list:[h]});
  }
  const cols = groups.map(({t, list}) => {
    if (list.length === 1) return {t, k0:list[0].k0, v:list[0].v};
    let lo = Infinity, hi = -Infinity; for (const h of list) { lo = Math.min(lo, h.k0); hi = Math.max(hi, h.k0 + h.v.length - 1); }
    const v = new Float32Array(hi - lo + 1);
    for (const h of list) for (let i = 0, o = h.k0 - lo; i < h.v.length; i++) if (h.v[i] > v[o + i]) v[o + i] = h.v[i];
    return {t, k0:lo, v};
  });
  // the unit: a power of ten about 1/100 of the median bin (from a sample); an older Beta tab (no ?tf) gets plain dollars
  let u = 1;
  if (fold) {
    const smp = []; let n = 0;
    for (const cl of cols) for (let i = 0; i < cl.v.length; i++) if (cl.v[i] > 0 && n++ % 37 === 0) smp.push(cl.v[i]);
    smp.sort((a, b) => a - b); const med = smp[smp.length >> 1] || 0;
    if (med >= 1000) u = 10 ** (Math.floor(Math.log10(med)) - 2);
  }
  const body = JSON.stringify({base:c.base, u, mins:groups.reduce((s, g) => s + g.list.length, 0), cols:cols.map(cl => [cl.t, cl.k0, Array.from(cl.v, x => Math.round(x / u))])});
  const e = {t:Date.now(), ver, body, gz:new Promise((ok, no) => zlib.gzip(body, (err, z) => err ? no(err) : ok(z)))};
  e.gz.catch(() => {}); HEAT_CACHE.set(key, e); return e;
}
function sendAnswer(req, res, e) {   // a cached answer, gzipped already when the caller takes gzip
  const head = {'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*', 'cache-control':'no-store'};
  const plain = () => { res.writeHead(200, head); res.end(e.body); };
  if (!/gzip/.test(req.headers['accept-encoding'] || '')) return plain();
  e.gz.then(z => { res.writeHead(200, {...head, 'content-encoding':'gzip'}); res.end(z); }, plain);
}
const routes = {
  '/health': () => ({ok:true, uptime:Math.round(process.uptime()), disk:diskInfo(), coins:[...coins.values()].map(c => ({sym:c.sym, mkt:c.mkt, book:!!c.book?.ok, levels:c.book ? c.book.bids.size + c.book.asks.size : 0, heatMin:c.heat.length, fpMin:c.fp.length, liqMin:c.liq.length}))}),
  '/symbols': () => { const of = m => [...coins.values()].filter(c => c.mkt === m).map(c => c.sym); return {symbols:of('spot'), futures:of('fut')}; },
  // the whole book we know, binned by the coin's base step: [[bin, $], …] for bids and asks
  '/book': (q, c) => {
    if (!c.book?.live) return {error:'book not ready'};
    const {mid} = best(c), bins = side => { const m = new Map(); for (const [p, x] of c.book[side]) { const k = Math.floor(p / c.base); m.set(k, (m.get(k) || 0) + p * x); } return [...m].map(([k, v]) => [k, round(v)]); };
    let minB = Infinity, maxA = 0; for (const p of c.book.bids.keys()) if (p < minB) minB = p; for (const p of c.book.asks.keys()) if (p > maxA) maxA = p;
    return {t:Date.now(), base:c.base, mid, minB, maxA, bids:bins('bids'), asks:bins('asks')};
  },
  // heatmap history since ?since=ms: {base, u, mins, cols:[[t, k0, [value / u …]], …]} per bar of ?tf= (per minute without it);
  // answered from HEAT_CACHE by the server below
  '/heat': (q, c) => heatAnswer(c, q),
  // clusters since ?since=ms: [[t, k0, [buy $…], [sell $…]], …] per minute
  // liquidations since ?since=ms: [[t, k0, [shorts $…], [longs $…]], …] per minute
  '/liq': (q, c) => { const since = +q.get('since') || 0; return {base:c.base, bars:c.liq.filter(b => b.t >= since).map(b => [b.t, b.k0, Array.from(b.buy, round), Array.from(b.sell, round)])}; },
  '/fp': (q, c) => { const since = +q.get('since') || 0; return {base:c.base, bars:c.fp.filter(b => b.t >= since).map(b => [b.t, b.k0, Array.from(b.buy, round), Array.from(b.sell, round)])}; },
};
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'access-control-allow-origin':'*', 'access-control-allow-methods':'GET, POST', 'access-control-allow-headers':'content-type'}); return res.end(); }
  // the Supabase bot's candles and analyses (scan.js): a JSON body, answered gzipped
  if (req.method === 'POST' && req.url === '/scan') {
    // only the Supabase bot may make this service download and compute (SCAN_TOKEN = bot_secret.scan in Supabase). Without the
    // variable the route stays shut (503) instead of open to anyone: one forgotten setting must not reopen it; the bot then
    // computes everything itself
    if (!SCAN_TOKEN) return send(req, res, 503, {error:'scan is not configured'});
    if (req.headers['x-scan-token'] !== SCAN_TOKEN) return send(req, res, 403, {error:'forbidden'});
    if (!allowed(req)) return send(req, res, 429, {error:'too many requests, slow down'}, {'retry-after':'60'});
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > 256e3) req.destroy(); else parts.push(d); });
    req.on('end', async () => {
      let body; try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { return send(req, res, 400, {error:'bad json'}); }
      try { send(req, res, 200, encode(await scan(body))); } catch (e) { send(req, res, 500, {error:e.message}); }
    });
    return;
  }
  if (req.method !== 'GET') return send(req, res, 405, {error:'GET only'});
  if (!allowed(req)) return send(req, res, 429, {error:'too many requests, slow down'}, {'retry-after':'60'});
  if (req.url.length > 300) return send(req, res, 414, {error:'url too long'});
  let u; try { u = new URL(req.url, 'http://x'); } catch { return send(req, res, 400, {error:'bad url'}); }
  const fn = routes[u.pathname];
  if (!fn) return send(req, res, 404, {error:'not found', routes:Object.keys(routes)});
  // &mkt=fut picks the futures twin; liquidations exist on futures only, so /liq always does
  const sym = (u.searchParams.get('symbol') || '').toUpperCase(), fut = u.searchParams.get('mkt') === 'fut' || u.pathname === '/liq';
  // the cache key is the route and the coin only: extra query junk must not make new entries
  const ttl = CACHE_MS[u.pathname], ck = ttl && (['/health', '/symbols'].includes(u.pathname) ? u.pathname : `${u.pathname}|${sym}|${fut}`), hit = ck && CACHE.get(ck);
  if (hit && Date.now() - hit.t < ttl) return send(req, res, 200, hit.body);
  const needCoin = !['/health', '/symbols'].includes(u.pathname), c = coins.get(cid(sym, fut ? 'fut' : 'spot'));
  if (needCoin && !c) return send(req, res, 404, {error:'symbol not followed', ...routes['/symbols']()});
  try {
    if (u.pathname === '/heat') return sendAnswer(req, res, fn(u.searchParams, c));
    const body = JSON.stringify(fn(u.searchParams, c));
    if (ck) CACHE.set(ck, {t:Date.now(), body});
    send(req, res, 200, body);
  } catch (e) { send(req, res, 500, {error:e.message}); }
}).listen(PORT, () => log('listening on', PORT));

// ---------- start ----------
(async () => {
  let syms, futs = [];
  for (;;) { try { syms = await pickSymbols(); break; } catch (e) { log('cannot list symbols (is the region outside the US?):', e.message); await sleep(30e3); } }
  try { futs = await pickFutures(); } catch (e) { log('cannot list futures, following spot only:', e.message); }
  for (const s of syms) { const c = coin(s); disk.load(c); disk.compact(c); coins.set(c.id, c); }
  for (const s of futs) { const c = coin(s, 'fut'); disk.load(c); if (!c.base) c.base = coins.get(s)?.base || 0; disk.compact(c); coins.set(c.id, c); }
  // Railway stops the old copy with SIGTERM on every deploy: save what is in memory first
  process.once('SIGTERM', () => { log('stopping: saving books'); for (const c of coins.values()) { closeHeat(c); closeFp(c); closeLiq(c); disk.saveBook(c); } process.exit(0); });
  setTimeout(() => { for (const c of coins.values()) disk.saveBook(c); }, 70e3);   // a first save soon after start, then every 5 minutes
  setInterval(() => { for (const c of coins.values()) disk.saveBook(c); }, 5 * 6e4);
  setInterval(() => { for (const c of coins.values()) disk.compact(c); }, 6 * 3600e3);
  log('following', syms.length, 'spot coins:', syms.join(' ')); log('and', futs.length, 'futures:', futs.join(' '));
  for (let i = 0; i < syms.length; i += 10) stream(syms.slice(i, i + 10));
  for (let i = 0; i < futs.length; i += 10) { stream(futs.slice(i, i + 10), 'fut', 'depth'); stream(futs.slice(i, i + 10), 'fut', 'trade'); }
  liqStream();
  setInterval(() => { for (const c of coins.values()) sampleHeat(c); }, 10e3);
  setInterval(() => { const t = Math.floor(Date.now() / 6e4) * 6e4; for (const c of coins.values()) { if (c.fpT && c.fpT < t) { closeFp(c); c.fpT = 0; c.fpCur = null; } if (c.liqT && c.liqT < t) { closeLiq(c); c.liqT = 0; } if (c.book?.ok) prune(c); } }, 15e3);
})();
