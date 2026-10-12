-- Applied 12.10.2026 (migration revoke_public_write_grants).
-- The site only reads the public tables; every write goes through SECURITY DEFINER functions (ub_*, beta_*) or the
-- server functions with the service role. RLS already blocked writes, but TRUNCATE is not covered by RLS:
-- the unused write rights are taken away from the public roles entirely, also for tables created later.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- Applied 12.10.2026 (migration watchdog_and_cleanup):
-- public.bot_watchdog() every 5 min (cron 'bot-watchdog'): Telegram message to tg_config.alert_chat when bot_state.checked_at
--   is older than 10 minutes (repeated at most hourly), and one more when the bot is back.
-- public.cleanup_abandoned_bots() daily at 03:17 UTC (cron 'cleanup-abandoned-bots'): deletes personal bots unseen for
--   90 days and not linked to Telegram; positions and trades go with them (on delete cascade).
-- Both are SECURITY DEFINER with execute revoked from public/anon/authenticated.
