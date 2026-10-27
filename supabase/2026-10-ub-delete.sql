-- Applied 27.10.2026 (migration ub_delete), 2.52.
-- «Удалить с сервера»: whoever holds a bot's id and secret (its owner's browser) deletes the bot with its positions and trades
-- (on delete cascade) and its Telegram link, which lives in the same row. A subscription to the shared bot (tg_subs) belongs to
-- the chat, not to the bot: it ends with /stop in Telegram. A bot step that read the bot before the delete writes nothing:
-- ub_commit finds no row and returns false.
create or replace function public.ub_delete(p_id uuid, p_secret text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  delete from user_bots where id = p_id;
end $$;
revoke all on function public.ub_delete(uuid, text) from public;
grant execute on function public.ub_delete(uuid, text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
