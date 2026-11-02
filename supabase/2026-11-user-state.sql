-- Accounts, stage 2 (docs/PLAN-ACCOUNTS.md): what follows a person between devices — one row per browser-storage key
-- (sr_settings, sr_favs, sr_bot, the Beta's layout…). A signed-in user reads their own rows; writes go through state_put,
-- which only replaces the version the device last saw: a stale device learns that another one wrote first.

create table if not exists public.user_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_state enable row level security;
drop policy if exists user_state_own_read on public.user_state;
create policy user_state_own_read on public.user_state for select to authenticated using (user_id = auth.uid());
revoke all on public.user_state from anon, authenticated;
grant select on public.user_state to authenticated;

-- p_version: the version this device has (0 — none yet). Returns the new version, or null when another device wrote first
create or replace function public.state_put(p_key text, p_value jsonb, p_version integer)
returns integer language plpgsql security definer set search_path = public as $$
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
revoke all on function public.state_put(text, jsonb, integer) from public, anon;
grant execute on function public.state_put(text, jsonb, integer) to authenticated;

notify pgrst, 'reload schema';
