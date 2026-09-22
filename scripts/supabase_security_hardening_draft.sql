-- Supabase security hardening DRAFT
-- PREP ONLY: DO NOT RUN IN PRODUCTION WITHOUT A NEW EXPLICIT RED-ACTION APPROVAL.
--
-- Goal: remove unnecessary PUBLIC/anon execution of privileged SECURITY DEFINER
-- functions while preserving the authenticated RPCs currently used by the web app.
--
-- This script changes privileges only. It does not change function bodies, table data,
-- RLS policies, extensions, auth settings, bookings, payments, or external communication.

begin;

-- Trigger-only functions: no direct browser/RPC invocation is required.
revoke execute on function public.auto_expense_split() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.log_queue_transition() from public, anon, authenticated;

-- Signed-in user RPCs: remove inherited/public and anonymous execution first.
revoke execute on function public.backlog_sweep_sender(text, boolean) from public, anon, authenticated;
revoke execute on function public.get_jobs_health() from public, anon, authenticated;
revoke execute on function public.recategorize_queue_item(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.set_user_secret(text, text) from public, anon, authenticated;
revoke execute on function public.split_queue_item_for_businesses(uuid, uuid[], text, text, uuid[]) from public, anon, authenticated;

-- Restore only the signed-in app access that is intentionally required.
grant execute on function public.backlog_sweep_sender(text, boolean) to authenticated;
grant execute on function public.get_jobs_health() to authenticated;
grant execute on function public.recategorize_queue_item(uuid, text, uuid) to authenticated;
grant execute on function public.set_user_secret(text, text) to authenticated;
grant execute on function public.split_queue_item_for_businesses(uuid, uuid[], text, text, uuid[]) to authenticated;

-- Preserve backend/service execution explicitly.
grant execute on function public.auto_expense_split() to service_role;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.log_queue_transition() to service_role;
grant execute on function public.backlog_sweep_sender(text, boolean) to service_role;
grant execute on function public.get_jobs_health() to service_role;
grant execute on function public.recategorize_queue_item(uuid, text, uuid) to service_role;
grant execute on function public.set_user_secret(text, text) to service_role;
grant execute on function public.split_queue_item_for_businesses(uuid, uuid[], text, text, uuid[]) to service_role;

-- Fail closed if the expected trigger wiring is missing.
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    join pg_namespace n on n.oid=p.pronamespace
    where not t.tgisinternal and n.nspname='public'
      and p.proname='auto_expense_split' and t.tgname='trg_auto_expense_split'
  ) then raise exception 'Expected trigger trg_auto_expense_split is missing'; end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    join pg_namespace n on n.oid=p.pronamespace
    where not t.tgisinternal and n.nspname='public'
      and p.proname='handle_new_user' and t.tgname='on_auth_user_created'
  ) then raise exception 'Expected trigger on_auth_user_created is missing'; end if;

  if not exists (
    select 1 from pg_trigger t
    join pg_proc p on p.oid=t.tgfoid
    join pg_namespace n on n.oid=p.pronamespace
    where not t.tgisinternal and n.nspname='public'
      and p.proname='log_queue_transition' and t.tgname='queue_items_transition'
  ) then raise exception 'Expected trigger queue_items_transition is missing'; end if;
end $$;

commit;
