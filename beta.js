// Beta: order book and order flow on top of the usual chart. Loaded only after the Beta password (see index.html).
// Everything comes straight from Binance spot in the browser: candles over REST + the kline stream, the order book as a
// REST snapshot kept current by the depth diff stream, trades from the aggTrade stream. Nothing is stored on a server yet,
// so the liquidity heatmap accumulates from the moment the tab is opened.
import * as M from './supabase/functions/_shared/math.js';

let K = null;                       // toolkit from index.html (renderChart, attachZoom, api, fp, …)
const $ = s => document.querySelector(s);
const TFMS = {'1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5};
const WS = 'wss://stream.binance.com:9443/stream?streams=';

// ---------- indicator catalogue (the picker mirrors the "Индикаторы" window of order-flow terminals) ----------
const CATS = [
  {name:'Стакан и ликвидность', items:[
    {id:'dom', name:'Биржевой стакан', hint:'bid/ask по уровням рядом с графиком'},
    {id:'imb', name:'Дисбаланс стакана', hint:'покупатели против продавцов у цены'},
    {id:'heat', name:'Тепловая карта ликвидности', hint:'плотность лимитных заявок во времени'},
    {id:'walls', name:'Стены в стакане', hint:'уровни, где заявок в 5× больше обычного'},
    {id:'bubbles', name:'Пузыри крупных сделок', hint:'крупные рыночные покупки и продажи'},
    {id:'flow', name:'Поток ликвидности', hint:'как быстро ставят и снимают заявки', soon:true},
  ]},
  {name:'Поток сделок', items:[
    {id:'delta', name:'Дельта объёма', hint:'покупки − продажи по рынку, по свечам'},
    {id:'cvd', name:'CVD', hint:'накопленная дельта объёма'},
  ]},
  {name:'Кластерный анализ', items:[
    {id:'fp', name:'Таблицы кластеров', hint:'объём по ценам внутри свечи', soon:true},
  ]},
  {name:'Профили объёма и POC', items:[
    {id:'vp', name:'Профиль объёма', hint:'объём по ценам в видимой части графика'},
    {id:'poc', name:'POC', hint:'цена с наибольшим объёмом'},
  ]},
  {name:'VWAP', items:[
    {id:'vwap', name:'VWAP по дню', hint:'средняя цена с учётом объёма с начала суток (UTC)'},
  ]},
  {name:'Цена и построения', items:[
    {id:'bb', name:'Канал Боллинджера', hint:'лог-канал 210/3, как на рынке'},
    {id:'rsi', name:'RSI', hint:'нижняя панель, если не выбраны дельта или CVD'},
    {id:'fib', name:'Уровни Фибоначчи', hint:'два клика по графику', soon:true},
  ]},
];
const ITEMS = CATS.flatMap(c => c.items), QUICK = ['dom', 'imb', 'heat', 'walls', 'bubbles', 'delta', 'cvd', 'vp', 'vwap'];
let sel, hidden;                    // chosen indicators, and chosen-but-hidden ones (the eye)
const on = id => sel.has(id) && !hidden.has(id);

// ---------- state ----------
const st = {sym:null, tf:'1m', d:null, view:null, geo:null, hoverI:null, hoverY:null, list:'fav'};
let ws = null, wsTimer = null, book = null, heat = new Map(), heatSym = null, heatMs = 0, step = 0, trades = [], tradeUsd = [], dirty = true, loopOn = false, lastDom = 0;

// ---------- candles ----------
async function loadCandles() {
  const want = st.sym + '|' + st.tf;
  const k = await K.api(`/api/v3/klines?symbol=${st.sym}&interval=${st.tf}&limit=500`);
  if (want !== st.sym + '|' + st.tf) return;
  st.d = M.parse(k); st.d.qv = k.map(x => +x[7]); st.d.tbq = k.map(x => +x[10]);   // quote volume and taker-buy quote volume
  calc(); dirty = true;
}
// indicators that only need candles: channel, RSI, delta, CVD, VWAP
function calc() {
  const d = st.d; if (!d) return;
  const N = Math.max(20, Math.min(210, d.c.length - 30));
  d.N = N; d.B = M.bands(d.c, N, 3, 'log'); d.R = M.rsi(d.c);
  d.delta = d.qv.map((v, i) => 2 * d.tbq[i] - v);   // market buys − market sells, in $
  let cum = 0; d.cvd = d.delta.map(x => cum += x);
  let day = -1, pv = 0, vv = 0;
  d.vwap = d.c.map((c, i) => { const dd = Math.floor(d.t[i] / 864e5); if (dd !== day) { day = dd; pv = 0; vv = 0; } const tp = (d.h[i] + d.l[i] + c) / 3; pv += tp * d.v[i]; vv += d.v[i]; return vv ? pv / vv : NaN; });
}
function onKline(k) {   // live candle from the stream: update the forming bar or start a new one
  const d = st.d; if (!d) return;
  const T = k.t, i = d.t.length - 1, row = [T, +k.o, +k.h, +k.l, +k.c, +k.v, 0, +k.q, 0, 0, +k.Q];
  if (T === d.t[i]) { d.o[i] = row[1]; d.h[i] = row[2]; d.l[i] = row[3]; d.c[i] = row[4]; d.v[i] = row[5]; d.qv[i] = row[7]; d.tbq[i] = row[10]; }
  else if (T > d.t[i]) { d.t.push(T); d.o.push(row[1]); d.h.push(row[2]); d.l.push(row[3]); d.c.push(row[4]); d.v.push(row[5]); d.qv.push(row[7]); d.tbq.push(row[10]); }
  calc(); dirty = true;
}

// ---------- order book: snapshot + diff stream (Binance's documented sync procedure) ----------
async function loadBook(buffer) {
  const snap = await K.api(`/api/v3/depth?symbol=${st.sym}&limit=5000`);
  const b = {bids:new Map(snap.bids.map(([p, q]) => [+p, +q])), asks:new Map(snap.asks.map(([p, q]) => [+p, +q])), id:snap.lastUpdateId, ok:false};
  for (const ev of buffer) applyDepth(b, ev);
  return b;
}
function applyDepth(b, ev) {
  if (ev.u <= b.id) return true;                        // already in the snapshot
  if (!b.ok) { if (ev.U > b.id + 1) return false; b.ok = true; }   // the first event must straddle the snapshot
  else if (ev.U !== b.id + 1) return false;             // a gap: the book is no longer exact
  for (const [p, q] of ev.b) +q ? b.bids.set(+p, +q) : b.bids.delete(+p);
  for (const [p, q] of ev.a) +q ? b.asks.set(+p, +q) : b.asks.delete(+p);
  b.id = ev.u; return true;
}
const mid = () => { if (!book) return st.d ? st.d.c[st.d.c.length - 1] : null; let bb = 0, ba = Infinity; for (const p of book.bids.keys()) if (p > bb) bb = p; for (const p of book.asks.keys()) if (p < ba) ba = p; return isFinite(ba) && bb ? (bb + ba) / 2 : null; };
// price buckets of a "nice" size ≈ 0.05% of the price, fixed per coin so heatmap columns line up over time
const niceStep = p => { const raw = p * 0.0005, m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].find(x => x * m >= raw) * m; };
function buckets(range = 0.03) {   // {key: usd} for bids and asks within ±range of the middle
  const m = mid(); if (!book || !m) return null;
  const bid = new Map(), ask = new Map();
  for (const [p, q] of book.bids) if (p >= m * (1 - range)) { const k = Math.round(p / step); bid.set(k, (bid.get(k) || 0) + p * q); }
  for (const [p, q] of book.asks) if (p <= m * (1 + range)) { const k = Math.round(p / step); ask.set(k, (ask.get(k) || 0) + p * q); }
  return {m, bid, ask};
}
// every second the current book is folded into the bar it belongs to (max per bucket), building the heatmap
function sampleHeat() {
  heatMs += 1000;
  if (!book?.ok || !st.d) return;
  const bk = buckets(0.04); if (!bk) return;
  const tf = TFMS[st.tf], bar = Math.floor(Date.now() / tf) * tf;
  let col = heat.get(bar); if (!col) heat.set(bar, col = new Map());
  for (const src of [bk.bid, bk.ask]) for (const [k, v] of src) if (v > (col.get(k) || 0)) col.set(k, v);
  if (heat.size > 1500) heat.delete(heat.keys().next().value);
  dirty = true;
}

// ---------- trades: big market buys / sells ----------
function onTrade(x) {
  const usd = +x.p * +x.q;
  tradeUsd.push(usd); if (tradeUsd.length > 2000) tradeUsd.shift();
  const s = [...tradeUsd].sort((a, b) => a - b), thr = Math.max(5000, s[Math.floor(s.length * 0.985)] || 0);   // top ~1.5% of recent trades
  if (usd >= thr) { trades.push({T:x.T, p:+x.p, usd, sell:x.m}); if (trades.length > 600) trades.shift(); dirty = true; }
}

// ---------- stream ----------
function connect() {
  disconnect();
  const s = st.sym.toLowerCase(), url = WS + [`${s}@depth@100ms`, `${s}@aggTrade`, `${s}@kline_${st.tf}`].join('/');
  const buffer = []; book = null;
  ws = new WebSocket(url);
  ws.onmessage = e => {
    const {stream, data} = JSON.parse(e.data);
    if (stream.endsWith('@aggTrade')) return onTrade(data);
    if (stream.includes('@kline_')) return onKline(data.k);
    if (!book) { buffer.push(data); return; }
    if (!applyDepth(book, data)) resync(buffer);
  };
  ws.onopen = async () => { setLive('ok'); try { book = await loadBook(buffer.splice(0)); } catch { setLive('bad'); } };
  ws.onclose = () => { if (!loopOn) return; setLive('bad'); clearTimeout(wsTimer); wsTimer = setTimeout(connect, 3000); };   // reconnect while the tab is open
  const resync = async buf => { book = null; try { book = await loadBook(buf.splice(0)); } catch { setLive('bad'); } };
}
function disconnect() { clearTimeout(wsTimer); if (ws) { ws.onclose = null; ws.close(); ws = null; } }
function setLive(s) {
  const mins = Math.floor(heatMs / 6e4);   // how long the heatmap has been collecting (only while the tab is open)
  $('#bLive').innerHTML = `<span class="live${s === 'ok' ? '' : ' stale'}"><i></i><span>${s === 'ok' ? `стакан и сделки вживую · карта копится ${mins ? mins + ' мин' : 'с этой минуты'}` : 'нет связи с Binance — переподключаюсь'}</span></span>`;
}

// ---------- drawing ----------
// heatmap scale comes from the CSS tokens --heat-0..3 (cold → hot)
let HEAT = null;
const rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
function heatColor(x) {
  HEAT ||= [0, 1, 2, 3].map(i => rgb(getComputedStyle(document.documentElement).getPropertyValue('--heat-' + i).trim() || '#888888'));   // 0..1 → dark blue → cyan → yellow → orange
  const t = Math.min(0.999, Math.max(0, x)) * (HEAT.length - 1), i = Math.floor(t), f = t - i, a = HEAT[i], b = HEAT[i + 1];
  return `rgba(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')},${(0.18 + 0.7 * x).toFixed(2)})`;
}
const fmtUsd = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return s + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'K' : Math.round(a)); };
function walls() {   // the strongest buckets on each side, at least 5× the typical bucket
  const bk = buckets(0.03); if (!bk) return [];
  const all = [...bk.bid.values(), ...bk.ask.values()].sort((a, b) => a - b), med = all[all.length >> 1] || 0;
  const pick = (m, side) => [...m].filter(([, v]) => v >= med * 5 && v >= 20000).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => ({price:k * step, usd:v, side}));
  return [...pick(bk.ask, 'ask'), ...pick(bk.bid, 'bid')];
}
function imbalance(range = 0.01) {
  const bk = buckets(range); if (!bk) return null;
  const b = [...bk.bid.values()].reduce((a, x) => a + x, 0), a = [...bk.ask.values()].reduce((s, x) => s + x, 0);
  return b + a ? {bid:b, ask:a, share:b / (a + b)} : null;
}
function draw() {
  const d = st.d; if (!d) return;
  const cv = $('#bcv'), n = d.c.length, defSpan = Math.min(n - d.N, Math.max(60, Math.round(cv.clientWidth / 6)));
  const r = K.viewRange(n, d.N - 1, st.view, defSpan);
  const PC = K.PC; let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, r.from); i <= Math.min(n - 1, r.to); i++) { lo = Math.min(lo, d.l[i]); hi = Math.max(hi, d.h[i]); }
  const W = walls().filter(w => w.price >= lo * 0.998 && w.price <= hi * 1.002);   // only walls inside the visible range, so they don't squash the candles
  const levels = on('walls') ? W.map(w => ({v:w.price, col:w.side === 'ask' ? PC.up : PC.lo, tag:`стена ${fmtUsd(w.usd)}`})) : [];
  const noBand = Array(n).fill(NaN), B = on('bb') ? d.B : {up:noBand, lo:noBand, mid:noBand, z:noBand};
  const sub = on('delta') ? {label:'Дельта объёма, $', values:d.delta, kind:'bars', fmt:fmtUsd} : on('cvd') ? {label:'CVD, $', values:d.cvd, kind:'line', fmt:fmtUsd} : null;
  st.geo = K.renderChart(cv, {...d, B}, {from:r.from, to:r.to, levels, live:true, hoverI:st.hoverI, hoverY:st.hoverY, top:44, sub,
    under:(g, G) => { if (on('heat')) drawHeat(g, G); if (on('vp') || on('poc')) drawProfile(g, G); },
    over:(g, G) => { if (on('vwap')) drawLine(g, G, d.vwap, PC.acc, [6, 3]); if (on('bubbles')) drawBubbles(g, G); }});
  if (on('dom')) drawDom(); note(W);
}
function drawHeat(g, G) {
  const d = st.d, tf = TFMS[st.tf]; if (!step) return;
  const vals = []; for (let i = G.s; i <= G.e; i++) { const col = heat.get(d.t[i]); if (col) for (const v of col.values()) vals.push(v); }
  if (!vals.length) return;
  vals.sort((a, b) => a - b); const top = vals[Math.floor(vals.length * 0.97)] || vals[vals.length - 1];
  const h = Math.max(1, Math.abs(G.Y(0) - G.Y(step)));
  for (let i = G.s; i <= G.e; i++) {
    const col = heat.get(d.t[i]); if (!col) continue;
    const x = G.X(i) - G.bw / 2;
    for (const [k, v] of col) { const y = G.Y(k * step); if (y < G.T0 || y > G.pH) continue; g.fillStyle = heatColor(v / top); g.fillRect(x, y - h / 2, G.bw + 0.5, h); }
  }
}
function drawProfile(g, G) {   // volume by price over the visible bars, drawn from the right edge of the plot
  const d = st.d, rows = 60, lo = G.mn, hi = G.mx, sz = (hi - lo) / rows, vp = Array(rows).fill(0);
  for (let i = G.s; i <= G.e; i++) {
    const a = Math.max(0, Math.floor((d.l[i] - lo) / sz)), b = Math.min(rows - 1, Math.floor((d.h[i] - lo) / sz)), share = d.v[i] / (b - a + 1);
    for (let k = a; k <= b; k++) vp[k] += share;
  }
  const max = Math.max(...vp), poc = vp.indexOf(max), wMax = (G.W - G.padL - G.padR) * 0.22, x1 = G.W - G.padR;
  if (on('vp')) for (let k = 0; k < rows; k++) {
    const y0 = G.Y(lo + (k + 1) * sz), y1 = G.Y(lo + k * sz), w = vp[k] / max * wMax;
    g.fillStyle = k === poc ? K.PC.acc + '55' : K.PC.mid + '33'; g.fillRect(x1 - w, y0, w, Math.max(1, y1 - y0 - 1));
  }
  if (on('poc')) { const y = G.Y(lo + (poc + 0.5) * sz); g.strokeStyle = K.PC.acc; g.lineWidth = 1.2; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(G.padL, y); g.lineTo(x1, y); g.stroke(); g.setLineDash([]); g.fillStyle = K.PC.acc; g.fillText('POC', G.padL + 4, y - 7); }
}
function drawLine(g, G, arr, col, dash = []) {
  g.beginPath(); g.setLineDash(dash); let s0 = false;
  for (let i = G.s; i <= G.e; i++) { if (!isFinite(arr[i])) continue; g[s0 ? 'lineTo' : 'moveTo'](G.X(i), G.Y(arr[i])); s0 = true; }
  g.strokeStyle = col; g.lineWidth = 1.4; g.stroke(); g.setLineDash([]);
  const v = arr[G.e]; if (isFinite(v)) { g.fillStyle = col; g.fillText('VWAP', G.X(G.e) + 6, G.Y(v)); }
}
function drawBubbles(g, G) {
  const d = st.d, tf = TFMS[st.tf], first = d.t[G.s], last = d.t[G.e] + tf;
  const vis = trades.filter(x => x.T >= first && x.T < last); if (!vis.length) return;
  const base = Math.min(...vis.map(x => x.usd));
  for (const x of vis) {
    const i = K.barAt(d.t, x.T), cx = G.X(i) - G.bw / 2 + (x.T - d.t[i]) / tf * G.bw, cy = G.Y(x.p);
    if (cy < G.T0 || cy > G.pH) continue;
    const r = Math.min(18, Math.max(3, Math.sqrt(x.usd / base) * 3.5));
    g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fillStyle = (x.sell ? K.PC.up : K.PC.lo) + '73'; g.fill();
    g.strokeStyle = x.sell ? K.PC.up : K.PC.lo; g.lineWidth = 1; g.stroke();
  }
}
function drawDom() {   // the ladder: asks above, bids below, bar length = $ at that level; imbalance strip on top
  const now = performance.now(); if (now - lastDom < 200) return; lastDom = now;
  const cv = $('#bdom'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const PC = K.PC; g.font = '11px system-ui'; g.textBaseline = 'middle';
  const bk = buckets(0.03);
  if (!bk) { g.fillStyle = PC.mute; g.fillText('Загружаю стакан…', 10, 20); return; }
  const im = imbalance(), top = on('imb') ? 34 : 8, rowH = 16, rowsN = Math.floor((H - top - 6) / rowH), half = rowsN >> 1, mk = Math.round(bk.m / step);
  if (im && on('imb')) {
    const w = W - 16, bw = w * im.share;
    g.fillStyle = PC.lo; g.fillRect(8, 8, bw, 8); g.fillStyle = PC.up; g.fillRect(8 + bw, 8, w - bw, 8);
    g.fillStyle = PC.mute; g.fillText(`покупатели ${Math.round(im.share * 100)}% · продавцы ${Math.round((1 - im.share) * 100)}%`, 8, 25);
  }
  const lv = []; for (let j = -half; j <= half; j++) { const k = mk - j; lv.push({k, ask:bk.ask.get(k) || 0, bid:bk.bid.get(k) || 0}); }
  const max = Math.max(1, ...lv.map(x => Math.max(x.ask, x.bid)));
  lv.forEach((x, j) => {
    const y = top + j * rowH, v = x.ask || x.bid, isAsk = x.ask >= x.bid, w = v / max * (W - 70);
    if (v) { g.fillStyle = (isAsk ? PC.up : PC.lo) + (v / max > 0.5 ? 'cc' : '66'); g.fillRect(W - 4 - w, y + 1, w, rowH - 2); }
    g.fillStyle = x.k === mk ? PC.acc : PC.axis; g.fillText(K.fp(x.k * step).replace('$', ''), 4, y + rowH / 2);
    if (v) { g.fillStyle = PC.price; const t = fmtUsd(v), tw = g.measureText(t).width; g.fillText(t, W - 8 - tw, y + rowH / 2); }
  });
  const ym = top + half * rowH + rowH / 2; g.strokeStyle = PC.acc; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, ym); g.lineTo(W, ym); g.stroke(); g.setLineDash([]);
}
// one line of plain words under the chart: walls near the price, who is stronger in the book, the channel
function note(W) {
  const d = st.d, m = mid(); if (!d || !m) { $('#bNote').innerHTML = ''; return; }
  const parts = [], i = d.c.length - 1, up = d.B.up[i], lo = d.B.lo[i];
  const near = (side) => W.filter(w => w.side === side).sort((a, b) => Math.abs(a.price - m) - Math.abs(b.price - m))[0];
  const a = near('ask'), b = near('bid');
  if (a) parts.push(`стена продаж <b>${K.fp(a.price)}</b> (+${((a.price / m - 1) * 100).toFixed(2)}%, ${fmtUsd(a.usd)})${isFinite(up) && Math.abs(a.price - up) < (up - lo) * 0.1 ? ' — <b>у верхней границы канала</b>' : ''}`);
  if (b) parts.push(`стена покупок <b>${K.fp(b.price)}</b> (−${((1 - b.price / m) * 100).toFixed(2)}%, ${fmtUsd(b.usd)})${isFinite(lo) && Math.abs(b.price - lo) < (up - lo) * 0.1 ? ' — <b>у нижней границы канала</b>' : ''}`);
  const im = imbalance(); if (im) parts.push(`в стакане ±1% ${im.share >= 0.5 ? 'перевес покупателей' : 'перевес продавцов'} <b>${Math.round(Math.max(im.share, 1 - im.share) * 100)}%</b>`);
  $('#bNote').innerHTML = parts.length ? parts.map(p => `<span>${p}</span>`).join('') : '<span>Стакан загружается…</span>';
}
function loop() {
  if (!loopOn) return;
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

// ---------- side list: favourites, leaders, signals (from the market scan) ----------
function spark(cl) {
  if (!cl || cl.length < 2) return '';
  const mn = Math.min(...cl), mx = Math.max(...cl), up = cl[cl.length - 1] >= cl[0];
  const pts = cl.map((v, i) => `${(i / (cl.length - 1) * 64).toFixed(1)},${(24 - (mx === mn ? 12 : (v - mn) / (mx - mn) * 22) - 1).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 64 26" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? K.PC.lo : K.PC.up}" stroke-width="1.5"/></svg>`;
}
function renderList() {
  const rows = K.rows; if (!rows.length) { $('#bList').innerHTML = '<div class="mute" style="padding:12px;font-size:13px">Загружаю монеты…</div>'; return; }
  const ch = r => { const k = K.cache[r.sym]; if (!k || k.length < 97) return 0; return +k[k.length - 1][4] / +k[k.length - 97][4] - 1; };
  let list;
  if (st.list === 'fav') { list = rows.filter(r => K.favs.has(r.sym)); if (!list.length) list = rows.filter(r => M.MAJORS.includes(r.sym)); }
  else if (st.list === 'lead') list = [...rows].sort((a, b) => Math.abs(ch(b)) - Math.abs(ch(a))).slice(0, 30);
  else list = rows.filter(r => r.rev).sort((a, b) => b.score - a.score);
  $('#bList').innerHTML = (st.list === 'fav' && !rows.some(r => K.favs.has(r.sym)) ? '<div class="faint" style="padding:4px 10px 8px;font-size:12px">Избранного пока нет — звёздочка у монеты на «Рынке». Пока BTC, ETH, SOL.</div>' : '')
    + (list.map(r => { const c = ch(r), k = K.cache[r.sym];
      return `<button class="bli${r.sym === st.sym ? ' on' : ''}" data-sym="${r.sym}"><span class="bn"><b>${K.base(r.sym)}</b><span>${r.rev ? (r.side === 'low' ? '▲ сигнал LONG' : '▼ сигнал SHORT') : 'спот'}</span></span>${spark(k?.slice(-96).map(x => +x[4]))}
        <span class="bp">${K.fp(r.price)}<span class="${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c * 100).toFixed(2)}%</span></span></button>`; }).join('')
    || '<div class="mute" style="padding:12px;font-size:13px">Сейчас подтверждённых сигналов нет.</div>');
}

// ---------- indicator picker ----------
const IC = '<svg class="i"><use href="#i-sliders"/></svg>';
function renderInd() {
  const n = sel.size; ['#bIndN', '#bIndN2', '#bIndN3'].forEach(s => $(s).textContent = n);
  $('#bQuick').innerHTML = QUICK.map(id => { const it = ITEMS.find(x => x.id === id); return `<button class="ind-chip${sel.has(id) ? ' on' : ''}" data-tog="${id}">${sel.has(id) ? '✓' : '+'} ${it.name}</button>`; }).join('');
  const q = $('#bIndQ').value.trim().toLowerCase();
  $('#bCats').innerHTML = CATS.map(c => {
    const items = c.items.filter(it => !q || (it.name + ' ' + it.hint).toLowerCase().includes(q)); if (!items.length) return '';
    const cnt = items.filter(it => sel.has(it.id)).length;
    return `<details class="ind-cat"${q || cnt ? ' open' : ''}><summary>${c.name}${cnt ? ` <span class="ind-n">${cnt}</span>` : ''}</summary>`
      + items.map(it => `<div class="ind-it${sel.has(it.id) ? ' on' : ''}${it.soon ? ' soon' : ''}"><span class="ii">${IC}</span><span class="it"><b>${it.name}</b><span>${it.soon ? 'скоро · ' : ''}${it.hint}</span></span>`
        + (it.soon ? '' : `<button data-tog="${it.id}" aria-label="${sel.has(it.id) ? 'Убрать' : 'Добавить'} ${it.name}">${sel.has(it.id) ? '✓' : '+'}</button>`) + '</div>').join('') + '</details>';
  }).join('') || '<div class="mute" style="padding:12px">Ничего не нашлось.</div>';
  $('#bSel').innerHTML = [...sel].map(id => { const it = ITEMS.find(x => x.id === id); return `<div class="sel-it"><span class="${hidden.has(id) ? 'off' : ''}">${it.name}</span><button data-eye="${id}" aria-label="${hidden.has(id) ? 'Показать' : 'Скрыть'} ${it.name}" title="${hidden.has(id) ? 'Показать' : 'Скрыть'}">${hidden.has(id) ? '◌' : '◉'}</button><button data-tog="${id}" aria-label="Убрать ${it.name}">✕</button></div>`; }).join('')
    || '<div class="faint" style="font-size:13px">Ничего не выбрано — только свечи и объём.</div>';
  $('#bDomWrap').classList.toggle('hidden', !on('dom'));
}
function saveInd() { K.save('sr_bind', [...sel]); K.save('sr_bhide', [...hidden]); renderInd(); dirty = true; requestAnimationFrame(() => { dirty = true; }); }
function wire() {
  $('#bIndBtn').onclick = () => { $('#bInd').classList.remove('hidden'); renderInd(); $('#bIndQ').focus(); };
  const close = () => $('#bInd').classList.add('hidden');
  $('#bIndClose').onclick = close; $('#bInd').onclick = e => { if (e.target.id === 'bInd') close(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  $('#bIndQ').oninput = renderInd;
  $('#bIndClear').onclick = () => { sel.clear(); hidden.clear(); saveInd(); };
  $('#bInd').addEventListener('click', e => {
    const t = e.target.closest('[data-tog]')?.dataset.tog, eye = e.target.closest('[data-eye]')?.dataset.eye;
    if (t) { sel.has(t) ? (sel.delete(t), hidden.delete(t)) : sel.add(t); if (t === 'delta' && sel.has('delta')) sel.delete('cvd'); if (t === 'cvd' && sel.has('cvd')) sel.delete('delta'); saveInd(); }
    if (eye) { hidden.has(eye) ? hidden.delete(eye) : hidden.add(eye); saveInd(); }
  });
  document.querySelectorAll('#bTf .tab').forEach(b => b.onclick = () => { document.querySelectorAll('#bTf .tab').forEach(x => x.classList.toggle('on', x === b)); st.tf = b.dataset.tf; K.save('sr_btf', st.tf); restart(); });
  document.querySelectorAll('#bListTabs .tab').forEach(b => b.onclick = () => { document.querySelectorAll('#bListTabs .tab').forEach(x => x.classList.toggle('on', x === b)); st.list = b.dataset.bl; renderList(); });
  $('#bList').onclick = e => { const b = e.target.closest('[data-sym]'); if (b) setSym(b.dataset.sym); };
  $('#bSym').onkeydown = e => { if (e.key !== 'Enter') return; let v = e.target.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!v) return; if (!v.endsWith('USDT')) v += 'USDT'; e.target.value = ''; setSym(v); };
  const cv = $('#bcv');
  cv.onmousemove = e => { st.hoverI = K.hoverIndex(st.geo, cv, e); st.hoverY = e.clientY - cv.getBoundingClientRect().top; dirty = true; };
  cv.onmouseleave = () => { st.hoverI = null; st.hoverY = null; dirty = true; };
  K.attachZoom(cv, {state:() => st.d && st.geo && {n:st.d.c.length, minFrom:st.d.N - 1, defSpan:Math.min(st.d.c.length - st.d.N, Math.max(60, Math.round(cv.clientWidth / 6))), view:st.view, geo:st.geo}, set:v => { st.view = v; dirty = true; }});
  window.addEventListener('resize', () => { dirty = true; });
}
function setSym(sym) { if (sym === st.sym) return; st.sym = sym; K.save('sr_bsym', sym); restart(); renderList(); }
async function restart() {
  st.view = null; st.d = null; trades = []; tradeUsd = [];
  if (heatSym !== st.sym + st.tf) { heat = new Map(); heatSym = st.sym + st.tf; heatMs = 0; step = 0; }
  $('#bNote').innerHTML = '<span>Загружаю…</span>'; $('#bSym').placeholder = K.base(st.sym);
  try { await loadCandles(); } catch (e) { K.toast('Не удалось загрузить свечи', `${st.sym}: ${e.message || e}`, 'bad'); return; }
  if (!step) step = niceStep(st.d.c[st.d.c.length - 1]);
  if (loopOn) connect();
}

// ---------- public: called by index.html when the Beta tab opens / closes ----------
let wired = false, sampler = null;
export function open(kit) {
  K = kit;
  if (!wired) {
    wired = true;
    sel = new Set(K.load('sr_bind', ['dom', 'imb', 'heat', 'walls', 'bubbles', 'delta', 'bb'])); hidden = new Set(K.load('sr_bhide', []));
    st.tf = K.load('sr_btf', '1m'); st.sym = K.load('sr_bsym', 'BTCUSDT');
    document.querySelectorAll('#bTf .tab').forEach(b => b.classList.toggle('on', b.dataset.tf === st.tf));
    wire(); renderInd();
  }
  if (loopOn) return;
  loopOn = true; renderList();
  sampler = setInterval(() => { sampleHeat(); setLive(ws?.readyState === 1 && book?.ok ? 'ok' : 'bad'); renderList(); }, 1000);
  if (st.d) connect(); else restart();
  requestAnimationFrame(loop);
}
// leaving the tab closes the streams (no traffic in the background); the heatmap collected so far stays in memory
export function pause() { if (!loopOn) return; loopOn = false; clearInterval(sampler); disconnect(); }
