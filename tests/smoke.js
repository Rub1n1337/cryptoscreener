// One-call layout checks for the preview, instead of several scripts and screenshots per width and theme:
//   await (await import('/tests/smoke.js?' + Date.now())).run()
// Returns a short report: version, width, theme, horizontal scroll, what sticks out of the screen, cut text (including the
// short card titles drawn by ::after, which scrollWidth doesn't see), touch targets under 36 px on touch screens, and
// browser-storage keys that index.html's KEYS doesn't declare (keys), modules imported at start without a modulepreload
// link (preload), modules that read the storage at load without app/account.js in their import chain (early).
// Errors are not here: read_console_messages has them, including the ones before this loads.
const sel = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const ctx = document.createElement('canvas').getContext('2d');
const textW = (s, txt) => { ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`; return ctx.measureText(txt).width; };

export async function run({ limit = 8 } = {}) {
  const W = document.documentElement.clientWidth, all = [...document.querySelectorAll('body *')].filter(shown);
  // horizontal scroll areas (tables) and fixed layers may be wider than the screen on purpose
  const scrollers = all.filter(el => /auto|scroll|hidden/.test(getComputedStyle(el).overflowX));
  const inScroller = el => scrollers.some(s => s !== el && s.contains(el));
  const out = { v: document.querySelector('#ver')?.textContent, page: location.hash || '#', w: W,
    theme: document.documentElement.dataset.theme || 'dark', hscroll: document.documentElement.scrollWidth > W + 1 };
  out.overflow = all.filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > W + 1 || r.left < -1) && !inScroller(el) && getComputedStyle(el).position !== 'fixed'; })
    .slice(0, limit).map(el => `${sel(el)} ${Math.round(el.getBoundingClientRect().left)}…${Math.round(el.getBoundingClientRect().right)}`);
  out.cut = all.filter(el => {
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) return true;
    const a = getComputedStyle(el, '::after'), c = a.content;
    return /^".+"$/.test(c) && s.fontSize === '0px' && textW(a, c.slice(1, -1)) > el.clientWidth + 0.5;
  }).slice(0, limit).map(el => `${sel(el)} «${(el.textContent.trim() || getComputedStyle(el, '::after').content).slice(0, 24)}»`);
  if (matchMedia('(pointer: coarse)').matches) out.small = all.filter(el => el.matches('button, a[href], select, input:not([type=hidden]), [role=button]'))
    .map(el => [el.matches('input') && el.closest('label') || el, el])   // a checkbox inside its label: the label is what is tapped
    .map(([t, el]) => [el, t.getBoundingClientRect()]).filter(([el, r]) => r.width && r.height < 36 && !el.closest('#cmdk'))
    .slice(0, limit).map(([el, r]) => `${sel(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
  // every browser-storage key is declared «profile» or «device» (KEYS in index.html): a new one is not synced, or kept, by accident
  const K = window.__sr?.KEYS;
  if (K) { const unk = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('sr_') && !(k in K)) unk.push(k); } if (unk.length) out.keys = unk; }
  // every module imported at start (the page's and theirs, static imports only) has a <link rel=modulepreload>: the auto-update
  // compares exactly those files (UPDATE_FILES), so a module missing there would change without open tabs noticing
  const pre = new Set([...document.querySelectorAll('link[rel=modulepreload]')].map(l => new URL(l.href).pathname)), seen = new Set(), miss = [];
  const imports = (txt, base) => [...txt.matchAll(/^\s*import\s[^'"()]*?['"]([^'"]+)['"]/gm)].map(m => new URL(m[1], base));
  const page = await (await fetch(location.pathname, { cache: 'no-store' })).text();
  let todo = [...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].flatMap(m => imports(m[1], location.href));
  const deps = {}, early = [];
  while (todo.length) {
    const u = todo.shift(); if (u.origin !== location.origin || seen.has(u.pathname)) continue; seen.add(u.pathname);
    if (!pre.has(u.pathname)) miss.push(u.pathname);
    try {
      const txt = await (await fetch(u.pathname)).text(), d = imports(txt, u.href);
      deps[u.pathname] = d.map(x => x.pathname); todo.push(...d);
      if (/^(?:export\s+)?(?:let|const|var)\s[^\n]*\bload\(\s*'sr_/m.test(txt)) early.push(u.pathname);
    } catch {}
  }
  if (miss.length) out.preload = miss;
  // a module that reads the browser storage at load must wait for the profile: app/account.js awaits it at its top level, so it
  // has to be in the module's import chain (docs/PLAN-UNTANGLE-modules.md 3.2), else it may read before the profile's values
  const ACC = '/app/account.js', reaches = (p, s = new Set()) => p === ACC || (!s.has(p) && (s.add(p), (deps[p] || []).some(q => reaches(q, s))));
  const lateLoad = early.filter(p => p !== ACC && !(deps[p] || []).some(q => reaches(q)));
  if (lateLoad.length) out.early = lateLoad;
  return out;
}
