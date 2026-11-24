// The bot (docs/PLAN-UNTANGLE-modules.md, wave 6): the journals themselves (J, SJ, SB_MINE) and which one is shown (jMode), the
// profiles, the browser bot's step, the profile's server bot, sharing a profile, the «Мой бот» panel and the profile form, Telegram,
// the shared bot, closing by hand and the reset. What ran at load in the page is start(), startForm() and startPanel(), called by the
// page at the same places as before. The journal (app/journal.js) does not import this module: it gets J, BP… in its start().
import * as M from '../supabase/functions/_shared/math.js';
import {TOPS as AL_TOPS, alertsView} from '../supabase/functions/_shared/alerts.js';
import {$, firstShow, load, save, fp, usd, rr, cl, dt, dur, base, pair, tfOf, toast, api, klines, pool, esc, ask, money, plural, METHOD_NAME, hlOpts, isPhone, keepFocus} from './core.js';
import {SB_URL, SB_KEY, AUTH, ME, syncReady, canon, authedFetch} from './account.js';   // it also keeps the order: J, BP and UB read the storage below, when this module loads
import {parseCoins, profToBacktest} from './backtest.js';
import {renderJournal, capJournal, baseOf, openTrade} from './journal.js';
const { TFMS, clamp } = M;

// the page's own functions and values this code needs: given by start() as wrappers, since some are declared further down the page
// and cache, chart are assigned anew there. The functions are called by their own names through these
const hooks = {};
const barsFor = (...a) => hooks.barsFor(...a), go = (...a) => hooks.go(...a), openJournal = m => hooks.openJournal(m), notifyUser = (...a) => hooks.notifyUser(...a),
  renderAway = () => hooks.renderAway(), drawChart = () => hooks.drawChart(), renderDetail = () => hooks.renderDetail(), ago = ms => hooks.ago(ms),
  liveTag = (...a) => hooks.liveTag(...a), tickLive = () => hooks.tickLive(), syncInputs = () => hooks.syncInputs(), loadChart = () => hooks.loadChart();

// the journals: J the browser bot's (kept in this browser), SJ the shared bot's, SB_MINE (below) the server bot's; jMode — the one
// the journal shows: 'mine' or 'shared', written by the page through setJMode
let J = load('sr_journal', null) || {balance:10000, start:10000, open:[], closed:[], on:true};
let SJ = null, jMode = load('sr_jmode', 'shared');
const setJMode = m => { jMode = m; };
// my bot's positions live in the browser or, in server mode, in the server journal
const myOpen = () => BP.where === 'server' ? (SB_MINE?.open || []) : J.open;
// an open position's result at the last price, after the entry and exit fee (the journal's «PnL сейчас» and the close dialog)
function openPnl(p) { const sg = p.side === 'LONG' ? 1 : -1, last = p.last ?? p.entry;
  return {u:sg * (last - p.entry) * p.qty - (p.entry + last) * p.qty * M.FEE, risk:p.risk || Math.abs(p.entry - p.sl) * p.qty}; }

// ---------- my bot (browser): profiles ----------
// A profile = which coins + which rules. "Auto" picks the flat or the impulse profile from the BTC/ETH/SOL regime.
const cleanName = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 60) || 'Профиль';
const PROFILE_DEF = {method:'log', N:210, k:3, tf:'15m', minScore:60, strategy:'revert', rr:0, risk:0.02, lev:1, minWidth:0, maxHL:0, longOnly:false, coinErMax:0, regimeOnly:'any', timeStop:48, maxOpen:3};
// p-sw4h: the shared bot's rules since 11.10.2026 (top-50, 4h, channel 3.5σ, T½ ≤ 20, flat if ER < 0.25). They were picked on
// today's top-50 traded all year (+0.38R a trade); on the top-50 of each moment, delisted coins included, they lose in each of
// three years (−0.30…−0.42R), so the preset is no longer called tested (docs/RESEARCH-2026-10.md, 19.10)
const PRESETS = [
  {id:'p-sw4h', name:'Переключатель · 4h', coins:{mode:'top', top:50}, set:{...PROFILE_DEF, tf:'4h', k:3.5, maxHL:20, erMax:0.25, strategy:'switch', rr:2, risk:0.01, lev:3, regimeOnly:'any'}},
  {id:'p-flat1h', name:'Боковик · 1h', coins:{mode:'top', top:50}, set:{...PROFILE_DEF, tf:'1h', rr:2, risk:0.01, lev:3, regimeOnly:'flat'}},
  {id:'p-flat', name:'Боковик · 15m', coins:{mode:'top', top:150}, set:{...PROFILE_DEF}},
  {id:'p-imp', name:'Импульс · 4h', coins:{mode:'top', top:150}, set:{...PROFILE_DEF, tf:'4h', k:3.5, strategy:'breakout', rr:3, longOnly:true}},
];
// the shared bot's rules as checked on the honest top over three years (docs/RESEARCH-2026-10.md, 19.10): while it trades by
// exactly these, its journal says in large type that they lost every year. Rules changed since → the numbers no longer apply,
// and the notice goes
const SHARED_TESTED = {N:210, k:3.5, rr:2, tf:'4h', lev:3, top:50, risk:0.01, erMax:0.25, maxHL:20, method:'log', minScore:60, strategy:'switch', timeStop:48, regimeSrc:'majors', regimeOnly:'any'};
const sharedNoEdge = () => !!SJ?.settings && Object.entries(SHARED_TESTED).every(([k, v]) => SJ.settings[k] === v);
// no preset has held up on an honest check (the top of each moment, delisted coins included, several years), so each says so;
// the shared bot's one with its numbers
const presetTag = p => !PRESETS.some(x => x.id === p.id) ? '' : ` <span class="tag" title="${p.id === 'p-sw4h'
  ? 'Правила общего бота. Честная проверка — топ-50 монет на каждый момент, включая снятые с биржи, — в минусе все три последних года: −0.42R, −0.40R и −0.30R на сделку. Прежние «+0.38R за год» получались только на сегодняшнем топ-50, который год назад знать было нельзя'
  : 'Готовый пример настроек, а не проверенная стратегия: честной проверкой на нескольких годах (топ монет на каждый момент, включая снятые с биржи) не подтверждён. Проверьте его в бэктесте'}">не подтверждён</span>`;
let BP = load('sr_bot', null) || {profiles:PRESETS, mode:'single', active:'p-sw4h', flat:'p-flat1h', impulse:'p-imp', erMax:0.15};
if (!BP.profiles.some(p => p.id === 'p-flat1h')) BP.profiles.unshift(PRESETS[1]);   // older setups get the presets they miss
if (!BP.profiles.some(p => p.id === 'p-sw4h')) BP.profiles.unshift(PRESETS[0]);
BP.profiles.forEach(p => { if (p.id === 'p-sw4h' && p.set.k === 3 && !p.set.maxHL) p.set = {...PRESETS[0].set}; });   // the first version of this preset (one day old) gets the tuned rules
// presets that did not hold up on an honest check: drop the "проверен за год" their names were saved with
BP.profiles.forEach(p => { if ((p.id === 'p-flat1h' || p.id === 'p-sw4h') && / \(проверен за год\)$/.test(p.name)) p.name = p.name.replace(/ \(проверен за год\)$/, ''); });
BP.where ||= 'browser';
BP.profiles.forEach(p => { p.name = cleanName(p.name); });
let UB = load('sr_ubot', null);   // {id} of the profile's server bot (see profileBot); {id, secret} — a bot no profile has yet
let SB_MINE = null;               // the server bot's journal, when it runs on the server
let alertsQ = Promise.resolve(), alertsAt = 0;   // its notification settings' saves, one after another (saveAlerts)
const saveBP = () => save('sr_bot', BP);
const profById = id => BP.profiles.find(p => p.id === id) || BP.profiles[0];
// the flat / impulse border: the profile's own when it has one (presets, shared links and saved backtests carry it), else the bot's
// common one. Before 2.34 the common one always won, so a shared profile backtested differently for people with different settings.
// The regime is read from BTC, ETH and SOL, or from BTC alone when the profile was backtested that way (regimeSrc, since 2.35)
const profSet = p => ({...PROFILE_DEF, ...p.set, regimeSrc:p.set?.regimeSrc === 'btc' ? 'btc' : 'majors', erMax:p.set?.erMax ?? BP.erMax});
const profSummary = p => { const s = profSet(p);
  return `${s.tf} · ${METHOD_NAME[s.method]} ${s.N}/${s.k} · ${M.STRATEGIES[s.strategy]}${s.longOnly ? ', только LONG' : ''} · сила ≥ ${s.minScore} · RR ${s.rr ? '1:' + s.rr : 'к центру'} · риск ${(s.risk * 100).toFixed(1)}%${s.fixedRisk ? ' от старта' : ''} · плечо до ${s.lev}×`
    + (s.minWidth ? ` · ширина ≥ ${s.minWidth}%` : '') + (s.maxHL ? ` · T½ ≤ ${s.maxHL}` : '') + (s.coinErMax ? ` · без трендовых монет` : '')
    + (s.regimeOnly === 'flat' ? ` · только когда ${s.regimeSrc === 'btc' ? 'BTC' : 'BTC, ETH, SOL'} во флэте` : s.regimeOnly === 'impulse' ? ' · только в импульсе' : '')
    + (s.regimeSrc === 'btc' && (s.strategy === 'switch' || s.regimeOnly === 'impulse') ? ' · режим рынка по BTC' : '')
    + (p.set?.erMax != null && (s.strategy === 'switch' || s.regimeOnly !== 'any') ? ` · боковик при ER < ${s.erMax}` : '')
    + (s.timeStop ? ` · тайм-стоп ${s.timeStop} свечей` : ' · без тайм-стопа')
    + ` · позиций одновременно: ${M.slotsOf(s)}`
    + ` · ${p.coins.mode === 'list' ? p.coins.list.map(base).join(', ') : 'топ-' + p.coins.top + ' монет'}`; };
let botRegime = null, botBusy = false, tickerCache = null, botProfile = null, botErr = '';   // botErr: the browser bot's last failed step
// the market regime on a timeframe, measured as the backtest and the server bots do (M.marketOn: BTC/ETH/SOL, closed candles).
// "The market now" (the auto mode's choice of profile, the line in «Мой бот») is 1h; a profile trades by the regime of its own
// timeframe. Kept 3 minutes per timeframe
const REGC = {};
async function regimeOn(tf) {
  const c = REGC[tf];
  // kept up to 3 minutes, but never past the close of a bar: the regime is read at the last closed bar, and one kept from the
  // previous bar decided the first entries on the new one by the old regime (the server bots measure it every minute)
  if (c && Date.now() - c.t < 3 * 6e4 && Math.floor(c.t / TFMS[tf]) === Math.floor(Date.now() / TFMS[tf])) return c.m;
  const C = {};
  await Promise.all(M.MAJORS.map(async s => { try { C[s] = M.closedCloses(await klines(s, tf, M.BARS), tf, Date.now()); } catch {} }));
  const m = M.marketOn(s => C[s] || null, tf);
  REGC[tf] = {t:Date.now(), m};
  return m;
}
// the same for drawing: what is known now (null at first), fetched in the background with one redraw when it arrives
const regAsked = {};
function regNow(tf, redraw) {
  const c = REGC[tf];
  if ((!c || Date.now() - c.t > 3 * 6e4) && !regAsked[tf]) { regAsked[tf] = true; regimeOn(tf).then(() => redraw?.()).catch(() => {}).finally(() => { regAsked[tf] = false; }); }
  return c?.m || null;
}
function activeProfile() {
  if (BP.mode !== 'auto') return profById(BP.active);
  const st = botRegime ? M.regimeOf(botRegime, {erMax:BP.erMax, regimeSrc:'majors'}) : 'flat';
  return profById(st === 'flat' ? BP.flat : BP.impulse);
}
// this device's own server bot, replaced by the profile's: asked once, with its result. Kept, it trades on unseen and never
// writes to Telegram (only a profile's bot does); it falls asleep 30 days after it was last opened
async function oldBotAsk() {
  const old = load('sr_ubot_old', null); if (!old?.id || old.id === UB?.id) return save('sr_ubot_old', null);
  let r; try { r = await rpc('ub_get', {p_id:old.id, p_secret:old.secret || null}); }
  catch (e) { if (rpcIs(e, /forbidden/)) save('sr_ubot_old', null); return; }   // gone, or another profile's: nothing to ask; offline: the next start
  const b = r.bot, n = r.closed?.length || 0, pos = r.open?.length || 0, pnl = b.balance - b.start_balance;
  const del = await ask({title:'Удалить прежний серверный бот?', ok:'Удалить', no:'Оставить', danger:true,
    text:`На этом устройстве был свой бот на сервере, теперь здесь бот профиля. Итог прежнего: баланс $${money(b.balance)} (${usd(pnl)}), сделок ${n}, открытых позиций ${pos}. Оставленный, он продолжит торговать без Telegram; удалённый — вместе со сделками и позициями. Отменить удаление нельзя.`});
  if (del) { try { await rpc('ub_delete', {p_id:old.id, p_secret:old.secret || null}); toast('Прежний бот удалён', '', 'ok'); } catch (e) { if (!rpcIs(e, /forbidden/)) return toast('Не удалось удалить прежний бот', String(e.message || e), 'bad'); } }
  save('sr_ubot_old', null);
}

// ---------- my bot on the server: the profile's bot (accounts stage 5), one for all its devices ----------
// signed in, calls go as the person (the profile's Telegram, the Beta, owner rights); a stale token is refreshed once
// PostgREST answers an error as {code, message, hint, details}: the person reads a sentence (RPC_TEXT), the code tells errors
// apart by the server's own words, kept in e.raw («P0001 forbidden»). Until 2.114 the toast showed the raw JSON
const RPC_TEXT = {'forbidden':'нет доступа к этому боту: его удалили или он принадлежит другому профилю', 'no profiles':'нужен хотя бы один профиль',
  'not signed in':'войдите в аккаунт', 'no bot':'бот не найден', 'config too large':'слишком много настроек — удалите лишние профили',
  'too big':'слишком большие данные', 'too many keys':'слишком много сохранённых настроек', 'bad key':'неизвестная настройка',
  'too many bots from this address, try later':'с этого адреса создано слишком много ботов, попробуйте позже',
  'too many bots created, try later':'сейчас создаётся слишком много ботов, попробуйте позже',
  'start balance must be 100 … 10000000':'стартовый баланс — от 100 до 10 000 000'};
const rpcIs = (e, re) => re.test(e?.raw || e?.message || '');
async function rpc(fn, args) {
  const r = await authedFetch(SB_URL + 'rpc/' + fn, {method:'POST', body:JSON.stringify(args)});
  if (!r.ok) {
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    const raw = String(j?.message || t || `HTTP ${r.status}`).slice(0, 200), e = new Error(RPC_TEXT[raw] || raw);
    e.raw = `${j?.code || ''} ${raw}`.trim(); e.status = r.status; throw e;
  }
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
// the server bot's id and, for a bot no profile has claimed yet, its secret (a profile's bot answers to the person's token)
const ubArgs = (x = {}) => ({p_id:UB.id, p_secret:UB.secret || null, ...x});
// The server knows the profile's bot; this device follows it at every start. The profile has one → it is shown here, and the
// device's own bot, if it had another, is offered for deletion once (oldBotAsk). The profile has none → the device's own bot
// becomes the profile's (the first device wins). Neither → the bot works in the browser until «На сервере 24/7» creates one
async function profileBot() {
  if (!AUTH) return;
  // «На сервере 24/7» pressed while the answer was on its way created the profile's bot: that is newer than the answer
  const was = UB?.id || null, moved = () => (UB?.id || null) !== was;
  let id;
  try { id = (await rpc('ub_mine', {}))?.id; } catch { return; }   // offline: as it was
  if (moved()) return;
  if (!id && UB?.secret) {
    try { id = (await rpc('ub_claim', {p_id:UB.id, p_secret:UB.secret}))?.id; }
    catch (e) { if (!rpcIs(e, /forbidden/)) return; }   // forbidden: this device's bot is gone, or another profile's
    if (moved()) return;
  }
  if (id && UB?.secret && UB.id !== id) save('sr_ubot_old', UB);
  UB = id ? {id} : null; save('sr_ubot', UB);
  const lost = BP.where === 'server' && !UB;   // deleted on another device, or asleep too long and removed
  if (lost) { botGone(); toast('Серверный бот не найден', 'бот работает в этой вкладке; «На сервере 24/7» создаст нового', 'warn'); }
  if (lost || was !== (id || null)) { SB_MINE = null; renderBotPanel(); renderJournal(); renderGuard(); fetchServerBot(); }
  oldBotAsk();
}
// what the server bot trades by; its Telegram settings are kept apart (alerts, see renderTg)
const serverConfig = () => ({profiles:BP.profiles, mode:BP.mode, active:BP.active, flat:BP.flat, impulse:BP.impulse, erMax:BP.erMax});
// on/off goes only with the person's own «Пауза» / «Продолжить» (on); other pushes leave it as the server has it: every device
// pushes to the one profile bot, and a device's own journal flag would pause it for all of them
let syncTimer, ubOn = null, cfgChecked = false;
function syncServerBot(on) {   // push profiles/mode to the server bot (debounced)
  if (BP.where !== 'server' || !UB) return;
  if (on != null) ubOn = on;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { const en = ubOn; ubOn = null;
    if (BP.where !== 'server' || !UB) return;   // the bot went meanwhile (deleted, the profile too)
    rpc('ub_set', ubArgs({p_config:serverConfig(), p_enabled:en})).then(() => fetchServerBot())
      .catch(e => { toast('Не удалось сохранить на сервере', String(e.message || e), 'bad'); fetchServerBot(); }); }, 400);   // the panel shows what the server has
}
async function fetchServerBot() {
  if (BP.where !== 'server' || !UB) return;
  const id = UB.id, sent = Date.now();
  try {
    const r = await rpc('ub_get', ubArgs()), b = r.bot, prev = SB_MINE;
    if (UB?.id !== id) return;   // the device moved to the profile's bot meanwhile

    // the server trades on its own: compare with the previous poll to tell the owner about new trades
    if (prev) {
      const seenO = new Set(prev.open.map(p => p.id)), seenC = new Set(prev.closed.map(t => t.id)), toJ = () => openJournal('mine');
      for (const p of (r.open || []).filter(p => !seenO.has(p.id))) notifyUser(`Мой бот: ${p.side} ${pair(p.sym)}`, `${p.snap?.profile ? `«${p.snap.profile}» · ` : ''}вход ${fp(p.entry)} · тейк ${fp(p.tp)} · стоп ${fp(p.sl)}`, 'info', toJ);
      for (const t of (r.closed || []).filter(t => !seenC.has(t.id))) notifyUser(`Мой бот: ${pair(t.sym)} закрыта — ${t.reason}`, `${usd(t.pnl)} (${rr(t.r)})`, t.pnl > 0 ? 'ok' : 'bad', toJ);
    }
    SB_MINE = {balance:b.balance, start:b.start_balance, open:r.open || [], closed:r.closed || [], on:b.enabled,
      checked:b.checked_at ? Date.parse(b.checked_at) : 0, profile:b.active_profile, regime:b.regime, error:b.last_error, tg:!!b.tg_chat,
      alerts:prev && sent < alertsAt ? prev.alerts : b.alerts || null};   // a notification setting saved while this was on its way is newer
    // once per page, after the sync has caught up with the profile: the server's profiles differ from the profile's (a push
    // that failed) → send them. Before 2.84 every device sent its own at every start, even before it knew of newer ones
    if (!cfgChecked && syncReady) { cfgChecked = true; if (canon(b.config || {}) !== canon(serverConfig())) syncServerBot(); }
    renderBotPanel(); renderAway();
    if (!$('#journal').classList.contains('hidden')) renderJournal();
    if (hooks.chart()) drawChart();
  } catch (e) {
    if (UB?.id !== id) return;
    if (rpcIs(e, /forbidden/)) profileBot();   // deleted on another device: the profile may have another bot, or none
    // any other failure (no connection, a timeout, a server error) was dropped and the panel kept old numbers as if fresh
    else if (SB_MINE) { SB_MINE.fetchError = String(e.message || e); renderGuard(); }
  }
}
// this device no longer has the profile's server bot (deleted here or on another device, asleep and removed, or the profile
// went): the bot carries on in this tab. One place for the three ways it happens
function botGone() {
  clearTimeout(syncTimer); ubOn = null;
  UB = null; save('sr_ubot', null); SB_MINE = null;
  if (BP.where === 'server' || BP.srvPaused != null) { BP.where = 'browser'; delete BP.srvPaused; saveBP(); }
}
let ubPausing = false;    // «В браузере» waiting for the server bot's pause
let ubCreating = false;   // a double tap would send two creates (the second gets the first one's bot back, with a second toast)
async function setWhere(w) {
  let fresh = false;
  if (w === 'server' && !UB) {
    if (ubCreating) return;
    let r; ubCreating = true;
    try { r = await rpc('ub_create', {p_config:serverConfig()}); }
    catch (e) { toast('Не удалось создать серверного бота', String(e.message || e), 'bad'); return; }
    finally { ubCreating = false; }
    UB = r.secret ? {id:r.id, secret:r.secret} : {id:r.id}; save('sr_ubot', UB);
    if (r.existing) toast('У профиля уже есть бот на сервере', 'здесь теперь его журнал', 'ok');   // another device created it a moment ago
    else {
      fresh = true;
      // a new server bot starts at $10 000; with another start in the browser it begins from the same amount
      const start = J.start >= 100 && J.start <= 1e7 ? Math.round(J.start) : 10000;
      if (start !== 10000) await rpc('ub_reset', ubArgs({p_start:start})).catch(() => {});
      toast('Ваш бот теперь работает на сервере 24/7', `торгует по выбранному профилю, даже когда сайт закрыт. Журнал — отдельный, начинается с $${start.toLocaleString('ru')}`, 'ok');
    }
  }
  // «В браузере» pauses the profile's server bot (the owner's decision, 09.11): before 2.84 it went on trading and writing to
  // Telegram unseen, the site showed the browser journal, and 30 days later it fell asleep. srvPaused (in sr_bot, so every device
  // knows) — it was running when paused here: «На сервере 24/7» runs it again; one the person had paused stays paused
  let paused = null;
  if (w === 'browser' && BP.where === 'server' && UB) {
    // a second tap while this waits would read the bot as paused by the first and overwrite srvPaused with false
    if (ubPausing) return;
    ubPausing = true;
    try {
    // the bot's state not loaded yet (a tap in the first second): asked here, so a bot the person had paused isn't resumed later
    paused = SB_MINE ? SB_MINE.on !== false : await rpc('ub_get', ubArgs()).then(r => r.bot?.enabled !== false, () => true);
    clearTimeout(syncTimer); ubOn = null;
    try { await rpc('ub_set', ubArgs({p_config:serverConfig(), p_enabled:false})); }
    catch (e) { toast('Не удалось поставить серверного бота на паузу', String(e.message || e), 'bad'); renderBotPanel(); return; }   // the switch stays where it was
    } finally { ubPausing = false; }
  }
  const resume = w === 'server' && !fresh && BP.srvPaused === true;
  BP.where = w;
  if (paused != null) BP.srvPaused = paused; else if (w === 'server') delete BP.srvPaused;
  saveBP();
  if (w === 'server') { syncServerBot(fresh ? J.on : resume ? true : null); fetchServerBot(); } else SB_MINE = null;   // a new bot starts as the browser one was
  if (paused != null) toast('Бот работает в этой вкладке', 'серверный бот на паузе и не пишет в Telegram; «На сервере 24/7» вернёт его', 'info');
  renderBotPanel(); renderJournal();
}
// Several open tabs each run the browser bot on one journal (sr_journal). Until 2.117 each traded its own copy and the last to save
// won: trades and their P&L vanished, one coin could be entered twice. Now one tab steps at a time (Web Lock sr_bot; the others skip
// that minute), and the step re-reads the journal from storage right before botTick, then saves it with no await between
async function runBot() {
  if (BP.where === 'server') { fetchServerBot(); return; }   // the server trades; the browser only shows the journal
  if (botBusy) return;
  if (navigator.locks?.request) return navigator.locks.request('sr_bot', {ifAvailable:true}, lk => lk ? botStep() : null).catch(() => {});
  return botStep();
}
async function botStep() {
  if (botBusy) return; botBusy = true;
  try {
    const now = Date.now();
    botRegime = await regimeOn('1h');   // "the market now": the auto mode picks the profile by it
    const P = activeProfile(), set = profSet(P);
    if (botProfile && botProfile !== P.id && BP.mode === 'auto') notifyUser(`Мой бот: профиль «${P.name}»`, `рынок сменился — ${M.regimeOf(botRegime, {erMax:BP.erMax, regimeSrc:'majors'}) === 'flat' ? 'боковик' : 'импульс'}`, 'warn');
    botProfile = P.id;
    let list;
    if (P.coins.mode === 'list') list = [...P.coins.list];
    else { if (!tickerCache || now - tickerCache.t > 5 * 6e4) tickerCache = {t:now, d:await api('/api/v3/ticker/24hr')}; list = M.pickSymbols(tickerCache.d, P.coins.top, [], now); }
    // the market scan already has these candles when the profile uses the same timeframe and channel; the same history length
    // as the server bots and the collector (M.BARS), so the strength matches theirs
    const S = hooks.S(), same = set.tf === S.tf && set.N === S.N, own = {}, nb = barsFor(set);
    await pool(list.filter(s => !(same && hooks.cache()[s])), 8, async s => { try { own[s] = await klines(s, set.tf, nb); } catch {} });
    const kOf = s => { const K = (same && hooks.cache()[s]) || own[s]; return K && K.length > nb ? K.slice(-nb) : K; };
    const botRows = list.map(s => { const K = kOf(s); return K ? M.analyze(s, K, set) : null; }).filter(Boolean);
    // exits are checked on each position's own timeframe
    const exitK = {};
    // enough candles to cover the time since the last check: after the tab was closed for long (more than 150 candles of the
    // position's timeframe) a stop or a take hit in the gap went unseen and was never checked again. Binance gives 1000 at most
    await pool(J.open, 6, async p => {
      const tf = tfOf(p.tfms) || set.tf, need = Math.min(1000, Math.ceil((now - Math.max(p.time, +J.checked || 0)) / p.tfms) + 3);
      const have = tf === set.tf && kOf(p.sym) ? kOf(p.sym) : tf === S.tf && hooks.cache()[p.sym] ? hooks.cache()[p.sym] : null;
      exitK[p.sym] = have && have.length >= need ? have : await klines(p.sym, tf, Math.max(150, need)).catch(() => have);
    });
    // it trades by the regime of the profile's own timeframe, as the backtest of that profile does. Awaited before the journal
    // is read: an await between reading J.open / J.balance and writing them back let a manual close made meanwhile be undone
    // (the position came back and its P&L was lost). The pause after a trade counts that close too
    const market = (await regimeOn(set.tf)) ?? undefined;
    J = load('sr_journal', J);   // another tab may have stepped or closed a position since this one read it (see runBot)
    if (BP.where === 'server') return;   // switched to the server meanwhile
    // in «Авто» with the market regime unknown (one of BTC/ETH/SOL did not load) no profile is the right one: no entries this minute
    const blind = BP.mode === 'auto' && M.regimeOf(botRegime, {erMax:BP.erMax, regimeSrc:'majors'}) == null;
    const recent = J.closed.filter(x => now - x.tclose < M.COOLDOWN * TFMS[set.tf]).map(x => x.sym);
    const res = M.botTick({rows:botRows, klines:exitK, open:J.open, recentSyms:recent, balance:J.balance, start:J.start, S:set, now, allowEntries:J.on && !blind, market});
    for (const p of res.opened) { p.note = `«${P.name}» · ${p.note}`; p.snap.profile = P.name; }
    J.open = [...res.stillOpen, ...res.opened];
    J.closed = [...res.closed, ...J.closed]; capJournal();
    for (const p of res.opened) notifyUser(`Мой бот: ${p.side} ${pair(p.sym)}`, `«${P.name}» · вход ${fp(p.entry)} · тейк ${fp(p.tp)} · стоп ${fp(p.sl)}`, 'info', () => openJournal('mine'));
    for (const t of res.closed) notifyUser(`Мой бот: ${pair(t.sym)} закрыта — ${t.reason}`, `${usd(t.pnl)} (${rr(t.r)})`, t.pnl > 0 ? 'ok' : 'bad', () => openJournal('mine'));
    J.balance = res.balance; J.checked = now; J.scanned = botRows.length;
    save('sr_journal', J); renderGuard(); renderBotPanel();
    if (!$('#journal').classList.contains('hidden')) renderJournal();
    if (hooks.chart()) drawChart();
    if (botErr) { botErr = ''; renderGuard(); }
  } catch (e) { console.warn('my bot', e); botErr = String(e?.message || e).slice(0, 200); renderGuard(); }   // said in the guard, not only the console
  finally { botBusy = false; }
}
// ---------- sharing profiles: a link carries one profile; everything is re-validated on the way in ----------
// (names end up in innerHTML, so they are stripped of markup wherever a profile enters: form, link, storage)
const num = (v, a, b, d) => { v = +v; return isFinite(v) ? clamp(v, a, b) : d; };
const near = (v, opts, d) => { v = +v; return isFinite(v) ? opts.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a) : d; };
function cleanProfile(p) {
  const s = p?.set || {}, D = PROFILE_DEF, c = p?.coins || {};
  const pick = (v, ok, d) => ok.includes(v) ? v : d;
  const set = {method:pick(s.method, ['log', 'classic', 'robust', 'ewma'], D.method), N:Math.round(num(s.N, 20, 300, D.N)), k:num(s.k, 1, 5, D.k),
    tf:pick(s.tf, ['5m', '15m', '1h', '4h', '1d'], D.tf), minScore:Math.round(num(s.minScore, 0, 100, D.minScore)),
    // values offered as lists in the form snap to the nearest option, so editing an imported profile never shows an empty field
    strategy:pick(s.strategy, Object.keys(M.STRATEGIES), D.strategy), rr:near(s.rr, [0, 1.5, 2, 3], 0), risk:near(s.risk, [0.005, 0.01, 0.02, 0.03, 0.04, 0.05], D.risk),
    lev:near(s.lev, [1, 2, 3, 5, 10], 1), minWidth:near(s.minWidth, [0, 3, 5, 8], 0), maxHL:near(s.maxHL, [0, 20, 40], 0), coinErMax:near(s.coinErMax, [0, 0.2, 0.3], 0),
    longOnly:s.longOnly === true, regimeOnly:pick(s.regimeOnly, ['any', 'flat', 'impulse'], 'any'), timeStop:near(s.timeStop ?? 48, [0, 24, 48, 96], 48), maxOpen:near(s.maxOpen ?? 3, M.SLOTS, 3),
    ...(s.fixedRisk === true ? {fixedRisk:true} : {}),   // risk from the starting balance, without compounding
    // the profile's own flat / impulse border travels with it; a profile without one uses the receiver's common setting
    ...(s.erMax != null && isFinite(+s.erMax) ? {erMax:near(s.erMax, [0.1, 0.15, 0.25], 0.15)} : {}),   // the values the selects offer
    ...(s.regimeSrc === 'btc' ? {regimeSrc:'btc'} : {})};   // the regime from BTC alone, as it was backtested
  const list = Array.isArray(c.list) ? c.list.map(x => String(x).toUpperCase()).filter(x => /^[A-Z0-9]{2,20}USDT$/.test(x)).slice(0, 200) : [];
  return {name:cleanName(p?.name), coins:c.mode === 'list' && list.length ? {mode:'list', list} : {mode:'top', top:[20, 50, 100, 150, 200].includes(+c.top) ? +c.top : 150}, set};
}
const b64u = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)));
const shareLink = p => location.origin + location.pathname + '#p=' + b64u(JSON.stringify({app:'sigma-radar', v:1, p:cleanProfile(p)}));
function parseShared(text) {
  const t = String(text || '').trim(), m = t.match(/#p=([A-Za-z0-9_-]+)/) || t.match(/^([A-Za-z0-9_-]{20,})$/);
  if (!m) return {error:'Это не ссылка на профиль Sigma Radar.'};
  try {
    const d = JSON.parse(unb64u(m[1]));
    if (d?.app !== 'sigma-radar' || typeof d.p !== 'object') throw 0;
    if ((d.v || 0) > 1) return {error:'Профиль сделан в более новой версии сайта — обновите страницу.'};
    return {p:cleanProfile(d.p)};
  } catch { return {error:'Ссылка повреждена — попросите прислать её ещё раз.'}; }
}
let pendingImport = null;
function showImport(p) {
  pendingImport = p;
  $('#pimp').innerHTML = `<div><b>Вам прислали профиль «${p.name}»</b><p>${profPlain(p)}</p><p class="faint" style="font-size:12px">${profSummary(p)}</p></div>
    <div class="bh-a"><button class="primary" data-imp="add">Добавить себе</button><button data-imp="no">Не надо</button></div>`;
  $('#pimp').classList.remove('hidden');
}
// a link to send: a phone's own share sheet (messengers, mail), else the clipboard, else a field to copy it from
async function shareUrl(url, title, copied) {
  if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({url, title}); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast(copied, '', 'ok'); }
  catch { await ask({title, text:'Браузер не дал скопировать автоматически — выделите ссылку и скопируйте её сами.', ok:'Готово', input:{value:url}}); }
}
async function shareProfile(p) {
  const url = shareLink(p);
  if (navigator.share && matchMedia('(pointer:coarse)').matches) { try { await navigator.share({url, title:'Профиль бота: ' + p.name}); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Ссылка на профиль скопирована', 'отправьте её — у получателя профиль добавится в «Мой бот» одним нажатием', 'ok'); }
  catch { await ask({title:'Ссылка на профиль', text:'Браузер не дал скопировать автоматически — выделите ссылку и скопируйте её сами.', ok:'Готово', input:{value:url}}); }
}
async function importByLink() {
  const t = await ask({title:'Добавить профиль по ссылке', text:'Вставьте ссылку, которой с вами поделились.', ok:'Продолжить', input:{placeholder:'https://…#p=…'}});
  if (!t?.trim()) return;
  const r = parseShared(t);
  if (r.error) toast('Не получилось добавить профиль', r.error, 'warn'); else { showImport(r.p); $('#pimp').scrollIntoView({block:'nearest', behavior:'smooth'}); }
}
// ---------- my bot: panel ----------
let editId = null;
// plain-language description of a profile, for people who don't read "лог-канал 210/3"
const TF_PLAIN = {'5m':'5-минутные свечи', '15m':'15-минутные свечи', '1h':'часовые свечи', '4h':'4-часовые свечи', '1d':'дневные свечи'};
const TF_BY = {'5m':'5-минутным свечам', '15m':'15-минутным свечам', '1h':'часовым свечам', '4h':'4-часовым свечам', '1d':'дневным свечам'};   // «решает по …»
const profPlain = p => { const s = profSet(p);
  const idea = s.strategy === 'breakout' ? 'Идёт за сильным движением: входит, когда цена пробила границу канала'
    : s.strategy === 'switch' ? 'Сам меняет тактику: в боковике ловит отскоки, в росте — пробои'
    : s.strategy === 'revert_trend' ? 'Ловит отскоки от границы, но только по направлению тренда'
    : 'Ловит отскоки: цена ушла за границу канала и возвращается к середине';
  const when = s.regimeOnly === 'flat' ? ' Торгует только в спокойном рынке.' : s.regimeOnly === 'impulse' ? ' Торгует только в сильном движении.' : '';
  const hold = s.timeStop ? '' : ' Держит сделку до тейка или стопа.';
  const tfp = TF_PLAIN[s.tf] || s.tf;
  return `${idea}.${when}${hold} ${tfp[0].toUpperCase() + tfp.slice(1)}, ${p.coins.mode === 'list' ? 'монеты: ' + p.coins.list.map(base).join(', ') : 'топ-' + p.coins.top + ' монет'}, риск ${(s.risk * 100).toFixed(s.risk < 0.01 ? 1 : 0)}% ${s.fixedRisk ? 'от стартового баланса' : 'на сделку'}.`; };
const regPlain = r => r === 'flat' ? 'боковик' : r === 'up' ? 'импульс вверх' : r === 'down' ? 'импульс вниз' : '—';
// why the bot isn't opening trades right now — in words, with the one action that changes it
const allowsReg = (p, r) => { const x = profSet(p);
  if (!r) return true;
  if (x.regimeOnly === 'flat' && r !== 'flat') return false;
  if (x.regimeOnly === 'impulse' && r === 'flat') return false;
  return !(x.strategy === 'switch' && r === 'down'); };
// "Рынок": what the shared bot is doing right now, in one line — in a trade, waiting for its kind of market, or waiting for a signal
function renderBotNow() {
  const el = $('#botNow'); if (!el) return;
  if (!SJ?.checked) { el.classList.add('hidden'); return; }
  const s = {...SJ.settings, regimeSrc:SJ.settings.regimeSrc || 'majors'}, open = SJ.open || [];
  const reg = sharedReg(() => { renderBotNow(); if (!$('#journal').classList.contains('hidden')) renderJournal(); }), only = s.regimeOnly || (s.flatOnly ? 'flat' : 'any');
  const off = reg && ((only === 'flat' && reg !== 'flat') || (only === 'impulse' && reg === 'flat') || (s.strategy === 'switch' && reg === 'down'));
  const pos = p => { const sg = p.side === 'LONG' ? 1 : -1, last = p.last ?? p.entry, u = sg * (last - p.entry) * p.qty - (p.entry + last) * p.qty * M.FEE;
    return `<span class="bn-pos"><b>${pair(p.sym)}</b> <span class="${p.side === 'LONG' ? 'pos' : 'neg'}">${p.side}</span> <span class="${cl(u)}">${usd(u)}</span></span>`; };
  const now = open.length ? `в сделке: ${open.map(pos).join('')}`
    : off ? (only === 'flat' ? `ждёт: торгует только в боковике, а сейчас ${regPlain(reg)}` : only === 'impulse' ? 'ждёт: торгует только в импульсе, а сейчас боковик' : 'ждёт: в падающем рынке в сделки не входит, а сейчас импульс вниз')
    : `ждёт сигнала: ${TF_PLAIN[s.tf] || s.tf}, сила от ${s.minScore}`;
  const last = [...(SJ.closed || [])].sort((a, b) => b.tclose - a.tclose)[0];
  el.innerHTML = `<span class="bn-dot${open.length ? ' on' : off ? ' wait' : ''}"></span><span class="bn-main"><b>Общий бот</b> ${now}</span>`
    + (last ? `<span class="bn-last faint">последняя сделка: ${pair(last.sym)} · ${last.reason} · <span class="${cl(last.pnl)}">${usd(last.pnl)}</span> · ${dur(Date.now() - last.tclose)} назад</span>` : '')
    + '<span class="bn-go">Журнал →</span>';
  el.classList.remove('hidden');
}
// the regime the shared bot trades by: the one its last run kept (bot_state.regime, measured on its own timeframe), else the same
// measurement made here. Before 2.34 this read the 1h regime, while the bot itself trades by its 4h one
function sharedReg(redraw) {
  const s = {...SJ.settings, regimeSrc:SJ.settings.regimeSrc || 'majors'};
  if (SJ.regime?.state && SJ.regime.tf === s.tf) return SJ.regime.state;
  const m = regNow(s.tf, redraw);
  return m ? M.regimeOf(m, s) : null;
}
// the same "why isn't it trading" for the shared bot: its rules often wait for a flat market, and silence looks like a breakdown
// «Бот ждёт» with the measure itself: ER of BTC, ETH and SOL over 7 days against the border of the rules. The market is a flat
// when all three are below it (BTC alone for rules tested on BTC); the bars show how far it is from turning, so a bot waiting
// for days reads as waiting, not as broken. by: {BTCUSDT: {er, ch}, …} of the timeframe the rules trade on
function erScale(by, s) {
  const thr = s.erMax ?? 0.15, syms = s.regimeSrc === 'btc' ? ['BTCUSDT'] : M.MAJORS;
  if (!syms.every(x => isFinite(by?.[x]?.er))) return '';
  const max = Math.max(0.5, thr * 2, ...syms.map(x => by[x].er)), pc = v => (v / max * 100).toFixed(1) + '%';
  return `<div class="erscale"${firstShow(`er-${syms.length}-${thr}`)} title="ER — насколько прямо шла цена за 7 дней: около 0 — ходит туда-сюда (боковик), около 1 — идёт в одну сторону (импульс). Черта — граница правил: ${thr}">`
    + syms.map(x => `<div class="er-row"><span>${base(x)}</span><span class="er-bar"><i class="${by[x].er >= thr ? 'over' : ''}" style="width:${pc(by[x].er)}"></i><b style="left:${pc(thr)}"></b></span><span>${by[x].er.toFixed(2)}</span></div>`).join('')
    + `<div class="er-note">Боковик — когда ${syms.length > 1 ? 'у всех трёх' : 'у BTC'} ER ниже черты (${thr}).</div></div>`;
}
function sharedIdle() {
  if (!SJ?.checked) return '';
  const s = {...SJ.settings, regimeSrc:SJ.settings.regimeSrc || 'majors'};
  const reg = sharedReg(() => renderJournal()), open = SJ.open || [], slots = M.slotsOf(s);
  if (open.length >= slots) return `<div class="bh-why"><b>Заняты все места: ${open.length} из ${slots}.</b> Новую сделку бот откроет, когда закроется одна из текущих.</div>`;
  const only = s.regimeOnly || (s.flatOnly ? 'flat' : 'any');
  if (reg && ((only === 'flat' && reg !== 'flat') || (only === 'impulse' && reg === 'flat') || (s.strategy === 'switch' && reg === 'down')))
    return `<div class="bh-why"><b>Бот ждёт:</b> ${only === 'flat' ? `он торгует только в боковике, а сейчас ${regPlain(reg)}` : only === 'impulse' ? 'он торгует только в импульсе, а сейчас боковик' : 'в падающем рынке он в сделки не входит'}. Новых сделок не будет, пока рынок не сменится — так правила и задуманы.${SJ.regime?.tf === s.tf ? erScale(SJ.regime.by, s) : ''}</div>`;
  const last = (SJ.closed || []).reduce((m, x) => Math.max(m, x.tclose || 0), 0);
  if (!open.length && (!last || Date.now() - last > 6 * 36e5))
    return `<div class="bh-why"><b>Подходящих сигналов пока нет.</b> Бот смотрит на ${TF_PLAIN[s.tf] || s.tf} и входит только по подтверждённым разворотам с силой от ${s.minScore}.</div>`;
  return '';
}
function idleReason(act, reg, srv) {
  const D = srv ? SB_MINE : J;
  if (!D?.checked) return '';
  const open = D.open || [], closed = D.closed || [], slots = M.slotsOf(profSet(act));
  if (open.length >= slots) return `<div class="bh-why"><b>Заняты все места: ${open.length} из ${slots}.</b> Новую сделку бот откроет, когда закроется одна из текущих.</div>`;
  if (reg && !allowsReg(act, reg)) {
    const s = profSet(act), now = regPlain(reg);
    const text = s.regimeOnly === 'flat' ? `профиль «${act.name}» торгует только в боковике, а сейчас ${now}`
      : s.regimeOnly === 'impulse' ? `профиль «${act.name}» торгует только в импульсе, а сейчас боковик`
      : `в падающем рынке профиль «${act.name}» в сделки не входит`;
    // another profile that would trade now — judged by the regime of its own timeframe with its own border and source (known
    // once measured; the same timeframe is not enough, a profile can have its own border)
    const same = sp => sp.tf === s.tf && sp.erMax === s.erMax && sp.regimeSrc === s.regimeSrc;
    const regOf = p => { const sp = profSet(p), m = regNow(sp.tf, renderBotPanel); return m ? M.regimeOf(m, sp) : same(sp) ? reg : null; };
    const alt = BP.profiles.find(p => p.id !== act.id && regOf(p) && allowsReg(p, regOf(p)));
    let acts = '';
    if (alt && BP.mode === 'auto') acts = `<button data-act="slot:${reg === 'flat' ? 'flat' : 'impulse'}:${alt.id}">Брать «${alt.name}» в ${reg === 'flat' ? 'боковике' : 'импульсе'}</button>`;
    else if (alt) {
      acts = `<button data-act="use:${alt.id}">Торговать по «${alt.name}»</button>`;
      if (s.regimeOnly === 'flat') acts += `<button data-act="auto:${act.id}:${alt.id}">Авто: «${act.name}» в боковике, «${alt.name}» в импульсе</button>`;
      if (s.regimeOnly === 'impulse') acts += `<button data-act="auto:${alt.id}:${act.id}">Авто: «${alt.name}» в боковике, «${act.name}» в импульсе</button>`;
    }
    return `<div class="bh-why"><b>Бот ждёт:</b> ${text}. Новых сделок не будет, пока рынок не сменится — так профиль и задуман.${erScale(regNow(s.tf, renderBotPanel)?.by, s)}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
  }
  const last = closed.reduce((m, x) => Math.max(m, x.tclose || 0), 0);
  if (!open.length && (!last || Date.now() - last > 6 * 36e5))
    return `<div class="bh-why"><b>Подходящих сигналов пока нет.</b> Профиль смотрит на ${TF_PLAIN[profSet(act).tf] || profSet(act).tf} и входит только по подтверждённым разворотам с силой от ${profSet(act).minScore} — такие бывают не каждый час. ${last ? `Последняя сделка закрылась ${ago(Date.now() - last)} назад.` : 'Сделок ещё не было.'}
      <div class="acts"><button data-act="mkt:${act.id}">Показать рынок глазами профиля</button></div></div>`;
  return '';
}
let bprofInit = false;
// ---------- Telegram: the shared bot's trades for anyone (/start); my bot's trades and signals once it is linked ----------
let tgBot;   // the Telegram bot's username, or null when the owner hasn't set it up
const tgName = async () => tgBot !== undefined ? tgBot : (tgBot = await rpc('tg_bot_name', {}).catch(() => null) || null);
// what the linked chat gets (user_bots.alerts, edited here and in the Telegram menu): the bot's own signals, by its rules, on its
// coins or a wider top for trading by hand; "Рынок" — a separate filter whose channel settings are saved only on request.
// Read by alertsView (supabase/functions/_shared/alerts.js), the same copy the menu and the bot use.
// Only the changed part is sent ({sig:{when:'touch'}}…): the database merges it into what is stored and returns the result
// (ub_alerts, supabase/2026-11-alerts-parts.sql). A whole copy from SB_MINE — up to a minute old — would undo a change made in
// the Telegram menu meanwhile. The owner's time zone goes with every save, so quiet hours are counted in their time.
// msg(view of what is now saved) → the toast's text.
// Saves go one after another: two at once could answer out of order, and the older answer would redraw the field back.
// alertsAt (next to SB_MINE) — when the last answer came: a ub_get poll sent before it has an older value (fetchServerBot keeps this one)
const saveAlerts = (part, msg) => alertsQ = alertsQ.then(async () => {
  // the zone's name follows summer time; the offset alone (tz) stays an hour off after the clocks change. tz is kept as a fallback
  let zone = null; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch {}
  part = {...part, quiet:{...(part.quiet || {}), tz:-new Date().getTimezoneOffset(), ...(zone ? {zone} : {})}};
  try {
    const a = await rpc('ub_alerts', ubArgs({p_alerts:part}));
    if (a && typeof a === 'object' && SB_MINE) { SB_MINE.alerts = a; alertsAt = Date.now(); }
    keepFocus(renderTg); toast('Сохранено', msg(alertsView(SB_MINE?.alerts)), 'ok');
  } catch (e) { toast('Не удалось сохранить', String(e.message || e), 'bad'); keepFocus(renderTg); }
}).catch(() => {});   // a throw outside the try must not leave the queue rejected: every later save would be skipped silently
// one plain sentence about what will come, for the current choice
function alertsHint(v) {
  if (!v.sig.on) return 'Сигналы бота выключены — приходят только его сделки.';
  const coins = v.sig.top ? `по топ-${v.sig.top} монет (бот входит только по своим — в остальных сигналах написано «✋ для ручной торговли»)` : 'по монетам, на которых торгует бот';
  const when = v.sig.when === 'touch' ? 'сразу при касании границы, а о подтверждении придёт короткий ответ' : 'когда разворот подтвердится — в тот же момент входит и бот';
  return `Сигнал придёт ${when}, ${coins}${v.sig.long ? ', только LONG' : ''}. Одна монета — одно сообщение: дальше оно обновляется.`;
}
const hourLabel = h => String(h).padStart(2, '0') + ':00';
function renderTg() {
  const el = $('#btg'); if (!el) return;
  const srv = BP.where === 'server' && UB, linked = srv && SB_MINE?.tg;
  const who = `Telegram, через который вы вошли${ME?.tg_username ? ` (@${esc(ME.tg_username)})` : ''}`;
  const text = !srv ? 'Бот присылает сделки и сигналы, только когда работает на сервере 24/7.'
    : linked ? `Включено: сделки бота приходят в ${who} всегда, сигналы — по настройкам ниже (их же можно менять в Telegram, «🔔 Уведомления»).`
    : `Выключено. Включите — сделки и сигналы бота профиля будут приходить в ${who}.`;
  let set = '';
  if (linked) {
    const S = hooks.S();
    const v = alertsView(SB_MINE?.alerts), opt = (vals, cur) => vals.map(([k, t]) => `<option value="${k}"${String(cur) === String(k) ? ' selected' : ''}>${t}</option>`).join(''), m = v.mkt;
    const hours = Array.from({length:24}, (_, h) => [h, hourLabel(h)]), now = `${S.tf} · ${S.top} монет · сила от ${Math.max(40, S.minScore || 60)}`;
    set = `<div class="btg-set">
      <label class="fl inl"><input type="checkbox" data-al="on"${v.sig.on ? ' checked' : ''}> Мои сигналы</label>
      <select data-al="top" aria-label="По каким монетам"${v.sig.on ? '' : ' disabled'}>${opt(AL_TOPS.map(n => [n, n ? `топ-${n} (для ручной торговли)` : 'монеты бота']), v.sig.top)}</select>
      <select data-al="when" aria-label="Когда присылать"${v.sig.on ? '' : ' disabled'}>${opt([['confirmed', 'только подтверждённые'], ['touch', 'сразу при касании']], v.sig.when)}</select>
      <select data-al="sides" aria-label="Стороны"${v.sig.on ? '' : ' disabled'}>${opt([['both', 'LONG и SHORT'], ['long', 'только LONG']], v.sig.long ? 'long' : 'both')}</select>
    </div><p class="btg-hint">${alertsHint(v)}</p><div class="btg-set">
      ${m ? `<label class="fl inl"><input type="checkbox" data-al="mkt"${m.on ? ' checked' : ''}> Рынок: ${esc(m.tf)} · топ-${m.top} · сила от ${m.minScore}</label>` : '<span>Рынок: не настроен</span>'}
      <button data-tg="mkt" title="Отдельный фильтр со своими настройками канала, только подтверждённые развороты. Сохраняется то, что сейчас выбрано на странице «Рынок»; дальше сайт эти настройки не трогает">${m ? 'Заменить' : 'Сохранить'}: ${esc(now)}</button>
    </div><div class="btg-set">
      <label class="fl inl"><input type="checkbox" data-al="quiet"${v.quiet.on ? ' checked' : ''}> 🌙 Ночью без звука</label>
      <select data-al="qfrom" aria-label="С"${v.quiet.on ? '' : ' disabled'}>${opt(hours, v.quiet.from)}</select>–<select data-al="qto" aria-label="До"${v.quiet.on ? '' : ' disabled'}>${opt(hours, v.quiet.to)}</select>
      <span>сообщения приходят, но беззвучно</span>
    </div>`;
  }
  el.innerHTML = `<span class="btg-i"><svg class="i"><use href="#i-bell"/></svg></span><div style="min-width:0;flex:1"><b>Telegram</b><p>${text}</p>${set}</div>${
    !srv ? '<button data-tg="server">Перевести на сервер</button>' : linked ? '<button data-tg="off">Выключить</button>' : '<button data-tg="on" class="primary">Включить Telegram</button>'}`;
}
function renderBotPanel() { return keepFocus(renderBotPanelNow); }
function renderBotPanelNow() {
  renderTg();
  $('#bER').value = String(BP.erMax);
  document.querySelectorAll('#bmode .tab').forEach(b => b.classList.toggle('on', b.dataset.m === BP.mode));
  document.querySelectorAll('#bwhere .tab').forEach(b => b.classList.toggle('on', b.dataset.w === BP.where));
  $('#bdelOpt').classList.toggle('hidden', !UB);
  const srv = BP.where === 'server', act = srv && SB_MINE?.profile ? (BP.profiles.find(p => p.name === SB_MINE.profile) || activeProfile()) : activeProfile();
  const on = srv && SB_MINE ? SB_MINE.on : J.on;
  if (srv && SB_MINE?.regime?.by) botRegime = {...M.marketOf(s => SB_MINE.regime.by[s] || null), by:SB_MINE.regime.by};
  const reg = botRegime ? M.regimeOf(botRegime, {erMax:BP.erMax, regimeSrc:'majors'}) : null;   // "the market now", 1h
  // what the profile trades by: the regime of its own timeframe with its own border (the server keeps it in regime.trade)
  const sAct = profSet(act), tr = srv && SB_MINE?.regime?.trade?.tf === sAct.tf ? SB_MINE.regime.trade : null;
  const regT = tr?.state || (m => m ? M.regimeOf(m, sAct) : null)(regNow(sAct.tf, renderBotPanel));
  // status card: one sentence about what is happening + one main button
  const checked = srv ? SB_MINE?.checked : J.checked;
  const title = !on ? 'Бот на паузе' : srv ? 'Бот торгует 24/7' : 'Бот торгует в этой вкладке';
  const chg = ` <button class="linkbtn" data-act="prof">сменить</button>`;
  const sub = !on ? `Новых сделок не открывает. Профиль «${act.name}»${chg}.`
    : srv ? `На сервере, даже когда сайт закрыт · профиль «${act.name}»${chg}`
    : `Профиль «${act.name}»${chg}. Если закрыть вкладку, бот остановится. Журнал в браузере — только на этом устройстве.`;
  const live = on ? `<div style="margin-top:6px">${liveTag(checked, 3 * 60e3, 'проверка рынка')}</div>` : '';
  const why = on ? idleReason(act, regT, srv) : '';
  const ers = botRegime ? M.MAJORS.map(s => `${base(s)} ${botRegime.by?.[s] ? botRegime.by[s].er.toFixed(2) : '—'}`).join(', ') : '';
  // the profile decides by its own timeframe, border and source: when they differ from the line above, say what it sees
  const usesReg = sAct.strategy === 'switch' || (sAct.regimeOnly || 'any') !== 'any';
  const notes = [sAct.erMax !== BP.erMax ? `боковик — при ER < ${sAct.erMax}` : '', sAct.regimeSrc === 'btc' ? 'режим — по BTC' : ''].filter(Boolean);
  const own = usesReg && regT && (sAct.tf !== '1h' || notes.length)
    ? ` Профиль «${act.name}» решает по ${TF_BY[sAct.tf] || sAct.tf}${notes.length ? ` (${notes.join(', ')})` : ''}: там <b>${regPlain(regT)}</b>.` : '';
  const market = reg ? `<div class="bh-m" title="ER за 7 дней по часовым свечам: ${ers}. Боковик — когда у всех трёх меньше ${BP.erMax}">Рынок сейчас: <b>${regPlain(reg)}</b> — ${reg === 'flat' ? 'BTC, ETH и SOL ходят в коридоре' : 'крупные монеты в сильном движении'}.${BP.mode === 'auto' ? ` Поэтому бот взял профиль «${act.name}».` : ''}${own}</div>` : '';
  const btns = !on ? `<button class="primary" data-act="on">Продолжить торговлю</button>`
    : srv ? `<button data-act="off">Поставить на паузу</button>`
    : `<button class="primary" data-act="server">Запустить на сервере 24/7</button><button data-act="off">Пауза</button>`;
  $('#bhero').className = 'bhero ' + (!on ? 'warn' : srv ? 'ok' : 'warn');
  $('#bhero').innerHTML = `<div style="min-width:0;flex:1 1 360px"><div class="bh-t"><span class="sdot ${!on ? 'idle' : srv ? '' : 'idle'}"></span>${title}</div><div class="bh-s">${sub}</div>${live}${market}
    ${srv && SB_MINE?.error ? `<div class="bh-err">Ошибка на сервере: ${esc(SB_MINE.error)}</div>` : ''}${why}</div><div class="bh-a">${btns}</div>`;
  tickLive();
  // profile picker: a folded row once there are trades to look at (open while there are none); the user's choice is remembered
  const D0 = srv ? SB_MINE : J;
  $('#bprofSum').textContent = `· сейчас «${act.name}»${BP.mode === 'auto' ? ' · автоматически по рынку' : ''} · всего ${BP.profiles.length}`;
  if (!bprofInit && (D0 || !srv)) { bprofInit = Date.now(); $('#bprof').open = load('sr_bprof', null) ?? !(D0?.closed?.length); }
  $('#bhint').textContent = BP.mode === 'auto'
    ? 'Бот сам смотрит на рынок и меняет профиль. Отметьте, какой профиль брать в боковике, а какой — в импульсе.'
    : 'Бот торгует только по выбранному профилю, что бы ни происходило на рынке. Нажмите на профиль, чтобы выбрать его.';
  const auto = BP.mode === 'auto';
  $('#blist').innerHTML = BP.profiles.map(p => {
    const isAct = p.id === act.id;
    const roles = auto ? `<div class="roles"><button class="chipb${BP.flat === p.id ? ' on' : ''}" data-role="flat" data-id="${p.id}">${BP.flat === p.id ? '✓ ' : ''}для боковика</button><button class="chipb${BP.impulse === p.id ? ' on' : ''}" data-role="impulse" data-id="${p.id}">${BP.impulse === p.id ? '✓ ' : ''}для импульса</button></div>` : '';
    return `<div class="prof${auto ? '' : ' pick'}${isAct ? ' on' : ''}" data-pick="${p.id}"${auto ? '' : ` role="radio" tabindex="0" aria-checked="${isAct}"`}>
      ${auto ? '' : '<span class="radio"></span>'}
      <div style="min-width:0;flex:1"><b>${p.name}</b>${isAct ? ` <span class="tag sq">${on ? 'торгует сейчас' : 'выбран'}</span>` : ''}${presetTag(p)}
        <div class="pplain">${profPlain(p)}</div><div class="ptech">${profSummary(p)}</div>${roles}</div>
      <div class="pa"><button data-pb="${p.id}" title="Перенести настройки профиля в бэктест и проверить их на истории">В бэктест</button><button data-pe="${p.id}">Изменить</button><button data-ps="${p.id}" title="Скопировать ссылку на этот профиль, чтобы отправить другу">Поделиться</button><button data-pd="${p.id}"${BP.profiles.length < 2 ? ' disabled' : ''} aria-label="Удалить профиль ${p.name}">Удалить</button></div></div>`; }).join('');
}
function openForm(p) {
  editId = p?.id || null; const s = {...PROFILE_DEF, ...(p?.set || {})};
  $('#bformTitle').textContent = p ? `Профиль «${p.name}»` : 'Новый профиль';
  $('#pfName').value = p?.name || 'Мой профиль';
  $('#pfCoins').value = p?.coins.mode === 'list' ? 'list' : String(p?.coins.top || 150);
  $('#pfList').value = p?.coins.mode === 'list' ? p.coins.list.map(base).join(', ') : '';
  $('#pfListL').classList.toggle('hidden', $('#pfCoins').value !== 'list');
  hlOpts('#pfHL', s.tf);
  $('#pfTf').value = s.tf; $('#pfMethod').value = s.method; $('#pfN').value = s.N; $('#pfK').value = s.k; $('#pfStrat').value = s.strategy; $('#pfMin').value = s.minScore;
  $('#pfRR').value = String(s.rr); $('#pfRisk').value = String(Math.round(s.risk * 1000) / 10); $('#pfLev').value = String(s.lev);
  $('#pfW').value = String(s.minWidth); $('#pfHL').value = String(s.maxHL); $('#pfCoinER').value = String(s.coinErMax); $('#pfLong').checked = !!s.longOnly; $('#pfComp').checked = !s.fixedRisk; $('#pfReg').value = s.regimeOnly || 'any'; $('#pfTS').value = String(s.timeStop ?? 48); $('#pfSlots').value = String(M.slotsOf(s));
  $('#bform').classList.remove('hidden'); $('#bform').scrollIntoView({block:'nearest', behavior:'smooth'});
  formBase = formState(); syncSavebar();
  if (!isPhone()) setTimeout(() => { $('#pfName').focus({preventScroll:true}); $('#pfName').select(); }, 0);   // on a phone the keyboard would cover the form
}
function saveForm() {
  const listMode = $('#pfCoins').value === 'list', list = parseCoins($('#pfList').value);
  if (listMode && !list.length) { toast('Впишите монеты', 'например: BTC, ETH, SOL', 'warn'); return; }
  const p = {id:editId || 'p' + Date.now(), name:cleanName($('#pfName').value),
    coins:listMode ? {mode:'list', list} : {mode:'top', top:+$('#pfCoins').value},
    set:{method:$('#pfMethod').value, N:clamp(+$('#pfN').value || 210, 20, 300), k:clamp(+$('#pfK').value || 3, 1, 5), tf:$('#pfTf').value,
         minScore:clamp(+$('#pfMin').value || 0, 0, 100), strategy:$('#pfStrat').value, rr:+$('#pfRR').value || 0, risk:(+$('#pfRisk').value || 2) / 100,
         lev:+$('#pfLev').value || 1, minWidth:+$('#pfW').value || 0, maxHL:+$('#pfHL').value || 0, coinErMax:+$('#pfCoinER').value || 0, longOnly:$('#pfLong').checked,
         regimeOnly:$('#pfReg').value, timeStop:+$('#pfTS').value, maxOpen:+$('#pfSlots').value || 3, ...($('#pfComp').checked ? {} : {fixedRisk:true})}};
  const i = BP.profiles.findIndex(x => x.id === p.id);
  // the profile's own flat / impulse border and regime source (from a preset, a link or a saved backtest) are not in the form:
  // they stay as they were
  if (i >= 0 && BP.profiles[i].set?.erMax != null) p.set.erMax = BP.profiles[i].set.erMax;
  if (i >= 0 && BP.profiles[i].set?.regimeSrc === 'btc') p.set.regimeSrc = 'btc';
  if (i >= 0) BP.profiles[i] = p; else BP.profiles.push(p);
  formBase = null; syncSavebar();
  saveBP(); $('#bform').classList.add('hidden'); renderBotPanel(); renderJournal(); syncServerBot();
  document.querySelector(`#blist [data-pick="${p.id}"]`)?.focus({preventScroll:true});   // the focus was on the form that just closed
  toast(`Профиль «${p.name}» сохранён`, i >= 0 ? 'изменения применятся со следующей проверки рынка' : 'нажмите на него в списке профилей, чтобы бот торговал по нему', 'ok');
}

// ---------- shared bot (read-only from Supabase) ----------
async function sb(path) {
  const r = await fetch(SB_URL + path, {headers:{apikey:SB_KEY}, cache:'no-store', signal:AbortSignal.timeout(15000)});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
let sharedErr = '';   // the last failed request for the shared bot's data ('' after a good one)
async function fetchShared() {
  try {
    const [st, open, closed, runs] = await Promise.all([
      sb('bot_state?id=eq.1&select=balance,start_balance,settings,checked_at,last_error,scanned,regime'),
      sb('positions?select=*&order=time.desc'),
      sb('trades?select=*&order=tclose.desc&limit=1000'),
      sb('bot_runs?select=ts,ok,ms,scanned,signals,opened,closed,error&order=ts.desc&limit=240').catch(() => []),
    ]);
    const s = st[0], prev = SJ;
    SJ = {balance:s.balance, start:s.start_balance, settings:s.settings, error:s.last_error, scanned:s.scanned, regime:s.regime || null,
          checked:s.checked_at ? Date.parse(s.checked_at) : 0, open, closed, runs, on:true};
    if (prev) { // tell the user about the shared bot's new trades since the last poll
      const seenO = new Set(prev.open.map(p => p.id)), seenC = new Set(prev.closed.map(t => t.id));
      for (const p of open.filter(p => !seenO.has(p.id))) notifyUser(`Общий бот: ${p.side} ${pair(p.sym)}`, `вход ${fp(p.entry)} · тейк ${fp(p.tp)} · стоп ${fp(p.sl)}`, 'info', () => openJournal('shared'));
      for (const t of closed.filter(t => !seenC.has(t.id))) notifyUser(`Общий бот: ${pair(t.sym)} закрыта — ${t.reason}`, `${usd(t.pnl)} (${rr(t.r)})`, t.pnl > 0 ? 'ok' : 'bad', () => openJournal('shared'));
    }
    sharedErr = '';
  } catch (e) { sharedErr = String(e.message || e); if (SJ) SJ.fetchError = sharedErr; }   // kept and said (renderGuard), not swallowed
  renderGuard(); renderBotNow(); renderAway();
  if (!$('#journal').classList.contains('hidden')) renderJournal();
  if (hooks.chart()) { drawChart(); renderDetail(); }
}
function renderGuard() {
  const el = $('#guard'), MD = BP.where === 'server' ? SB_MINE : J, mine = MD ? M.journalStats(baseOf(MD), MD.closed) : null;
  const mineTxt = MD ? `Мой бот (${BP.where === 'server' ? 'на сервере' : 'в этой вкладке'}): ${MD.on ? 'торгует' : 'на паузе'}, позиций ${MD.open.length}, за 24 ч ${usd(mine.pnl24)}`
      + (MD.fetchError ? ` · не удалось обновить, показано состояние ${MD.checked ? ago(Date.now() - MD.checked) + ' назад' : 'с прошлой загрузки'}` : '')
      + (BP.where !== 'server' && botErr ? ` · последняя проверка рынка не удалась: ${esc(botErr)}` : '')
    : 'Мой бот: загружаю…';
  const open = el.classList.contains('open') ? ' open' : '';
  // with all well only a dot is shown, so the words go to the tooltip and to screen readers
  const pill = (state, txt) => { const b = $('#guardPill'); b.className = 'pill ' + state; $('#guardTxt').textContent = txt; b.title = txt + ' — подробности'; b.setAttribute('aria-label', txt + ' — подробности'); };
  if (!SJ) {
    el.className = 'guard idle' + open;
    el.innerHTML = `<b class="guard-heading">Работа ботов</b><p class="guard-message">${sharedErr ? `Нет связи с сервером, пробуем снова. ${esc(sharedErr.slice(0, 90))}` : 'Получаем данные общего бота…'}</p><div class="guard-bot"><span>${mineTxt}</span></div>`;
    pill(sharedErr ? 'idle' : 'idle load', sharedErr ? 'Нет связи с сервером' : 'Загрузка…'); return;   // loading stays a dot: the header doesn't jump
  }
  const age = Date.now() - SJ.checked, s = M.journalStats(SJ.start, SJ.closed);
  const ok = [...SJ.open, ...myOpen()].every(p => isFinite(p.tp) && isFinite(p.sl));
  const stale = age > 5 * 60000;
  // our own request failed: what is shown is the last good data, and "the bot is not answering" would blame the wrong side
  const netErr = SJ.fetchError;
  const state = !ok ? 'bad' : netErr ? 'idle' : stale ? 'bad' : SJ.error ? 'idle' : 'ok';
  el.className = 'guard' + (state === 'ok' ? '' : ' ' + state) + open;
  const msg = !ok ? 'У позиции нет тейка или стопа. Проверьте защиту сделки.'
    : netErr ? `Не удалось обновить данные с сервера (${esc(netErr.slice(0, 90))}): показано состояние ${ago(age)} назад, пробую снова.`
    : stale ? `Общий бот не отвечает уже ${dur(age)}.` : SJ.error ? `Общий бот работает с ошибкой: ${esc(SJ.error)}` : 'Общий бот работает 24/7, у всех позиций есть тейк и стоп.';
  el.innerHTML = `<b class="guard-heading">${state === 'ok' ? 'Боты работают' : 'Нужно внимание'}</b><p class="guard-message">${msg}</p>
    <div class="guard-bot"><b>Общий бот</b><span>Проверка рынка ${SJ.checked ? ago(age) + ' назад' : '—'}</span><span>Открыто позиций: ${SJ.open.length} · Итог за 24 ч: ${usd(s.pnl24)}</span></div><div class="guard-bot"><span>${mineTxt}</span></div>`;
  pill(state, state === 'ok' ? `Общий бот · ${SJ.open.length} поз.` : state === 'bad' ? (ok ? 'Бот не отвечает' : 'Нет тейка или стопа') : netErr ? 'Нет связи с сервером' : 'Ошибка бота');
}

// server health of the shared bot: one cell per minute for the last 2 hours
function renderServer() {
  const el = $('#srv');
  el.classList.toggle('hidden', jMode !== 'shared' || !SJ);
  if (jMode !== 'shared' || !SJ) return;
  const runs = SJ.runs || [], byMin = new Map(runs.map(r => [Math.floor(Date.parse(r.ts) / 6e4), r]));
  const nowMin = Math.floor(Date.now() / 6e4), cells = [];
  for (let m = nowMin - 119; m <= nowMin; m++) {
    const r = byMin.get(m);
    // amber: the run went fine, but the collector did not answer and the bot computed everything itself (its note is in `error`)
    cells.push(`<i class="${r ? (r.ok ? (r.error ? 'warn' : 'ok') : 'err') : ''}" title="${new Date(m * 6e4).toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit'})} — ${r ? (r.ok ? `ок, ${r.ms} мс, пар ${r.scanned}, сигналов ${r.signals}${r.error ? ' · ' + esc(r.error) + ', бот посчитал сам' : ''}` : 'ошибка: ' + esc(r.error)) : 'нет прогона'}"></i>`);
  }
  const win = runs.filter(r => Date.now() - Date.parse(r.ts) < 4 * 36e5);
  const okN = win.filter(r => r.ok).length, expected = Math.min(240, Math.max(1, Math.round((Date.now() - (runs.length ? Date.parse(runs[runs.length - 1].ts) : Date.now())) / 6e4) + 1));
  const avgMs = okN ? win.filter(r => r.ok).reduce((a, r) => a + r.ms, 0) / okN : null;
  const lastErr = runs.find(r => !r.ok), noColl = win.filter(r => r.ok && r.error).length;
  const share = okN / expected * 100, st = share >= 95 ? '' : share >= 80 ? 'idle' : 'bad';
  const wasOpen = el.querySelector('details')?.open ? ' open' : '';
  el.innerHTML = `<details class="dis"${wasOpen}><summary><span class="sdot ${st}"></span>${st ? 'Сервер работает с перебоями' : 'Сервер работает'} <span class="mute">· ${share.toFixed(0)}% проверок успешны за 4 часа</span></summary>
    <div class="dbody"><div class="mute" style="font-size:12px">Каждая клетка — одна минута за последние 2 часа: зелёная — проверка рынка прошла, жёлтая — прошла, но коллектор не ответил и бот посчитал всё сам (дольше, но так же), красная — ошибка, серая — проверки не было.</div>
    <div class="strip">${cells.join('')}</div>
    <div class="mute" style="font-size:12px">${okN} из ${expected} проверок · в среднем ${avgMs == null ? '—' : (avgMs / 1000).toFixed(1) + ' с'} ·
      ${lastErr ? `последняя ошибка ${dt(Date.parse(lastErr.ts))}: <span class="neg">${esc(lastErr.error)}</span>` : 'ошибок нет'}${noColl ? ` · без коллектора: ${noColl}` : ''}</div></div></details>`;
}
// close my bot's positions by hand (one, or all with id = null), at market with the usual fee and slippage.
// In the browser it happens at once; on the server the positions are marked and the bot closes them on its next run (within a minute)
async function closeMine(id) {
  const open = myOpen().filter(p => !p.closeReq && (id == null || p.id === id)); if (!open.length) return;
  const what = id == null ? `все ${open.length} ${plural(open.length, ['позицию', 'позиции', 'позиций'])}` : `${open[0].side} ${pair(open[0].sym)}`;
  // the receipt: what closing locks in, the same estimate as the «PnL сейчас» column
  const est = open.reduce((a, p) => { const {u, risk} = openPnl(p); return {u:a.u + u, risk:a.risk + risk}; }, {u:0, risk:0});
  const at = id == null ? '' : ` по цене ${fp(open[0].last ?? open[0].entry)}`;
  const text = `Сейчас это ≈ ${usd(est.u)}${est.risk && id != null ? ` (${rr(est.u / est.risk)})` : ''} после комиссии${at}; итог — по цене в момент закрытия и с проскальзыванием. Бот не будет входить в ${id == null ? 'эти монеты' : 'эту монету'}, пока не пройдёт пауза после сделки.`;
  if (!(await ask({title:`Закрыть ${what}?`, text, ok:'Закрыть', danger:true}))) return;
  if (BP.where === 'server' && UB) {
    try { await rpc('ub_close', ubArgs({p_pos:id})); }
    catch (e) { const m = String(e.message || e); toast('Не удалось закрыть', rpcIs(e, /ub_close|PGRST202|Could not find/) ? 'Закрытие позиций на сервере ещё не включено — скоро заработает. В браузерном режиме уже работает.' : m, 'bad'); return; }
    for (const p of open) p.closeReq = true;
    renderJournal(); toast(id == null ? 'Позиции закрываются' : 'Позиция закрывается', 'Бот на сервере закроет по рынку в течение минуты.', 'info');
    setTimeout(fetchServerBot, 65e3); return;
  }
  const now = Date.now(); let net = 0, done = 0, noPrice = 0;
  for (const p0 of open) {
    let px; try { px = +(await api(`/api/v3/ticker/price?symbol=${p0.sym}`)).price; } catch {}
    if (!(px > 0)) { noPrice++; if (id != null) toast(`Нет цены ${pair(p0.sym)}`, 'Позиция осталась открытой — попробуйте ещё раз.', 'bad'); continue; }
    // the bot may have run while the confirmation was open or the price was loading: it may have closed this position by its
    // stop or take already. Closing the old copy again recorded a second trade and counted its P&L twice.
    // Read from storage: the bot may have stepped in another tab (see runBot)
    J = load('sr_journal', J);
    const p = J.open.find(x => x.id === p0.id); if (!p) continue;
    const t = M.closeTrade(p, px * (1 - (p.side === 'LONG' ? 1 : -1) * M.SLIP), 'вручную', now);
    J.open = J.open.filter(x => x.id !== p.id); J.closed = [t, ...J.closed]; capJournal(); J.balance += t.pnl; net += t.pnl; done++;
  }
  save('sr_journal', J); renderJournal(); renderBotPanel(); renderGuard();
  // said as it went: «закрыты» only when all were, otherwise how many and why the rest stayed open (no price from Binance)
  if (!done) { if (id == null) toast('Позиции не закрыты', 'Binance не отдал цену — проверьте связь и попробуйте ещё раз.', 'bad'); return; }
  if (noPrice) toast(`Закрыто ${done} из ${open.length}`, `итог ${usd(net)} · по ${noPrice} ${plural(noPrice, ['монете', 'монетам', 'монетам'])} нет цены — они остались открытыми, попробуйте ещё раз`, 'warn');
  else toast(done > 1 ? 'Позиции закрыты' : 'Позиция закрыта', `итог ${usd(net)}`, net > 0 ? 'ok' : net < 0 ? 'bad' : 'info');
}

// ---------- profile form: unsaved changes ----------
// The save row turns into a sticky bar once something changed; Ctrl+S saves; leaving or cancelling asks first.
const formState = () => [...$('#bform').querySelectorAll('input, select')].map(x => x.type === 'checkbox' ? x.checked : x.value).join('|');
let formBase = null;
const formDirty = () => formBase != null && !$('#bform').classList.contains('hidden') && formState() !== formBase;
function syncSavebar() { const d = formDirty(); $('#pfBar').classList.toggle('dirty', d); $('#pfBarT').textContent = d ? 'Есть несохранённые изменения' : ''; }
// main button of the status card: pause / resume / move to the server
const setOn = v => { J.on = v; save('sr_journal', J); if (SB_MINE) SB_MINE.on = v; renderGuard(); renderBotPanel(); syncServerBot(v); };
const pickProfile = id => { if (BP.active === id && BP.mode === 'single') return; BP.active = id; BP.mode = 'single'; saveBP(); renderBotPanel(); renderJournal(); syncServerBot(); runBot();
  toast(`Бот торгует по профилю «${profById(id).name}»`, BP.where === 'server' ? 'сервер подхватит его на следующей проверке — в течение минуты' : 'со следующей проверки рынка', 'ok'); };
// the shared bot's rules as a profile, for showing them and for the backtest
const sharedProf = () => ({name:'Общий бот', coins:{mode:'top', top:SJ.settings.top || 150}, set:{...SJ.settings, erMax:SJ.settings.erMax ?? 0.15}});

function start(h) {
  Object.assign(hooks, h);
window.addEventListener('storage', e => {
  // the browser bot stepped (or a position was closed, the journal reset) in another tab: show that journal here too
  if (e.key === 'sr_journal') {
    if (botBusy) return;   // a step under way re-reads it before it writes
    J = load('sr_journal', J); renderGuard(); renderBotPanel();
    if (!$('#journal').classList.contains('hidden')) renderJournal();
  }
});
$('#pimp').onclick = e => {
  const a = e.target.closest('[data-imp]')?.dataset.imp; if (!a) return;
  if (a === 'add' && pendingImport) {
    const p = {...pendingImport, id:'p' + Date.now()};
    if (BP.profiles.some(x => x.name === p.name)) p.name = cleanName(p.name + ' (копия)');
    BP.profiles.push(p); saveBP(); renderBotPanel(); syncServerBot();
    toast(`Профиль «${p.name}» добавлен`, 'нажмите на него в списке, чтобы бот торговал по нему', 'ok');
  }
  pendingImport = null; $('#pimp').classList.add('hidden');
};
$('#botNow').onclick = () => { jMode = 'shared'; save('sr_jmode', jMode); go('journal'); };
$('#botNow').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#botNow').click(); } };
$('#btg').onchange = e => {
  const f = e.target.closest('[data-al]'); if (!f || !SB_MINE) return;
  const k = f.dataset.al;   // each field sends only itself (saveAlerts)
  if (k === 'mkt') return saveAlerts({mkt:{on:f.checked}}, n => n.mkt?.on ? 'Сигналы «Рынка» включены' : 'Сигналы «Рынка» выключены');
  if (k === 'quiet' || k === 'qfrom' || k === 'qto') {
    return saveAlerts({quiet:k === 'quiet' ? {on:f.checked} : {[k === 'qfrom' ? 'from' : 'to']:+f.value}},
      n => n.quiet.on ? `С ${hourLabel(n.quiet.from)} до ${hourLabel(n.quiet.to)} сообщения придут без звука.` : 'Ночью — со звуком.');
  }
  saveAlerts({sig:k === 'on' ? {on:f.checked} : k === 'top' ? {top:+f.value || 0} : {[k]:f.value}}, alertsHint);
};
$('#btg').onclick = async e => {
  const b = e.target.closest('[data-tg]'); if (!b) return;
  if (b.dataset.tg === 'server') { setWhere('server'); return; }
  if (b.dataset.tg === 'mkt') {   // the "Рынок" page's current channel settings, saved for Telegram until replaced
    const S = hooks.S();
    if (!['5m', '15m', '1h', '4h', '1d'].includes(S.tf)) return toast('Недельный таймфрейм в Telegram не поддерживается', 'выберите на «Рынке» от 5м до 1д', 'warn');
    const m = {on:true, tf:S.tf, top:S.top, minScore:Math.max(40, S.minScore || 60), method:S.method, N:S.N, k:S.k};
    return saveAlerts({mkt:m}, () => `Рынок: ${m.tf} · топ-${m.top} · сила от ${m.minScore}. Дальше эти настройки меняются только этой кнопкой.`);
  }
  // on / off: only the profile's bot writes, and only to the Telegram the person signed in with (its private chat with our bot)
  if (b.dataset.tg === 'on' || b.dataset.tg === 'off') {
    const on = b.dataset.tg === 'on';
    b.disabled = true;
    try {
      await rpc('ub_tg', {p_on:on}); if (SB_MINE) SB_MINE.tg = on; renderTg();
      toast(on ? 'Telegram включён' : 'Telegram выключен', on ? `Сделки и сигналы бота придут в Telegram${ME?.tg_username ? ' @' + ME.tg_username : ''}` : 'Бот продолжает торговать, сообщения не приходят', 'ok');
    } catch (err) { toast(on ? 'Не удалось включить Telegram' : 'Не удалось выключить Telegram', String(err.message || err), 'bad'); }
    finally { b.disabled = false; }
    fetchServerBot();
  }
};
}
function startForm() {
['input', 'change'].forEach(t => $('#bform').addEventListener(t, syncSavebar));
window.addEventListener('beforeunload', e => { if (formDirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS' && !$('#bform').classList.contains('hidden')) { e.preventDefault(); saveForm(); }
});
$('#pfTf').addEventListener('change', () => hlOpts('#pfHL', $('#pfTf').value));
}
function startPanel() {
$('#jcloseAll').onclick = () => closeMine(null);
['#jopen', '#jclosed'].forEach(s => $(s).onclick = e => {
  const cb = e.target.closest('[data-close]'); if (cb) { closeMine(cb.dataset.close); return; }
  const tr = e.target.closest('tr.row'); if (tr) openTrade(tr.dataset.kind, tr.dataset.id);
});
$('#bhero').onclick = e => {
  const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return;
  const [k, x, y] = a.split(':');
  if (k === 'on') setOn(true);
  if (k === 'off') setOn(false);
  if (k === 'server') setWhere('server');
  if (k === 'prof') { $('#bprof').open = true; save('sr_bprof', true); $('#bprof').scrollIntoView({block:'start', behavior:'smooth'}); }
  if (k === 'mkt') {   // the market tab switches to the profile's timeframe and channel, so its signals are the ones the bot weighs
    const S = hooks.S(), ps = profSet(profById(x));
    Object.assign(S, {tf:ps.tf, method:ps.method, N:ps.N, k:ps.k}); save('sr_settings', S); syncInputs();
    go('market'); document.querySelector('#flseg [data-fl=sig]')?.click(); loadChart(); hooks.rescanNow();
    toast(`Рынок показан как у профиля «${profById(x).name}»`, `${ps.tf}, ${METHOD_NAME[ps.method]} ${ps.N}/${ps.k}. Сигнал бот возьмёт при силе от ${ps.minScore}${ps.regimeOnly === 'flat' ? ' и только в боковике' : ps.regimeOnly === 'impulse' ? ' и только в импульсе' : ''}.`, 'info');
  }
  if (k === 'use') pickProfile(x);
  if (k === 'slot') { BP[x] = y; saveBP(); renderBotPanel(); renderJournal(); syncServerBot(); runBot(); toast(`В ${x === 'flat' ? 'боковике' : 'импульсе'} бот берёт «${profById(y).name}»`, '', 'ok'); }
  if (k === 'auto') { Object.assign(BP, {mode:'auto', flat:x, impulse:y}); saveBP(); renderBotPanel(); renderJournal(); syncServerBot(); runBot();
    toast('Бот сам выбирает профиль по рынку', `боковик — «${profById(x).name}», импульс — «${profById(y).name}»`, 'ok'); }
};
document.querySelectorAll('#bwhere .tab').forEach(b => b.onclick = () => setWhere(b.dataset.w));
// my bot: profiles panel
document.querySelectorAll('#bmode .tab').forEach(b => b.onclick = () => { BP.mode = b.dataset.m; saveBP(); renderBotPanel(); renderJournal(); syncServerBot(); runBot(); });
$('#bER').onchange = e => { BP.erMax = +e.target.value; saveBP(); renderBotPanel(); syncServerBot(); runBot(); };
// only the user's own toggles are remembered, not the initial open/close done by renderBotPanel
$('#bprof').addEventListener('toggle', () => { if (bprofInit && Date.now() - bprofInit > 300) save('sr_bprof', $('#bprof').open); });
// «Дополнительно» in «Мой бот» stays open or closed as the user left it (the backtest form's: app/backtest.js)
{ const d = $('.bmore'); d.open = load('sr_bmore', false) === true; d.addEventListener('toggle', () => save('sr_bmore', d.open)); }
$('#bnew').onclick = () => openForm(null);
$('#bimport').onclick = importByLink;
$('#pfCancel').onclick = async () => {
  if (formDirty() && !(await ask({title:'Не сохранять изменения?', text:'Правки в этом профиле пропадут.', ok:'Не сохранять', danger:true}))) return;
  formBase = null; syncSavebar(); $('#bform').classList.add('hidden');
};
$('#pfSave').onclick = saveForm;
// Escape in the form is 'Cancel' (with the same question when something was changed)
$('#bform').addEventListener('keydown', e => { if (e.key === 'Escape' && $('#dlg').classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); $('#pfCancel').click(); } });
$('#pfCoins').onchange = () => $('#pfListL').classList.toggle('hidden', $('#pfCoins').value !== 'list');
$('#blist').onclick = async e => {
  const ed = e.target.closest('[data-pe]'), del = e.target.closest('[data-pd]'), role = e.target.closest('[data-role]'), sh = e.target.closest('[data-ps]');
  if (sh) { shareProfile(profById(sh.dataset.ps)); return; }
  const tb = e.target.closest('[data-pb]'); if (tb) { const p = profById(tb.dataset.pb); profToBacktest(p, p.name); return; }
  if (role) { BP[role.dataset.role] = role.dataset.id; saveBP(); renderBotPanel(); renderJournal(); syncServerBot(); runBot(); return; }
  if (!ed && !del) { const c = e.target.closest('.prof.pick'); if (c) pickProfile(c.dataset.pick); return; }
  if (ed) {
    if (formDirty() && editId !== ed.dataset.pe && !(await ask({title:'Не сохранять изменения?', text:'Правки в открытом профиле пропадут.', ok:'Не сохранять', danger:true}))) return;
    openForm(profById(ed.dataset.pe));
  }
  if (del && BP.profiles.length > 1) {
    const p = profById(del.dataset.pd), next = BP.profiles.find(x => x.id !== p.id);
    const inUse = ['active', 'flat', 'impulse'].some(k => BP[k] === p.id);
    if (!(await ask({title:`Удалить профиль «${p.name}»?`, ok:'Удалить', danger:true,
      text:`Сделки в журнале останутся.${inUse ? ` Бот сейчас использует этот профиль — вместо него возьмёт «${next.name}».` : ''}`}))) return;
    BP.profiles = BP.profiles.filter(x => x.id !== p.id);
    for (const k of ['active', 'flat', 'impulse']) if (BP[k] === p.id) BP[k] = next.id;
    if (editId === p.id) { formBase = null; syncSavebar(); $('#bform').classList.add('hidden'); }   // or saving would bring it back
    saveBP(); renderBotPanel(); renderJournal(); syncServerBot();
  }
};
$('#blist').onkeydown = e => { const c = e.target.closest('.prof.pick'); if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickProfile(c.dataset.pick); } };
// starting over, from any amount: the journal and its percentages begin anew, so the start changes only with a reset
$('#jreset').onclick = async () => {
  const srv = BP.where === 'server' && UB, cur = (srv ? SB_MINE?.start : J.start) || 10000;
  const v = await ask({title:'Начать заново', ok:'Сбросить', danger:true, input:{value:String(Math.round(cur)), inputmode:'numeric'},
    text:`Все сделки ${srv ? 'серверного' : 'вашего'} бота удалятся, профили останутся. Отменить это нельзя. С какой суммы начать, $ (от 100 до 10 000 000):`});
  if (v == null) return;
  const start = Math.round(+String(v).replace(/[\s,]/g, ''));   // «25 000» and «25,000» are 25000
  if (!(start >= 100 && start <= 1e7)) { toast('Сумма — от $100 до $10 000 000', `введено: «${String(v).slice(0, 20)}»`, 'warn'); return; }
  if (srv) {
    try { await rpc('ub_reset', ubArgs({p_start:start})); toast(`Журнал начат заново с $${start.toLocaleString('ru')}`, '', 'ok'); }
    catch (e) { toast('Не удалось сбросить', String(e.message || e), 'bad'); }
    fetchServerBot(); return;
  }
  J = {balance:start, start, open:[], closed:[], on:J.on}; save('sr_journal', J); renderJournal(); renderGuard(); drawChart();
  toast(`Журнал начат заново с $${start.toLocaleString('ru')}`, '', 'ok');
};
// the server copy goes entirely (ub_delete): trades, positions, the Telegram link — for every device of the profile. The profiles
// live here, so the bot carries on in this tab; «На сервере 24/7» later creates a new one
$('#ubdel').onclick = async () => {
  if (!UB) return;
  if (!(await ask({title:'Удалить бота с сервера?', ok:'Удалить', danger:true,
    text:'Серверный бот профиля удалится на всех ваших устройствах: его сделки, позиции и Telegram. Отменить это нельзя. Профили останутся, бот продолжит работать в этой вкладке.'}))) return;
  clearTimeout(syncTimer); ubOn = null;
  try { await rpc('ub_delete', ubArgs()); }
  catch (e) { if (!rpcIs(e, /forbidden/)) { toast('Не удалось удалить', String(e.message || e), 'bad'); return; } }   // forbidden: it is gone already
  botGone();
  renderBotPanel(); renderJournal(); renderGuard();
  toast('Бот удалён с сервера', 'Профили остались, бот работает в этой вкладке', 'ok');
};
}

export {J, SJ, jMode, setJMode, BP, SB_MINE, UB, tgBot, PROFILE_DEF, PRESETS, cleanName, saveBP, profSet, profSummary, profPlain, activeProfile, sharedNoEdge,
  sharedProf, sharedIdle, myOpen, openPnl, pickProfile, parseShared, showImport, importByLink, shareUrl, openForm, formDirty, runBot, syncServerBot, fetchServerBot,
  profileBot, botGone, fetchShared, renderBotPanel, renderGuard, renderServer, tgName, start, startForm, startPanel};
