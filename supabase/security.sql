-- Applied 12.10.2026 (migration revoke_public_write_grants).
-- The site only reads the public tables; every write goes through SECURITY DEFINER functions (ub_*, beta_*) or the
-- server functions with the service role. RLS already blocked writes, but TRUNCATE is not covered by RLS:
-- the unused write rights are taken away from the public roles entirely, also for tables created later.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
