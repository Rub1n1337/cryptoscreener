// Beta: order book and order flow on top of the usual chart. Loaded only after the Beta password (see index.html).
// Everything comes straight from Binance spot in the browser: candles over REST + the kline stream, the order book as a
// REST snapshot kept current by the depth diff stream, trades from the aggTrade stream. Nothing is stored on a server yet,
// so the liquidity heatmap accumulates from the moment the tab is opened.
// Up to four charts (panes) can be shown at once; each has its own coin, timeframe, history range and streams.
// The toolbar, the order book ladder and the note under the charts belong to the active pane (blue outline).
import * as M from './supabase/functions/_shared/math.js';

let K = null;                       // toolkit from index.html (renderChart, attachZoom, api, fp, …)
const $ = s => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TFMS = {'1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '1d': 864e5};
const TFL = {'1m': '1м', '5m': '5м', '15m': '15м', '30m': '30м', '1h': '1ч', '4h': '4ч', '1d': '1д'};
const RANGES = [[0, 'авто', 'авто'], [1, '1 день', '1д'], [3, '3 дня', '3д'], [7, '7 дней', '7д'], [30, '30 дней', '30д'], [90, '90 дней', '90д'], [180, '180 дней', '180д'], [365, '1 год', '1г']];
const MAXBARS = 5000;               // candles loaded per chart at most (5 requests)
const WS = 'wss://stream.binance.com:9443/stream?streams=';
// on phones the chart buttons sit above the canvas, so the plot needs no room for them at the top
const PHONE = matchMedia('(max-width:700px)');
const DEF_SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

// ---------- indicator catalogue (the picker mirrors the "Индикаторы" window of order-flow terminals) ----------
const CATS = [
  {name:'Стакан и ликвидность', items:[
    {id:'dom', name:'Биржевой стакан', hint:'заявки по уровням — колонкой у шкалы цены'},
    {id:'imb', name:'Дисбаланс стакана', hint:'полоса у шкалы: доля покупателей и продавцов у цены'},
    {id:'heat', name:'Тепловая карта ликвидности', hint:'плотность лимитных заявок во времени'},
    {id:'walls', name:'Стены в стакане', hint:'уровни, где заявок намного больше обычного (порог — в настройках)'},
    {id:'bubbles', name:'Пузыри крупных сделок', hint:'крупные рыночные покупки и продажи'},
    {id:'flow', name:'Поток ликвидности', hint:'как быстро ставят и снимают заявки', soon:true},
  ]},
  {name:'Поток сделок', items:[
    {id:'vol', name:'Объём', hint:'панель объёма под графиком; выключите — цене достанется больше места'},
    {id:'delta', name:'Дельта объёма', hint:'нижняя панель: покупки − продажи по рынку, по свечам'},
    {id:'cvd', name:'CVD', hint:'нижняя панель: накопленная дельта объёма'},
    {id:'dtint', name:'Подсветка дельты', hint:'фон свечи: зелёный — перевес покупок по рынку, красный — продаж'},
  ]},
  {name:'Кластерный анализ', items:[
    {id:'fp', name:'Таблицы кластеров', hint:'объём по ценам внутри свечи', soon:true},
  ]},
  {name:'Профили объёма и POC', items:[
    {id:'vp', name:'Профиль объёма', hint:'объём по ценам в видимой части графика'},
    {id:'poc', name:'POC', hint:'цена с наибольшим объёмом в видимой части'},
    {id:'dpoc', name:'Динамический POC', hint:'POC с начала дня (на 4ч и 1д — недели): видно, как смещается интерес'},
    {id:'frvp', name:'Профиль участка', hint:'инструмент на панели над графиком: протяните по свечам', tool:true},
  ]},
  {name:'VWAP', items:[
    {id:'vwap', name:'VWAP по дню', hint:'средняя цена с учётом объёма с начала суток (UTC)'},
  ]},
  {name:'Цена и построения', items:[
    {id:'bb', name:'Канал Боллинджера', hint:'лог-канал, как на рынке (длина и ширина — в настройках)'},
    {id:'rsi', name:'RSI', hint:'нижняя панель: перекупленность и перепроданность'},
    {id:'fib', name:'Уровни Фибоначчи', hint:'два клика по графику', soon:true},
  ]},
];
const LOWER = ['delta', 'cvd', 'rsi'];   // one lower pane: choosing one of these replaces the other
const ITEMS = CATS.flatMap(c => c.items), QUICK = ['dom', 'imb', 'heat', 'walls', 'bubbles', 'vol', 'delta', 'cvd', 'vp', 'vwap'];
let sel, hidden, labels = true;      // chosen indicators, chosen-but-hidden ones (the eye), text labels on the chart
const on = id => sel.has(id) && !hidden.has(id);
// per-indicator settings (the gear next to a chosen indicator); values live in cfg and are saved in localStorage
const stepParam = {k:'stepX', name:'Шаг цены: уровни склеиваются в строки по', min:0.5, max:10, step:0.5, def:1, u:v => { const p = act(); return p?.base ? '$' + niceNum(p.base * v) : v + '×'; }};
const PARAMS = {
  dom:[{k:'domRows', name:'Высота строки стакана (растяните шкалу цены — строки станут мельче)', min:10, max:40, step:2, def:16, u:v => v + ' px'}],
  imb:[{k:'imbRange', name:'Зона подсчёта у цены', min:0.2, max:3, step:0.1, def:1, u:v => '±' + v + '%'}],
  heat:[stepParam, {k:'heatCut', name:'Контраст: самые яркие — верхние', min:0.5, max:20, step:0.5, def:3, u:v => v + '% уровней'}],
  walls:[{k:'domRange', name:'Искать стены в пределах', min:0.5, max:5, step:0.5, def:3, u:v => '±' + v + '%'},
    {k:'wallX', name:'Стена — во сколько раз больше обычного уровня', min:2, max:20, step:1, def:5, u:v => v + '×'},
    {k:'wallMin', name:'И не меньше', min:5e3, max:2e6, step:5e3, def:2e4, u:v => '$' + fmtUsd(v)},
    {k:'wallN', name:'Стен с каждой стороны', min:1, max:5, step:1, def:2, u:v => v}],
  bubbles:[{k:'bubPct', name:'Показывать самые крупные сделки', min:0.2, max:5, step:0.1, def:1.5, u:v => v + '% от всех'},
    {k:'bubMin', name:'И не меньше', min:1e3, max:1e6, step:1e3, def:5e3, u:v => '$' + fmtUsd(v)}],
  vp:[{k:'vpRows', name:'Строк в профиле', min:20, max:150, step:10, def:60, u:v => v},
    {k:'vpW', name:'Ширина профиля', min:10, max:50, step:5, def:22, u:v => v + '% графика'}],
  poc:[{k:'vpRows', name:'Строк в профиле (общая с профилем)', min:20, max:150, step:10, def:60, u:v => v}],
  bb:[{k:'bbN', name:'Длина канала', min:20, max:300, step:10, def:210, u:v => v + ' свечей'},
    {k:'bbK', name:'Ширина канала', min:1.5, max:4, step:0.5, def:3, u:v => v + 'σ'}],
};
const ALLP = Object.values(PARAMS).flat();
let cfg = {};
const C = k => cfg[k] ?? ALLP.find(p => p.k === k).def;

// ---------- formatting ----------
const fmtUsd = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return s + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'K' : Math.round(a)); };
const niceNum = v => v >= 1 ? +v.toFixed(2) + '' : v.toPrecision(2);
const durTxt = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + ' мин' : m < 1440 ? (m / 60).toFixed(m < 600 ? 1 : 0) + ' ч' : (m / 1440).toFixed(1) + ' д'; };
// price buckets of a "nice" size ≈ share of the price, fixed per coin so heatmap columns line up over time
const niceStep = (p, share) => { const raw = p * share, m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].find(x => x * m >= raw) * m; };
const maxDays = tf => Math.floor((MAXBARS - C('bbN') - 30) * TFMS[tf] / 864e5 * 10) / 10;

// ---------- drawings (Smart VWAP anchors, text notes): per coin, saved, with undo / redo ----------
let drawings = {}, undoS = [], redoS = [];
const drw = sym => drawings[sym] || [];
function mutate(sym, fn) {
  undoS.push({sym, prev:JSON.stringify(drw(sym))}); if (undoS.length > 100) undoS.shift(); redoS = [];
  const a = drw(sym).slice(); fn(a); drawings[sym] = a; K.save('sr_bdraw', drawings); redrawAll();
}
function undoRedo(from, to) {
  const h = from.pop(); if (!h) { K.toast(from === undoS ? 'Нечего отменять' : 'Нечего повторять', '', 'info'); return; }
  to.push({sym:h.sym, prev:JSON.stringify(drw(h.sym))}); drawings[h.sym] = JSON.parse(h.prev); K.save('sr_bdraw', drawings); redrawAll();
  if (!panes.some(p => p.sym === h.sym)) K.toast(from === undoS ? 'Отменено' : 'Повторено', `Изменение было на ${K.base(h.sym)} — сейчас эта монета не на экране.`, 'info');
}
const undo = () => undoRedo(undoS, redoS), redo = () => undoRedo(redoS, undoS);

// ---------- panes ----------
let panes = [], active = 0, layout = 1, link = true, hoverT = null, tool = null, ruler = null, loopOn = false;
const act = () => panes[active];
const redrawAll = () => panes.forEach(p => p.dirty = true);

class Pane {
  constructor(conf) {
    Object.assign(this, {sym:conf.sym, tf:TFMS[conf.tf] ? conf.tf : '5m', range:conf.range || 0, d:null, view:null, geo:null, hoverI:null, hoverY:null,
      ws:null, wsTimer:null, book:null, heat:new Map(), heatKey:'', heatMs:0, base:0, fine:0, trades:[], tradeUsd:[], dirty:true, req:0, dead:false});
    const el = this.el = document.createElement('div'); el.className = 'bpane';
    el.innerHTML = '<div class="bph"><b></b><span class="tfl"></span><span class="lg"></span><span class="bpx"></span></div><div class="cvwrap"><canvas class="bcv" tabindex="0" aria-label="График беты: свечи, стакан и сделки"></canvas></div>';
    $('#bPanes').appendChild(el); this.cv = el.querySelector('canvas');
    el.addEventListener('pointerdown', () => setActive(panes.indexOf(this)), true);
    el.addEventListener('focusin', () => setActive(panes.indexOf(this)));   // Tab to a chart makes it the active one too
    const cv = this.cv;
    cv.addEventListener('mousemove', e => {
      this.hoverI = K.hoverIndex(this.geo, cv, e); this.hoverY = e.clientY - cv.getBoundingClientRect().top; this.dirty = true;
      if (!e.buttons) cv.style.cursor = !tool && this.hitAt(e) ? 'pointer' : '';
      if (link && this.d && this.hoverI != null) { hoverT = {src:this, t:this.d.t[clamp(this.hoverI, 0, this.d.t.length - 1)]}; panes.forEach(q => { if (q !== this) q.dirty = true; }); }
      if (ruler?.live && ruler.pane === this) { const pt = this.pointAt(e); if (pt) ruler.b = pt; }
    });
    cv.addEventListener('mouseleave', () => { this.hoverI = this.hoverY = null; hoverT = null; redrawAll(); });
    cv.addEventListener('touchmove', e => { if (this.yDrag?.scale && e.touches.length === 1) { e.preventDefault(); const f = Math.exp((e.touches[0].clientY - this.yDrag.y0) / 160), c = (this.yDrag.mn + this.yDrag.mx) / 2, h = (this.yDrag.mx - this.yDrag.mn) / 2 * f; this.setY({mn:c - h, mx:c + h}); return; }
      if (ruler?.live && ruler.pane === this) { e.preventDefault(); const pt = this.pointAt(e.touches[0]); if (pt) { ruler.b = pt; this.dirty = true; } } }, {passive:false});
    this.zs = K.attachZoom(cv, {
      state:() => !this.dead && this.d && this.geo && {n:this.d.c.length, minFrom:this.d.N - 1, defSpan:this.defSpan(), view:this.view, geo:this.geo},
      set:v => { this.setView(v, true); if (v === null) this.setY(null); }, pick:e => this.pick(e),
      tools:'<button data-z="yauto" class="ct-yauto" title="Вернуть автомасштаб цены (A, двойной клик по шкале)" aria-label="Автомасштаб цены"><svg class="i"><use href="#i-scale"/></svg><span>авто</span></button><button data-z="help" title="Как управлять графиком" aria-label="Как управлять графиком"><svg class="i"><use href="#i-help"/></svg></button>',
      onTool:(z, b) => { if (z === 'yauto') this.setY(null); if (z === 'help') popFor === b ? closePop() : helpPop(b); },
      key:k => { const t = {r:'ruler', 'к':'ruler', v:'avwap', 'м':'avwap', t:'note', 'е':'note', p:'frvp', 'з':'frvp'}[k]; if (k === 'a' || k === 'ф') { this.setY(null); return true; } if (!t) return false; setTool(tool === t ? null : t); return true; }});
    // the price scale: drag it up / down to stretch / squash the candles, wheel over it does the same;
    // once the scale is manual, dragging the chart also moves it up and down; "A" or a double click goes back to auto
    cv.addEventListener('wheel', e => {
      if (!this.inScale(e) || !this.geo) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.zoomY(e.deltaY > 0 ? 1.12 : 1 / 1.12, e);
    }, {passive:false, capture:true});
    window.addEventListener('mousemove', e => {
      const y = this.yDrag; if (!y || !this.geo) return;
      const dy = e.clientY - y.y0, g = this.geo;
      if (y.scale) { const f = Math.exp(dy / 160), c = (y.mn + y.mx) / 2, h = (y.mx - y.mn) / 2 * f; this.setY({mn:c - h, mx:c + h}); }
      else { const sh = dy / g.ph * (y.mx - y.mn); this.setY({mn:y.mn + sh, mx:y.mx + sh}); }
    });
    window.addEventListener('mouseup', () => { this.yDrag = null; }); window.addEventListener('touchend', () => { this.yDrag = null; });
    cv.addEventListener('dblclick', e => { if (this.inScale(e)) this.setY(null); });
    cv.addEventListener('mousemove', e => { if (!e.buttons && !tool && this.inScale(e)) cv.style.cursor = 'ns-resize'; });
    this.label();
  }
  inScale(e) { const g = this.geo; if (!g) return false; const x = e.clientX - this.cv.getBoundingClientRect().left; return x > g.W - g.padR + this.rc && x < g.W; }
  setY(r) {
    if (r && !(r.mx > r.mn)) return;
    this.yr = r; this.dirty = true; this.el.querySelector('.ct-yauto')?.classList.toggle('show', !!r);
  }
  zoomY(f, e) {   // around the price under the cursor
    const g = this.geo, cur = this.yr || {mn:g.mn, mx:g.mx}, y = e.clientY - this.cv.getBoundingClientRect().top;
    const p = clamp(cur.mx - (y - g.T0) / g.ph * (cur.mx - cur.mn), cur.mn, cur.mx);
    this.setY({mn:p - (p - cur.mn) * f, mx:p + (cur.mx - p) * f});
  }
  label() { this.el.querySelector('.bph b').textContent = K.base(this.sym); this.el.querySelector('.bph .tfl').textContent =TFL[this.tf] + (this.range ? ' · ' + RANGES.find(r => r[0] === this.range)[2] : ''); }
  defSpan() {
    const avail = this.d.c.length - this.d.N;
    return this.range ? clamp(Math.round(this.range * 864e5 / TFMS[this.tf]), 20, avail) : Math.min(avail, Math.max(60, Math.round(this.cv.clientWidth / 6)));
  }
  // zoom / pan; when charts move together, the others get the same time window (whatever their timeframe)
  setView(v, spread) {
    this.view = v; this.dirty = true;
    if (!spread || !link || !this.d) return;
    const tf = TFMS[this.tf], n = this.d.c.length;
    for (const q of panes) {
      if (q === this || !q.d) continue;
      if (!v) { q.view = null; } else {
        // the same right edge in time, measured by candle closes (opens differ between timeframes: a 1h candle opened up to
        // an hour ago), and never more empty space on the right than a sliver
        const qtf = TFMS[q.tf], qn = q.d.c.length, right = this.d.t[n - 1] + tf - v.endOff * tf, span = Math.max(20, Math.round(v.span * tf / qtf));
        q.view = {span, endOff:Math.max(-Math.round(span * 0.12), Math.round((q.d.t[qn - 1] + qtf - right) / qtf))};
      }
      q.dirty = true; q.zs.sync();
    }
  }
  hitAt(e) {
    const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return (this.hits || []).find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
  }
  pointAt(e) {
    if (!this.geo || !this.d) return null;
    const p = K.priceAt(this.geo, this.cv, e); if (p == null) return null;
    const n = this.d.c.length, i = clamp(K.hoverIndex(this.geo, this.cv, e), 0, n - 1);
    return {i, t:this.d.t[i], p};
  }
  // a press on the chart: tools take it first; otherwise a finished ruler is cleared and the press pans the chart
  pick(e) {
    if (e.button === undefined || e.button === 0) {   // a press on the price scale scales the price; with a manual scale, a press on the chart also pans it vertically
      if (this.inScale(e) && this.geo) { const r = this.yr || {mn:this.geo.mn, mx:this.geo.mx}; this.yDrag = {y0:e.clientY, ...r, scale:true}; return true; }
      if (!tool && this.yr && e instanceof MouseEvent && !this.hitAt(e)) this.yDrag = {y0:e.clientY, ...this.yr};
    }
    if (!tool) {
      const h = this.hitAt(e); if (h) { const x = e.clientX, y = e.clientY; setTimeout(() => objPop(this, h.obj, x, y)); return true; }
      if (ruler && !ruler.live) { ruler = null; redrawAll(); }
      return false;
    }
    const pt = this.pointAt(e); if (!pt) return true;
    if (tool === 'ruler' || tool === 'frvp') { ruler = {pane:this, a:pt, b:pt, live:true, kind:tool}; this.dirty = true; return true; }
    if (tool === 'avwap') { mutate(this.sym, a => a.push({type:'avwap', t:pt.t})); setTool(null); return true; }
    if (tool === 'note') { const x = e.clientX, y = e.clientY; setTool(null); setTimeout(() => notePop(this, pt, x, y)); return true; }
    return true;
  }

  // ---------- candles ----------
  async load() {
    const req = ++this.req, tf = TFMS[this.tf];
    const want = this.range ? Math.ceil(this.range * 864e5 / tf) + C('bbN') + 30 : 500, total = clamp(want, 300, MAXBARS);
    let rows = [], end = null;
    while (rows.length < total) {   // Binance gives at most 1000 candles per request: page backwards
      const lim = Math.min(1000, total - rows.length);
      const k = await K.api(`/api/v3/klines?symbol=${this.sym}&interval=${this.tf}&limit=${lim}${end ? '&endTime=' + end : ''}`);
      if (req !== this.req) return false;
      if (!k.length) break;
      rows = k.concat(rows); end = k[0][0] - 1; if (k.length < lim) break;
    }
    if (!rows.length) throw new Error('нет свечей');
    const d = M.parse(rows); d.qv = rows.map(x => +x[7]); d.tbq = rows.map(x => +x[10]);   // quote volume and taker-buy quote volume
    this.d = d; calc(d); this.dirty = true; return true;
  }
  onKline(k) {   // live candle from the stream: update the forming bar or start a new one
    const d = this.d; if (!d) return;
    const T = k.t, i = d.t.length - 1, v = [+k.o, +k.h, +k.l, +k.c, +k.v, +k.q, +k.Q];
    if (T === d.t[i]) { [d.o[i], d.h[i], d.l[i], d.c[i], d.v[i], d.qv[i], d.tbq[i]] = v; }
    else if (T > d.t[i]) { d.t.push(T); d.o.push(v[0]); d.h.push(v[1]); d.l.push(v[2]); d.c.push(v[3]); d.v.push(v[4]); d.qv.push(v[5]); d.tbq.push(v[6]); }
    calc(d); this.dirty = true;
  }

  // ---------- order book: snapshot + diff stream (Binance's documented sync procedure) ----------
  mid() {
    const b = this.book; if (!b) return this.d ? this.d.c[this.d.c.length - 1] : null;
    let bb = 0, ba = Infinity; for (const p of b.bids.keys()) if (p > bb) bb = p; for (const p of b.asks.keys()) if (p < ba) ba = p;
    return isFinite(ba) && bb ? (bb + ba) / 2 : null;
  }
  get step() { return this.base * C('stepX'); }
  buckets(range, step = this.step) {   // {key: usd} for bids and asks within ±range of the middle
    const m = this.mid(); if (!this.book || !m || !step) return null;
    const bid = new Map(), ask = new Map();
    for (const [p, q] of this.book.bids) if (p >= m * (1 - range)) { const k = Math.round(p / step); bid.set(k, (bid.get(k) || 0) + p * q); }
    for (const [p, q] of this.book.asks) if (p <= m * (1 + range)) { const k = Math.round(p / step); ask.set(k, (ask.get(k) || 0) + p * q); }
    return {m, bid, ask, step};
  }
  // every second the current book is folded into the bar it belongs to (max per fine bucket), building the heatmap
  sampleHeat() {
    // the big-trade threshold (top N% of recent trades) is refreshed here once a second, not sorted on every trade
    if (this.tradeUsd.length >= 50) { const s = [...this.tradeUsd].sort((a, b) => a - b); this.thr = s[Math.floor(s.length * (1 - C('bubPct') / 100))]; }
    if (!this.book?.ok || !this.d) return;
    this.heatMs += 1000;
    const bk = this.buckets(0.04, this.fine); if (!bk) return;
    const tf = TFMS[this.tf], bar = Math.floor(Date.now() / tf) * tf;
    let col = this.heat.get(bar); if (!col) this.heat.set(bar, col = new Map());
    for (const src of [bk.bid, bk.ask]) for (const [k, v] of src) if (v > (col.get(k) || 0)) col.set(k, v);
    if (this.heat.size > 1500) this.heat.delete(this.heat.keys().next().value);
  }
  walls() {   // the strongest buckets on each side, several times the typical bucket
    const bk = this.buckets(C('domRange') / 100); if (!bk) return [];
    const all = [...bk.bid.values(), ...bk.ask.values()].sort((a, b) => a - b), med = all[all.length >> 1] || 0;
    const pick = (m, side) => [...m].filter(([, v]) => v >= med * C('wallX') && v >= C('wallMin')).sort((a, b) => b[1] - a[1]).slice(0, C('wallN')).map(([k, v]) => ({price:k * bk.step, usd:v, side}));
    return [...pick(bk.ask, 'ask'), ...pick(bk.bid, 'bid')];
  }
  imbalance(range = C('imbRange') / 100) {
    const bk = this.buckets(range); if (!bk) return null;
    const b = [...bk.bid.values()].reduce((a, x) => a + x, 0), a = [...bk.ask.values()].reduce((s, x) => s + x, 0);
    return b + a ? {bid:b, ask:a, share:b / (a + b)} : null;
  }
  onTrade(x) {   // big market buys / sells: the top N% of recent trades
    const usd = +x.p * +x.q;
    this.tradeUsd.push(usd); if (this.tradeUsd.length > 2000) this.tradeUsd.shift();
    if (usd >= Math.max(C('bubMin'), this.thr || Infinity)) { this.trades.push({T:x.T, p:+x.p, usd, sell:x.m}); if (this.trades.length > 600) this.trades.shift(); this.dirty = true; }
  }

  // ---------- stream ----------
  connect() {
    this.disconnect();
    const s = this.sym.toLowerCase(), buffer = [];
    const ws = this.ws = new WebSocket(WS + [`${s}@depth@100ms`, `${s}@aggTrade`, `${s}@kline_${this.tf}`].join('/'));
    this.book = null; let syncing = false;
    // Binance's procedure: buffer the diff stream, take a snapshot, then apply the buffered events newer than it.
    // One sync at a time per chart, snapshots spaced out across charts, growing pauses after failures —
    // a snapshot is expensive (the 5000-level one costs 250 of the 6000 request weight per minute)
    const resync = async () => {
      if (syncing || ws !== this.ws) return;
      syncing = true; this.book = null;
      try {
        await snapGate(); if (ws !== this.ws) return;
        const snap = await K.api(`/api/v3/depth?symbol=${this.sym}&limit=${this === act() ? 5000 : 1000}`); if (ws !== this.ws) return;
        const b = {bids:new Map(snap.bids.map(([p, q]) => [+p, +q])), asks:new Map(snap.asks.map(([p, q]) => [+p, +q])), id:snap.lastUpdateId, ok:false};
        for (const ev of buffer.splice(0)) if (!applyDepth(b, ev)) throw new Error('snapshot older than the stream');
        this.book = b; this.fails = 0; syncing = false;
      } catch {
        syncing = false; if (ws !== this.ws) return;
        this.fails = (this.fails || 0) + 1;
        clearTimeout(this.syncTimer); this.syncTimer = setTimeout(resync, Math.min(60e3, 1500 * 2 ** this.fails));
      }
    };
    ws.onmessage = e => {
      this.wsFails = 0;
      const {stream, data} = JSON.parse(e.data);
      if (stream.endsWith('@aggTrade')) return this.onTrade(data);
      if (stream.includes('@kline_')) return this.onKline(data.k);
      if (!this.book) { buffer.push(data); if (buffer.length > 3000) buffer.shift(); return; }
      if (!applyDepth(this.book, data)) { buffer.length = 0; buffer.push(data); resync(); }   // a gap: start over from a fresh snapshot
    };
    ws.onopen = resync;
    ws.onclose = () => {   // reconnect while the tab is open, waiting longer after each failed attempt
      if (!loopOn || this.dead) return;
      this.wsFails = (this.wsFails || 0) + 1;
      clearTimeout(this.wsTimer); this.wsTimer = setTimeout(() => this.connect(), Math.min(60e3, 3000 * 2 ** (this.wsFails - 1)));
    };
  }
  disconnect() { clearTimeout(this.wsTimer); clearTimeout(this.syncTimer); if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } }
  live() { return this.ws?.readyState === 1 && this.book?.ok; }
  async restart() {
    // the old coin's streams stop first, so its book and trades never mix with the new coin's candles
    this.disconnect(); this.book = null; this.view = null; this.setY(null); this.d = null; this.trades = []; this.tradeUsd = []; this.thr = 0; this.label();
    if (ruler?.pane === this) ruler = null;
    const key = this.sym + this.tf; if (this.heatKey !== key) { this.heat = new Map(); this.heatKey = key; this.heatMs = 0; this.base = 0; }
    if (this === act()) { $('#bNote').innerHTML = '<span>Загружаю…</span>'; $('#bSym').placeholder = K.base(this.sym); }
    this.dirty = true;
    try { if (!await this.load()) return; }
    catch (e) {
      // a mistyped coin: go back to the previous one instead of leaving an empty chart (and saving it)
      const bad = this.sym, back = this.prevSym; this.prevSym = null;
      K.toast(back ? `Монеты ${K.base(bad)} нет на споте Binance` : 'Не удалось загрузить свечи', back ? `Вернул ${K.base(back)}. Пишите тикер, например SOL или PEPE.` : `${bad}: ${e.message || e}`, 'bad');
      if (back) { this.sym = back; savePanes(); renderList(); this.restart(); }
      return;
    }
    this.prevSym = null;
    if (!this.base) { const p = this.d.c[this.d.c.length - 1]; this.base = niceStep(p, 0.0005); this.fine = niceStep(p, 0.00025); }
    if (loopOn && !this.el.classList.contains('hidden')) this.connect();
  }
  destroy() { this.dead = true; this.disconnect(); this.el.remove(); }

  // ---------- drawing ----------
  draw() {
    const d = this.d; if (!d) return;
    const n = d.c.length, r = K.viewRange(n, d.N - 1, this.view, this.defSpan()), PC = K.PC;
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, r.from); i <= Math.min(n - 1, r.to); i++) { lo = Math.min(lo, d.l[i]); hi = Math.max(hi, d.h[i]); }
    if (this.yr) { lo = this.yr.mn; hi = this.yr.mx; }   // a manual price scale decides what is visible
    const sl = this.yr ? 0 : 0.002, W = this.lastWalls = this.walls().filter(w => w.price >= lo * (1 - sl) && w.price <= hi * (1 + sl));   // only walls inside the visible range, so they don't squash the candles
    const cw0 = this.cv.clientWidth, narrow = cw0 < 520;   // phones: walls stay as lines and in the book column, without tags on the scale   // on narrow charts a wall tag is just its size (the colour tells the side)
    const wi0 = Math.max(r.from, n - 1 - Math.round((r.to - r.from) * 0.3));   // wall lines only over the recent third: the book column shows them in full
    const levels = on('walls') ? W.map(w => ({v:w.price, i0:wi0, noTag:cw0 < 420 && on('dom'), col:w.side === 'ask' ? PC.up : PC.lo, tag:!labels ? '' : narrow ? fmtUsd(w.usd) : `стена ${fmtUsd(w.usd)}`})) : [];
    const noBand = Array(n).fill(NaN), B = on('bb') ? d.B : {up:noBand, lo:noBand, mid:noBand, z:noBand};
    // the lower pane holds one of delta / CVD / RSI (they replace each other in the picker); empty says how to fill it
    const sub = on('delta') ? {label:'Дельта объёма, $', values:d.delta, kind:'bars', fmt:fmtUsd} : on('cvd') ? {label:'CVD, $', values:d.cvd, kind:'line', fmt:fmtUsd}
      : null;   // RSI, or nothing at all (the price then takes the room)
    // the crosshair of the chart under the mouse is mirrored on the others at the same time (just the line and the time)
    this.hits = [];   // clickable drawings (notes, VWAP anchors), filled while drawing
    let hI = this.hoverI, hY = this.hoverY, mirror = false;
    if (ruler?.pane === this) hI = null;   // the candle tooltip would cover the ruler's label
    else if (hoverT && hoverT.src !== this && link) { hI = hoverT.t >= d.t[0] && hoverT.t < d.t[n - 1] + TFMS[this.tf] ? K.barAt(d.t, hoverT.t) : null; hY = null; mirror = true; }
    // VWAP lines get their value as a tag on the price scale (a text label next to the line collided with the price tags)
    const e = Math.min(n - 1, r.to), av = drw(this.sym).filter(x => x.type === 'avwap' && x.t >= d.t[0]).map(x => ({x, arr:avwap(d, x.t)}));
    const tags = [...(on('vwap') && isFinite(d.vwap[e]) ? [{v:d.vwap[e], text:(labels ? 'VWAP ' : '') + K.fp(d.vwap[e]), col:PC.acc, pin:true}] : []),
      ...av.filter(a => isFinite(a.arr[e])).map(a => ({v:a.arr[e], text:(labels ? 'VWAP⚓ ' : '') + K.fp(a.arr[e]), col:PC.trade, pin:true})),
      ...(on('dpoc') && isFinite(d.dpoc[e]) ? [{v:d.dpoc[e], text:(labels ? 'dPOC ' : '') + K.fp(d.dpoc[e]), col:PC.rsi, pin:true}] : [])];
    const cw = this.cv.clientWidth; this.rc = on('dom') ? (cw < 400 ? 40 : cw < 520 ? 52 : 68) : on('imb') ? 34 : 0;   // the order book column at the price scale
    this.geo = K.renderChart(this.cv, {...d, B}, {from:r.from, to:r.to, levels, tags, live:true, hoverI:hI, hoverY:hY, hoverLine:mirror, top:PHONE.matches ? 10 : 44, sub, vol:on('vol'), lower:!!sub || on('rsi'), noTip:true, vgrid:true,
      priceCol:d.c[n - 1] >= d.o[n - 1] ? PC.lo : PC.up, priceSub:this.countdown(), fitPrice:true, thin:true,
      rightCol:this.rc, yRange:this.yr, crossPct:true,
      under:(g, G) => { if (on('dtint')) this.drawTint(g, G); if (on('heat')) this.drawHeat(g, G); if (on('vp') || on('poc')) this.drawProfile(g, G); },
      over:(g, G) => {
        if (on('vwap')) drawLine(g, G, d.vwap, PC.acc, [6, 3]);
        for (const a of av) this.drawAvwap(g, G, a);
        if (on('dpoc')) drawStep(g, G, d.dpoc, PC.rsi);
        for (const x of drw(this.sym)) if (x.type === 'frvp') this.drawFrvp(g, G, x);
        if (this.rc) this.drawBook(g, G);
        if (on('bubbles')) this.drawBubbles(g, G);
        this.drawNotes(g, G);
        if (ruler?.pane === this) this.drawRuler(g, G);
        if (labels && on('heat') && this.heatMs < 15 * 6e4) {   // the heatmap only has what was collected while the tab was open: say so
          const m = Math.floor(this.heatMs / 6e4), t = this.book?.ok ? `карта копится · ${m} мин` : 'стакан загружается…';
          g.font = '11px system-ui'; g.textBaseline = 'middle'; g.fillStyle = PC.mute; g.fillText(t, Math.max(G.padL + 4, G.X(G.e) - G.bw - 8 - g.measureText(t).width), G.T0 + 8);
        }
      }});
    this.el.querySelector('.bpx').textContent = K.fp(d.c[n - 1]);
    // the header doubles as the legend: the candle under the cursor (or the last one), instead of a box over the candles
    const li = hI != null && hI >= 0 && hI < n ? hI : n - 1, chg = (d.c[li] / d.o[li] - 1) * 100, np = x => K.fp(x).replace('$', '');
    const lg = `<i>O</i>${np(d.o[li])} <i>H</i>${np(d.h[li])} <i>L</i>${np(d.l[li])} <i>C</i>${np(d.c[li])} <span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(2)}%</span>`
      + ` <i>об.</i>$${fmtUsd(d.qv[li])} <i>Δ</i><span class="${d.delta[li] >= 0 ? 'pos' : 'neg'}">${d.delta[li] >= 0 ? '+' : ''}${fmtUsd(d.delta[li])}</span>`;
    if (lg !== this.lgHtml) { this.lgHtml = lg; this.el.querySelector('.lg').innerHTML = lg; }
    if (this === act()) this.note(W);
  }
  // time left until the current candle closes; shown inside the live price tag (as on order-flow terminals)
  countdown() {
    const d = this.d, left = d.t[d.t.length - 1] + TFMS[this.tf] - Date.now(); if (left <= 0) return '';
    const s = Math.floor(left / 1000), dd = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    return dd ? `${dd}д ${hh}ч` : (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  }
  drawHeat(g, G) {   // fine buckets are summed into the display step; the result is cached (mouse moves redraw often)
    const d = this.d, step = this.step; if (!step || !this.fine) return;
    const key = `${G.s}|${G.e}|${step}|${C('heatCut')}|${d.t[G.e]}`, now = performance.now(), hc = this.hc;
    let cols, top;
    if (hc && hc.key === key && now - hc.at < 1000) ({cols, top} = hc);
    else {
      cols = [];
      for (let i = G.s; i <= G.e; i++) {
        const col = this.heat.get(d.t[i]); if (!col) continue;
        const agg = new Map(); for (const [k, v] of col) { const kk = Math.round(k * this.fine / step); agg.set(kk, (agg.get(kk) || 0) + v); }
        cols.push([i, agg]);
      }
      // one or two collected candles would only be a coloured stripe on the last bar: wait for a few
      const vals = cols.flatMap(([, a]) => [...a.values()]); if (!vals.length || cols.length < 3) { this.hc = null; return; }
      vals.sort((a, b) => a - b); top = vals[Math.floor(vals.length * (1 - C('heatCut') / 100))] || vals[vals.length - 1];
      this.hc = {key, at:now, cols, top};
    }
    const h = Math.max(1, Math.abs(G.Y(0) - G.Y(step)));
    for (const [i, agg] of cols) {
      const x = G.X(i) - G.bw / 2;
      for (const [k, v] of agg) { if (v < top * 0.12) continue; const y = G.Y(k * step); if (y < G.T0 || y > G.pH) continue; g.fillStyle = heatColor(v / top); g.fillRect(x, y - h / 2, G.bw + 0.5, h); }
    }
  }
  drawProfile(g, G) {   // volume by price over the visible bars, drawn from the right edge of the plot
    const d = this.d, rows = C('vpRows'), lo = G.mn, hi = G.mx, sz = (hi - lo) / rows, vp = Array(rows).fill(0);
    for (let i = G.s; i <= G.e; i++) {
      const a = Math.max(0, Math.floor((d.l[i] - lo) / sz)), b = Math.min(rows - 1, Math.floor((d.h[i] - lo) / sz)), share = d.v[i] / (b - a + 1);
      for (let k = a; k <= b; k++) vp[k] += share;
    }
    const max = Math.max(...vp), poc = vp.indexOf(max), wMax = (G.W - G.padL - G.padR) * C('vpW') / 100, x1 = G.W - G.padR;
    if (on('vp')) for (let k = 0; k < rows; k++) {
      const y0 = G.Y(lo + (k + 1) * sz), y1 = G.Y(lo + k * sz), w = vp[k] / max * wMax;
      g.fillStyle = k === poc ? K.PC.acc + '55' : K.PC.mid + '33'; g.fillRect(x1 - w, y0, w, Math.max(1, y1 - y0 - 1));
    }
    if (on('poc')) { const y = G.Y(lo + (poc + 0.5) * sz); g.strokeStyle = K.PC.acc; g.lineWidth = 1.2; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(G.padL, y); g.lineTo(x1, y); g.stroke(); g.setLineDash([]); if (labels) { g.fillStyle = K.PC.acc; g.fillText('POC', G.padL + 4, y - 7); } }
  }
  drawBubbles(g, G) {
    const d = this.d, tf = TFMS[this.tf], first = d.t[G.s], last = d.t[G.e] + tf;
    const vis = this.trades.filter(x => x.T >= first && x.T < last); if (!vis.length) return;
    const base = Math.min(...vis.map(x => x.usd));
    for (const x of vis) {
      const i = K.barAt(d.t, x.T), cx = G.X(i) - G.bw / 2 + (x.T - d.t[i]) / tf * G.bw, cy = G.Y(x.p);
      if (cy < G.T0 || cy > G.pH) continue;
      const r = Math.min(13, Math.max(2.5, Math.sqrt(x.usd / base) * 3));
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fillStyle = (x.sell ? K.PC.up : K.PC.lo) + '40'; g.fill();
      g.strokeStyle = x.sell ? K.PC.up : K.PC.lo; g.lineWidth = 1; g.stroke();
    }
  }
  drawAvwap(g, G, {x, arr}) {   // VWAP accumulated from the chosen candle on, with a dot at the anchor
    const d = this.d, i0 = K.barAt(d.t, x.t), PC = K.PC;
    drawLine(g, G, arr, PC.trade);
    const y0 = G.Y(arr[i0]); if (i0 >= G.s && i0 <= G.e && y0 >= G.T0 && y0 <= G.pH) { g.beginPath(); g.arc(G.X(i0), y0, 4, 0, 7); g.fillStyle = PC.trade; g.fill(); g.strokeStyle = PC.canvas; g.lineWidth = 1.5; g.stroke(); this.hits.push({x0:G.X(i0) - 9, x1:G.X(i0) + 9, y0:y0 - 9, y1:y0 + 9, obj:x}); }
  }
  drawTint(g, G) {   // candle background by who won the bar: market buys (green) or sells (red), stronger = brighter
    const d = this.d, PC = K.PC;
    for (let i = G.s; i <= G.e; i++) {
      const r = d.qv[i] ? d.delta[i] / d.qv[i] : 0, a = Math.min(0.08, Math.max(0, Math.abs(r) - 0.1) * 0.3); if (a < 0.015) continue;   // only clear wins are tinted
      g.globalAlpha = a; g.fillStyle = r > 0 ? PC.lo : PC.up; g.fillRect(G.X(i) - G.bw / 2, G.T0, G.bw + 0.5, G.pH - G.T0);
    }
    g.globalAlpha = 1;
  }
  // fixed-range volume profile: volume by price over the chosen candles, bars from the left edge of the range, POC line across
  drawFrvp(g, G, x) {
    const d = this.d, PC = K.PC; if (x.t1 < d.t[0] || x.t0 > d.t[d.c.length - 1]) return;
    const i0 = K.barAt(d.t, Math.max(x.t0, d.t[0])), i1 = K.barAt(d.t, x.t1); if (i1 < G.s || i0 > G.e || i1 <= i0) return;
    let lo = Infinity, hi = -Infinity, vol = 0; for (let i = i0; i <= i1; i++) { lo = Math.min(lo, d.l[i]); hi = Math.max(hi, d.h[i]); vol += d.qv[i]; }
    const rows = 40, sz = (hi - lo) / rows || 1, vp = Array(rows).fill(0);
    for (let i = i0; i <= i1; i++) { const a = clamp(Math.floor((d.l[i] - lo) / sz), 0, rows - 1), b = clamp(Math.floor((d.h[i] - lo) / sz), 0, rows - 1), sh = d.v[i] / (b - a + 1); for (let k = a; k <= b; k++) vp[k] += sh; }
    const max = Math.max(...vp), poc = vp.indexOf(max), xa = G.X(i0) - G.bw / 2, xb = G.X(i1) + G.bw / 2, wMax = (xb - xa) * 0.6;
    g.save(); g.beginPath(); g.rect(G.padL, G.T0, G.W - G.padL - G.padR, G.pH - G.T0); g.clip();
    g.fillStyle = PC.rsi + '10'; g.fillRect(xa, G.Y(hi), xb - xa, G.Y(lo) - G.Y(hi)); g.strokeStyle = PC.rsi + '66'; g.lineWidth = 1; g.strokeRect(xa, G.Y(hi), xb - xa, G.Y(lo) - G.Y(hi));
    for (let k = 0; k < rows; k++) { const y0 = G.Y(lo + (k + 1) * sz), y1 = G.Y(lo + k * sz); g.fillStyle = k === poc ? PC.acc + '99' : PC.rsi + '44'; g.fillRect(xa, y0, vp[k] / max * wMax, Math.max(1, y1 - y0 - 1)); }
    const yp = G.Y(lo + (poc + 0.5) * sz); g.strokeStyle = PC.acc; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xa, yp); g.lineTo(xb, yp); g.stroke(); g.setLineDash([]);
    g.restore();
    const lbl = `Профиль · ${i1 - i0 + 1} св. · POC ${K.fp(lo + (poc + 0.5) * sz)} · $${fmtUsd(vol)}`; g.font = '600 11px system-ui'; g.textBaseline = 'middle';
    const lw = g.measureText(lbl).width + 10, ly = Math.max(G.T0 + 9, G.Y(hi) - 10);
    g.fillStyle = PC.tip; g.fillRect(xa, ly - 9, lw, 18); g.fillStyle = PC.rsi; g.fillText(lbl, xa + 5, ly); g.font = '11px system-ui';
    this.hits.push({x0:xa, x1:xa + lw, y0:ly - 9, y1:ly + 9, obj:x});
  }
  drawNotes(g, G) {
    const d = this.d, PC = K.PC;
    for (const x of drw(this.sym)) {
      if (x.type !== 'note' || x.t < d.t[0] || x.t > d.t[d.c.length - 1]) continue;
      const i = K.barAt(d.t, x.t); if (i < G.s || i > G.e) continue;
      const cx = G.X(i), cy = G.Y(x.p); if (cy < G.T0 || cy > G.pH) continue;
      const col = PC[x.col] || PC.acc; g.font = '600 12px system-ui'; g.textBaseline = 'middle';
      const w = g.measureText(x.text).width, lx = cx + 10 + w > G.W - G.padR ? cx - 14 - w : cx + 10;
      g.beginPath(); g.arc(cx, cy, 3.5, 0, 7); g.fillStyle = col; g.fill();
      g.fillStyle = PC.tip; g.fillRect(lx - 5, cy - 10, w + 10, 20); g.fillStyle = col; g.fillRect(lx - 5, cy - 10, 3, 20);
      g.fillStyle = PC.price; g.fillText(x.text, lx + 1, cy); g.font = '11px system-ui';
      this.hits.push({x0:Math.min(cx - 6, lx - 5), x1:Math.max(cx + 6, lx + w + 5), y0:cy - 11, y1:cy + 11, obj:x});
    }
  }
  drawRuler(g, G) {   // a box from A to B with the move in %, in $, in candles and in time
    const {a, b} = ruler, d = this.d, PC = K.PC, x0 = G.X(a.i), x1 = G.X(b.i), y0 = G.Y(a.p), y1 = G.Y(b.p);
    if (ruler.kind === 'frvp') {   // while dragging a range: a band over the chosen candles
      const xa = Math.min(x0, x1) - G.bw / 2, xb = Math.max(x0, x1) + G.bw / 2, t = `Профиль · ${Math.abs(b.i - a.i) + 1} свеч.`;
      g.fillStyle = PC.rsi + '1c'; g.fillRect(xa, G.T0, xb - xa, G.pH - G.T0); g.strokeStyle = PC.rsi; g.lineWidth = 1; g.strokeRect(xa, G.T0, xb - xa, G.pH - G.T0);
      g.font = '600 12px system-ui'; g.textBaseline = 'middle'; g.fillStyle = PC.rsi; g.fillText(t, xa + 6, G.T0 + 12); return;
    }
    const up = b.p >= a.p, col = up ? PC.lo : PC.up, bars = b.i - a.i, pct = (b.p / a.p - 1) * 100;
    g.fillStyle = col + '22'; g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || 1, Math.abs(y1 - y0) || 1);
    g.strokeStyle = col; g.lineWidth = 1.2; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]);
    const l1 = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%  (${pct >= 0 ? '+' : '−'}${K.fp(Math.abs(b.p - a.p))})`, l2 = `${Math.abs(bars)} свеч. · ${durTxt(Math.abs(bars) * TFMS[this.tf])}`;
    g.font = '600 12px system-ui'; const w = Math.max(g.measureText(l1).width, g.measureText(l2).width) + 16;
    const bx = clamp(x1 - w / 2, G.padL, G.W - G.padR - w), by = clamp(up ? y1 - 46 : y1 + 8, G.T0, G.pH - 40);
    g.fillStyle = col; g.fillRect(bx, by, w, 38); g.fillStyle = PC.canvas; g.textBaseline = 'middle';
    g.fillText(l1, bx + 8, by + 11); g.font = '11px system-ui'; g.fillText(l2, bx + 8, by + 27);
  }
  // the order book at the price scale (as on order-flow terminals): one row per price step that fits ~domRows px,
  // so stretching the price scale shows finer levels; the strip at the right edge is the imbalance near the price
  drawBook(g, G) {
    const PC = K.PC, x0 = G.W - G.padR, cw = this.rc, ph = G.pH - G.T0, m = this.mid();
    // a faint lane, so the column reads as part of the scale in both themes
    g.fillStyle = PC.grid; g.globalAlpha = 0.18; g.fillRect(x0, G.T0, cw, ph); g.globalAlpha = 1;
    if (!this.book?.ok || !m) { g.save(); g.translate(x0 + cw / 2, G.T0 + ph / 2); g.rotate(-Math.PI / 2); g.font = '11px system-ui'; g.textAlign = 'center'; g.fillStyle = PC.mute; g.fillText('стакан загружается…', 0, 0); g.restore(); return; }
    const im = on('imb') ? this.imbalance() : null, sw = im ? 4 : 0, right = x0 + cw - sw - (im ? 3 : 1), bw = right - x0 - 2;
    if (on('dom') && bw > 8) {
      const raw = (G.mx - G.mn) * C('domRows') / ph, step = Math.max(this.base, niceStep(raw, 1));
      const range = Math.min(0.08, Math.max(m - G.mn, G.mx - m) / m + step / m);
      const bk = this.buckets(range, step);
      if (bk) {
        const rows = []; for (const [side, mp] of [['ask', bk.ask], ['bid', bk.bid]]) for (const [k, v] of mp) { const y = G.Y(k * step); if (y >= G.T0 + 2 && y <= G.pH - 2) rows.push({y, v, k, ask:side === 'ask'}); }
        const max = Math.max(1, ...rows.map(r => r.v)), rh = clamp(Math.abs(G.Y(0) - G.Y(step)) - 1, 2, 12);
        // bars grow from the scale to the left; length by the square root, so mid-size levels stay visible next to a wall
        for (const r of rows) {
          const f = Math.sqrt(r.v / max), w = Math.max(2, f * bw);
          g.fillStyle = (r.ask ? PC.up : PC.lo) + (f > 0.6 ? 'cc' : f > 0.3 ? '88' : '4d'); g.fillRect(right - w, r.y - rh / 2, w, rh);
        }
        // sizes only for the few biggest levels and only where there is room; walls already have their size on the scale
        if (bw >= 46 && rh >= 9) {
          g.font = '600 10px system-ui'; g.textBaseline = 'middle'; g.textAlign = 'left';
          const wallsAt = new Set((this.lastWalls || []).map(w => Math.round(w.price / step)));
          for (const r of [...rows].sort((a, b) => b.v - a.v).slice(0, 4)) {
            if (labels && on('walls') && wallsAt.has(r.k)) continue;   // its size is already in the wall tag
            g.fillStyle = PC.price; g.fillText(fmtUsd(r.v), x0 + 3, r.y);
          }
        }
      }
    }
    if (im) {   // red share on top (sellers), green below (buyers), split at the buyers' share
      const sx = x0 + cw - sw - 1, split = G.T0 + ph * (1 - im.share);
      g.fillStyle = PC.up; g.fillRect(sx, G.T0, sw, split - G.T0); g.fillStyle = PC.lo; g.fillRect(sx, split, sw, G.pH - split);
      if (cw >= 30) {
        g.font = '600 10px system-ui'; g.textBaseline = 'middle'; g.textAlign = 'right';
        g.fillStyle = PC.up; g.fillText(Math.round((1 - im.share) * 100) + '%', sx - 2, G.T0 + 8); g.fillStyle = PC.lo; g.fillText(Math.round(im.share * 100) + '%', sx - 2, G.pH - 8);
      }
      g.textAlign = 'left';
    }
  }
  // one line of plain words under the charts (active one): walls near the price, who is stronger in the book, the channel
  note(W) {
    const d = this.d, m = this.mid(); if (!d || !m) { $('#bNote').innerHTML = ''; return; }
    const parts = layout > 1 ? [`<b>${K.base(this.sym)} · ${TFL[this.tf]}</b>`] : [], i = d.c.length - 1, up = d.B.up[i], lo = d.B.lo[i];
    const near = side => W.filter(w => w.side === side).sort((a, b) => Math.abs(a.price - m) - Math.abs(b.price - m))[0];
    const a = near('ask'), b = near('bid');
    if (a) parts.push(`стена продаж <b>${K.fp(a.price)}</b> (+${((a.price / m - 1) * 100).toFixed(2)}%, ${fmtUsd(a.usd)})${isFinite(up) && Math.abs(a.price - up) < (up - lo) * 0.1 ? ' — <b>у верхней границы канала</b>' : ''}`);
    if (b) parts.push(`стена покупок <b>${K.fp(b.price)}</b> (−${((1 - b.price / m) * 100).toFixed(2)}%, ${fmtUsd(b.usd)})${isFinite(lo) && Math.abs(b.price - lo) < (up - lo) * 0.1 ? ' — <b>у нижней границы канала</b>' : ''}`);
    const im = this.imbalance(); if (im) parts.push(`в стакане ±${C('imbRange')}% ${im.share >= 0.5 ? 'перевес покупателей' : 'перевес продавцов'} <b>${Math.round(Math.max(im.share, 1 - im.share) * 100)}%</b>`);
    $('#bNote').innerHTML = parts.length > (layout > 1 ? 1 : 0) ? parts.map(p => `<span>${p}</span>`).join('') : '<span>Стакан загружается…</span>';
  }
}

// order book snapshots from all charts go out at least 1.2 s apart (they are the heaviest request we make)
let gateAt = 0;
const snapGate = () => { const now = Date.now(), at = Math.max(now, gateAt); gateAt = at + 1200; return new Promise(r => setTimeout(r, at - now)); };
function applyDepth(b, ev) {
  if (ev.u <= b.id) return true;                        // already in the snapshot
  if (!b.ok) { if (ev.U > b.id + 1) return false; b.ok = true; }   // the first event must straddle the snapshot
  else if (ev.U !== b.id + 1) return false;             // a gap: the book is no longer exact
  for (const [p, q] of ev.b) +q ? b.bids.set(+p, +q) : b.bids.delete(+p);
  for (const [p, q] of ev.a) +q ? b.asks.set(+p, +q) : b.asks.delete(+p);
  b.id = ev.u; return true;
}
// indicators that only need candles: channel, RSI, delta, CVD, VWAP
function calc(d) {
  const N = Math.max(20, Math.min(C('bbN'), d.c.length - 30));
  d.N = N; d.B = M.bands(d.c, N, C('bbK'), 'log'); d.R = M.rsi(d.c);
  d.delta = d.qv.map((v, i) => 2 * d.tbq[i] - v);   // market buys − market sells, in $
  let cum = 0; d.cvd = d.delta.map(x => cum += x);
  let day = -1, pv = 0, vv = 0;
  d.vwap = d.c.map((c, i) => { const dd = Math.floor(d.t[i] / 864e5); if (dd !== day) { day = dd; pv = 0; vv = 0; } const tp = (d.h[i] + d.l[i] + c) / 3; pv += tp * d.v[i]; vv += d.v[i]; return vv ? pv / vv : NaN; });
  // developing POC: the price with the most volume since the session start (day; a week on 4h / 1d candles)
  const tfms = d.t.length > 1 ? d.t[1] - d.t[0] : 864e5, sess = tfms >= 144e5 ? 7 * 864e5 : 864e5, bin = niceStep(d.c[d.c.length - 1], 0.001);
  let sk = null, hist = new Map(), best = null, bestV = 0;
  d.dpoc = d.c.map((c, i) => {
    const s = Math.floor((d.t[i] + (sess > 864e5 ? 3 * 864e5 : 0)) / sess);   // weeks start on Monday
    if (s !== sk) { sk = s; hist = new Map(); best = null; bestV = 0; }
    const a = Math.round(d.l[i] / bin), b = Math.round(d.h[i] / bin), share = d.v[i] / (b - a + 1);
    for (let k = a; k <= b; k++) { const v = (hist.get(k) || 0) + share; hist.set(k, v); if (v > bestV) { bestV = v; best = k; } }
    return best == null ? NaN : best * bin;
  });
}
// heatmap scale comes from the CSS tokens --heat-0..3 (cold → hot)
let HEAT = null;
const rgb = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
function heatColor(x) {
  HEAT ||= [0, 1, 2, 3].map(i => rgb(getComputedStyle(document.documentElement).getPropertyValue('--heat-' + i).trim() || '#888888'));
  const t = Math.min(0.999, Math.max(0, x)) * (HEAT.length - 1), i = Math.floor(t), f = t - i, a = HEAT[i], b = HEAT[i + 1];
  return `rgba(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')},${(0.1 + 0.55 * x * x).toFixed(2)})`;   // faint for thin levels, so candles stay readable
}
function drawLine(g, G, arr, col, dash = []) {
  g.save(); g.beginPath(); g.rect(G.padL, G.T0, G.W - G.padL - G.padR, G.pH - G.T0); g.clip();   // stay inside the price pane
  g.beginPath(); g.setLineDash(dash); let s0 = false;
  for (let i = G.s; i <= G.e; i++) { if (!isFinite(arr[i])) continue; g[s0 ? 'lineTo' : 'moveTo'](G.X(i), G.Y(arr[i])); s0 = true; }
  g.strokeStyle = col; g.lineWidth = 1.4; g.stroke(); g.setLineDash([]); g.restore();
}
const avwap = (d, t) => { const i0 = K.barAt(d.t, t), arr = Array(d.c.length).fill(NaN); let pv = 0, vv = 0; for (let i = i0; i < d.c.length; i++) { pv += (d.h[i] + d.l[i] + d.c[i]) / 3 * d.v[i]; vv += d.v[i]; arr[i] = vv ? pv / vv : NaN; } return arr; };
function drawStep(g, G, arr, col) {   // a level that jumps between bars (developing POC)
  g.save(); g.beginPath(); g.rect(G.padL, G.T0, G.W - G.padL - G.padR, G.pH - G.T0); g.clip();
  g.beginPath(); let prev = null;
  // horizontal pieces only: a jump to a new level is not drawn as a tall vertical line
  for (let i = G.s; i <= G.e; i++) { const v = arr[i]; if (!isFinite(v)) { prev = null; continue; } const x0 = G.X(i) - G.bw / 2, x1 = G.X(i) + G.bw / 2, y = G.Y(v); if (prev !== v) g.moveTo(x0, y); g.lineTo(x1, y); prev = v; }
  g.strokeStyle = col; g.lineWidth = 1.5; g.stroke(); g.restore();
}

// ---------- active pane, layout, tools ----------
function setActive(i) {
  if (i < 0 || i === active) return;
  active = i; K.save('sr_bact', i); closePop();   // an open timeframe / history panel belonged to the previous chart
  panes.forEach((p, k) => p.el.classList.toggle('on', k === i)); syncBar(); renderList(); redrawAll();
}
function syncBar() {
  const p = act(); if (!p) return;
  $('#bTfL').textContent = TFL[p.tf]; $('#bRangeL').textContent = RANGES.find(r => r[0] === p.range)[2];
  $('#bSym').placeholder = K.base(p.sym);
  document.querySelectorAll('#bLay .tab').forEach(b => b.classList.toggle('on', +b.dataset.lay === layout));
  $('#bLink').setAttribute('aria-pressed', link); $('#bLink').classList.toggle('hidden', layout === 1);
}
const savePanes = () => K.save('sr_bpanes', pool.map(p => ({sym:p.sym, tf:p.tf, range:p.range})));
// panes are kept (hidden, streams closed) when the layout shrinks, so switching back is instant and the heatmap survives
let pool = [];
function setLayout(n) {
  K.save('sr_blay', n); if (n > 2 && matchMedia('(max-width:700px)').matches) n = 2;   // four charts don't fit a phone (the choice is kept for the computer)
  layout = n; $('#bPanes').dataset.lay = n;
  const saved = K.load('sr_bpanes', []);
  for (let i = 0; i < Math.max(n, pool.length); i++) {
    if (i < n && !pool[i]) {
      const used = new Set(pool.map(p => p.sym)), conf = saved[i] || {sym:DEF_SYMS.find(s => !used.has(s)) || 'BTCUSDT', tf:pool[0]?.tf || '5m'};
      pool[i] = new Pane(conf);
    }
    const p = pool[i], show = i < n; if (!p) continue;
    p.el.classList.toggle('hidden', !show);
    if (!show) p.disconnect(); else if (loopOn && !p.ws) p.d ? p.connect() : p.restart();
  }
  panes = pool.slice(0, n);
  if (active >= n) active = 0;
  panes.forEach((p, k) => p.el.classList.toggle('on', k === active));
  savePanes(); syncBar(); redrawAll(); requestAnimationFrame(redrawAll);
}
// drawing tools: chosen in the toolbar, applied to whichever chart is clicked; a chip above the charts says what to do
const TOOL_HINT = {frvp:'Профиль участка: зажмите и протяните по свечам', ruler:'Линейка: зажмите и протяните по графику', avwap:'VWAP от свечи: нажмите на свечу, от которой считать', note:'Заметка: нажмите на место на графике'};
function setTool(t) {
  tool = t; if (t !== 'ruler' && ruler?.live) ruler = null;
  document.querySelectorAll('#bTools [data-tool]').forEach(b => { b.classList.toggle('on', b.dataset.tool === t); b.setAttribute('aria-pressed', b.dataset.tool === t); });
  if (t !== 'frvp' && ruler?.kind === 'frvp') ruler = null;
  panes.forEach(p => p.el.classList.toggle('tool', !!t));
  const h = $('#bToolHint'); h.classList.toggle('hidden', !t);
  if (t) h.innerHTML = `<span>${TOOL_HINT[t]}</span><button data-tcancel>Отмена · Esc</button>`;
  redrawAll();
}
function toolAct(z) {
  const p = act();
  if (z === 'undo') undo(); if (z === 'redo') redo();
  if (z === 'clear') { if (!drw(p.sym).length) { K.toast('Построений нет', `На ${K.base(p.sym)} нечего убирать.`, 'info'); return; } mutate(p.sym, a => a.length = 0); K.toast('Построения убраны', 'Вернуть — ↶ или Ctrl+Z.', 'ok'); }
}

// ---------- popovers (timeframe, history, indicator settings, note): small panels next to their button, the chart stays visible ----------
let popFor = null, popAt = 0;
function openPop(anchor, html, cls = '') {
  const pop = $('#bPop'), host = $('.bmain').getBoundingClientRect(), a = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  pop.className = 'bpop ' + cls; pop.innerHTML = html;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(a.left - host.left, 8, host.width - w - 8) + 'px';
  pop.style.top = clamp(a.bottom - host.top + 6, 8, Math.max(8, host.height - h - 8)) + 'px';
  popFor = anchor.getBoundingClientRect ? anchor : null; popAt = performance.now();
  pop.querySelector('textarea, [data-tf].on, [data-range].on, input')?.focus({preventScroll:true});
}
const closePop = () => { $('#bPop').classList.add('hidden'); popFor = null; };
const head = t => `<h4>${t}<button data-close aria-label="Закрыть">${ic('x')}</button></h4>`;
// a cheat sheet of chart gestures, behind the "?" on every chart
function helpPop(btn) {
  const row = (k, t) => `<div class="hk"><b>${k}</b><span>${t}</span></div>`;
  openPop(btn, head('Как управлять графиком') + '<div class="hks">'
    + row('Колёсико / щипок', 'масштаб по времени')
    + row('Тянуть график', 'листать историю; после ручного масштаба цены — и вверх-вниз')
    + row('Тянуть шкалу цены', 'растянуть или сжать свечи; колёсико над шкалой — то же')
    + row('A · двойной клик', 'вернуть автомасштаб цены · всё сразу')
    + row('← → · + −', 'листать · масштаб (график в фокусе)')
    + row('R · V · T · P', 'линейка · VWAP от свечи · заметка · профиль участка')
    + row('Ctrl+Z · Esc', 'отменить · выйти из инструмента')
    + row('Клик по заметке', 'изменить или удалить; так же VWAP и профиль')
    + '</div>', 'help');
}
function tfPop() {
  const p = act();
  openPop($('#bTfBtn'), head('Таймфрейм') + `<div class="pgrid">${Object.keys(TFMS).map(tf => `<button data-tf="${tf}" class="${tf === p.tf ? 'on' : ''}">${TFL[tf]}</button>`).join('')}</div>`
    + `<p class="phint">${layout > 1 ? 'Для выделенного графика. ' : ''}Тепловая карта копится заново для каждой пары «монета + таймфрейм».</p>`);
}
function rangePop() {
  const p = act(), mx = maxDays(p.tf);
  openPop($('#bRangeBtn'), head('Сколько истории показать') + `<div class="pgrid">${RANGES.map(([k, l]) => `<button data-range="${k}" class="${k === p.range ? 'on' : ''}"${k > mx ? ` disabled title="На ${TFL[p.tf]} — не больше ${mx} дн."` : ''}>${l}</button>`).join('')}</div>`
    + `<p class="phint">«Авто» — по ширине экрана. На мелких таймфреймах длинная история недоступна: грузим до ${MAXBARS} свечей (на ${TFL[p.tf]} это ~${mx} дн.).</p>`);
}
function cfgPop(id) {
  const it = ITEMS.find(x => x.id === id), P = PARAMS[id];
  openPop($('#bIndBtn'), head(it.name) + `<div class="sel-cfg">${P.map(p => `<label><span>${p.name}<b data-v="${p.k}">${p.u(C(p.k))}</b></span><input type="range" data-k="${p.k}" min="${p.min}" max="${p.max}" step="${p.step}" value="${C(p.k)}"></label>`).join('')}</div>`
    + `<div class="pact"><button data-back>← Все индикаторы</button><button data-def="${id}">По умолчанию</button></div>`, 'cfg');
}
const COLS = [['acc', 'жёлтый'], ['lo', 'зелёный'], ['up', 'красный'], ['rsi', 'синий'], ['trade', 'фиолетовый']];
let noteDraft = null;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));
const colsHtml = cur => `<div class="pcols" role="radiogroup" aria-label="Цвет">${COLS.map(([c, n]) => `<button data-col="${c}" style="background:var(--c-${c})" aria-label="${n}" class="${c === cur ? 'on' : ''}"></button>`).join('')}</div>`;
function notePop(p, pt, x, y) {
  noteDraft = {p, pt, col:K.load('sr_bnotec', 'acc')};
  openPop({left:x, bottom:y, top:y}, head('Заметка на графике') + `<textarea id="bNoteT" maxlength="80" placeholder="Например: отбой от стены"></textarea>`
    + colsHtml(noteDraft.col) + `<div class="pact"><button data-close>Отмена</button><button class="primary" data-save>Добавить</button></div>`);
}
// a press on an existing note or VWAP anchor opens it: change the text / colour, or delete
function objPop(p, obj, x, y) {
  noteDraft = {p, edit:obj, col:obj.col};
  const at = {left:x, bottom:y, top:y};
  if (obj.type === 'note') openPop(at, head('Заметка') + `<textarea id="bNoteT" maxlength="80">${esc(obj.text)}</textarea>` + colsHtml(obj.col)
    + `<div class="pact"><button data-del>Удалить</button><button class="primary" data-save>Сохранить</button></div>`);
  else if (obj.type === 'frvp') openPop(at, head('Профиль участка') + `<p class="phint" style="margin:0">С ${K.dt(obj.t0)} по ${K.dt(obj.t1)}. Жёлтая линия — POC: цена, где за этот участок прошло больше всего объёма.</p><div class="pact"><button data-del>Удалить</button></div>`);
  else openPop(at, head('VWAP от свечи') + `<p class="phint" style="margin:0">Считается с ${K.dt(obj.t)} — средняя цена с учётом объёма от этой свечи.</p><div class="pact"><button data-del>Удалить</button></div>`);
}
function saveNote() {
  const text = $('#bNoteT').value.trim(); if (!text || !noteDraft) { $('#bNoteT').focus(); return; }
  const {p, pt, col, edit} = noteDraft; K.save('sr_bnotec', col);
  if (edit) mutate(p.sym, a => { const i = a.indexOf(edit); if (i >= 0) a[i] = {...edit, text, col}; });
  else mutate(p.sym, a => a.push({type:'note', t:pt.t, p:pt.p, text, col}));
  closePop(); noteDraft = null;
}
function delObj() {
  const {p, edit} = noteDraft || {}; if (!edit) return;
  mutate(p.sym, a => { const i = a.indexOf(edit); if (i >= 0) a.splice(i, 1); }); closePop(); noteDraft = null;
  K.toast({note:'Заметка удалена', frvp:'Профиль участка удалён'}[edit.type] || 'VWAP удалён', 'Вернуть — ↶ или Ctrl+Z.', 'ok');
}
function wirePop() {
  const pop = $('#bPop');
  pop.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const p = act(), ds = b.dataset;
    if ('close' in ds) closePop();
    if (ds.tf) { p.tf = ds.tf; if (p.range > maxDays(p.tf)) p.range = 0; savePanes(); syncBar(); closePop(); p.restart(); }
    if (ds.range != null && ds.range !== '') { p.range = +ds.range; savePanes(); syncBar(); closePop(); p.restart(); }
    if ('back' in ds) { closePop(); openInd(); }
    if (ds.def) { for (const q of PARAMS[ds.def]) delete cfg[q.k]; applyCfg(); cfgPop(ds.def); }
    if (ds.col) { noteDraft.col = ds.col; pop.querySelectorAll('[data-col]').forEach(x => x.classList.toggle('on', x === b)); }
    if ('save' in ds) saveNote();
    if ('del' in ds) delObj();
  });
  // sliders: the chart follows while dragging
  pop.addEventListener('input', e => {
    const k = e.target.dataset?.k; if (!k) return;
    cfg[k] = +e.target.value; const q = ALLP.find(x => x.k === k);
    pop.querySelectorAll(`[data-v="${k}"]`).forEach(b => b.textContent = q.u(cfg[k])); applyCfg();
  });
  pop.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'bNoteT' && !e.shiftKey) { e.preventDefault(); saveNote(); } });
  document.addEventListener('mousedown', e => { if (performance.now() - popAt > 400 && !pop.classList.contains('hidden') && !pop.contains(e.target) && !popFor?.contains(e.target)) closePop(); });
}

// ---------- side list: favourites, leaders, signals (from the market scan) ----------
function spark(cl) {
  if (!cl || cl.length < 2) return '';
  const mn = Math.min(...cl), mx = Math.max(...cl), up = cl[cl.length - 1] >= cl[0];
  const pts = cl.map((v, i) => `${(i / (cl.length - 1) * 64).toFixed(1)},${(24 - (mx === mn ? 12 : (v - mn) / (mx - mn) * 22) - 1).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 64 26" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? K.PC.lo : K.PC.up}" stroke-width="1.5"/></svg>`;
}
let listMode = 'fav';
// the list is rebuilt every second; the DOM is touched only when something changed (keeps hover and scroll calm)
let lastList = '', suggestN = 0;
const setList = html => { if (html !== lastList) { lastList = html; $('#bList').innerHTML = html; } };
function fillSuggest(rows) {   // the coin search suggests the coins of the market scan
  if (rows.length === suggestN) return; suggestN = rows.length;
  $('#bSymList').innerHTML = rows.map(r => `<option value="${K.base(r.sym)}">`).join('');
}
function renderList() {
  const rows = K.rows; if (!rows.length) { setList('<div class="mute" style="padding:12px;font-size:13px">Загружаю монеты…</div>'); return; }
  fillSuggest(rows);
  const cur = act()?.sym, shown = new Map(panes.map((p, i) => [p.sym, i + 1]));
  // change over the last 24 h of the market scan's candles (whatever its timeframe is)
  const bars = k => k.length > 1 ? Math.max(1, Math.round(864e5 / (k[1][0] - k[0][0]))) : 1;
  const ch = r => { const k = K.cache[r.sym]; if (!k) return 0; const b = Math.min(bars(k), k.length - 1); return b > 0 ? +k[k.length - 1][4] / +k[k.length - 1 - b][4] - 1 : 0; };
  const item = r => { const c = ch(r), k = K.cache[r.sym];
    return `<button class="bli${r.sym === cur ? ' on' : ''}" data-sym="${r.sym}"><span class="bn"><b>${K.base(r.sym)}</b><span>${r.rev ? (r.side === 'low' ? '▲ сигнал LONG' : '▼ сигнал SHORT') : 'спот'}${layout > 1 && shown.has(r.sym) ? ` · график ${shown.get(r.sym)}` : ''}</span></span>${spark(k?.slice(-bars(k) - 1).map(x => +x[4]))}
      <span class="bp">${K.fp(r.price)}<span class="${c > 0 ? 'pos' : c < 0 ? 'neg' : ''}">${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c * 100).toFixed(2)}%</span></span></button>`; };
  if (listMode === 'lead') {
    const s = [...rows].map(r => [r, ch(r)]).sort((a, b) => b[1] - a[1]);
    const up = s.filter(x => x[1] > 0).slice(0, 8).map(x => x[0]), dn = s.filter(x => x[1] < 0).reverse().slice(0, 8).map(x => x[0]);
    setList(`<div class="bl-h pos">▲ Лидеры роста · 24 ч</div>${up.map(item).join('') || '<div class="faint bl-e">Растущих монет нет</div>'}`
      + `<div class="bl-h neg">▼ Лидеры падения · 24 ч</div>${dn.map(item).join('') || '<div class="faint bl-e">Падающих монет нет</div>'}`);
    return;
  }
  let list;
  if (listMode === 'fav') { list = rows.filter(r => K.favs.has(r.sym)); if (!list.length) list = rows.filter(r => M.MAJORS.includes(r.sym)); }
  else list = rows.filter(r => r.rev).sort((a, b) => b.score - a.score);
  setList((listMode === 'fav' && !rows.some(r => K.favs.has(r.sym)) ? '<div class="faint" style="padding:4px 10px 8px;font-size:12px">Избранного пока нет — звёздочка у монеты на «Рынке». Пока BTC, ETH, SOL.</div>' : '')
    + (list.map(item).join('') || '<div class="mute" style="padding:12px;font-size:13px">Сейчас подтверждённых сигналов нет.</div>'));
}

// ---------- indicator picker ----------
const ic = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
// an icon per indicator in the picker (instead of one generic icon for all)
const ICONS = {dom:'book', imb:'scale', heat:'heat', walls:'wall', bubbles:'bubble', flow:'wave', delta:'delta', dtint:'delta', cvd:'wave', fp:'heat', vp:'poc', poc:'poc', dpoc:'poc', frvp:'range', vwap:'vwap', bb:'channel', rsi:'gauge', fib:'ruler'};
function renderInd() {
  const n = sel.size; ['#bIndN', '#bIndN2', '#bIndN3'].forEach(s => $(s).textContent = n);
  $('#bQuick').innerHTML = QUICK.map(id => { const it = ITEMS.find(x => x.id === id); return `<button class="ind-chip${sel.has(id) ? ' on' : ''}" data-tog="${id}">${ic(sel.has(id) ? 'check' : 'plus')}${it.name}</button>`; }).join('');
  const q = $('#bIndQ').value.trim().toLowerCase();
  $('#bCats').innerHTML = CATS.map(c => {
    const items = c.items.filter(it => !q || (it.name + ' ' + it.hint).toLowerCase().includes(q)); if (!items.length) return '';
    const cnt = items.filter(it => sel.has(it.id)).length;
    return `<details class="ind-cat"${q || cnt ? ' open' : ''}><summary>${c.name}${cnt ? ` <span class="ind-n">${cnt}</span>` : ''}</summary>`
      + items.map(it => `<div class="ind-it${sel.has(it.id) ? ' on' : ''}${it.soon ? ' soon' : ''}"><span class="ii">${ic(ICONS[it.id] || 'sliders')}</span><span class="it"><b>${it.name}</b><span>${it.soon ? 'скоро · ' : ''}${it.hint}</span></span>`
        + (it.soon ? '' : it.tool ? `<button data-usetool="${it.id}" title="Взять инструмент" aria-label="Взять инструмент: ${it.name}">${ic('range')}</button>` : `<button data-tog="${it.id}" aria-label="${sel.has(it.id) ? 'Убрать' : 'Добавить'} ${it.name}">${ic(sel.has(it.id) ? 'check' : 'plus')}</button>`) + '</div>').join('') + '</details>';
  }).join('') || '<div class="mute" style="padding:12px">Ничего не нашлось.</div>';
  $('#bSel').innerHTML = [...sel].map(id => { const it = ITEMS.find(x => x.id === id);
    return `<div class="sel-it"><span class="${hidden.has(id) ? 'off' : ''}">${it.name}</span>`
      + `<button data-eye="${id}" aria-label="${hidden.has(id) ? 'Показать' : 'Скрыть'} ${it.name}" title="${hidden.has(id) ? 'Показать' : 'Скрыть'}">${ic(hidden.has(id) ? 'eyeoff' : 'eye')}</button>`
      + (PARAMS[id] ? `<button data-cfg="${id}" aria-label="Настройки: ${it.name}" title="Настройки — откроются рядом с графиком">${ic('gear')}</button>` : '')
      + `<button data-tog="${id}" aria-label="Убрать ${it.name}" title="Убрать">${ic('x')}</button></div>`; }).join('')
    || '<div class="faint" style="font-size:13px">Ничего не выбрано — только свечи и объём.</div>';
}
function applyCfg() { K.save('sr_bcfg', cfg); panes.forEach(p => p.d && calc(p.d)); redrawAll(); }
function saveInd() { K.save('sr_bind', [...sel]); K.save('sr_bhide', [...hidden]); renderInd(); redrawAll(); requestAnimationFrame(redrawAll); }
const openInd = () => { $('#bInd').classList.remove('hidden'); renderInd(); $('#bIndQ').focus(); };
const closeInd = () => $('#bInd').classList.add('hidden');
function wire() {
  $('#bIndBtn').onclick = () => { closePop(); openInd(); };
  $('#bIndClose').onclick = closeInd; $('#bInd').onclick = e => { if (e.target.id === 'bInd') closeInd(); };
  $('#bIndQ').oninput = renderInd;
  $('#bIndClear').onclick = () => { sel.clear(); hidden.clear(); saveInd(); };
  $('#bLabels').checked = labels; $('#bLabels').onchange = e => { labels = e.target.checked; K.save('sr_blabels', labels); redrawAll(); };
  $('#bInd').addEventListener('click', e => {
    const t = e.target.closest('[data-tog]')?.dataset.tog, eye = e.target.closest('[data-eye]')?.dataset.eye, cf = e.target.closest('[data-cfg]')?.dataset.cfg;
    if (t) { sel.has(t) ? (sel.delete(t), hidden.delete(t)) : sel.add(t); if (LOWER.includes(t) && sel.has(t)) LOWER.forEach(x => x !== t && sel.delete(x)); saveInd(); }
    if (eye) { hidden.has(eye) ? hidden.delete(eye) : hidden.add(eye); saveInd(); }
    if (cf) { closeInd(); setTimeout(() => cfgPop(cf)); }
    const ut = e.target.closest('[data-usetool]')?.dataset.usetool; if (ut) { closeInd(); setTool(ut); }
  });
  $('#bTools').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.tool) setTool(tool === b.dataset.tool ? null : b.dataset.tool); if (b.dataset.act) toolAct(b.dataset.act); };
  $('#bToolHint').onclick = e => { if (e.target.closest('[data-tcancel]')) setTool(null); };
  $('#bTfBtn').onclick = () => popFor === $('#bTfBtn') ? closePop() : tfPop();
  $('#bRangeBtn').onclick = () => popFor === $('#bRangeBtn') ? closePop() : rangePop();
  document.querySelectorAll('#bLay .tab').forEach(b => b.onclick = () => setLayout(+b.dataset.lay));
  $('#bLink').onclick = () => { link = !link; K.save('sr_blink', link); syncBar(); hoverT = null; if (link) act().setView(act().view, true); redrawAll(); };
  document.querySelectorAll('#bListTabs .tab').forEach(b => b.onclick = () => { document.querySelectorAll('#bListTabs .tab').forEach(x => x.classList.toggle('on', x === b)); listMode = b.dataset.bl; renderList(); });
  $('#bList').onclick = e => { const b = e.target.closest('[data-sym]'); if (b) setSym(b.dataset.sym); };
  const goSym = el => { let v = el.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!v) return; if (!v.endsWith('USDT')) v += 'USDT'; el.value = ''; el.blur(); setSym(v); };
  $('#bSym').onkeydown = e => { if (e.key === 'Enter') goSym(e.target); if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); } };
  $('#bSym').oninput = e => { if (!e.inputType || e.inputType === 'insertReplacementText') goSym(e.target); };   // a coin picked from the suggestions
  // the ruler / range is finished on release, wherever the pointer is; a range becomes a fixed-range profile
  const finish = () => {
    if (!ruler?.live) return;
    ruler.live = false;
    if (ruler.kind === 'frvp') {
      const {pane, a, b} = ruler; ruler = null;
      if (Math.abs(b.i - a.i) >= 2) mutate(pane.sym, x => x.push({type:'frvp', t0:Math.min(a.t, b.t), t1:Math.max(a.t, b.t)}));
      else K.toast('Слишком короткий участок', 'Протяните хотя бы через 3 свечи.', 'info');
    }
    setTool(null);
  };
  window.addEventListener('mouseup', finish); window.addEventListener('touchend', finish);
  document.addEventListener('keydown', e => {
    if (!loopOn) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape') { closeInd(); closePop(); if (tool) setTool(null); if (ruler) { ruler = null; redrawAll(); } return; }
    if (typing || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'я') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (k === 'y' || k === 'н') { e.preventDefault(); redo(); }
  });
  window.addEventListener('resize', redrawAll);
  wirePop();
}
function setSym(sym) { const p = act(); if (!p || sym === p.sym) return; p.prevSym = p.sym; p.sym = sym; savePanes(); p.restart(); renderList(); }
function setLive() {
  const p = act(); if (!p) return;
  const ok = p.live(), mins = Math.floor(p.heatMs / 6e4), all = panes.filter(q => q.live()).length;
  $('#bLive').innerHTML = `<span class="live${ok ? '' : ' stale'}"><i></i><span>${ok ? `стакан и сделки вживую${layout > 1 ? ` · ${all} из ${layout} графиков` : ''} · карта ${K.base(p.sym)} копится ${mins ? mins + ' мин' : 'с этой минуты'}` : 'нет связи с Binance — переподключаюсь'}</span></span>`;
}
function loop() {
  if (!loopOn) return;
  for (const p of panes) if (p.dirty) { p.dirty = false; p.draw(); }
  requestAnimationFrame(loop);
}

// ---------- public: called by index.html when the Beta tab opens / closes ----------
let wired = false, sampler = null;
export function open(kit) {
  K = kit;
  if (!wired) {
    wired = true;
    sel = new Set(K.load('sr_bind', ['dom', 'imb', 'heat', 'walls', 'bubbles', 'vol', 'delta', 'bb']));
    if (!K.load('sr_bvol', false)) { sel.add('vol'); K.save('sr_bvol', true); K.save('sr_bind', [...sel]); }   // volume became optional: keep it on for everyone once
    hidden = new Set(K.load('sr_bhide', [])); labels = K.load('sr_blabels', true); cfg = K.load('sr_bcfg', {}) || {};
    drawings = K.load('sr_bdraw', {}) || {}; link = K.load('sr_blink', true); active = K.load('sr_bact', 0);
    // older single-chart settings become the first pane
    if (!K.load('sr_bpanes', null)) K.save('sr_bpanes', [{sym:K.load('sr_bsym', 'BTCUSDT'), tf:K.load('sr_btf', '5m'), range:0}]);
    wire(); renderInd();
    setLayout(K.load('sr_blay', 1));
  }
  if (loopOn) return;
  loopOn = true; renderList();
  sampler = setInterval(() => { panes.forEach(p => { p.sampleHeat(); p.dirty = true; }); setLive(); renderList(); }, 1000);
  for (const p of panes) p.d ? p.connect() : p.restart();
  requestAnimationFrame(loop);
}
// leaving the tab closes the streams (no traffic in the background); the heatmap collected so far stays in memory
export function pause() { if (!loopOn) return; loopOn = false; clearInterval(sampler); panes.forEach(p => p.disconnect()); closePop(); if (tool) setTool(null); }
