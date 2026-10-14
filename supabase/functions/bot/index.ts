// Shared 24/7 paper-trading bot + personal 24/7 bots. Called every minute by pg_cron (see supabase/cron.sql).
// All strategy math lives in ../_shared/math.js — the same file the site uses.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as M from "../_shared/math.js";
import { COMMANDS, SITE, coin, dur, esc, fp, handleUpdate, pct, rr, usd } from "../_shared/tg.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];

// every exchange call has a deadline: one hanging request must not hold the whole minute (the run would be killed and the next one skipped).
// When Binance says "too many requests" (429) or bans the address for a while (418), stop asking until it allows again:
// carrying on is what turns a minute's ban into hours. The pause outlives a run while the function instance stays warm.
const PAUSE: Record<string, number> = {};
async function api(path: string) {
  let err: unknown;
  for (const b of BASES) {
    if (Date.now() < (PAUSE[b] || 0)) { err = new Error("Binance просит подождать (" + b + ")"); continue; }
    try {
      const r = await fetch(b + path, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status === 418) PAUSE[b] = Date.now() + Math.min(600, Math.max(30, Number(r.headers.get("retry-after")) || 60)) * 1000;
      err = new Error("HTTP " + r.status + " " + b);
    } catch (e) { err = e; }
  }
  throw err;
}
// the 24 h ticker (the coin list) is kept too: when one request fails (a 418 can hit a shared outgoing address for a moment),
// the run uses the last list if it is under 15 minutes old instead of losing the whole minute
// (the shared bot and the personal bots both ask for it within a run: one request of weight 80 serves both)
let TICKER: { t: number; d: any } | null = null;
async function ticker24() {
  if (TICKER && Date.now() - TICKER.t < 30_000) return TICKER.d;
  try { const d = await api("/api/v3/ticker/24hr"); TICKER = { t: Date.now(), d }; return d; }
  catch (e) { if (TICKER && Date.now() - TICKER.t < 15 * 60_000) return TICKER.d; throw e; }
}
// candles are kept between runs while the function instance stays warm, as compact numeric rows [time, open, high, low, close, volume];
// the next minute fetches only the newest 3 bars of each coin and splices them in (a fresh instance downloads everything once).
// Supabase usually starts the function fresh for every call, so in practice this cache lives one run (docs/PLAN-NOTIFY.md).
// Re-downloading hundreds of coins × 450 bars every minute was most of a run's time and of Binance's request weight.
// maxAge: candles refreshed less than this long ago are returned as they are (the same array, so analyses of it can be reused):
// signals that only notify (not trades) on 1h/4h/1d don't need a fresh request every minute — see LAZY
const KC = new Map<string, { K: number[][]; limit: number; used: number; at: number; view?: number[][] }>();
let kcSwept = 0;
const compact = (K: any[]) => K.map((k: any) => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
async function candles(sym: string, tf: string, limit: number, maxAge = 0): Promise<number[][]> {
  const key = sym + "|" + tf, st = KC.get(key), tfms = (M.TFMS as any)[tf], now = Date.now();
  if (now - kcSwept > 60_000) { kcSwept = now; for (const [k, v] of KC) if (now - v.used > 600_000) KC.delete(k); }   // coins nobody asked for in 10 min
  if (st && maxAge && st.limit >= limit && now - st.at < maxAge && now - st.K[st.K.length - 1][0] < tfms) {
    st.used = now;
    if (!st.view || st.view.length !== Math.min(limit, st.K.length)) st.view = st.K.slice(-limit);
    return st.view;
  }
  if (st && st.K.length && st.limit >= limit && now - st.K[st.K.length - 1][0] < 2 * tfms) {
    const N = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=3`));
    if (N.length && N[0][0] <= st.K[st.K.length - 1][0]) {   // overlaps the kept bars: no gap
      const K = st.K.filter((k) => k[0] < N[0][0]).concat(N).slice(-st.limit), view = K.slice(-limit);
      KC.set(key, { K, limit: st.limit, used: now, at: now, view });
      return view;
    }
  }
  const K = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`));
  KC.set(key, { K, limit, used: now, at: now, view: K });
  return K;
}
// how stale notify-only candles may be: a signal stays enterable for 5 candles (5–20 h on 1h/4h), so a few minutes' delay
// costs nothing, while refreshing hundreds of coins every minute was most of a run's requests
const LAZY: Record<string, number> = { "5m": 0, "15m": 0, "1h": 3 * 60_000, "4h": 5 * 60_000, "1d": 15 * 60_000 };
// requests in flight at once: with candles kept, a run is ~600 tiny requests whose time is all waiting for Binance;
// 25 at a time stays far below its limits (a request weighs 1 of 6000 a minute) and a 429 pauses the host anyway
const PAR = 25;
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- analyses from the collector (server/scan.js on Railway) ----------
// This function starts fresh every minute, so the candle cache above rarely outlives a run. The collector runs all the time:
// it keeps the candles, tops them up and answers with the analyses — one request instead of hundreds. Only if both sides
// run the same math (M.fingerprint) are its answers used; whatever it doesn't answer is done here as before.
const SCAN_URL = "https://cryptoscreener-production-f6ba.up.railway.app/scan";
let FPRINT = "";
const RSTAT = { calls: 0, rows: 0, ms: 0, err: "" };   // reported in the response, to watch it
const rkey = (sym: string, S: any) => `${sym}|${S.tf}|${S.method}|${S.N}|${S.k}`;
type Groups = Map<string, { S: any; syms: Set<string> }>;
function addTask(groups: Groups, S: any, syms: string[]) {
  const k = `${S.tf}|${S.method}|${S.N}|${S.k}`;
  if (!groups.has(k)) groups.set(k, { S, syms: new Set() });
  for (const s of syms) groups.get(k)!.syms.add(s);
}
// lazy: for notifications only, the collector may use candles a few minutes old (see LAZY)
async function remote(groups: Groups, lazy: boolean, now: number, out: Map<string, any>, timeout: number) {
  if (!groups.size) return;
  FPRINT ||= M.fingerprint();
  const tasks = [...groups.values()].map((g) => ({ tf: g.S.tf, method: g.S.method, N: g.S.N, k: g.S.k, syms: [...g.syms], lazy }));
  const t0 = Date.now();
  try {
    const r = await fetch(SCAN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fp: FPRINT, now, tasks }), signal: AbortSignal.timeout(timeout) });
    // T½ = ∞ can't travel in JSON: it comes as "__Infinity"
    const j = JSON.parse(await r.text(), (_k, v) => typeof v === "string" && v.startsWith("__") ? Number(v.slice(2)) : v);
    if (j.error || !Array.isArray(j.rows)) throw new Error(j.error || "no rows");
    let n = 0;
    tasks.forEach((t, i) => { for (const [sym, row] of Object.entries(j.rows[i] || {})) if (row) { out.set(rkey(sym, t), row); n++; } });
    RSTAT.calls++; RSTAT.rows += n; RSTAT.ms += Date.now() - t0;
  } catch (e) { RSTAT.err = String((e as Error)?.message ?? e).slice(0, 120); }
}

// ---------- Telegram (optional: one bot, token in public.tg_config; chats subscribe with /start, see README) ----------
let TG: any;   // tg_config, read once per run
async function tgConf() { if (TG === undefined) { const { data } = await db.from("tg_config").select("*").eq("id", 1).maybeSingle(); TG = data?.enabled && data.bot_token ? data : null; } return TG; }
async function tgCall(method: string, body: unknown) {
  const tg = await tgConf(); if (!tg) return null;
  const r = await fetch(`https://api.telegram.org/bot${tg.bot_token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return await r.json().catch(() => null);
}
const FOOT = `\n\n<i>бумажная торговля · не финансовый совет</i>`;
// syms: up to 3 coins get a button that opens the coin's chart on the site; under them — the notification settings
// ("+n": opens them as a new message, so the signal itself stays in the chat)
// the link is percent-encoded: a coin named in Chinese would otherwise make Telegram refuse the whole message
const keyboard = (syms: string[]) => {
  const coins = [...new Set(syms.map((s) => s.replace(/USDT$/, "")))].slice(0, 3);
  return { inline_keyboard: [
    ...(coins.length ? [coins.map((c) => ({ text: `📈 ${c}`, url: `${SITE}/#market/${encodeURIComponent(c)}` }))] : []),
    [{ text: "🔔 Уведомления", callback_data: "+n" }, { text: "🤖 Мой бот", callback_data: "+m" }],
  ] };
};
// one message to one chat; returns its id (0 if it wasn't sent), so it can be updated later.
// reply: answer that message (a short follow-up that rings, unlike an edit); such follow-ups go without buttons and footer
// chats in their quiet hours right now: messages still come, without a sound (alerts.quiet, see quietNow)
const QUIET = new Set<string>();
async function tgSend(chat: number | string, text: string, syms: string[] = [], reply = 0): Promise<number> {
  if (!(await tgConf())) return 0;
  try {
    const base: any = { chat_id: chat, text: reply ? text : text.slice(0, 3900) + FOOT, parse_mode: "HTML", disable_web_page_preview: true,
      ...(QUIET.has(String(chat)) ? { disable_notification: true } : {}),
      ...(reply ? { reply_parameters: { message_id: reply, allow_sending_without_reply: true } } : {}) };
    let r = await tgCall("sendMessage", reply ? base : { ...base, reply_markup: keyboard(syms) });
    if (r && !r.ok && r.error_code === 400 && !reply) r = await tgCall("sendMessage", base);   // buttons refused: send without them
    if (r && !r.ok && r.error_code === 403) { await db.from("tg_subs").delete().eq("chat_id", chat); return 0; }   // the user blocked the bot
    // what happened to the last message in this chat, so a "nothing came" can be checked
    const { data: s } = await db.from("tg_subs").select("sent_n").eq("chat_id", chat).maybeSingle();
    if (s) await db.from("tg_subs").update(r?.ok ? { last_ok: new Date().toISOString(), last_err: null, sent_n: (s.sent_n || 0) + 1 } : { last_err: String(r?.description || "нет ответа").slice(0, 200) }).eq("chat_id", chat);
    return r?.ok ? Number(r.result?.message_id) || 0 : 0;
  } catch { return 0; }   // notifications must never break trading
}
async function tgEdit(chat: number | string, mid: number, text: string, syms: string[] = []) {
  try { await tgCall("editMessageText", { chat_id: chat, message_id: mid, text: text.slice(0, 3900) + FOOT, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard(syms) }); }
  catch { /* an old or deleted message just stays as it was */ }
}
async function sendTo(chats: (number | string)[], lines: string[], syms: string[] = []) {
  if (!lines.length || !chats.length) return;
  for (const chat of [...new Set(chats.map(String))]) await tgSend(chat, lines.join("\n\n"), syms);
}
// who gets the shared bot's trades: every subscribed chat that kept them on (plus the owner's old single chat, if set)
async function chatsFor(kind: "shared") {
  const tg = await tgConf(); if (!tg) return [];
  const { data } = await db.from("tg_subs").select("chat_id").eq(kind, true);
  return [...(data ?? []).map((x: any) => x.chat_id), ...(kind === "shared" && tg.chat_id ? [tg.chat_id] : [])];
}
const notify = async (lines: string[], syms: string[] = []) => sendTo(await chatsFor("shared"), lines, syms);

// commands and button presses from Telegram: the "tg" function answers them at once (a webhook); this registers it
// (with the command menu), and until that works reads them here once a minute (getUpdates)
const UPDATES = ["message", "callback_query"];
async function tgPoll() {
  const tg = await tgConf(); if (!tg) return;
  // registered: check every 10 minutes that it still is (a new token after /revoke has no webhook yet)
  if (tg.wh_ok) { if (new Date().getUTCMinutes() % 10) return; const i = await tgCall("getWebhookInfo", {}); if (!i?.ok || i.result?.url) return; }
  const wh = await tgCall("setWebhook", { url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/tg`, secret_token: tg.wh_secret, allowed_updates: UPDATES });
  if (wh?.ok) { await tgCall("setMyCommands", { commands: COMMANDS }); await db.from("tg_config").update({ wh_ok: true }).eq("id", 1); return; }
  const r = await tgCall("getUpdates", { offset: Number(tg.upd_offset || 0) + 1, timeout: 0, allowed_updates: UPDATES });
  if (!r?.ok || !r.result?.length) return;
  for (const u of r.result) {
    try { await handleUpdate(db, u, (m: string, b: Record<string, unknown>) => tgCall(m, b).catch(() => null)); }
    catch { /* one bad update must not stop the others */ }
  }
  await db.from("tg_config").update({ upd_offset: r.result[r.result.length - 1].update_id }).eq("id", 1);
}

// what a chat was already told: `sent` maps "<feed>SYM:touchTime" to the time it was sent (a number), or for the bot's own
// signals ("s:") to {t, st: stage, mid: message id}; entries are kept 3 days
function pruneSent(sent: Record<string, any>, now: number) {
  for (const k of Object.keys(sent)) { const v = sent[k]; if (now - (typeof v === "number" ? v : Number(v?.t) || 0) > 3 * 864e5) delete sent[k]; }
}
// signals at the threshold not announced yet (`sent` is updated in place);
// the very first call only remembers what is there, so nobody gets a pile of old signals ("_init" marks that it has run)
// pre: a separate memory inside the same object (the "Рынок" feed uses "m:"), with its own first-run marker
// win: while the price stays beyond the band every new candle is a new touch; touches this close to an announced one are the
// same episode and are not announced again
function freshSignals(rows: any[], min: number, sent: Record<string, any>, now: number, pre = "", win = 0) {
  const told = (r: any) => !!sent[`${pre}${r.sym}:${r.touchTime}`] || (win > 0 && Object.keys(sent).some((k) => {
    if (!k.startsWith(`${pre}${r.sym}:`)) return false;
    const t = Number(k.slice(pre.length + r.sym.length + 1)); return Math.abs(t - r.touchTime) <= win;
  }));
  const fresh = rows.filter((r) => r.score != null && r.score >= min && r.touchTime && !told(r)).sort((a, b) => b.score - a.score);
  const first = !sent["_init" + pre];
  for (const r of fresh) sent[`${pre}${r.sym}:${r.touchTime}`] = now;
  pruneSent(sent, now);
  sent["_init" + pre] = now;
  return first ? [] : fresh;
}
// one signal: side and coin first, then where the price is and why it counts; last — how long it can still be entered
// (a touch counts for M.TOUCH_BARS candles) and whether the coin springs back to the centre on this timeframe (T½)
const sigLine = (tf: string) => (r: any) => {
  const long = r.side === "low", toMid = (r.mid / r.price - 1) * 100, tfms = (M.TFMS as any)[tf];
  const left = r.touchTime + M.TOUCH_BARS * tfms - Date.now(), hlMs = r.hl * tfms;
  const hl = !isFinite(hlMs) || hlMs >= 30 * 864e5 ? "тренд ⚠️" : `${dur(hlMs)}${r.hl <= 20 ? " ✅" : r.hl > 40 ? " ⚠️" : ""}`;
  return `${long ? "🟢" : "🔴"} <b>${long ? "LONG" : "SHORT"} ${coin(r.sym)}</b> · сила <b>${r.score}</b>\n` +
    `цена ${fp(r.price)} · до центра ${toMid >= 0 ? "+" : "−"}${Math.abs(toMid).toFixed(1)}%\n` +
    `RSI ${Math.round(r.rsi)} · объём ${r.volX ? "×" + r.volX.toFixed(1) : "—"} · ${r.rev ? "✔ отскок подтверждён" : "⏳ ждём подтверждения"}\n` +
    `⌛ войти можно ещё ${left > 6e4 ? dur(left) : "минуту"} · T½ ${hl}` + (r.lv ? `\n🎯 цель ${fp(r.lv.tp)} (${pct(r.lv.tp, r.lv.e)}) · 🛑 стоп ${fp(r.lv.sl)} (${pct(r.lv.sl, r.lv.e)})` : "") +
    (r.botNote ? `\n${r.botNote}` : "");
};
// why the profile's own bot passes a signal at its threshold — so a signal it doesn't take is not a mystery
function whyNot(r: any, S: any, nOpen: number) {
  const mode = M.modeOf(r, S), reg = M.regimeOf(r.mkt, S), only = S.regimeOnly || "any";
  if (mode === "none") return "рынок падает — «переключатель» в падении не торгует";
  if (mode === "breakout_long") return "рынок растёт — «переключатель» берёт только пробои вверх";
  if (only === "flat" && reg !== "flat") return "профиль торгует только в боковике";
  if (only === "impulse" && (reg == null || reg === "flat")) return "профиль торгует только в импульсе";
  if (S.coinErMax && mode !== "breakout" && r.er >= S.coinErMax) return "монета сама в тренде (фильтр профиля)";
  if (!r.rev) return "разворот не подтверждён";
  if (S.longOnly && r.side === "up") return "профиль торгует только LONG";
  if (mode === "revert_trend" && !(r.side === "low" ? r.slope > 0 : r.slope < 0)) return "отскок против тренда канала";
  if (S.minWidth && !((r.up - r.lo) / r.mid * 100 >= S.minWidth)) return `канал уже ${S.minWidth}% (фильтр профиля)`;
  if (S.maxHL && !(isFinite(r.hl) && r.hl <= S.maxHL)) return `T½ ${isFinite(r.hl) ? Math.round(r.hl) + " свечей" : "— тренд"}, а в профиле T½ ≤ ${S.maxHL}`;
  if (nOpen >= M.slotsOf(S)) return `заняты все места (${M.slotsOf(S)})`;
  return "до центра осталось мало места или по монете недавно была сделка";
}
// a signal message: title, the rules it follows in one grey line, up to 15 signals
const sigMsg = (title: string, rules: string, list: any[], tf: string) =>
  [`${title}\n<i>${rules}</i>`, ...list.slice(0, 15).map(sigLine(tf)), ...(list.length > 15 ? [`…и ещё ${list.length - 15} — на сайте`] : [])];
// who: "общий бот" or "ваш бот «…»"
const openedMsg = (p: any, who = "общий бот") =>
  `${p.side === "LONG" ? "🟢" : "🔴"} <b>${p.side} ${coin(p.sym)}</b> — ${who} вошёл\n` +
  `вход <b>${fp(p.entry)}</b>\n🎯 тейк ${fp(p.tp)} (${pct(p.tp, p.entry)})\n🛑 стоп ${fp(p.sl)} (${pct(p.sl, p.entry)})\n` +
  `<i>${esc(String(p.note || "").replace(/^«[^»]*» · /, ""))} · риск $${p.risk.toFixed(2)}</i>`;
const WHY: Record<string, string> = { "тейк": "по тейку", "стоп": "по стопу", "тайм-стоп": "по времени", "вручную": "вручную" };
const closedMsg = (t: any, who = "общий бот") =>
  `${t.pnl > 0 ? "✅" : "❌"} <b>${t.side} ${coin(t.sym)}</b> — ${who} закрыл ${WHY[t.reason] || esc(t.reason)}\n` +
  `${fp(t.entry)} → ${fp(t.exit)} · <b>${usd(t.pnl)}</b>${rr(t.r)}\n` +
  `<i>в сделке ${dur(t.tclose - t.time)} · комиссия $${t.fee.toFixed(2)}</i>`;

// ---------- shared bot ----------
async function run() {
  const now = Date.now();
  const { data: st, error: e1 } = await db.from("bot_state").select("*").eq("id", 1).single();
  if (e1) throw e1;
  const S = st.settings;
  const { data: open, error: e2 } = await db.from("positions").select("*");
  if (e2) throw e2;
  const list = M.pickSymbols(await ticker24(), S.top, open!.map((p: any) => p.sym), now);

  // analyses from the collector; candles here only for open positions (their exits) and for coins it didn't answer
  const klines: Record<string, unknown[]> = {}, rows: any[] = [], RM = new Map<string, any>(), groups: Groups = new Map();
  addTask(groups, S, list);
  await remote(groups, false, now, RM, 15_000);
  const limit = Math.min(1000, S.N + 150), held = new Set(open!.map((p: any) => p.sym));
  await pool(list, PAR, async (sym) => {
    try {
      let r = RM.get(rkey(sym, S));
      if (!r || held.has(sym)) { const K = await candles(sym, S.tf, limit); if (held.has(sym)) klines[sym] = K; r ||= M.analyze(sym, K, S, now, true); }
      if (r) rows.push(r);
    } catch { /* skip pair */ }
  });

  const { data: recent } = await db.from("trades").select("sym").gt("tclose", now - M.COOLDOWN * M.TFMS[S.tf]);
  const res = M.botTick({ rows, klines, open: open!, recentSyms: (recent ?? []).map((x: any) => x.sym), balance: st.balance, S, now });

  if (res.closed.length) {
    // ignoreDuplicates: if a previous run wrote the trade but failed to remove the position, it closes again here — once
    const { error } = await db.from("trades").upsert(res.closed, { onConflict: "id", ignoreDuplicates: true }); if (error) throw error;
    const { error: e3 } = await db.from("positions").delete().in("id", res.closed.map((x: any) => x.id)); if (e3) throw e3;
  }
  const upserts = [...res.stillOpen, ...res.opened];
  if (upserts.length) { const { error } = await db.from("positions").upsert(upserts); if (error) throw error; }
  await db.from("bot_state").update({ balance: res.balance, checked_at: new Date(now).toISOString(), scanned: rows.length, last_error: null }).eq("id", 1);
  await notify([...res.closed.map((t: any) => closedMsg(t)), ...res.opened.map((p: any) => openedMsg(p))], [...res.opened, ...res.closed].map((x: any) => x.sym));
  return { scanned: rows.length, signals: rows.filter((r) => M.wants(r, S)).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length, ticker: undefined as any };
}

// ---------- personal bots (one per browser; config = profiles chosen on the site) ----------
let AN = 0;   // coin analyses in the last run of the personal bots (reported in the response, to watch the load)
const AW = new WeakMap<object, Map<string, any>>();   // analyses of a kept candle array, reused while it is not refreshed (lazy candles)
const PROFILE_DEF = { method: "log", N: 210, k: 3, tf: "15m", minScore: 60, strategy: "revert", rr: 0, risk: 0.02, lev: 1, minWidth: 0, maxHL: 0, longOnly: false, coinErMax: 0 };
// the config comes from the visitor's browser: every value is re-checked before it drives requests or sizing
const num = (v: unknown, a: number, b: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
const oneOf = <T,>(v: unknown, ok: readonly T[], d: T) => (ok as readonly unknown[]).includes(v) ? v as T : d;
function cleanSet(s: any = {}) {
  const D = PROFILE_DEF;
  return { method: oneOf(s.method, ["log", "classic", "robust", "ewma"], D.method), N: Math.round(num(s.N, 20, 300, D.N)), k: num(s.k, 1, 5, D.k),
    tf: oneOf(s.tf, ["5m", "15m", "1h", "4h", "1d"], D.tf), minScore: num(s.minScore, 0, 100, D.minScore),
    strategy: oneOf(s.strategy, Object.keys(M.STRATEGIES), D.strategy), rr: num(s.rr, 0, 10, 0), risk: num(s.risk, 0.001, 0.05, D.risk),
    lev: num(s.lev, 1, 10, 1), minWidth: num(s.minWidth, 0, 30, 0), maxHL: num(s.maxHL, 0, 500, 0), longOnly: s.longOnly === true,
    coinErMax: num(s.coinErMax, 0, 1, 0), regimeOnly: oneOf(s.regimeOnly, ["any", "flat", "impulse"], "any"),
    timeStop: oneOf(s.timeStop === undefined ? 48 : Number(s.timeStop), [0, 24, 48, 96], 48),
    maxOpen: oneOf(s.maxOpen === undefined ? M.MAX_OPEN : Number(s.maxOpen), M.SLOTS, M.MAX_OPEN) };
}
// a linked chat's notification settings (user_bots.alerts, see supabase/alerts.sql), re-checked like the config
const SIG_TOPS = [0, 50, 100, 150, 250];
function alertsOf(b: any) {
  const a = b.alerts && typeof b.alerts === "object" ? b.alerts : {}, s = a.sig && typeof a.sig === "object" ? a.sig : {}, m = a.mkt, q = a.quiet;
  return {
    // quiet hours in the owner's time zone (tz: minutes east of UTC, set by the site; Moscow when unknown)
    quiet: q && typeof q === "object" && q.on ? { from: Math.round(num(q.from, 0, 23, 23)), to: Math.round(num(q.to, 0, 23, 8)), tz: Math.round(num(q.tz, -720, 840, 180)) } : null,
    sig: { on: s.on !== false, top: oneOf(Math.round(Number(s.top) || 0), SIG_TOPS, 0), when: oneOf(s.when, ["confirmed", "touch"], "confirmed"), long: s.sides === "long" },
    mkt: m && typeof m === "object" && m.on !== false ? {
      method: oneOf(m.method, ["log", "classic", "robust", "ewma"], "log"), N: Math.round(num(m.N, 20, 300, 210)), k: num(m.k, 1, 5, 3),
      tf: oneOf(m.tf, ["5m", "15m", "1h", "4h", "1d"], "4h"), minScore: num(m.minScore, 40, 100, 60), top: Math.round(num(m.top, 10, 400, 150)) } : null,
  };
}
const quietNow = (q: any) => {
  if (!q) return false;
  const h = Math.floor(((Date.now() / 6e4 + q.tz) % 1440 + 1440) % 1440 / 60);
  return q.from <= q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
};
const tfOf = (ms: number) => Object.keys(M.TFMS).find((k) => (M.TFMS as any)[k] === ms);
const effN = (len: number, S: any) => (S.tf === "1d" || S.tf === "1w") ? Math.max(20, Math.min(S.N, len - 20)) : S.N;
// market regime the same way the site does it: BTC/ETH/SOL on 1h, efficiency ratio over 7 days
async function majorsRegime() {
  const got: Record<string, any> = {};
  await Promise.all(M.MAJORS.map(async (s: string) => {
    try {
      const c = (await candles(s, "1h", 200)).map((k) => k[4]), L = 168, i = c.length - 1;
      let path = 0; for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
      got[s] = { er: path ? Math.abs(c[i] - c[i - L]) / path : 0, ch: c[i] / c[i - L] - 1 };
    } catch { /* regime falls back to BTC-only or null */ }
  }));
  const m: any = M.marketOf((s: string) => got[s] || null);
  if (m) m.by = got;
  return m;
}
async function runUserBots(now: number, reqStart: number) {
  // fair queue: the least recently checked bots go first, so with more bots than fit in one run every bot still gets its turn;
  // bots whose owner hasn't opened the site for 30 days are not scheduled
  const { data: bots } = await db.from("user_bots").select("id, config, balance, tg_chat, alerts, sig_sent").eq("enabled", true)
    .gt("last_seen", new Date(now - 30 * 864e5).toISOString()).order("checked_at", { ascending: true, nullsFirst: true }).limit(40);
  QUIET.clear();   // recomputed per chat below, each run
  if (!bots?.length) return 0;
  const reg = await majorsRegime(), ticker = await ticker24();
  // one request per coin + timeframe for all bots in this run (compact candles, see candles()); lazy: notify-only, may be minutes old
  const kc = new Map<string, Promise<any>>();
  const getK = (s: string, tf: string, lazy = false) => {
    const key = s + "|" + tf;
    if (!kc.has(key)) kc.set(key, candles(s, tf, 450, lazy ? LAZY[tf] || 0 : 0).catch(() => null));
    return kc.get(key)!;
  };
  // one analysis per coin + channel settings for all bots (most share them); the bots don't need the site's display extras.
  // Unchanged candles (lazy) keep their analyses from earlier runs, so only refreshed coins cost CPU.
  // Analyses the collector sent (RM) come first; a coin it didn't answer is fetched and analysed here.
  const ac = new Map<string, any>(), RM = new Map<string, any>();
  let computed = 0;
  const analyzeK = (s: string, K: any, S: any) => {
    const key = rkey(s, S);
    if (ac.has(key)) return ac.get(key);
    if (RM.has(key)) { ac.set(key, RM.get(key)); return ac.get(key); }
    if (!K?.length) return null;
    let memo = AW.get(K); if (!memo) AW.set(K, memo = new Map());
    if (!memo.has(key)) { memo.set(key, M.analyze(s, K, { ...S, N: effN(K.length, S) }, now, true)); computed++; }
    ac.set(key, memo.get(key));
    return ac.get(key);
  };
  // a CPU budget per run: the function is stopped by the platform when it computes too much (WORKER_RESOURCE_LIMIT),
  // which also loses the shared bot's minute. Trading comes first for every bot; signals (only notifications) use what is left,
  // so a big signal scan can delay a message by a minute but never a bot's entry or exit.
  const BUDGET = 1800;   // coin analyses computed per run (~1 s of CPU)
  const over = (t: number) => Date.now() - reqStart > t || computed > BUDGET;
  AN = 0;
  let done = 0;
  const later: any[] = [];   // bots whose signals are checked after everyone's trading
  // what each bot trades by this minute: the profile (in "auto" — by the market), its settings and coins
  const plan = (b: any) => {
    const cfg = b.config || {}, profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    if (!profiles.length) return null;
    const byId = (id: string) => profiles.find((p: any) => p.id === id) || profiles[0];
    const erMax = num(cfg.erMax, 0.05, 0.5, 0.15);
    const regName = M.regimeOf(reg, { erMax, regimeSrc: "majors" });
    const P = cfg.mode === "auto" ? byId(regName === "flat" ? cfg.flat : cfg.impulse) : byId(cfg.active);
    const S = { ...cleanSet(P.set), regimeSrc: "majors", erMax };
    const pname = String(P.name ?? "Профиль").replace(/[<>&"'`]/g, "").slice(0, 60);
    const own = Array.isArray(P.coins?.list) ? P.coins.list.filter((s: unknown) => typeof s === "string" && /^[A-Z0-9]{2,20}USDT$/.test(s)).slice(0, 200) : [];
    const list: string[] = P.coins?.mode === "list" && own.length ? own : M.pickSymbols(ticker, Math.round(num(P.coins?.top, 20, 200, 150)), [], now);
    return { P, S, pname, list, regName };
  };
  // every bot's coins in one request to the collector
  const plans = new Map<string, any>(), tradeGroups: Groups = new Map();
  for (const b of bots) { try { const x = plan(b); if (x) { plans.set(b.id, x); addTask(tradeGroups, x.S, x.list); } } catch { /* the loop below reports it */ } }
  await remote(tradeGroups, false, now, RM, 15_000);
  for (const b of bots) {
    // the deadline counts from the start of the whole request (the shared bot ran first): the run lock lasts 120 s, and a run
    // that outlives it would overlap the next minute's. The rest go first next minute.
    if (over(70_000)) break;
    try {
      const x = plans.get(b.id) ?? plan(b);
      if (!x) {   // still mark it checked, or it would stay first in the queue forever
        await db.from("user_bots").update({ checked_at: new Date(now).toISOString(), last_error: "нет профилей" }).eq("id", b.id);
        continue;
      }
      const { P, S, pname, list, regName } = x;
      const { data: pr } = await db.from("user_positions").select("data").eq("bot_id", b.id);
      const open = (pr ?? []).map((x: any) => x.data);
      const Ks: Record<string, any> = {};
      await pool(list.filter((s: string) => !RM.has(rkey(s, S))), PAR, async (s) => { Ks[s] = await getK(s, S.tf); });
      const rows = list.map((s) => analyzeK(s, Ks[s], S)).filter(Boolean);
      const exitK: Record<string, any> = {};
      for (const p of open) exitK[p.sym] = await getK(p.sym, tfOf(p.tfms) || S.tf);
      const { data: rec } = await db.from("user_trades").select("data").eq("bot_id", b.id).gt("tclose", now - M.COOLDOWN * (M.TFMS as any)[S.tf]);
      const res = M.botTick({ rows, klines: exitK, open, recentSyms: (rec ?? []).map((x: any) => x.data.sym), balance: b.balance, S, now, market: reg });
      for (const p of res.opened) { p.note = `«${pname}» · ${p.note}`; p.snap.profile = pname; }
      if (res.closed.length) {
        // a trade is only removed from the open positions once it is written: a failed write must not lose it (it closes again next minute)
        const { error: ei } = await db.from("user_trades").upsert(res.closed.map((t: any) => ({ bot_id: b.id, id: t.id, tclose: t.tclose, data: t })), { onConflict: "bot_id,id", ignoreDuplicates: true });
        if (ei) throw ei;
        const { error: ed } = await db.from("user_positions").delete().eq("bot_id", b.id).in("id", res.closed.map((t: any) => t.id));
        if (ed) throw ed;
      }
      const keep = [...res.stillOpen, ...res.opened];
      if (keep.length) { const { error: eu } = await db.from("user_positions").upsert(keep.map((p: any) => ({ bot_id: b.id, id: p.id, data: p }))); if (eu) throw eu; }
      await db.from("user_bots").update({ balance: res.balance, checked_at: new Date(now).toISOString(), active_profile: pname,
        regime: reg ? { state: regName, by: reg.by } : null, last_error: null }).eq("id", b.id);
      if (b.tg_chat) {
        if (quietNow(alertsOf(b).quiet)) QUIET.add(String(b.tg_chat));
        await sendTo([b.tg_chat], [
          ...res.closed.map((t: any) => closedMsg(t, `ваш бот «${esc(pname)}»`)),
          ...res.opened.map((p: any) => openedMsg(p, `ваш бот «${esc(pname)}»`))], [...res.opened, ...res.closed].map((x: any) => x.sym));
        later.push({ b, P, S, pname, list, rows, res });
      }
      done++;
    } catch (e) {
      await db.from("user_bots").update({ last_error: String((e as Error)?.message ?? e), checked_at: new Date(now).toISOString() }).eq("id", b.id);
    }
  }
  // ---- signals: only for bots with a linked chat, after all trading. A bot skipped here (time or budget) is not lost:
  // a signal is remembered only once it is sent, so it comes next minute while it is still fresh
  // the wider tops and "Рынок" scans of all linked chats in one request too (lazy: candles may be minutes old)
  const sigGroups: Groups = new Map();
  for (const { b, P, S, list } of later) {
    const A = alertsOf(b);
    if (A.sig.on && A.sig.top > list.length && P.coins?.mode !== "list") addTask(sigGroups, S, M.pickSymbols(ticker, A.sig.top, [], now));
    if (A.mkt) addTask(sigGroups, A.mkt, M.pickSymbols(ticker, A.mkt.top, [], now));
  }
  await remote(sigGroups, true, now, RM, 15_000);
  for (const { b, P, S, pname, list, rows, res } of later) {
    if (over(80_000)) break;
    try {
      const A = alertsOf(b), sent = b.sig_sent || {}, chat = b.tg_chat;
      if (A.sig.on) await mySignals(A.sig, sent, chat, P, S, pname, list, rows, res);
      if (A.mkt) await marketSignals(A.mkt, sent, chat, S);
      if (A.sig.on || A.mkt) await db.from("user_bots").update({ sig_sent: sent }).eq("id", b.id);
    } catch { /* signals must never break trading */ }
  }
  AN = computed;
  return done;

  // the bot's own signals: the same rules it trades by, on its coins or a wider top (for trading by hand).
  // One message per episode — while the price stays beyond the band every new candle is a new touch, and touches of the same side
  // within TOUCH_BARS candles of each other are one episode. The message is updated as it develops: 1 — touched, waiting for the
  // reversal; 2 — reversal confirmed; 3 — the bot entered. If a confirmed bounce fails (the price is beyond the band again) it says
  // so and goes back to waiting. An edit doesn't ring, so a confirmation of a signal sent at the touch also comes as a short reply.
  async function mySignals(A: any, sent: any, chat: any, P: any, S: any, pname: string, list: string[], rows: any[], res: any) {
    const sigMin = Math.max(40, S.minScore), inList = new Set(list);   // a floor of 40: a profile with no threshold would message every touch
    const tfms = (M.TFMS as any)[S.tf], win = M.TOUCH_BARS * tfms;
    let sigRows = rows;
    if (A.top > list.length && P.coins?.mode !== "list") {
      const wide = M.pickSymbols(ticker, A.top, [], now).filter((s: string) => !inList.has(s)), KW: Record<string, any> = {};
      await pool(wide.filter((s: string) => !RM.has(rkey(s, S))), PAR, async (s) => { KW[s] = await getK(s, S.tf, true); });
      sigRows = [...rows, ...wide.map((s: string) => analyzeK(s, KW[s], S)).filter(Boolean)];
    }
    const entered = new Map<string, number>([...res.stillOpen, ...res.opened].map((p: any) => [p.sym, p.time]));
    const first = !sent["_init:s"];
    sent["_init:s"] = now;
    // the episode a touch belongs to: the same touch, or an earlier one of this coin and side close enough to it
    const episode = (r: any) => {
      const exact = sent[`s:${r.sym}:${r.touchTime}`];
      if (exact && typeof exact === "object") return exact;
      for (const k of Object.keys(sent)) {
        if (!k.startsWith(`s:${r.sym}:`)) continue;
        const v = sent[k];
        if (v && typeof v === "object" && (!v.sd || v.sd === r.side) && Math.abs(Number(k.slice(r.sym.length + 3)) - r.touchTime) <= win) return v;
      }
      return null;
    };
    const fresh: any[] = [], upd: any[] = [];
    for (const r of sigRows) {
      if (!r.touchTime || r.score == null) continue;
      const key = `s:${r.sym}:${r.touchTime}`, prev = episode(r);
      const stage = inList.has(r.sym) && (entered.get(r.sym) ?? 0) >= r.touchTime ? 3 : r.rev ? 2 : 1;
      if (prev) {
        const newTouch = prev.tt != null && prev.tt !== r.touchTime;
        sent[key] = prev; prev.tt = r.touchTime; prev.t = now;
        if (stage > prev.st) upd.push({ r, prev, stage });
        else if (newTouch && prev.st === 2 && stage === 1) upd.push({ r, prev, stage, failed: true });   // the bounce didn't hold
        continue;
      }
      if (r.score < sigMin || (A.long && r.side !== "low") || (A.when === "confirmed" && stage < 2)) continue;
      fresh.push({ r, key, stage });
    }
    const note = (r: any, stage: number) => !inList.has(r.sym) ? `✋ для ручной торговли: бот торгует топ-${list.length}, по этой монете не войдёт`
      : stage === 3 ? "🤖 бот вошёл в сделку" : entered.has(r.sym) ? "🤖 бот уже в сделке по этой монете"
      : stage === 1 ? "🤖 бот ждёт подтверждения разворота" : `🤖 бот не войдёт: ${whyNot(r, S, entered.size)}`;
    // levels as the bot would set them now (the regime decides the strategy for "переключатель")
    const text = (r: any, stage: number, failed = false) => {
      const x = { ...r, mkt: r.mkt ?? reg }, lv = stage < 3 ? M.levels(x, S) : null;
      return `📡 <b>«${esc(pname)}»</b> · ${S.tf}\n${sigLine(S.tf)({ ...x, lv, botNote: note(r, stage) })}` +
        (failed ? "\n⚠️ <b>отскок не удержался</b>: цена снова за границей канала — ждём нового подтверждения" : "");
    };
    fresh.sort((a, b) => b.r.score - a.r.score);
    let n = 0;
    const rest: any[] = [];
    for (const x of fresh) {
      // the first run only remembers; a signal the bot entered on at once is told by the trade message itself
      let mid = 0;
      if (!first && x.stage < 3) { if (n++ < 6) mid = await tgSend(chat, text(x.r, x.stage), [x.r.sym]); else rest.push(x); }
      sent[x.key] = { t: now, st: x.stage, mid, sd: x.r.side, tt: x.r.touchTime };
    }
    // more than 6 at once: the rest in one list, without updates
    if (rest.length) await sendTo([chat], sigMsg(`📡 <b>Ещё сигналы «${esc(pname)}»</b>`, `${S.tf} · сила от ${sigMin}`, rest.map((x) => ({ ...x.r, botNote: note(x.r, x.stage) })), S.tf), rest.map((x) => x.r.sym));
    for (const x of upd) {
      if (x.prev.mid && !first) {
        await tgEdit(chat, x.prev.mid, text(x.r, x.stage, x.failed), [x.r.sym]);
        const what = x.failed ? "отскок не удержался, ждём нового подтверждения" : x.prev.st === 1 ? `разворот подтверждён${x.stage === 3 ? ", бот вошёл" : ""}` : "";
        if (what) await tgSend(chat, `${x.failed ? "⚠️" : "✔"} <b>${x.r.side === "low" ? "LONG" : "SHORT"} ${coin(x.r.sym)}</b> — ${what}`, [], x.prev.mid);
      }
      x.prev.st = x.stage;
    }
    pruneSent(sent, now);
  }
  // the "Рынок" filter: its own channel settings, saved explicitly; confirmed reversals only, in one list per run.
  // A coin the bot's own signals already told about (same timeframe, same touch) is not repeated
  async function marketSignals(SM: any, sent: any, chat: any, S: any) {
    const lst = M.pickSymbols(ticker, SM.top, [], now), KM: Record<string, any> = {}, win = M.TOUCH_BARS * (M.TFMS as any)[SM.tf];
    await pool(lst.filter((s) => !RM.has(rkey(s, SM))), PAR, async (s) => { KM[s] = await getK(s, SM.tf, true); });
    const told = new Map<string, number[]>();
    if (SM.tf === S.tf) for (const k of Object.keys(sent)) if (k.startsWith("s:")) { const [, s, t] = k.split(":"); told.set(s, [...(told.get(s) || []), +t]); }
    const rowsM = lst.map((s) => analyzeK(s, KM[s], SM)).filter((r: any) => r?.rev && !(told.get(r.sym) || []).some((t) => Math.abs(t - r.touchTime) <= win));
    const mktSigs = freshSignals(rowsM, SM.minScore, sent, now, "m:", win).map((r: any) => ({ ...r, lv: M.levels({ ...r, mkt: reg }, SM) }));
    if (mktSigs.length) await sendTo([chat], sigMsg("🔔 <b>Рынок</b>", `${SM.tf} · топ-${SM.top} · сила от ${SM.minScore} · только подтверждённые развороты`, mktSigs, SM.tf), mktSigs.map((r: any) => r.sym));
  }
}

// the run token is cached for 10 minutes; a request without one is refused before any database read
let SEC: string | null = null, secAt = 0;
Deno.serve(async (req) => {
  const tok = req.headers.get("x-bot-token");
  if (!tok) return new Response("forbidden", { status: 403 });
  const readSec = async () => { const { data } = await db.from("bot_secret").select("token").eq("id", 1).single(); SEC = data?.token ?? null; secAt = Date.now(); };
  if (!SEC || Date.now() - secAt > 600_000) await readSec();
  if (tok !== SEC && Date.now() - secAt > 30_000) await readSec();   // the token may have been changed: re-read, at most twice a minute
  if (!SEC || tok !== SEC) return new Response("forbidden", { status: 403 });
  const { data: locked } = await db.rpc("bot_try_lock", { seconds: 120 });
  if (!locked) return Response.json({ skipped: "another run in progress" });
  const t0 = Date.now();
  TG = undefined;   // re-read the Telegram settings every run
  try { await tgPoll(); } catch { /* Telegram must never break trading */ }
  try {
    const out = await run();
    const t1 = Date.now();
    let users = 0;
    try { users = await runUserBots(Date.now(), t0); } catch { /* personal bots never break the shared one */ }
    await db.from("bot_runs").insert({ ok: true, ms: Date.now() - t0, scanned: out.scanned, signals: out.signals, opened: out.opened, closed: out.closed });
    // where the time goes (shared bot / personal bots) and how many coins' candles are kept warm between runs
    return Response.json({ ...out, users, analyses: AN, ms: { shared: t1 - t0, users: Date.now() - t1 }, kept: KC.size, remote: RSTAT });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await db.from("bot_state").update({ last_error: msg, checked_at: new Date().toISOString() }).eq("id", 1);
    // alert on the third failure in a row, once: a single lost minute (Binance refusing a shared address for a moment) is not news
    const { data: prev } = await db.from("bot_runs").select("ok").order("ts", { ascending: false }).limit(3);
    await db.from("bot_runs").insert({ ok: false, ms: Date.now() - t0, error: msg });
    if (prev?.[0]?.ok === false && prev?.[1]?.ok === false && prev?.[2]?.ok !== false) await notify([`⚠️ <b>Общий бот: ошибка три минуты подряд</b>\n${esc(msg)}`]);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    await db.from("bot_runs").delete().lt("ts", new Date(Date.now() - 3 * 864e5).toISOString());
    await db.from("bot_state").update({ lock_until: null }).eq("id", 1);
  }
});
