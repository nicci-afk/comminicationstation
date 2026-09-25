-- MCC Phase 3 manual writes — DRAFT ONLY.
-- This is intentionally under scripts/ until final migration generation/review.
-- DO NOT RUN IN PRODUCTION WITHOUT EXPLICIT RED APPROVAL.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.mcc_audit_obligation_manual_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_type text;
  v_reason text;
begin
  -- Browser writes run as authenticated and must be tenant-owned.
  if current_user = 'authenticated' then
    if (select auth.uid()) is null
       or old.user_id <> (select auth.uid())
       or new.user_id <> (select auth.uid()) then
      raise exception 'MCC obligation ownership check failed';
    end if;

    if new.state = 'DONE' and new.completed_at is null then
      raise exception 'DONE requires completed_at';
    end if;

    if new.state <> 'DONE' and new.completed_at is not null then
      raise exception 'completed_at is only valid for DONE';
    end if;

    if new.state = 'BLOCKED'
       and (new.blocked_reason is null or length(btrim(new.blocked_reason)) = 0) then
      raise exception 'BLOCKED requires blocked_reason';
    end if;

    v_actor_type := 'NICCI';
  else
    v_actor_type := 'SYSTEM';
  end if;

  new.updated_at := now();

  v_reason := case
    when new.state = 'DONE' and old.state is distinct from new.state
      then 'Marked done in MCC executive UI'
    when new.state = 'BLOCKED' and old.state is distinct from new.state
      then 'Blocked in MCC executive UI: ' || coalesce(new.blocked_reason,'')
    when new.execution_owner = 'CHATGPT_PREP'
         and old.execution_owner is distinct from new.execution_owner
      then 'Requested ChatGPT help in MCC executive UI'
    else 'Manual MCC obligation update'
  end;

  insert into public.obligation_events (
    user_id,obligation_id,event_type,actor_type,actor_ref,
    old_value,new_value,reason,source_ref
  ) values (
    new.user_id,new.id,'MANUAL_UPDATE',v_actor_type,
    case when current_user='authenticated' then 'mcc-executive-ui' else current_user end,
    jsonb_build_object(
      'state',old.state,
      'execution_owner',old.execution_owner,
      'blocked_reason',old.blocked_reason,
      'completed_at',old.completed_at
    ),
    jsonb_build_object(
      'state',new.state,
      'execution_owner',new.execution_owner,
      'blocked_reason',new.blocked_reason,
      'completed_at',new.completed_at
    ),
    v_reason,
    'mcc-ui'
  );

  return new;
end;
$$;

revoke all on function private.mcc_audit_obligation_manual_update()
from public, anon, authenticated;

drop trigger if exists trg_mcc_obligation_manual_update on public.obligations;
create trigger trg_mcc_obligation_manual_update
before update of state,execution_owner,blocked_reason,completed_at,updated_at
on public.obligations
for each row
execute function private.mcc_audit_obligation_manual_update();

revoke update on public.obligations from public, anon, authenticated;
grant update (state,execution_owner,blocked_reason,completed_at,updated_at)
on public.obligations to authenticated;

drop policy if exists obligations_update_own on public.obligations;
create policy obligations_update_own
on public.obligations
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Audit events remain browser read-only.
revoke insert, update, delete on public.obligation_events
from public, anon, authenticated;

commit;
