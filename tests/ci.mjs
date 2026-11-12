// Runs the browser test pages headless and fails when any check fails — used by .github/workflows/tests.yml.
// Each page sets window.__TEST = {pass, fail, failed} when it is done (tests/math.html, tests/alerts.html).
//   node tests/ci.mjs http://localhost:8000/tests/math.html http://localhost:8000/tests/alerts.html
// A page that throws before it is done, or takes longer than 5 minutes, fails too.
import { chromium } from 'playwright';
import { appendFileSync } from 'node:fs';

const pages = process.argv.slice(2);
const summary = process.env.GITHUB_STEP_SUMMARY;
const note = s => { console.log(s); if (summary) appendFileSync(summary, s + '\n'); };
const browser = await chromium.launch();
let bad = 0;
for (const url of pages) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  let res = null;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.__TEST, null, { timeout: 300_000, polling: 1000 });
    res = await page.evaluate(() => window.__TEST);
  } catch (e) { errors.push(String(e.message || e).split('\n')[0]); }
  const name = new URL(url).pathname + new URL(url).search;
  if (!res || res.fail || errors.length) {
    bad++;
    note(`### ✗ ${name}: ${res ? `${res.fail} of ${res.pass + res.fail} failed` : 'did not finish'}`);
    for (const f of res?.failed || []) note(`- FAIL ${f}`);
    for (const e of errors) note(`- error: ${e}`);
  } else note(`### ✓ ${name}: all ${res.pass} passed`);
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
