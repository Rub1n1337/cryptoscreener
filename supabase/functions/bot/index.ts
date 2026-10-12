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
// candles are kept between runs while the function instance stays warm, as compact numeric rows [time, open, high, low, close, volume];
// the next minute fetches only the newest 3 bars of each coin and splices them in (a fresh instance downloads everything once).
// Re-downloading hundreds of coins × 450 bars every minute was most of a run's time and of Binance's request weight.
const KC = new Map<string, { K: number[][]; limit: number; used: number }>();
let kcSwept = 0;
const compact = (K: any[]) => K.map((k: any) => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
async function candles(sym: string, tf: string, limit: number): Promise<number[][]> {
  const key = sym + "|" + tf, st = KC.get(key), tfms = (M.TFMS as any)[tf], now = Date.now();
  if (now - kcSwept > 60_000) { kcSwept = now; for (const [k, v] of KC) if (now - v.used > 600_000) KC.delete(k); }   // coins nobody asked for in 10 min
  if (st && st.K.length && st.limit >= limit && now - st.K[st.K.length - 1][0] < 2 * tfms) {
    const N = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=3`));
    if (N.length && N[0][0] <= st.K[st.K.length - 1][0]) {   // overlaps the kept bars: no gap
      const K = st.K.filter((k) => k[0] < N[0][0]).concat(N).slice(-st.limit);
      KC.set(key, { K, limit: st.limit, used: now });
      return K.slice(-limit);
    }
  }
  const K = compact(await api(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`));
  KC.set(key, { K, limit, used: now });
  return K;
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
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
async function sendTo(chats: (number | string)[], lines: string[], syms: string[] = []) {
  if (!lines.length || !chats.length || !(await tgConf())) return;
  const text = lines.join("\n\n").slice(0, 3900) + FOOT, coins = [...new Set(syms.map((s) => s.replace(/USDT$/, "")))].slice(0, 3);
  // the link is percent-encoded: a coin named in Chinese would otherwise make Telegram refuse the whole message
  const reply_markup = { inline_keyboard: [
    ...(coins.length ? [coins.map((c) => ({ text: `📈 ${c}`, url: `${SITE}/#market/${encodeURIComponent(c)}` }))] : []),
    [{ text: "🔔 Уведомления", callback_data: "+n" }, { text: "📊 Общий бот", callback_data: "+s" }],
  ] };
  for (const chat of [...new Set(chats.map(String))]) {
    try {
      let r = await tgCall("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup });
      if (r && !r.ok && r.error_code === 400) r = await tgCall("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });   // buttons refused: send without them
      if (r && !r.ok && r.error_code === 403) { await db.from("tg_subs").delete().eq("chat_id", chat); continue; }   // the user blocked the bot
      // what happened to the last message in this chat, so a "nothing came" can be checked
      const { data: s } = await db.from("tg_subs").select("sent_n").eq("chat_id", chat).maybeSingle();
      if (s) await db.from("tg_subs").update(r?.ok ? { last_ok: new Date().toISOString(), last_err: null, sent_n: (s.sent_n || 0) + 1 } : { last_err: String(r?.description || "нет ответа").slice(0, 200) }).eq("chat_id", chat);
    } catch { /* notifications must never break trading */ }
  }
}
// who gets what: every subscribed chat that kept this kind on (plus the owner's old single chat, if set)
async function chatsFor(kind: "shared" | "signals") {
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

// new signals with strength ≥ 60 (by the shared bot's rules): one message per touch of a band, not every minute
const SIG_MIN = 60;
// signals at the threshold not announced yet (`sent` is updated in place: "SYM:touchTime" → ms, kept 3 days);
// the very first call only remembers what is there, so nobody gets a pile of old signals ("_init" marks that it has run)
// pre: a separate memory inside the same object (the "Рынок" feed uses "m:"), with its own first-run marker
function freshSignals(rows: any[], min: number, sent: Record<string, number>, now: number, pre = "") {
  const fresh = rows.filter((r) => r.score != null && r.score >= min && r.touchTime && !sent[`${pre}${r.sym}:${r.touchTime}`]).sort((a, b) => b.score - a.score);
  const first = !sent["_init" + pre];
  for (const r of fresh) sent[`${pre}${r.sym}:${r.touchTime}`] = now;
  for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
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
    `⌛ войти можно ещё ${left > 6e4 ? dur(left) : "минуту"} · T½ ${hl}` + (r.botNote ? `\n${r.botNote}` : "");
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
  if (nOpen >= M.MAX_OPEN) return `заняты все ${M.MAX_OPEN} места`;
  return "до центра осталось мало места или по монете недавно была сделка";
}
// a signal message: title, the rules it follows in one grey line, up to 15 signals
const sigMsg = (title: string, rules: string, list: any[], tf: string) =>
  [`${title}\n<i>${rules}</i>`, ...list.slice(0, 15).map(sigLine(tf)), ...(list.length > 15 ? [`…и ещё ${list.length - 15} — на сайте`] : [])];
async function announceSignals(rows: any[], S: any, sent: Record<string, number>, now: number) {
  const fresh = freshSignals(rows, SIG_MIN, sent, now);
  await db.from("bot_state").update({ sig_sent: sent }).eq("id", 1);
  if (fresh.length) await sendTo(await chatsFor("signals"), sigMsg("📡 <b>Новые сигналы</b> · общие правила", `${S.tf} · топ-${S.top} монет · сила от ${SIG_MIN}`, fresh, S.tf), fresh.map((r) => r.sym));
}
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
  const list = M.pickSymbols(await api("/api/v3/ticker/24hr"), S.top, open!.map((p: any) => p.sym), now);

  const klines: Record<string, unknown[]> = {}, rows: any[] = [];
  const limit = Math.min(1000, S.N + 150);
  await pool(list, 10, async (sym) => {
    try { const K = await candles(sym, S.tf, limit); klines[sym] = K; const r = M.analyze(sym, K, S, now, true); if (r) rows.push(r); } catch { /* skip pair */ }
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
  await db.from("bot_state").update({ balance: res.balance, checked_at: new Date(now).toISOString(), scanned: Object.keys(klines).length, last_error: null }).eq("id", 1);
  await notify([...res.closed.map((t: any) => closedMsg(t)), ...res.opened.map((p: any) => openedMsg(p))], [...res.opened, ...res.closed].map((x: any) => x.sym));
  try { await announceSignals(rows, S, st.sig_sent || {}, now); } catch { /* signals must never break trading */ }
  return { scanned: Object.keys(klines).length, signals: rows.filter((r) => M.wants(r, S)).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length, ticker: undefined as any };
}

// ---------- personal bots (one per browser; config = profiles chosen on the site) ----------
let AN = 0;   // coin analyses in the last run of the personal bots (reported in the response, to watch the load)
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
    timeStop: oneOf(s.timeStop === undefined ? 48 : Number(s.timeStop), [0, 24, 48, 96], 48) };
}
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
  const { data: bots } = await db.from("user_bots").select("id, config, balance, tg_chat, tg_sig, tg_mkt, sig_sent").eq("enabled", true)
    .gt("last_seen", new Date(now - 30 * 864e5).toISOString()).order("checked_at", { ascending: true, nullsFirst: true }).limit(40);
  if (!bots?.length) return 0;
  const reg = await majorsRegime(), ticker = await api("/api/v3/ticker/24hr");
  // one request per coin + timeframe for all bots in this run (compact candles, see candles())
  const kc = new Map<string, Promise<any>>();
  const getK = (s: string, tf: string) => { const key = s + "|" + tf; if (!kc.has(key)) kc.set(key, candles(s, tf, 450).catch(() => null)); return kc.get(key)!; };
  // one analysis per coin + channel settings for all bots (most share them); the bots don't need the site's display extras
  const ac = new Map<string, any>();
  const analyzeK = (s: string, K: any, S: any) => {
    if (!K?.length) return null;
    const key = `${s}|${S.tf}|${S.method}|${S.N}|${S.k}`;
    if (!ac.has(key)) ac.set(key, M.analyze(s, K, { ...S, N: effN(K.length, S) }, now, true));
    return ac.get(key);
  };
  // a CPU budget per run: the function is stopped by the platform when it computes too much (WORKER_RESOURCE_LIMIT),
  // which also loses the shared bot's minute. Bots that don't fit wait for the next run — they are first in the fair queue.
  const BUDGET = 1800;   // distinct coin analyses per run (~1 s of CPU)
  AN = 0;
  let done = 0;
  for (const b of bots) {
    // the deadline counts from the start of the whole request (the shared bot ran first): the run lock lasts 120 s, and a run
    // that outlives it would overlap the next minute's. The rest go first next minute.
    if (Date.now() - reqStart > 80_000 || ac.size > BUDGET) break;
    try {
      const cfg = b.config || {}, profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
      if (!profiles.length) {   // still mark it checked, or it would stay first in the queue forever
        await db.from("user_bots").update({ checked_at: new Date(now).toISOString(), last_error: "нет профилей" }).eq("id", b.id);
        continue;
      }
      const byId = (id: string) => profiles.find((p: any) => p.id === id) || profiles[0];
      const erMax = num(cfg.erMax, 0.05, 0.5, 0.15);
      const regName = M.regimeOf(reg, { erMax, regimeSrc: "majors" });
      const P = cfg.mode === "auto" ? byId(regName === "flat" ? cfg.flat : cfg.impulse) : byId(cfg.active);
      const S = { ...cleanSet(P.set), regimeSrc: "majors", erMax };
      const pname = String(P.name ?? "Профиль").replace(/[<>&"'`]/g, "").slice(0, 60);
      const own = Array.isArray(P.coins?.list) ? P.coins.list.filter((s: unknown) => typeof s === "string" && /^[A-Z0-9]{2,20}USDT$/.test(s)).slice(0, 200) : [];
      const list: string[] = P.coins?.mode === "list" && own.length ? own : M.pickSymbols(ticker, Math.round(num(P.coins?.top, 20, 200, 150)), [], now);
      const { data: pr } = await db.from("user_positions").select("data").eq("bot_id", b.id);
      const open = (pr ?? []).map((x: any) => x.data);
      const Ks: Record<string, any> = {};
      await pool(list, 10, async (s) => { Ks[s] = await getK(s, S.tf); });
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
      // a linked chat also gets the profile's own signals (strength at its threshold), unless switched off with /mysignals
      const sigOn = b.tg_chat && b.tg_sig !== false, sent = b.sig_sent || {}, sigMin = Math.max(40, S.minScore), mySigs = sigOn ? freshSignals(rows, sigMin, sent, now).map((r) => ({ ...r })) : [];   // a floor of 40: a profile with no threshold would message every touch; copies — the rows are shared between bots
      const took = new Set(res.opened.map((p: any) => p.sym)), held = new Set(res.stillOpen.map((p: any) => p.sym));
      for (const r of mySigs) r.botNote = took.has(r.sym) ? "🤖 бот вошёл в сделку" : held.has(r.sym) ? "🤖 бот уже в сделке по этой монете"
        : `🤖 бот не войдёт: ${whyNot(r, S, res.stillOpen.length + res.opened.length)}`;
      // the owner's "Рынок" settings (sent by the site): the same signals as the bell there — a confirmed reversal at the threshold
      const sc = cfg.scan, mktOn = !!(b.tg_chat && b.tg_mkt !== false && sc && typeof sc === "object");
      let mktSigs: any[] = [], SM: any = null, mktTop = 0;
      if (mktOn) {
        SM = { method: oneOf(sc.method, ["log", "classic", "robust", "ewma"], "log"), N: Math.round(num(sc.N, 20, 300, 210)), k: num(sc.k, 1, 5, 3),
          tf: oneOf(sc.tf, ["5m", "15m", "1h", "4h", "1d"], "4h"), minScore: num(sc.minScore, 40, 100, 60) };
        mktTop = Math.round(num(sc.top, 10, 400, 150));
        const lst = M.pickSymbols(ticker, mktTop, [], now), KM: Record<string, any> = {};
        await pool(lst, 10, async (s) => { KM[s] = await getK(s, SM.tf); });
        const rowsM = lst.map((s) => analyzeK(s, KM[s], SM)).filter((r: any) => r?.rev);
        mktSigs = freshSignals(rowsM, SM.minScore, sent, now, "m:");
      }
      await db.from("user_bots").update({ balance: res.balance, checked_at: new Date(now).toISOString(), active_profile: pname,
        regime: reg ? { state: regName, by: reg.by } : null, last_error: null, ...(sigOn || mktOn ? { sig_sent: sent } : {}) }).eq("id", b.id);
      if (b.tg_chat) await sendTo([b.tg_chat], [
        ...res.closed.map((t: any) => closedMsg(t, `ваш бот «${esc(pname)}»`)),
        ...res.opened.map((p: any) => openedMsg(p, `ваш бот «${esc(pname)}»`))], [...res.opened, ...res.closed].map((x: any) => x.sym));
      if (mySigs.length) await sendTo([b.tg_chat], sigMsg(`📡 <b>Сигналы профиля «${esc(pname)}»</b>`, `${S.tf} · сила от ${sigMin}`, mySigs, S.tf), mySigs.map((r: any) => r.sym));
      if (mktSigs.length) await sendTo([b.tg_chat], sigMsg("🔔 <b>Сигналы вашего «Рынка»</b>", `${SM.tf} · ${mktTop} монет · сила от ${SM.minScore} · как колокольчик на сайте`, mktSigs, SM.tf), mktSigs.map((r: any) => r.sym));
      done++;
    } catch (e) {
      await db.from("user_bots").update({ last_error: String((e as Error)?.message ?? e), checked_at: new Date(now).toISOString() }).eq("id", b.id);
    }
  }
  AN = ac.size;
  return done;
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
    return Response.json({ ...out, users, analyses: AN, ms: { shared: t1 - t0, users: Date.now() - t1 }, kept: KC.size });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await db.from("bot_state").update({ last_error: msg, checked_at: new Date().toISOString() }).eq("id", 1);
    // alert only on the first failure in a row, not every minute
    const { data: prev } = await db.from("bot_runs").select("ok").order("ts", { ascending: false }).limit(1);
    await db.from("bot_runs").insert({ ok: false, ms: Date.now() - t0, error: msg });
    if (prev?.[0]?.ok !== false) await notify([`⚠️ <b>Общий бот: ошибка</b>\n${esc(msg)}`]);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    await db.from("bot_runs").delete().lt("ts", new Date(Date.now() - 3 * 864e5).toISOString());
    await db.from("bot_state").update({ lock_until: null }).eq("id", 1);
  }
});
