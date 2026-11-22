// Accounts (docs/PLAN-UNTANGLE-modules.md, wave 1; docs/PLAN-UNTANGLE-accounts.md): the session, the first look at the profile
// (syncEarly, awaited at the top level — every module that reads its settings at load imports this one, so the read waits for
// it), sign-in through the Telegram bot and the profile sync. What ran at load in the page is start(), called by the page at
// the same place as before.
import {$, load, save, toast, ask, esc, sleep, setOnSaved} from './core.js';

// ---------- the session and the first look at the profile (accounts; docs/PLAN-UNTANGLE-accounts.md, fixes 3 and 4) ----------
// Both run before anything below reads its settings: a signed-in page puts the profile's newer values into storage first.
const SB_URL = 'https://aumldylzccbmddavtrqe.supabase.co/rest/v1/', SB_KEY = 'sb_publishable_dJ7vC-wBDBUNT9W1VgwPEg_M0WpHxXB';
const SB_BASE = SB_URL.replace('/rest/v1/', ''), AUTH_URL = SB_BASE + '/auth/v1/', FN_URL = SB_BASE + '/functions/v1/';
let AUTH = load('sr_auth', null), ME = null, authRun = 0, authTimer = 0, authBack = null, refreshing = null;
async function gotrue(path, body, token) {
  const r = await fetch(AUTH_URL + path, {method:'POST', headers:{apikey:SB_KEY, 'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})},
    body:JSON.stringify(body || {}), signal:AbortSignal.timeout(15000)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.msg || j.error_description || j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return j;
}
// A refresh token works once. The tabs of this browser take turns (Web Locks), and a tab that waited takes the tokens the one
// before it got instead of refreshing again — before 2.83 a random moment and a second look made a clash rare, not impossible.
// 'ok' — AUTH is good; 'dead' — the refresh token was refused (signed out elsewhere, too old); 'later' — no connection, or the
// server busy (429, 5xx): the tokens are kept (a 429 used to sign the person out). What follows is the caller's
async function renewTokens() {
  const run = async () => {
    const cur = load('sr_auth', null);
    if (!cur?.rt) return 'dead';   // signed out in another tab
    if (cur.rt !== AUTH?.rt) { AUTH = cur; if (cur.exp - Date.now() > 120e3) return 'ok'; }   // another tab has just renewed them
    try {
      const s = await gotrue('token?grant_type=refresh_token', {refresh_token:cur.rt});
      AUTH = {at:s.access_token, rt:s.refresh_token, exp:Date.now() + (s.expires_in || 3600) * 1000}; save('sr_auth', AUTH);
      return 'ok';
    } catch (e) {
      const now = load('sr_auth', null);   // a browser without Web Locks: another tab renewed with the same token a moment earlier
      if (now?.rt && now.rt !== cur.rt) { AUTH = now; return 'ok'; }
      return [400, 401, 403].includes(e.status) ? 'dead' : 'later';
    }
  };
  try { return navigator.locks?.request ? await navigator.locks.request('sr_auth', run) : await run(); } catch { return 'later'; }
}
// PostgREST as the signed-in person (anonymously when signed out), one way for loadMe, the sync and rpc: a token about to run
// out is renewed first, and a 401 renews it once more and repeats the call
async function authedFetch(url, init = {}) {
  if (AUTH && AUTH.exp - Date.now() < 60e3) await refreshSession();
  const call = () => fetch(url, {...init, headers:{apikey:SB_KEY, 'Content-Type':'application/json', ...(AUTH ? {Authorization:'Bearer ' + AUTH.at} : {})}, signal:AbortSignal.timeout(15000)});
  let r = await call();
  if (r.status === 401 && AUTH) { await refreshSession(); r = await call(); }
  return r;
}
const authUid = () => { try { return JSON.parse(atob(AUTH.at.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } };

// Every browser-storage key, in one place: 'profile' — kept in the profile (user_state), the same on all the person's devices;
// 'device' — stays on this device. A new key goes here with its reason: tests/smoke.js reports a key in storage that isn't
// listed.
const KEYS = {
  // settings, favourites, bot profiles, chart levels, the table's filters and sorting, the Beta's charts, indicators and drawings
  sr_settings:'profile', sr_favs:'profile', sr_bot:'profile', sr_lv:'profile', sr_tfilt:'profile', sr_msort:'profile',
  sr_jsort:'profile', sr_bcfg:'profile', sr_bdraw:'profile', sr_bind:'profile', sr_bpanes:'profile', sr_bchips:'profile',
  sr_blabels:'profile', sr_bvol:'profile', sr_bnotec:'profile', sr_blink:'profile',
  // the lessons marked «пройдено» (renderLearn): written only by that button, so reading lessons sends nothing
  sr_learn:'profile',
  // the session and the sync's own bookkeeping
  sr_auth:'device', sr_sync:'device',
  // the browser bot's journal: two open devices would both trade one journal; the bot for several devices is the server one,
  // and the server knows which is the profile's (see profileBot)
  sr_journal:'device', sr_ubot:'device', sr_ubot_old:'device',
  // change on every open: another device would get a notice each time
  sr_recent:'device', sr_chart:'device', sr_seen:'device', sr_seenv:'device', sr_events:'device', sr_evread:'device',
  // how this screen looks: a phone wants other than a computer (the number of Beta charts, hidden panels, open sections)
  sr_theme:'device', sr_glass:'device', sr_wide:'device', sr_more:'device', sr_bmore:'device', sr_btadv:'device',
  sr_bprof:'device', sr_jmode:'device', sr_blay:'device', sr_bhide:'device', sr_bact:'device', sr_bactph:'device', sr_cmode:'device',
  // this browser's notification permission and sound, the intro, caches, the charts' server override
  sr_ntf:'device', sr_sound:'device', sr_intro:'device', sr_pool:'device', sr_bsrv:'device',
  // how many different backtest settings were tried here (btTries): the correction for trying many is about this person's search
  sr_bttries:'device',
  // old keys, read once to move to newer ones or removed on start (sr_delisted, sr_beta)
  sr_bsym:'device', sr_btf:'device', sr_delisted:'device', sr_beta:'device',
};
const SYNC = new Set(Object.keys(KEYS).filter(k => KEYS[k] === 'profile'));
// a value from the profile is taken only in a shape this code reads: a wrong one (an older or newer page, a broken write) would
// stop the page from starting on every device of the profile (sr_bot without profiles did, in a test). Left out, it stays in
// the profile until this device's own value replaces it
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const SHAPE = {sr_settings:isObj, sr_bot:v => isObj(v) && Array.isArray(v.profiles) && v.profiles.length > 0 && v.profiles.every(isObj),
  sr_favs:Array.isArray, sr_lv:isObj, sr_tfilt:isObj, sr_msort:Array.isArray, sr_jsort:Array.isArray, sr_bcfg:isObj, sr_bdraw:isObj,
  sr_bind:Array.isArray, sr_bpanes:Array.isArray, sr_learn:v => isObj(v) && isObj(v.done)};
const fits = (k, v) => v != null && (SHAPE[k] ? SHAPE[k](v) : true);
// sr_sync: {uid, v: {key: version this device has}, h: {key: fingerprint of that version's value}, t: {key: when this device
// last changed it}}. With the fingerprint a change is told by the value, not by the moment it was saved: one made while the
// sync couldn't run (no connection at start) still goes to the profile, and a save of the same value never does (2.74)
let SYNCV = load('sr_sync', null), syncReady = false, syncTimer2 = 0, syncStarting = null, syncPostponed = false;
const syncDirty = new Set();
// the same fingerprint whichever device wrote the value: the profile's jsonb comes back with its keys in another order
const canon = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const valFp = v => { const s = canon(v); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + '.' + s.length; };
// values from the profile → this device's storage, with their versions and fingerprints
function storeRows(rows) {
  syncMeta(m => {
    for (const r of rows) {
      if (!fits(r.key, r.value)) continue;
      try { localStorage.setItem(r.key, JSON.stringify(r.value)); m.h[r.key] = valFp(r.value); delete m.t[r.key]; }
      catch { /* full storage: the old value stays, and its fingerprint with it, so it isn't sent back as a change */ }
      m.v[r.key] = r.version;
    }
  });
}
// Signed in, the profile's newer values go into storage before anything below reads them: a change made on another device
// needs no reload. Before 2.83 the page started on this device's values, reloaded when the profile's answer came, and in
// between sent its old bot profiles to the server bot. One request, waited for at most 2 s; without an answer the page starts
// on this device's values and syncStart does what it did before. EARLY keeps the answer for syncStart (no second request)
let EARLY = null;
async function syncEarly() {
  const got = await Promise.race([(async () => {
    if (AUTH.exp - Date.now() < 60e3 && await renewTokens() !== 'ok') return null;
    const r = await fetch(SB_URL + 'user_state?select=key,version,updated_at,value', {headers:{apikey:SB_KEY, Authorization:'Bearer ' + AUTH.at}, signal:AbortSignal.timeout(2500)});
    return r.ok ? {rows:(await r.json()).filter(x => SYNC.has(x.key))} : null;
  })().catch(() => null), new Promise(r => setTimeout(r, 2000, null))]);
  SYNCV = load('sr_sync', null);
  if (got && SYNCV?.uid && SYNCV.uid === authUid()) storeRows(syncPlan(got.rows, syncMeta()).take);
  return got;
}
if (AUTH?.rt) EARLY = await syncEarly();

// ---------- account: sign-in through the Telegram bot (docs/PLAN-ACCOUNTS.md) ----------
// The tab keeps a secret and shows the code the auth function gave it; the person picks that code in the bot; the tab then
// trades a one-time token for a Supabase session (/auth/v1/verify). The tokens, their renewal and the early sync with the profile
// are at the top of the module (they run before the settings are read).
// the site opens only signed in (stage 4): without a session the page starts locked — the sign-in screen and the legal page,
// nothing scanned, no bot; signing in or out reloads the page, so everything starts (or stops) cleanly
const LOCKED = !AUTH;
const hexOf = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function authFn(body, token) {
  const r = await fetch(FN_URL + 'auth', {method:'POST', headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000)})
    .catch(() => { throw new Error('Нет связи с сервером входа. Проверьте интернет и попробуйте ещё раз.'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 429 ? 'Слишком много попыток входа — попробуйте через 10 минут' : j.error || 'HTTP ' + r.status);
  return j;
}
function setSession(s) {   // a GoTrue session → the tokens and when the access token runs out
  AUTH = s ? {at:s.access_token, rt:s.refresh_token, exp:Date.now() + (s.expires_in || 3600) * 1000} : null;
  save('sr_auth', AUTH); scheduleRefresh();
}
function signedOut() {   // this device keeps its copy of the settings; the profile no longer hears about changes
  AUTH = null; ME = null; save('sr_auth', null); clearTimeout(authTimer); renderAcct();
  syncReady = false; syncDirty.clear(); clearTimeout(syncTimer2);
  if (!LOCKED) setTimeout(() => location.reload(), 1200);   // back to the sign-in screen, after the toast has been seen
}
function scheduleRefresh() {   // 1.5 minutes before the end; the tabs take turns in renewTokens
  clearTimeout(authTimer);
  if (AUTH?.rt) authTimer = setTimeout(refreshSession, Math.max(5e3, AUTH.exp - Date.now() - 90e3));
}
// one at a time in this tab (see renewTokens for the other tabs). Offline or the server busy (429, 5xx): the tokens are kept and
// the next try is in a minute — not at every request in between, each of which would otherwise ask again
let renewAfter = 0;
function refreshSession(due) {
  if (refreshing || !AUTH) return refreshing;
  if (!due && Date.now() < renewAfter) return Promise.resolve();
  refreshing = renewTokens().then(r => {
    if (r === 'ok') { renewAfter = 0; scheduleRefresh(); }
    else if (r === 'dead') signedOut();
    else { renewAfter = Date.now() + 60e3; clearTimeout(authTimer); authTimer = setTimeout(() => refreshSession(true), 60e3); }
  }).finally(() => { refreshing = null; });
  return refreshing;
}
async function loadMe() {
  if (!AUTH) return renderAcct();
  try {
    const r = await authedFetch(SB_URL + 'profiles?select=tg_name,tg_username&limit=1');
    if (r.ok) ME = (await r.json())[0] || null;
  } catch { /* offline: the button still says signed in; the name comes with the next try */ }
  renderAcct();
}
function renderAcct() {
  const b = $('#acct'), t = AUTH ? 'Профиль' + (ME?.tg_name ? ': ' + ME.tg_name : '') : 'Войти через Telegram';
  $('#acctTxt').textContent = AUTH ? ME?.tg_name || 'Профиль' : 'Войти';
  b.title = t; b.setAttribute('aria-label', t); b.classList.toggle('on', !!AUTH);
  if (AUTH && $('#authDlg').classList.contains('profile-open') && !$('#authDlg').classList.contains('hidden')) authProfile();   // the name came while the window is open
}
const authBody = h => { $('#authBody').innerHTML = h; };
function openAuth() {
  authBack = document.activeElement;
  hooks.evClose(); hooks.closeGuard();
  $('#acct').setAttribute('aria-expanded', 'true');
  $('#authDlg').classList.remove('hidden');
  if (AUTH) authProfile(); else authStart();
  ($('#authBody').querySelector('a,button') || $('#authClose')).focus();
}
function closeAuth() {
  if ($('#authDlg').classList.contains('hidden')) return;
  authRun++; $('#authDlg').classList.add('hidden'); $('#acct').setAttribute('aria-expanded', 'false');
  if (authBack?.isConnected) authBack.focus({preventScroll:true});
}
function authFail(msg, again) {
  authBody(`<p>${esc(msg)}</p>${again ? '<button class="primary" id="authAgain">Начать заново</button>' : ''}`);
  if (!$('#authDlg').classList.contains('hidden')) ($('#authAgain') || $('#authClose')).focus();
}
async function authStart() {
  const run = ++authRun;
  $('#authDlg').classList.remove('profile-open');
  $('#authT').textContent = 'Вход через Telegram';
  authBody('<p class="faint" role="status">Готовлю вход…</p>');
  const secret = hexOf(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const h = hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  let s;
  try { s = await authFn({op:'start', h}); } catch (e) { if (run === authRun) authFail(e.message || String(e), true); return; }
  if (run !== authRun) return;
  if (!s.bot) return authFail('Вход через Telegram сейчас недоступен.', true);
  const until = Date.now() + (s.ttl || 300e3);
  authBody(`<p>1. Откройте нашего бота в Telegram.<br>2. Нажмите в нём этот код:</p>
    <div class="authcode" aria-label="Код для входа">${esc(s.code)}</div>
    <a class="authgo" href="https://t.me/${encodeURIComponent(s.bot)}?start=login_${s.nonce}" target="_blank" rel="noopener">Открыть Telegram</a>
    <p class="faint">Ждём подтверждения в Telegram. Код действует ещё <b id="authLeft"></b>.</p><p class="faint" id="authNet" role="status"></p>`);
  if (!$('#authDlg').classList.contains('hidden')) $('#authBody .authgo').focus();
  // how long the code still works, and a word when the network drops (the code keeps working, the page asks again)
  const left = () => { const s = Math.max(0, Math.ceil((until - Date.now()) / 1000)), n = $('#authLeft'); if (n) n.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const net = t => { const n = $('#authNet'); if (n && n.textContent !== t) n.textContent = t; };
  left();
  while (run === authRun) {
    await sleep(2000); left();
    if (run !== authRun) return;
    if (Date.now() > until) return authFail('Время на вход вышло.', true);
    let p; try { p = await authFn({op:'poll', nonce:s.nonce, secret}); } catch { net('Нет связи с сервером — пробую снова. Код продолжает действовать.'); continue; }   // a dropped request: ask again
    if (run !== authRun) return;
    net('');
    if (p.state === 'denied') return authFail('Вход отменён в Telegram.', true);
    if (p.state === 'expired') return authFail('Время на вход вышло.', true);
    if (p.state === 'ok') {
      try { setSession(await gotrue('verify', {type:'magiclink', token_hash:p.token_hash})); }
      catch (e) { return authFail('Не удалось войти: ' + (e.message || e), true); }
      await loadMe(); closeAuth();
      toast('Вы вошли', ME?.tg_name ? 'Профиль: ' + ME.tg_name : '', 'ok');
      await syncStart();
      if (LOCKED) location.reload();   // the site starts now, signed in, where the link led
      return;
    }
  }
}
function authProfile() {
  authRun++;
  $('#authDlg').classList.add('profile-open');   // shows #profileSettings and #authFoot, which stay in the page with their handlers
  $('#authT').textContent = 'Профиль';
  const initial = Array.from((ME?.tg_name || '').trim())[0] || 'Σ';
  authBody(`<section class="profile-identity" aria-label="Аккаунт"><div class="profile-avatar" aria-hidden="true">${esc(initial)}</div>
    <div><h4>${esc(ME?.tg_name || 'Аккаунт Telegram')}</h4>${ME?.tg_username ? `<p>@${esc(ME.tg_username)}</p>` : ''}<p class="profile-scope">Вход через Telegram</p></div></section>`);
  hooks.syncProfileNtf();   // the browser's permission can change outside the site
}
async function deleteProfile() {
  closeAuth();
  if (!await ask({title:'Удалить профиль?', text:'Удалятся профиль, сохранённые в нём настройки и серверный бот профиля со сделками — на всех устройствах. Данные в этом браузере останутся. Отменить нельзя.', ok:'Удалить', danger:true})) return;
  try {
    if (AUTH.exp - Date.now() < 60e3) await refreshSession();
    await authFn({op:'delete'}, AUTH?.at);
  } catch (e) { return toast('Не удалось удалить профиль', e.message || String(e), 'bad'); }
  SYNCV = null; save('sr_sync', null); signedOut();
  hooks.botGone();   // the profile's bot went with it
  toast('Профиль удалён', 'Настройки остались только в этом браузере', 'ok');
}
// «Выйти на всех устройствах» asks first, and says what is true: this device is out at once; the others are told by the
// server (it ends every session) and drop out at their next token renewal — unless that request didn't get through
async function signOut(all) {
  if (all) { closeAuth(); if (!await ask({title:'Выйти на всех устройствах?', text:'Профиль закроется здесь сразу, а на остальных устройствах — в течение часа. Для нового входа понадобится Telegram.', ok:'Выйти везде', danger:true})) return; }
  const t = AUTH?.at;
  const sent = t ? gotrue('logout' + (all ? '?scope=global' : ''), null, t).then(() => true, () => false) : Promise.resolve(false);
  const ok = all ? await Promise.race([sent, sleep(4000).then(() => false)]) : true;
  signedOut(); closeAuth();
  toast(all ? (ok ? 'Вы вышли на всех устройствах' : 'Вы вышли на этом устройстве') : 'Вы вышли из профиля',
    all ? (ok ? 'Остальные устройства закроют профиль в течение часа — те, что без сети, когда подключатся.' : 'Сервер не ответил — на остальных устройствах выйдите сами.') : '', ok ? 'ok' : 'warn');
}

// ---------- profile sync (accounts stage 2): what follows the person between devices ----------
// Which keys follow the person (KEYS, SYNC), the bookkeeping (sr_sync) and the first look at the profile, before the settings
// are read, are at the top of the module. Here: the rest — sending this device's changes, the first sign-in, return to the tab.
async function authFetch(path, init = {}) {   // PostgREST as the signed-in person
  if (!AUTH) throw new Error('signed out');
  const r = await authedFetch(SB_URL + path, init);
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const stateRows = (withValue, keys) => authFetch('user_state?select=key,version,updated_at' + (withValue ? ',value' : '') + (keys ? '&key=in.(' + keys.join(',') + ')' : ''));
// sr_sync is shared by this device's tabs: each change goes into the stored copy, read just before, never a copy kept in
// memory — a second tab would otherwise put back versions and fingerprints from before the first tab's pushes
function syncMeta(fn) {
  const m = load('sr_sync', null); if (!m?.uid || m.uid !== SYNCV?.uid) return SYNCV = m;   // signed out or deleted in another tab
  m.v ||= {}; m.h ||= {}; m.t ||= {}; fn?.(m); save('sr_sync', m); return SYNCV = m;
}
async function syncPush() {
  let yielded = false;
  for (const k of [...syncDirty]) {
    if (!syncReady || !syncMeta()) return;
    syncDirty.delete(k);
    const value = load(k, null); if (value == null) continue;
    const f = valFp(value);
    if (SYNCV.v[k] && SYNCV.h[k] === f) continue;   // the profile has this very value (this or another tab sent it): a save is not a change
    let v = SYNCV.v[k] || 0, done = false;
    for (let i = 0; i < 3 && !done; i++) {
      let nv;
      try { nv = await authFetch('rpc/state_put', {method:'POST', body:JSON.stringify({p_key:k, p_value:value, p_version:v})}); }
      catch { syncDirty.add(k); syncTimer2 = setTimeout(syncPush, 30e3); return; }   // offline or signed out: later
      if (nv) { syncMeta(m => { m.v[k] = nv; m.h[k] = f; }); done = true; continue; }
      // another device wrote first. The later change wins, as at the start (syncPlan): before 2.125 this change went over the
      // other one even when it was older (made offline, sent on the way back)
      const r = (await stateRows(false, [k]).catch(() => []))[0];
      if (r && SYNCV?.t?.[k] && Date.parse(r.updated_at) > SYNCV.t[k]) { yielded = true; break; }   // the profile's is newer: offered below
      v = r?.version || 0;
    }
  }
  if (yielded) syncCheck();   // «Настройки изменены на другом устройстве» — the newer value, as on a return to the tab
}
function syncApply(rows, asked) {   // values from the profile → this device's storage, then a reload so everything reads them
  storeRows(rows);
  let last = 0; try { last = +sessionStorage.getItem('sr_syncreload') || 0; } catch {}   // a browser policy may forbid storage
  if (!asked && Date.now() - last < 15e3) return;   // never a reload loop; the values are stored and apply at the next start
  try { sessionStorage.setItem('sr_syncreload', Date.now()); } catch { if (!asked) return; }   // can't guard against a loop: wait for the next start
  location.reload();
}
// a device that synced before, against the profile's rows: the profile's newer values are taken, this device's own changes
// since its last sync are sent — also those made while the sync couldn't run. Changed on both: the later change wins (the
// owner's decision, 09.11). An sr_sync from before 2.82 has no fingerprints: a key it can't judge is taken from the profile
function syncPlan(rows, m) {
  const take = [], send = [], learn = {};
  for (const k of SYNC) {
    const r = rows.find(x => x.key === k), raw = localStorage.getItem(k), known = m.v[k] || 0;
    let local = null; try { local = raw == null ? null : JSON.parse(raw); } catch { /* unreadable: as if absent */ }
    const here = local != null && (m.h[k] ? valFp(local) !== m.h[k] : r ? r.version === known && valFp(local) !== valFp(r.value) : true);
    if (!r) { if (local != null) send.push(k); }   // the profile doesn't have this key yet
    else if (r.version > known) { if (here && m.t[k] > Date.parse(r.updated_at)) send.push(k); else if (fits(k, r.value)) take.push(r); }
    else if (here) send.push(k);
    else if (local != null && !m.h[k]) learn[k] = valFp(local);   // the same value as the profile's: its fingerprint, from now on
  }
  return {take, send, learn};
}
// after sign-in, on every start while signed in, and again on return to the tab or to the network when it couldn't reach the
// profile (atStart false: the profile's newer values then wait for «применить», as in syncCheck, instead of reloading)
function syncStart(atStart = true) { return syncStarting ||= syncStartNow(atStart).finally(() => { syncStarting = null; }); }
async function syncStartNow(atStart) {
  if (!AUTH) return;
  const uid = authUid(); if (!uid) return;
  let rows = atStart ? EARLY?.rows : null; EARLY = null;   // the answer the page started with, already in storage
  if (!rows) try { rows = (await stateRows(true)).filter(r => SYNC.has(r.key)); } catch { return; }   // offline: syncCheck tries again
  SYNCV = load('sr_sync', null);   // as this device's tabs keep it now
  if (SYNCV?.uid === uid) {
    const {take, send, learn} = syncPlan(rows, syncMeta());
    syncMeta(m => Object.assign(m.h, learn));
    syncReady = true;
    if (send.length) { send.forEach(k => syncDirty.add(k)); clearTimeout(syncTimer2); await syncPush(); }
    if (take.length) {
      if (atStart) syncApply(take);   // reloads
      else toast('Настройки изменены на другом устройстве', 'Нажмите, чтобы применить их здесь', 'info', () => syncApply(take, true), 15000);
    }
    return;
  }
  // the first sign-in with this profile on this device
  const local = [...SYNC].filter(k => localStorage.getItem(k) != null);
  let take = rows.length > 0;
  // closing the question (Esc, a tap beside it) decides nothing: before 2.82 it meant «Оставить эти» and replaced the profile's
  // settings with this device's. Nothing is synced until it is answered; it comes again at the next start
  if (rows.length && local.length) take = await ask({title:'Настройки в профиле', text:'В профиле уже есть настройки с другого устройства: монеты, профили бота, вид графиков. Взять их или заменить настройками этого устройства? Журнал этого устройства не меняется.', ok:'Взять из профиля', no:'Оставить эти', dismiss:null});
  if (take == null) { syncPostponed = true; return; }
  SYNCV = {uid, v:Object.fromEntries(rows.map(r => [r.key, r.version])), h:Object.fromEntries(rows.map(r => [r.key, valFp(r.value)])), t:{}};
  save('sr_sync', SYNCV);
  syncReady = true;
  if (take) return syncApply(rows, true);
  // «Оставить эти»: this device's values win; what it doesn't have comes from the profile
  for (const r of rows) if (localStorage.getItem(r.key) == null && fits(r.key, r.value)) try { localStorage.setItem(r.key, JSON.stringify(r.value)); } catch { /* full storage */ }
  local.forEach(k => syncDirty.add(k));
  await syncPush();   // at once: a locked page reloads right after this
}
async function syncCheck() {   // back to the tab or to the network: another device may have changed something
  if (!AUTH) return;
  if (!syncReady) return syncPostponed ? undefined : syncStart(false);   // the start couldn't reach the profile: this device's changes go now
  if (syncDirty.size) return;
  let rows; try { rows = await stateRows(false); } catch { return; }
  if (!syncMeta()) return;   // versions as this device's tabs keep them: another tab's own push is not «another device»
  rows = rows.filter(r => SYNC.has(r.key) && r.version > (SYNCV.v[r.key] || 0));
  if (!rows.length) return;
  toast('Настройки изменены на другом устройстве', 'Нажмите, чтобы применить их здесь', 'info', async () => {
    try { syncApply(await stateRows(true, rows.map(r => r.key)), true); } catch { toast('Не удалось загрузить настройки', 'Проверьте интернет', 'bad'); }
  }, 15000);
}

// ---------- what ran at load (the page calls start() where these sections used to be) ----------
// the page's own functions this code calls: given by start() as wrappers, since some are declared further down the page
const hooks = {};
export function start(h) {
  Object.assign(hooks, h);
document.documentElement.classList.toggle('locked', LOCKED);
$('#acct').onclick = openAuth;
$('#authClose').onclick = closeAuth;
$('#authDlg').onclick = e => {
  if (e.target.id === 'authDlg') closeAuth();
  const id = e.target.closest('button')?.id;
  if (id === 'authAgain') authStart().then(() => {}, () => {});
  if (id === 'authOut' || id === 'authOutAll') signOut(id === 'authOutAll');
  if (id === 'authDel') deleteProfile();
};
$('#authDlg').onkeydown = e => {
  if (e.key === 'Escape') { e.stopPropagation(); closeAuth(); }
  if (e.key === 'Tab') {   // keep focus inside the dialog
    const f = [...$('#authDlg').querySelectorAll('a,button')].filter(x => x.offsetParent && !x.disabled);   // a disabled button takes no focus: Tab would stick before it
    e.preventDefault(); f[(f.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
  }
};
window.addEventListener('storage', e => {   // sr_journal from another tab: the page's own listener, next to this start() call
  if (e.key !== 'sr_auth') return;
  AUTH = load('sr_auth', null);
  if (!AUTH !== LOCKED) return location.reload();   // signed in or out in another tab
  scheduleRefresh(); if (AUTH) loadMe(); else { ME = null; renderAcct(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !AUTH) return;
  if (AUTH.exp - Date.now() < 120e3) refreshSession();
  syncCheck();
});
window.addEventListener('online', () => { if (AUTH) syncCheck(); });   // a start without a connection syncs now, a hidden tab too
setOnSaved(k => {
  if (!SYNC.has(k) || !SYNCV) return;
  syncMeta(m => { m.t[k] = Date.now(); });   // when this device changed it: settles a clash with another device
  if (!syncReady) return;   // compared with the profile once the sync can run (syncStart)
  syncDirty.add(k); clearTimeout(syncTimer2); syncTimer2 = setTimeout(syncPush, 1500);
});
renderAcct(); scheduleRefresh();
// one after the other: each may ask something. A failed sync must not cost the profile's bot its check
  return loadMe().then(() => syncStart()).catch(e => console.error('sync', e));
}

export {SB_URL, SB_KEY, FN_URL, AUTH, ME, LOCKED, KEYS, SYNC, syncReady, canon, fits, authedFetch, authFetch, openAuth};
