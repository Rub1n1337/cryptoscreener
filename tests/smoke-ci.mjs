// tests/smoke.js headless at 320 / 375 / 1280 px, signed out (the sign-in screen, #legal) and signed in on a fake server —
// used by .github/workflows/tests.yml, so a session doesn't have to run smoke in the preview by hand before every release.
//   node tests/smoke-ci.mjs http://localhost:8000/index.html
// Nothing leaves the runner except the page's own files: Supabase answers from here (a made-up session, an empty profile, no
// bot), Binance from tests/fixtures/binance.json (the runner may get 429 or 451 from the real one), everything else is
// aborted, WebSocket is a stub that never connects. Red when smoke reports hscroll, overflow, cut or small (touch targets on
// the phone widths), or the page throws / logs an error — except failed loads of the aborted hosts.
import { chromium } from 'playwright';
import { appendFileSync, readFileSync } from 'node:fs';

const base = process.argv[2] || 'http://localhost:8000/index.html';
const summary = process.env.GITHUB_STEP_SUMMARY;
const note = s => { console.log(s); if (summary) appendFileSync(summary, s + '\n'); };
const FX = JSON.parse(readFileSync(new URL('./fixtures/binance.json', import.meta.url), 'utf8'));

const WIDTHS = [
  { name: '320', viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true },
  { name: '375', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  { name: '1280', viewport: { width: 1280, height: 800 } },
];
const OUT = ['market', 'legal'];   // signed out every address but #legal is the sign-in screen
const IN = ['market', 'journal', 'backtest', 'learn', 'help', 'changes', 'legal'];

// ---------- the fake Supabase ----------
const UID = '00000000-0000-4000-8000-00000000c1c1';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.ci`;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
function supabase(route, req) {
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  const p = new URL(req.url()).pathname;
  if (p.startsWith('/auth/v1/')) return json(route, { access_token: jwt(), refresh_token: 'ci-refresh', expires_in: 86400, token_type: 'bearer', user: { id: UID } });
  if (p.startsWith('/functions/v1/')) return json(route, {});
  if (p.startsWith('/rest/v1/rpc/')) return json(route, null);   // ub_mine → no bot, state_put, tg_bot_name …
  const t = p.slice('/rest/v1/'.length);
  if (t === 'profiles') return json(route, [{ tg_name: 'CI', tg_username: 'ci' }]);
  if (t === 'bot_state') return json(route, [{ balance: 10000, start_balance: 10000, settings: {}, checked_at: new Date().toISOString(), last_error: null, scanned: 0, regime: null }]);
  return json(route, []);   // user_state, positions, trades, bot_runs …
}

// ---------- Binance from the fixture: times moved to now, candles scaled to each coin's price ----------
const TF = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '8h': 288e5, '12h': 432e5, '1d': 864e5, '3d': 2592e5, '1w': 6048e5 };
const BTC = +FX.klines.at(-1)[4];
const price = sym => +(FX.ticker.find(x => x.symbol === sym)?.lastPrice || BTC);
function klines(q) {
  const tf = TF[q.get('interval')] || 36e5, n = Math.min(+q.get('limit') || 500, FX.klines.length), k = price(q.get('symbol')) / BTC;
  const last = Math.floor(Date.now() / tf) * tf, src = FX.klines.slice(-n), f = v => String(+v * k);
  return src.map((r, i) => { const t = last - (n - 1 - i) * tf; return [t, f(r[1]), f(r[2]), f(r[3]), f(r[4]), r[5], t + tf - 1, r[7], r[8], r[9], r[10], '0']; });
}
function binance(route, req) {
  const u = new URL(req.url()), q = u.searchParams, now = Date.now();
  if (u.pathname === '/api/v3/ticker/24hr') return json(route, FX.ticker.map(x => ({ ...x, openTime: now - 864e5, closeTime: now })));
  if (u.pathname === '/api/v3/ticker/price') return json(route, FX.ticker.map(x => ({ symbol: x.symbol, price: x.lastPrice })));
  if (u.pathname === '/api/v3/klines') return json(route, klines(q));
  if (u.pathname === '/api/v3/depth') {
    const p = price(q.get('symbol')), lv = s => Array.from({ length: 50 }, (_, i) => [String(p * (1 + s * (i + 1) * 4e-4)), String(1 + (i * 7 % 13))]);
    return json(route, { lastUpdateId: 1, bids: lv(-1), asks: lv(1) });
  }
  return route.abort();
}

const BLOCKED = /binance|supabase\.co|r2\.dev|railway\.app/;
async function open(browser, w, signedIn) {
  const ctx = await browser.newContext({ viewport: w.viewport, isMobile: !!w.isMobile, hasTouch: !!w.hasTouch, deviceScaleFactor: 1, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.addInitScript(({ signedIn, at }) => {
    // the page's own world (javascript_tool's isolated world can't do this, docs/LESSONS.md 16.11)
    if (!sessionStorage.getItem('ci-init')) {
      sessionStorage.setItem('ci-init', '1');
      localStorage.clear();
      localStorage.setItem('sr_intro', 'true');
      if (signedIn) localStorage.setItem('sr_auth', JSON.stringify({ at, rt: 'ci-refresh', exp: Date.now() + 864e5 }));
    }
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } addEventListener() {} removeEventListener() {} };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }, { signedIn, at: jwt() });
  await ctx.route(/^https:\/\/[^/]*supabase\.co\//, supabase);
  await ctx.route(/^https:\/\/(data-api\.binance\.vision|api\.binance\.com)\//, binance);
  await ctx.route(url => BLOCKED.test(url.hostname) && !/supabase\.co$|data-api\.binance\.vision$|api\.binance\.com$/.test(url.hostname), r => r.abort());
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e.message || e).split('\n')[0]));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const at = m.location()?.url || '';
    if (/^Failed to load resource/.test(m.text()) && (BLOCKED.test(at) || !at)) return;   // an aborted request of a mocked host
    errors.push('console: ' + m.text().slice(0, 300) + (at ? ` (${at.split('?')[0]})` : ''));
  });
  return { ctx, page, errors };
}
const settle = page => page.waitForFunction(() => !document.querySelector('#refresh.busy'), null, { timeout: 30_000, polling: 250 }).catch(() => {}).then(() => page.waitForTimeout(1200));

const browser = await chromium.launch();
let bad = 0;
for (const signedIn of [false, true]) for (const w of WIDTHS) {
  const { ctx, page, errors } = await open(browser, w, signedIn), label = `${signedIn ? 'signed in' : 'signed out'} · ${w.name}px`;
  const lines = [], checked = [];
  try {
    await page.goto(base + '#market');
    await page.waitForFunction(() => document.querySelector('#ver')?.textContent, null, { timeout: 30_000 });
    await settle(page);
    for (const t of signedIn ? IN : OUT) {
      if (t !== 'market') { await page.evaluate(h => { location.hash = h; }, '#' + t); await settle(page); }
      // the run is only worth something if it looked at the right page: signed in really signed in, the market filled from the fixture
      const want = signedIn || t === 'legal' ? t : 'gate';
      const seen = await page.evaluate(() => ({ shown: [...document.querySelectorAll('main > section, body > section, section[id]')].filter(s => !s.classList.contains('hidden') && s.getClientRects().length).map(s => s.id), rows: document.querySelectorAll('#tb tr').length }));
      if (!seen.shown.includes(want)) lines.push(`- #${t}: expected section #${want}, shown: ${seen.shown.join(', ') || 'none'}`);
      if (signedIn && t === 'market' && seen.rows < 10) lines.push(`- #market: ${seen.rows} rows in the table — the fake Binance didn't reach the scan`);
      const r = await page.evaluate(async () => (await import('/tests/smoke.js?' + Date.now())).run());
      checked.push(`${t}${t === 'market' && signedIn ? ` (${seen.rows} rows)` : ''}`);
      const issues = ['hscroll', 'overflow', 'cut', 'small'].filter(k => k === 'hscroll' ? r.hscroll : r[k]?.length);
      if (issues.length) lines.push(`- ${r.page} (${r.v}, ${r.theme}): ` + issues.map(k => k === 'hscroll' ? 'hscroll' : `${k}: ${r[k].join('; ')}`).join(' · '));
      if (r.keys) console.log(`  note ${label} ${r.page}: storage keys not in KEYS: ${r.keys.join(', ')}`);
    }
  } catch (e) { lines.push('- did not finish: ' + String(e.message || e).split('\n')[0]); }
  for (const e of [...new Set(errors)]) lines.push('- ' + e);
  if (lines.length) { bad++; note(`### ✗ smoke ${label}`); lines.forEach(l => note(l)); for (const l of lines) console.log(`::error title=smoke ${label}::${l.slice(2)}`); }
  else { note(`### ✓ smoke ${label}: clean — ${checked.join(', ')}`); console.log(`::notice title=smoke ${label}::clean: ${checked.join(', ')}`); }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
