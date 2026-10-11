// Telegram webhook: Telegram calls this the moment someone writes to the bot, so answers come in a second, not a minute.
// The bot function registers the webhook (setWebhook) with tg_config.wh_secret; Telegram sends it back in a header,
// anything without it is refused. Deployed without JWT checks — Telegram can't send one; the secret is the check.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleMessage } from "../_shared/tg.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const { data: tg } = await db.from("tg_config").select("enabled, bot_token, wh_secret").eq("id", 1).maybeSingle();
  if (!tg?.enabled || !tg.bot_token || req.headers.get("x-telegram-bot-api-secret-token") !== tg.wh_secret) return new Response("forbidden", { status: 403 });
  let u: any; try { u = await req.json(); } catch { return new Response("ok"); }
  const say = (text: string) => fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: u.message.chat.id, text, parse_mode: "HTML", disable_web_page_preview: true }) }).catch(() => null);
  try { if (u?.message) await handleMessage(db, u.message, say); } catch { /* a bad message must not make Telegram retry forever */ }
  return new Response("ok");   // always 200: otherwise Telegram re-sends the same update
});
