// Backtest (docs/PLAN-UNTANGLE-modules.md, wave 2): the history downloads, the form, the run, the verdict and the result's
// tables. The math is M.backtest (supabase/functions/_shared/math.js), the stored candles are history.js; a deep check of a run:
// tests/backtest-audit.js. What ran at load in the page is start(), called by the page at the same place as before.
import * as M from '../supabase/functions/_shared/math.js';
import * as HS from '../history.js';
import {$, load, save, fp, usd, rr, cl, dt, dur, base, coin, toast, api, pool, sleep, ask, money, curH, plural, reasonTag, METHOD_NAME, hlOpts, isPhone, layoutFix} from './core.js';
import {showTrade, equityChart, eqRestore, coinSums, coinRows, sortCoins, sortHead, sortBy, segOn} from './journal.js';
const { TFMS, clamp } = M;

// the page's own functions and values this code needs: given by start() as wrappers, since some are declared further down the page
const hooks = {};

// ---------- backtest ----------
const histCache = new Map();
let lastReq = 0, btRes = null, btBusy = false, btHist = null, histIdx, idxAsk = false;
async function throttled(path) { // backtest downloads stay well under Binance's weight limit: ≤ 750 requests a minute of weight 2 is a quarter of it
  const wait = Math.max(0, lastReq + 80 - Date.now()); lastReq = Date.now() + wait;
  if (wait) await sleep(wait);
  return api(path);
}
// candles straight from Binance, rows as history.js ([open time, o, h, l, c, volume, quote volume]); a multi-page download is
// throttled, the one-request tail after the stored history is not
async function binanceHistory(sym, tf, startT, endT, stop) {
  const tfms = TFMS[tf], out = [], get = endT - startT > 1000 * tfms ? throttled : api;
  for (let t = startT; t < endT;) {
    stop?.();
    const K = await get(`/api/v3/klines?symbol=${sym}&interval=${tf}&startTime=${t}&endTime=${endT - 1}&limit=1000`);
    if (!K.length) break;
    for (const k of K) out.push([k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
    t = K[K.length - 1][0] + tfms;
    if (K.length < 1000) break;
  }
  return out;
}
// history.js: stored months from R2 (cached in IndexedDB), the rest from Binance; anything off → all from Binance.
// Only closed candles come back. Only numbers are kept (open time, o, h, l, c, volume, close time): Binance's 12-field rows of
// strings took ~4× the memory. The close time is open + interval − 1: Binance's own differs only on outage and delisting candles,
// and nothing reads it but the "closed" check.
// stop: throws to end the download between requests (see runBacktest); a coin cut off half-way is not cached
async function fetchHistory(sym, tf, startT, endT, stop) {
  const key = `${sym}|${tf}|${startT}|${endT}`;
  // a hit moves the download to the end, so trimHistory (oldest first) drops what has not been used longest, not what came first
  if (histCache.has(key)) { const v = histCache.get(key); histCache.delete(key); histCache.set(key, v); return v; }
  const tfms = TFMS[tf];
  const K = await HS.candles(sym, tf, startT, endT, {api:(s, t, a, b) => binanceHistory(s, t, a, b, stop), stop});
  const out = K.map(k => [k[0], k[1], k[2], k[3], k[4], k[5], k[0] + tfms - 1]);
  histCache.set(key, out); histBars += out.length;
  return out;
}
// the history stays for instant reruns, but not without bound: past ~1.5M candles (~150 MB) the oldest downloads go,
// except the ones the current run uses
let histBars = 0;
function trimHistory(keep) {
  for (const [key, K] of histCache) {
    if (histBars <= 1.5e6) break;
    if (!keep(key)) { histCache.delete(key); histBars -= K.length; }
  }
}
// custom coin list: "btc, eth sol" → ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']; the layout is fixed first, so the comma key («б») splits
const parseCoins = txt => [...new Set(layoutFix(String(txt)).toUpperCase().split(/[\s,;]+/).map(x => x.replace(/[^A-Z0-9]/g, '')).filter(Boolean)
  .map(x => x.endsWith('USDT') ? x : x + 'USDT'))].slice(0, 300);
// The honest top («на каждый момент») trades, at each moment, only that moment's top-N by 24 h turnover, out of a pool loaded
// in advance — so the pool must hold every coin that was in that top at some moment of the period. Until 2.79 it was today's
// top-150…400 plus the coins delisted since: on the year to 09.11.2026 (top-20, 1h) it left out 165 of the 319 coins that were
// in the top-20 at some moment — still trading, but no longer in today's top-150 (ALLO, RE, OPN, BANK…; 12% of all top-20
// coin-hours), and a past period (a year of one's own) can't take today's top at all. Now: every pair that was in the daily
// top-K by turnover on some day of the period (or the day before: a 24 h window reaches into it), delisted ones included, plus
// today's live top-K for a period that ends now (today isn't in the daily candles yet). Checked on 2025: every coin of the
// hourly top-20 (299) was in the daily top-40 on some day (top-30 missed one); top-50: 429 coins, all in the daily top-75.
// Daily turnover from the stored daily candles (history.js); from Binance when they don't cover the period (one request a
// pair). first: the day each coin first made that top — it is loaded from 450 bars before it (the warm-up every coin gets at
// the period's start), which keeps a year of 1h on top-20 (404 coins) under the memory limit; last: its last day with candles
const periodK = top => Math.max(top + 20, Math.round(top * 1.5));
async function periodPool(tk, from, endT, top, say) {
  const syms = tk.filter(x => x.symbol.endsWith('USDT') && !M.STABLE.has(x.symbol.slice(0, -4))).map(x => x.symbol);
  const d0 = Math.floor(from / 864e5) * 864e5 - 864e5, today = Math.floor(Date.now() / 864e5) * 864e5;
  let d1 = Math.min(Math.ceil(endT / 864e5) * 864e5, today);
  // the stored daily candles may be a night behind: a day or two at the very end doesn't change who the pool is
  const last = (await HS.index())?.d?.last;
  if (last != null && d1 > last + 864e5 && d1 - last - 864e5 <= 2 * 864e5) d1 = last + 864e5;
  const qv = {}, D = await HS.daily(syms, d0, d1);
  let miss = syms, n = 0;
  if (D) { Object.assign(qv, D.rows); miss = D.miss; }
  await pool(miss, 6, async s => { try { const K = await binanceHistory(s, '1d', d0, d1); if (K.length) qv[s] = K; } catch {} say(`Собираю топ периода: ${++n}/${miss.length} пар…`); });
  const K = periodK(top), first = new Map();
  const list = HS.topEver(Object.fromEntries(Object.entries(qv).map(([s, R]) => [s, new Map(R.map(k => [k[0], k[6]]))])), d0, d1, K, [], first);
  if (endT > today) for (const s of M.pickSymbols(tk, K, [], Date.now())) if (!first.has(s)) { list.push(s); first.set(s, today); }
  return {list, first, last:Object.fromEntries(list.map(s => [s, qv[s] ? qv[s][qv[s].length - 1][0] : today]))};
}
const coinsGen = n => plural(n, ['монеты', 'монет', 'монет']);   // «история 1 монеты», «из 21 монеты», «5 монет»
const coinsLabel = r =>r.pool && r.pool > r.pairs ? `топ-${r.pairs} на каждый момент (из ${r.pool} ${coinsGen(r.pool)})` : `${r.pairs} ${plural(r.pairs, ['монета', 'монеты', 'монет'])}`;
function btSettings() {
  const custom = $('#btTop').value === 'custom' ? parseCoins($('#btCustom').value) : null;
  return {method:$('#btMethod').value, N:clamp(+$('#btN').value || 210, 20, 300), k:clamp(+$('#btK').value || 3, 1, 5), tf:$('#btTf').value,
          minScore:clamp(+$('#btMin').value || 0, 0, 100), maxHL:+$('#btHL').value || 0, minWidth:+$('#btW').value || 0,
          top:custom ? custom.length : +$('#btTop').value, custom, pit:!custom && $('#btPit').value === 'pit',
          strategy:$('#btStrat').value, longOnly:$('#btLong').checked,
          rr:+$('#btRR').value || 0, risk:(+$('#btRisk').value || 2) / 100, lev:+$('#btLev').value || 1,
          erMax:+$('#btER').value || 0.15, regimeOnly:$('#btReg').value, regimeSrc:$('#btSrc').value, coinErMax:+$('#btCoinER').value || 0, timeStop:+$('#btTS').value, maxOpen:+$('#btSlots').value || 3,
          // a study idea's own settings (M.studyOf: only those of the chosen idea, so the others don't mark a result stale)
          ...M.studyOf({strategy:$('#btStrat').value, fibK:$('#btFibK').value, fibZone:$('#btFibZone').value, fibStop:$('#btFibStop').value, fibTarget:$('#btFibTarget').value,
            obEntry:$('#btObEntry').value, obSwing:$('#btObSwing').value, fvgMin:$('#btFvgMin').value, fvgLife:$('#btFvgLife').value}),
          // the starting balance, and the stake of the risk: the balance (compounding, as the bots trade) or the start (fixedRisk)
          start:clamp(Math.round(+$('#btStart').value) || 10000, 100, 1e7), ...($('#btComp').checked ? {} : {fixedRisk:true})};
}
function btFill(s) {
  $('#btMethod').value = s.method; $('#btN').value = s.N; $('#btK').value = s.k; $('#btTf').value = TFMS[s.tf] && !['5m', '1d', '1w'].includes(s.tf) ? s.tf : '15m'; $('#btMin').value = s.minScore; $('#btHL').value = String(s.maxHL || 0); hlOpts('#btHL', $('#btTf').value);
  $('#btStrat').value = s.strategy || 'revert'; $('#btLong').checked = !!s.longOnly; $('#btW').value = String(s.minWidth || 0);
  // the take comes from the rules: a mark «2 was put in automatically» left by a study idea would turn it back to «к центру»
  $('#btRR').value = String(s.rr || 0); delete $('#btRR').dataset.auto; $('#btRisk').value = String(Math.round((s.risk ?? M.RISK) * 1000) / 10); $('#btLev').value = String(s.lev ?? 1);
  $('#btER').value = String(s.erMax ?? 0.15); $('#btReg').value = s.regimeOnly || (s.flatOnly ? 'flat' : 'any');
  $('#btSrc').value = s.regimeSrc || 'majors';   // the bot always reads the regime from BTC+ETH+SOL
  $('#btTS').value = String(s.timeStop ?? 48); $('#btSlots').value = String(M.slotsOf(s)); $('#btCoinER').value = String(s.coinErMax || 0);
  $('#btComp').checked = !s.fixedRisk;   // the starting balance stays as the user set it
  btEstimate();
}
// the period: the last N days up to the current hour, or one's own dates (UTC, both days included) — a past year, say.
// key: what the result on screen was run for (dates as typed: a period ending today keeps its key through the hours)
const fmtDay = t => new Date(t).toLocaleDateString('ru', {timeZone:'UTC', day:'2-digit', month:'2-digit', year:'numeric'});
function btPeriod(now = Date.now()) {
  const hour = Math.floor(now / 36e5) * 36e5;   // whole hours → reruns hit the cache
  if ($('#btDays').value !== 'custom') { const days = +$('#btDays').value; return {from:hour - days * 864e5, endT:hour, days, key:String(days), label:`${days} дней`}; }
  const a = Date.parse($('#btFrom').value + 'T00:00:00Z'), b = Date.parse($('#btTo').value + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return {err:'Выберите первый и последний день периода.'};
  if (a < Date.UTC(2020, 0, 1)) return {err:'Период может начинаться не раньше 1 января 2020 года.'};
  const endT = Math.min(b + 864e5, hour);
  if (b < a) return {err:'Последний день периода не может быть раньше первого.'};
  // today – today (or a first day still ahead) passed the old check's wording and was refused by it all the same
  if (endT - a < 864e5) return {err:'В периоде меньше суток истории: первый день должен быть не позже вчерашнего.'};
  return {from:a, endT, days:(endT - a) / 864e5, key:$('#btFrom').value + '|' + $('#btTo').value, label:`${fmtDay(a)} – ${fmtDay(endT - 1)}`, custom:true};
}
// a result left on screen after the form changed belongs to the old settings: it fades and says so,
// otherwise a screenshot shows one set of settings next to the numbers of another
function btStale() {
  const stale = !!btRes && (JSON.stringify(btSettings()) !== JSON.stringify(btRes.settings) || btPeriod().key !== btRes.period);
  $('#btOut').classList.toggle('stale', stale);
  return stale;
}
// one line under «Идея входа»: what the chosen idea does (as wants / modeOf in math.js)
const BT_HINT = {revert:'Цена коснулась границы канала и развернулась — входим в сторону центра канала.',
  revert_trend:'Тот же отскок от границы, но только по направлению наклона канала.',
  breakout:'Свеча закрылась за границей канала на повышенном объёме — входим в ту же сторону.',
  switch:'Рынок в боковике — отскок от границы; рынок растёт — пробой, только LONG; рынок падает — без сделок.',
  // study ideas (M.STUDY): the research checked the defaults only (docs/RESEARCH-2026-10.md, docs/RESEARCH-SMC.md); FVG — never
  fib:'Учебная стратегия. После импульса цена откатывается назад на долю его длины; вход в зоне отката, стоп — на более глубоком уровне, цель — вершина. С настройками по умолчанию на нескольких годах нашей истории она убыточна и не лучше отката к случайному уровню — запустите, чтобы увидеть, как выглядит идея без преимущества. Бот по учебным стратегиям не торгует.',
  smc_ob:'Учебная стратегия. Ордер-блок — последняя свеча перед сломом структуры; он существует только с момента слома. «Отскок у границы канала» с настройками по умолчанию на нескольких годах нашей истории хуже обычного отскока; «возврат цены в блок» не исследовался. Бот по учебным стратегиям не торгует.',
  smc_fvg:'Учебная стратегия. Разрыв (FVG) — цены, через которые рынок проскочил: между максимумом свечи и минимумом свечи через одну. Вход при возврате цены в разрыв, стоп за его дальним краем. Эту идею мы не исследовали — смотрите на сравнение со случайным входом. Бот по учебным стратегиям не торгует.'};
// the idea of a run's settings in words, with a study idea's own settings
const btOwn = s => s.strategy === 'fib' || s.strategy === 'smc_fvg' || (s.strategy === 'smc_ob' && s.obEntry === 'zone');
const btIdea = s => s.strategy === 'fib' ? `${M.STUDY.fib} (импульс ${s.fibK} × ATR, зона ${s.fibZone}–${M.FIB_ZONES[s.fibZone][1]}, стоп ${s.fibStop}, цель — ${s.fibTarget ? 'расширение ' + s.fibTarget : 'вершина'})`
  : s.strategy === 'smc_ob' ? `${M.STUDY.smc_ob} (${s.obEntry === 'zone' ? 'возврат в блок' : 'отскок у границы канала'}, свинг ${s.obSwing})`
  : s.strategy === 'smc_fvg' ? `${M.STUDY.smc_fvg} (разрыв ≥ ${s.fvgMin} × ATR, ждать ${s.fvgLife} свечей)` : M.STRATEGIES[s.strategy];
// which fields the chosen idea uses: own — a study idea with entries and levels of its own (no channel signal, no strength)
function btMode() {
  const st = $('#btStrat').value, study = !!M.STUDY[st];
  return {st, study, own:st === 'fib' || st === 'smc_fvg' || (st === 'smc_ob' && $('#btObEntry').value === 'zone')};
}
function btModeShow() {
  const {st, study, own} = btMode(), hide = (sel, h) => document.querySelectorAll(sel).forEach(e => e.classList.toggle('hidden', h));
  hide('#backtest .btch', own); hide('#backtest .btsig', own);
  hide('#backtest .btfib', st !== 'fib'); hide('#backtest .btob', st !== 'smc_ob'); hide('#backtest .btfvg', st !== 'smc_fvg');
  hide('#btRRL', st === 'fib'); hide('#backtest .btrrfib', st !== 'fib');
  // a stop beyond a block or a gap has no channel centre to aim at: the take is a multiple of the stop (2 when «к центру» was set)
  // and back to «к центру» when the idea changes back, unless the user picked another take meanwhile
  const o0 = $('#btRR').options[0], rr = $('#btRR'); o0.disabled = own;
  if (own && rr.value === '0') { rr.value = '2'; rr.dataset.auto = '1'; }
  else if (!own && rr.dataset.auto) { if (rr.value === '2') rr.value = '0'; delete rr.dataset.auto; }
  else if (own && rr.value !== '2') delete rr.dataset.auto;
  $('#btSave').disabled = study; $('#btSave').title = study ? 'Учебные стратегии бот не торгует — их нельзя сохранить как профиль' : 'Сохранить текущие настройки бэктеста как профиль «Моего бота»';
  $('#btStratHint').textContent = BT_HINT[st] || '';
}
function btEstimate() {
  btModeShow();
  // the fields that depend on a select and the fading follow the form during a run too: «Свои даты…» picked while the history
  // loaded used to leave the dates hidden, and a result that came for the settings before the change looked fresh
  $('#btCustomL').classList.toggle('hidden', $('#btTop').value !== 'custom'); $('#btPitL').classList.toggle('hidden', $('#btTop').value === 'custom');
  for (const id of ['#btFromL', '#btToL']) $(id).classList.toggle('hidden', $('#btDays').value !== 'custom');
  const stale = btStale();
  if (btBusy) return;   // the status line is the run's
  const s = btSettings(), per = btPeriod(), days = per.days || 0, bars = days * 864e5 / TFMS[s.tf] + 450;
  if (stale) { $('#btStatus').innerHTML = '<b style="color:var(--acc-t)">Настройки изменены — результат ниже ещё для прежних.</b> Нажмите «Запустить», чтобы пересчитать.'; return; }
  if (btRes) { $('#btStatus').textContent = btRes.status || ''; return; }   // back to the settings of the result on screen
  if (s.custom && !s.custom.length) { $('#btStatus').textContent = 'Впишите монеты через запятую, например: BTC, ETH, SOL.'; return; }
  if (per.err) { $('#btStatus').textContent = per.err; return; }
  // with stored history (history.js) a coin is one file a month from R2 (r2.dev gives ~35 files a second) and one request for
  // the newest candles; without it ~1000 candles a request at the throttle's pace. Measured 09.11: 1h, a year, 209 coins —
  // 83 s with stored history, 185 s without. The index is asked once; the estimate redraws when it comes. The honest pool is
  // every coin of the period's daily top-K (periodPool); measured on a year: top-20 (K 40) 383–404 coins, top-50 (K 75)
  // 447–468, top-100 (K 150) 513; two weeks of top-50 — 129
  // asked again while there is none (history.js keeps a failed answer for a minute, so this costs no request meanwhile): until
  // 2.113 one failed request left the estimate «from Binance» until the page was reloaded
  if (!histIdx && !idxAsk) { idxAsk = true; HS.index().then(i => { idxAsk = false; if (i && !histIdx) { histIdx = i; btEstimate(); } }, () => { idxAsk = false; }); }
  const K = periodK(s.top), coins = !s.pit ? s.top : Math.round(Math.min(K * 9, K + 400) * Math.min(1, 0.3 + 0.7 * days / 365));
  const stored = !!histIdx?.s?.BTCUSDT?.[s.tf] && per.from - 450 * TFMS[s.tf] >= HS.monthStart(histIdx.from);
  const sec = Math.max(5, Math.round((stored ? coins * ((days / 30 + 1) * 0.03 + 0.03) : Math.ceil(bars / 1000) * coins * 0.09) / 5) * 5);
  $('#btStatus').textContent = `Первый запуск займёт около ${sec < 60 ? sec + ' секунд' : Math.round(sec / 60) + ' мин'} — загружаем историю ${coins} ${coinsGen(coins)}. Повторные — мгновенно.`
    + (sec > 180 ? ` Это долго: быстрее будет ${s.tf === '15m' ? 'на 1h или ' : ''}с меньшим числом монет или коротким периодом.` : '')
    // the run stops past ~3M candles (runBacktest, by the real pool); the pool here is a guess, and a coin rarely spans the whole
    // period (0.89 of coins × bars on 60 days of 4h, less on a year), so only a clear excess is told, before the downloads start
    + (coins * bars * 0.6 > 3e6 ? ' Скорее всего, такой прогон не поместится в память вкладки: возьмите период короче, таймфрейм крупнее или меньше монет.' : '');
}
// while the history loads, «Запустить» is «Прервать»: a year on a wide pool takes minutes. Each run has its own stop flag,
// so the downloads of a stopped run end with their current request even if a new run has started; what was fully loaded stays
// in histCache, and the next run goes on from there. The calculation itself (seconds) is not interrupted
const STOPPED = new Error('остановлено');
let btCtl = null;
const btButton = busy => { $('#btRun').classList.toggle('primary', !busy); $('#btRun').innerHTML = `<svg class="i"><use href="#i-${busy ? 'x' : 'play'}"/></svg>${busy ? 'Прервать' : 'Запустить'}`; };
// what went wrong, in the user's words: the browser's own «Failed to fetch» says nothing
const btErr = e => /Failed to fetch|NetworkError|Load failed/i.test(e?.message) || ['TimeoutError', 'AbortError'].includes(e?.name) ? 'нет связи с Binance. Проверьте интернет и нажмите «Запустить» ещё раз — загруженная история сохранилась.'
  : /^HTTP (429|418)/.test(e?.message) ? 'Binance просит подождать — слишком много запросов. Нажмите «Запустить» через минуту: загруженная история сохранилась.'
  : e?.message || String(e);
async function runBacktest() {
  // the second click of a double click on «Запустить» lands on «Прервать»: within half a second of the start it is not a stop
  if (btBusy) { if (btCtl && performance.now() - btCtl.t > 500) { btCtl.stop = true; $('#btRun').disabled = true; $('#btStatus').textContent = 'Останавливаю…'; } return; }
  const ctl = btCtl = {stop:false, t:performance.now()}, stop = () => { if (ctl.stop) throw STOPPED; };
  btBusy = true; btButton(true); $('#btStatus').classList.add('busy');   // a turning mark while it loads and counts
  const s = btSettings(), per = btPeriod(), days = per.days, tfms = TFMS[s.tf];
  const st = $('#btStatus'); let ok = false;
  try {
    st.textContent = 'Беру список пар…';
    if (per.err) throw new Error(per.err);
    const now = Date.now(), {from, endT} = per, startT = from - 450 * tfms;   // 450 bars of warm-up covers N ≤ 300
    if (s.custom && !s.custom.length) throw new Error('список монет пуст');
    // honest top: a wider pool is loaded and the backtest trades, at each moment, only that moment's top by 24 h turnover
    const tk = s.custom ? null : await api('/api/v3/ticker/24hr');
    let traded, gone = [], first = null, lastDay = null;
    if (s.pit) {   // the coins that made the period's daily top (periodPool), delisted ones among them
      ({list:traded, first, last:lastDay} = await periodPool(tk, from, endT, s.top, t => { stop(); st.textContent = t; }));
      const quiet = new Set(tk.filter(x => !(x.closeTime > now - 864e5)).map(x => x.symbol));
      gone = traded.filter(x => quiet.has(x));
    } else {
      // today's top for the whole period, fixed for the day: picked by live 24 h turnover it changed from run to run at its edge,
      // and so did the result with the same settings (Oct 2026: 106k, then 142k a minute later)
      const day = Math.floor(now / 864e5), pk = load('sr_pool', null);
      const live = s.custom ? null : pk?.day === day && pk.n === s.top && Array.isArray(pk.list) ? pk.list : M.pickSymbols(tk, s.top, [], now);
      if (live && !(pk?.day === day && pk.n === s.top)) save('sr_pool', {day, n:s.top, list:live});
      traded = s.custom || live;
    }
    const syms = [...new Set([...traded, ...M.MAJORS])];   // BTC/ETH/SOL are always loaded: they define the market regime
    // each coin from 450 bars before the day it first made the period's top (periodPool), the majors from the start. Checked on
    // 2025, 4h, top-20: the trades are the same as with every coin from the start for the log, classic and robust channels (837
    // of 837); EWMA weighs all history, so it moved 10 of 262 — an EWMA channel loads every coin from the start, as before
    const trim = s.method !== 'ewma';
    const startOf = x => trim && first?.has(x) && !M.MAJORS.includes(x) ? Math.max(startT, first.get(x) - 864e5 - 450 * tfms) : startT;
    // a run is held in memory whole: 15m × a year × a wide pool is ~14M candles, more than a phone (and many laptops) can hold,
    // and the tab used to crash with nothing said. ~3M candles (~600 MB with the computed series) is where it stops. The pool
    // knows each coin's own span (from startOf to its last day with candles), so the count is close to the real one
    const bars = syms.reduce((a, x) => a + Math.max(0, Math.ceil((Math.min(endT, lastDay?.[x] != null ? lastDay[x] + 864e5 : endT) - startOf(x)) / tfms)), 0);
    if (bars > 3e6) throw new Error(`слишком большой прогон: ${syms.length} монет, около ${(bars / 1e6).toFixed(1)} млн свечей — вкладке не хватит памяти. Возьмите период короче, таймфрейм крупнее или меньше монет`);
    trimHistory(key => { const [x, tf, a, b] = key.split('|'); return tf === s.tf && +b === endT && syms.includes(x) && +a === startOf(x); });
    // 8 coins at a time: with stored history a coin is a few files from R2 and one request to Binance (≤ ~800 weight a run
    // in all); full downloads from Binance keep their pace through throttled()
    const hist = {}; let done = 0;
    await pool(syms, 8, async sym => {
      stop();
      try { hist[sym] = (await fetchHistory(sym, s.tf, startOf(sym), endT, stop)).filter(k => k[6] < now); } catch {}
      if (!ctl.stop) st.textContent = `Загружаю историю: ${++done}/${syms.length} пар…`;
    });
    stop();
    // a coin whose download failed (a phone on a weak network, Binance asking to slow down) used to drop out silently and
    // change the result; it gets two more tries, and whatever still fails is named next to the result
    let failed = syms.filter(x => !hist[x]);
    for (let round = 1; round <= 2 && failed.length; round++) {
      st.textContent = `Догружаю ${failed.length} ${plural(failed.length, ['пару', 'пары', 'пар'])} (попытка ${round + 1})…`; await sleep(1500 * round);
      for (const sym of failed) { stop(); try { hist[sym] = (await fetchHistory(sym, s.tf, startOf(sym), endT, stop)).filter(k => k[6] < now); } catch {} }
      stop();
      failed = failed.filter(x => !hist[x]);
    }
    // nothing to trade on is not a result: with the network gone the run used to end as «Готово: 0 монет, Invalid Date →
    // Invalid Date» with an untouched balance in place of the previous result
    if (!traded.some(x => hist[x]?.length)) throw new Error(failed.length ? 'история не загрузилась ни по одной монете. Проверьте интернет' + (s.custom ? ' и названия монет' : '') + ' и нажмите «Запустить» ещё раз.' : 'у выбранных монет нет свечей за этот период.');
    st.textContent = 'Считаю…'; $('#btRun').disabled = true; await sleep(30);   // the calculation can't be stopped: no «Прервать» during it
    const t0 = performance.now();
    btHist = {hist, from, endT, only:traded, top:s.pit ? s.top : 0, S:s};   // window.__sr.btHist: to check a run by hand (tests/backtest-audit.js)
    btRes = M.backtest(hist, s, {start:s.start, from, only:traded, top:s.pit ? s.top : 0});
    btRes.settings = s; btRes.days = days; btRes.period = per.key; btRes.periodLabel = per.label; btRes.H = btHist;   // H: the candles, for btRandom
    btRes.tries = btTry(s, per.key);
    const miss = s.pit ? [] : traded.filter(x => !hist[x]?.length && !failed.includes(x));   // a coin of the wider pool without history simply never makes the top
    const goneN = gone.filter(x => hist[x]?.length).length;
    st.textContent = `Готово: ${coinsLabel(btRes)}${goneN ? `, из них ${goneN} уже сняты с Binance` : ''}, ${per.custom ? per.label + ' (UTC)' : `${dt(btRes.from)} → ${dt(btRes.to + tfms)}`}, расчёт ${Math.round(performance.now() - t0)} мс.`
      + ` ${btIdea(s)}${s.longOnly ? ', только LONG' : ''} · ${s.strategy === 'fib' ? '' : `RR ${s.rr ? '1:' + s.rr : 'к центру'} · `}старт $${money(s.start)} · риск ${(s.risk * 100).toFixed(1)}%${s.fixedRisk ? ` от старта ($${money(s.start * s.risk)} со сделки)` : ' от баланса (сложный процент)'} · плечо до ${s.lev}× · `
      + (btOwn(s) ? s.tf : `${METHOD_NAME[s.method]} (${s.N}, ${s.k}), ${s.tf}, сила ≥ ${s.minScore}${s.maxHL ? `, T½ ≤ ${s.maxHL}` : ''}${s.minWidth ? `, ширина ≥ ${s.minWidth}%` : ''}`) + `, ${s.timeStop ? 'тайм-стоп ' + s.timeStop : 'без тайм-стопа'}.`;
    // what makes the result incomplete goes to «Можно ли верить» (btWarnShow), the status line keeps the run's summary
    btRes.warn = [
      ...(M.isStudy(s) ? [['info', 'Учебная стратегия: бот по ней не торгует. Она здесь, чтобы проверить популярную идею на истории.']] : []),
      ...(failed.length ? [['warn', `Не загрузилась история ${failed.length} ${coinsGen(failed.length)} (${failed.slice(0, 8).map(base).join(', ')}${failed.length > 8 ? '…' : ''}): итог неполный и может отличаться от следующего запуска — нажмите «Запустить» ещё раз, скачанное заново не качается.`]] : []),
      ...(miss.length ? [['info', `Не найдены на Binance: ${miss.map(base).join(', ')}.`]] : []),
      ...(HS.isOff() ? [['info', 'История загружена только с Binance (?history=off).']] : [])];
    btRes.status = st.textContent; btAll = false; renderBacktest(); ok = true; btRandom();
    if (isPhone()) $('#btOut').scrollIntoView({block:'start'});   // on a phone the result is below the form — go there
  } catch (e) {
    st.textContent = e === STOPPED ? 'Остановлено. Загруженная история сохранилась — следующий запуск продолжит с неё.' : 'Ошибка: ' + btErr(e);
  }
  btBusy = false; btCtl = null; btButton(false); $('#btRun').disabled = false; $('#btStatus').classList.remove('busy');
  // the form may have changed while the run was on: then the result is for the settings before the change, and says so;
  // after a stop or an error the line keeps its message, only the fading follows the form
  if (ok) btEstimate(); else btStale();
  setTimeout(btCacheShow, 1500);   // the files of this run are still being written to the cache
}
function groupRow(name, list) {
  const g = M.journalStats(10000, list);
  // data-l: the column's name, shown over the number when the table is a card (phone)
  return `<tr><td>${name}</td><td data-l="Сделок">${g.n}</td><td data-l="Winrate">${g.wr == null ? '—' : g.wr.toFixed(0) + '%'}</td><td data-l="Средний R" class="${cl(g.expR)}">${rr(g.expR)}</td><td data-l="PF">${g.pf == null ? '—' : g.pf.toFixed(2)}</td><td data-l="PnL" class="${cl(g.net)}">${usd(g.net)}</td></tr>`;
}
const groupHead = '<thead><tr><th>Группа</th><th>Сделок</th><th>Winrate</th><th title="Средний результат на сделку в R после комиссий">Ср. результат</th><th>PF</th><th>PnL</th></tr></thead>';
// the held-out part (#btHold): the last share of the period by entry time, shown apart from the part the settings were picked on.
// It took the place of the two halves the verdict compared before. Only the view: the same trades, no new run
function btParts(r) {
  const hold = +$('#btHold').value || 0.3, end = r.to + TFMS[r.settings.tf], cut = end - hold * (end - r.from);
  const fit = r.trades.filter(x => x.time < cut), out = r.trades.filter(x => x.time >= cut);
  const pc = Math.round(hold * 100), name = hold === 0.5 ? ['1-я половина', '2-я половина'] : [`первые ${100 - pc}%`, `последние ${pc}%`];
  return {fit, out, sf:M.journalStats(r.start, fit), so:M.journalStats(r.start, out), name};
}
// the verdict: the result as a whole, the held-out part (btParts) and the comparison with random entries (btRandom, r.rand).
// Green only when all three agree; redrawn on its own when the comparison moves on
// the correction for trying many settings (M.dsr, Bailey & López de Prado 2014): the more different settings one tries, the better
// the best of them looks by luck alone. btTry counts the different settings (with the period) run in this browser, the current
// one included; btDsr is the probability that the result beats the best luck would give after that many — needs ≥ RAND_BAR
const DSR_KEEP = 500;
function btTry(s, period) {
  const key = JSON.stringify({...s, start:undefined, period});
  let h = 0; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  const list = (load('sr_bttries', []) || []).filter(x => typeof x === 'number');
  if (!list.includes(h)) { list.push(h); save('sr_bttries', list.slice(-DSR_KEEP)); }
  return Math.max(1, Math.min(list.length, DSR_KEEP));
}
function btDsr(r) {
  const s = M.sharpeOf(r.trades.map(t => t.r)), N = r.tries || 1;
  if (!s || s.n < 30 || !(s.sr > 0)) return null;
  const d = M.dsr(s, N);
  return d && d.p != null ? {sr:s.sr, n:s.n, N, p0:M.psr(s), p:d.p, sr0:d.sr0} : null;
}
function btDsrLine(r) {
  const d = btDsr(r);
  if (!d) return '';
  const pc = x => Math.round(x * 100) + '%';
  return `<div class="btrand">С поправкой на перебор: результат не случаен с вероятностью <b>${pc(d.p)}</b>${d.p * 100 < RAND_BAR ? ' — <b>мало, нужно от 95%</b>' : ''}.`
    + ` <span class="mute">Шарп на сделку ${d.sr.toFixed(2)} (${d.n} ${plural(d.n, ['сделка', 'сделки', 'сделок'])}); без поправки — ${pc(d.p0)}.`
    + ` Здесь проверено ${d.N} ${plural(d.N, ['вариант', 'варианта', 'вариантов'])} настроек: лучший из стольких получил бы Шарп ${d.sr0.toFixed(2)} и без преимущества, просто случайно.</span></div>`;
}
function btVerdictShow() {
  const r = btRes, st = M.journalStats(r.start, r.trades), s = r.settings, {sf, so, name} = btParts(r);
  const dsr = btDsr(r), picked = dsr && dsr.p * 100 < RAND_BAR;   // in the plus, but the best of many tries would look as good
  const rk = r.rand?.rank, luck = rk && rk.pct < RAND_BAR, beat = rk && rk.pct >= RAND_BAR;
  const parts = `на подборе (${name[0]} периода) ${rr(sf.expR)}, на проверке (${name[1]}) ${rr(so.expR)}`;
  // held out much worse than picked: in the minus, or under half of the picked part's result
  const overfit = sf.expR > 0 && so.n > 0 && (so.expR <= 0 || so.expR < sf.expR / 2);
  let v, vk;
  if (st.n < 30) { v = `Сделок всего <b>${st.n}</b> — слишком мало для выводов. Увеличьте период или число пар, или снизьте мин. силу.`; vk = 'info'; }
  else if (!(st.expR > 0)) { v = `<b class="neg">На этих настройках стратегия убыточна:</b> ${rr(st.expR)} на сделку после комиссий.${st.gross > 0 ? ` До комиссий она была в плюсе (${usd(st.gross)}), но комиссии (${usd(-st.fees)}) съели всё — нужны более крупные ходы на сделку.` : ''}`; vk = 'bad'; }
  else if (overfit) { v = `<b style="color:var(--acc)">Похоже на подгонку под историю:</b> в целом ${rr(st.expR)} на сделку, но ${parts}. На проверке настройки работают намного хуже, чем там, где их подбирали.${so.n < 30 ? ` На отложенной части всего ${so.n} ${plural(so.n, ['сделка', 'сделки', 'сделок'])} — выводы предварительные.` : ''}`; vk = 'warn'; }
  else if (!(sf.expR > 0 && so.expR > 0)) { v = `<b style="color:var(--acc)">В плюсе, но нестабильно:</b> в целом ${rr(st.expR)} на сделку, а ${parts}. Похоже на удачный отрезок, а не на устойчивое преимущество.`; vk = 'warn'; }
  else if (luck) { v = `<b style="color:var(--acc)">В плюсе, но не отличить от случая:</b> ${rr(st.expR)} на сделку, ${parts}. Случайные входы с теми же выходами дают такой же результат слишком часто.`; vk = 'warn'; }
  else if (beat && picked) { v = `<b style="color:var(--acc)">Лучше случайного входа, но может быть удачным подбором:</b> ${rr(st.expR)} на сделку, ${parts}. Здесь проверено ${dsr.N} ${plural(dsr.N, ['вариант', 'варианта', 'вариантов'])} настроек, а среди стольких такой результат находится и случайно.`; vk = 'warn'; }
  else if (beat) { v = `<b class="pos">У настроек есть преимущество:</b> ${rr(st.expR)} на сделку после комиссий, ${parts}, и это лучше случайного входа. Хороший знак, но проверьте и на другом периоде.`; vk = 'ok'; }
  else { v = `<b style="color:var(--acc)">В плюсе:</b> ${rr(st.expR)} на сделку, ${parts}. Отличается ли это от случая, покажет сравнение ниже.`; vk = 'warn'; }
  // "today's top" over the whole past knows which coins later grew: its verdict is never green, and the honest run is one click
  // away (Oct 2026: a profile showed +0.67R here and +0.11R honestly, and was taken for a sure thing)
  if (!s.pit && !s.custom) {
    v = `<b style="color:var(--acc)">Итог завышен: монеты взяты по сегодняшнему топу.</b> По всему периоду гоняются монеты, которые в топе сегодня, — они уже выросли и не исчезли с биржи. Монеты, которые тогда были в топе, а потом рухнули или были сняты, сюда не попали, а живой бот торговал бы и ими. Без поправки: ${rr(st.expR)} на сделку.`
      + `<div style="margin-top:8px"><button class="primary" data-honest>Проверить честно — топ на каждый момент</button></div>`;
    if (vk === 'ok' || vk === 'info') vk = 'warn';
  }
  // a hand-made list can carry the same hindsight: picked now, it keeps the coins that are big today or that the strategy won on
  // (Oct 2026: a list "of coins that were always in the top" made $228k a year with green here; the honest top-20 with the same
  // rules made $10.8k). A plus is never green; the comparison with the honest top of about the same size is one click away
  else if (s.custom && st.expR > 0) {
    const tops = [...$('#btTop').options].map(o => +o.value).filter(Boolean), n = tops.reduce((a, b) => Math.abs(b - s.custom.length) < Math.abs(a - s.custom.length) ? b : a);
    v = `<b style="color:var(--acc)">Итог может быть завышен: монеты выбраны вручную.</b> Бэктест не знает, почему в списке именно они. Если их выбрали сейчас — потому что они в топе или на них стратегия выигрывала, — в список не попали монеты, которые тогда были в топе, а потом упали, а живой бот год назад так выбрать не мог. Без поправки: ${rr(st.expR)} на сделку${st.n < 30 ? `, и сделок всего ${st.n} — для выводов мало` : ''}.`
      + `<div style="margin-top:8px"><button class="primary" data-honest="${n}">Сравнить с честным топ-${n} на каждый момент</button></div>`;
    if (vk === 'ok' || vk === 'info') vk = 'warn';
  }
  $('#btVerdict').className = 'banner ' + vk;
  $('#btVerdict').innerHTML = `<svg class="i"><use href="#i-${vk === 'info' ? 'info' : vk}"/></svg><div>${v}${btRandLine(r)}${btDsrLine(r)}</div>`;
}
// random entries (M.randomSetup in math.js): the same coins, period, number of trades and exits as the result on screen, the
// moments, coins and sides at random, RAND_RUNS runs with a fixed seed — the same result gives the same line. Counted in slices
// of ~40 ms between timers, so the page keeps answering; «Прервать» stops it, «Сравнить» starts it again. The state lives on
// the result (r.rand): a redraw (the theme, #btHold) keeps it, a new result stops the old job
const RAND_BAR = 95, RAND_RUNS = M.RANDOM_RUNS;   // %: below it a result is not told apart from luck; runs (300)
let btRnd = null;   // the job counting now: {r, stop}
function btRandLine(r) {
  const x = r.rand;
  if (!x) return '';
  const pre = '<div class="btrand">';
  if (x.rank) return pre + `Лучше <b>${Math.floor(x.rank.pct)}%</b> случайных прогонов (средний R случайных — ${rr(x.rank.mean)}).`
    + (x.rank.pct < RAND_BAR ? ' <b>Результат не отличить от случая.</b>' : ' Случайно так получается редко.')
    + ` <span class="mute">Те же монеты, период, число сделок и выходы, но моменты и стороны входа случайные; ${x.rank.runs} прогонов.</span></div>`;
  if (x.stopped) return pre + `Сравнение со случайным входом прервано. <button data-rgo>Сравнить</button></div>`;
  return pre + `Сравниваю со случайным входом: <span id="btRandN">${x.done}</span> из ${x.runs}… <button data-rstop>Прервать</button></div>`;
}
function btRandom(r = btRes) {
  if (btRnd) btRnd.stop = true;
  const H = r?.H;
  if (!H) return;
  let X = null;
  try { X = M.randomSetup(H.hist, r.settings, r.trades, {from:H.from, only:H.only, top:H.top, start:r.start, seed:1}); } catch (e) { console.warn('randomSetup', e); }
  if (!X) { r.rand = null; if (r === btRes) btVerdictShow(); return; }
  const job = btRnd = {r, stop:false, t:performance.now()}, runs = RAND_RUNS, means = [];
  r.rand = {done:0, runs};
  if (r === btRes) btVerdictShow();
  const slice = () => {
    if (job.stop) { if (!r.rand?.rank) { r.rand = {...r.rand, stopped:true}; if (r === btRes) btVerdictShow(); } if (btRnd === job) btRnd = null; return; }
    const t0 = performance.now();
    // a hidden tab gets a timer about once a second: longer slices there, nobody is waiting for the page to answer
    while (means.length < runs && performance.now() - t0 < (document.hidden ? 400 : 40)) means.push(X.run(means.length).mean);
    r.rand.done = means.length;
    if (means.length < runs) { const n = $('#btRandN'); if (n && r === btRes) n.textContent = means.length; setTimeout(slice, 0); return; }
    r.rand = {done:runs, runs, rank:M.randomRank(X.ref, means)}; btRnd = null;
    if (r === btRes) btVerdictShow();
  };
  setTimeout(slice, 0);
}
function renderBacktest() {
  const r = btRes, tr = r.trades, st = M.journalStats(r.start, tr), s = r.settings;
  // a redraw (the theme switch calls it too) keeps the fading of a result whose settings are no longer in the form
  $('#btOut').classList.remove('hidden'); btStale(); $('#btEmpty').classList.add('hidden');
  btVerdictShow();
  const {fit, out, name} = btParts(r);
  const card = (t, val, sub, c = '', tip = '') => `<div class="card"${tip ? ` title="${tip}"` : ''}><div class="t">${t}</div><div class="v ${c}">${val}</div><div class="s">${sub}</div></div>`;
  const D = {start:r.start, balance:r.balance, closed:tr}, chg = r.balance / r.start - 1;
  $('#btCards').innerHTML =
    `<div class="hero">
       <div class="htop">
         <div><div class="t">Итоговый баланс · ${r.periodLabel || r.days + ' дней'} · ${coinsLabel(r)}</div>
           <div class="hv">${curH('$' + money(r.balance))}</div>
           <div class="hchg"><span class="chip ${st.net > 0 ? 'pos' : st.net < 0 ? 'neg' : 'flat'} ${cl(st.net)}">${usd(st.net)} · ${chg >= 0 ? '+' : '−'}${Math.abs(chg * 100).toFixed(2)}%</span><span class="faint">после комиссий</span></div></div>
         <div class="hside">
           <div title="Средний итог сделки в рисках (R) после комиссий: +1R — заработали столько, сколько рисковали. Больше 0 — у правил есть преимущество"><span class="tl">Средний результат</span><b class="${cl(st.expR)}">${rr(st.expR)}</b></div>
           <div title="Самое большое падение баланса от предыдущего пика, а не от старта. На графике ниже оно подсвечено"><span class="tl">Макс. просадка</span><b>${st.maxDD.toFixed(1)}%</b></div>
           <div>Сделок<b>${st.n}</b></div>
         </div>
       </div>
       ${equityChart(D, r.to + TFMS[s.tf], 'bt')}
     </div>
     ${st.n ? `<div class="statrow">
       ${card('Winrate', st.wr == null ? '—' : st.wr.toFixed(0) + '%', `${st.win} в плюс · ${st.loss} в минус`, '', 'Доля прибыльных сделок. Сама по себе мало что говорит: при тейке вдвое дальше стопа хватает и 35%')}
       ${card('Profit factor', st.pf == null ? '—' : st.pf.toFixed(2), `ср. +${usd(st.avgWin, false)} / ${usd(st.avgLoss)}`, st.pf == null ? '' : st.pf >= 1 ? 'pos' : 'neg', 'Сумма прибылей / сумма убытков')}
       ${card('Комиссии и заём', usd(-st.fees), `до них ${usd(st.gross)}`, 'neg', 'Комиссия биржи и проценты за заём под шорты и плечо, за все сделки')}
       ${card('Комиссия в R', st.feeR == null ? '—' : '−' + st.feeR.toFixed(2) + 'R', 'на каждую сделку', st.feeR > 0.1 ? 'neg' : '', 'Какую долю риска сделки съедает комиссия. Чем меньше стоп и чем больше плечо, тем больше эта доля')}
       ${card('Плечо', st.lev == null ? '—' : st.lev.toFixed(2) + '×', `средний размер позиции к балансу · до ${s.lev}×`, '', 'Размер позиции, делённый на баланс. Комиссия считается от размера позиции')}
       ${card('Сделок в день', (st.n / r.days).toFixed(1), `в сделке в среднем ${dur(st.avgHold)}`, '', 'Как часто за период находились сигналы, на которых бот вошёл бы, и сколько в среднем длилась сделка')}
     </div>` : ''}`;
  // by score bucket
  // a study idea with entries of its own has no signal strength: the table by strength would be one empty row
  $('#btScoreP').classList.toggle('hidden', !tr.some(x => x.snap?.score != null));
  const buckets = {};
  for (const x of tr) { const b = Math.min(90, Math.floor((x.snap?.score ?? 0) / 10) * 10); (buckets[b] ||= []).push(x); }
  $('#btScore').innerHTML = groupHead + '<tbody>' + (Object.keys(buckets).sort((a, b) => a - b).map(b => groupRow(`сила ${b}–${+b + 9}`, buckets[b])).join('') || '<tr><td colspan="6" class="mute">нет сделок</td></tr>') + '</tbody>';
  const by = (f, v) => tr.filter(x => f(x) === v);
  $('#btSplit').innerHTML = groupHead + '<tbody>'
    + groupRow('LONG', by(x => x.side, 'LONG')) + groupRow('SHORT', by(x => x.side, 'SHORT'))
    + ['тейк', 'стоп', 'тайм-стоп', 'конец теста'].filter(z => tr.some(x => x.reason === z)).map(z => groupRow('выход: ' + z, by(x => x.reason, z))).join('')
    + (s.regimeSrc === 'majors' ? [['flat', 'Рынок в боковике'], ['up', 'Рынок растёт'], ['down', 'Рынок падает']] : [['flat', 'BTC во флэте'], ['up', 'BTC в росте'], ['down', 'BTC в падении']]).filter(([k]) => tr.some(x => x.snap?.regime === k)).map(([k, nm]) => groupRow(nm, by(x => x.snap?.regime, k))).join('') + '</tbody>';
  // «Можно ли верить»: the part the settings were picked on and the held-out part (#btHold), and what made the result incomplete
  $('#btPartsT').innerHTML = groupHead + '<tbody>' + groupRow(name[0] + ' периода · подбор', fit) + groupRow(name[1] + ' · проверка', out) + '</tbody>';
  $('#btWarn').innerHTML = (r.warn || []).map(([k, t]) => `<div class="banner ${k}"><svg class="i"><use href="#i-${k}"/></svg><div>${t}</div></div>`).join('');
  renderBtTrades();
  eqRestore('bt');
}
// «Сделки бэктеста»: the result filter, the summary by coin and sorting by the head, as «Закрытые сделки» in the journal
// (renderClosed, app/journal.js). This visit's view: it stays for the next run, so runs compare in the same view; not saved
let bRes = '', bView = 'list', bSort = 'tclose', bDir = -1, bcSort = 'n', bcDir = -1;
function renderBtTrades() {
  const all = btRes.trades.map(x => ({...M.normTrade(x), score:x.snap?.score ?? null})), coins = bView === 'coins' && all.length > 0;
  segOn('#btRes', 'br', bRes); segOn('#btView', 'bv', bView);
  $('#btFilters').classList.toggle('hidden', !all.length);
  $('#btcsort').classList.toggle('hidden', !coins); $('#btcsort').value = `${bcSort}:${bcDir}`;
  ['#btCoinsW', '#btHintC'].forEach(s => $(s).classList.toggle('hidden', !coins)); ['#btListW', '#btHintL'].forEach(s => $(s).classList.toggle('hidden', coins));
  const src = coins ? coinSums(all) : all, on = all.length > 0 && !!bRes, list = src.filter(x => !bRes || (x.pnl > 0) === (bRes === 'win'));
  $('#btShown').classList.toggle('hidden', !on);
  $('#btShown').innerHTML = on ? `<span class="mute">Показано <b>${list.length}</b> из ${src.length}</span><button class="chip clear" data-bclear>Сбросить</button>` : '';
  const empty = n => `<tr><td colspan="${n}" class="mute tbl-empty">${!all.length ? 'Сделок нет — сигналов с такой силой за период не было'
    : `${bRes === 'win' ? 'Прибыльных' : 'Убыточных'} ${coins ? 'монет' : 'сделок'} нет <button data-bclear>Сбросить фильтр</button>`}</td></tr>`;
  if (coins) {
    sortHead('#btchead', bcSort, bcDir);
    $('#btCoins tbody').innerHTML = coinRows(sortCoins(list, bcSort, bcDir)) || empty(6);
    return;
  }
  sortHead('#bthead', bSort, bDir);
  btList = list.sort((a, b) => sortBy(bSort, bDir)(a, b) || b.tclose - a.tclose);
  // the first BT_ROWS, the rest on request: a long 15m run drew thousands of rows at once and froze a phone for a moment
  $('#btTrades').innerHTML = btRowsHtml(btAll ? btList : btList.slice(0, BT_ROWS))
    + (!btAll && btList.length > BT_ROWS ? `<tr class="btmore"><td colspan="13"><button data-btmore>Показать все ${btList.length} сделок</button></td></tr>` : '')
    || empty(13);
}
const BT_ROWS = 300;
let btList = [], btAll = false;   // btList: the trades as shown (filtered, sorted); btAll: «Показать все» was pressed for this result — a redraw (the theme) keeps the list open
const btRowsHtml = list => list.map(x => `<tr tabindex="0" class="row" data-id="${x.id}"><td>${dt(x.tclose)}</td><td>${coin(x.sym)}</td>
    <td class="${x.side === 'LONG' ? 'pos' : 'neg'}">${x.side}</td><td>${fp(x.entry)}</td><td>${fp(x.exit)}</td><td class="hm">$${x.size.toFixed(0)}</td>
    <td>${reasonTag(x.reason)}</td><td class="hm mute">${dur(x.hold)}</td><td class="hm ${cl(x.gross)}">${usd(x.gross)}</td><td class="hm neg">${usd(-x.fee)}</td>
    <td class="${cl(x.pnl)}"><b>${usd(x.pnl)}</b></td><td class="${cl(x.r)}">${rr(x.r)}</td><td class="hm">${x.snap?.score ?? '—'}</td></tr>`).join('');

// the stored candle history this browser keeps (history.js, IndexedDB): its size on the button, and clearing it together with
// the downloads held in memory — the next run loads everything again
async function btCacheShow() {
  const s = await HS.cacheStats(), mb = s?.bytes ? s.bytes / 1e6 : 0;
  $('#btCacheN').textContent = mb ? ` · ${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ` : '';
}
// the backtest has no 5m, 1d and 1w (btFill takes 15m): every way into the backtest names the timeframe it took, not the rules'
const btTfNote = want => $('#btTf').value !== want ? ` Таймфрейм ${want} в бэктесте недоступен — взят ${$('#btTf').value}.` : '';
// a profile (or the shared bot's rules) → the backtest form, then the backtest page: check it on history in one click
function btFromProf(p) {   // fill the backtest form from a profile: rules and coins
  btFill(hooks.profSet(p));   // as the bot trades it: a profile without its own flat / impulse border uses the bot's (it was always 0.15 here)
  const c = p.coins || {};
  if (c.mode === 'list' && c.list?.length) { $('#btTop').value = 'custom'; $('#btCustom').value = c.list.map(s => s.replace(/USDT$/, '')).join(', '); }
  else { const tops = [...$('#btTop').options].map(o => +o.value).filter(Boolean), want = +(c.top || 50); $('#btTop').value = String(tops.reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a)); }
  btEstimate();
}
function profToBacktest(p, who) {
  btFromProf(p); hooks.go('backtest');
  toast(`Настройки «${who}» перенесены в бэктест`, `Выберите период и нажмите «Запустить».${btTfNote(p.set.tf)}`, 'ok');
}

// ---------- what ran at load (the page calls start() where the form's handlers used to be) ----------
function start(h) {
  Object.assign(hooks, h);
// the daily turnover of delisted pairs that the pool of 2.45–2.78 kept for the day (up to ~0.5 MB): nothing reads it now
try { localStorage.removeItem('sr_delisted'); } catch {}
// «Дополнительно» in the form stays open or closed as the user left it
$('#btAdv').open = load('sr_btadv', false) === true; $('#btAdv').addEventListener('toggle', () => save('sr_btadv', $('#btAdv').open));
$('#btCache').onclick = async () => {
  if (btBusy) return toast('Идёт бэктест', 'Очистите кэш, когда он закончится.', 'warn');
  histCache.clear(); histBars = 0;
  const ok = await HS.clearCache();
  toast(ok ? 'Кэш истории очищен' : 'История в памяти очищена', ok ? 'Следующий запуск загрузит историю заново.' : 'Хранилище браузера недоступно — в нём нечего очищать.', ok ? 'ok' : 'info');
  btCacheShow();
};
// backtest → bot: keep the tested settings as a profile
$('#btSave').onclick = async () => {
  const s = btSettings(), usesReg = s.regimeOnly !== 'any' || s.strategy === 'switch';
  // a study idea is not in M.STRATEGIES: a profile would fall back to the default strategy (cleanProfile, the bot's oneOf)
  if (M.isStudy(s)) return toast('Учебные стратегии бот не торгует', 'Сохранить можно настройки рабочей стратегии.', 'info');
  // the profile keeps how the market regime was tested — the flat / impulse border and BTC alone or BTC+ETH+SOL — and the bot
  // reads it the same way, on the profile's timeframe
  const name = await ask({title:'Сохранить как профиль бота', text:'Под этим названием профиль появится в «Мой бот» — там его можно выбрать для торговли.',
    ok:'Сохранить', input:{value:`${M.STRATEGIES[s.strategy]} · ${s.tf}${s.rr ? ' · 1:' + s.rr : ''}`}});
  if (!name?.trim()) return;
  const {method, N, k, tf, minScore, strategy, rr, risk, lev, minWidth, maxHL, longOnly, coinErMax, regimeOnly, timeStop, maxOpen, erMax} = s;
  hooks.addProfile({id:'p' + Date.now(), name:hooks.cleanName(name), coins:s.custom ? {mode:'list', list:s.custom} : {mode:'top', top:s.top},
    set:{method, N, k, tf, minScore, strategy, rr, risk, lev, minWidth, maxHL, longOnly, coinErMax, regimeOnly, timeStop, maxOpen,
      ...(s.fixedRisk ? {fixedRisk:true} : {}), ...(usesReg ? {erMax, ...(s.regimeSrc === 'btc' ? {regimeSrc:'btc'} : {})} : {})}});
  toast(`Профиль «${hooks.cleanName(name)}» добавлен`, 'Журнал → Мой бот: нажмите на него, чтобы бот торговал по этим правилам', 'ok', () => hooks.goMine());
};
$('#btRun').onclick = runBacktest;
// the held-out share is only a view of the same trades: the result on screen is redrawn, not rerun, and stays fresh
$('#btHold').onchange = () => { if (btRes) renderBacktest(); };
// "Проверить честно" under an inflated (today's top) result
$('#btVerdict').addEventListener('click', e => {
  // the comparison with random entries: stop it, or count it again after a stop (the same seed — the same line)
  // «Прервать» takes the place of «Сравнить»: the second click of a double click within half a second is not a stop (as #btRun)
  if (e.target.closest('[data-rstop]')) { if (btRnd && performance.now() - btRnd.t > 500) btRnd.stop = true; return; }
  if (e.target.closest('[data-rgo]')) { if (btRes) btRandom(btRes); return; }
  const b = e.target.closest('[data-honest]');
  if (!b || btBusy) return;
  // from a hand-made list: the honest top of about its size (the list stays in its field, to go back to)
  if (b.dataset.honest) { $('#btTop').value = b.dataset.honest; $('#btTop').dispatchEvent(new Event('change', {bubbles:true})); }
  $('#btPit').value = 'pit'; $('#btPit').dispatchEvent(new Event('change', {bubbles:true}));
  runBacktest();
});
$('#btMine').onclick = () => {
  const S = hooks.S();
  btFill(S); $('#btTop').value = '50'; btEstimate();
  toast('Подставлены настройки «Рынка»', `${$('#btTf').value}, канал ${S.N}/${S.k}, топ-50 монет.${btTfNote(S.tf)} Нажмите «Запустить».`, 'ok');
};
// an empty backtest offers a start: the shared bot's rules or the profile «Мой бот» trades by, checked at once on the period
// in the form (60 days by default — under a minute)
$('#btEmpty').onclick = e => {
  const b = e.target.closest('[data-qs]'); if (!b || btBusy) return;
  if (b.dataset.qs === 'shared' && !hooks.SJ()) { toast('Правила общего бота ещё загружаются', 'Попробуйте через пару секунд.', 'info'); return; }
  const S = hooks.S();
  let want = S.tf;
  if (b.dataset.qs === 'market') { btFill(S); $('#btTop').value = '50'; btEstimate(); }   // as «Подставить: настройки „Рынка“»
  else { const p = b.dataset.qs === 'shared' ? hooks.sharedProf() : hooks.activeProfile(); want = p.set.tf; btFromProf(p); }
  runBacktest();
  const note = btTfNote(want); if (note) toast(`Бэктест на ${$('#btTf').value}`, note.trim(), 'warn');
};
$('#btShared').onclick = () => { if (!hooks.SJ()) { toast('Правила общего бота ещё загружаются', 'Попробуйте через пару секунд.', 'info'); return; } profToBacktest(hooks.sharedProf(), 'общий бот'); };
// the profile «Мой бот» trades by: the same set as the empty page's quick start, filled in without a run
$('#btProf').onclick = () => {
  const p = hooks.activeProfile(); btFromProf(p);
  toast(`Подставлен профиль «${p.name}»`, `Нажмите «Запустить».${btTfNote(p.set.tf)}`, 'ok');
};
['#btMethod', '#btN', '#btK', '#btTf', '#btMin', '#btDays', '#btTop', '#btStrat', '#btLong', '#btHL', '#btW', '#btRR', '#btRisk', '#btLev', '#btER', '#btReg', '#btSrc', '#btCoinER', '#btTS', '#btSlots', '#btPit', '#btStart', '#btComp', '#btFrom', '#btTo',
  '#btFibK', '#btFibZone', '#btFibStop', '#btFibTarget', '#btObEntry', '#btObSwing', '#btFvgMin', '#btFvgLife'].forEach(s => $(s).onchange = btEstimate);
// «Свои даты…» start on the previous calendar year (UTC); the dates can't run past today
$('#btDays').addEventListener('change', () => {
  if ($('#btDays').value !== 'custom') return;
  const y = new Date().getUTCFullYear() - 1, today = new Date().toISOString().slice(0, 10);
  $('#btFrom').max = $('#btTo').max = today;
  if (!$('#btFrom').value) $('#btFrom').value = `${y}-01-01`;
  if (!$('#btTo').value) $('#btTo').value = `${y}-12-31`;
  btEstimate();
});
$('#btStart').addEventListener('change', () => { $('#btStart').value = btSettings().start; });   // shows the amount the test will use: 50 → 100
$('#btTf').addEventListener('change', () => hlOpts('#btHL', $('#btTf').value));
hlOpts('#btHL', $('#btTf').value);
$('#btCustom').oninput = btEstimate;
$('#btTop').addEventListener('change', () => { if ($('#btTop').value === 'custom') $('#btCustom').focus(); });
const numFirst = k => k === 'sym' || k === 'reason' ? 1 : -1;   // a first click: names from А, numbers from the biggest
document.querySelectorAll('#bthead th').forEach(th => th.onclick = () => { const k = th.dataset.s; bDir = bSort === k ? -bDir : numFirst(k); bSort = k; if (btRes) renderBtTrades(); });
const bcSortBy = (k, d) => { bcSort = k; bcDir = d; if (btRes) renderBtTrades(); };
document.querySelectorAll('#btchead th').forEach(th => th.onclick = () => { const k = th.dataset.s; bcSortBy(k, bcSort === k ? -bcDir : numFirst(k)); });
$('#btcsort').onchange = e => { const [k, d] = e.target.value.split(':'); bcSortBy(k, +d); };   // phones: the summary is cards, without a head to sort by
$('#btTradesP').addEventListener('click', e => {
  const r = e.target.closest('[data-br]'), v = e.target.closest('[data-bv]');
  if (r) bRes = r.dataset.br; else if (v) bView = v.dataset.bv; else if (e.target.closest('[data-bclear]')) bRes = ''; else return;
  if (btRes) renderBtTrades();
});
$('#btTrades').onclick = e => {
  if (e.target.closest('[data-btmore]')) { btAll = true; e.target.closest('tr').outerHTML = btRowsHtml(btList.slice(BT_ROWS)); return; }
  const tr = e.target.closest('tr.row'); if (!tr || !btRes) return;
  const x = btRes.trades.find(t => String(t.id) === tr.dataset.id);
  if (x) showTrade(x, {isOpen:false, who:'бэктест', set:btRes.settings});
};
// the backtest opens on the rules that held up over a year (the shared bot trades by the same), not on a setup that loses
$('#btDays').value = '60'; btFromProf(hooks.firstPreset());
}

export {parseCoins, fmtDay, btBusy, btRes, btHist, btFill, btEstimate, runBacktest, renderBacktest, btCacheShow, profToBacktest, start};
