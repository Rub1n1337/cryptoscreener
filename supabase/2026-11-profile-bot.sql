-- Accounts, stage 5 (docs/PLAN-ACCOUNTS.md): the profile's server bot is known to the server.
-- Before, only the devices knew which bot was the profile's (the synced sr_ubot, id and secret), and Telegram was linked per bot,
-- so several bots of one person could write to one chat. Now:
--   user_bots.user_id  — the profile the bot belongs to, at most one bot per profile; deleting the profile deletes its bot;
--   ub_auth            — a profile's bot is reached through its profile (the caller's token), a bot without one by its secret;
--   ub_mine / ub_claim — a device asks for the profile's bot, or hands its own bot to a profile that has none (first one wins);
--   ub_create          — a signed-in person gets the profile's bot back if there is one, otherwise a new bot of the profile;
--   ub_tg              — Telegram on/off: only the profile's bot, only to the profile's Telegram. Bots without a profile never
--                        write (a check, not a hope); linking by code (ub_tg_link, /start b…) is gone;
--   sr_ubot            — no longer kept in the profile.
-- The site opens only signed in (stage 4), so anon needs none of the ub_* functions.

alter table public.user_bots add column if not exists user_id uuid references public.profiles(id) on delete cascade;
create unique index if not exists user_bots_user_id on public.user_bots (user_id) where user_id is not null;

-- a profile's bot answers to its profile only; the secret still opens a bot that no profile has claimed
create or replace function public.ub_auth(p_id uuid, p_secret text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from user_bots where id = p_id and case when user_id is not null then user_id = auth.uid()
    else secret_hash = encode(digest(p_secret, 'sha256'), 'hex') end);
$$;
revoke all on function public.ub_auth(uuid, text) from public, anon, authenticated;

-- the signed-in profile's bot: {id, tg} or null
create or replace function public.ub_mine() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('id', id, 'tg', tg_chat is not null) from user_bots where user_id = auth.uid();
$$;
revoke all on function public.ub_mine() from public, anon, authenticated;
grant execute on function public.ub_mine() to authenticated;

-- a device hands its own bot (by the secret) to a profile without one; returns the profile's bot after the call: {id}.
-- When another device of the profile was first, that device's bot is returned and this one stays as it was
create or replace function public.ub_claim(p_id uuid, p_secret text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := (select id from profiles where id = auth.uid()); b uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select id into b from user_bots where user_id = v_uid;
  if b is not null then return json_build_object('id', b); end if;
  if not exists (select 1 from user_bots where id = p_id and user_id is null and secret_hash = encode(digest(p_secret, 'sha256'), 'hex'))
    then raise exception 'forbidden'; end if;
  begin
    update user_bots set user_id = v_uid where id = p_id and user_id is null;
  exception when unique_violation then null;   -- another device claimed its bot a moment earlier
  end;
  return json_build_object('id', (select id from user_bots where user_id = v_uid));
end $$;
revoke all on function public.ub_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.ub_claim(uuid, text) to authenticated;

-- a new bot belongs to the signed-in profile; a profile that has one gets it back ({id, secret: null, existing: true}),
-- also when two devices press «На сервере» together (the unique index lets one insert through)
create or replace function public.ub_create(p_config jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := encode(gen_random_bytes(24), 'hex'); b uuid; v_uid uuid := (select id from profiles where id = auth.uid());
begin
  if v_uid is not null then
    select id into b from user_bots where user_id = v_uid;
    if b is not null then return jsonb_build_object('id', b, 'secret', null, 'existing', true); end if;
  end if;
  if octet_length(coalesce(p_config, '{}'::jsonb)::text) > 50000 then raise exception 'config too large'; end if;
  if not public._rl('ubc:' || public._client_ip(), 5, interval '1 hour') then raise exception 'too many bots from this address, try later'; end if;
  if (select count(*) from user_bots where created_at > now() - interval '1 hour') > 200 then raise exception 'too many bots created, try later'; end if;
  begin
    insert into user_bots (secret_hash, config, enabled, user_id) values (encode(digest(s, 'sha256'), 'hex'), coalesce(p_config, '{}'::jsonb), false, v_uid)
      returning id into b;
  exception when unique_violation then
    return jsonb_build_object('id', (select id from user_bots where user_id = v_uid), 'secret', null, 'existing', true);
  end;
  return jsonb_build_object('id', b, 'secret', case when v_uid is null then s end);   -- the profile's bot needs no secret
end $$;

-- p_enabled null keeps the bot's on/off: devices push their settings to the one profile bot, and only the person's own
-- «Пауза» / «Продолжить» may change it (a device's journal flag paused the bot for every device)
create or replace function public.ub_set(p_id uuid, p_secret text, p_config jsonb, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if octet_length(p_config::text) > 50000 then raise exception 'config too large'; end if;
  update user_bots set config = p_config, enabled = coalesce(p_enabled, enabled) where id = p_id;
end $$;

-- Telegram of the profile's bot: on — its messages go to the profile's Telegram (the private chat with the bot is the
-- Telegram user id); off — they stop. No other bot and no other chat
create or replace function public.ub_tg(p_on boolean) returns json
language plpgsql security definer set search_path = public as $$
declare p public.profiles; b uuid;
begin
  select * into p from profiles where id = auth.uid();
  if not found then raise exception 'not signed in'; end if;
  select id into b from user_bots where user_id = p.id;
  if b is null then raise exception 'no bot'; end if;
  if p_on then
    update user_bots set tg_chat = p.tg_id where id = b;
    insert into tg_subs (chat_id, name, shared) values (p.tg_id, p.tg_name, false) on conflict (chat_id) do nothing;
  else
    update user_bots set tg_chat = null where id = b;
  end if;
  return json_build_object('tg', p_on);
end $$;
revoke all on function public.ub_tg(boolean) from public, anon, authenticated;
grant execute on function public.ub_tg(boolean) to authenticated;

-- ---------- moving the data ----------
-- 1. each profile's bot, from the sr_ubot its devices kept in the profile (the secret must match the bot)
update user_bots b set user_id = s.user_id
  from user_state s join profiles p on p.id = s.user_id
 where s.key = 'sr_ubot' and b.id::text = s.value->>'id' and b.user_id is null
   and b.secret_hash = encode(extensions.digest(s.value->>'secret', 'sha256'), 'hex');
-- 2. Telegram moves to the profile's bot when another bot was linked to the profile's Telegram (the owner's decision, 02.11)
update user_bots b set tg_chat = p.tg_id
  from profiles p
 where b.user_id = p.id and b.tg_chat is null
   and exists (select 1 from user_bots o where o.tg_chat = p.tg_id and o.id <> b.id);
insert into tg_subs (chat_id, name, shared)
  select p.tg_id, p.tg_name, false from profiles p join user_bots b on b.user_id = p.id where b.tg_chat = p.tg_id
  on conflict (chat_id) do nothing;
-- 3. only a profile's bot writes, and only to its profile's Telegram
update user_bots set tg_chat = null where user_id is null and tg_chat is not null;
update user_bots b set tg_chat = null from profiles p where b.user_id = p.id and b.tg_chat <> p.tg_id;
alter table public.user_bots add constraint user_bots_tg_needs_profile check (tg_chat is null or user_id is not null);
-- 4. the profile no longer keeps bot keys
delete from user_state where key = 'sr_ubot';

-- a page that hasn't reloaded since this release may still send sr_ubot: accepted and dropped, so its other keys still go
create or replace function public.state_put(p_key text, p_value jsonb, p_version integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_key = 'sr_ubot' then return coalesce(p_version, 0) + 1; end if;
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

-- ---------- linking by code is gone ----------
drop function if exists public.ub_tg_link(uuid, text);
drop function if exists public.ub_tg_me(uuid, text);
drop function if exists public.ub_tg_unlink(uuid, text);
alter table public.user_bots drop column if exists tg_code, drop column if exists tg_code_until;

-- ---------- who may call what: the site calls only signed in ----------
revoke all on function public.ub_create(jsonb) from public, anon;
revoke all on function public.ub_get(uuid, text) from public, anon;
revoke all on function public.ub_set(uuid, text, jsonb, boolean) from public, anon;
revoke all on function public.ub_reset(uuid, text, double precision) from public, anon;
revoke all on function public.ub_close(uuid, text, text) from public, anon;
revoke all on function public.ub_alerts(uuid, text, jsonb) from public, anon;
revoke all on function public.ub_delete(uuid, text) from public, anon;
grant execute on function public.ub_create(jsonb), public.ub_get(uuid, text), public.ub_set(uuid, text, jsonb, boolean),
  public.ub_reset(uuid, text, double precision), public.ub_close(uuid, text, text), public.ub_alerts(uuid, text, jsonb),
  public.ub_delete(uuid, text) to authenticated;

notify pgrst, 'reload schema';
