-- Accounts, stage 3 (docs/PLAN-ACCOUNTS.md): the server bot, Telegram and the Beta follow the profile.
-- The server bot itself moves with the profile on the site side (sr_ubot is one of the synced keys); here:
--   ub_tg_me   — sends the bot's trades and signals to the Telegram account the person signed in with (no link code);
--   beta_*     — a code redeemed while signed in opens the Beta for the profile on every device (revoking the code closes it);
--                the owner's password, entered once while signed in, marks the profile as the owner's, and from then on the
--                owner's actions need no password.

alter table public.profiles add column if not exists beta_key uuid references public.beta_keys(id) on delete set null;

-- the bot's messages go to the signed-in person's own chat (their Telegram user id is their private chat with the bot, which
-- they opened when signing in). Other bots sent to this chat are unlinked, so an old device's bot can't double the signals.
create or replace function public.ub_tg_me(p_id uuid, p_secret text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found then raise exception 'no profile'; end if;
  update public.user_bots set tg_chat = null where tg_chat = p.tg_id and id <> p_id;
  update public.user_bots set tg_chat = p.tg_id, tg_code = null, tg_code_until = null where id = p_id;
  insert into public.tg_subs (chat_id, name, shared) values (p.tg_id, p.tg_name, false) on conflict (chat_id) do nothing;
  return json_build_object('ok', true);
end $$;
revoke all on function public.ub_tg_me(uuid, text) from public, anon;
grant execute on function public.ub_tg_me(uuid, text) to authenticated;

-- the owner's profile passes the owner check without the password
create or replace function public._beta_admin_ok(p_admin text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare a public.beta_admin; f public.beta_fails; v_ip text := public._client_ip(); p text := lower(trim(coalesce(p_admin, ''))); ok boolean;
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and is_owner) then return true; end if;
  select * into f from public.beta_fails where beta_fails.ip = v_ip;
  if f.locked_until is not null and f.locked_until > now() then return false; end if;
  select * into a from public.beta_admin where id = 1;
  ok := p <> '' and case when a.pass_hash like '$2%' then crypt(p, a.pass_hash) = a.pass_hash
                         else encode(digest(p, 'sha256'), 'hex') = a.pass_hash end;
  if ok then
    if a.pass_hash not like '$2%' then update public.beta_admin set pass_hash = crypt(p, gen_salt('bf', 10)) where id = 1; end if;
    delete from public.beta_fails where beta_fails.ip = v_ip;
    return true;
  end if;
  insert into public.beta_fails as b (ip, fails) values (v_ip, 1)
    on conflict (ip) do update set fails = case when b.locked_until < now() then 1 else b.fails + 1 end, locked_until = null;
  update public.beta_fails set locked_until = now() + interval '15 minutes' where beta_fails.ip = v_ip and fails >= 5;
  return false;
end $$;

-- the right password while signed in marks the profile as the owner's
create or replace function public.beta_owner(p_admin text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean := public._beta_admin_ok(p_admin);
begin
  if ok and auth.uid() is not null then update public.profiles set is_owner = true where id = auth.uid(); end if;
  return json_build_object('ok', ok);
end $$;

-- a code redeemed while signed in is kept on the profile
create or replace function public.beta_redeem(p_code text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare k public.beta_keys; h text := encode(digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex');
begin
  if not public._rl('br:' || public._client_ip(), 30, interval '10 minutes') then return json_build_object('ok', false, 'error', 'Слишком много попыток — подождите 10 минут'); end if;
  select * into k from public.beta_keys where code_hash = h;
  if not found then return json_build_object('ok', false, 'error', 'Такого кода нет'); end if;
  if k.revoked then return json_build_object('ok', false, 'error', 'Доступ по этому коду отозван'); end if;
  if k.expires_at <= now() then return json_build_object('ok', false, 'error', 'Срок действия кода истёк'); end if;
  update public.beta_keys set uses = uses + 1, last_used = now() where id = k.id;
  if auth.uid() is not null then update public.profiles set beta_key = k.id where id = auth.uid(); end if;
  return json_build_object('ok', true, 'expires_at', k.expires_at);
end $$;

-- the signed-in person's access to the Beta: {owner, exp} (exp — until when their code lasts; null — no code or it ended)
create or replace function public.beta_me() returns json language sql stable security definer set search_path = public as $$
  select coalesce((select json_build_object('owner', p.is_owner,
      'exp', (select k.expires_at from public.beta_keys k where k.id = p.beta_key and not k.revoked and k.expires_at > now()))
    from public.profiles p where p.id = auth.uid()), json_build_object('owner', false, 'exp', null));
$$;
revoke all on function public.beta_me() from public, anon;
grant execute on function public.beta_me() to authenticated;

notify pgrst, 'reload schema';
