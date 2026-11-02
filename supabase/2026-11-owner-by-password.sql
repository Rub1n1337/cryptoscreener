-- Accounts, stage 4: the owner's password, accepted anywhere while signed in (the Beta's lock, «Временный доступ»), marks
-- the profile as the owner's. In 2.65 only beta_owner did, and a device whose Beta was already open never asked for it.
create or replace function public._beta_admin_ok(p_admin text) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare a public.beta_admin; f public.beta_fails; v_ip text := public._client_ip(); p text := lower(trim(coalesce(p_admin, ''))); ok boolean;
begin
  if auth.uid() is not null and exists (select 1 from public.profiles where id = auth.uid() and is_owner) then return true; end if;
  select * into f from public.beta_fails where beta_fails.ip = v_ip;
  if f.locked_until is not null and f.locked_until > now() then return false; end if;
  select * into a from public.beta_admin where id = 1;
  ok := p <> '' and case when a.pass_hash like '$2%' then crypt(p, a.pass_hash) = a.pass_hash
                         else encode(digest(p, 'sha256'), 'hex') = a.pass_hash end;
  if ok then
    if a.pass_hash not like '$2%' then update public.beta_admin set pass_hash = crypt(p, gen_salt('bf', 10)) where id = 1; end if;
    delete from public.beta_fails where beta_fails.ip = v_ip;
    if auth.uid() is not null then update public.profiles set is_owner = true where id = auth.uid(); end if;
    return true;
  end if;
  insert into public.beta_fails as b (ip, fails) values (v_ip, 1)
    on conflict (ip) do update set fails = case when b.locked_until < now() then 1 else b.fails + 1 end, locked_until = null;
  update public.beta_fails set locked_until = now() + interval '15 minutes' where beta_fails.ip = v_ip and fails >= 5;
  return false;
end $$;
