# Карта проекта для новичка

Что где лежит и как части связаны. Правила работы — `CLAUDE.md`, грабли — `docs/LESSONS.md` (короткий список сверху),
текущее состояние и открытые пункты — `docs/AUDIT-STATE.md`. Сверено с кодом 12.11.2026 (2.110); при большой перестройке
обновить вместе с ней.

## Сайт (Vercel, пуш в `main` → выкладка)

| Файл | Что в нём |
|---|---|
| `index.html` (~6 тыс. строк, ES-модуль) | весь сайт: разделы `#market` (рынок и графики), `#journal` (бот и журнал), `#backtest`, `#learn`, `#help`, `#changes`, `#legal`; вход и синхронизация профиля; браузерный бот; CSP в `<meta>` (новый внешний хост — в `connect-src`); `CHANGELOG` |
| `beta.js` | графики раздела «Рынок»: свечи, стакан, тепловая карта, список монет; догрузка истории при прокрутке влево |
| `history.js` | чтение копии свечей Binance из Cloudflare R2 для бэктеста (`docs/PLAN-HISTORY.md`) |
| `learn.js` | тексты уроков (`docs/PLAN-LEARN.md`) |
| `changelog.js` | старые записи «Что нового» (до 2.40), грузится при открытии |
| `fonts/` | свои шрифты (Manrope, JetBrains Mono) |
| `vercel.json`, `.vercelignore` | заголовки и что не выкладывать (`.claude/`, исходник функции `auth`) |

Цвета — только CSS-токены (`:root` тёмная, `:root[data-theme=light]`), холст читает их через `pal()` → `PC`.
Правила дизайна — `docs/DESIGN-RULES.md` (чек-лист — раздел 12).

## Общая математика

`supabase/functions/_shared/math.js` — одна копия для сайта и сервера: анализ канала (`analyze`, `bands`), сигналы и вход
(`wants`, `levels`, `planEntry`), выход (`checkExit`), сделка и издержки (`closeTrade`, `borrowedOf`, `borrowAt`), шаг бота
(`botTick`), бэктест (`backtest`), случайный вход для сравнения (`randomSetup`), режим рынка (`regimeOf`, `marketOn`),
учебные стратегии (Фибоначчи, SMC), отпечаток расчёта (`fingerprint`). Любая правка — с `tests/math.html?ref=_ref/math.js`;
правка бэктеста или `botTick` — ещё и с `tests/backtest-audit.js`.

## Сервер (Supabase)

- **Функция `bot`** (`supabase/functions/bot/index.ts`) — раз в минуту её вызывает `pg_cron` (`supabase/cron.sql`):
  общий бот (таблицы `positions`, `trades`, `bot_state`, запись через `bot_commit`), затем личные боты по профилям
  (`user_bots`, `user_positions`, `user_trades`, запись через `ub_commit`), сообщения в Telegram.
- **Функция `tg`** — Telegram-бот (вебхук); логика в `_shared/tg.ts`.
- **Функция `auth`** — вход через Telegram (`docs/PLAN-ACCOUNTS.md`), `_shared/login.ts`.
- Функции выкладывает GitHub Actions при пуше в `supabase/functions` (`.github/workflows/deploy-functions.yml`);
  нужную им миграцию — применить до пуша.
- SQL: `schema.sql` (таблицы), `security.sql`, `hardening.sql` (права и RLS), `cron.sql`, `telegram.sql`, `alerts.sql`,
  файлы `2026-MM-*.sql` — миграции по датам. Права на функции — только `authenticated` и `service_role`.

## Данные

- Свечи для сайта — прямо с Binance из браузера.
- История для бэктеста — копия в R2: каждую ночь `.github/workflows/history.yml` → `scripts/history-job.js`
  (итог последнего прогона — `status.json` в бакете). Из R2 читают `history.js` и исследования.
- Коллектор `server/` (Railway: стаканы, тепловая карта) **отключён** с 12.11: `SERVER = ''` в `beta.js`,
  `SCAN_URL = ""` в `bot/index.ts`, хоста нет в CSP. Как вернуть — `docs/AUDIT-STATE.md`.

## Проверки

- `serve.ps1` — локальный сервер на http://localhost:8765 (R2 отдаёт CORS только этому порту).
- `tests/smoke.js` — вёрстка на 320 / 375 / десктоп; запуск из консоли превью (см. `CLAUDE.md`).
- `tests/math.html` — математика против прежней копии `tests/_ref/math.js`.
- `tests/backtest-audit.js` — пересчёт сделок, нет ли заглядывания вперёд, бот против бэктеста (инструкция в шапке).
- `tests/alerts.html` — уведомления.
- После пуша: `bash scripts/after-push.sh <версия>`.

## Документы

- `docs/PLAN-*.md` — планы волн (статус и передача между сессиями); `docs/PLAN-V3.md` — дорожная карта.
- `docs/RESEARCH-*.md` — исследования торговых идей; `docs/LITERATURE.md` — литература до любой новой гипотезы.
- `docs/AUDIT-*.md`, `docs/REVIEW-*.md` — аудиты и разборы внешних ревью.
- `research/` — стенды исследований (не часть сайта).
- `.claude/skills/` — навыки `click-path-audit` и `untangle-area`; `.claude/settings.json` — хук проверки кодировки.
