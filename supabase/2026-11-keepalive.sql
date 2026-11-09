-- Only the bot's own profile keeps it running (docs/PLAN-UNTANGLE-accounts.md, fix 8). A bot runs 30 days after its last visit
-- (last_seen, functions/bot: runUserBots). ub_get set last_seen for whoever read the bot, and the site reads a replaced bot to
-- show its result in «Удалить прежний серверный бот?» (oldBotAsk): a bot nobody uses got another month of trading unseen.
-- Now a read moves last_seen only for the profile's own bot. The Telegram menu of the bot's chat counts as a visit too (the
-- owner's decision, 09.11) — that is in functions/_shared/tg.ts, which writes as the service role.
-- Same signature, grants stay. Backward compatible with the site and the functions as they are.

create or replace function public.ub_get(p_id uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set last_seen = now()
   where id = p_id and user_id = auth.uid() and last_seen < now() - interval '10 minutes';
  return (select jsonb_build_object(
    'bot', (select to_jsonb(b) - 'secret_hash' - 'tg_code' - 'tg_code_until' - 'sig_sent' from user_bots b where b.id = p_id),
    'open', coalesce((select jsonb_agg(data) from user_positions where bot_id = p_id), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(data order by tclose desc) from (select data, tclose from user_trades where bot_id = p_id order by tclose desc limit 1000) t), '[]'::jsonb)));
end $$;

notify pgrst, 'reload schema';
