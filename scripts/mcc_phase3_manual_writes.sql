-- MCC Phase 3A manual daily-use actions
-- PREP ONLY. Do not apply to production until the exact reviewed release is approved.
-- Browser keeps no direct write grant to MCC tables. A JWT-authenticated Edge Function
-- calls this service-role-only RPC after resolving the real user id.

begin;

create or replace function public.mcc_apply_manual_action(
  p_user_id uuid,
  p_obligation_id uuid,
  p_action text,
  p_reason text default null,
  p_waiting_on text default null,
  p_follow_up_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text := upper(btrim(coalesce(p_action,'')));
  v_row public.obligations%rowtype;
  v_old jsonb;
  v_new jsonb;
  v_event_type text;
  v_target_event public.obligation_events%rowtype;
begin
  if p_user_id is null or p_obligation_id is null then
    raise exception 'user and obligation are required';
  end if;

  select * into v_row
  from public.obligations
  where id=p_obligation_id and user_id=p_user_id
  for update;

  if not found then
    raise exception 'obligation not found';
  end if;

  v_old := jsonb_build_object(
    'state',v_row.state,
    'execution_owner',v_row.execution_owner,
    'waiting_on',v_row.waiting_on,
    'waiting_since',v_row.waiting_since,
    'follow_up_at',v_row.follow_up_at,
    'blocked_reason',v_row.blocked_reason,
    'completed_at',v_row.completed_at,
    'cancelled_at',v_row.cancelled_at,
    'next_action',v_row.next_action
  );

  if v_action='UNDO_LAST' then
    select e.* into v_target_event
    from public.obligation_events e
    where e.user_id=p_user_id
      and e.obligation_id=p_obligation_id
      and e.actor_type='NICCI'
      and e.event_type in ('MANUAL_DONE','MANUAL_BLOCKED','MANUAL_WAITING','HELP_REQUESTED')
      and e.old_value is not null
      and not exists (
        select 1 from public.obligation_events u
        where u.user_id=e.user_id
          and u.obligation_id=e.obligation_id
          and u.event_type='MANUAL_UNDO'
          and u.source_ref='event:'||e.id::text
      )
    order by e.created_at desc,e.id desc
    limit 1;

    if not found then
      raise exception 'no reversible manual action found';
    end if;

    update public.obligations
    set state=coalesce(v_target_event.old_value->>'state',state),
        execution_owner=coalesce(v_target_event.old_value->>'execution_owner',execution_owner),
        waiting_on=nullif(v_target_event.old_value->>'waiting_on',''),
        waiting_since=case when v_target_event.old_value->>'waiting_since' is null then null else (v_target_event.old_value->>'waiting_since')::timestamptz end,
        follow_up_at=case when v_target_event.old_value->>'follow_up_at' is null then null else (v_target_event.old_value->>'follow_up_at')::timestamptz end,
        blocked_reason=nullif(v_target_event.old_value->>'blocked_reason',''),
        completed_at=case when v_target_event.old_value->>'completed_at' is null then null else (v_target_event.old_value->>'completed_at')::timestamptz end,
        cancelled_at=case when v_target_event.old_value->>'cancelled_at' is null then null else (v_target_event.old_value->>'cancelled_at')::timestamptz end,
        next_action=nullif(v_target_event.old_value->>'next_action',''),
        updated_at=now()
    where id=p_obligation_id and user_id=p_user_id
    returning * into v_row;

    v_event_type := 'MANUAL_UNDO';

  elsif v_action='DONE' then
    if v_row.state='DONE' then
      return jsonb_build_object('ok',true,'idempotent',true,'obligation_id',v_row.id,'state',v_row.state);
    end if;
    if v_row.state='CANCELLED' then raise exception 'cancelled obligation cannot be marked done'; end if;

    update public.obligations
    set state='DONE',
        completed_at=now(),
        cancelled_at=null,
        waiting_on=null,
        waiting_since=null,
        follow_up_at=null,
        blocked_reason=null,
        updated_at=now()
    where id=p_obligation_id and user_id=p_user_id
    returning * into v_row;
    v_event_type := 'MANUAL_DONE';

  elsif v_action='BLOCKED' then
    if v_row.state in ('DONE','CANCELLED') then raise exception 'terminal obligation cannot be blocked'; end if;
    if p_reason is null or length(btrim(p_reason))=0 then raise exception 'blocked reason is required'; end if;

    update public.obligations
    set state='BLOCKED',
        blocked_reason=btrim(p_reason),
        waiting_on=null,
        waiting_since=null,
        follow_up_at=null,
        completed_at=null,
        cancelled_at=null,
        updated_at=now()
    where id=p_obligation_id and user_id=p_user_id
    returning * into v_row;
    v_event_type := 'MANUAL_BLOCKED';

  elsif v_action='WAITING' then
    if v_row.state in ('DONE','CANCELLED') then raise exception 'terminal obligation cannot be moved to waiting'; end if;
    if p_waiting_on is null or length(btrim(p_waiting_on))=0 then raise exception 'waiting_on is required'; end if;

    update public.obligations
    set state='WAITING',
        execution_owner='WAITING',
        waiting_on=btrim(p_waiting_on),
        waiting_since=coalesce(waiting_since,now()),
        follow_up_at=p_follow_up_at,
        blocked_reason=null,
        completed_at=null,
        cancelled_at=null,
        updated_at=now()
    where id=p_obligation_id and user_id=p_user_id
    returning * into v_row;
    v_event_type := 'MANUAL_WAITING';

  elsif v_action='NEED_HELP' then
    if v_row.state in ('DONE','CANCELLED') then raise exception 'terminal obligation cannot request help'; end if;

    update public.obligations
    set execution_owner='CHATGPT_PREP',
        updated_at=now()
    where id=p_obligation_id and user_id=p_user_id
    returning * into v_row;
    v_event_type := 'HELP_REQUESTED';

  else
    raise exception 'unsupported manual action: %',v_action;
  end if;

  v_new := jsonb_build_object(
    'state',v_row.state,
    'execution_owner',v_row.execution_owner,
    'waiting_on',v_row.waiting_on,
    'waiting_since',v_row.waiting_since,
    'follow_up_at',v_row.follow_up_at,
    'blocked_reason',v_row.blocked_reason,
    'completed_at',v_row.completed_at,
    'cancelled_at',v_row.cancelled_at,
    'next_action',v_row.next_action
  );

  insert into public.obligation_events (
    user_id,obligation_id,event_type,actor_type,actor_ref,
    old_value,new_value,reason,source_ref
  ) values (
    p_user_id,p_obligation_id,v_event_type,'NICCI','web:executive',
    v_old,v_new,
    nullif(btrim(coalesce(p_reason,'')),''),
    case when v_action='UNDO_LAST' then 'event:'||v_target_event.id::text else 'manual:web' end
  );

  return jsonb_build_object(
    'ok',true,
    'obligation_id',v_row.id,
    'state',v_row.state,
    'execution_owner',v_row.execution_owner,
    'event_type',v_event_type
  );
end;
$$;

revoke all on function public.mcc_apply_manual_action(uuid,uuid,text,text,text,timestamptz)
from public,anon,authenticated;

grant execute on function public.mcc_apply_manual_action(uuid,uuid,text,text,text,timestamptz)
to service_role;

comment on function public.mcc_apply_manual_action(uuid,uuid,text,text,text,timestamptz) is
  'Atomic MCC manual state transition + audit event. Service-role only; calling Edge Function must resolve and pass authenticated user id.';

commit;
