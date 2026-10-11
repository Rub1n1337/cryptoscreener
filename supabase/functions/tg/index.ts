// Telegram webhook: Telegram calls this the moment someone writes to the bot or presses a button, so answers come in a second, not a minute.
// The bot function registers the webhook (setWebhook) with tg_config.wh_secret; Telegram sends it back in a header,
// anything without it is refused. Deployed without JWT checks — Telegram can't send one; the secret is the check.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleUpdate } from "../_shared/tg.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const { data: tg } = await db.from("tg_config").select("enabled, bot_token, wh_secret").eq("id", 1).maybeSingle();
  if (!tg?.enabled || !tg.bot_token || req.headers.get("x-telegram-bot-api-secret-token") !== tg.wh_secret) return new Response("forbidden", { status: 403 });
  let u: any; try { u = await req.json(); } catch { return new Response("ok"); }
  const call = (method: string, body: Record<string, unknown>) => fetch(`https://api.telegram.org/bot${tg.bot_token}/${method}`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
  try { await handleUpdate(db, u, call); } catch { /* a bad update must not make Telegram retry forever */ }
  return new Response("ok");   // always 200: otherwise Telegram re-sends the same update
});
