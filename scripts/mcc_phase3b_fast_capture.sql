-- REVIEWED RELEASE CANDIDATE ONLY. Never run against production without approval.
-- Existing canonical tables, no new grants for browser writes, no AI or sends.
begin;
create or replace function public.mcc_fast_capture(p_user_id uuid, p_request_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_note text;
  v_ref text := 'capture:' || p_request_id::text;
begin
  if p_user_id is null or p_request_id is null then raise exception 'user and request id required'; end if;
  if p_note is null or length(btrim(p_note))=0 or length(p_note)>10000 then raise exception 'note must contain 1 to 10000 characters'; end if;
  if not exists (select 1 from public.profiles where user_id=p_user_id) then raise exception 'user not found'; end if;
  -- Serialize retries, including concurrent duplicate requests for this user.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_ref,0));
  select s.obligation_id,o.description into v_id,v_note
  from public.obligation_sources s join public.obligations o on o.id=s.obligation_id and o.user_id=s.user_id
  where s.user_id=p_user_id and s.source_system='MCC_MANUAL_CAPTURE' and s.source_ref=v_ref;
  if found then
    if v_note is distinct from p_note then raise exception 'request id already used with different note'; end if;
    return jsonb_build_object('ok',true,'obligation_id',v_id,'idempotent',true);
  end if;
  -- Type ACTION is provisional. Review is required before it becomes actionable.
  insert into public.obligations(user_id,type,title,description,state,verification_state,blocked_reason,next_action)
  values(p_user_id,'ACTION',left(btrim(p_note),160),p_note,'BLOCKED','UNVERIFIED',
    'CAPTURED — NEEDS CLARIFICATION','Review original capture and confirm its next action') returning id into v_id;
  insert into public.obligation_sources(user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,claim_scope,evidence_role)
  values(p_user_id,v_id,'MCC_MANUAL_CAPTURE','RAW_NOTE',v_ref,now(),array['capture_text'],'PRIMARY');
  insert into public.obligation_events(user_id,obligation_id,event_type,actor_type,actor_ref,old_value,new_value,reason,source_ref)
  values(p_user_id,v_id,'CAPTURE_CREATED','NICCI','web:capture',null,
    jsonb_build_object('state','BLOCKED','verification_state','UNVERIFIED','raw_note',p_note),
    'Captured verbatim; no date, project, payment or booking claim inferred',v_ref);
  return jsonb_build_object('ok',true,'obligation_id',v_id,'idempotent',false);
end; $$;
revoke all on function public.mcc_fast_capture(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mcc_fast_capture(uuid,uuid,text) to service_role;

create or replace function public.mcc_review_capture(p_user_id uuid,p_obligation_id uuid,p_next_action text,p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.obligations%rowtype; v_old jsonb;
begin
  if p_next_action is null or length(btrim(p_next_action))=0 or length(p_next_action)>2000 then raise exception 'next action required, maximum 2000 characters'; end if;
  select * into v_row from public.obligations where id=p_obligation_id and user_id=p_user_id for update;
  if not found then raise exception 'capture not found'; end if;
  if v_row.blocked_reason is distinct from 'CAPTURED — NEEDS CLARIFICATION' or v_row.state<>'BLOCKED'
    or not exists(select 1 from public.obligation_sources where user_id=p_user_id and obligation_id=p_obligation_id and source_system='MCC_MANUAL_CAPTURE')
    then raise exception 'capture is no longer awaiting review'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and user_id=p_user_id and state='ACTIVE') then raise exception 'active owned project required'; end if;
  v_old := to_jsonb(v_row);
  update public.obligations set title=btrim(p_next_action),next_action=btrim(p_next_action),
    project_id=p_project_id,state='TODAY',blocked_reason=null,verification_state='PARTIALLY_VERIFIED',updated_at=now()
  where id=p_obligation_id and user_id=p_user_id returning * into v_row;
  insert into public.obligation_events(user_id,obligation_id,event_type,actor_type,actor_ref,old_value,new_value,reason,source_ref)
  values(p_user_id,p_obligation_id,'CAPTURE_REVIEWED','NICCI','web:capture',v_old,to_jsonb(v_row),
    'Human confirmed executive action only; source-system facts still require verification','manual:capture-review');
  return jsonb_build_object('ok',true,'obligation_id',p_obligation_id);
end; $$;
revoke all on function public.mcc_review_capture(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.mcc_review_capture(uuid,uuid,text,uuid) to service_role;
-- Extend existing undo for reviewed captures and preserve newer changes.
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
    'title',v_row.title,
    'project_id',v_row.project_id,
    'verification_state',v_row.verification_state,
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
      and e.event_type in ('MANUAL_DONE','MANUAL_BLOCKED','MANUAL_WAITING','HELP_REQUESTED','CAPTURE_REVIEWED')
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

    -- Never let undo erase a newer source/system/manual change.
    if exists (select 1 from public.obligation_events e
      where e.user_id=p_user_id and e.obligation_id=p_obligation_id
        and e.id>v_target_event.id and e.event_type<>'MANUAL_UNDO'
        and not exists(select 1 from public.obligation_events u where u.user_id=e.user_id
          and u.obligation_id=e.obligation_id and u.event_type='MANUAL_UNDO' and u.source_ref='event:'||e.id::text)) then
      raise exception 'newer change prevents safe undo';
    end if;
    update public.obligations
    set title=coalesce(v_target_event.old_value->>'title',title),
        project_id=case when v_target_event.old_value ? 'project_id' then (v_target_event.old_value->>'project_id')::uuid else project_id end,
        verification_state=coalesce(v_target_event.old_value->>'verification_state',verification_state),
        state=coalesce(v_target_event.old_value->>'state',state),
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

    -- Never let undo erase a newer source/system/manual change.
    if exists (select 1 from public.obligation_events e
      where e.user_id=p_user_id and e.obligation_id=p_obligation_id
        and e.id>v_target_event.id and e.event_type<>'MANUAL_UNDO'
        and not exists(select 1 from public.obligation_events u where u.user_id=e.user_id
          and u.obligation_id=e.obligation_id and u.event_type='MANUAL_UNDO' and u.source_ref='event:'||e.id::text)) then
      raise exception 'newer change prevents safe undo';
    end if;
    update public.obligations
    set title=coalesce(v_target_event.old_value->>'title',title),
        project_id=case when v_target_event.old_value ? 'project_id' then (v_target_event.old_value->>'project_id')::uuid else project_id end,
        verification_state=coalesce(v_target_event.old_value->>'verification_state',verification_state),
        state='DONE',
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

    -- Never let undo erase a newer source/system/manual change.
    if exists (select 1 from public.obligation_events e
      where e.user_id=p_user_id and e.obligation_id=p_obligation_id
        and e.id>v_target_event.id and e.event_type<>'MANUAL_UNDO'
        and not exists(select 1 from public.obligation_events u where u.user_id=e.user_id
          and u.obligation_id=e.obligation_id and u.event_type='MANUAL_UNDO' and u.source_ref='event:'||e.id::text)) then
      raise exception 'newer change prevents safe undo';
    end if;
    update public.obligations
    set title=coalesce(v_target_event.old_value->>'title',title),
        project_id=case when v_target_event.old_value ? 'project_id' then (v_target_event.old_value->>'project_id')::uuid else project_id end,
        verification_state=coalesce(v_target_event.old_value->>'verification_state',verification_state),
        state='BLOCKED',
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

    -- Never let undo erase a newer source/system/manual change.
    if exists (select 1 from public.obligation_events e
      where e.user_id=p_user_id and e.obligation_id=p_obligation_id
        and e.id>v_target_event.id and e.event_type<>'MANUAL_UNDO'
        and not exists(select 1 from public.obligation_events u where u.user_id=e.user_id
          and u.obligation_id=e.obligation_id and u.event_type='MANUAL_UNDO' and u.source_ref='event:'||e.id::text)) then
      raise exception 'newer change prevents safe undo';
    end if;
    update public.obligations
    set title=coalesce(v_target_event.old_value->>'title',title),
        project_id=case when v_target_event.old_value ? 'project_id' then (v_target_event.old_value->>'project_id')::uuid else project_id end,
        verification_state=coalesce(v_target_event.old_value->>'verification_state',verification_state),
        state='WAITING',
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
    'title',v_row.title,
    'project_id',v_row.project_id,
    'verification_state',v_row.verification_state,
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
    'title',v_row.title,
    'project_id',v_row.project_id,
    'verification_state',v_row.verification_state,
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
