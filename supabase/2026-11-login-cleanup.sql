-- Sign-in attempts keep an IP address; the legal page promises it is gone within two days. The auth function deletes rows
-- older than a day only when someone starts a sign-in, so on quiet days nothing would: a nightly job does it as well.
select cron.unschedule('login-requests-cleanup') where exists (select 1 from cron.job where jobname = 'login-requests-cleanup');
select cron.schedule('login-requests-cleanup', '23 3 * * *', $$delete from public.login_requests where created_at < now() - interval '1 day'$$);
