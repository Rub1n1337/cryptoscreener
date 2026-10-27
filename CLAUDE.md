# Sigma Radar

- Site: single `index.html` (ES module); strategy math in `supabase/functions/_shared/math.js`, shared with the Edge Function `supabase/functions/bot`.
- Edge Functions `bot` and `tg` deploy from GitHub Actions on push to `main` (`.github/workflows/deploy-functions.yml`); apply a migration they need before pushing. Run status: `https://api.github.com/repos/Rub1n1337/cryptoscreener/actions/runs?per_page=1`.
- Design/UX rules: follow `docs/DESIGN-RULES.md`; run its checklist (section 12) before every push.
- Colours only through CSS tokens (`:root` = dark, `:root[data-theme=light]`); canvas code reads them via `pal()` into `PC`.
- Local preview: `serve.ps1` (http://localhost:8765). Pushing to `main` auto-deploys to Vercel and reloads open tabs.
- After changing `math.js`: open `tests/math.html?ref=_ref/math.js` in the preview (the previous copy saved to `tests/_ref/math.js` first); every check must pass.
- Changelog (`CHANGELOG` in index.html) is for users: what changed for them, no implementation details.
- Problems hit and how they were fixed: `docs/LESSONS.md`. Before work read its short checklist at the top, then grep the section of the area you touch (the whole file is ~36 KB); add a row with every non-trivial fix.

## Working economically
- `index.html` is ~4.5k lines: find places with grep, read only ranges (sed -n / Read offset+limit). Never read or cat it whole; same for `beta.js`, `math.js`, `bot/index.ts` unless the whole file is the task.
- Text with Cyrillic or other non-ASCII: change it with Edit only, never perl/sed substitutions.
- Checks in the preview: `await (await import('/tests/smoke.js?' + Date.now())).run()` at 320 / 375 / desktop (horizontal scroll, overflow, cut text, small touch targets) plus `read_console_messages`; own assertions in the same call; screenshots only for visual changes, at scale ≤ 0.6. A hidden preview pane stops `requestAnimationFrame` — wait with setTimeout in scripts.
- After a push: `bash scripts/after-push.sh <version>` waits for Vercel and the functions deploy and prints one line each.
- One session per plan wave (`docs/PLAN-*.md` keeps the status and is the hand-off); a long session gets compacted and loses detail.
- After changing `math.js`: `tests/math.html?ref=_ref/math.js`. After a push: check the served version (Vercel can miss a push).
