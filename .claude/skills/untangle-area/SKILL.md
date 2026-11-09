---
name: untangle-area
description: Map one area of Sigma Radar (accounts and sync, server bot and Telegram, backtest, «Бета»…) for pieces that must change together without the code showing it, needless ties and surplus code, then design the fix behind several problems at once. Writes a decision log for the owner first; code changes only after the owner picks what to do. Use when the same kind of bug keeps coming back in one area, or before a big change there.
argument-hint: "[area, e.g. «профиль и синхронизация»]"
---

# Untangle one area

Method from caldoai/skills `untangle-codebase` (MIT, © 2026 Maze), cut down for this codebase: a live single-page site
(`index.html` ~5k lines, `beta.js`), shared strategy math (`supabase/functions/_shared/math.js`), Edge Functions and SQL,
almost no automated tests, and other sessions pushing several versions a day. So: one area per run, a plan before any
edit, small releases.

Most bugs of 2.63–2.75 were of one kind — pieces that had to change together while nothing showed it (the table saving
its filters on every redraw into the synced profile; Telegram unlinking written twice, in `ub_tg_me` and in `tg.ts`; the
profile's server bot known only through a synced key). That is what this skill looks for.

## 1. Map the area (no edits)

Scope: the area in the argument, or ask. Grep for its entry points, read only their ranges (CLAUDE.md «Working
economically»). Follow every piece of state it touches: globals (`grep -n "^let " index.html`), `sr_*` keys and the
`SYNC` list, `rpc('…')` and the SQL behind it (`supabase/*.sql`), the functions in `supabase/functions/`, timers,
reloads. Use `git log -p --follow` / `git log --stat` on the area's files as evidence of what changes together and of
the fixes that keep coming back; read the area's section of `docs/LESSONS.md` — repeated rows point at one root cause.

For each pair of pieces ask: **should these change together?** Write down every place the code answers wrong:

**Hidden links** — must change together, the code doesn't show it:
- a copy of logic or a value in two places (site and SQL, site and Edge Function, two handlers);
- a module that reads a global, an `sr_*` key or a table row another one sets, with nothing tying them;
- a list kept by hand next to the things it lists (`SYNC`, per-device keys, `PAGES`, `CHANGELOG` rules);
- an order of calls or a convention callers just have to know (save before render, reload after sign-in…).

**Needless links** — tied together, change for different reasons:
- callers that reach into another part's internals;
- stable code (math.js, SQL functions) depending on something more volatile;
- a general function with a parameter or branch only one caller understands.

**Surplus** — no reason of its own to change: pass-through wrappers, options nothing sets, dead code (grep for callers
across index.html, beta.js, the functions, SQL and the research scripts before calling anything dead).

**Special cases** — code for one situation instead of following from the design: an `if` for one value, a parameter for
one caller, a swallowed `catch`, a retry or a `setTimeout` waiting for something to be ready, a guard like «not more
than once in 15 s». Each is a requirement the design never accounted for.

Keep comments that explain something outside the code (Binance, Telegram, Safari, Supabase behaviour, a lesson): this
codebase uses them on purpose. Don't delete the checks in `tests/`.

## 2. Redesign

Work out the fixes as if today's requirements had been known from the start. Look for the one change behind several
problems — it often looks nothing like them. Check each fix: what changes together ends up together, what doesn't
isn't tied, everything depends on what changes less (math.js and SQL change least, the page most). Don't fix special
cases one by one; note which ones the redesign removes and which the system still needs.

## 3. Decision log for the owner

Write `docs/PLAN-UNTANGLE-<area>.md` (Russian, plain words, like the other plans): each fix, then the problems it solves
(`file:line` — what is wrong), then for each fix: what the user would notice (ideally nothing), the risk, whether it needs
a migration (the owner's explicit «да» per migration), and how it will be checked. Order by value against risk. Commit it
and show the owner a short summary; **stop here** until the owner picks the fixes.

## 4. Fix, in small releases

One fix (or a few small related ones) per version, each:
- behaviour stays the same apart from bugs the fix removes — say exactly what was checked;
- `math.js` touched → `tests/math.html?ref=_ref/math.js` with the old copy saved first, every check passing;
- buttons that change state touched → the `click-path-audit` skill on them;
- smoke at 320 / 375 / desktop plus `read_console_messages`; SQL checked live (grants, RLS, a wrong caller refused);
- rebase on `main` before pushing (other sessions push often), then `bash scripts/after-push.sh <version>`;
- changelog in the users' style, `docs/AUDIT-STATE.md`, a `docs/LESSONS.md` row per trap, the plan's status updated.

## 5. Re-check

After the chosen fixes: search the area again (a fresh subagent works well) for hidden links, needless links, surplus and
special cases. Done when a typical change in the area lands in one place, nothing depends on something more volatile
than itself, and no finding left is worth its risk. Record what was left on purpose, and why, in the plan.
