// Telegram commands, shared by the "tg" function (the webhook: Telegram calls it the moment a message arrives)
// and the bot function (falls back to reading messages once a minute while the webhook isn't registered).
export const esc = (s: string) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
export const HELP = "Команды:\n/signals — новые сигналы с силой ≥ 60 вкл/выкл\n/shared — сделки общего бота вкл/выкл\n/status — что сейчас включено\n/mysignals — сигналы вашего профиля вкл/выкл\n/market — сигналы вашего «Рынка» (как колокольчик на сайте) вкл/выкл\n/unlink — отвязать ваш бот с сайта\n/stop — отписаться от всего\n\nЧтобы получать сделки и сигналы своего бота: на сайте «Журнал» → «Мой бот» → «Подключить Telegram».";

// one incoming message; say() answers in the same chat
export async function handleMessage(db: any, m: any, say: (t: string) => Promise<unknown>) {
  const chat = m?.chat?.id, text = String(m?.text || "").trim();
  if (!chat || !text.startsWith("/")) return;
  const [cmd0, arg = ""] = text.split(/\s+/, 2), cmd = cmd0.replace(/@.*$/, "").toLowerCase();
  const name = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || "";
  const { data: sub } = await db.from("tg_subs").select("*").eq("chat_id", chat).maybeSingle();
  if (cmd === "/start") {
    if (!sub) await db.from("tg_subs").insert({ chat_id: chat, name: name.slice(0, 80) });
    if (/^b[0-9a-f]{18}$/.test(arg)) {   // a link code from the site: this chat gets that bot's trades
      const { data: b } = await db.from("user_bots").select("id, active_profile").eq("tg_code", arg).gt("tg_code_until", new Date().toISOString()).maybeSingle();
      if (b) { await db.from("user_bots").update({ tg_chat: chat, tg_code: null, tg_code_until: null }).eq("id", b.id); await say(`✅ Ваш бот с сайта привязан${b.active_profile ? ` (профиль «${esc(b.active_profile)}»)` : ""}. Сюда будут приходить его сделки и новые сигналы его профиля.\n\n${HELP}`); }
      else await say("Ссылка устарела — на сайте нажмите «Подключить Telegram» ещё раз.");
    } else await say(`👋 Это бот <b>Sigma Radar</b>. Сюда будут приходить сделки общего бота и новые сигналы с силой ≥ 60 (по правилам общего бота).\n\n${HELP}`);
  } else if (!sub && cmd !== "/unlink" && cmd !== "/mysignals" && cmd !== "/market") await say("Сначала нажмите /start.");
  else if (cmd === "/mysignals" || cmd === "/market") {   // switches of the linked bot: its profile's signals / the "Рынок" signals
    const col = cmd === "/market" ? "tg_mkt" : "tg_sig", what = cmd === "/market" ? "Сигналы вашего «Рынка»" : "Сигналы вашего профиля";
    const { data: bots } = await db.from("user_bots").select(col).eq("tg_chat", chat);
    if (!bots?.length) await say("Сначала привяжите своего бота: на сайте «Журнал» → «Мой бот» → «Подключить Telegram».");
    else { const on = arg ? !/^(off|выкл|0|нет)$/i.test(arg) : !bots[0][col]; await db.from("user_bots").update({ [col]: on }).eq("tg_chat", chat); await say(`${what}: ${on ? "включены" : "выключены"}.`); }
  } else if (cmd === "/signals" || cmd === "/shared") {
    const k = cmd.slice(1), on = arg ? !/^(off|выкл|0|нет)$/i.test(arg) : !sub[k];
    await db.from("tg_subs").update({ [k]: on }).eq("chat_id", chat);
    await say(`${k === "signals" ? "Сигналы ≥ 60" : "Сделки общего бота"}: ${on ? "включены" : "выключены"}.`);
  } else if (cmd === "/status") {
    const { data: bots } = await db.from("user_bots").select("active_profile, tg_sig, tg_mkt, config").eq("tg_chat", chat);
    const ago = (t: string) => { const m = Math.round((Date.now() - Date.parse(t)) / 6e4); return m < 60 ? `${m} мин назад` : m < 2880 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`; };
    await say(`Сигналы ≥ 60: ${sub.signals ? "вкл" : "выкл"} (правила общего бота)\nСделки общего бота: ${sub.shared ? "вкл" : "выкл"}\nВаш бот с сайта: ${bots?.length ? bots.map((x: any) => `привязан${x.active_profile ? ` («${esc(x.active_profile)}»)` : ""}, сигналы профиля ${x.tg_sig === false ? "выкл" : "вкл"}, сигналы «Рынка» ${x.tg_mkt === false ? "выкл" : x.config?.scan ? `вкл (${esc(x.config.scan.tf)}, ${x.config.scan.top} монет)` : "ждут, пока вы откроете сайт"}`).join(", ") : "не привязан"}\n` +
      `Сообщений отправлено: ${sub.sent_n || 0}${sub.last_ok ? `, последнее ${ago(sub.last_ok)}` : ""}${sub.last_err ? `\n⚠️ Последняя ошибка отправки: ${esc(sub.last_err)}` : ""}\n\nТо же, что колокольчик на сайте, приходит в «сигналах «Рынка»» — по вашим настройкам таймфрейма и числа монет (обновляются, когда вы открываете сайт).`);
  } else if (cmd === "/unlink") {
    await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat); await say("Бот с сайта отвязан.");
  } else if (cmd === "/stop") {
    await db.from("tg_subs").delete().eq("chat_id", chat); await db.from("user_bots").update({ tg_chat: null }).eq("tg_chat", chat);
    await say("Вы отписались от всего. Вернуться — /start.");
  } else await say(HELP);
}
