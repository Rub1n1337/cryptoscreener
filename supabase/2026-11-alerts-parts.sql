-- Notification settings (user_bots.alerts) are saved in parts (docs/PLAN-UNTANGLE-accounts.md, fix 6). Up to 2.85 the site sent
-- the whole object from its snapshot, up to a minute old, and the Telegram menu wrote its own whole copy without a check: a change
-- made in the menu was undone by the next save on the site.
-- Now both send only what changed — {"sig":{"when":"touch"}}, {"quiet":{"on":true}}, {"mkt":{…}} — and the database merges it into
-- the stored value in one update (the row lock orders two saves): each key of the part replaces the stored one, and an object over an
-- object is merged one level down. A whole object, as an old tab sends it, is a part like any other. Checked as before: an object,
-- at most 2000 bytes (the part and the result).
-- How the value is read (defaults, junk): supabase/functions/_shared/alerts.js, one copy for the site, the menu and the bot.
-- Backward compatible: ub_alerts keeps its arguments and grants and now returns the saved value (a new return type needs drop and
-- create, in this one transaction); tg_alerts is new, for the Telegram menu (service role only). Apply before the functions push.

-- the merge itself; called only by the two functions below
create or replace function public._alerts_put(p_bot uuid, p_part jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare v jsonb;
begin
  if jsonb_typeof(p_part) is distinct from 'object' or octet_length(p_part::text) > 2000 then raise exception 'bad alerts'; end if;
  update user_bots b set alerts = (case when jsonb_typeof(b.alerts) = 'object' then b.alerts else '{}'::jsonb end) || (
      select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'object' and jsonb_typeof(b.alerts -> e.key) = 'object'
        then (b.alerts -> e.key) || e.value else e.value end), '{}'::jsonb)
      from jsonb_each(p_part) e)
    where b.id = p_bot returning b.alerts into v;
  if octet_length(v::text) > 2000 then raise exception 'bad alerts'; end if;
  return v;
end $$;
revoke all on function public._alerts_put(uuid, jsonb) from public, anon, authenticated, service_role;

-- the site («Мой бот» → Telegram): the profile's bot, or a bot by its secret (ub_auth)
drop function public.ub_alerts(uuid, text, jsonb);
create function public.ub_alerts(p_id uuid, p_secret text, p_alerts jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  return _alerts_put(p_id, p_alerts);
end $$;
revoke all on function public.ub_alerts(uuid, text, jsonb) from public, anon;
grant execute on function public.ub_alerts(uuid, text, jsonb) to authenticated;

-- the Telegram menu (functions/_shared/tg.ts): the bot that writes to this chat (at most one — tg_chat is the profile's Telegram,
-- one bot per profile); null when there is none
create or replace function public.tg_alerts(p_chat bigint, p_part jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select id into b from user_bots where tg_chat = p_chat limit 1;
  if b is null then return null; end if;
  return _alerts_put(b, p_part);
end $$;
revoke all on function public.tg_alerts(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.tg_alerts(bigint, jsonb) to service_role;

notify pgrst, 'reload schema';
