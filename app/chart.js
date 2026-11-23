// The chart renderer and the zoom & pan (docs/PLAN-UNTANGLE-modules.md, wave 4). Used by the market chart, the second timeframe and
// the trade card in the page, and by beta.js through window.__sr.kit. Only declarations: nothing runs at load, the storage is not read.
// Colours come from PC (core.js: pal()).
import {PC, fp, dt} from './core.js';
import {clamp} from '../supabase/functions/_shared/math.js';

// ---------- chart renderer (market chart and trade card) ----------
// d: {t,o,h,l,c,v,B,R}; o: {from, levels:[{v,col,label,i0,i1}], marks:[{i,price,col,label}], live, hoverI}
function renderChart(cv, d, o = {}) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !d) return null;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  // the view may extend past the last candle (eView > n-1): that is empty space on the right. from / to may be fractional
  // (a view moved by a part of a candle): f is where the view starts; s…e are the bars at least partly in view,
  // s0…e0 one more on each side, so lines run to the edges (the plot is clipped)
  const {t, h, l, c, v, B, R} = d, op = d.o, n = c.length, f = clamp(o.from ?? 0, 0, n - 1);
  const eView = Math.max(f + 1, o.to ?? n - 1), s = Math.floor(f + 1e-6), e = Math.min(Math.ceil(eView - 1e-6), n - 1), s0 = Math.max(0, s - 1), e0 = Math.min(n - 1, e + 1);
  // the right gutter is as wide as the longest price tag, so tags are never cut and no space is wasted
  g.font = '11px system-ui';
  const tagW = Math.max(...[...(o.levels || []).filter(L => !L.noTag).map(L => `${L.tag || ''} ${fp(L.v)}`), ...(o.tags || []).map(T => T.text), ...(o.ulevels || []).map(v => `ур. ${fp(v)}`), fp(B.up[e]), fp(B.lo[e]), fp(c[n - 1]) + (o.priceSub ? ' · ' + o.priceSub : '')].map(x => g.measureText(x).width));
  // o.rightCol: a column between the plot and the price tags (Beta: the order book at the price scale)
  // panes: price, volume, lower (RSI or o.sub); o.vol === false / o.lower === false give their height back to the price
  const showV = o.vol !== false, showR = o.lower !== false;
  const RC = o.rightCol || 0, padL = 8, padR = clamp(Math.ceil(tagW) + 18, 56, 130) + RC;
  let pH = Math.round(H * (showV && showR ? 0.7 : showV ? 0.84 : showR ? 0.76 : 1) - (showV || showR ? 0 : 24));
  // the lower pane (RSI, or the Beta's delta) keeps at least 56 px: on a phone, at 52 % of a 667 px screen, it was 24 px and
  // its 30 / 70 lines ran into the value. The price pane gives the difference
  if (showR) { const r0 = H - (showV ? pH + 24 + Math.round(H * 0.08) + 22 : pH + 30) - 6; if (r0 < 56) pH -= 56 - r0; }
  const vTop = pH + 24, vH = showV ? Math.round(H * (showR ? 0.08 : 0.16) - (showR ? 0 : 30)) : 0, rTop = showV ? vTop + vH + 22 : pH + 30, rH = H - rTop - 6;
  const pw = W - padL - padR, cnt = eView - f + 1, bw = pw / cnt, candles = bw >= (o.thin ? 1 : 3);   // o.thin: keep candles even when they are 1-2 px wide
  const step = n > 1 ? t[n - 1] - t[n - 2] : 0, tAt = i => i < n ? t[i] : t[n - 1] + (i - n + 1) * step;
  const X = i => padL + (i - f + 0.5) * bw;
  // drawing inside the plot only: bars cut by the edges don't spill into the margin or under the price tags
  const clip = () => { g.save(); g.beginPath(); g.rect(padL, 0, pw, H); g.clip(); };
  // time labels at round times (hours, days…): they ride with the candles while the chart is dragged, instead of
  // hopping to other candles. The step is the shortest that keeps labels a label's width + 24 px (at least 100 px) apart,
  // with 4 and 5 days between 3 days and a week (a phone's 4h chart had one label); a label goes on the first bar of
  // each period, shown only when it fits whole and doesn't touch the previous one
  g.font = '11px system-ui';
  const tz = -new Date(t[n - 1]).getTimezoneOffset() * 6e4, need = Math.max(100, g.measureText(dt(t[n - 1])).width + 24) / bw * step;
  const D = [6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 144e5, 216e5, 432e5, 864e5, 1728e5, 2592e5, 3456e5, 4320e5, 6048e5, 12096e5, 2592e6, 7776e6, 15552e6, 31536e6].find(x => x >= need && x >= step) || need;
  const per = i => Math.floor((tAt(i) + tz - (D % 6048e5 ? 0 : 3456e5)) / D);   // weeks start on Monday (1970-01-01 was a Thursday)
  const tLabels = []; g.font = '11px system-ui';
  for (let i = Math.max(1, s), last = -Infinity; i <= Math.floor(eView + 0.5) && step; i++) {
    if (per(i) === per(i - 1)) continue;
    const txt = dt(tAt(i)), w = g.measureText(txt).width, x0 = X(i) - w / 2;
    if (x0 < padL || x0 + w > W - padR || x0 < last + 12) continue;
    tLabels.push({x:X(i), x0, txt}); last = x0 + w;
  }
  let mn = Infinity, mx = -Infinity;
  const acc = x => { if (isFinite(x)) { mn = Math.min(mn, x); mx = Math.max(mx, x); } };
  for (let i = s; i <= e; i++) { if (!o.fitPrice) { acc(B.up[i]); acc(B.lo[i]); } if (candles) { acc(h[i]); acc(l[i]); } else acc(c[i]); }
  for (const L of o.levels || []) acc(L.v);
  // o.yRange: a price range the user stretched / moved on the price scale; otherwise fit what is visible
  if (o.yRange) { mn = o.yRange.mn; mx = o.yRange.mx; } else { const pad = (mx - mn) * 0.06 || mx * 0.01; mn -= pad; mx += pad; }
  // the price pane starts below the toolbar (top-left corner) where there is one over the canvas
  const T0 = o.top ?? 8, ph = pH - T0 - 8;
  const Y = x => T0 + (mx - x) / (mx - mn) * ph;
  // price scale: round levels across the plot; their labels are drawn later, only where no price tag sits
  const raw = (mx - mn) / 5, mag = raw > 0 ? 10 ** Math.floor(Math.log10(raw)) : 0, stepP = mag ? [1, 2, 2.5, 5, 10].find(m => m * mag >= raw) * mag : 0;
  const gridV = []; if (stepP) for (let v = Math.ceil(mn / stepP) * stepP; v <= mx && gridV.length < 12; v += stepP) gridV.push(v);
  g.strokeStyle = PC.grid; g.lineWidth = 1; g.globalAlpha = 0.5; g.setLineDash([2, 4]);
  for (const v of gridV) { g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(W - padR, Y(v)); g.stroke(); }
  if (o.vgrid) for (const L of tLabels) { g.beginPath(); g.moveTo(L.x, T0); g.lineTo(L.x, pH); g.stroke(); }   // o.vgrid: vertical lines at the time labels
  g.setLineDash([]); g.globalAlpha = 1;
  g.font = '11px system-ui'; g.textBaseline = 'middle';
  clip();
  // o.fitPrice: the scale follows the candles only; the channel may run off the plot, so the price pane is clipped
  if (o.fitPrice) { g.save(); g.beginPath(); g.rect(0, T0 - 4, W - padR, pH - T0 + 4); g.clip(); }
  // channel
  let f0 = s0; while (f0 <= e0 && !isFinite(B.mid[f0])) f0++;
  if (f0 <= e0 && !o.fitPrice) {   // with the scale fitted to the candles the band usually overflows the plot: lines only
    g.beginPath();
    for (let i = f0; i <= e0; i++) g[i === f0 ? 'moveTo' : 'lineTo'](X(i), Y(B.up[i]));
    for (let i = e0; i >= f0; i--) g.lineTo(X(i), Y(B.lo[i]));
    g.fillStyle = PC.band; g.fill();
  }
  const line = (arr, col, w = 1.3, dash = []) => { g.beginPath(); g.setLineDash(dash); let st = false;
    for (let i = s0; i <= e0; i++) { if (!isFinite(arr[i])) continue; g[st ? 'lineTo' : 'moveTo'](X(i), Y(arr[i])); st = true; }
    g.strokeStyle = col; g.lineWidth = w; g.stroke(); g.setLineDash([]); };
  // position zones: green from entry to take profit, red from entry to stop
  for (const z of o.zones || []) {
    const x0 = Math.max(padL, X(clamp(z.i0, s, eView)) - bw / 2), x1 = Math.min(W - padR, z.i1 != null ? X(clamp(z.i1, s, eView)) + bw / 2 : W - padR);
    if (x1 <= x0) continue;
    g.fillStyle = PC.lo + '1f'; g.fillRect(x0, Math.min(Y(z.entry), Y(z.tp)), x1 - x0, Math.abs(Y(z.tp) - Y(z.entry)));
    g.fillStyle = PC.up + '1f'; g.fillRect(x0, Math.min(Y(z.entry), Y(z.sl)), x1 - x0, Math.abs(Y(z.sl) - Y(z.entry)));
  }
  // layers under the price (Beta: liquidity heatmap, volume profile)
  o.under?.(g, {X, Y, s, e, eView, bw, padL, padR, W, H, pH, T0, mn, mx, t, tAt});
  line(B.up, PC.up); line(B.lo, PC.lo); line(B.mid, PC.mid, 1, [4, 4]);
  // price
  if (candles) {
    const cw = Math.max(1, bw * 0.7);
    for (let i = s; i <= e; i++) {
      const col = c[i] >= op[i] ? PC.lo : PC.up;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(i), Y(h[i])); g.lineTo(X(i), Y(l[i])); g.stroke();
      const y1 = Y(Math.max(op[i], c[i])), y2 = Y(Math.min(op[i], c[i]));
      g.fillRect(X(i) - cw / 2, y1, cw, Math.max(1, y2 - y1));
    }
  } else {
    line(c, PC.price, 1.2);
    const tri = (x, y, dir, col) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x - 5, y - dir*8); g.lineTo(x + 5, y - dir*8); g.closePath(); g.fillStyle = col; g.fill(); };
    if (!o.noMarks) for (let i = Math.max(f0, s, 1); i <= e; i++) {   // o.noMarks: no band-touch triangles (Beta)
      if (h[i] >= B.up[i] && !(h[i-1] >= B.up[i-1])) tri(X(i), Y(B.up[i]) - 8, -1, PC.up);
      if (l[i] <= B.lo[i] && !(l[i-1] <= B.lo[i-1])) tri(X(i), Y(B.lo[i]) + 8, 1, PC.lo);
    }
  }
  // levels (entry / TP / SL): dashed line over the trade's span, price tag in the right gutter
  const tags = [];
  for (const L of o.levels || []) {
    const x0 = L.i0 != null ? X(clamp(L.i0, s, e)) - bw / 2 : padL, x1 = L.i1 != null ? X(clamp(L.i1, s, e)) + bw / 2 : W - padR;
    g.setLineDash([4, 3]); g.strokeStyle = L.col; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x0, Y(L.v)); g.lineTo(W - padR, Y(L.v)); g.stroke(); g.setLineDash([]);
    if (x1 < W - padR) { g.strokeStyle = L.col + '55'; g.beginPath(); g.moveTo(x1, Y(L.v)); g.lineTo(W - padR, Y(L.v)); g.stroke(); } // faded after the exit
    if (!L.noTag) tags.push({y:Y(L.v), text:`${L.tag || ''} ${fp(L.v)}`.trim(), col:L.col, box:true});   // noTag: a line without a price tag
  }
  // entry / exit marks; their labels step away from each other when a short trade puts them on top of one another
  const placed = [];
  for (const m of o.marks || []) {
    if (m.i < s || m.i > e) continue;
    g.beginPath(); g.arc(X(m.i), Y(m.price), 5, 0, 7); g.fillStyle = m.col; g.fill(); g.strokeStyle = PC.canvas; g.lineWidth = 2; g.stroke();
    if (!m.label) continue;
    const w = g.measureText(m.label).width, lx = X(m.i) + 8 + w > W - padR ? X(m.i) - 8 - w : X(m.i) + 8, dir = m.below ? 1 : -1;
    let ly = Y(m.price) + (m.below ? 14 : -12);
    for (let k = 0; k < 6 && placed.some(p => lx < p.x + p.w + 4 && p.x < lx + w + 4 && Math.abs(p.y - ly) < 13); k++) ly += dir * 14;
    placed.push({x:lx, y:ly, w});
    g.fillStyle = PC.tip; g.fillRect(lx - 3, ly - 7, w + 6, 14);   // a backing so the label reads over candles
    g.fillStyle = m.col; g.fillText(m.label, lx, ly);
  }
  // the user's own horizontal levels: solid line across the view, price tag in the gutter
  for (const v of o.ulevels || []) {
    if (!(v >= mn && v <= mx)) continue;
    g.strokeStyle = PC.rsi; g.lineWidth = 1.2; g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(W - padR, Y(v)); g.stroke();
    tags.push({y:Y(v), text:`ур. ${fp(v)}`, col:PC.rsi, box:true});
  }
  if (o.fitPrice) g.restore();
  const cur = o.live ? c[n - 1] : c[e];
  const curCol = o.priceCol || PC.acc;   // o.priceCol: e.g. green / red by the last candle
  if (o.live && cur >= mn && cur <= mx) { g.setLineDash([3, 3]); g.strokeStyle = curCol + '88'; g.lineWidth = 1; g.beginPath(); g.moveTo(padL, Y(cur)); g.lineTo(W - padR, Y(cur)); g.stroke(); g.setLineDash([]); }
  g.restore();   // the plot clip: price tags go to the right margin
  // a border off the plot (the scale fits the candles) is pinned to the edge with an arrow, so it never disappears
  if (isFinite(B.up[e])) tags.push(!o.fitPrice || B.up[e] <= mx ? {y:Y(B.up[e]), text:fp(B.up[e]), col:PC.up} : {y:T0, text:'↑ ' + fp(B.up[e]), col:PC.up});
  if (isFinite(B.lo[e])) tags.push(!o.fitPrice || B.lo[e] >= mn ? {y:Y(B.lo[e]), text:fp(B.lo[e]), col:PC.lo} : {y:pH - 6, text:'↓ ' + fp(B.lo[e]), col:PC.lo});
  // extra price tags from the caller (Beta: VWAP, POC); with pin, a level off the visible range stays at the edge with an arrow
  for (const T of o.tags || []) { if (T.v >= mn && T.v <= mx) tags.push({y:Y(T.v), text:T.text, col:T.col, box:true}); else if (T.pin && isFinite(T.v)) tags.push({y:T.v > mx ? T0 : pH - 6, text:(T.v > mx ? '↑ ' : '↓ ') + T.text, col:T.col, box:true}); }
  tags.push({y:Y(clamp(cur, mn, mx)), text:fp(cur) + (o.live && o.priceSub ? ' · ' + o.priceSub : ''), col:curCol, box:true});   // priceSub: e.g. time left in the candle
  // spread tags so they never overlap: sort by y, push down, then shift the stack up if it ran past the bottom
  tags.sort((a, b) => a.y - b.y);
  for (let q = 0; q < tags.length; q++) tags[q].ty = Math.max(clamp(tags[q].y, T0, pH - 6), q ? tags[q-1].ty + 15 : T0);
  const over = tags.length ? tags[tags.length - 1].ty - (pH - 6) : 0;
  if (over > 0) for (let q = tags.length - 1; q >= 0; q--) tags[q].ty = Math.min(tags[q].ty - over, q < tags.length - 1 ? tags[q+1].ty - 15 : Infinity);
  g.font = '11px system-ui'; g.fillStyle = PC.axis;
  for (const v of gridV) if (!tags.some(tg => Math.abs(tg.ty - Y(v)) < 11)) g.fillText(fp(v), W - padR + RC + 8, Y(v));
  for (const tg of tags) {
    const tx = W - padR + RC + 4, w = g.measureText(tg.text).width + 8;
    if (tg.box) { g.fillStyle = tg.col + '26'; g.fillRect(tx, tg.ty - 7, w, 14); }
    if (Math.abs(tg.ty - tg.y) > 2) { g.strokeStyle = tg.col + '88'; g.lineWidth = 1; g.beginPath(); g.moveTo(W - padR + RC, tg.y); g.lineTo(tx, tg.ty); g.stroke(); }
    g.fillStyle = tg.col; g.fillText(tg.text, tx + 4, tg.ty);
  }
  // time axis
  g.font = '11px system-ui'; g.fillStyle = PC.axis;
  for (const L of tLabels) g.fillText(L.txt, L.x0, pH + 6);
  // volume
  if (showV) {
  let vmax = 0; for (let i = s; i <= e; i++) vmax = Math.max(vmax, v[i]);
  g.fillStyle = PC.label; g.fillText('Объём', padL + 2, vTop + 6);
  clip();
  for (let i = s; i <= e; i++) {
    const hh = vmax ? v[i] / vmax * vH : 0;
    g.fillStyle = c[i] >= op[i] ? PC.volup : PC.voldn;
    g.fillRect(X(i) - Math.max(0.5, bw * 0.35), vTop + vH - hh, Math.max(1, bw * 0.7), hh);
  }
  g.restore();
  }
  if (!showR) {}
  else if (o.sub) {
    // lower pane replaced by a series (e.g. volume delta as bars, CVD as a line) — used by the Beta chart
    const sv = o.sub.values; let a = Infinity, b = -Infinity;
    for (let i = s; i <= e; i++) if (isFinite(sv[i])) { a = Math.min(a, sv[i]); b = Math.max(b, sv[i]); }
    if (o.sub.kind === 'bars') { a = Math.min(a, 0); b = Math.max(b, 0); }
    const SY = x => rTop + (b - x) / ((b - a) || 1) * rH;
    g.fillStyle = PC.label; g.fillText(o.sub.label, padL + 2, rTop + 7);
    clip();
    if (o.sub.kind === 'bars') {
      for (let i = s; i <= e; i++) { if (!isFinite(sv[i])) continue; g.fillStyle = sv[i] >= 0 ? PC.volup : PC.voldn; const y0 = SY(0), y1 = SY(sv[i]); g.fillRect(X(i) - Math.max(0.5, bw * 0.35), Math.min(y0, y1), Math.max(1, bw * 0.7), Math.abs(y1 - y0) || 1); }
    } else {
      g.beginPath(); let st = false;
      for (let i = s0; i <= e0; i++) { if (!isFinite(sv[i])) continue; g[st ? 'lineTo' : 'moveTo'](X(i), SY(sv[i])); st = true; }
      g.strokeStyle = PC.rsi; g.lineWidth = 1.3; g.stroke();
    }
    g.restore();
    if (isFinite(sv[e])) { g.fillStyle = PC.rsi; g.fillText(o.sub.fmt ? o.sub.fmt(sv[e]) : sv[e].toFixed(0), W - padR + RC + 6, SY(sv[e])); }
  } else {
  // RSI
  g.fillStyle = PC.label; g.fillText('RSI', padL + 2, rTop + 7);
  const RY = x => rTop + (100 - x) / 100 * rH;
  g.fillStyle = PC.hi; g.fillRect(padL, RY(100), W - padL - padR, RY(70) - RY(100));
  g.fillStyle = PC.lo2; g.fillRect(padL, RY(30), W - padL - padR, RY(0) - RY(30));
  g.strokeStyle = PC.grid; g.lineWidth = 1; g.setLineDash([3, 3]);
  for (const x of [30, 70]) { g.beginPath(); g.moveTo(padL, RY(x)); g.lineTo(W - padR, RY(x)); g.stroke(); }
  g.setLineDash([]); clip(); g.beginPath(); let st = false;
  for (let i = s0; i <= e0; i++) { if (!isFinite(R[i])) continue; g[st ? 'lineTo' : 'moveTo'](X(i), RY(R[i])); st = true; }
  g.strokeStyle = PC.rsi; g.stroke(); g.restore();
  if (isFinite(R[e])) { g.fillStyle = PC.rsi; g.fillText(R[e].toFixed(0), W - padR + RC + 6, RY(R[e])); }
  }
  // extra layers drawn by the caller on top of everything (Beta: trade bubbles, walls)
  o.over?.(g, {X, Y, s, e, eView, bw, padL, padR, W, H, pH, T0, mn, mx, t, tAt});
  // hover
  const hi = o.hoverI;
  if (hi != null && hi >= s && hi <= e) {
    const x = clamp(X(hi), padL, W - padR);   // a bar cut by the edge: the line stays on the plot
    g.strokeStyle = PC.cross; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    const pb = (c[hi] - B.lo[hi]) / (B.up[hi] - B.lo[hi]);
    const txt = [dt(t[hi]), candles ? `O ${fp(op[hi])}  H ${fp(h[hi])}` : '', candles ? `L ${fp(l[hi])}  C ${fp(c[hi])}` : 'цена ' + fp(c[hi]),
      isFinite(pb) ? `%B ${(pb*100).toFixed(1)}%  ${B.z[hi].toFixed(2)}σ` : '', o.hoverExtra ? '' : 'RSI ' + (isFinite(R[hi]) ? R[hi].toFixed(0) : '—'), ...(o.hoverExtra?.(hi) || [])].filter(Boolean);
    // tooltip sits below the toolbar (top-left corner) and flips to the other side of the cursor near the right edge;
    // o.hoverLine (a chart mirroring another one's crosshair) shows only the vertical line and the time
    g.font = '12px system-ui';
    if (!o.hoverLine && !o.noTip) {   // o.noTip: the caller shows the candle's values elsewhere (Beta: in the chart header)
      const tw = Math.max(178, ...txt.map(s2 => g.measureText(s2).width + 16)), bx = x > W / 2 ? x - tw - 10 : x + 10, by = o.top ? o.top + 2 : 46;
      g.fillStyle = PC.tip; g.fillRect(bx, by, tw, txt.length * 17 + 10);
      g.fillStyle = PC.price; txt.forEach((s2, k) => g.fillText(s2, bx + 8, by + 10 + k * 17));
    }
    // crosshair: the price under the cursor on the right scale, the bar's time on the time axis
    const hy = o.hoverY;
    if (hy != null && hy >= T0 && hy <= pH - 8) {
      const price = mx - (hy - T0) / ph * (mx - mn), lp = o.crossPct && c[n - 1] ? (price / c[n - 1] - 1) * 100 : null;   // o.crossPct: also the distance from the last price
      const lbl = fp(price) + (lp != null ? ` ${lp >= 0 ? "+" : "−"}${Math.abs(lp).toFixed(2)}%` : ""), lw = g.measureText(lbl).width + 10;
      g.setLineDash([3, 3]); g.strokeStyle = PC.cross; g.beginPath(); g.moveTo(padL, hy); g.lineTo(W - padR, hy); g.stroke(); g.setLineDash([]);
      const lx = Math.min(W - padR + RC + 2, W - lw - 2); g.fillStyle = PC.cross; g.fillRect(lx, hy - 9, lw, 18); g.fillStyle = PC.canvas; g.fillText(lbl, lx + 5, hy);
    }
    const tl = new Date(t[hi]).toLocaleDateString('ru', {weekday:'short'}) + ' ' + dt(t[hi]), tw = g.measureText(tl).width + 10, tx = clamp(x - tw / 2, padL, W - padR - tw);
    g.fillStyle = PC.cross; g.fillRect(tx, pH - 2, tw, 17); g.fillStyle = PC.canvas; g.fillText(tl, tx + 5, pH + 6);
  }
  return {s, e, f, padL, padR, pw, bw, mn, mx, pH, W, T0, ph};   // enough to turn a pointer position back into a bar and a price
}
const hoverIndex = (geo, cv, ev) => geo ? Math.floor((ev.clientX - cv.getBoundingClientRect().left - geo.padL) / geo.bw + geo.f) : null;
// the price under a pointer, or null outside the price pane
const priceAt = (geo, cv, ev) => { if (!geo) return null; const y = ev.clientY - cv.getBoundingClientRect().top; return y >= geo.T0 && y <= geo.pH - 8 ? geo.mx - (y - geo.T0) / geo.ph * (geo.mx - geo.mn) : null; };

// ---------- zoom & pan: view = {span, endOff} — bars visible, bars hidden on the right; null = default ----------
// both may be fractional: the view moves with the finger / wheel by a part of a candle, not in candle steps.
// from / to are fractional too; s…e are the whole bars at least partly in view (for loops over the data)
const MIN_SPAN = 8;
function viewRange(n, minFrom, view, defSpan) {
  const room = Math.max(20, n - minFrom);
  // (MIN_SPAN: the closest zoom — 8 candles, enough room for footprint numbers inside a candle)
  const span = clamp(view?.span ?? Math.round(defSpan), Math.min(MIN_SPAN, room), room);
  // negative endOff = empty bars to the right of the last candle (up to 8% of the view); default leaves a small margin
  const endOff = clamp(view?.endOff ?? -Math.round(Math.max(2, span * 0.03)), -Math.max(3, span * 0.08), room - span);   // a small margin; at most 8% empty space on the right
  const to = n - 1 - endOff, from = to - span + 1;
  return {from, to, span, endOff, s:Math.max(0, Math.floor(from + 1e-6)), e:Math.min(n - 1, Math.ceil(to - 1e-6))};
}
// a wheel event's travel in px (some mice and Firefox count in lines or pages); Shift turns the wheel sideways
function wheelPx(e, el) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
  let dx = e.deltaX * k, dy = e.deltaY * k;
  if (e.shiftKey && !dx) { dx = dy; dy = 0; }
  return {dx, dy};
}
// zoom in proportion to the travel, so a touchpad's dozens of small steps zoom as smoothly as a mouse notch (~100 px ≈ ×1.2);
// a touchpad pinch arrives as Ctrl + small steps and gets a stronger rate
const wheelZoom = (dy, e, rate = 0.0018) => Math.exp(clamp(dy, -300, 300) * (e.ctrlKey && Math.abs(dy) < 40 ? rate * 5 : rate));
// one redraw per frame, however many mouse, wheel, touch, slider or resize events arrive: a 120 Hz mouse used to redraw the
// whole chart 120 times a second, and dragging N from 20 to 300 recomputed the channel 280 times
const perFrame = f => { let id = 0; return () => { if (!id) id = requestAnimationFrame(() => { id = 0; f(); }); }; };
// api.state() → {n, minFrom, defSpan, view, geo}; api.set(view) stores the view and redraws
function attachZoom(cv, api) {
  let drag = null;
  // charts inside a scrolling page (api.wheelGate): the wheel scrolls the page until the chart is clicked (or with Ctrl/⌘),
  // so the page doesn't get stuck under the mouse; a short hint says how to zoom
  let armed = false, hintAt = 0;
  if (api.wheelGate) {
    cv.addEventListener('mousedown', () => { armed = true; });
    cv.addEventListener('mouseleave', () => { armed = false; });
  }
  const wheelHint = () => {
    if (performance.now() - hintAt < 4000) return; hintAt = performance.now();
    const box = cv.parentElement; let h = box.querySelector('.whint');
    if (!h) { h = document.createElement('div'); h.className = 'whint'; h.textContent = 'Чтобы менять масштаб колёсиком — нажмите на график или держите Ctrl'; box.append(h); }
    h.classList.add('show'); setTimeout(() => h.classList.remove('show'), 1800);
  };
  const range = st => viewRange(st.n, st.minFrom, st.view, st.defSpan);
  // positions in bars: bar i spans i − ½ … i + ½, the view's left edge is from − ½. Several events can arrive before the
  // next redraw, so the bar width comes from the current view and the plot width (geo.bw may be a step behind)
  const posAt = (st, r, x) => r.from - 0.5 + (x - cv.getBoundingClientRect().left - st.geo.padL) / st.geo.pw * r.span;
  const maxSpan = st => Math.max(20, st.n - st.minFrom);
  const setLeft = (st, left, span) => api.set({span, endOff:st.n - 0.5 - left - span});
  // zoom by m keeping the point at pos (in bars) where it is
  const zoomAt = (st, r, m, pos) => { const span = clamp(r.span * m, MIN_SPAN, maxSpan(st)); setLeft(st, pos - (pos - (r.from - 0.5)) * span / r.span, span); };
  cv.addEventListener('wheel', e => {
    // vertical: zoom; sideways (touchpad swipe, Shift + wheel): through history. The sideways swipe needs no click on a
    // page chart: the page doesn't scroll sideways anyway
    const {dx, dy} = wheelPx(e, cv), free = !api.wheelGate || armed || e.ctrlKey || e.metaKey;
    const side = Math.abs(dx) > Math.abs(dy) * (free ? 1 : 2);
    if (!free && !side) { if (dy) wheelHint(); return; }   // let the page scroll
    const st = api.state(); if (!st?.geo || !(dx || dy)) return;
    e.preventDefault();
    const r = range(st);
    if (side) api.set({span:r.span, endOff:r.endOff - dx / st.geo.pw * r.span});
    else zoomAt(st, r, wheelZoom(dy, e), clamp(posAt(st, r, e.clientX), r.from - 0.5, r.to + 0.5));   // the bar under the cursor stays
  }, {passive:false});
  const down = x => { const st = api.state(); if (!st?.geo) return; const r = range(st); drag = {x, endOff:r.endOff, span:r.span, bw:st.geo.pw / r.span}; };
  const move = x => { if (!drag) return false; api.set({span:drag.span, endOff:drag.endOff + (x - drag.x) / drag.bw}); return true; };
  // api.pick(e) gets the first say on a press (e.g. placing a level); when it takes it, there is no drag
  cv.addEventListener('mousedown', e => { if (e.button !== 0 || api.pick?.(e)) return; down(e.clientX); cv.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', e => { if (move(e.clientX)) e.preventDefault(); });
  window.addEventListener('mouseup', () => { drag = null; cv.style.cursor = ''; });
  // touch: one finger pans, two fingers pinch-zoom (the canvas allows only vertical page scroll, so the browser doesn't zoom the page)
  // around the point between the fingers: the bar under it at the start stays under it, also when both fingers move
  let pinch = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), mid = t => (t[0].clientX + t[1].clientX) / 2;
  cv.addEventListener('touchstart', e => {
    if (e.touches.length === 1 && !api.pick?.(e.touches[0])) down(e.touches[0].clientX);
    if (e.touches.length === 2) { const st = api.state(); if (!st?.geo) return; const r = range(st); pinch = {d:dist(e.touches), span:r.span, pos:posAt(st, r, mid(e.touches)), pw:st.geo.pw, padL:st.geo.padL}; drag = null; }
  }, {passive:true});
  cv.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault(); const st = api.state(); if (!st) return;
      const span = clamp(pinch.span * pinch.d / Math.max(1, dist(e.touches)), MIN_SPAN, maxSpan(st));
      setLeft(st, pinch.pos - (mid(e.touches) - cv.getBoundingClientRect().left - pinch.padL) / pinch.pw * span, span); return;
    }
    if (e.touches.length === 1 && move(e.touches[0].clientX)) e.preventDefault();
  }, {passive:false});
  cv.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) drag = null; });
  cv.addEventListener('dblclick', () => api.set(null));
  // the same actions as buttons (for people who don't know about the wheel) and keys
  const ctl = {
    zoom: f => { const st = api.state(); if (!st?.geo) return; const r = range(st); api.set({span:clamp(r.span * f, MIN_SPAN, maxSpan(st)), endOff:r.endOff}); },
    pan: k => { const st = api.state(); if (!st?.geo) return; const r = range(st); api.set({span:r.span, endOff:r.endOff + r.span * k}); },
    latest: () => { const st = api.state(); if (!st?.geo) return; api.set({span:range(st).span}); },   // keep the zoom, default right margin
    reset: () => api.set(null),
  };
  const bar = document.createElement('div'); bar.className = 'ctools';
  bar.innerHTML = `<button data-z="out" title="Отдалить (−)" aria-label="Отдалить">−</button><button data-z="in" title="Приблизить (+)" aria-label="Приблизить">+</button>`
    + `<button data-z="reset" title="Обычный вид (0 или двойной клик)" aria-label="Обычный вид">⟲</button>`
    + (api.tools || '') + (api.expand ? `<button data-z="expand" title="Развернуть график на всю ширину (F)" aria-label="Развернуть график">⤢</button>` : '')
    + `<button data-z="latest" class="ct-latest" title="К последней свече (End)" aria-label="К последней свече"><span class="ctl-t">к последней свече </span>→</button>`;   // a phone's charts keep the arrow only
  cv.parentElement.appendChild(bar);
  // "to the latest candle" shows up only when the view has been scrolled into the past
  const sync = () => { const st = api.state(); bar.classList.toggle('away', !!st?.geo && range(st).endOff > 2); };
  const set0 = api.set; api.set = v => { set0(v); sync(); };
  bar.onclick = e => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') ctl.zoom(1 / 1.4); if (z === 'out') ctl.zoom(1.4); if (z === 'latest') ctl.latest(); if (z === 'reset') ctl.reset();
    if (z === 'expand') api.expand();
    else if (z && !['in', 'out', 'latest', 'reset'].includes(z) && api.onTool) api.onTool(z, e.target.closest('[data-z]'));
  };
  cv.addEventListener('mousedown', () => cv.focus({preventScroll:true}));
  cv.addEventListener('keydown', e => {
    const k = e.key;
    if (k === 'ArrowLeft') ctl.pan(0.15); else if (k === 'ArrowRight') ctl.pan(-0.15);
    else if (k === '+' || k === '=') ctl.zoom(1 / 1.4); else if (k === '-' || k === '_') ctl.zoom(1.4);
    else if (k === 'End') ctl.latest(); else if (k === '0') ctl.reset();
    else if ((k === 'f' || k === 'F' || k === 'а' || k === 'А') && api.expand) bar.querySelector('[data-z=expand]').click();
    else if (!api.key?.(k.toLowerCase())) return;
    e.preventDefault();
  });
  return {sync};
}
const barAt = (t, time) => { let i = 0; while (i + 1 < t.length && t[i + 1] <= time) i++; return i; };

export {renderChart, hoverIndex, priceAt, viewRange, wheelPx, wheelZoom, perFrame, attachZoom, barAt};
