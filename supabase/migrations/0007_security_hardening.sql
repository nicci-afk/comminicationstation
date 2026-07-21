-- Advisor-driven tightening (applied live as migration `security_hardening`).
-- Trigger functions are never meant to be called via /rest/v1/rpc (revoking
-- EXECUTE does not affect trigger firing), and the user-facing RPCs require
-- auth.uid() so anon has no legitimate use.
alter function public.touch_updated_at() set search_path = public;
revoke execute on function public.log_queue_transition() from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.backlog_sweep_sender(text, boolean) from anon;
revoke execute on function public.get_jobs_health() from anon;
revoke execute on function public.set_user_secret(text, text) from anon;
