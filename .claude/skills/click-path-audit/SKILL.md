---
name: click-path-audit
description: Trace every button in one area of Sigma Radar through all the state it changes (globals, sr_* storage, server rpc, timers, re-render) to find handlers that undo each other, races and state that doesn't survive a reload. Use before shipping changes to buttons that change state, or when "the button works but the result is wrong".
---

# Click-path audit

Finds bugs that reading one function at a time misses: each call works, but together the final state is not what the
button label promises. Idea from the ECC skill of the same name (MIT); rewritten for this codebase.

Scope it to one area per run (e.g. «Мой бот», журнал, бэктест, «Бета»): grep for handlers, read only their ranges.

## Where state lives here

- **Globals in index.html** (`grep -n "^let " index.html`): `S` settings, `J` journal, `SJ`/`jMode` shared journal,
  `BP` bot profiles, `UB` (server bot id+secret) and `SB_MINE` (its journal), `rows`/`cache` scan, chart vars
  (`chartSym`, `chartView`, `chartReq`), backtest (`btRes`, `btBusy`, `btCtl`). beta.js keeps its own (`cfg`, panes, streams).
- **Browser storage**: `save('sr_…')` / `load('sr_…')` — what survives a reload and what other tabs see.
- **Server**: `rpc('ub_…')`, `bot_commit` / `ub_commit` (one transaction), `reset_n` against stale bot steps.
- **Timers and async**: `syncTimer`, scan and bot ticks, request counters (`chartReq`, `lastReq`) that drop stale replies.
- **Navigation**: `go()`, `readHash()`, `#coin/SYM` vs `#market/SYM`, modals with `modalBack`.

## Steps

1. **Side-effect map** for the area. One line per function the handlers call:
   `name → reads {…} · writes {…} · RESETS {…} · saves sr_… · rpc … · starts/clears timer … · async?`
   Mark every function that resets or overwrites state it does not own.
2. **Each touchpoint** (button, toggle, menu item, keyboard shortcut, confirm dialog):
   list its calls in order, then answer:
   - Does a later call undo an earlier one (re-render from a stale variable, a reset inside a "select" helper)?
   - Can an async reply or a timer land after the user moved on and write old state back (`syncTimer` after delete or
     reset, a scan reply for the previous coin, a backtest finishing after «Прервать»)?
   - Double click / tap while busy: two requests, two positions, two toasts?
   - Cancel path of `confirm()` and the error path of `rpc` / `fetch` (offline, 429, forbidden): is the UI left half-changed?
   - After F5: is the state the same as right after the click (memory vs `sr_*` vs server)?
   - Another tab open: does it overwrite `sr_journal` / `sr_ubot` with its older copy?
   - Back button / hash: does it reopen something that was just deleted or closed?
3. **Prove it in the preview** (localhost:8765): click via the tools, then in one `javascript_tool` call assert the
   globals, `localStorage`, the DOM text, and — for server paths — the rpc result; reload and assert again. Simulate
   failures by wrapping `window.fetch` for one call. Wait with `setTimeout`, not `requestAnimationFrame` (hidden pane).

## Output

| Touchpoint (file:line) | Label promises | Actual final state | Verdict |
|---|---|---|---|

Verdicts: BUG (with the conflicting calls named), RACE, NOT PERSISTED, OK. Fix the bugs, add a row to
`docs/LESSONS.md` for each non-trivial one, and leave OK rows out of the report to the owner.
