// The journal and the trade card (docs/PLAN-UNTANGLE-modules.md, wave 5): the balance chart and its pointer, the cards, the tables,
// their sorting and filters; the card of a trade, opened from the journal and the backtest. What ran at load in the page is start(),
// called by the page at the same place as before. The journals themselves (J, SJ, SB_MINE), closing by hand and the reset are with
// the bot, app/bot.js; the page hands them over in start(): an import here would close a circle (bot.js imports this module).
import * as M from '../supabase/functions/_shared/math.js';
import {$, firstShow, save, savedSort, keepFocus, PC, fp, usd, rr, cl, dt, dur, base, pair, tfOf, coin, money, curH, plural, reasonTag, METHOD_NAME, isPhone, normQ, api, esc} from './core.js';
import './account.js';   // savedSort below reads the storage when this module loads: after the profile's values are there
import {renderChart, hoverIndex, viewRange, perFrame, attachZoom, barAt} from './chart.js';
const { TFMS, clamp, bands, rsi, parse } = M;

// the page's own functions and values this code needs: given by start() as wrappers, since some are declared further down the page
// and J, SJ, SB_MINE, BP, jMode, tgBot are assigned anew in app/bot.js
const hooks = {};

// ---------- journal ----------
const lastBal = {};
function countUp(el, from, to, fmt, ms = 650) {
  if (!el || from == null || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now(), ease = x => 1 - (1 - x) ** 3;
  const step = t => { const k = Math.min(1, (t - t0) / ms); el.innerHTML = fmt(from + (to - from) * ease(k)); if (k < 1) requestAnimationFrame(step); };   // fmt gives figures and our own markup only
  requestAnimationFrame(step);
}
// the browser journal keeps its newest JMAX trades (owner's choice 12.11): ~1 KB a trade, and a full storage would stop saving it
// at all. The trades that go are folded into J.cut {n, pnl}; the balance chart, its peak and the drawdown start from
// baseOf = start + cut.pnl, so they still end at the balance. The other journals (server bots) have no cut: baseOf = start
const JMAX = 3000, baseOf = D => D.start + (+D.cut?.pnl || 0);
function capJournal() {
  const J = hooks.J();
  if (J.closed.length <= JMAX) return;
  const gone = J.closed.splice(JMAX);   // newest first: the oldest go
  J.cut = {n:(J.cut?.n || 0) + gone.length, pnl:(+J.cut?.pnl || 0) + gone.reduce((s, x) => s + (+x.pnl || 0), 0)};
}
const peakOf = D => { let b = baseOf(D), pk = b; for (const x of [...D.closed].sort((a, b2) => a.tclose - b2.tclose)) { b += x.pnl; pk = Math.max(pk, b); } return pk; };
// balance over time: a step line — the balance only changes when a trade closes.
// key: 'j' the journal's chart, 'bt' the backtest's — both can be on the page at once (one hidden), so ids carry it.
// EQ keeps each chart's points for the pointer and the keyboard (eqShow); EQH — the point shown, to show it again after a redraw
const EQ = new Map(), EQH = {key:null, t:null, sticky:false};
function equityChart(D, tEnd, key = 'j') {
  const cl2 = [...D.closed].sort((a, b) => a.tclose - b.tclose);
  if (!cl2.length) { EQ.delete(key); return `<div class="hempty">Закрытых сделок пока нет — здесь появится график баланса и итоги: winrate, средний результат, комиссии, просадка.</div>`; }
  const t0 = Math.min(...cl2.map(x => x.time)), t1 = tEnd ?? Date.now();
  const pts = [{t:t0, b:baseOf(D), dd:0}]; let b = baseOf(D);
  for (const x of cl2) { b += x.pnl; pts.push({t:x.tclose, b, x}); }
  // the deepest fall from a peak, measured as M.journalStats measures «Макс. просадка» (same order, same sums, so the band
  // and the number agree): «8.5%» is from the highest balance before it, not from the start — on a chart from 10k to 40k
  // it looked like a small step that never went below the start
  let peak = baseOf(D), pkI = 0, dd = 0, ddPk = 0, ddTr = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].b > peak) { peak = pts[i].b; pkI = i; }
    pts[i].dd = (peak - pts[i].b) / peak;
    if (pts[i].dd > dd) { dd = pts[i].dd; ddPk = pkI; ddTr = i; }
  }
  pts.push({t:t1, b, dd:pts[pts.length - 1].dd, end:true});
  let mn = Math.min(...pts.map(p => p.b)), mx = Math.max(...pts.map(p => p.b));
  const pad = (mx - mn) * 0.18 || Math.max(1, mx * 0.002); mn -= pad; mx += pad;
  const W = 1000, H = 150, X = t => (t - t0) / Math.max(1, t1 - t0) * W, Y = v => (mx - v) / (mx - mn) * H, f = v => v.toFixed(1);
  let d = `M${f(X(pts[0].t))},${f(Y(pts[0].b))}`;
  for (let i = 1; i < pts.length; i++) d += ` H${f(X(pts[i].t))} V${f(Y(pts[i].b))}`;
  const col = b >= D.start ? PC.lo : PC.up, ys = Y(D.start) / H * 100, ye = Y(b) / H * 100;
  EQ.set(key, {pts, t0, t1, mn, mx, col, start:D.start, live:!tEnd});
  // the band of the deepest drawdown, and its size on it: from the left edge of the band when it is in the left half, else
  // from the right edge, so the words never run off the chart; at the bottom when the «старт» label is in the upper half
  const bx0 = X(pts[ddPk].t), bx1 = X(pts[ddTr].t), ddPct = (dd * 100).toFixed(1);
  const band = dd >= 0.0005 ? `<rect x="${f(bx0)}" y="0" width="${f(Math.max(3, bx1 - bx0))}" height="${H}" fill="${PC.up}" fill-opacity=".1"/>` : '';
  const ddLab = dd >= 0.0005 ? `<span class="hdd neg" style="${(bx0 + bx1) / 2 < W / 2 ? `left:${f(bx0 / 10)}%` : `right:${f(100 - bx1 / 10)}%`};${ys < 50 ? 'bottom' : 'top'}:3px">макс. просадка −${ddPct}%</span>` : '';
  return `<div class="hchart" data-eq="${key}"${firstShow(key === 'bt' ? `eq-bt-${tEnd}-${cl2.length}` : 'eq-' + key)} tabindex="0" role="group" aria-label="График баланса по закрытым сделкам: старт $${money(D.start)}, ${tEnd ? 'в конце' : 'сейчас'} $${money(b)}${dd >= 0.0005 ? `, макс. просадка ${ddPct}%` : ''}. Стрелки влево и вправо — по сделкам">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="eqg-${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".25"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      ${band}<line x1="0" x2="${W}" y1="${f(Y(D.start))}" y2="${f(Y(D.start))}" stroke="${PC.base}" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>
      <path d="${d} V${H} H0 Z" fill="url(#eqg-${key})"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
      <span class="hlab" style="top:${ys}%">старт $${money(D.start)}</span>${ddLab}
      <span class="hend" style="top:${ye}%;background:${col}"></span>
      <span class="hdim" hidden></span><span class="hcross" hidden></span><span class="hdot" hidden></span><div class="htip" hidden></div><span class="sr" aria-live="polite"></span></div>
    <div class="haxis"><span>${dt(t0)}</span><span>${dt((t0 + t1) / 2)}</span><span>${tEnd ? dt(t1) : 'сейчас'}</span></div>`;
}
// the point under the pointer: the trade close nearest in time (a binary search — a long backtest has thousands)
function eqAt(el, cx) {
  const E = EQ.get(el.dataset.eq), r = el.getBoundingClientRect(), t = E.t0 + (cx - r.left) / Math.max(1, r.width) * (E.t1 - E.t0), P = E.pts;
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t <= t) lo = m; else hi = m; }
  return t - P[lo].t <= P[hi].t - t ? lo : hi;
}
// a vertical line, a dot on the balance and a note: date, balance, change from the start, drawdown from the peak, the trade
// closed at that moment. say: also read it out (keyboard) — on every mouse move a screen reader would never stop talking
function eqShow(el, i, say = false) {
  const E = EQ.get(el.dataset.eq); if (!E) return;
  i = clamp(i, 0, E.pts.length - 1);
  const p = E.pts[i], W = el.clientWidth, x = (p.t - E.t0) / Math.max(1, E.t1 - E.t0) * W, y = (E.mx - p.b) / (E.mx - E.mn) * el.clientHeight;
  const ln = el.querySelector('.hcross'), dot = el.querySelector('.hdot'), tip = el.querySelector('.htip'), dim = el.querySelector('.hdim');
  Object.assign(EQH, {key:el.dataset.eq, t:p.t});
  ln.hidden = dot.hidden = tip.hidden = false;
  ln.style.left = dot.style.left = x + 'px'; dot.style.top = y + 'px'; dot.style.background = E.col; dot.style.color = E.col;
  // a tactile chart (DESIGN-RULES п. 69): what lies after the point dims, and the large balance above shows the point's value
  if (dim) { dim.hidden = false; dim.style.left = x + 'px'; }
  const chg = p.b / E.start - 1, tr = p.x;
  const hv = el.closest('.hero')?.querySelector('.hv');
  if (hv) { if (hv.dataset.orig == null) hv.dataset.orig = hv.innerHTML; hv.innerHTML = curH('$' + money(p.b)); hv.classList.add('peek'); }
  tip.innerHTML = `<div class="faint">${i === 0 ? 'старт · ' : ''}${p.end ? (E.live ? 'сейчас' : 'конец периода') : dt(p.t)}</div>`
    + `<div><b>$${money(p.b)}</b> <span class="${cl(chg)}">${chg >= 0 ? '+' : '−'}${Math.abs(chg * 100).toFixed(1)}%</span> <span class="faint">от старта</span></div>`
    + (i ? `<div>${p.dd >= 0.0005 ? `<span class="neg">−${(p.dd * 100).toFixed(1)}%</span> <span class="faint">от пика</span>` : '<span class="faint">на пике</span>'}</div>` : '')
    + (tr ? `<div>${pair(tr.sym)} ${tr.side} · ${tr.reason || '—'} · <span class="${cl(tr.pnl)}">${usd(tr.pnl)}</span></div>` : '');
  const tw = tip.offsetWidth;
  tip.style.left = (x + 12 + tw <= W ? x + 12 : Math.max(0, x - 12 - tw)) + 'px';
  if (say) el.querySelector('.sr').textContent = tip.textContent;
}
function eqHide(el) {
  for (const s of ['.hcross', '.hdot', '.htip', '.hdim']) { const n = el?.querySelector(s); if (n) n.hidden = true; }
  const hv = el?.closest('.hero')?.querySelector('.hv');
  if (hv?.dataset.orig != null) { hv.innerHTML = hv.dataset.orig; delete hv.dataset.orig; hv.classList.remove('peek'); }
  if (!el || EQH.key === el.dataset.eq) Object.assign(EQH, {key:null, t:null, sticky:false});
}
// the journal is redrawn every 30-60 s: a note still shown (the mouse hasn't left, the finger hasn't tapped elsewhere, the
// keyboard is on it) comes back on the same moment
const eqIdx = (E, t) => { const i = E.pts.findIndex(p => p.t >= t); return i < 0 ? E.pts.length - 1 : i; };
function eqRestore(key) {
  if (EQH.key !== key || EQH.t == null) return;
  const el = document.querySelector(`.hchart[data-eq="${key}"]`), E = EQ.get(key);
  if (el && E) eqShow(el, eqIdx(E, EQH.t)); else Object.assign(EQH, {key:null, t:null, sticky:false});
}
// mouse: the note follows the pointer and goes when it leaves. A finger: a tap or a sideways drag shows the point and it stays
// until a tap elsewhere; a scroll that starts on the chart shows nothing (touch-action: pan-y leaves up-down to the page,
// and the browser cancels the pointer when it scrolls)
let eqMove = null, eqTap = null;
const eqMoveSoon = perFrame(() => { if (eqMove?.el.isConnected) eqShow(eqMove.el, eqAt(eqMove.el, eqMove.x)); });
const eqOf = e => { const el = e.target.closest?.('.hchart[data-eq]'); return el && EQ.has(el.dataset.eq) ? el : null; };
function equitySvg(D, W = 150, H = 26) {
  const pts = [D.start]; [...D.closed].sort((a, b) => a.tclose - b.tclose).forEach(x => pts.push(pts[pts.length-1] + x.pnl));
  if (pts.length < 2) return '';
  const mn = Math.min(...pts, D.start), mx = Math.max(...pts, D.start), pad = 3;
  const Y = v => (pad + (H - 2 * pad) * (1 - (mx === mn ? 0.5 : (v - mn) / (mx - mn)))).toFixed(1);
  const d = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${Y(v)}`).join(' ');
  const col = pts[pts.length-1] >= D.start ? PC.lo : PC.up;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;width:100%;max-width:${W}px;height:${H}px">
    <line x1="0" x2="${W}" y1="${Y(D.start)}" y2="${Y(D.start)}" stroke="${PC.base}" stroke-dasharray="3 3"/>
    <polyline points="0,${H} ${d} ${W},${H}" fill="${col}" fill-opacity=".08" stroke="none"/>
    <polyline points="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
const scoreOf = p => p.snap?.score ?? (String(p.note || '').match(/(?:оценка|сила) (\d+)/)?.[1] ?? '—');
let [jSort, jDir] = savedSort('sr_jsort', '#jhead', ['tclose', -1]);
const journalData = () => hooks.jMode() === 'shared' ? hooks.SJ() : (hooks.BP().where === 'server' ? hooks.SB_MINE() : hooks.J());
// ▲/▼ chip for a change: sign and arrow carry the meaning, colour only reinforces it
const deltaChip = (d, unit, tip) => !isFinite(d) || Math.abs(d) < 0.005 ? '' :
  `<span class="dchip ${d > 0 ? 'pos' : 'neg'}" title="${tip}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)}${unit}</span>`;
// one plain-language takeaway from the closed trades — the reading of the numbers, next to the numbers
function journalInsight(D, st) {
  const cl2 = D.closed.map(M.normTrade).filter(x => x.r != null && isFinite(x.r));
  let txt;
  if (cl2.length < 10) txt = cl2.length ? `Пока ${cl2.length} ${plural(cl2.length, ['сделка', 'сделки', 'сделок'])} — для выводов мало. Результату можно доверять примерно после 30 сделок.` : '';
  else {
    const avg = a => a.reduce((s, x) => s + x.r, 0) / a.length;
    const L = cl2.filter(x => x.side === 'LONG'), Sh = cl2.filter(x => x.side === 'SHORT');
    const ts = cl2.filter(x => x.reason === 'тайм-стоп').length / cl2.length;
    if (L.length >= 5 && Sh.length >= 5 && Math.sign(avg(L)) !== Math.sign(avg(Sh)))
      txt = `LONG в среднем ${rr(avg(L))}, SHORT ${rr(avg(Sh))} на сделку — ${avg(L) < 0 ? 'лонги' : 'шорты'} тянут результат вниз.`;
    else if (ts > 0.3) txt = `${Math.round(ts * 100)}% сделок закрываются по тайм-стопу — цена не успевает дойти ни до тейка, ни до стопа.`;
    else if (st.gross > 0 && st.fees > st.gross) txt = `До комиссий бот в плюсе (${usd(st.gross)}), но комиссии забрали больше (${usd(-st.fees)}).`;
    else {
      const best = Object.entries(cl2.reduce((m, x) => (m[x.sym] = (m[x.sym] || 0) + x.pnl, m), {})).sort((a, b) => b[1] - a[1]);
      const [top, bot] = [best[0], best[best.length - 1]];
      if (best.length >= 2 && top[1] > 0 && bot[1] < 0) txt = `Больше всего принесла ${pair(top[0])} (${usd(top[1])}), больше всего забрала ${pair(bot[0])} (${usd(bot[1])}).`;
    }
  }
  return txt ? `<div class="insight"><svg class="i"><use href="#i-info"/></svg><span>${txt}</span></div>` : '';
}
function renderJournal() { const r = keepFocus(renderJournalNow); eqRestore('j'); return r; }
function renderJournalNow() {
  const {renderServer, profSet, activeProfile, sharedNoEdge, sharedIdle, sharedProf, profPlain, profSummary, liveTag, tickLive, openPnl} = hooks;
  const S = hooks.S(), SJ = hooks.SJ(), jMode = hooks.jMode(), tgBot = hooks.tgBot();
  document.querySelectorAll('.jm').forEach(b => b.classList.toggle('on', b.dataset.m === jMode));
  $('#jmine').classList.toggle('hidden', jMode !== 'mine');
  $('#pimp').classList.toggle('off', jMode !== 'mine');   // a shared profile's offer is for «Мой бот» (.hidden stays its own: shown / answered)
  renderServer();
  const D = journalData(), shared = jMode === 'shared';
  const slots = M.slotsOf(shared ? SJ?.settings : profSet(activeProfile()));   // how many positions this bot may hold at once
  if (!D) { $('#jdesc').textContent = shared ? 'Загружаю журнал общего бота…' : 'Загружаю журнал вашего бота с сервера…'; ['#jwarn', '#jcards', '#jopen', '#jclosed', '#jcoins tbody'].forEach(s => $(s).innerHTML = ''); ['#jfilters', '#jshown'].forEach(s => $(s).classList.add('hidden')); return; }
  const st = M.journalStats(baseOf(D), D.closed), set = shared ? SJ.settings : S;
  $('#jwarn').innerHTML = shared && sharedNoEdge() ? `<div class="banner warn noedge"><svg class="i"><use href="#i-warn"/></svg><div><b>У правил общего бота не найдено преимущества.</b>
        На честной проверке — топ-50 монет на каждый момент, включая снятые с биржи, — они в минусе каждый из трёх последних лет: <span class="term" title="R — риск одной сделки: сумма, которую она теряет, если сработал стоп. −0.42R на сделку — в среднем каждая сделка теряла почти половину этой суммы">−0.42R, −0.40R и −0.30R на сделку</span>.
        Общий бот показывает, как работает бот, а не стратегию, по которой стоит торговать. Проверить самому — кнопка «Проверить в бэктесте» ниже.</div></div>` : '';
  $('#jdesc').innerHTML = shared
    ? `Один бот для всех — торгует на сервере круглосуточно, даже когда сайт закрыт. ${liveTag(SJ.checked, 5 * 60e3, 'проверка рынка')}
      <div class="sprof"><div style="min-width:0;flex:1"><span class="faint">Профиль общего бота</span><div class="pplain">${profPlain(sharedProf())}</div><div class="ptech">${profSummary(sharedProf())}</div></div>
        <div class="sprof-a">${tgBot ? `<button id="jSharedTg" title="Входы и выходы общего бота — сообщениями в Telegram">Получать в Telegram</button>` : ''}<button id="jSharedBt" title="Перенести правила общего бота в бэктест и проверить их на истории">Проверить в бэктесте</button></div></div>${sharedIdle()}`
    : `Ваш личный бот на виртуальные $${Math.round(D.start || 10000).toLocaleString('ru')}: торгует по вашим профилям, журнал видите только вы.`;
  tickLive();
  const card = (t, v, s, c = '', tip = '') => `<div class="card"${tip ? ` title="${tip}"` : ''}><div class="t">${t}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
  const other = !shared && SJ ? M.journalStats(SJ.start, SJ.closed) : null;
  const chg = D.balance / D.start - 1, cutN = +D.cut?.n || 0, allNet = st.net + (+D.cut?.pnl || 0);   // cut: trades past JMAX
  // last 7 days and the last 20 trades, so the cards say which way things are going, not only where they are
  const wk = D.closed.filter(x => Date.now() - x.tclose < 7 * 864e5), wkNet = wk.reduce((a, x) => a + x.pnl, 0);
  const recent = [...D.closed].sort((a, b) => b.tclose - a.tclose).slice(0, 20).map(M.normTrade).map(x => x.r).filter(x => x != null && isFinite(x));
  const recR = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const trend = st.n >= 25 && recR != null && st.expR != null ? deltaChip(recR - st.expR, 'R', `последние 20 сделок: ${rr(recR)}`) : '';
  $('#jcards').innerHTML =
    `<div class="hero">
       <div class="htop">
         <div><div class="t">Баланс · виртуальный</div>
           <div class="hv">${curH('$' + money(D.balance))}</div>
           <div class="hchg"><span class="chip ${allNet > 0 ? 'pos' : allNet < 0 ? 'neg' : 'flat'} ${cl(allNet)}">${usd(allNet)} · ${chg >= 0 ? '+' : '−'}${Math.abs(chg * 100).toFixed(2)}%</span><span class="faint">за всё время, после комиссий</span>
             ${wk.length && wk.length < D.closed.length ? `<span class="chip ${wkNet > 0 ? 'pos' : wkNet < 0 ? 'neg' : 'flat'} ${cl(wkNet)}" style="margin-left:10px">${wkNet > 0 ? '▲' : wkNet < 0 ? '▼' : ''} ${usd(wkNet)}</span><span class="faint">за 7 дней · ${wk.length} ${plural(wk.length, ['сделка', 'сделки', 'сделок'])}</span>` : ''}</div></div>
         <div class="hside">
           <div>Старт<b>${curH('$' + money(D.start))}</b></div>
           <div>Пик<b>${curH('$' + money(peakOf(D)))}</b></div>
           <div>Закрыто сделок<b>${st.n + cutN}</b>${cutN ? `<span class="faint" title="Журнал в браузере хранит последние ${JMAX} сделок; итог за всё время и баланс учитывают все">хранятся ${JMAX}</span>` : ''}</div>
         </div>
       </div>
       ${equityChart(D)}
       ${journalInsight(D, st)}
     </div>
     ${st.n ? `<div class="statrow">
       ${card('Сделок', st.n, `открыто ${D.open.length} из ${slots}`, '', 'Сколько сделок закрыто за всё время и сколько позиций открыто сейчас из возможных')}
       ${card('Winrate', st.wr == null ? '—' : st.wr.toFixed(0) + '%', `${st.win} в плюс · ${st.loss} в минус`, '', 'Доля прибыльных сделок')}
       ${card('Ср. результат', rr(st.expR) + trend, other ? `у общего бота ${rr(other.expR)}` : 'на сделку', cl(st.expR),'Средний итог сделки в R после комиссий. R — риск одной сделки: сумма, которую она теряет, если сработал стоп; +1R — заработали столько же. Больше 0 — у стратегии есть преимущество. Главная цифра журнала')}
       ${card('Profit factor', st.pf == null ? '—' : st.pf.toFixed(2), 'прибыли / убытки', st.pf == null ? '' : st.pf >= 1 ? 'pos' : 'neg', 'Сумма прибылей, делённая на сумму убытков. Больше 1 — в плюсе')}
       ${card('Комиссии и заём', usd(-st.fees), `до них ${usd(st.gross)}`, st.fees ? 'neg' : '', 'Сколько забрала биржа: комиссия и проценты за заём под шорты и плечо. Если это больше прибыли до них — стратегия работает на биржу')}
       ${card('Просадка', st.maxDD.toFixed(1) + '%', 'максимальная', st.maxDD > 10 ? 'neg' : '', 'Самое большое падение баланса от предыдущего пика, а не от старта. На графике баланса оно подсвечено')}
     </div>` : ''}`;
  // the balance counts to its new value instead of jumping (only when it actually changed)
  countUp($('#jcards .hv'), lastBal[jMode], D.balance, v => curH('$' + money(v))); lastBal[jMode] = D.balance;
  const now = Date.now();
  $('#jopen').innerHTML = D.open.map(p => {
    const last = p.last ?? p.entry, {u, risk} = openPnl(p);
    return `<tr tabindex="0" class="row" data-kind="open" data-id="${p.id}" title="Открыть карточку позиции"><td>${dt(p.time)} <span class="faint">${dur(now - p.time)}</span></td><td>${coin(p.sym)}</td>
      <td class="${p.side === 'LONG' ? 'pos' : 'neg'}">${p.side}</td><td>${fp(p.entry)}</td><td>${fp(last)}</td><td class="hm">$${(p.qty * p.entry).toFixed(0)}</td><td class="hm">${fp(p.tp)}</td><td class="hm">${fp(p.sl)}</td>
      <td class="${cl(u)}">${usd(u)}</td><td class="${cl(u)}">${rr(risk ? u / risk : null)}</td><td>${scoreOf(p)}</td>
      <td class="jx">${jMode === 'mine' ? `<button data-close="${p.id}"${p.closeReq ? ' disabled' : ''} title="Закрыть позицию по рынку">${p.closeReq ? 'закрывается…' : 'Закрыть'}</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="12" class="mute">Нет открытых позиций — бот ждёт подтверждённого сигнала</td></tr>';
  $('#jcloseAll').classList.toggle('hidden', jMode !== 'mine' || D.open.filter(p => !p.closeReq).length < 2);
  renderClosed(D);
}
// «Закрытые сделки»: the search and the result filter, over the trades or over the summary by coin. All of it is this visit's
// view, not saved: a reload shows every trade. A trade is profitable as in the cards above (M.journalStats): pnl > 0, the rest
// are losses; in the summary the filter goes by the coin's total
let jRes = '', jView = 'list', cSort = 'n', cDir = -1;
const C_SORTS = {sym:['Монета', 'А → Я', 'Я → А'], n:['Сделок'], win:['Прибыльных'], loss:['Убыточных'], pnl:['PnL'], r:['R']};
const sortHead = (head, k, d) => document.querySelectorAll(head + ' th').forEach(th => { const on = th.dataset.s === k;
  th.classList.toggle('sorted', on); th.dataset.dir = on ? (d > 0 ? 'asc' : 'desc') : ''; th.setAttribute('aria-sort', on ? (d > 0 ? 'ascending' : 'descending') : 'none'); });
const sortBy = (k, d) => (a, b) => { const x = a[k], y = b[k]; return (typeof x === 'string' ? x.localeCompare(y) : (x ?? -1e9) - (y ?? -1e9)) * d; };
function coinSums(trades) {
  const m = new Map();
  for (const x of trades) {
    let g = m.get(x.sym); if (!g) m.set(x.sym, g = {sym:x.sym, n:0, win:0, loss:0, pnl:0, r:null});
    g.n++; x.pnl > 0 ? g.win++ : g.loss++; g.pnl += x.pnl;
    if (x.r != null && isFinite(x.r)) g.r = (g.r ?? 0) + x.r;
  }
  return [...m.values()];
}
function renderClosed(D = journalData()) {
  if (!D) return;
  const all = D.closed.map(M.normTrade), coins = jView === 'coins' && all.length > 0, q = normQ($('#jq').value);
  const seg = (sel, k, v) => document.querySelectorAll(sel + ' .tab').forEach(b => { const on = b.dataset[k] === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  seg('#jres', 'jr', jRes); seg('#jview', 'jv', jView);
  $('#jfilters').classList.toggle('hidden', !all.length);
  $('#jcsort').classList.toggle('hidden', !coins); $('#jcsort').value = `${cSort}:${cDir}`;
  ['#jcoinsW', '#jhintC'].forEach(s => $(s).classList.toggle('hidden', !coins)); ['#jlistW', '#jhintL'].forEach(s => $(s).classList.toggle('hidden', coins));
  const src = coins ? coinSums(all) : all, on = all.length > 0 && !!(q || jRes);
  const list = src.filter(x => (!q || base(x.sym).includes(q)) && (!jRes || (x.pnl > 0) === (jRes === 'win')));
  $('#jshown').classList.toggle('hidden', !on);
  $('#jshown').innerHTML = on ? `<span class="mute">Показано <b>${list.length}</b> из ${src.length}</span><button class="chip clear" data-jclear>Сбросить</button>` : '';
  // nothing left: what was looked for is named, so the trades don't look lost
  const kind = jRes === 'win' ? 'прибыльных ' : jRes === 'loss' ? 'убыточных ' : '';
  const empty = n => `<tr><td colspan="${n}" class="mute tbl-empty">${!all.length ? 'Сделок пока нет. Пропуск сделок — норма: бот ждёт подтверждённых сигналов.'
    : `${q ? `По запросу «${esc($('#jq').value.trim())}» ${kind}${coins ? 'монет' : 'сделок'} нет` : `${kind[0].toUpperCase() + kind.slice(1)}${coins ? 'монет' : 'сделок'} нет`} <button data-jclear>Сбросить фильтры</button>`}</td></tr>`;
  if (coins) {
    sortHead('#jchead', cSort, cDir);
    list.sort((a, b) => sortBy(cSort, cDir)(a, b) || b.n - a.n || a.sym.localeCompare(b.sym));
    $('#jcoins tbody').innerHTML = list.map(g => `<tr><td>${coin(g.sym)}</td><td data-l="Сделок">${g.n}</td><td data-l="Прибыльных">${g.win}</td><td data-l="Убыточных">${g.loss}</td>
      <td data-l="PnL" class="${cl(g.pnl)}"><b>${usd(g.pnl)}</b></td><td data-l="R" class="${cl(g.r)}">${rr(g.r)}</td></tr>`).join('') || empty(6);
    return;
  }
  list.sort(sortBy(jSort, jDir));
  sortHead('#jhead', jSort, jDir);
  // in the usual order (newest first) the trades come in days, each headed with its count and result: a log of what each day
  // brought. Sorted by anything else there are no days to group by
  const byDay = jSort === 'tclose' && jDir < 0, dayOf = t => new Date(t).toDateString(), days = {};
  if (byDay) for (const x of list) { const g = days[dayOf(x.tclose)] ||= {n:0, pnl:0}; g.n++; g.pnl += x.pnl; }
  let lastDay = '';
  const dayRow = x => {
    if (!byDay || dayOf(x.tclose) === lastDay) return '';
    lastDay = dayOf(x.tclose); const g = days[lastDay], d = new Date(x.tclose);
    return `<tr class="jday"><td colspan="12">${d.toLocaleDateString('ru', {day:'numeric', month:'long', weekday:'short', ...(d.getFullYear() !== new Date().getFullYear() && {year:'numeric'})})} · ${g.n} ${plural(g.n, ['сделка', 'сделки', 'сделок'])} · <span class="${cl(g.pnl)}">${usd(g.pnl)}</span></td></tr>`;
  };
  $('#jclosed').innerHTML = list.map(x => dayRow(x) + `<tr tabindex="0" class="row" data-kind="closed" data-id="${x.id}" title="Открыть карточку сделки"><td>${dt(x.tclose)}</td><td>${coin(x.sym)}</td>
    <td class="${x.side === 'LONG' ? 'pos' : 'neg'}">${x.side}</td><td>${fp(x.entry)}</td><td>${fp(x.exit)}</td><td class="hm">$${x.size.toFixed(0)}</td>
    <td>${reasonTag(x.reason)}</td><td class="hm mute">${dur(x.hold)}</td><td class="hm ${cl(x.gross)}">${usd(x.gross)}</td><td class="hm neg">${usd(-x.fee)}</td>
    <td class="${cl(x.pnl)}"><b>${usd(x.pnl)}</b></td><td class="${cl(x.r)}">${rr(x.r)}</td></tr>`).join('')
    || empty(12);
}

// ---------- trade card ----------
let tcard = null, zmT = null, cardReq = 0; // {d, opts}; the trade chart's zoom controls; the open card's request for candles
function openTrade(kind, id) {
  const S = hooks.S(), SJ = hooks.SJ(), jMode = hooks.jMode();
  const D = journalData();
  const raw = (kind === 'open' ? D.open : D.closed).find(x => String(x.id) === String(id));
  if (raw) showTrade(raw, {isOpen:kind === 'open', who:jMode === 'shared' ? 'общий бот' : 'мой бот', set:jMode === 'shared' ? SJ.settings : S});
}
async function showTrade(raw, {isOpen, who, set: fallback}) {
  const x = isOpen ? raw : M.normTrade(raw);
  const set = x.snap?.settings || fallback;
  const tf = x.snap?.settings?.tf || tfOf(x.tfms) || set.tf, tfms = TFMS[tf];
  const sg = x.side === 'LONG' ? 1 : -1;
  // the card takes the focus (a keyboard or screen-reader user lands in it) and gives it back to what opened it on close
  if ($('#modal').classList.contains('hidden')) { modalBack = document.activeElement; requestAnimationFrame(() => $('#mclose').focus({preventScroll:true})); }
  $('#modal').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#mtitle').textContent = `${pair(x.sym)} — ${isOpen ? 'открытая позиция' : 'сделка'}`;
  $('#mmeta').innerHTML = `<span class="dchip ${x.side === 'LONG' ? 'pos' : 'neg'}">${x.side}</span> ${who} · ${isOpen ? 'открыта ' + dt(x.time) : dt(x.time) + ' → ' + dt(x.tclose)} · ${tf}`;
  // aside: the result first (PnL and R), where the price stands between the stop and the take, then the numbers in groups
  const last = isOpen ? (x.last ?? x.entry) : x.exit, risk = x.risk || Math.abs(x.entry - x.sl) * x.qty;
  // a closed trade shows what was recorded (normTrade fills old records): its fee holds the interest on the loan (fin) too.
  // Counted here anew, the card of a short or a leveraged long left the loan out — its PnL and R were above the table's row
  // while the line under them said «комиссия и заём»
  const gross = isOpen ? sg * (last - x.entry) * x.qty : x.gross, fee = isOpen ? (x.entry + last) * x.qty * M.FEE : x.fee, net = isOpen ? gross - fee : x.pnl;
  const pct = v => { const p = (v / x.entry - 1) * 100; return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(2) + '%'; };
  const tile = (k, v, c = '', sub = '') => `<div><span>${k}</span><b class="${c}">${v}</b>${sub ? `<i>${sub}</i>` : ''}</div>`;
  const group = (h, tiles) => `<h4>${h}</h4><div class="ttiles">${tiles}</div>`;
  // the stop is 0 and the take 1 for either side, so the bar always reads «risk on the left, reward on the right»
  const at = p => (clamp((p - x.sl) / (x.tp - x.sl), 0, 1) * 100).toFixed(1), pe = at(x.entry), pc = at(last), mv = sg * (last - x.entry);
  const nowW = isOpen ? 'сейчас' : 'выход';
  let html = `<div class="thero">
    <div class="thero-k">${isOpen ? 'PnL сейчас' : 'PnL после комиссий'}</div>
    <div class="thero-v"><b class="${cl(net)}">${curH(usd(net))}</b><span class="${cl(net)}">${rr(!isOpen && x.r != null ? x.r : risk ? net / risk : null)}</span></div>
    <div class="thero-s">до комиссий ${usd(gross)} · ${x.fin ? 'комиссия и заём' : 'комиссия'} ${usd(-fee)}${x.fin ? ` (заём ${usd(-x.fin)})` : ''}</div>
    <div class="tpath" role="img" aria-label="Цена между стопом и тейком: вход ${fp(x.entry)}, ${nowW} ${fp(last)} (${pct(last)}), стоп ${fp(x.sl)}, тейк ${fp(x.tp)}">
      <div class="tpath-bar"><i class="${cl(mv)}" style="left:${Math.min(pe, pc)}%;width:${Math.abs(pc - pe).toFixed(1)}%"></i><b class="te" style="left:${pe}%"></b><b class="tc ${cl(mv)}" style="left:${pc}%"></b></div>
      <div class="tpath-l"><span>стоп <b class="neg">${pct(x.sl)}</b></span><span>${nowW} <b class="${cl(mv)}">${pct(last)}</b></span><span>тейк <b class="pos">${pct(x.tp)}</b></span></div>
    </div>
  </div>`;
  html += group('Цены', tile('Вход', fp(x.entry)) + tile(isOpen ? 'Сейчас' : 'Выход', fp(last), cl(mv), pct(last))
    + tile('Тейк', fp(x.tp), 'pos', pct(x.tp)) + tile('Стоп', fp(x.sl), 'neg', pct(x.sl)));
  html += group('Сделка', tile('Открыта', dt(x.time))
    + (isOpen ? tile('В сделке', dur(Date.now() - x.time)) : tile('Закрыта', dt(x.tclose)) + tile('Длительность', dur(x.hold)) + tile('Причина выхода', reasonTag(x.reason))));
  html += group('Размер и риск', tile('Позиция', '$' + (x.entry * x.qty).toFixed(2)) + tile('Монет', (+x.qty).toLocaleString('ru', {maximumFractionDigits: x.qty >= 100 ? 0 : x.qty >= 1 ? 2 : 6}))
    + tile('Риск (1R)', '$' + risk.toFixed(2), '', x.snap?.riskPct ? `${x.snap.riskPct.toFixed(2)}% баланса` : '') + (x.snap?.lev ? tile('Плечо', x.snap.lev.toFixed(2) + '×') : '')
    + tile(x.fin ? 'Комиссия и заём' : 'Комиссия', usd(-fee), 'neg') + tile('Комиссия в R', risk ? '−' + (fee / risk).toFixed(2) + 'R' : '—', 'neg'));
  // «why the bot entered» goes under the chart on a wide screen (it was empty there, and the numbers above it now fit the
  // screen) and after the numbers on a narrow one (#mwhy's grid area): the signal's parts on the left, the reading on the right
  let why = `<h4>Почему бот вошёл</h4>`;
  const sd = x.snap?.study;
  if (sd) {   // a study idea of the backtest (M.STUDY): its levels and the bar they became known on, no signal strength
    const st = x.snap.settings || {};
    why = `<h4>Почему вошли</h4><div class="mute" style="font-size:13px;line-height:1.55">` + (sd.kind === 'fib'
      ? `Импульс ${sg > 0 ? 'вверх' : 'вниз'} от ${fp(sd.from)} до ${fp(sd.to)} (порог ${st.fibK} × ATR) стал известен ${dt(sd.knownT)}. Вход — на откате в зону ${st.fibZone}–${M.FIB_ZONES[st.fibZone]?.[1]}, стоп — на уровне ${st.fibStop}, цель — ${st.fibTarget ? 'расширение ' + st.fibTarget : 'вершина импульса'}.`
      : `${sd.kind === 'ob' ? 'Ордер-блок' : 'Разрыв (FVG)'} ${fp(sd.bot)} – ${fp(sd.top)} появился ${dt(sd.knownT)}${sd.kind === 'ob' ? ' — на сломе структуры' : ''}. Вход — когда цена вернулась в него, стоп — за его дальним краем, тейк — ${st.rr > 0 ? st.rr : 2} стопа.`)
      + `<div class="faint" style="font-size:12px;margin-top:8px">Учебная стратегия бэктеста: бот по ней не торгует.</div></div>`;
  } else if (x.snap) {
    const s = x.snap;
    why += `<div class="twhy"><div><div style="font-size:13px;margin-bottom:6px">Сила сигнала <b style="color:var(--acc)">${s.score}</b> из 100 · объём <b>×${s.volX?.toFixed(1)}</b> к обычному</div>` + hooks.compsHtml(s, x.side) + '</div><div>';
    // for a bounce: how much of the way back to the centre was still ahead at the entry — the whole idea of the trade
    if (isFinite(s.mid) && !/пробой/.test(x.note || '')) {
      const room = sg * (s.mid - x.entry) / x.entry * 100, stopPct = Math.abs(x.sl / x.entry - 1) * 100;
      why += `<div class="insight" style="margin-top:0"><svg class="i"><use href="#i-info"/></svg><span>До середины канала на входе оставалось <b>${room.toFixed(2)}%</b> при стопе ${stopPct.toFixed(2)}%.`
        + (room < 0.8 * stopPct ? ' Почти весь ход к середине уже случился до входа — у такого отскока мало шансов. Сейчас бот такие сделки пропускает.' : '') + '</span></div>';
    }
    why += `<div class="faint" style="font-size:12px;margin-top:8px">Настройки на входе: ${METHOD_NAME[s.settings.method]} (${s.settings.N}, ${s.settings.k}), ${s.settings.tf}, мин. сила ${s.settings.minScore}.</div></div></div>`;
  } else {
    why += `<div class="mute" style="font-size:12px">${x.note || ''}<br>Подробный снимок сигнала не сохранён: сделка открыта до обновления журнала.</div>`;
  }
  $('#maside').innerHTML = html; $('#mwhy').innerHTML = why;
  // chart; candles that come after the card was closed or another opened are dropped (they were drawn over the next card)
  const req = ++cardReq;
  tcard = null; renderChart($('#tcv'), null);
  const cv = $('#tcv'), g = cv.getContext('2d'); cv.width = cv.clientWidth; cv.height = cv.clientHeight; g.fillStyle = PC.mute; g.font = '13px system-ui'; g.fillText('Загружаю свечи…', 16, 24);
  try {
    const start = Math.floor(x.time / tfms) * tfms - (set.N + 120) * tfms, end = isOpen ? Date.now() : x.tclose + 40 * tfms;
    const K = await api(`/api/v3/klines?symbol=${x.sym}&interval=${tf}&startTime=${start}&limit=${Math.min(1000, Math.ceil((end - start) / tfms) + 1)}`);
    if (req !== cardReq) return;
    const d = parse(K); d.B = bands(d.c, set.N, set.k, set.method); d.R = rsi(d.c);
    const ei = barAt(d.t, x.time), xi = isOpen ? d.c.length - 1 : barAt(d.t, x.tclose);
    const levels = [
      {v:x.entry, col:PC.trade, tag:'вход', i0:ei, i1:xi},
      {v:x.tp, col:PC.lo, tag:'TP', i0:ei, i1:xi},
      {v:x.sl, col:PC.up, tag:'SL', i0:ei, i1:xi},
    ];
    // a study idea: the impulse, or the block / gap, from the bar it became known on
    if (sd) { const ki = barAt(d.t, sd.knownT); for (const [v, tag] of sd.kind === 'fib' ? [[sd.from, 'начало импульса'], [sd.to, 'вершина']] : [[sd.top, sd.kind === 'ob' ? 'блок' : 'FVG'], [sd.bot, '']]) levels.push({v, col:PC.mute, tag, i0:ki, i1:xi}); }
    const marks = [{i:ei, price:x.entry, col:PC.trade, label:'вход', below:sg < 0}];
    if (!isOpen) marks.push({i:xi, price:x.exit, col:x.pnl > 0 ? PC.lo : PC.up, label:`выход · ${x.reason}`, below:sg > 0});
    const from0 = Math.max(set.N - 1, ei - 120);
    tcard = {d, minFrom:set.N - 1, defSpan:d.c.length - from0, view:null, opts:{levels, marks, zones:[{i0:ei, i1:xi, entry:x.entry, tp:x.tp, sl:x.sl}], live:isOpen, hoverI:null}};
    drawCard();
  } catch (e) {
    if (req !== cardReq) return;
    g.clearRect(0, 0, cv.width, cv.height); g.fillStyle = PC.up; g.fillText('Не удалось загрузить свечи: ' + e.message, 16, 24);
  }
}
function drawCard() {
  if (!tcard) return;
  const r = viewRange(tcard.d.c.length, tcard.minFrom, tcard.view, tcard.defSpan);
  tcard.opts.from = r.from; tcard.opts.to = r.to; tcard.opts.top = hooks.chartTop();
  tcard.geo = renderChart($('#tcv'), tcard.d, tcard.opts);
  zmT?.sync();   // a new trade opens at its default view: "к последней свече" from the previous one's scrolling must go
}
const drawCardSoon = perFrame(() => drawCard());
let modalBack = null;
function closeModal() {
  if ($('#modal').classList.contains('hidden')) return;
  $('#modal').classList.add('hidden'); document.body.style.overflow = ''; tcard = null; cardReq++;
  if (modalBack?.isConnected) modalBack.focus({preventScroll:true});
  modalBack = null;
}

// ---------- what ran at load (the page calls start() where the journal section used to be) ----------
function start(h) {
  Object.assign(hooks, h);
document.addEventListener('pointermove', e => {
  const el = eqOf(e); if (!el || (e.pointerType !== 'mouse' && !eqTap)) return;
  if (e.pointerType !== 'mouse') EQH.sticky = true;
  eqMove = {el, x:e.clientX}; eqMoveSoon();
});
document.addEventListener('pointerdown', e => {
  const el = eqOf(e);
  if (!el) { if (EQH.sticky) document.querySelectorAll('.hchart[data-eq]').forEach(eqHide); return; }
  if (e.pointerType === 'mouse') { eqMove = {el, x:e.clientX}; eqMoveSoon(); } else eqTap = {el};
});
document.addEventListener('pointerup', e => { if (eqTap && e.pointerType !== 'mouse') { eqMove = {el:eqTap.el, x:e.clientX}; EQH.sticky = true; eqMoveSoon(); } eqTap = null; });
document.addEventListener('pointercancel', () => { eqTap = null; });
document.addEventListener('pointerout', e => { const el = eqOf(e); if (!el || el.contains(e.relatedTarget) || e.pointerType !== 'mouse') return; eqMove = null; eqHide(el); });
document.addEventListener('keydown', e => {
  const el = e.target; if (!el.matches?.('.hchart[data-eq]')) return;
  const E = EQ.get(el.dataset.eq); if (!E) return;
  if (e.key === 'Escape') { eqHide(el); return; }
  const n = E.pts.length, shown = EQH.key === el.dataset.eq && EQH.t != null, cur = shown ? eqIdx(E, EQH.t) : n - 1;
  const i = !shown && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? n - 1
    : e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
  if (i == null) return;
  e.preventDefault(); eqShow(el, i, true);
});
document.addEventListener('focusout', e => { if (e.target.matches?.('.hchart[data-eq]') && !EQH.sticky) eqHide(e.target); });
$('#jcsort').innerHTML = Object.entries(C_SORTS).flatMap(([k, [t, up = 'меньше сначала', dn = 'больше сначала']]) =>
  (k === 'sym' ? [[1, up], [-1, dn]] : [[-1, dn], [1, up]]).map(([d, w]) => `<option value="${k}:${d}">${t}: ${w}</option>`)).join('');
$('#mclose').onclick = closeModal;
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
// Tab stays inside the open card instead of walking the page behind it
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || $('#modal').classList.contains('hidden')) return;
  const f = [...$('#modal').querySelectorAll('button, [href], input, select, textarea, canvas, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], inside = $('#modal').contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
});
document.querySelectorAll('#jhead th').forEach(th => th.onclick = () => { const k = th.dataset.s; jDir = jSort === k ? -jDir : (k === 'sym' || k === 'reason' ? 1 : -1); jSort = k; save('sr_jsort', [jSort, jDir]); renderJournal(); });
// the closed trades' search, filter and summary by coin (renderClosed): redrawn alone, the balance above stays as it is
const cSortBy = (k, d) => { cSort = k; cDir = d; renderClosed(); };
document.querySelectorAll('#jchead th').forEach(th => th.onclick = () => { const k = th.dataset.s; cSortBy(k, cSort === k ? -cDir : (k === 'sym' ? 1 : -1)); });
$('#jcsort').onchange = e => { const [k, d] = e.target.value.split(':'); cSortBy(k, +d); };   // phones: the summary is cards, without a head to sort by
let jqT = 0;
$('#jq').oninput = e => { clearTimeout(jqT); jqT = setTimeout(renderClosed, 120); };
$('#jq').onkeydown = e => { if (e.key === 'Escape' && e.target.value) { e.preventDefault(); clearTimeout(jqT); e.target.value = ''; renderClosed(); } };
$('#jclosedP').addEventListener('click', e => {
  const r = e.target.closest('[data-jr]'), v = e.target.closest('[data-jv]');
  if (r) jRes = r.dataset.jr; else if (v) jView = v.dataset.jv;
  else if (e.target.closest('[data-jclear]')) { clearTimeout(jqT); $('#jq').value = ''; jRes = ''; if (!isPhone()) $('#jq').focus({preventScroll:true}); }
  else return;
  renderClosed();
});
const tcv = $('#tcv');
tcv.onmousemove = e => { if (!tcard) return; tcard.opts.hoverI = hoverIndex(tcard.geo, tcv, e); tcard.opts.hoverY = e.clientY - tcv.getBoundingClientRect().top; drawCardSoon(); };
tcv.onmouseleave = () => { if (!tcard) return; tcard.opts.hoverI = null; drawCardSoon(); };
zmT = attachZoom(tcv, {state:() => tcard && {n:tcard.d.c.length, minFrom:tcard.minFrom, defSpan:tcard.defSpan, view:tcard.view, geo:tcard.geo}, set:v => { tcard.view = v; drawCardSoon(); }});
}

export {renderJournal, drawCard, drawCardSoon, capJournal, baseOf, openTrade, showTrade, closeModal, equityChart, eqRestore, start};
