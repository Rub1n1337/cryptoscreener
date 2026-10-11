// Telegram: commands and buttons, shared by the "tg" function (the webhook: Telegram calls it the moment a message or a
// button press arrives) and the bot function (falls back to reading updates once a minute while the webhook isn't registered).
// Every screen is one message with buttons under it; a press edits that message in place instead of sending a new one.
export const SITE = "https://cryptoscreener-topaz.vercel.app";
export const esc = (s: string) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
export const fp = (p: number) => { const a = Math.abs(p); return "$" + (a >= 1000 ? p.toFixed(0) : a >= 100 ? p.toFixed(2) : a >= 1 ? p.toFixed(3) : p.toPrecision(4)); };
export const pct = (v: number, e: number) => { const x = (v / e - 1) * 100; return (x > 0 ? "+" : "−") + Math.abs(x).toFixed(2) + "%"; };
export const coin = (s: string) => esc(String(s).replace(/USDT$/, ""));
export const usd = (x: number) => (x >= 0 ? "+" : "−") + "$" + Math.abs(x).toFixed(2);
export const rr = (x: number | null) => x == null || !isFinite(x) ? "" : ` (${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R)`;
const money = (x: number) => "$" + Math.round(x).toLocaleString("ru-RU").replace(/ /g, " ");
export const dur = (ms: number) => { const m = Math.max(0, Math.round(ms / 6e4)); return m < 60 ? `${m} мин` : m < 2880 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} дн`; };
const ago = (t: string | number | null) => t == null ? "" : dur(Date.now() - (typeof t === "number" ? t : Date.parse(t))) + " назад";
const TFN: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const STRAT: Record<string, string> = { revert: "отскок от границы", revert_trend: "отскок по тренду", breakout: "пробой", switch: "переключатель по режиму рынка" };

// the menu Telegram shows next to the input field (registered by the bot function together with the webhook)
export const COMMANDS = [
  { command: "menu", description: "Главное меню" },
  { command: "notify", description: "Уведомления: что присылать" },
  { command: "bot", description: "Общий бот: баланс и позиции" },
  { command: "mybot", description: "Мой бот с сайта" },
  { command: "help", description: "Как читать сигналы" },
  { command: "stop", description: "Отписаться от всего" },
];

type Call = (method: string, body: Record<string, unknown>) => Promise<any>;
type Screen = { text: string; kb: any[][] };
const btn = (text: string, data: string) => ({ text, callback_data: data });
const link = (text: string, path = "") => ({ text, url: SITE + path });
const mark = (on: boolean) => on ? "✅" : "▫️";
const HOME = [btn("◀️ Меню", "h")];

// who this chat is: its subscription and the site bot linked to it (one is shown if several are)
async function ctx(db: any, chat: number) {
  const [{ data: sub }, { data: bots }] = await Promise.all([
    db.from("tg_subs").select("*").eq("chat_id", chat).maybeSingle(),
    db.from("user_bots").select("id, active_profile, balance, start_balance, regime, config, checked_at, last_error, enabled, tg_sig, tg_mkt").eq("tg_chat", chat).limit(1),
  ]);
  return { sub, bot: bots?.[0] || null };
}
const profileOf = (bot: any) => { const ps = Array.isArray(bot?.config?.profiles) ? bot.config.profiles : []; return ps.find((p: any) => p.name === bot.active_profile) || ps[0] || null; };
const sigMinOf = (set: any) => Math.max(40, Number(set?.minScore ?? 60));
const scanOf = (bot: any) => { const s = bot?.config?.scan; return s && typeof s === "object" ? s : null; };
// market state from BTC/ETH/SOL efficiency ratio over 7 days (stored by the personal bots each minute), at a given threshold
function regimeOf(by: any, erMax: number) {
  if (!by?.BTCUSDT) return null;
  const ms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((s) => by[s]).filter(Boolean);
  return ms.every((m: any) => m.er < erMax) ? "flat" : by.BTCUSDT.ch > 0 ? "up" : "down";
}
const REG: Record<string, string> = { flat: "↔️ боковик", up: "📈 рост", down: "📉 падение" };

// ---------- screens ----------
function home(c: any): Screen {
  const { sub, bot } = c, sc = scanOf(bot);
  const lines = [
    `${mark(!!sub?.signals)} Сигналы ≥ 60 по общим правилам`,
    `${mark(!!sub?.shared)} Сделки общего бота`,
    ...(bot ? [
      `✅ Сделки вашего бота «${esc(bot.active_profile || "—")}»`,
      `${mark(bot.tg_sig !== false)} Сигналы вашего профиля`,
      `${mark(bot.tg_mkt !== false && !!sc)} Сигналы вашего «Рынка»${sc ? ` · ${esc(sc.tf)}, ${sc.top} монет` : bot.tg_mkt !== false ? " · откройте сайт, чтобы включить" : ""}`,
    ] : ["▫️ Ваш бот с сайта — не привязан"]),
  ];
  return {
    text: `📡 <b>Sigma Radar</b>\nСигналы отскока от статистического канала и бумажные боты по рынку Binance.\n\n<b>Что приходит в этот чат</b>\n${lines.join("\n")}`,
    kb: [[btn("🔔 Уведомления", "n"), btn("❓ Как читать", "?")], [btn("📊 Общий бот", "s"), btn("🤖 Мой бот", "m")], [link("🌐 Открыть сайт")]],
  };
}

async function notifyScreen(db: any, c: any): Promise<Screen> {
  const { sub, bot } = c, sc = scanOf(bot), P = profileOf(bot);
  const { data: st } = await db.from("bot_state").select("settings").eq("id", 1).maybeSingle();
  const S = st?.settings || {};
  const parts = [
    `🔔 <b>Уведомления</b>\nНажмите на кнопку, чтобы включить или выключить.`,
    `<b>Сигналы ≥ 60</b> — касания канала по правилам общего бота (${TFN[S.tf] || S.tf}, топ-${S.top} монет). Одно сообщение на касание.\n<b>Сделки общего бота</b> — его входы и выходы.`,
    bot ? `<b>Сделки вашего бота</b> приходят всегда, пока он привязан.\n<b>Сигналы профиля</b> — по настройкам «${esc(bot.active_profile || "—")}»${P?.set ? ` (${esc(P.set.tf)}, сила от ${sigMinOf(P.set)})` : ""}.\n` +
      `<b>Сигналы «Рынка»</b> — то же, что колокольчик на сайте${sc ? ` (${esc(sc.tf)}, ${sc.top} монет, сила от ${sc.minScore})` : ": настройки придут, когда вы откроете сайт"}.`
      : `Сделки и сигналы <b>своего</b> бота с сайта — «🤖 Мой бот» → как привязать.`,
    `📬 Отправлено сюда: ${sub?.sent_n || 0}${sub?.last_ok ? ` · последнее ${ago(sub.last_ok)}` : ""}${sub?.last_err ? `\n⚠️ Последняя ошибка отправки: ${esc(sub.last_err)}` : ""}`,
  ];
  return {
    text: parts.join("\n\n"),
    kb: [
      [btn(`${mark(!!sub?.signals)} Сигналы ≥ 60`, "t:signals"), btn(`${mark(!!sub?.shared)} Сделки общего бота`, "t:shared")],
      ...(bot ? [[btn(`${mark(bot.tg_sig !== false)} Сигналы профиля`, "t:sig"), btn(`${mark(bot.tg_mkt !== false)} Сигналы «Рынка»`, "t:mkt")]] : []),
      HOME,
    ],
  };
}

const posLine = (p: any) => {
  const sg = p.side === "LONG" ? 1 : -1, last = p.last ?? p.entry, pnl = sg * (last - p.entry) * p.qty, risk = p.risk || Math.abs(p.entry - p.sl) * p.qty;
  return `${p.side === "LONG" ? "🟢" : "🔴"} <b>${p.side} ${coin(p.sym)}</b> · ${fp(p.entry)} → ${fp(last)} · <b>${usd(pnl)}</b>${risk ? rr(pnl / risk) : ""}\n   🎯 ${fp(p.tp)} · 🛑 ${fp(p.sl)} · ${dur(Date.now() - p.time)} в сделке`;
};
const tradeLine = (t: any) => `${t.pnl > 0 ? "✅" : "❌"} ${coin(t.sym)} ${t.side} · ${esc(t.reason || "")} · <b>${usd(t.pnl)}</b>${rr(t.r)} · ${ago(t.tclose)}`;
const stats = (ts: any[]) => { const n = ts.length, w = ts.filter((t) => t.pnl > 0).length; return n ? `Сделок ${n} · прибыльных ${Math.round(w / n * 100)}% · итого ${usd(ts.reduce((s, t) => s + (t.pnl || 0), 0))}` : "Сделок пока нет"; };
const balLine = (b: number, s: number) => `Баланс <b>${money(b)}</b>${s ? ` (${pct(b, s)} с ${money(s)})` : ""}`;

async function sharedScreen(db: any): Promise<Screen> {
  const [{ data: st }, { data: pos }, { data: tr }, { data: rg }] = await Promise.all([
    db.from("bot_state").select("settings, balance, start_balance, checked_at, last_error").eq("id", 1).maybeSingle(),
    db.from("positions").select("*"),
    db.from("trades").select("sym, side, pnl, r, reason, tclose").order("tclose", { ascending: false }),
    db.from("user_bots").select("regime").not("regime", "is", null).order("checked_at", { ascending: false }).limit(1),
  ]);
  const S = st?.settings || {}, reg = regimeOf(rg?.[0]?.regime?.by, S.erMax ?? 0.15), ts = tr ?? [];
  const doing = S.strategy !== "switch" ? "" : reg === "flat" ? " → ищет отскоки от границ канала" : reg === "up" ? " → ищет пробои вверх (только LONG)" : reg === "down" ? " → не входит, ждёт" : "";
  const parts = [
    `📊 <b>Общий бот</b> — один на всех, торгует на бумаге\n<i>${esc(STRAT[S.strategy] || S.strategy)} · ${TFN[S.tf] || S.tf} · топ-${S.top} монет · сила от ${S.minScore}</i>`,
    `${balLine(st?.balance ?? 0, st?.start_balance ?? 10000)}\n${stats(ts)}`,
    reg ? `<b>Рынок сейчас:</b> ${REG[reg]}${doing}` : "",
    pos?.length ? `<b>Открытые позиции</b>\n${pos.map(posLine).join("\n")}` : "Открытых позиций нет — бот ждёт сигнала.",
    ts.length ? `<b>Последние сделки</b>\n${ts.slice(0, 3).map(tradeLine).join("\n")}` : "",
    st?.last_error ? `⚠️ Ошибка: ${esc(st.last_error)}` : `<i>проверен ${ago(st?.checked_at)}</i>`,
  ];
  return { text: parts.filter(Boolean).join("\n\n"), kb: [[btn("🔄 Обновить", "s"), link("📒 Журнал", "/#journal")], HOME] };
}

async function mineScreen(db: any, c: any): Promise<Screen> {
  const { bot } = c;
  if (!bot) return {
    text: `🤖 <b>Мой бот</b>\nВаш бот с сайта ещё не привязан к этому чату. После привязки сюда придут его сделки, сигналы его профиля и сигналы вашего «Рынка» (как колокольчик на сайте).\n\n<b>Как привязать</b>\n1. На сайте откройте «Журнал» → «Мой бот».\n2. Нажмите «На сервере 24/7», чтобы бот работал, даже когда сайт закрыт.\n3. Нажмите «Подключить Telegram» — откроется этот чат, нажмите «Запустить» (Start).`,
    kb: [[link("🌐 Открыть «Мой бот»", "/#journal")], HOME],
  };
  const [{ data: pos }, { data: tr }] = await Promise.all([
    db.from("user_positions").select("data").eq("bot_id", bot.id),
    db.from("user_trades").select("data").eq("bot_id", bot.id).order("tclose", { ascending: false }),
  ]);
  const P = profileOf(bot), set = P?.set || {}, ts = (tr ?? []).map((x: any) => x.data), op = (pos ?? []).map((x: any) => x.data);
  const auto = bot.config?.mode === "auto", reg = bot.regime?.state;
  const parts = [
    `🤖 <b>Мой бот</b> · «${esc(bot.active_profile || P?.name || "—")}»\n<i>${esc(STRAT[set.strategy] || set.strategy || "отскок от границы")} · ${esc(set.tf || "15m")} · сила от ${set.minScore ?? 60}${auto ? " · профиль выбирается по рынку" : ""}</i>`,
    `${balLine(bot.balance ?? 0, bot.start_balance ?? 10000)}\n${stats(ts)}`,
    reg ? `<b>Рынок сейчас:</b> ${REG[reg] || esc(reg)}` : "",
    op.length ? `<b>Открытые позиции</b>\n${op.map(posLine).join("\n")}` : "Открытых позиций нет — бот ждёт сигнала.",
    ts.length ? `<b>Последние сделки</b>\n${ts.slice(0, 3).map(tradeLine).join("\n")}` : "",
    !bot.enabled ? "⏸ Бот на паузе — включите его на сайте." : bot.last_error ? `⚠️ ${esc(bot.last_error)}` : `<i>проверен ${ago(bot.checked_at)}</i>`,
  ];
  return { text: parts.filter(Boolean).join("\n\n"), kb: [[btn("🔄 Обновить", "m"), link("📒 Журнал", "/#journal")], [btn("🔕 Отвязать", "u"), ...HOME]] };
}

const unlinkAsk: Screen = {
  text: "🔕 <b>Отвязать бота с сайта?</b>\nЕго сделки и сигналы перестанут приходить в этот чат. Сам бот на сайте продолжит работать, привязать снова можно в любой момент.",
  kb: [[btn("Да, отвязать", "u!"), btn("Отмена", "m")]],
};

const help: Screen = {
  text: `❓ <b>Как читать сигналы</b>\n\n` +
    `🟢 <b>LONG</b> — цена коснулась нижней границы канала, ждём отскок вверх.\n🔴 <b>SHORT</b> — коснулась верхней, ждём откат вниз.\n\n` +
    `<b>Сила 0–100</b> — насколько выразительное касание: глубина выхода за канал, объём, RSI, подтверждение разворота и скорость возврата к центру. От 60 — сильный сигнал.\n` +
    `<b>До центра</b> — расстояние до середины канала: туда обычно идёт отскок.\n` +
    `<b>✔ отскок подтверждён</b> — свеча закрылась обратно в канал на повышенном объёме. <b>⏳ ждём подтверждения</b> — касание есть, разворота пока нет.\n\n` +
    `<b>Общий бот</b> — один на всех, торгует по правилам, проверенным на истории. <b>Мой бот</b> — ваш бот с сайта с вашими профилями.\n\n` +
    `<i>Вся торговля бумажная, для изучения. Это не финансовый совет.</i>`,
  kb: [[btn("🔔 Уведомления", "n"), ...HOME]],
};

async function screenFor(db: any, key: string, c: any): Promise<Screen> {
  if (key === "n" || key.startsWith("t:")) return notifyScreen(db, c);
  if (key === "s") return sharedScreen(db);
  if (key === "m" || key === "u!") return mineScreen(db, c);
  if (key === "u") return unlinkAsk;
  if (key === "?") return help;
  return home(c);
}

const show = (call: Call, chat: number, s: Screen, mid?: number) => call(mid ? "editMessageText" : "sendMessage",
  { chat_id: chat, ...(mid ? { message_id: mid } : {}), text: s.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: s.kb } });
const chatName = (ch: any) => String(ch?.title || [ch?.first_name, ch?.last_name].filter(Boolean).join(" ") || ch?.username || "").slice(0, 80);

// ---------- entry point: one update from Telegram ----------
export async function handleUpdate(db: any, u: any, call: Call) {
  if (u?.callback_query) return onButton(db, u.callback_query, call);
  if (u?.message) return onMessage(db, u.message, call);
}

async function onMessage(db: any, m: any, call: Call) {
  const chat = m?.chat?.id, text = String(m?.text || "").trim();
  if (!chat || !text.startsWith("/")) return;
  const [cmd0, arg = ""] = text.split(/\s+/, 2), cmd = cmd0.replace(/@.*$/, "").toLowerCase();
  const say = (t: string, kb?: any[][]) => call("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
  let c = await ctx(db, chat);
  if (cmd === "/start") {
    if (!c.sub) await db.from("tg_subs").insert({ chat_id: chat, name: chatName(m.chat) });
    if (/^b[0-9a-f]{18}$/.test(arg)) {   // a link code from the site: this chat gets that bot's trades and signals
      const { data: b } = await db.from("user_bots").select("id, active_profile").eq("tg_code", arg).gt("tg_code_until", new Date().toISOString()).maybeSingle();
      if (b) { await db.from("user_bots").update({ tg_chat: chat, tg_code: null, tg_code_until: null }).eq("id", b.id); await say(`✅ <b>Ваш бот с сайта привязан</b>${b.active_profile ? ` · «${esc(b.active_profile)}»` : ""}\nСюда будут приходить его сделки, сигналы его профиля и сигналы вашего «Рынка».`); }
      else await say("⌛ Ссылка устарела — на сайте нажмите «Подключить Telegram» ещё раз.", [[link("🌐 Открыть «Мой бот»", "/#journal")]]);
    }
    c = await ctx(db, chat);
    return show(call, chat, home(c));
  }
  if (cmd === "/stop") {
    await db.from("tg_subs").delete().eq("chat_id", chat); await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat);
    return say("👋 Вы отписались от всего, ваш бот с сайта отвязан. Вернуться можно в любой момент.", [[btn("▶️ Подписаться снова", "go")]]);
  }
  if (!c.sub) return say("Сначала подпишитесь — это бесплатно и отключается в любой момент.", [[btn("▶️ Начать", "go")]]);
  // the old on/off commands still work, then show the notifications screen
  const tog: Record<string, string> = { "/signals": "signals", "/shared": "shared", "/mysignals": "sig", "/market": "mkt" };
  if (tog[cmd]) {
    const want = arg ? !/^(off|выкл|0|нет)$/i.test(arg) : undefined;
    const r = await toggle(db, chat, c, tog[cmd], want);
    if (r) await say(r);
    return show(call, chat, await notifyScreen(db, await ctx(db, chat)));
  }
  if (cmd === "/unlink") { await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat); return say("🔕 Бот с сайта отвязан."); }
  const key = ({ "/notify": "n", "/settings": "n", "/status": "n", "/bot": "s", "/mybot": "m", "/help": "?" } as Record<string, string>)[cmd] || "h";
  return show(call, chat, await screenFor(db, key, c));
}

// switches one kind of message; returns a short confirmation, or why it can't
async function toggle(db: any, chat: number, c: any, k: string, want?: boolean) {
  const NAMES: Record<string, string> = { signals: "Сигналы ≥ 60", shared: "Сделки общего бота", sig: "Сигналы профиля", mkt: "Сигналы «Рынка»" };
  let on: boolean;
  if (k === "signals" || k === "shared") { on = want ?? !c.sub[k]; await db.from("tg_subs").update({ [k]: on }).eq("chat_id", chat); }
  else {
    if (!c.bot) return "Сначала привяжите своего бота с сайта — «🤖 Мой бот».";
    const col = k === "mkt" ? "tg_mkt" : "tg_sig";
    on = want ?? c.bot[col] === false;   // unset counts as on
    await db.from("user_bots").update({ [col]: on }).eq("tg_chat", chat);
  }
  return `${NAMES[k]}: ${on ? "вкл" : "выкл"}`;
}

async function onButton(db: any, q: any, call: Call) {
  const chat = q.message?.chat?.id, mid = q.message?.message_id;
  // "+" — the button is under a signal or a trade: open the screen as a new message instead of replacing that one
  const raw = String(q.data || ""), fresh = raw.startsWith("+"), key = raw.replace(/^\+/, "");
  const answer = (text = "", alert = false) => call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) });
  if (!chat) return answer();
  let c = await ctx(db, chat), note = "";
  if (key === "go") { if (!c.sub) await db.from("tg_subs").insert({ chat_id: chat, name: chatName(q.message.chat) }); note = "Подписка включена"; }
  else if (!c.sub) return answer("Вы отписаны — нажмите /start, чтобы вернуться.", true);
  if (key.startsWith("t:")) { note = await toggle(db, chat, c, key.slice(2)) || ""; if (!c.bot && /^t:(sig|mkt)$/.test(key)) return answer(note, true); }
  if (key === "u!") { await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat); note = "Бот отвязан"; }
  if (key === "s" || (key === "m" && c.bot)) note = "Обновлено";
  c = await ctx(db, chat);
  const scr = await screenFor(db, key, c);
  await answer(note);
  if (fresh) return show(call, chat, scr);
  const r = await show(call, chat, scr, mid);
  // an edit can fail (the message is too old, or was a plain notice); "not modified" just means nothing changed
  if (r && !r.ok && !/not modified/i.test(r.description || "")) await show(call, chat, scr);
}
