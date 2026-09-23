-- MCC Phase 2 current obligation expansion 2
-- Approved for controlled production execution on 2026-09-23.
-- Scope: four current obligations with bounded-source verification.

begin;

do $$
begin
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'Expected exactly one MCC profile';
  end if;
end $$;

-- Ensure Tahiti project shell exists.
insert into public.projects (
  user_id,business_id,title,description,state,health,health_method,health_reason,
  priority,source_system,source_ref,last_meaningful_change_at
)
select p.user_id,b.id,
  'Tahiti FAM',
  'Executive coordination for Nicci and Tim Tahiti travel. Supplier and booking systems remain authoritative.',
  'ACTIVE','NEEDS_ATTENTION','MANUAL',
  'Current pre-trip actions require verification before October travel.',
  80,'mcc_project_seed','phase2:tahiti-fam',now()
from public.profiles p
join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
where not exists (
  select 1 from public.projects x
  where x.user_id=p.user_id and x.source_system='mcc_project_seed' and x.source_ref='phase2:tahiti-fam'
);

-- 1) Master Account authorization promise.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,due_at,due_kind,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'PROMISE',
    'MasterClass — verify Rosen Master Account authorization completion',
    'Nicci told Rosen on September 21 that she would complete the Master Account card authorization that day. Rosen then sent an updated secure authorization link. No completion confirmation was located in the bounded Gmail check, so completion is not assumed.',
    'TODAY',94,'ORANGE','NICCI',
    '2026-09-22T04:59:59Z','SOFT',
    'Verify whether the current Rosen Master Account authorization was submitted; if not, complete it using the current secure Rosen link.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0c4ed6415b2928'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','sent_message','message:1a0c4ed6415b2928','2026-09-21T17:04:46Z',
  array['promise_made','promise_date','authorization_dependency'],
  array['promise_made','promise_date'],'PRIMARY'
from ins;

insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select o.user_id,o.id,'gmail','hotel_message','message:1a0c54fff7288b77','2026-09-21T18:52:25Z',
  array['current_authorization_link_exists'],array['current_authorization_link_exists'],'SUPPORTING'
from public.obligations o
join public.obligation_sources s on s.obligation_id=o.id and s.source_ref='message:1a0c4ed6415b2928'
where not exists (
  select 1 from public.obligation_sources x
  where x.user_id=o.user_id and x.source_system='gmail' and x.source_ref='message:1a0c54fff7288b77'
);

-- 2) Rosen check discrepancy / waiting.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,waiting_on,waiting_since,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'DISCREPANCY',
    'Rosen check — verify clearing status',
    'Rosen AP reported check #10316963 had not cleared as of September 18. Nicci replied that she deposited it on September 18 and asked Rosen to advise if it still did not clear. Email does not establish authoritative bank/payment status.',
    'WAITING',84,'YELLOW','WAITING',
    'Rosen Hotels / bank clearing confirmation','2026-09-21T12:54:50Z',
    'Verify clearing from the authoritative financial source before treating the check as cleared.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='thread:1a0b58398c97189b'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','thread','thread:1a0b58398c97189b','2026-09-21T12:54:50Z',
  array['rosen_reported_uncleared','nicci_reported_deposit','followup_requested'],
  array['rosen_reported_uncleared','nicci_reported_deposit','followup_requested'],'SUPPORTING'
from ins;

-- 3) Angie Cain / Victoria Redwine room update.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'ACTION',
    'Angie Cain — add Victoria Redwine to MasterClass room',
    'Angie requested another person in her room. After Nicci asked for the name, Angie replied Victoria Redwine on September 21. Current hotel/AgentEdge completion state is not yet verified.',
    'THIS_WEEK',86,'YELLOW','CHATGPT_PREP',
    'Verify the current hotel/AgentEdge rooming record and prepare the required occupancy update if it is still outstanding.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0c5e56da415d9b'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','client_message','message:1a0c5e56da415d9b','2026-09-21T21:35:35Z',
  array['additional_guest_name','room_change_request_exists'],
  array['additional_guest_name','room_change_request_exists'],'PRIMARY'
from ins;

-- 4) Tahiti tattoo decision / overdue details.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:tahiti-fam'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,due_at,due_kind,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'DECISION',
    'Tahiti — resolve Oct 23 tattoo appointment details',
    'Tahiti Adventures requested tattoo design, placement, size, and reference details and set a September 10 reply deadline, noting the appointment may not be confirmed without them. A bounded Gmail search found no matching to/from the tattoo artist after the request; other-channel completion is not excluded.',
    'TODAY',92,'ORANGE','NICCI',
    '2026-09-11T03:59:59Z','SOFT',
    'Decide whether to keep the tattoo appointment; if yes, verify current appointment status and provide the requested details through the authoritative contact path.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0673ecfd73ba95'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','supplier_message','message:1a0673ecfd73ba95','2026-09-03T12:29:09Z',
  array['tattoo_details_requested','reply_deadline','appointment_risk'],
  array['tattoo_details_requested','reply_deadline','appointment_risk'],'PRIMARY'
from ins;

-- Creation events for any newly seeded obligations.
insert into public.obligation_events (
  user_id,obligation_id,event_type,actor_type,actor_ref,new_value,reason,source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','phase2-current-obligations-2',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'risk_level',o.risk_level,'execution_owner',o.execution_owner),
  'Controlled Phase 2 carry-forward from current bounded-source verification.',
  s.source_system||':'||s.source_ref
from public.obligations o
join lateral (
  select s.* from public.obligation_sources s
  where s.obligation_id=o.id and s.user_id=o.user_id
  order by case when s.evidence_role='PRIMARY' then 0 else 1 end,s.created_at
  limit 1
) s on true
where s.source_ref in (
  'message:1a0c4ed6415b2928',
  'thread:1a0b58398c97189b',
  'message:1a0c5e56da415d9b',
  'message:1a0673ecfd73ba95'
)
and not exists (
  select 1 from public.obligation_events e
  where e.obligation_id=o.id and e.event_type='CREATED'
);

do $$
begin
  if exists (
    select 1 from public.obligations o
    left join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
    where s.id is null
  ) then raise exception 'Would leave an obligation without provenance'; end if;

  if exists (
    select 1 from public.obligation_sources
    group by user_id,source_system,source_ref
    having count(*) > 1
  ) then raise exception 'Would create duplicate stable source refs'; end if;
end $$;

commit;
