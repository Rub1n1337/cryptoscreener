-- Applied 19.10.2026 (migration hardening_after_audit). Fixes from docs/AUDIT-2026-10-19.md.

-- ---------- per-address limits for the public RPCs ----------
-- the caller's address as Supabase's proxy reports it (Cloudflare sets cf-connecting-ip itself, so it can't be forged)
create or replace function public._client_ip() returns text language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip',
                  split_part(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ',', 1), 'unknown');
$$;
create table if not exists public.rl (k text primary key, n int not null, since timestamptz not null);
alter table public.rl enable row level security;
revoke all on public.rl from anon, authenticated;
-- true while key k was used at most `lim` times in the current window
create or replace function public._rl(k text, lim int, win interval) returns boolean language plpgsql security definer set search_path = public as $$
declare x public.rl;
begin
  insert into public.rl values (k, 1, now()) on conflict (k) do update
    set n = case when rl.since < now() - win then 1 else rl.n + 1 end,
        since = case when rl.since < now() - win then now() else rl.since end
  returning * into x;
  return x.n <= lim;
end $$;
revoke all on function public._rl(text, int, interval) from public, anon, authenticated;
revoke all on function public._client_ip() from public, anon, authenticated;

-- ---------- "Мой бот": new bots ----------
-- a new bot starts paused (the site enables it with its first ub_set a moment later); 5 bots an hour per address,
-- 200 an hour overall: a script can no longer fill the queue or lock everyone else out of creating one
create or replace function public.ub_create(p_config jsonb) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := encode(gen_random_bytes(24), 'hex'); b uuid;
begin
  if octet_length(coalesce(p_config, '{}'::jsonb)::text) > 50000 then raise exception 'config too large'; end if;
  if not public._rl('ubc:' || public._client_ip(), 5, interval '1 hour') then raise exception 'too many bots from this address, try later'; end if;
  if (select count(*) from user_bots where created_at > now() - interval '1 hour') > 200 then raise exception 'too many bots created, try later'; end if;
  insert into user_bots (secret_hash, config, enabled) values (encode(digest(s, 'sha256'), 'hex'), coalesce(p_config, '{}'::jsonb), false) returning id into b;
  return jsonb_build_object('id', b, 'secret', s);
end $$;

-- bots that never got a profile and no Telegram are gone after a day; the rest after 90 days without a visit, as before
create or replace function public.cleanup_abandoned_bots() returns integer language plpgsql security definer set search_path = public as $$
declare n integer; m integer;
begin
  delete from user_bots where last_seen < now() - interval '90 days' and tg_chat is null;   -- positions and trades follow (on delete cascade)
  get diagnostics n = row_count;
  delete from user_bots where created_at < now() - interval '1 day' and tg_chat is null
    and (case when jsonb_typeof(config->'profiles') = 'array' then jsonb_array_length(config->'profiles') else 0 end) = 0;
  get diagnostics m = row_count;
  return n + m;
end $$;

-- ---------- one write per bot step: trades, positions and balance together ----------
-- Before, a failed balance update after the position was already removed lost that trade's P&L for good.
-- A manual close (ub_close) that lands while the bot is mid-step is kept: closeReq survives the position's rewrite.
create or replace function public.ub_commit(p_bot uuid, p_closed jsonb, p_keep jsonb, p_balance float8, p_profile text, p_regime jsonb, p_checked timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into user_trades (bot_id, id, tclose, data)
    select p_bot, t->>'id', (t->>'tclose')::bigint, t from jsonb_array_elements(coalesce(p_closed, '[]')) t
    on conflict (bot_id, id) do nothing;
  delete from user_positions where bot_id = p_bot and id in (select t->>'id' from jsonb_array_elements(coalesce(p_closed, '[]')) t);
  insert into user_positions (bot_id, id, data)
    select p_bot, p->>'id', p from jsonb_array_elements(coalesce(p_keep, '[]')) p
    on conflict (bot_id, id) do update set data = excluded.data
      || case when user_positions.data ? 'closeReq' then jsonb_build_object('closeReq', true) else '{}'::jsonb end;
  update user_bots set balance = p_balance, checked_at = p_checked, active_profile = p_profile, regime = p_regime, last_error = null where id = p_bot;
end $$;
create or replace function public.bot_commit(p_closed jsonb, p_open jsonb, p_balance float8, p_checked timestamptz, p_scanned int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into trades select * from jsonb_populate_recordset(null::trades, coalesce(p_closed, '[]')) on conflict (id) do nothing;
  delete from positions where id in (select t->>'id' from jsonb_array_elements(coalesce(p_closed, '[]')) t);
  insert into positions select * from jsonb_populate_recordset(null::positions, coalesce(p_open, '[]'))
    on conflict (id) do update set sym = excluded.sym, side = excluded.side, entry = excluded.entry, last = excluded.last, tp = excluded.tp,
      sl = excluded.sl, qty = excluded.qty, time = excluded.time, tfms = excluded.tfms, note = excluded.note, risk = excluded.risk, snap = excluded.snap, ts = excluded.ts;
  update bot_state set balance = p_balance, checked_at = p_checked, scanned = p_scanned, last_error = null where id = 1;
end $$;
revoke all on function public.ub_commit(uuid, jsonb, jsonb, float8, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.bot_commit(jsonb, jsonb, float8, timestamptz, int) from public, anon, authenticated;

-- ---------- the run lock belongs to one run ----------
-- a run that outlived its lock no longer clears the lock of the run that took over
alter table public.bot_state add column if not exists lock_run text;
create or replace function public.bot_lock(p_run text, seconds int) returns boolean language sql security definer set search_path = public as $$
  update bot_state set lock_until = now() + make_interval(secs => seconds), lock_run = p_run
  where id = 1 and (lock_until is null or lock_until < now()) returning true;
$$;
create or replace function public.bot_unlock(p_run text) returns void language sql security definer set search_path = public as $$
  update bot_state set lock_until = null where id = 1 and lock_run = p_run;
$$;
revoke all on function public.bot_lock(text, int) from public, anon, authenticated;
revoke all on function public.bot_unlock(text) from public, anon, authenticated;

-- ---------- Telegram: the per-chat counter in one statement ----------
create or replace function public.tg_sent(p_chat bigint, p_ok boolean, p_err text) returns void language sql security definer set search_path = public as $$
  update tg_subs set last_ok = case when p_ok then now() else last_ok end, last_err = case when p_ok then null else left(p_err, 200) end,
    sent_n = sent_n + case when p_ok then 1 else 0 end where chat_id = p_chat;
$$;
revoke all on function public.tg_sent(bigint, boolean, text) from public, anon, authenticated;

-- ---------- the collector's /scan answers only the bot ----------
-- the bot sends this token; the collector reads the same value from its SCAN_TOKEN variable (set by the owner on Railway)
alter table public.bot_secret add column if not exists scan text default encode(gen_random_bytes(24), 'hex');
update public.bot_secret set scan = encode(gen_random_bytes(24), 'hex') where scan is null;

-- ---------- Beta: the owner's password is checked here only ----------
-- the site no longer carries a hash of it. Wrong attempts are counted per address (5, then 15 minutes), so a stranger
-- can't lock the owner out; the stored hash becomes a salted bcrypt one on the first correct login
create table if not exists public.beta_fails (ip text primary key, fails int not null default 0, locked_until timestamptz);
alter table public.beta_fails enable row level security;
revoke all on public.beta_fails from anon, authenticated;
create or replace function public._beta_admin_ok(p_admin text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare a public.beta_admin; f public.beta_fails; v_ip text := public._client_ip(); p text := lower(trim(coalesce(p_admin, ''))); ok boolean;
begin
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
-- the site's owner login
create or replace function public.beta_owner(p_admin text) returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  return json_build_object('ok', public._beta_admin_ok(p_admin));
end $$;
grant execute on function public.beta_owner(text) to anon, authenticated;
-- codes: 30 tries per 10 minutes per address (a code has 40 bits, guessing stays hopeless either way)
create or replace function public.beta_redeem(p_code text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare k public.beta_keys; h text := encode(digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex');
begin
  if not public._rl('br:' || public._client_ip(), 30, interval '10 minutes') then return json_build_object('ok', false, 'error', 'Слишком много попыток — подождите 10 минут'); end if;
  select * into k from public.beta_keys where code_hash = h;
  if not found then return json_build_object('ok', false, 'error', 'Такого кода нет'); end if;
  if k.revoked then return json_build_object('ok', false, 'error', 'Доступ по этому коду отозван'); end if;
  if k.expires_at <= now() then return json_build_object('ok', false, 'error', 'Срок действия кода истёк'); end if;
  update public.beta_keys set uses = uses + 1, last_used = now() where id = k.id;
  return json_build_object('ok', true, 'expires_at', k.expires_at);
end $$;

-- ---------- nothing the site doesn't read ----------
revoke select on public.tg_subs from anon, authenticated;
revoke select on public.trades_archive from anon, authenticated;

-- Applied 19.10.2026 (migration cleanup_rate_tables): the nightly cleanup also empties the per-address counters
create or replace function public.cleanup_abandoned_bots() returns integer language plpgsql security definer set search_path = public as $$
declare n integer; m integer;
begin
  delete from user_bots where last_seen < now() - interval '90 days' and tg_chat is null;
  get diagnostics n = row_count;
  delete from user_bots where created_at < now() - interval '1 day' and tg_chat is null
    and (case when jsonb_typeof(config->'profiles') = 'array' then jsonb_array_length(config->'profiles') else 0 end) = 0;
  get diagnostics m = row_count;
  -- per-address counters (rate limits, beta login attempts) only matter for an hour or so
  delete from rl where since < now() - interval '1 day';
  delete from beta_fails where coalesce(locked_until, now() - interval '2 days') < now() - interval '1 day';
  return n + m;
end $$;
