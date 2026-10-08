// Sigma Radar collector: runs around the clock (Railway) and gives the Beta tab what a browser cannot get on its own.
//  - full order books: the REST snapshot covers only the nearest 5000 levels, but the diff stream reports changes on
//    every level, so a book kept for hours knows the far levels too (a browser tab only knows them since it opened)
//  - liquidity heatmap history: the book folded into price bins once every 10 s, kept for a day by the minute
//  - trade clusters (footprint): market buys / sells by price bin, per minute, kept for a day
// Data comes from Binance spot market streams; nothing is traded and no keys are needed.
// Binance refuses connections from US IP addresses: deploy in an EU or Asia region.
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket from 'ws';

const PORT = +process.env.PORT || 8080;
const TOP = +process.env.TOP || 20;                       // how many of the most traded USDT pairs to follow
const ONLY = (process.env.SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const KEEP_MIN = +process.env.KEEP_MIN || 1440;           // minutes of heatmap / cluster history per coin
const HEAT_RANGE = 0.12;                                  // heatmap: ±12% around the price (far walls show up too)
const BOOK_RANGE = 0.25;                                  // book served up to ±25% (far levels beyond are dropped)
const REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
const WS_URL = 'wss://stream.binance.com:9443/stream?streams=';
const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|USD1|XUSD|PAXG|XAUT|RLUSD|USDE|USDS|PYUSD|EURI|WBTC|WBETH|BFUSD|BNSOL)USDT$/;   // stablecoins, gold and wrapped tokens: no point charting them

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a "nice" price bin ≈ 0.05% of the price, fixed per coin so the history lines up over time
const niceStep = (p, share = 0.0005) => { const raw = p * share, m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].find(x => x * m >= raw) * m; };

async function api(path) {
  let err;
  for (const b of REST) {
    try { const r = await fetch(b + path); if (r.ok) return await r.json(); err = new Error(`HTTP ${r.status} ${path}`); if (r.status === 418 || r.status === 429) await sleep(60e3); }
    catch (e) { err = e; }
  }
  throw err;
}

// ---------- coins ----------
const coins = new Map();   // sym -> state
function coin(sym) {
  return {sym, base:0, book:null, buffer:[], syncing:false, fails:0, last:0,
    heat:[], heatCur:null,            // heat: [{t, k0, v:Float32Array}] one per minute; heatCur: Map bin -> max $ in the current minute
    fp:[], fpCur:null, fpT:0};        // fp: [{t, k0, buy:Float32Array, sell:Float32Array}]; fpCur: Map bin -> [buy $, sell $]
}
async function pickSymbols() {
  if (ONLY.length) return ONLY;
  const t = await api('/api/v3/ticker/24hr');
  return t.filter(x => x.symbol.endsWith('USDT') && !STABLE.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP).map(x => x.symbol);
}

// ---------- order books: snapshot + diff stream (Binance's procedure) ----------
// snapshots are expensive (weight 250 of 6000 per minute): one at a time, at least 3 s apart
let gateAt = 0;
const snapGate = () => { const now = Date.now(), at = Math.max(now, gateAt); gateAt = at + 3000; return sleep(at - now); };
function applyDepth(b, ev) {
  if (ev.u <= b.id) return true;
  if (!b.ok) { if (ev.U > b.id + 1) return false; b.ok = true; }
  else if (ev.U !== b.id + 1) return false;
  for (const [p, q] of ev.b) +q ? b.bids.set(+p, +q) : b.bids.delete(+p);
  for (const [p, q] of ev.a) +q ? b.asks.set(+p, +q) : b.asks.delete(+p);
  b.id = ev.u; return true;
}
async function resync(c) {
  if (c.syncing) return;
  c.syncing = true;
  try {
    await snapGate();
    const s = await api(`/api/v3/depth?symbol=${c.sym}&limit=5000`);
    const minB = +s.bids[s.bids.length - 1][0], maxA = +s.asks[s.asks.length - 1][0];
    const b = {bids:new Map(s.bids.map(([p, q]) => [+p, +q])), asks:new Map(s.asks.map(([p, q]) => [+p, +q])), id:s.lastUpdateId, ok:false, minB, maxA};
    // far levels learned from the stream before this snapshot are still valid: the snapshot just doesn't reach them
    if (c.book) { for (const [p, q] of c.book.bids) if (p < minB) b.bids.set(p, q); for (const [p, q] of c.book.asks) if (p > maxA) b.asks.set(p, q); }
    for (const ev of c.buffer.splice(0)) if (!applyDepth(b, ev)) throw new Error('snapshot older than the stream');
    b.live = true; c.book = b; c.fails = 0;
    if (!c.base) c.base = niceStep((+s.bids[0][0] + +s.asks[0][0]) / 2);
  } catch (e) {
    c.fails++; log(c.sym, 'snapshot failed:', e.message); if (c.book) c.book.live = false;
    setTimeout(() => resync(c), Math.min(120e3, 3000 * 2 ** c.fails));
  } finally { c.syncing = false; }
}
function onDepth(c, ev) {
  // until a snapshot is in place (or while a new one is being taken) the diff events wait in the buffer
  if (!c.book?.live || c.syncing) { c.buffer.push(ev); if (c.buffer.length > 5000) c.buffer.shift(); return; }
  if (!applyDepth(c.book, ev)) { c.buffer.length = 0; c.buffer.push(ev); c.book.live = false; resync(c); }
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
  c.fp.push({t:c.fpT, k0, buy, sell}); if (c.fp.length > KEEP_MIN) c.fp.shift();
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
  c.heat.push({t:h.t, k0, v}); if (c.heat.length > KEEP_MIN) c.heat.shift();
}

// ---------- streams: one connection per 10 coins, reconnect with growing pauses ----------
function stream(group, attempt = 0) {
  const ws = new WebSocket(WS_URL + group.flatMap(s => [`${s.toLowerCase()}@depth@100ms`, `${s.toLowerCase()}@aggTrade`]).join('/'));
  let opened = false;
  ws.on('open', () => { opened = true; attempt = 0; log('stream open', group.join(',')); for (const s of group) { const c = coins.get(s); c.buffer.length = 0; if (c.book) c.book.live = false; resync(c); } });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    const c = coins.get(m.data?.s); if (!c) return;
    if (m.stream.endsWith('@aggTrade')) onTrade(c, m.data); else onDepth(c, m.data);
  });
  ws.on('error', e => log('stream error', e.message));
  ws.on('close', () => { const wait = Math.min(60e3, 2000 * 2 ** (opened ? 0 : attempt)); log('stream closed, reconnecting in', wait / 1000, 's'); setTimeout(() => stream(group, opened ? 0 : attempt + 1), wait); });
  // Binance drops connections after 24 h: reconnect a bit earlier on our own
  setTimeout(() => ws.close(), 23 * 3600e3);
}

// ---------- HTTP API for the Beta tab ----------
const round = x => Math.round(x);
function send(req, res, code, obj) {
  const body = JSON.stringify(obj), gz = /gzip/.test(req.headers['accept-encoding'] || '') && body.length > 1024;
  res.writeHead(code, {'content-type':'application/json; charset=utf-8', 'access-control-allow-origin':'*', 'cache-control':'no-store', ...(gz && {'content-encoding':'gzip'})});
  res.end(gz ? zlib.gzipSync(body) : body);
}
const routes = {
  '/health': () => ({ok:true, uptime:Math.round(process.uptime()), coins:[...coins.values()].map(c => ({sym:c.sym, book:!!c.book?.ok, levels:c.book ? c.book.bids.size + c.book.asks.size : 0, heatMin:c.heat.length, fpMin:c.fp.length}))}),
  '/symbols': () => ({symbols:[...coins.keys()]}),
  // the whole book we know, binned by the coin's base step: [[bin, $], …] for bids and asks
  '/book': (q, c) => {
    if (!c.book?.live) return {error:'book not ready'};
    const {mid} = best(c), bins = side => { const m = new Map(); for (const [p, x] of c.book[side]) { const k = Math.floor(p / c.base); m.set(k, (m.get(k) || 0) + p * x); } return [...m].map(([k, v]) => [k, round(v)]); };
    let minB = Infinity, maxA = 0; for (const p of c.book.bids.keys()) if (p < minB) minB = p; for (const p of c.book.asks.keys()) if (p > maxA) maxA = p;
    return {t:Date.now(), base:c.base, mid, minB, maxA, bids:bins('bids'), asks:bins('asks')};
  },
  // heatmap history since ?since=ms: [[t, k0, [$…]], …] per minute
  '/heat': (q, c) => { const since = +q.get('since') || 0; return {base:c.base, cols:c.heat.filter(h => h.t >= since).map(h => [h.t, h.k0, Array.from(h.v, round)])}; },
  // clusters since ?since=ms: [[t, k0, [buy $…], [sell $…]], …] per minute
  '/fp': (q, c) => { const since = +q.get('since') || 0; return {base:c.base, bars:c.fp.filter(b => b.t >= since).map(b => [b.t, b.k0, Array.from(b.buy, round), Array.from(b.sell, round)])}; },
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), fn = routes[u.pathname];
  if (req.method === 'OPTIONS') { res.writeHead(204, {'access-control-allow-origin':'*', 'access-control-allow-methods':'GET'}); return res.end(); }
  if (!fn) return send(req, res, 404, {error:'not found', routes:Object.keys(routes)});
  const needCoin = !['/health', '/symbols'].includes(u.pathname), c = coins.get((u.searchParams.get('symbol') || '').toUpperCase());
  if (needCoin && !c) return send(req, res, 404, {error:'symbol not followed', symbols:[...coins.keys()]});
  try { send(req, res, 200, fn(u.searchParams, c)); } catch (e) { send(req, res, 500, {error:e.message}); }
}).listen(PORT, () => log('listening on', PORT));

// ---------- start ----------
(async () => {
  let syms;
  for (;;) { try { syms = await pickSymbols(); break; } catch (e) { log('cannot list symbols (is the region outside the US?):', e.message); await sleep(30e3); } }
  for (const s of syms) coins.set(s, coin(s));
  log('following', syms.length, 'coins:', syms.join(' '));
  for (let i = 0; i < syms.length; i += 10) stream(syms.slice(i, i + 10));
  setInterval(() => { for (const c of coins.values()) sampleHeat(c); }, 10e3);
  setInterval(() => { const t = Math.floor(Date.now() / 6e4) * 6e4; for (const c of coins.values()) { if (c.fpT && c.fpT < t) { closeFp(c); c.fpT = 0; c.fpCur = null; } if (c.book?.ok) prune(c); } }, 15e3);
})();
