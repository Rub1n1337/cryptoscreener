-- Runs the shared bot every minute. The token is read from public.bot_secret at run time
-- (that table has RLS with no policies, so only the database itself and the service role can read it).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'shared-bot-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://aumldylzccbmddavtrqe.supabase.co/functions/v1/bot',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-bot-token', (select token from public.bot_secret where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
