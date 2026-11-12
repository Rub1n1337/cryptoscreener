-- 12.11 (after 2.114): the shared bot writes only while the run lock is its own (outside review 12.11, fourth batch, item 3; owner's «да» 12.11).
-- bot_lock(p_run, 120) kept two runs apart only while a run lasted under 120 s. A run that outlived it (Binance slow) could
-- commit after the next run had started and put back positions that run had closed, with the old balance. Now bot_commit
-- takes the run id and writes only when bot_state.lock_run is still it; the row is locked for the commit, so a bot_lock of
-- the next run waits until it ends. Returns true when written, false when the lock was lost (nothing written).
-- p_run defaults to null (no check), so the function code deployed before this file keeps working until it is redeployed.
-- The signature changes: the old one is dropped here, and the grant is given again (service_role only, as before).
drop function if exists public.bot_commit(jsonb, jsonb, double precision, timestamp with time zone, integer, jsonb);
create function public.bot_commit(p_closed jsonb, p_open jsonb, p_balance double precision, p_checked timestamp with time zone,
  p_scanned integer, p_regime jsonb default null, p_run text default null)
 returns boolean language plpgsql security definer set search_path to 'public'
as $function$
begin
  if p_run is not null then
    perform 1 from bot_state where id = 1 and lock_run = p_run for update;
    if not found then return false; end if;
  end if;
  insert into trades select * from jsonb_populate_recordset(null::trades, coalesce(p_closed, '[]')) on conflict (id) do nothing;
  delete from positions where id in (select t->>'id' from jsonb_array_elements(coalesce(p_closed, '[]')) t);
  insert into positions select * from jsonb_populate_recordset(null::positions, coalesce(p_open, '[]'))
    on conflict (id) do update set sym = excluded.sym, side = excluded.side, entry = excluded.entry, last = excluded.last, tp = excluded.tp,
      sl = excluded.sl, qty = excluded.qty, time = excluded.time, tfms = excluded.tfms, note = excluded.note, risk = excluded.risk, snap = excluded.snap, ts = excluded.ts,
      bh = excluded.bh, bl = excluded.bl;
  update bot_state set balance = p_balance, checked_at = p_checked, scanned = p_scanned, last_error = null, regime = coalesce(p_regime, regime) where id = 1;
  return true;
end $function$;
revoke all on function public.bot_commit(jsonb, jsonb, double precision, timestamp with time zone, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.bot_commit(jsonb, jsonb, double precision, timestamp with time zone, integer, jsonb, text) to service_role;
