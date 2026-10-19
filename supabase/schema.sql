-- The whole database as it was on 19.10.2026, before supabase/hardening.sql (apply that file after this one).
-- Exported from the live project so the schema lives in the repository: several tables and functions were created by
-- migrations straight in Supabase and existed nowhere else. Only structure — no data, no tokens.
-- Extensions: pgcrypto (schema extensions), pg_cron, pg_net. Jobs: supabase/cron.sql, plus
--   bot-watchdog            */5 * * * *   select public.bot_watchdog()
--   cleanup-abandoned-bots  17 3 * * *    select public.cleanup_abandoned_bots()

-- ---------- tables ----------
create table if not exists public.beta_admin (
  id integer default 1 not null,
  pass_hash text not null,
  fails integer default 0 not null,
  locked_until timestamp with time zone,
  constraint beta_admin_id_check CHECK ((id = 1)),
  constraint beta_admin_pkey PRIMARY KEY (id)
);
alter table public.beta_admin enable row level security;

create table if not exists public.beta_keys (
  id uuid default gen_random_uuid() not null,
  code_hash text not null,
  note text,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  revoked boolean default false not null,
  uses integer default 0 not null,
  last_used timestamp with time zone,
  constraint beta_keys_code_hash_key UNIQUE (code_hash),
  constraint beta_keys_pkey PRIMARY KEY (id)
);
alter table public.beta_keys enable row level security;

create table if not exists public.bot_runs (
  id bigint generated always as identity not null,
  ts timestamp with time zone default now() not null,
  ok boolean not null,
  ms integer,
  scanned integer,
  signals integer,
  opened integer,
  closed integer,
  error text,
  constraint bot_runs_pkey PRIMARY KEY (id)
);
alter table public.bot_runs enable row level security;
create policy "public read" on public.bot_runs for SELECT to anon, authenticated using (true);

create table if not exists public.bot_secret (
  id integer default 1 not null,
  token text default encode(gen_random_bytes(24), 'hex'::text) not null,
  constraint bot_secret_id_check CHECK ((id = 1)),
  constraint bot_secret_pkey PRIMARY KEY (id)
);
alter table public.bot_secret enable row level security;

create table if not exists public.bot_state (
  id integer default 1 not null,
  balance double precision default 10000 not null,
  start_balance double precision default 10000 not null,
  settings jsonb default '{"N": 210, "k": 3.5, "rr": 2, "tf": "4h", "lev": 3, "top": 50, "risk": 0.01, "erMax": 0.25, "maxHL": 20, "method": "log", "minScore": 60, "strategy": "switch", "timeStop": 48, "regimeSrc": "majors", "regimeOnly": "any"}'::jsonb not null,
  checked_at timestamp with time zone,
  last_error text,
  scanned integer,
  lock_until timestamp with time zone,
  sig_sent jsonb default '{}'::jsonb not null,
  constraint bot_state_id_check CHECK ((id = 1)),
  constraint bot_state_pkey PRIMARY KEY (id)
);
alter table public.bot_state enable row level security;
create policy "public read" on public.bot_state for SELECT to anon, authenticated using (true);

create table if not exists public.positions (
  id text not null,
  sym text not null,
  side text not null,
  entry double precision not null,
  last double precision,
  tp double precision not null,
  sl double precision not null,
  qty double precision not null,
  time bigint not null,
  tfms bigint not null,
  note text,
  risk double precision,
  snap jsonb,
  ts integer,
  constraint positions_pkey PRIMARY KEY (id),
  constraint positions_side_check CHECK ((side = ANY (ARRAY['LONG'::text, 'SHORT'::text])))
);
alter table public.positions enable row level security;
create policy "public read" on public.positions for SELECT to anon, authenticated using (true);

create table if not exists public.tg_config (
  id integer default 1 not null,
  enabled boolean default false not null,
  bot_token text,
  chat_id text,
  bot_name text,
  upd_offset bigint default 0,
  wh_secret text default encode(gen_random_bytes(24), 'hex'::text) not null,
  wh_ok boolean default false not null,
  alert_chat bigint,
  alert_at timestamp with time zone,
  alert_down boolean default false not null,
  constraint tg_config_id_check CHECK ((id = 1)),
  constraint tg_config_pkey PRIMARY KEY (id)
);
alter table public.tg_config enable row level security;

create table if not exists public.tg_subs (
  chat_id bigint not null,
  shared boolean default true not null,
  signals boolean default true not null,
  name text,
  created_at timestamp with time zone default now() not null,
  last_ok timestamp with time zone,
  last_err text,
  sent_n integer default 0 not null,
  constraint tg_subs_pkey PRIMARY KEY (chat_id)
);
alter table public.tg_subs enable row level security;

create table if not exists public.trades (
  id text not null,
  sym text not null,
  side text not null,
  entry double precision not null,
  exit double precision not null,
  tp double precision not null,
  sl double precision not null,
  qty double precision not null,
  pnl double precision not null,
  time bigint not null,
  tclose bigint not null,
  note text,
  reason text,
  fee double precision,
  gross double precision,
  r double precision,
  snap jsonb,
  constraint trades_pkey PRIMARY KEY (id)
);
alter table public.trades enable row level security;
create policy "public read" on public.trades for SELECT to anon, authenticated using (true);

create table if not exists public.trades_archive (
  id text, sym text, side text, entry double precision, exit double precision, tp double precision, sl double precision,
  qty double precision, pnl double precision, time bigint, tclose bigint, note text, reason text, fee double precision,
  gross double precision, r double precision, snap jsonb, archived_at timestamp with time zone, archive_note text
);
alter table public.trades_archive enable row level security;

create table if not exists public.user_bots (
  id uuid default gen_random_uuid() not null,
  secret_hash text not null,
  name text default 'Мой бот'::text not null,
  config jsonb default '{}'::jsonb not null,
  enabled boolean default true not null,
  balance double precision default 10000 not null,
  start_balance double precision default 10000 not null,
  active_profile text,
  regime jsonb,
  checked_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone default now() not null,
  last_seen timestamp with time zone default now() not null,
  tg_chat bigint,
  tg_code text,
  tg_code_until timestamp with time zone,
  tg_sig boolean default true not null,
  sig_sent jsonb default '{}'::jsonb not null,
  tg_mkt boolean default true not null,
  alerts jsonb,
  constraint user_bots_pkey PRIMARY KEY (id)
);
alter table public.user_bots enable row level security;

create table if not exists public.user_positions (
  bot_id uuid not null,
  id text not null,
  data jsonb not null,
  constraint user_positions_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES user_bots(id) ON DELETE CASCADE,
  constraint user_positions_pkey PRIMARY KEY (bot_id, id)
);
alter table public.user_positions enable row level security;

create table if not exists public.user_trades (
  bot_id uuid not null,
  id text not null,
  tclose bigint not null,
  data jsonb not null,
  constraint user_trades_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES user_bots(id) ON DELETE CASCADE,
  constraint user_trades_pkey PRIMARY KEY (bot_id, id)
);
alter table public.user_trades enable row level security;

CREATE INDEX IF NOT EXISTS bot_runs_ts_idx ON public.bot_runs USING btree (ts DESC);
CREATE INDEX IF NOT EXISTS trades_tclose_idx ON public.trades USING btree (tclose DESC);
CREATE INDEX IF NOT EXISTS user_bots_queue ON public.user_bots USING btree (checked_at NULLS FIRST) WHERE enabled;
CREATE INDEX IF NOT EXISTS user_trades_bot_idx ON public.user_trades USING btree (bot_id, tclose DESC);

-- what the site may read (column lists): see supabase/security.sql

-- ---------- functions (the ones hardening.sql replaces are left out: _beta_admin_ok, beta_redeem, ub_create, cleanup_abandoned_bots) ----------
CREATE OR REPLACE FUNCTION public.ub_auth(p_id uuid, p_secret text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
  select exists (select 1 from user_bots where id = p_id and secret_hash = encode(digest(p_secret, 'sha256'), 'hex'));
$function$;
revoke all on function public.ub_auth(uuid, text) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ub_get(p_id uuid, p_secret text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set last_seen = now() where id = p_id and last_seen < now() - interval '10 minutes';
  return (select jsonb_build_object(
    'bot', (select to_jsonb(b) - 'secret_hash' - 'tg_code' - 'tg_code_until' - 'sig_sent' from user_bots b where b.id = p_id),
    'open', coalesce((select jsonb_agg(data) from user_positions where bot_id = p_id), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(data order by tclose desc) from (select data, tclose from user_trades where bot_id = p_id order by tclose desc limit 1000) t), '[]'::jsonb)));
end $function$;

CREATE OR REPLACE FUNCTION public.ub_set(p_id uuid, p_secret text, p_config jsonb, p_enabled boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if octet_length(p_config::text) > 50000 then raise exception 'config too large'; end if;
  update user_bots set config = p_config, enabled = p_enabled where id = p_id;
end $function$;

CREATE OR REPLACE FUNCTION public.ub_reset(p_id uuid, p_secret text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  delete from user_positions where bot_id = p_id;
  delete from user_trades where bot_id = p_id;
  update user_bots set balance = start_balance, last_error = null where id = p_id;
end $function$;

CREATE OR REPLACE FUNCTION public.ub_alerts(p_id uuid, p_secret text, p_alerts jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_alerts) <> 'object' or octet_length(p_alerts::text) > 2000 then raise exception 'bad alerts'; end if;
  update user_bots set alerts = p_alerts where id = p_id;
end $function$;

CREATE OR REPLACE FUNCTION public.ub_close(p_id uuid, p_secret text, p_pos text DEFAULT NULL::text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare n integer;
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_positions set data = data || '{"closeReq": true}'::jsonb
   where bot_id = p_id and (p_pos is null or id = p_pos);
  get diagnostics n = row_count;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.ub_tg_link(p_id uuid, p_secret text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare c text := 'b' || encode(gen_random_bytes(9), 'hex');
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set tg_code = c, tg_code_until = now() + interval '30 minutes' where id = p_id;
  return jsonb_build_object('code', c, 'bot', (select bot_name from tg_config where id = 1 and enabled));
end $function$;

CREATE OR REPLACE FUNCTION public.ub_tg_unlink(p_id uuid, p_secret text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set tg_chat = null, tg_code = null, tg_code_until = null where id = p_id;
end $function$;

CREATE OR REPLACE FUNCTION public.tg_bot_name() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select bot_name from tg_config where id = 1 and enabled;
$function$;

CREATE OR REPLACE FUNCTION public.bot_try_lock(seconds integer) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  update bot_state set lock_until = now() + make_interval(secs => seconds)
  where id = 1 and (lock_until is null or lock_until < now())
  returning true;
$function$;
revoke all on function public.bot_try_lock(integer) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.beta_issue(p_admin text, p_hours integer, p_note text DEFAULT NULL::text) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := gen_random_bytes(8); code text := 'SR-'; exp timestamptz; i int;
begin
  if not public._beta_admin_ok(p_admin) then return json_build_object('ok', false, 'error', 'Неверный пароль владельца или слишком много попыток — подождите 15 минут'); end if;
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    if i = 3 then code := code || '-'; end if;
  end loop;
  exp := now() + make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 24 * 90)));
  insert into public.beta_keys (code_hash, note, expires_at) values (encode(digest(code, 'sha256'), 'hex'), left(nullif(trim(p_note), ''), 80), exp);
  return json_build_object('ok', true, 'code', code, 'expires_at', exp);
end $function$;

CREATE OR REPLACE FUNCTION public.beta_list(p_admin text) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not public._beta_admin_ok(p_admin) then return json_build_object('ok', false, 'error', 'Неверный пароль владельца или слишком много попыток — подождите 15 минут'); end if;
  return json_build_object('ok', true, 'keys', coalesce((select json_agg(x order by x.created_at desc) from (
    select id, note, created_at, expires_at, revoked, uses, last_used from public.beta_keys order by created_at desc limit 50) x), '[]'::json));
end $function$;

CREATE OR REPLACE FUNCTION public.beta_revoke(p_admin text, p_id uuid) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not public._beta_admin_ok(p_admin) then return json_build_object('ok', false, 'error', 'Неверный пароль владельца или слишком много попыток — подождите 15 минут'); end if;
  update public.beta_keys set revoked = true where id = p_id;
  return json_build_object('ok', true);
end $function$;

-- tells tg_config.alert_chat when the shared bot hasn't checked the market for 10 minutes (and when it is back)
CREATE OR REPLACE FUNCTION public.bot_watchdog() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare c record; st record; idle interval;
begin
  select * into c from tg_config where id = 1;
  if c is null or not c.enabled or c.bot_token is null or c.alert_chat is null then return; end if;
  select checked_at, last_error into st from bot_state where id = 1;
  idle := now() - coalesce(st.checked_at, now());
  if idle > interval '10 minutes' then
    if c.alert_down and c.alert_at > now() - interval '1 hour' then return; end if;   -- repeat at most hourly while it is down
    perform net.http_post(url := 'https://api.telegram.org/bot' || c.bot_token || '/sendMessage',
      body := jsonb_build_object('chat_id', c.alert_chat, 'text',
        '⚠️ Общий бот не отвечает уже ' || floor(extract(epoch from idle) / 60) || ' мин.' || coalesce(E'\nПоследняя ошибка: ' || left(st.last_error, 300), '')),
      headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000);
    update tg_config set alert_down = true, alert_at = now() where id = 1;
  elsif c.alert_down then
    perform net.http_post(url := 'https://api.telegram.org/bot' || c.bot_token || '/sendMessage',
      body := jsonb_build_object('chat_id', c.alert_chat, 'text', '✅ Общий бот снова работает.'),
      headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000);
    update tg_config set alert_down = false, alert_at = now() where id = 1;
  end if;
end $function$;
revoke all on function public.bot_watchdog() from public, anon, authenticated;
