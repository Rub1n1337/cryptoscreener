-- Cleanup after the accounts untangling (docs/PLAN-UNTANGLE-accounts.md, fix 10): what was kept for the move to profile bots
-- (2.75) and has no reader any more. Nothing the site, the Telegram menu or the bot reads changes; signatures and grants stay.
--   state_put — no longer swallows sr_ubot: a page from before 2.75 has long reloaded (every deploy reloads open tabs);
--   ub_create — only for a signed-in profile: the bot with a secret for a browser without a profile went with the sign-in gate
--               (2.75; anon can't call it, but a token without a profile row still could). The limit per address (_rl) stays;
--   ub_get    — no longer removes tg_code / tg_code_until, columns dropped in 2.75;
--   ub_mine   — only the id: the site never read tg;
--   columns   — user_bots.tg_sig, tg_mkt (replaced by alerts in supabase/alerts.sql), name; tg_subs.signals (the stream of
--               signals ≥ 60, removed earlier). No function, view or policy reads them (checked in pg_proc, 09.11).
-- Apply before the functions push (the bot then stops reading tg_config.chat_id, which is empty).

-- 1. functions and columns
create or replace function public.state_put(p_key text, p_value jsonb, p_version integer) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_key !~ '^sr_[a-z]{1,20}$' then raise exception 'bad key'; end if;
  if pg_column_size(p_value) > 262144 then raise exception 'too big'; end if;
  if (select count(*) from user_state where user_id = auth.uid()) >= 40 and not exists (select 1 from user_state where user_id = auth.uid() and key = p_key)
    then raise exception 'too many keys'; end if;
  insert into user_state (user_id, key, value, version) values (auth.uid(), p_key, p_value, 1)
  on conflict (user_id, key) do update set value = excluded.value, version = user_state.version + 1, updated_at = now()
    where user_state.version = p_version
  returning version into v;
  return v;
end $$;

create or replace function public.ub_create(p_config jsonb) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare b uuid; v_uid uuid := (select id from profiles where id = auth.uid());
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select id into b from user_bots where user_id = v_uid;
  if b is not null then return jsonb_build_object('id', b, 'secret', null, 'existing', true); end if;
  if octet_length(coalesce(p_config, '{}'::jsonb)::text) > 50000 then raise exception 'config too large'; end if;
  if not public._rl('ubc:' || public._client_ip(), 5, interval '1 hour') then raise exception 'too many bots from this address, try later'; end if;
  if (select count(*) from user_bots where created_at > now() - interval '1 hour') > 200 then raise exception 'too many bots created, try later'; end if;
  begin
    -- the table wants a secret's hash; the profile's bot answers to the person's token, so this secret is never handed out
    insert into user_bots (secret_hash, config, enabled, user_id)
      values (encode(digest(gen_random_bytes(24), 'sha256'), 'hex'), coalesce(p_config, '{}'::jsonb), false, v_uid)
      returning id into b;
  exception when unique_violation then
    return jsonb_build_object('id', (select id from user_bots where user_id = v_uid), 'secret', null, 'existing', true);
  end;
  return jsonb_build_object('id', b, 'secret', null);
end $$;

create or replace function public.ub_get(p_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set last_seen = now()
   where id = p_id and user_id = auth.uid() and last_seen < now() - interval '10 minutes';
  return (select jsonb_build_object(
    'bot', (select to_jsonb(b) - 'secret_hash' - 'sig_sent' from user_bots b where b.id = p_id),
    'open', coalesce((select jsonb_agg(data) from user_positions where bot_id = p_id), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(data order by tclose desc) from (select data, tclose from user_trades where bot_id = p_id order by tclose desc limit 1000) t), '[]'::jsonb)));
end $$;

create or replace function public.ub_mine() returns json
language sql stable security definer set search_path to 'public' as $$
  select json_build_object('id', id) from user_bots where user_id = auth.uid();
$$;

alter table public.user_bots drop column if exists tg_sig, drop column if exists tg_mkt, drop column if exists name;
alter table public.tg_subs drop column if exists signals;

notify pgrst, 'reload schema';

-- 2. data — applied only with its own «да»: profile rows of keys that are no longer synced (sr_blay, the Beta's layout, and
-- sr_recent, recently opened coins — per device since 2.67). The sync reads only the profile's keys, so nothing reads them,
-- and nothing writes them back.
delete from public.user_state where key in ('sr_blay', 'sr_recent');
