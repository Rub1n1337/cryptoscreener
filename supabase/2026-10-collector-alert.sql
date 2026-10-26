-- Applied 26.10.2026 (migration collector_watchdog), 2.47. Replaces bot_watchdog from schema.sql (cron: every 5 minutes).
-- When the collector on Railway stops answering, the bot computes every analysis itself: slower, and with many personal bots it
-- may not fit in a minute. Until now only «Работа сервера» on the site showed it (bot_runs.error «коллектор: …»); now the owner
-- gets a message in tg_config.alert_chat, like the one about the shared bot.
alter table public.tg_config add column if not exists coll_down boolean not null default false,
  add column if not exists coll_at timestamptz;

create or replace function public.bot_watchdog() returns void language plpgsql security definer set search_path = public, extensions as $function$
declare c record; st record; idle interval; v_url text; v_hdr jsonb := '{"Content-Type": "application/json"}'::jsonb;
  total int; bad int; n5 int; bad5 int; last_err text; since timestamptz; m int;
begin
  select * into c from tg_config where id = 1;
  if c is null or not c.enabled or c.bot_token is null or c.alert_chat is null then return; end if;
  v_url := 'https://api.telegram.org/bot' || c.bot_token || '/sendMessage';

  -- the shared bot hasn't checked the market for 10 minutes (and when it is back). It used to return early while repeating
  -- the alert was not due, which would also skip the collector below
  select checked_at, last_error into st from bot_state where id = 1;
  idle := now() - coalesce(st.checked_at, now());
  if idle > interval '10 minutes' then
    if not (c.alert_down and c.alert_at > now() - interval '1 hour') then   -- repeat at most hourly while it is down
      perform net.http_post(url := v_url, body := jsonb_build_object('chat_id', c.alert_chat, 'text',
        '⚠️ Общий бот не отвечает уже ' || floor(extract(epoch from idle) / 60) || ' мин.' || coalesce(E'\nПоследняя ошибка: ' || left(st.last_error, 300), '')),
        headers := v_hdr, timeout_milliseconds := 10000);
      update tg_config set alert_down = true, alert_at = now() where id = 1;
    end if;
  elsif c.alert_down then
    perform net.http_post(url := v_url, body := jsonb_build_object('chat_id', c.alert_chat, 'text', '✅ Общий бот снова работает.'),
      headers := v_hdr, timeout_milliseconds := 10000);
    update tg_config set alert_down = false, alert_at = now() where id = 1;
  end if;

  -- the collector: an ok run that had to compute without it says so in its error. Silent when at least 80% of the last 15
  -- minutes' runs (10 or more) did: a single time-out is not news. Repeated at most every 3 hours while it lasts
  select count(*), count(*) filter (where error like 'коллектор:%') into total, bad from bot_runs where ok and ts > now() - interval '15 minutes';
  if total >= 10 and bad >= 0.8 * total then
    if not (c.coll_down and c.coll_at > now() - interval '3 hours') then
      select error into last_err from bot_runs where ok and error like 'коллектор:%' order by ts desc limit 1;
      select max(ts) into since from bot_runs where ok and (error is null or error not like 'коллектор:%');
      m := floor(extract(epoch from now() - since) / 60);
      perform net.http_post(url := v_url, body := jsonb_build_object('chat_id', c.alert_chat, 'text',
        '⚠️ Коллектор на Railway не отвечает ' || case when since is null then 'давно' when m >= 120 then floor(m / 60) || ' ч' else m || ' мин' end ||
        E'.\nБот считает всё сам: медленнее, и при многих ботах может не успевать за минуту.' ||
        coalesce(E'\nПоследняя ошибка: ' || left(substr(last_err, 12), 200), '') ||
        E'\nПроверьте на Railway, что сервис запущен и SCAN_TOKEN совпадает с bot_secret.scan.'),
        headers := v_hdr, timeout_milliseconds := 10000);
      update tg_config set coll_down = true, coll_at = now() where id = 1;
    end if;
  elsif c.coll_down then
    -- back: the last 5 ok runs all had its answers
    select count(*), count(*) filter (where error like 'коллектор:%') into n5, bad5 from (select error from bot_runs where ok order by ts desc limit 5) x;
    if n5 = 5 and bad5 = 0 then
      perform net.http_post(url := v_url, body := jsonb_build_object('chat_id', c.alert_chat, 'text', '✅ Коллектор снова отвечает.'),
        headers := v_hdr, timeout_milliseconds := 10000);
      update tg_config set coll_down = false, coll_at = now() where id = 1;
    end if;
  end if;
end $function$;
revoke all on function public.bot_watchdog() from public, anon, authenticated;
