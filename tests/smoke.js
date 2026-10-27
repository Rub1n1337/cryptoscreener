// One-call layout checks for the preview, instead of several scripts and screenshots per width and theme:
//   await (await import('/tests/smoke.js?' + Date.now())).run()
// Returns a short report: version, width, theme, horizontal scroll, what sticks out of the screen, cut text (including the
// short card titles drawn by ::after, which scrollWidth doesn't see), touch targets under 36 px on touch screens.
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
  return out;
}
