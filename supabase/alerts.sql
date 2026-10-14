-- Notification settings of a bot's linked Telegram chat, edited by the site (ub_alerts) and by the Telegram menu.
-- Kept apart from `config`, which the site overwrites with every profile change.
--   sig: the bot's own signals — {on, top: 0 (the bot's coins) | 50..250 (wider, for trading by hand),
--        when: 'confirmed' (a confirmed reversal, as the bot enters) | 'touch' (at the touch, then updated), sides: 'both' | 'long'}
--   mkt: a separate filter with its own channel settings, saved explicitly — {on, tf, top, minScore, method, N, k} or null
alter table public.user_bots add column if not exists alerts jsonb;

-- once: the old switches and the "Рынок" settings the site used to send with every sync become explicit settings
update public.user_bots set alerts = jsonb_build_object(
  'sig', jsonb_build_object('on', tg_sig is distinct from false, 'top', coalesce((config->>'sigTop')::int, 0), 'when', 'confirmed', 'sides', 'both'),
  'mkt', case when jsonb_typeof(config->'scan') = 'object' then (config->'scan') || jsonb_build_object('on', tg_mkt is distinct from false) else null end)
where alerts is null;

create or replace function public.ub_alerts(p_id uuid, p_secret text, p_alerts jsonb)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_alerts) <> 'object' or octet_length(p_alerts::text) > 2000 then raise exception 'bad alerts'; end if;
  update user_bots set alerts = p_alerts where id = p_id;
end $$;
revoke all on function public.ub_alerts(uuid, text, jsonb) from public;
grant execute on function public.ub_alerts(uuid, text, jsonb) to anon, authenticated;
