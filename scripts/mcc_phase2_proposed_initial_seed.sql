-- MCC v2 Phase 2 proposed initial seed.
-- PREP ONLY: DO NOT RUN IN PRODUCTION WITHOUT NICCI'S EXPLICIT APPROVAL.
-- Scope: five conservative carry-forward obligations with current evidence.
-- No historical queue import. No external communication. No booking or financial changes.

begin;

-- Fail closed if the expected single-user profile is not present.
do $$
begin
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'Phase 2 seed expects exactly one current MCC profile';
  end if;
end $$;

-- Minimal project shells. These hold executive coordination only; domain truth stays in source systems.
insert into public.projects (
  user_id, business_id, title, description, state, health, health_method, health_reason,
  priority, source_system, source_ref, last_meaningful_change_at
)
select
  p.user_id,
  b.id,
  'Travel GHR — Client Operations',
  'Executive coordination for verified current Travel GHR client obligations. AgentEdge/suppliers remain operational sources of truth.',
  'ACTIVE',
  'NEEDS_ATTENTION',
  'MANUAL',
  'Initial Phase 2 carry-forward contains active client work requiring current-source verification.',
  70,
  'mcc_project_seed',
  'phase2:travel-ghr-client-operations',
  now()
from public.profiles p
join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
where not exists (
  select 1 from public.projects x
  where x.user_id=p.user_id and x.source_system='mcc_project_seed'
    and x.source_ref='phase2:travel-ghr-client-operations'
);

insert into public.projects (
  user_id, business_id, title, description, state, health, health_method, health_reason,
  priority, source_system, source_ref, last_meaningful_change_at
)
select
  p.user_id,
  b.id,
  'MasterClass — Events & Operations',
  'Executive coordination for MasterClass event operations. Communication and booking source records remain authoritative.',
  'ACTIVE',
  'NEEDS_ATTENTION',
  'MANUAL',
  'October Orlando operations are active and require current readiness checks.',
  75,
  'mcc_project_seed',
  'phase2:masterclass-events-operations',
  now()
from public.profiles p
join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
where not exists (
  select 1 from public.projects x
  where x.user_id=p.user_id and x.source_system='mcc_project_seed'
    and x.source_ref='phase2:masterclass-events-operations'
);

-- Helper convention:
-- An obligation is considered already seeded when its stable primary source ref already exists.
-- This makes the seed rerunnable without duplicating executive work.

-- 1) Amanda Setchell — current NYC Christmas trip request.
with ctx as (
  select p.user_id, b.id as business_id, pr.id as project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id
    and pr.source_ref='phase2:travel-ghr-client-operations'
), ins as (
  insert into public.obligations (
    user_id, project_id, business_id, type, title, description, state, priority,
    risk_level, execution_owner, next_action, verification_state
  )
  select user_id, project_id, business_id,
    'ACTION',
    'Amanda Setchell — prepare NYC Christmas options',
    'Current Gmail thread contains trip details supplied on 2026-09-21. Quote/option work is active; no client-facing send is authorized by this seed.',
    'TODAY', 88, 'YELLOW', 'CHATGPT_PREP',
    'Prepare current NYC options/quote for review; refresh volatile pricing before use and require approval before sending.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='thread:1a0bbb1fd30f4ef1'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select user_id,id,'gmail','thread','thread:1a0bbb1fd30f4ef1','2026-09-21T14:06:13Z',
  array['request_exists','traveler_requirements','current_message_timestamp'],
  array['request_exists','traveler_requirements','current_message_timestamp'],
  'PRIMARY'
from ins;

insert into public.obligation_events (
  user_id, obligation_id, event_type, actor_type, actor_ref, new_value, reason, source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-controlled-seed',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'execution_owner',o.execution_owner),
  'Initial controlled carry-forward from current Gmail evidence.',
  'gmail:thread:1a0bbb1fd30f4ef1'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='gmail' and s.source_ref='thread:1a0bbb1fd30f4ef1'
  and not exists (
    select 1 from public.obligation_events e
    where e.obligation_id=o.id and e.event_type='CREATED'
  );

-- 2) Paul Darr — anniversary trip remains a current client item, but completion state is not proven.
with ctx as (
  select p.user_id, b.id as business_id, pr.id as project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id
    and pr.source_ref='phase2:travel-ghr-client-operations'
), ins as (
  insert into public.obligations (
    user_id, project_id, business_id, type, title, description, state, priority,
    risk_level, execution_owner, next_action, verification_state
  )
  select user_id, project_id, business_id,
    'ACTION',
    'Paul Darr — verify anniversary proposal status',
    'Gmail confirms active 20th-anniversary planning and an in-person discussion was coordinated. The latest quote/proposal completion state is not established by the thread alone.',
    'THIS_WEEK', 78, 'YELLOW', 'CHATGPT_PREP',
    'Verify the latest proposal/quote state in the current Travel GHR source before recommending follow-up.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='thread:1a0727583159f2aa'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select user_id,id,'gmail','thread','thread:1a0727583159f2aa','2026-09-15T02:09:50Z',
  array['client_request_exists','meeting_coordination','latest_email_timestamp'],
  array['client_request_exists','meeting_coordination','latest_email_timestamp'],
  'PRIMARY'
from ins;

insert into public.obligation_events (
  user_id, obligation_id, event_type, actor_type, actor_ref, new_value, reason, source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-controlled-seed',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'execution_owner',o.execution_owner),
  'Initial controlled carry-forward; completion intentionally not inferred.',
  'gmail:thread:1a0727583159f2aa'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='gmail' and s.source_ref='thread:1a0727583159f2aa'
  and not exists (
    select 1 from public.obligation_events e
    where e.obligation_id=o.id and e.event_type='CREATED'
  );

-- 3) Orlando return-flight decision — conflicting current Calendar events.
with ctx as (
  select p.user_id, b.id as business_id, pr.id as project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id
    and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id, project_id, business_id, type, title, description, state, priority,
    risk_level, execution_owner, next_action, verification_state, blocked_reason
  )
  select user_id, project_id, business_id,
    'DECISION',
    'Orlando return flight — reconcile Oct 7 vs Oct 8',
    'Google Calendar currently contains Orlando→St. Louis flight events on both October 7 and October 8. No booking change should occur until the authoritative airline/booking source is reconciled.',
    'BLOCKED', 96, 'ORANGE', 'NICCI',
    'Check the authoritative airline/booking record and decide which return itinerary is valid before any change.',
    'CONFLICT',
    'Two current Calendar flight events conflict; Calendar alone is not authoritative booking truth.'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='google_calendar'
      and s.source_ref='event:6ktqgfr11qti42fffda2euou6g'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select user_id,id,'google_calendar','event','event:6ktqgfr11qti42fffda2euou6g','2026-10-07T19:10:00Z',
  array['scheduled_event_exists'], array['scheduled_event_exists'], 'PRIMARY'
from ins;

insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select o.user_id,o.id,'google_calendar','event','event:3243mtkonq9f7fljcknnv5borg','2026-10-08T23:25:00Z',
  array['scheduled_event_exists'], array['scheduled_event_exists'], 'SUPPORTING'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='google_calendar' and s.source_ref='event:6ktqgfr11qti42fffda2euou6g'
  and not exists (
    select 1 from public.obligation_sources x
    where x.user_id=o.user_id and x.source_system='google_calendar'
      and x.source_ref='event:3243mtkonq9f7fljcknnv5borg'
  );

insert into public.obligation_events (
  user_id, obligation_id, event_type, actor_type, actor_ref, new_value, reason, source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-controlled-seed',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'risk_level',o.risk_level),
  'Initial controlled carry-forward marked CONFLICT; consequential booking action blocked.',
  'google_calendar:event:6ktqgfr11qti42fffda2euou6g'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='google_calendar' and s.source_ref='event:6ktqgfr11qti42fffda2euou6g'
  and not exists (
    select 1 from public.obligation_events e
    where e.obligation_id=o.id and e.event_type='CREATED'
  );

-- 4) Sarah Harrison — verify Cancun readiness.
with ctx as (
  select p.user_id, b.id as business_id, pr.id as project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id
    and pr.source_ref='phase2:travel-ghr-client-operations'
), ins as (
  insert into public.obligations (
    user_id, project_id, business_id, type, title, description, state, priority,
    risk_level, execution_owner, next_action, verification_state
  )
  select user_id, project_id, business_id,
    'ACTION',
    'Sarah Harrison — verify Cancun trip readiness',
    'Current Funjet itinerary confirms an October 22 departure and a recent client update exists. Specific remaining readiness items must be refreshed from AgentEdge/supplier truth before outreach.',
    'THIS_WEEK', 82, 'YELLOW', 'CHATGPT_PREP',
    'Refresh AgentEdge/supplier record and identify any incomplete trip-readiness items; prepare follow-up only if needed.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a068a0f7cbe18a5'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select user_id,id,'gmail','supplier_itinerary_email','message:1a068a0f7cbe18a5','2026-09-03T18:56:12Z',
  array['trip_exists','supplier_reservation_ref','departure_date'],
  array['trip_exists','supplier_reservation_ref','departure_date'],
  'PRIMARY'
from ins;

insert into public.obligation_events (
  user_id, obligation_id, event_type, actor_type, actor_ref, new_value, reason, source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-controlled-seed',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'execution_owner',o.execution_owner),
  'Initial controlled carry-forward; operational readiness remains subject to AgentEdge/supplier refresh.',
  'gmail:message:1a068a0f7cbe18a5'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='gmail' and s.source_ref='message:1a068a0f7cbe18a5'
  and not exists (
    select 1 from public.obligation_events e
    where e.obligation_id=o.id and e.event_type='CREATED'
  );

-- 5) MasterClass Facebook-group content status.
with ctx as (
  select p.user_id, b.id as business_id, pr.id as project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id
    and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id, project_id, business_id, type, title, description, state, priority,
    risk_level, execution_owner, next_action, verification_state
  )
  select user_id, project_id, business_id,
    'ACTION',
    'MasterClass — verify Facebook group content status',
    'Kha’s current thread supports using two separate Facebook groups. The project seed says a classroom-look video needs posting, but current posting status is not proven.',
    'THIS_WEEK', 72, 'GREEN', 'CHATGPT_PREP',
    'Verify whether the classroom-look video has already been posted; if not, prepare the post for approval.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='thread:1a032ef06e29cde9'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id, obligation_id, source_system, source_type, source_ref, source_timestamp,
  claim_scope, authoritative_claims, evidence_role
)
select user_id,id,'gmail','thread','thread:1a032ef06e29cde9','2026-08-26T03:26:29Z',
  array['facebook_group_structure'], array['facebook_group_structure'], 'SUPPORTING'
from ins;

insert into public.obligation_events (
  user_id, obligation_id, event_type, actor_type, actor_ref, new_value, reason, source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-controlled-seed',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'execution_owner',o.execution_owner),
  'Initial controlled carry-forward as a verification/preparation task, not a claim that posting is incomplete.',
  'gmail:thread:1a032ef06e29cde9'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
where s.source_system='gmail' and s.source_ref='thread:1a032ef06e29cde9'
  and not exists (
    select 1 from public.obligation_events e
    where e.obligation_id=o.id and e.event_type='CREATED'
  );

-- Final fail-closed sanity checks inside the transaction.
do $$
begin
  if exists (
    select 1
    from public.obligations o
    left join public.obligation_sources s
      on s.obligation_id=o.id and s.user_id=o.user_id
    where s.id is null
  ) then
    raise exception 'Seed would leave an obligation without provenance';
  end if;

  if exists (
    select 1
    from public.obligation_sources
    group by user_id, source_system, source_ref
    having count(*) > 1
  ) then
    raise exception 'Seed would create duplicate stable source refs';
  end if;
end $$;

-- Production execution should COMMIT only after the exact script is approved.
commit;
