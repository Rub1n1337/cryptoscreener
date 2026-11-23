// Shared helpers of the page (docs/PLAN-UNTANGLE-modules.md, wave 1): storage, formatters, toasts, Binance requests, chart
// colours, sound, the own dialog, tooltips on touch screens. Nothing here reads the browser storage at load: a module that does
// imports ./account.js (directly or through a chain), so its top-level await of the profile keeps that read after it.
import {TFMS} from '../supabase/functions/_shared/math.js';

// ---------- utils ----------
const $ = s => document.querySelector(s);
// a block's entrance animation plays once: firstShow(key) marks it with data-first until the animation has ended (it only runs
// while the block is on screen, so one rendered in a closed tab plays when the tab opens); later re-renders come without it
const seenFirst = new Set();
const firstShow = key => seenFirst.has(key) ? '' : ` data-first="${key}"`;
const DEF ={method:'log', N:210, k:3, tf:'4h', candles:540, top:150, minScore:60, v:4};   // 4h — the same timeframe the shared bot trades, so the market shows what it acts on
const SCAN_MS = 60000;
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
// a full browser storage used to fail silently (a long journal would simply stop being saved): say it once
let saveWarned = false, onSaved = null;   // onSaved: the profile sync (accounts) hears which key changed
const setOnSaved = fn => { onSaved = fn; };   // account.js start(): from then on a save of a profile key reaches the profile
// an unchanged value is not a change: the table saves its filters on every redraw, and each save used to reach the profile as
// a new version, so the other devices kept reloading for nothing
const save = (k, v) => { try { const s = JSON.stringify(v); if (localStorage.getItem(k) === s) return; localStorage.setItem(k, s); onSaved?.(k); } catch (e) {
  if (!saveWarned && /quota/i.test(e?.name + e?.message)) { saveWarned = true; setTimeout(() => toast('Браузер не сохраняет данные сайта', 'Хранилище переполнено: новые сделки журнала и настройки не запомнятся после перезагрузки. Освободите место (сбросьте журнал или очистите данные сайта).', 'bad'), 0); }
} };

// chart colours come from the CSS tokens of the current theme (see :root / [data-theme=light])
const PC = {};
function pal() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  for (const k of ['up','lo','mid','trade','price','acc','axis','label','grid','cross','rsi','mute','band','tip','volup','voldn','hi','lo2','base']) PC[k] = v('--c-' + k);
  PC.canvas = v('--canvas');
}
const fp = p => { if (p == null || !isFinite(p)) return '—'; const a = Math.abs(p); return '$' + (a >= 1000 ? p.toFixed(0) : a >= 100 ? p.toFixed(2) : a >= 1 ? p.toFixed(3) : p.toPrecision(4)); };
const usd = (x, sign = true) => x == null || !isFinite(x) ? '—' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.abs(x).toFixed(2);
const rr = x => x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2) + 'R';
const cl = x => x > 0 ? 'pos' : x < 0 ? 'neg' : '';
const hm = t => new Date(t).toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit'});
const dt = t => new Date(t).toLocaleString('ru', {day:'2-digit', month:'2-digit', ...(new Date(t).getFullYear() !== new Date().getFullYear() && {year:'2-digit'}), hour:'2-digit', minute:'2-digit'});
const dur = ms => ms == null || !isFinite(ms) ? '—' : ms < 36e5 ? Math.round(ms/6e4) + 'м' : ms < 864e5 ? (ms/36e5).toFixed(1) + 'ч' : (ms/864e5).toFixed(1) + 'д';
const base = s => s.replace(/USDT$/, '');
const pair = s => s.replace(/USDT$/, '/USDT');
const tfOf = ms => Object.keys(TFMS).find(k => TFMS[k] === ms);
const money = v => v.toLocaleString('ru', {minimumFractionDigits:2, maximumFractionDigits:2});
// a large sum with the currency set lighter than the value (DESIGN-RULES п. 67): «$» in .cur, after a sign if there is one
const curH = s => String(s).replace(/^([+−-]?)\$/, '$1<span class="cur">$</span>');
const plural = (n, f) => f[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];
const reasonTag = r => `<span class="tag ${r === 'тейк' ? 'tp' : r === 'стоп' ? 'sl' : 'ts'}">${r || '—'}</span>`;
const METHOD_NAME = {log:'лог-канал', classic:'классика', robust:'робастная', ewma:'EWMA'};
// the T½ filter counts candles: show what that is in time on the chosen timeframe
function hlOpts(sel, tf) { for (const o of $(sel).options) if (+o.value) o.textContent = `T½ ≤ ${o.value} (≈ ${dur(+o.value * TFMS[tf])})`; }
const isPhone = () => matchMedia('(max-width:700px)').matches;
// coin avatar: first letter on a colour derived from the ticker
const coin = sym => { const b = base(sym); let h = 0; for (const ch of b) h = (h * 31 + ch.charCodeAt(0)) % 360; return `<span class="coin"><i style="--h:${h}">${b.replace(/^1000+/, '')[0] || '?'}</i><b>${b}</b></span>`; };
// title and body are plain text (the same go to the browser's Notification): escaped here, so a server's error message can't
// put markup on the page. A function declaration, not esc: toast may run before esc is defined further down
function plainHtml(s) { return String(s).replace(/[<>&"]/g, c => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"}[c])); }
// in-app toasts: kind = ok | bad | warn | info; click runs onClick
function toast(title, body = '', kind = 'info', onClick, ms = 6000) {
  // the same message twice at once is noise: keep the one already on screen
  const key = title + '\n' + body;
  if ([...$('#toasts').children].some(t => t.dataset.key === key && !t.classList.contains('out'))) return;
  const el = document.createElement('div');
  el.dataset.key = key;
  el.className = 'toast ' + kind;
  el.innerHTML = `<svg class="i" style="color:var(--${kind === 'ok' ? 'lo' : kind === 'bad' ? 'up' : kind === 'warn' ? 'acc' : 'blue'})"><use href="#i-${kind}"/></svg><div><b>${plainHtml(title)}</b>${body ? `<div class="mute">${plainHtml(body)}</div>` : ''}</div>`;
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.onclick = () => { onClick?.(); kill(); };
  $('#toasts').prepend(el);
  while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
  setTimeout(kill, ms);
}

const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];
async function api(path) {
  let err;
  for (const b of BASES) {
    // a hung request must not hold the scan forever (it would never run again): 10 s, then the next host
    try { const r = await fetch(b + path, {signal:AbortSignal.timeout(10000)}); if (r.ok) return await r.json(); err = new Error('HTTP ' + r.status); } catch (e) { err = e; }
  }
  throw err;
}
// candles of the last scan are kept, and the next ones only fetch the newest 3 bars and splice them in:
// every minute only the last bar changes, so re-downloading 360 bars of ~150 coins (~10 MB a minute) was waste
const KST = new Map(); let kstSwept = 0;
async function klines(sym, tf, limit) {
  const key = sym + '|' + tf, st = KST.get(key), tfms = TFMS[tf];
  if (Date.now() - kstSwept > 6e4) {   // coins nobody asked for in 10 min (left the list, another timeframe) are dropped
    kstSwept = Date.now();
    for (const [k, v] of KST) if (kstSwept - v.used > 6e5) KST.delete(k);
  }
  if (st && st.K.length && st.limit >= limit && Date.now() - st.K[st.K.length - 1][0] < 2 * tfms) {
    const N = await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=3`);
    if (N.length && N[0][0] <= st.K[st.K.length - 1][0]) {   // overlaps the stored bars: no gap
      const K = st.K.filter(k => k[0] < N[0][0]).concat(N).slice(-st.limit);
      KST.set(key, {K, limit:st.limit, used:Date.now()});
      return K.slice(-limit);
    }
  }
  const K = await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);
  KST.set(key, {K, limit, used:Date.now()});
  return K;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length:n}, async () => { while (i < items.length) await fn(items[i++]); }));
}

const esc = s => String(s).replace(/[<>&"]/g, c => ({"<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"}[c]));   // user text into HTML
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- sound ----------
let actx = null;
function beep() {
  try { actx = actx || new AudioContext(); if (actx.state === 'suspended') actx.resume(); const o = actx.createOscillator(), gn = actx.createGain(); o.frequency.value = 880; gn.gain.value = 0.08;
    o.connect(gn); gn.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.25); } catch {}
}

// ---------- own dialog instead of confirm()/prompt(): says exactly what will happen, follows the theme ----------
// ask({title, text, ok, danger}) → true/false; with `input` → the typed text or null. Destructive dialogs focus "Отмена".
// The cancel label is noText: a parameter named `no` was shadowed by the `const no` below and every dialog threw (2.64–2.74)
// dismiss: what closing without a choice (Esc, a tap beside the window) returns, when it must differ from the «no» button
function ask({title, text = '', ok = 'Готово', no:noText = 'Отмена', danger = false, input = null, dismiss}) {
  return new Promise(res => {
    const back = document.activeElement, inp = $('#dlgIn'), withInput = input != null;
    $('#dlgT').textContent = title; $('#dlgD').textContent = text; $('#dlgD').classList.toggle('hidden', !text);
    $('#dlgOk').textContent = ok; $('#dlgOk').className = danger ? 'danger' : 'primary'; $('#dlgNo').textContent = noText;
    inp.classList.toggle('hidden', !withInput); inp.value = input?.value ?? ''; inp.placeholder = input?.placeholder ?? ''; inp.inputMode = input?.inputmode ?? '';
    $('#dlg').classList.remove('hidden');
    if (withInput) { inp.focus(); inp.select(); } else (danger ? $('#dlgNo') : $('#dlgOk')).focus();
    const done = v => {
      $('#dlg').classList.add('hidden');
      $('#dlg').onkeydown = $('#dlg').onclick = $('#dlgOk').onclick = $('#dlgNo').onclick = null;
      back?.focus?.({preventScroll:true}); res(v);
    };
    const no = () => done(withInput ? null : false), away = () => dismiss === undefined ? no() : done(dismiss);
    $('#dlgOk').onclick = () => done(withInput ? inp.value : true);
    $('#dlgNo').onclick = no;
    $('#dlg').onclick = e => { if (e.target.id === 'dlg') away(); };
    $('#dlg').onkeydown = e => {
      if (e.key === 'Escape') { e.stopPropagation(); away(); }
      if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); done(inp.value); }
      if (e.key === 'Tab') {   // keep focus inside the dialog
        const f = [inp, $('#dlgNo'), $('#dlgOk')].filter(x => !x.classList.contains('hidden'));
        e.preventDefault(); f[(f.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    };
  });
}
// ---------- tooltips on touch screens ----------
// A phone has no hover, and ~440 explanations live in title="…" (what PF or R is, why a strength is grey, what the borrowing is).
// A tap on something that only explains — a card, a label, a tag — shows its text; on a button, a link or a table row the tap
// keeps its action and a long press (½ s) shows the text instead. Another tap or a scroll hides it. Called by the page where this
// section used to be: its capture listener on document keeps its place among the page's own
function startTips() { if (matchMedia('(hover: none)').matches) {
  const tip = document.createElement('div'); tip.className = 'taptip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true; document.body.append(tip);
  const ACT = 'button, a, select, input, textarea, summary, [role=button], [role=radio], [tabindex], th[data-s], tr[data-sym], [data-fav], [data-act], [data-pick], canvas';
  let shownFor = null, lp = null, lpShown = false;
  const hide = () => { tip.hidden = true; shownFor = null; };
  const show = el => {
    const t = el.getAttribute('title'); if (!t) return false;
    tip.textContent = t; tip.hidden = false; shownFor = el;
    const r = el.getBoundingClientRect(), W = document.documentElement.clientWidth;
    tip.style.maxWidth = Math.min(320, W - 32) + 'px';
    const x = Math.min(Math.max(16, r.left + r.width / 2 - tip.offsetWidth / 2), W - 16 - tip.offsetWidth);
    let y = r.bottom + 8; if (y + tip.offsetHeight > innerHeight - 8) y = Math.max(8, r.top - tip.offsetHeight - 8);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    return true;
  };
  document.addEventListener('click', e => {
    if (!tip.hidden) { const was = shownFor; hide(); if (was && was.contains(e.target)) { e.preventDefault(); return; } }   // the same thing again: just close
    const el = e.target.closest('[title]');
    if (!el || e.target.closest(ACT) || el.closest(ACT)) return;   // an action keeps its tap; its text is on a long press
    if (show(el)) e.preventDefault();
  }, true);
  document.addEventListener('touchstart', e => {
    lpShown = false; clearTimeout(lp);
    const el = e.target.closest('[title]'); if (!el || e.target.closest('canvas')) return;
    lp = setTimeout(() => { lpShown = show(el); }, 500);
  }, {passive:true});
  document.addEventListener('touchmove', () => clearTimeout(lp), {passive:true});
  document.addEventListener('touchend', e => { clearTimeout(lp); if (lpShown) e.preventDefault(); }, {passive:false});   // a long press does not also tap
  addEventListener('scroll', hide, {passive:true, capture:true});
} }

// ---------- what ran at load: the page calls start() first (startTips() at its old place, near the end) ----------
function start() {
  // a block's entrance animation plays once (firstShow)
  document.addEventListener('animationend', e => { const k = e.target.closest?.('[data-first]')?.dataset.first; if (k) seenFirst.add(k); });
  pal();
  // browsers keep sound started by a timer muted until the page is clicked or a key is pressed; the next touch unmutes it
  for (const ev of ['pointerup', 'keydown']) addEventListener(ev, () => { if (actx?.state === 'suspended') actx.resume(); }, {passive:true});
}

export {$, firstShow, DEF, SCAN_MS, load, save, setOnSaved, PC, pal, fp, usd, rr, cl, hm, dt, dur, base, pair, tfOf, coin, plainHtml,
  money, curH, plural, reasonTag, METHOD_NAME, hlOpts, isPhone, toast, BASES, api, KST, klines, pool, esc, sleep, beep, ask, start, startTips};
