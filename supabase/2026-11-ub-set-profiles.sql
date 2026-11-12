-- 2.110: a profile bot cannot be saved without profiles (outside review 12.11, item 2.4; owner's «да» 12.11).
-- A bot with an empty list makes no entries (bot/index.ts plan() → null, «нет профилей»); its positions still exit.
-- Before this, ub_set accepted any config. At the time of the change no bot had an empty list.
-- The signature is the same, so CREATE OR REPLACE keeps the grants.
CREATE OR REPLACE FUNCTION public.ub_set(p_id uuid, p_secret text, p_config jsonb, p_enabled boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not ub_auth(p_id, p_secret) then raise exception 'forbidden'; end if;
  if octet_length(p_config::text) > 50000 then raise exception 'config too large'; end if;
  if jsonb_typeof(p_config->'profiles') is distinct from 'array' or jsonb_array_length(p_config->'profiles') = 0 then raise exception 'no profiles'; end if;
  update user_bots set config = p_config, enabled = coalesce(p_enabled, enabled) where id = p_id;
end $function$;
