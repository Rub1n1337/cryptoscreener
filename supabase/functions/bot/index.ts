// Shared 24/7 paper-trading bot + personal 24/7 bots. Called every minute by pg_cron (see supabase/cron.sql).
// All strategy math lives in ../_shared/math.js — the same file the site uses.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as M from "../_shared/math.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
const SITE = "https://cryptoscreener-topaz.vercel.app";

async function api(path: string) {
  let err: unknown;
  for (const b of BASES) {
    try { const r = await fetch(b + path); if (r.ok) return await r.json(); err = new Error("HTTP " + r.status + " " + b); } catch (e) { err = e; }
  }
  throw err;
}
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- Telegram (optional: one bot, token in public.tg_config; chats subscribe with /start, see README) ----------
const fp = (p: number) => { const a = Math.abs(p); return "$" + (a >= 1000 ? p.toFixed(0) : a >= 100 ? p.toFixed(2) : a >= 1 ? p.toFixed(3) : p.toPrecision(4)); };
const pct = (v: number, e: number) => { const x = (v / e - 1) * 100; return (x > 0 ? "+" : "−") + Math.abs(x).toFixed(2) + "%"; };
const pair = (s: string) => s.replace(/USDT$/, "/USDT");
const esc = (s: string) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
let TG: any;   // tg_config, read once per run
async function tgConf() { if (TG === undefined) { const { data } = await db.from("tg_config").select("*").eq("id", 1).maybeSingle(); TG = data?.enabled && data.bot_token ? data : null; } return TG; }
async function tgCall(method: string, body: unknown) {
  const tg = await tgConf(); if (!tg) return null;
  const r = await fetch(`https://api.telegram.org/bot${tg.bot_token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => null);
}
const FOOT = `\n\n<a href="${SITE}">Sigma Radar</a> · бумажная торговля, не совет`;
async function sendTo(chats: (number | string)[], lines: string[]) {
  if (!lines.length || !chats.length || !(await tgConf())) return;
  const text = lines.join("\n\n").slice(0, 3900) + FOOT;
  for (const chat of [...new Set(chats.map(String))]) {
    try {
      const r = await tgCall("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
      if (r && !r.ok && r.error_code === 403) await db.from("tg_subs").delete().eq("chat_id", chat);   // the user blocked the bot
    } catch { /* notifications must never break trading */ }
  }
}
// who gets what: every subscribed chat that kept this kind on (plus the owner's old single chat, if set)
async function chatsFor(kind: "shared" | "signals") {
  const tg = await tgConf(); if (!tg) return [];
  const { data } = await db.from("tg_subs").select("chat_id").eq(kind, true);
  return [...(data ?? []).map((x: any) => x.chat_id), ...(kind === "shared" && tg.chat_id ? [tg.chat_id] : [])];
}
const notify = async (lines: string[]) => sendTo(await chatsFor("shared"), lines);

// commands from Telegram, read every minute (getUpdates — no webhook to set up)
const HELP = "Команды:\n/signals — новые сигналы с силой ≥ 60 вкл/выкл\n/shared — сделки общего бота вкл/выкл\n/status — что сейчас включено\n/unlink — отвязать ваш бот с сайта\n/stop — отписаться от всего\n\nЧтобы получать сделки своего бота: на сайте «Журнал» → «Мой бот» → «Подключить Telegram».";
async function tgPoll() {
  const tg = await tgConf(); if (!tg) return;
  const r = await tgCall("getUpdates", { offset: Number(tg.upd_offset || 0) + 1, timeout: 0, allowed_updates: ["message"] });
  if (!r?.ok || !r.result?.length) return;
  for (const u of r.result) {
    const m = u.message, chat = m?.chat?.id, text = String(m?.text || "").trim();
    if (!chat || !text.startsWith("/")) continue;
    const [cmd0, arg = ""] = text.split(/\s+/, 2), cmd = cmd0.replace(/@.*$/, "").toLowerCase();
    const name = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || "";
    const say = (t: string) => tgCall("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => null);
    const { data: sub } = await db.from("tg_subs").select("*").eq("chat_id", chat).maybeSingle();
    try {
      if (cmd === "/start") {
        if (!sub) await db.from("tg_subs").insert({ chat_id: chat, name: name.slice(0, 80) });
        if (/^b[0-9a-f]{18}$/.test(arg)) {   // a link code from the site: this chat gets that bot's trades
          const { data: b } = await db.from("user_bots").select("id, active_profile").eq("tg_code", arg).gt("tg_code_until", new Date().toISOString()).maybeSingle();
          if (b) { await db.from("user_bots").update({ tg_chat: chat, tg_code: null, tg_code_until: null }).eq("id", b.id); await say(`✅ Ваш бот с сайта привязан${b.active_profile ? ` (профиль «${esc(b.active_profile)}»)` : ""}. Сюда будут приходить его сделки.\n\n${HELP}`); }
          else await say("Ссылка устарела — на сайте нажмите «Подключить Telegram» ещё раз.");
        } else await say(`👋 Это бот <b>Sigma Radar</b>. Сюда будут приходить сделки общего бота и новые сигналы с силой ≥ 60 (по правилам общего бота).\n\n${HELP}`);
      } else if (!sub && cmd !== "/unlink") await say("Сначала нажмите /start.");
      else if (cmd === "/signals" || cmd === "/shared") {
        const k = cmd.slice(1), on = arg ? !/^(off|выкл|0|нет)$/i.test(arg) : !sub[k];
        await db.from("tg_subs").update({ [k]: on }).eq("chat_id", chat);
        await say(`${k === "signals" ? "Сигналы ≥ 60" : "Сделки общего бота"}: ${on ? "включены" : "выключены"}.`);
      } else if (cmd === "/status") {
        const { data: bots } = await db.from("user_bots").select("active_profile").eq("tg_chat", chat);
        await say(`Сигналы ≥ 60: ${sub.signals ? "вкл" : "выкл"}\nСделки общего бота: ${sub.shared ? "вкл" : "выкл"}\nВаш бот с сайта: ${bots?.length ? bots.map((x: any) => `привязан${x.active_profile ? ` («${esc(x.active_profile)}»)` : ""}`).join(", ") : "не привязан"}`);
      } else if (cmd === "/unlink") {
        await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat); await say("Бот с сайта отвязан.");
      } else if (cmd === "/stop") {
        await db.from("tg_subs").delete().eq("chat_id", chat); await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat);
        await say("Вы отписались от всего. Вернуться — /start.");
      } else await say(HELP);
    } catch { /* one bad message must not stop the others */ }
  }
  await db.from("tg_config").update({ upd_offset: r.result[r.result.length - 1].update_id }).eq("id", 1);
}

// new signals with strength ≥ 60 (by the shared bot's rules): one message per touch of a band, not every minute
const SIG_MIN = 60;
async function announceSignals(rows: any[], S: any, sent: Record<string, number>, now: number) {
  const fresh = rows.filter((r) => r.score != null && r.score >= SIG_MIN && r.touchTime && !sent[`${r.sym}:${r.touchTime}`]).sort((a, b) => b.score - a.score);
  const first = !Object.keys(sent).length;   // the very first run only remembers what is there, so nobody gets a pile of old signals
  for (const r of fresh) sent[`${r.sym}:${r.touchTime}`] = now;
  for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 864e5) delete sent[k];
  await db.from("bot_state").update({ sig_sent: sent }).eq("id", 1);
  if (first || !fresh.length) return;
  const line = (r: any) => `${r.side === "low" ? "🟢" : "🔴"} <b>${pair(r.sym)}</b> · сила <b>${r.score}</b> · ${esc(r.label)}\n` +
    `цена ${fp(r.price)} · RSI ${Math.round(r.rsi)} · объём ×${r.volX ? r.volX.toFixed(1) : "—"} · ${r.rev ? "отскок подтверждён" : "ждём подтверждения"}`;
  await sendTo(await chatsFor("signals"), [`📡 <b>Новые сигналы ≥ ${SIG_MIN}</b> · ${S.tf}, топ-${S.top} монет`, ...fresh.slice(0, 15).map(line)]);
}
const openedMsg = (p: any) =>
  `${p.side === "LONG" ? "🟢" : "🔴"} <b>${p.side} ${pair(p.sym)}</b> — общий бот открыл позицию\n` +
  `вход ${fp(p.entry)} · тейк ${fp(p.tp)} (${pct(p.tp, p.entry)}) · стоп ${fp(p.sl)} (${pct(p.sl, p.entry)})\n` +
  `сила сигнала ${p.snap?.score ?? "—"} · риск $${p.risk.toFixed(2)}`;
const closedMsg = (t: any) =>
  `${t.pnl > 0 ? "✅" : "❌"} <b>${pair(t.sym)} ${t.side}</b> закрыта: ${t.reason}\n` +
  `${fp(t.entry)} → ${fp(t.exit)} · PnL ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.r >= 0 ? "+" : "−"}${Math.abs(t.r).toFixed(2)}R) · комиссия $${t.fee.toFixed(2)}`;

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
    try { const K = await api(`/api/v3/klines?symbol=${sym}&interval=${S.tf}&limit=${limit}`); klines[sym] = K; const r = M.analyze(sym, K, S, now); if (r) rows.push(r); } catch { /* skip pair */ }
  });

  const { data: recent } = await db.from("trades").select("sym").gt("tclose", now - M.COOLDOWN * M.TFMS[S.tf]);
  const res = M.botTick({ rows, klines, open: open!, recentSyms: (recent ?? []).map((x: any) => x.sym), balance: st.balance, S, now });

  if (res.closed.length) {
    const { error } = await db.from("trades").insert(res.closed); if (error) throw error;
    const { error: e3 } = await db.from("positions").delete().in("id", res.closed.map((x: any) => x.id)); if (e3) throw e3;
  }
  const upserts = [...res.stillOpen, ...res.opened];
  if (upserts.length) { const { error } = await db.from("positions").upsert(upserts); if (error) throw error; }
  await db.from("bot_state").update({ balance: res.balance, checked_at: new Date(now).toISOString(), scanned: Object.keys(klines).length, last_error: null }).eq("id", 1);
  await notify([...res.closed.map(closedMsg), ...res.opened.map(openedMsg)]);
  try { await announceSignals(rows, S, st.sig_sent || {}, now); } catch { /* signals must never break trading */ }
  return { scanned: Object.keys(klines).length, signals: rows.filter((r) => M.wants(r, S)).length, opened: res.opened.length, closed: res.closed.length, open: upserts.length, ticker: undefined as any };
}

// ---------- personal bots (one per browser; config = profiles chosen on the site) ----------
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
      const c = (await api(`/api/v3/klines?symbol=${s}&interval=1h&limit=200`)).map((k: any) => +k[4]), L = 168, i = c.length - 1;
      let path = 0; for (let j = i - L + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
      got[s] = { er: path ? Math.abs(c[i] - c[i - L]) / path : 0, ch: c[i] / c[i - L] - 1 };
    } catch { /* regime falls back to BTC-only or null */ }
  }));
  const m: any = M.marketOf((s: string) => got[s] || null);
  if (m) m.by = got;
  return m;
}
async function runUserBots(now: number) {
  // fair queue: the least recently checked bots go first, so with more bots than fit in one run every bot still gets its turn;
  // bots whose owner hasn't opened the site for 30 days are not scheduled
  const { data: bots } = await db.from("user_bots").select("id, config, balance, tg_chat").eq("enabled", true)
    .gt("last_seen", new Date(now - 30 * 864e5).toISOString()).order("checked_at", { ascending: true, nullsFirst: true }).limit(40);
  if (!bots?.length) return 0;
  const reg = await majorsRegime(), ticker = await api("/api/v3/ticker/24hr");
  const kc = new Map<string, Promise<any>>();   // one download per coin + timeframe for all bots
  const getK = (s: string, tf: string) => { const key = s + "|" + tf; if (!kc.has(key)) kc.set(key, api(`/api/v3/klines?symbol=${s}&interval=${tf}&limit=450`).catch(() => null)); return kc.get(key)!; };
  let done = 0;
  const t0 = Date.now();
  for (const b of bots) {
    if (Date.now() - t0 > 90_000) break;   // leave room before the function's time limit; the rest go first next minute
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
      const rows = list.map((s) => Ks[s]?.length ? M.analyze(s, Ks[s], { ...S, N: effN(Ks[s].length, S) }, now) : null).filter(Boolean);
      const exitK: Record<string, any> = {};
      for (const p of open) exitK[p.sym] = await getK(p.sym, tfOf(p.tfms) || S.tf);
      const { data: rec } = await db.from("user_trades").select("data").eq("bot_id", b.id).gt("tclose", now - M.COOLDOWN * (M.TFMS as any)[S.tf]);
      const res = M.botTick({ rows, klines: exitK, open, recentSyms: (rec ?? []).map((x: any) => x.data.sym), balance: b.balance, S, now, market: reg });
      for (const p of res.opened) { p.note = `«${pname}» · ${p.note}`; p.snap.profile = pname; }
      if (res.closed.length) {
        await db.from("user_trades").insert(res.closed.map((t: any) => ({ bot_id: b.id, id: t.id, tclose: t.tclose, data: t })));
        await db.from("user_positions").delete().eq("bot_id", b.id).in("id", res.closed.map((t: any) => t.id));
      }
      const keep = [...res.stillOpen, ...res.opened];
      if (keep.length) await db.from("user_positions").upsert(keep.map((p: any) => ({ bot_id: b.id, id: p.id, data: p })));
      await db.from("user_bots").update({ balance: res.balance, checked_at: new Date(now).toISOString(), active_profile: pname,
        regime: reg ? { state: regName, by: reg.by } : null, last_error: null }).eq("id", b.id);
      if (b.tg_chat) await sendTo([b.tg_chat], [
        ...res.closed.map((t: any) => closedMsg(t).replace("</b> закрыта", "</b> — ваш бот закрыл")),
        ...res.opened.map((p: any) => openedMsg(p).replace("общий бот открыл позицию", `ваш бот открыл позицию · «${esc(pname)}»`))]);
      done++;
    } catch (e) {
      await db.from("user_bots").update({ last_error: String((e as Error)?.message ?? e), checked_at: new Date(now).toISOString() }).eq("id", b.id);
    }
  }
  return done;
}

Deno.serve(async (req) => {
  const { data: sec } = await db.from("bot_secret").select("token").eq("id", 1).single();
  if (!sec || req.headers.get("x-bot-token") !== sec.token) return new Response("forbidden", { status: 403 });
  const { data: locked } = await db.rpc("bot_try_lock", { seconds: 120 });
  if (!locked) return Response.json({ skipped: "another run in progress" });
  const t0 = Date.now();
  TG = undefined;   // re-read the Telegram settings every run
  try { await tgPoll(); } catch { /* Telegram must never break trading */ }
  try {
    const out = await run();
    let users = 0;
    try { users = await runUserBots(Date.now()); } catch { /* personal bots never break the shared one */ }
    await db.from("bot_runs").insert({ ok: true, ms: Date.now() - t0, scanned: out.scanned, signals: out.signals, opened: out.opened, closed: out.closed });
    return Response.json({ ...out, users });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await db.from("bot_state").update({ last_error: msg, checked_at: new Date().toISOString() }).eq("id", 1);
    // alert only on the first failure in a row, not every minute
    const { data: prev } = await db.from("bot_runs").select("ok").order("ts", { ascending: false }).limit(1);
    await db.from("bot_runs").insert({ ok: false, ms: Date.now() - t0, error: msg });
    if (prev?.[0]?.ok !== false) await notify([`⚠️ <b>Общий бот: ошибка</b>\n${msg}`]);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    await db.from("bot_runs").delete().lt("ts", new Date(Date.now() - 3 * 864e5).toISOString());
    await db.from("bot_state").update({ lock_until: null }).eq("id", 1);
  }
});
