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
  v_uid uuid := auth.uid();
  v_reason text;
  v_latest_old jsonb;
  v_is_done boolean := false;
  v_is_blocked boolean := false;
  v_is_need_help boolean := false;
  v_is_undo boolean := false;
begin
  if v_uid is not null then
    if old.user_id <> v_uid or new.user_id <> v_uid then
      raise exception 'MCC obligation ownership check failed';
    end if;

    v_is_done :=
      new.state = 'DONE'
      and old.state is distinct from new.state
      and new.completed_at is not null
      and new.blocked_reason is null
      and new.execution_owner is not distinct from old.execution_owner;

    v_is_blocked :=
      new.state = 'BLOCKED'
      and old.state is distinct from new.state
      and new.completed_at is null
      and new.blocked_reason is not null
      and length(btrim(new.blocked_reason)) > 0
      and new.execution_owner is not distinct from old.execution_owner;

    v_is_need_help :=
      new.state is not distinct from old.state
      and new.completed_at is not distinct from old.completed_at
      and new.blocked_reason is not distinct from old.blocked_reason
      and new.execution_owner = 'CHATGPT_PREP'
      and old.execution_owner is distinct from new.execution_owner;

    select e.old_value
      into v_latest_old
    from public.obligation_events e
    where e.user_id = v_uid
      and e.obligation_id = old.id
      and e.event_type = 'MANUAL_UPDATE'
      and e.actor_ref = 'mcc-executive-ui'
    order by e.created_at desc, e.id desc
    limit 1;

    if v_latest_old is not null then
      v_is_undo :=
        new.state is not distinct from (v_latest_old->>'state')
        and new.execution_owner is not distinct from (v_latest_old->>'execution_owner')
        and new.blocked_reason is not distinct from nullif(v_latest_old->>'blocked_reason','')
        and new.completed_at is not distinct from
          case
            when v_latest_old->>'completed_at' is null then null
            else (v_latest_old->>'completed_at')::timestamptz
          end;
    end if;

    if not (v_is_done or v_is_blocked or v_is_need_help or v_is_undo) then
      raise exception 'Unsupported MCC manual action';
    end if;
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

  if new.state <> 'BLOCKED' then
    new.blocked_reason := null;
  end if;

  new.updated_at := now();

  v_reason := case
    when v_uid is not null and v_is_undo
      then 'Undid latest MCC executive UI state change'
    when new.state = 'DONE' and old.state is distinct from new.state
      then 'Marked done in MCC executive UI'
    when new.state = 'BLOCKED' and old.state is distinct from new.state
      then 'Blocked in MCC executive UI: ' || coalesce(new.blocked_reason,'')
    when new.execution_owner = 'CHATGPT_PREP'
         and old.execution_owner is distinct from new.execution_owner
      then 'Requested ChatGPT help in MCC executive UI'
    else 'Controlled MCC obligation update'
  end;

  insert into public.obligation_events (
    user_id,obligation_id,event_type,actor_type,actor_ref,
    old_value,new_value,reason,source_ref
  ) values (
    new.user_id,new.id,'MANUAL_UPDATE',
    case when v_uid is not null then 'NICCI' else 'SYSTEM' end,
    case when v_uid is not null then 'mcc-executive-ui' else current_user end,
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
before update of state,execution_owner,blocked_reason,completed_at
on public.obligations
for each row
execute function private.mcc_audit_obligation_manual_update();

revoke update on public.obligations from public, anon, authenticated;
grant update (state,execution_owner,blocked_reason,completed_at)
on public.obligations to authenticated;

drop policy if exists obligations_update_own on public.obligations;
create policy obligations_update_own
on public.obligations
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Audit events and provenance remain browser read-only.
revoke insert, update, delete on public.obligation_events
from public, anon, authenticated;
revoke insert, update, delete on public.obligation_sources
from public, anon, authenticated;

commit;
