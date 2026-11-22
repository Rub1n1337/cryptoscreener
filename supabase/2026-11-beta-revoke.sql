-- 23.11.2026 (after 2.132, DeepSeek audit 21.11, finding 1.2): the beta key functions were callable by anyone (anon), guarded
-- only by the owner's password with a lockout per address. Nothing on the site calls them; they stay for future closed tests,
-- for a signed-in person only.
revoke all on function public.beta_issue(text, integer, text) from public, anon;
revoke all on function public.beta_list(text) from public, anon;
revoke all on function public.beta_revoke(text, uuid) from public, anon;
grant execute on function public.beta_issue(text, integer, text) to authenticated;
grant execute on function public.beta_list(text) to authenticated;
grant execute on function public.beta_revoke(text, uuid) to authenticated;
