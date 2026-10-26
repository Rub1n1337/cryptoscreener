-- Applied 26.10.2026 (migration reset_start_gen), 2.46. Apply after hardening.sql.
-- «Мой бот» on the server can start again from any amount, and a reset can no longer be undone by a bot step that read the
-- journal before it. Backward compatible: the old site calls ub_reset with two arguments, the old bot calls ub_commit without
-- p_gen, and both keep working.

-- how many times the journal was reset: a bot step remembers it when it reads the bot, and its write is refused if it changed
alter table public.user_bots add column if not exists reset_n int not null default 0;

-- p_start: the new starting balance (100 … 10 000 000), or null to keep the current one. The bot's row is locked first, as
-- ub_commit does: a step's write then runs wholly before the reset (and is deleted by it) or after it (and sees the new number).
-- The two-argument version is dropped: next to this one a call with two arguments would be ambiguous
drop function if exists public.ub_reset(uuid, text);
create function public.ub_reset(p_id uuid, p_secret text, p_start float8 default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if p_start is not null and not (p_start between 100 and 10000000) then raise exception 'start balance must be 100 … 10000000'; end if;
  perform 1 from user_bots where id = p_id for update;
  delete from user_positions where bot_id = p_id;
  delete from user_trades where bot_id = p_id;
  update user_bots set start_balance = coalesce(p_start, start_balance), balance = coalesce(p_start, start_balance),
    reset_n = reset_n + 1, last_error = null where id = p_id;
end $$;
revoke all on function public.ub_reset(uuid, text, float8) from public;
grant execute on function public.ub_reset(uuid, text, float8) to anon, authenticated, service_role;

-- one write per bot step (see hardening.sql), now refused when the journal was reset after the step read it (p_gen: the
-- reset_n the step saw; null — an old caller, no check). Returns whether it wrote: the bot then doesn't announce trades of a
-- refused step. Before 2.46 such a step put the positions and the balance from before the reset back
drop function if exists public.ub_commit(uuid, jsonb, jsonb, float8, text, jsonb, timestamptz);
create function public.ub_commit(p_bot uuid, p_closed jsonb, p_keep jsonb, p_balance float8, p_profile text, p_regime jsonb,
  p_checked timestamptz, p_gen int default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare g int;
begin
  select reset_n into g from user_bots where id = p_bot for update;
  if not found then return false; end if;                         -- the bot was deleted meanwhile
  if p_gen is not null and p_gen <> g then return false; end if;  -- reset after the step read the journal
  insert into user_trades (bot_id, id, tclose, data)
    select p_bot, t->>'id', (t->>'tclose')::bigint, t from jsonb_array_elements(coalesce(p_closed, '[]')) t
    on conflict (bot_id, id) do nothing;
  delete from user_positions where bot_id = p_bot and id in (select t->>'id' from jsonb_array_elements(coalesce(p_closed, '[]')) t);
  insert into user_positions (bot_id, id, data)
    select p_bot, p->>'id', p from jsonb_array_elements(coalesce(p_keep, '[]')) p
    on conflict (bot_id, id) do update set data = excluded.data
      || case when user_positions.data ? 'closeReq' then jsonb_build_object('closeReq', true) else '{}'::jsonb end;
  update user_bots set balance = p_balance, checked_at = p_checked, active_profile = p_profile, regime = p_regime, last_error = null where id = p_bot;
  return true;
end $$;
revoke all on function public.ub_commit(uuid, jsonb, jsonb, float8, text, jsonb, timestamptz, int) from public, anon, authenticated;

notify pgrst, 'reload schema';
