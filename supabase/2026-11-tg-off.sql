-- «Выключить Telegram» in one place (docs/PLAN-UNTANGLE-accounts.md, fix 5). Before: four copies of «tg_chat = null» — ub_tg,
-- and /stop, /unlink and the «u!» button in functions/_shared/tg.ts — while a bot blocked by the person (403 from Telegram)
-- removed only the chat's subscription: the profile's bot went on sending to that chat and the site showed «Включено».
--   p_unsubscribe false — the site bot's messages to this chat stop (/unlink, «🔕 Выключить» in the menu, ub_tg(false));
--   p_unsubscribe true  — the chat is gone: its subscription to the shared bot as well (/stop, a 403 from Telegram).
-- Backward compatible: a new function, and ub_tg keeps its signature and grants. Apply before the functions push.

create or replace function public.tg_chat_off(p_chat bigint, p_unsubscribe boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  update user_bots set tg_chat = null where tg_chat = p_chat;
  if p_unsubscribe then delete from tg_subs where chat_id = p_chat; end if;
end $$;
revoke all on function public.tg_chat_off(bigint, boolean) from public, anon, authenticated;
grant execute on function public.tg_chat_off(bigint, boolean) to service_role;

-- the site's «Выключить» goes the same way: the profile's Telegram is its chat (user_bots_tg_needs_profile and ub_tg(true) keep
-- tg_chat equal to profiles.tg_id, so this is the profile's bot and no other)
create or replace function public.ub_tg(p_on boolean) returns json
language plpgsql security definer set search_path = public as $$
declare p public.profiles; b uuid;
begin
  select * into p from profiles where id = auth.uid();
  if not found then raise exception 'not signed in'; end if;
  select id into b from user_bots where user_id = p.id;
  if b is null then raise exception 'no bot'; end if;
  if p_on then
    update user_bots set tg_chat = p.tg_id where id = b;
    insert into tg_subs (chat_id, name, shared) values (p.tg_id, p.tg_name, false) on conflict (chat_id) do nothing;
  else
    perform tg_chat_off(p.tg_id, false);
  end if;
  return json_build_object('tg', p_on);
end $$;

notify pgrst, 'reload schema';
