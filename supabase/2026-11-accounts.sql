-- Accounts, stage 1 (docs/PLAN-ACCOUNTS.md): a profile per Telegram user, and login requests confirmed in the bot.
-- Both are written only by the `auth` Edge Function and the Telegram webhook (service role); a signed-in user reads
-- their own profile. login_requests has no policies at all: nobody but the service role can see the hashes and codes.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tg_id bigint not null unique,
  tg_name text,
  tg_username text,
  is_owner boolean not null default false,
  beta boolean not null default false,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists profiles_own_read on public.profiles;
create policy profiles_own_read on public.profiles for select to authenticated using (id = auth.uid());
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- one login attempt: the site keeps `secret` (only its hash is here) and shows `code`; the bot fills tg_* when the
-- right code is picked; the function then hands the tab a one-time sign-in token and marks the request used
create table if not exists public.login_requests (
  nonce text primary key,
  secret_hash text not null,
  code text not null,
  ip text,
  created_at timestamptz not null default now(),
  tg_id bigint,
  tg_name text,
  tg_username text,
  confirmed_at timestamptz,
  denied_at timestamptz,
  used_at timestamptz,
  polls integer not null default 0
);
create index if not exists login_requests_created on public.login_requests (created_at);
create index if not exists login_requests_ip on public.login_requests (ip, created_at);
alter table public.login_requests enable row level security;
revoke all on public.login_requests from anon, authenticated;

notify pgrst, 'reload schema';
