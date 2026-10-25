# Sigma Radar

- Site: single `index.html` (ES module); strategy math in `supabase/functions/_shared/math.js`, shared with the Edge Function `supabase/functions/bot`.
- Design/UX rules: follow `docs/DESIGN-RULES.md`; run its checklist (section 12) before every push.
- Colours only through CSS tokens (`:root` = dark, `:root[data-theme=light]`); canvas code reads them via `pal()` into `PC`.
- Local preview: `serve.ps1` (http://localhost:8765). Pushing to `main` auto-deploys to Vercel and reloads open tabs.
- After changing `math.js`: open `tests/math.html?ref=_ref/math.js` in the preview (the previous copy saved to `tests/_ref/math.js` first); every check must pass.
- Changelog (`CHANGELOG` in index.html) is for users: what changed for them, no implementation details.
- Problems hit and how they were fixed: `docs/LESSONS.md`. Read it before big changes; add a row with every non-trivial fix.
