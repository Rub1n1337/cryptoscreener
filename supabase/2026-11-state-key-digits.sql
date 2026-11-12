-- 2.114: synced profile keys may hold digits (outside review 12.11, third batch, item 2; owner's «да» 12.11).
-- Until now state_put took ^sr_[a-z]{1,20}$ only, so a future profile key with a digit (as the device keys sr_tf2, sr_tf2tf)
-- would have failed with 'bad key'. Same signature, so CREATE OR REPLACE keeps the grants (authenticated, service_role).
CREATE OR REPLACE FUNCTION public.state_put(p_key text, p_value jsonb, p_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_key !~ '^sr_[a-z0-9]{1,20}$' then raise exception 'bad key'; end if;
  if pg_column_size(p_value) > 262144 then raise exception 'too big'; end if;
  if (select count(*) from user_state where user_id = auth.uid()) >= 40 and not exists (select 1 from user_state where user_id = auth.uid() and key = p_key)
    then raise exception 'too many keys'; end if;
  insert into user_state (user_id, key, value, version) values (auth.uid(), p_key, p_value, 1)
  on conflict (user_id, key) do update set value = excluded.value, version = user_state.version + 1, updated_at = now()
    where user_state.version = p_version
  returning version into v;
  return v;
end $function$;
