// «Учёба» and «Что нового» (docs/PLAN-UNTANGLE-modules.md, wave 3): the list of modules, a lesson, the dictionary, the terms' hints,
// «Проверьте сами», the help page's glossary; the changelog page. The texts are learn.js and changelog.js, loaded on the first open.
// What ran at load in the page is start(), called by the page at the same place as before.
import {$, load, save, toast, plural, isPhone} from './core.js';
import {fits} from './account.js';
import {CHANGELOG} from './changes.js';
import {btBusy, btFill, runBacktest, fmtDay} from './backtest.js';

// the page's own functions and values this code needs: given by start() as wrappers, since some are declared further down the page
const hooks = {};

// ---------- «Учёба»: #learn — the modules, #learn/<module>/<lesson> — a lesson ----------
// The texts are in learn.js (MODULES: {id, title, lead, lessons:[{id, title, min, body, try, check}], soon}), loaded on the first
// open like changelog.js, so the site's first load doesn't carry them; the version in the address keeps a deploy from serving
// the old file. Progress: sr_learn = {done:{'test/costs': 'YYYY-MM-DD'}, last:'test/costs'}, written only by «Пройдено»
let LEARN = null, GLOSS = null, learnLoad = null, learnPath = '', learnShown = null;
const setLearnPath = p => { learnPath = p; };   // the page's readHash, the tab and Ctrl+K open an address; an imported let can't be assigned there
const loadLearn = () => learnLoad ||= import('../learn.js?v=' + CHANGELOG[0].v).then(m => { LEARN = m.MODULES; GLOSS = m.GLOSS; }).catch(e => { learnLoad = null; throw e; });
const glossBy = id => GLOSS?.find(g => g.id === id);
// «Справка» → «Словарь терминов»: the entries of GLOSS marked help, in their order, filled on the first open
function fillHelpGloss() {
  const box = $('#hGloss');
  if (!$('#hGlossD').open || !box.hasAttribute('aria-busy')) return;
  box.innerHTML = '<span class="mute">Загружаю словарь…</span>';
  loadLearn().then(() => { box.removeAttribute('aria-busy'); box.innerHTML = GLOSS.filter(g => g.help).map(g => `<b>${g.t}</b><span>${g.d}</span>`).join(''); },
    () => { box.innerHTML = '<span class="mute">Не удалось загрузить словарь. Проверьте интернет.</span><span><button id="hGlossR">Повторить</button></span>'; $('#hGlossR').onclick = fillHelpGloss; });
}
const learnProg = () => { const v = load('sr_learn', null); return fits('sr_learn', v) ? v : {done:{}}; };
function learnLesson(path = learnPath) {
  const [mi, li] = path.split('/'), m = LEARN?.find(x => x.id === mi), i = m && li ? m.lessons.findIndex(x => x.id === li) : -1;
  return i < 0 ? null : {m, l:m.lessons[i], i, key:m.id + '/' + m.lessons[i].id};
}
const learnMin = n => `≈ ${n} мин`;
const learnDoneN = (m, P) => m.lessons.filter(l => P.done[m.id + '/' + l.id]).length;
function learnList() {
  const P = learnProg(), ready = LEARN.filter(m => m.lessons.length), soon = LEARN.filter(m => !m.lessons.length);
  // where to go on: the lesson after the last one marked, or the first not marked
  const all = ready.flatMap(m => m.lessons.map(l => ({m, l, key:m.id + '/' + l.id}))), li = all.findIndex(x => x.key === P.last);
  const next = [...all.slice(li + 1), ...all.slice(0, li + 1)].find(x => !P.done[x.key]);
  const row = (m, l, j) => { const k = m.id + '/' + l.id, d = P.done[k];
    return `<li><a class="lrow" href="#learn/${k}"><span class="ln">${j + 1}</span><span class="lt">${l.title}</span><span class="lm">${learnMin(l.min)}</span>`
      + `<span class="lck${d ? '' : ' no'}" title="${d ? 'Пройдено' : 'Не пройдено'}">${d ? '<svg class="i" aria-hidden="true"><use href="#i-check"/></svg><span class="sr">пройдено</span>' : ''}</span></a></li>`; };
  const mod = m => { const n = LEARN.indexOf(m) + 1, d = learnDoneN(m, P);
    return `<section class="panel lmod${m.lessons.length ? '' : ' soon'}" aria-labelledby="lm-${m.id}"><div class="lmh"><span class="lnum" aria-hidden="true">${n}</span>`
      + `<div class="lmt"><h3 id="lm-${m.id}"><span class="sr">Модуль ${n}. </span>${m.title}</h3><p class="lead">${m.lead}</p></div>`
      + (m.lessons.length ? `<span class="lprog">${d} из ${m.lessons.length}</span>` : '<span class="tag">скоро</span>') + '</div>'
      + (m.lessons.length ? `<ol class="llist">${m.lessons.map((l, j) => row(m, l, j)).join('')}</ol>`
        : `<ul class="llist">${(m.soon || []).map(t => `<li>${t}</li>`).join('')}</ul>`) + '</section>'; };
  return (next && Object.keys(P.done).length ? `<div class="banner info lgo"><svg class="i"><use href="#i-learn"/></svg><div>Продолжить: <a href="#learn/${next.key}">${next.l.title}</a> <span class="mute">· модуль «${next.m.title}»</span></div></div>` : '')
    + `<nav class="lgl" aria-label="Учёба"><a href="#learn/gloss"><svg class="i"><use href="#i-book"/></svg>Словарь терминов</a></nav>`
    + `<div class="lmods">${ready.map(mod).join('')}${soon.map(mod).join('')}</div>`;
}
// «Источники» under a lesson: references from learn.js (our file, not the network's). A plain link to the work's page is a
// navigation, which the CSP's connect-src doesn't govern; a new tab with noopener noreferrer so the page can't reach back
// A reference list as papers keep one: small type at the very end, «Authors (year). Title. Journal.», then our one line about it
const learnSrc = s => s?.length ? `<section class="lsrc" aria-labelledby="lSrcH"><h3 id="lSrcH">Источники</h3><ol>`
  + s.map(w => `<li>${w.a} (${w.y}). ${w.url ? `<a href="${w.url}" target="_blank" rel="noopener noreferrer">${w.t}<span class="sr"> (откроется в новой вкладке)</span></a>` : w.t}. <i>${w.j}</i>. <span class="lsn">${w.n}</span></li>`).join('')   // a book with no stable page: the title alone
  + '</ol></section>' : '';
// «Проверьте себя»: the lesson's questions (learn.js CHECKS). The answers come in an order shuffled by the lesson and question
// (the same every time, so the right one isn't always first); a tap marks the pick, the right answer and shows why. Nothing is stored
const learnOrder = (seed, n) => { let h = 7; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const o = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { h = (Math.imul(h, 1103515245) + 12345) >>> 0; const j = (h >>> 8) % (i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; };
const learnCheck = (l, key) => l.check?.length ? `<section class="lchk" aria-labelledby="lChkH"><h3 id="lChkH">Проверьте себя</h3>`
  + l.check.map((q, qi) => `<fieldset class="lq" data-q="${qi}"><legend>${qi + 1}. ${q.q}</legend><div class="lqa">`
    + learnOrder(key + '/' + qi, q.a.length).map(ai => `<button type="button" data-a="${ai}" aria-pressed="false">${q.a[ai]}</button>`).join('')
    + '</div><p class="lqw" aria-live="polite"></p></fieldset>').join('') + '</section>' : '';
function learnAnswer(b, x) {
  const fs = b.closest('.lq'), q = x.l.check[+fs.dataset.q], a = +b.dataset.a, ok = a === q.ok;
  fs.querySelectorAll('[data-a]').forEach(y => { const i = +y.dataset.a; y.setAttribute('aria-pressed', String(i === a)); y.classList.toggle('ok', i === q.ok); y.classList.toggle('no', i === a && !ok); });
  fs.querySelector('.lqw').innerHTML = `<b>${ok ? 'Верно.' : 'Не совсем.'}</b> ${ok ? '' : `Правильный ответ — «${q.a[q.ok]}». `}${q.why}`;
}
// «Словарь» (#learn/gloss, #learn/gloss/<term>): every term of GLOSS by the alphabet, a filter, the lessons that use it
function learnGloss() {
  const uses = {};
  for (const m of LEARN) for (const l of m.lessons) for (const t of new Set([...l.body.matchAll(/data-term="([^"]+)"/g)].map(r => r[1]))) (uses[t] ||= []).push(`<a href="#learn/${m.id}/${l.id}">${l.title}</a>`);
  const list = [...GLOSS].sort((a, b) => a.t.localeCompare(b.t, 'ru'));
  return `<nav class="lgl" aria-label="Учёба"><a href="#learn"><svg class="i"><use href="#i-back"/></svg>Все модули</a></nav>`
    + `<article class="panel doc lgpage"><h2 id="lTitle" tabindex="-1">Словарь</h2><p class="mute">Термины уроков и сайта простыми словами. В уроках термин подчёркнут пунктиром: наведите или нажмите, чтобы увидеть объяснение.</p>`
    + `<input type="search" id="lgq" class="lgq" placeholder="Найти термин" aria-label="Найти термин" autocomplete="off">`
    + `<dl class="gdl">${list.map(g => `<div id="g-${g.id}" tabindex="-1" data-s="${[g.t, g.d, ...(g.kw || [])].join(' ').toLowerCase()}"><dt>${g.t}</dt><dd>${g.d}`
      + (uses[g.id] ? `<span class="gu">В уроках: ${uses[g.id].join(', ')}</span>` : '') + '</dd></div>').join('')}</dl>`
    + '<p class="mute" id="lgnone" hidden>Такого термина нет. Попробуйте другое слово или быстрый поиск (Ctrl K).</p></article>';
}
// a term in a lesson: a hint right after it (so Tab goes from the term to the hint's link) — on hover with a mouse, on a tap
// or Enter / Space; one at a time, Esc or a tap elsewhere closes it. Placed under the term, kept inside the screen
let tipFor = null, tipTimer = 0;
function tipHide(back) {
  clearTimeout(tipTimer); if (!tipFor) return;
  const d = tipFor; tipFor = null; d.setAttribute('aria-expanded', 'false');
  const t = $('#lTip'); if (t) { t.classList.remove('open'); t.removeAttribute('id'); setTimeout(() => t.remove(), 160); }
  if (back) d.focus();
}
function tipShow(d) {
  clearTimeout(tipTimer); if (tipFor === d) return;
  const g = glossBy(d.dataset.term); if (!g) return;
  tipHide(); tipFor = d; d.setAttribute('aria-expanded', 'true');
  const t = document.createElement('span'); t.id = 'lTip'; t.className = 'ltip'; t.setAttribute('role', 'note');
  t.innerHTML = `<b>${g.t}</b><span>${g.d}</span><a href="#learn/gloss/${g.id}"><svg class="i" aria-hidden="true"><use href="#i-book"/></svg>В словарь</a>`;
  d.after(t);
  // the wanted place on screen, then the shift from where the hint landed (its containing block may be a list item or a table)
  const rs = d.getClientRects(), r = rs[rs.length - 1], w = t.offsetWidth, h = t.offsetHeight, W = document.documentElement.clientWidth;
  const bot = r.bottom - 3, top = rs[0].top + 3;   // the term's box has 9 px of tap padding: a 6 px gap from the text itself
  const x = Math.max(8, Math.min(r.left, W - 8 - w)), y = bot + h <= innerHeight || top - h < 0 ? bot : top - h;
  t.style.left = t.style.top = '0px';
  const o = t.getBoundingClientRect(); t.style.left = (x - o.left) + 'px'; t.style.top = (y - o.top) + 'px';
  void t.offsetWidth; t.classList.add('open');   // the start state is laid out, so the fade-in runs (no rAF: a hidden tab stops it)
}
const tipLater = fn => { clearTimeout(tipTimer); tipTimer = setTimeout(fn, 200); };
function learnTerms(box) {
  box.querySelectorAll('.lart dfn[data-term]').forEach(d => { if (!glossBy(d.dataset.term)) return;
    d.tabIndex = 0; d.setAttribute('role', 'button'); d.setAttribute('aria-expanded', 'false'); d.setAttribute('aria-label', d.textContent + ' — что это'); });
}
function learnPage(x) {
  const {m, l, i, key} = x, P = learnProg(), n = LEARN.indexOf(m) + 1, done = P.done[key], nx = m.lessons[i + 1];
  const toc = m.lessons.map((y, j) => { const k = m.id + '/' + y.id;
    return `<li><a href="#learn/${k}"${j === i ? ' aria-current="page"' : ''}><span class="ln">${j + 1}</span><span class="lt">${y.title}</span>${P.done[k] ? '<svg class="i lck" aria-label="пройдено"><use href="#i-check"/></svg>' : ''}</a></li>`; }).join('');
  const tries = (l.try || []).map((t, j) => `<div><button data-ltry="${j}"${t.primary ? ' class="primary"' : ''}><svg class="i"><use href="#i-play"/></svg>${t.label}</button>${t.note ? `<span class="mute">${t.note}</span>` : ''}</div>`).join('');
  // a phone: the module's list folds at the top; wider: it stands beside the lesson, always open
  return `<div class="lgrid"><nav class="ltoc" aria-label="Уроки модуля"><details${isPhone() ? '' : ' open'}><summary>Модуль ${n} · ${m.title} <span class="lprog">${learnDoneN(m, P)} из ${m.lessons.length}</span></summary>`
    + `<ol>${toc}</ol><a class="lall" href="#learn"><svg class="i"><use href="#i-back"/></svg>Все модули</a><a class="lall" href="#learn/gloss"><svg class="i"><use href="#i-book"/></svg>Словарь</a></details></nav>`
    + `<article class="panel doc lart"><div class="lmeta faint">Модуль ${n} · урок ${i + 1} из ${m.lessons.length} · ${learnMin(l.min)}</div>`
    + `<h2 id="lTitle" tabindex="-1">${l.title}</h2>`
    + (l.key?.length ? `<aside class="lkey" aria-labelledby="lKeyH"><h3 id="lKeyH">Главное</h3><ul>${l.key.map(k => `<li>${k}</li>`).join('')}</ul></aside>` : '') + l.body
    + (tries ? `<div class="ltry"><h3>Проверьте сами</h3>${l.tryLead ? `<p>${l.tryLead}</p>` : ''}<div class="lta">${tries}</div></div>` : '')
    + learnCheck(l, key) + learnSrc(l.src)
    + `<div class="lend"><button id="lDone" aria-pressed="${!!done}" title="${done ? `Отмечено ${fmtDay(Date.parse(done))}. Нажмите, чтобы снять отметку` : 'Отметка сохраняется в профиле'}">${done ? '<svg class="i"><use href="#i-check"/></svg>Пройдено' : 'Отметить пройденным'}</button>`
    + (nx ? `<a class="lnext" href="#learn/${m.id}/${nx.id}">Дальше: <b>${nx.title}</b></a>` : `<a class="lnext" href="#learn">Все модули</a>`) + '</div></article></div>';
}
function renderLearn() {
  const box = $('#learnBody');
  if (!LEARN) {
    // loading: the list's shape in grey; an error says so with a retry (the texts are a file of this site, not the network's)
    box.innerHTML = '<div class="lmods" aria-busy="true" aria-label="Загружаю уроки">' + '<div class="panel lmod lsk"><i></i><i></i><i></i><i></i></div>'.repeat(2) + '</div>';
    loadLearn().then(() => { if (hooks.page() === 'learn') renderLearn(); }, () => {
      if (hooks.page() !== 'learn') return;
      box.innerHTML = '<div class="banner bad"><svg class="i"><use href="#i-bad"/></svg><div><b>Не удалось загрузить уроки.</b> Проверьте интернет и попробуйте ещё раз. <div style="margin-top:8px"><button id="lRetry">Повторить</button></div></div></div>';
      $('#lRetry').onclick = renderLearn;
    });
    return;
  }
  tipHide();
  const gl = /^gloss(\/|$)/.test(learnPath);
  let x = gl ? null : learnLesson();
  if (learnPath && !x && !gl) { learnPath = ''; hooks.setHash(); }  // a lesson that isn't (or no longer is) there, or a module alone: the list
  box.innerHTML = gl ? learnGloss() : x ? learnPage(x) : learnList();
  learnTerms(box);
  hooks.setTitle();
  // a new lesson opened from a link inside the page: the keyboard goes on from its title, not from the top of the document;
  // a term of the dictionary (#learn/gloss/<id>, from a hint or the search): scrolled to, focused and flashed
  const term = gl && learnPath.split('/')[1], te = term && $('#g-' + term);
  if (te) setTimeout(() => { te.scrollIntoView({block:'center'}); te.focus({preventScroll:true}); te.classList.remove('flash'); void te.offsetWidth; te.classList.add('flash'); }, 50);
  else if (learnShown != null && learnShown !== learnPath && (x || gl)) $('#lTitle').focus({preventScroll:true});
  learnShown = learnPath;
  if (gl) $('#lgq').oninput = e => { const q = e.target.value.trim().toLowerCase(); let n = 0;
    box.querySelectorAll('.gdl>div').forEach(d => { const on = !q || d.dataset.s.includes(q); d.hidden = !on; n += on; }); $('#lgnone').hidden = n > 0; };
}
// «Проверьте сами» → the backtest form filled as the lesson says, then a run (as btFromProf + «Запустить»). Every field the
// lesson doesn't name is reset to the rules of PROFILE_DEF, so the run doesn't depend on what was in the form; the form is not
// saved anywhere, so the person's own settings (profiles, the bot) are untouched
const BT_STUDY_F = {fibK:'#btFibK', fibZone:'#btFibZone', fibStop:'#btFibStop', fibTarget:'#btFibTarget', obEntry:'#btObEntry', obSwing:'#btObSwing', fvgMin:'#btFvgMin', fvgLife:'#btFvgLife'};
function learnTry(t, x) {
  if (t?.go) return learnGo(t.go, x);
  if (!t?.bt) return;
  if (btBusy) { toast('Бэктест уже считает', 'Дождитесь конца прогона или прервите его на странице «Бэктест».', 'info', () => hooks.go('backtest')); return; }
  const b = t.bt, s = {...hooks.PROFILE_DEF, erMax:0.15, regimeSrc:'majors', ...b.set};
  for (const [k, sel] of Object.entries(BT_STUDY_F)) { const el = $(sel), d = [...el.options].find(o => o.defaultSelected) || el.options[0]; el.value = s[k] != null ? String(s[k]) : d.value; }
  if (b.coins) { $('#btTop').value = 'custom'; $('#btCustom').value = b.coins.join(', '); }
  else { $('#btTop').value = String(b.top || 20); $('#btPit').value = b.pit === 'now' ? 'now' : 'pit'; }
  if (b.from) { $('#btDays').value = 'custom'; $('#btFrom').value = b.from; $('#btTo').value = b.to; } else $('#btDays').value = String(b.days || 365);
  $('#btStart').value = String(b.start || 10000); $('#btHold').value = String(b.hold || 0.3);
  btFill(s);   // the rules, then btEstimate: the fields that depend on the selects show or hide
  hooks.go('backtest'); runBacktest();
  toast(`Урок «${x.l.title}»: запускаю бэктест`, `${t.label}. «Назад» в браузере вернёт к уроку.`, 'info', () => { location.hash = '#learn/' + x.key; });
}

// «Проверьте сами» → a coin on the market: go:{sym ('BTCUSDT'), mode ('ob' «Стакан», the default | 'ch' «Канал»), ind:[beta.js
// indicator ids], mkt ('fut' — the chart on futures, beta.js setMkt; optional)}. The indicators stay on (owner 11.11, docs/PLAN-LEARN.md): saved like a pick in the window, and the toast takes
// back only the ones the lesson turned on. «Назад» in the browser returns to the lesson (go('market') pushes the address)
async function learnGo(g, x) {
  const ind = g.ind || [], m = g.mode || 'ob';
  if (hooks.cmode() !== m) hooks.setCmode(m);
  hooks.openCoin(g.sym);
  if (m === 'ob' && !isPhone()) hooks.showOb();
  if (!ind.length) return;
  let betaMod, added, was = null;
  try { betaMod = await hooks.loadBeta(); added = await betaMod.setInd(ind); if (g.mkt) was = await betaMod.setMkt(g.mkt); }
  catch { toast('Не удалось включить индикатор', 'Проверьте интернет и нажмите кнопку урока ещё раз.', 'bad'); return; }
  const nm = ids => ids.map(i => `«${betaMod.indName(i)}»`).join(', '), ids = added.map(a => a.id);
  // go.mkt ('fut'): the chart switched to futures — said in the toast, and «убрать» puts the market back too
  const mk = was ? (g.mkt === 'fut' ? 'фьючерсы' : 'спот') : '';
  if (!added.length && !was) { toast(ind.length > 1 ? `Индикаторы ${nm(ind)} уже включены` : `Индикатор ${nm(ind)} уже включён`, '«Назад» в браузере вернёт к уроку.', 'info'); return; }
  const head = ids.length ? (ids.length > 1 ? `Включены индикаторы ${nm(ids)}` : `Включён индикатор ${nm(ids)}`) : '';
  toast(head ? head + (mk ? ` · ${mk}` : '') : `Открыты ${mk}`, `Урок «${x.l.title}». Нажмите здесь, чтобы убрать${was ? ` и вернуть ${was === 'fut' ? 'фьючерсы' : 'спот'}` : ''}; «Назад» в браузере вернёт к уроку.`, 'info',
    () => { betaMod.undoInd(added); if (was) betaMod.setMkt(was); }, 10000);
}

// ---------- changelog ----------
// the entries: CHANGELOG in changes.js (imported at the top)
let CHANGELOG_OLD = [], oldAsked = false;
const loadOldChangelog = () => { if (oldAsked) return; oldAsked = true; import('../changelog.js').then(m => { CHANGELOG_OLD = m.OLD; renderChangelog(); }).catch(() => { oldAsked = false; }); };
function renderChangelog() {
  $('#ver').textContent = 'v' + CHANGELOG[0].v;
  $('#ver').classList.toggle('fresh', load('sr_seenv', null) !== CHANGELOG[0].v);   // a dot until the latest version is seen
  const item = c => `<div class="cl-item"><div style="font-weight:600;font-size:16px"><span class="tag" style="margin-right:8px">v${c.v}</span>${c.title} <span class="faint" style="font-weight:400;font-size:12px">· ${c.date}</span></div>
     <ul>${c.items.map(i => `<li>${i}</li>`).join('')}</ul></div>`;
  // the latest three are open; older ones fold away so the page doesn't run for screens. Versions before 2.40 live in
  // changelog.js and come when the page is opened (loadOldChangelog), so the site's first load doesn't carry them
  const old = [...CHANGELOG.slice(3), ...CHANGELOG_OLD];
  $('#changelog').innerHTML = CHANGELOG.slice(0, 3).map(item).join('')
    + (old.length ? `<details class="clold"><summary>Ранние обновления <span class="mute">· ${old.length} ${plural(old.length, ['версия', 'версии', 'версий'])}, с v${old[old.length - 1].v} по v${old[0].v}</span></summary>${old.map(item).join('')}</details>` : '');
}

// what ran at load, at its old place in the page (the order of the document's listeners is kept)
function start(h) {
Object.assign(hooks, h);
$('#hGlossD').addEventListener('toggle', fillHelpGloss);
$('#learnBody').addEventListener('click', e => {
  const x = learnLesson();
  if (e.target.closest('#lDone') && x) {
    const P = learnProg(), done = {...P.done};
    if (done[x.key]) delete done[x.key]; else done[x.key] = new Date().toISOString().slice(0, 10);
    save('sr_learn', {done, last:done[x.key] ? x.key : P.last});
    renderLearn(); $('#lDone').focus();
    return;
  }
  const b = e.target.closest('[data-ltry]');
  if (b && x) learnTry(x.l.try[+b.dataset.ltry], x);
  const qa = e.target.closest('.lq [data-a]');
  if (qa && x) learnAnswer(qa, x);
  const d = e.target.closest('dfn[aria-expanded]');
  if (d) { if (tipFor === d && !hoverable.matches) tipHide(); else tipShow(d); }   // a mouse closes it by leaving, Esc or a click elsewhere
});
// the terms' hints: a mouse shows one on hover (and keeps it while the pointer is on the hint); keys and taps toggle it
const learnBox = $('#learnBody'), hoverable = matchMedia('(hover:hover)');
learnBox.addEventListener('mouseover', e => { if (!hoverable.matches) return;
  const d = e.target.closest('dfn[aria-expanded]'); if (d) tipLater(() => tipShow(d)); else if (e.target.closest('#lTip')) clearTimeout(tipTimer); });
learnBox.addEventListener('mouseout', e => { if (!hoverable.matches || !tipFor) return;
  if (e.target.closest('dfn[aria-expanded], #lTip') && !e.relatedTarget?.closest?.('#lTip, dfn[aria-expanded=true]')) tipLater(() => tipHide()); });
learnBox.addEventListener('keydown', e => {
  const d = e.target.closest('dfn[aria-expanded]');
  if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (tipFor === d) tipHide(); else tipShow(d); }
  if (e.key === 'Escape' && tipFor) { e.stopPropagation(); tipHide(true); }
});
learnBox.addEventListener('focusout', e => { if (tipFor && !e.relatedTarget?.closest?.('#lTip, dfn[aria-expanded=true]') && e.relatedTarget) tipHide(); });
document.addEventListener('click', e => { if (tipFor && !e.target.closest('dfn[aria-expanded], #lTip')) tipHide(); });
}

export {LEARN, GLOSS, loadLearn, learnPath, setLearnPath, learnLesson, renderLearn, renderChangelog, loadOldChangelog, start};
