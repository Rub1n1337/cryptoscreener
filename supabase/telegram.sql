-- Telegram for everyone: one bot (token in tg_config), any number of chats.
-- A chat that pressed Start gets the shared bot's trades and new signals ≥ 60 (each can be turned off with a command);
-- a chat linked to a personal bot ("Мой бот" on the server) also gets that bot's trades.
-- The bot function polls Telegram for new messages every minute (getUpdates), so no webhook is needed.

alter table public.tg_config add column if not exists bot_name text;          -- the bot's username without @, for t.me links
alter table public.tg_config add column if not exists upd_offset bigint default 0;   -- the last Telegram update already handled

alter table public.bot_state add column if not exists sig_sent jsonb not null default '{}'::jsonb;   -- signal ≥ 60 already announced: {"SYM:touchTime": ms}

alter table public.user_bots add column if not exists tg_chat bigint;          -- the Telegram chat that gets this bot's trades
alter table public.user_bots add column if not exists tg_code text;            -- one-time code for linking (t.me/<bot>?start=<code>)
alter table public.user_bots add column if not exists tg_code_until timestamptz;

create table if not exists public.tg_subs (
  chat_id bigint primary key,
  shared boolean not null default true,     -- the shared bot's trades
  signals boolean not null default true,    -- new signals with strength ≥ 60
  name text,
  created_at timestamptz not null default now()
);
alter table public.tg_subs enable row level security;   -- no policies: only the bot function (service role) reads and writes it

-- the site asks for a link code for its own bot (by the bot's secret); the code lives 30 minutes
create or replace function public.ub_tg_link(p_id uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare c text := 'b' || encode(gen_random_bytes(9), 'hex');
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set tg_code = c, tg_code_until = now() + interval '30 minutes' where id = p_id;
  return jsonb_build_object('code', c, 'bot', (select bot_name from tg_config where id = 1 and enabled));
end $$;

create or replace function public.ub_tg_unlink(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set tg_chat = null, tg_code = null, tg_code_until = null where id = p_id;
end $$;

-- the bot's username for "open in Telegram" links on the site (never the token)
create or replace function public.tg_bot_name()
returns text language sql security definer set search_path to 'public' as $$
  select bot_name from tg_config where id = 1 and enabled;
$$;

revoke all on function public.ub_tg_link(uuid, text), public.ub_tg_unlink(uuid, text), public.tg_bot_name() from public;
grant execute on function public.ub_tg_link(uuid, text), public.ub_tg_unlink(uuid, text), public.tg_bot_name() to anon, authenticated;

-- ub_get must not hand the link code back: it returns the bot row without secret_hash and tg_code
create or replace function public.ub_get(p_id uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_bots set last_seen = now() where id = p_id and last_seen < now() - interval '10 minutes';
  return (select jsonb_build_object(
    'bot', (select to_jsonb(b) - 'secret_hash' - 'tg_code' - 'tg_code_until' from user_bots b where b.id = p_id),
    'open', coalesce((select jsonb_agg(data) from user_positions where bot_id = p_id), '[]'::jsonb),
    'closed', coalesce((select jsonb_agg(data order by tclose desc) from (select data, tclose from user_trades where bot_id = p_id order by tclose desc limit 1000) t), '[]'::jsonb)));
end $$;

-- a linked personal bot can also send its profile's signals (strength at the profile's threshold), one message per band touch
alter table public.user_bots add column if not exists tg_sig boolean not null default true;
alter table public.user_bots add column if not exists sig_sent jsonb not null default '{}'::jsonb;
-- (ub_get then also drops 'sig_sent' from the bot row it returns)
