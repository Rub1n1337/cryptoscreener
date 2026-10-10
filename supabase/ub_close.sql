-- "Мой бот" on the server: the owner asks to close one position (p_pos) or all of them (p_pos null).
-- Positions are only marked; the bot closes them at market on its next run (every minute), with the usual fee and slippage
-- (see checkExit in functions/_shared/math.js, reason 'вручную').
create or replace function public.ub_close(p_id uuid, p_secret text, p_pos text default null)
returns integer language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare n integer;
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  update user_positions set data = data || '{"closeReq": true}'::jsonb
   where bot_id = p_id and (p_pos is null or id = p_pos);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.ub_close(uuid, text, text) from public;
grant execute on function public.ub_close(uuid, text, text) to anon, authenticated;
