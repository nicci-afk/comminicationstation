-- MCC final current-state reconciliation batch
-- PREP ONLY: DO NOT RUN IN PRODUCTION WITHOUT NICCI'S EXPLICIT APPROVAL.
-- Current-source reconciliation after the nine-obligation seed.

begin;

do $$
begin
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'Expected exactly one MCC profile';
  end if;
end $$;

-- Project: AgentEdge Audit.
insert into public.projects (
  user_id,business_id,title,description,state,health,health_method,health_reason,
  priority,source_system,source_ref,last_meaningful_change_at
)
select p.user_id,b.id,
  'AgentEdge Audit',
  'Executive tracking for AgentEdge workflow/data-trust and runtime health. AgentEdge remains authoritative for Travel GHR client/trip/booking operational truth.',
  'ACTIVE','AT_RISK','MANUAL',
  'Current AgentEdge monitor reports debrief freshness failure and intermittent email-sync health-check failure.',
  95,'mcc_project_seed','phase2:agentedge-audit','2026-09-25T16:07:13Z'
from public.profiles p
join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
where not exists (
  select 1 from public.projects x
  where x.user_id=p.user_id and x.source_system='mcc_project_seed' and x.source_ref='phase2:agentedge-audit'
);

-- Project: Vietnam FAM.
insert into public.projects (
  user_id,business_id,title,description,state,health,health_method,health_reason,
  priority,source_system,source_ref,last_meaningful_change_at
)
select p.user_id,b.id,
  'Vietnam FAM',
  'Executive coordination for Nicci and Tim Vietnam FAM. Supplier/booking systems remain authoritative.',
  'ACTIVE','NEEDS_ATTENTION','MANUAL',
  'Supplier deadline and traveler completion requirements need current verification before October 2.',
  88,'mcc_project_seed','phase2:vietnam-fam','2026-09-10T18:04:50Z'
from public.profiles p
join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
where not exists (
  select 1 from public.projects x
  where x.user_id=p.user_id and x.source_system='mcc_project_seed' and x.source_ref='phase2:vietnam-fam'
);

-- Close the Rosen authorization obligation based on Nicci's direct completion statement.
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select o.user_id,o.id,'gmail','sent_message','message:1a0cf345628d6dc8','2026-09-23T16:58:27Z',
  array['authorization_action_completed','catering_decision_made'],
  array['authorization_action_completed','catering_decision_made'],'PRIMARY'
from public.obligations o
join public.obligation_sources s
  on s.obligation_id=o.id and s.user_id=o.user_id
 and s.source_system='gmail' and s.source_ref='message:1a0c4ed6415b2928'
where not exists (
  select 1 from public.obligation_sources x
  where x.user_id=o.user_id and x.source_system='gmail' and x.source_ref='message:1a0cf345628d6dc8'
);

with target as (
  select o.id,o.user_id,o.state as old_state,o.verification_state as old_verification
  from public.obligations o
  join public.obligation_sources s
    on s.obligation_id=o.id and s.user_id=o.user_id
   and s.source_system='gmail' and s.source_ref='message:1a0c4ed6415b2928'
  where o.state not in ('DONE','CANCELLED')
), updated as (
  update public.obligations o
  set state='DONE',
      completed_at='2026-09-23T16:58:27Z',
      verification_state='PARTIALLY_VERIFIED',
      next_action=null,
      updated_at=now()
  from target t
  where o.id=t.id and o.user_id=t.user_id
  returning o.id,o.user_id,t.old_state,t.old_verification
)
insert into public.obligation_events (
  user_id,obligation_id,event_type,actor_type,actor_ref,old_value,new_value,reason,source_ref
)
select user_id,id,'COMPLETED','CHATGPT','final-current-state-reconciliation',
  jsonb_build_object('state',old_state,'verification_state',old_verification),
  jsonb_build_object('state','DONE','verification_state','PARTIALLY_VERIFIED'),
  'Nicci directly stated in sent Gmail that the Rosen authorization link was completed. This closes the promised action only; it does not assert hotel payment/settlement state.',
  'gmail:message:1a0cf345628d6dc8'
from updated;

-- 1) AgentEdge current health risk.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:agentedge-audit'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'RISK',
    'AgentEdge — resolve failing debrief freshness and intermittent email-sync health checks',
    'The current AgentEdge monitor reports debrief_freshness=FAIL and ping_email-sync=FAIL while other listed checks are OK. Treat AgentEdge-derived operational truth cautiously until the failing checks are understood.',
    'TODAY',97,'ORANGE','CHATGPT_PREP',
    'Inspect the current AgentEdge runtime/monitor path, determine whether debrief freshness is expected or broken, and verify email-sync health before relying on AgentEdge intake as fully healthy.',
    'VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0d952241358fd4'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','monitor_alert','message:1a0d952241358fd4','2026-09-25T16:07:13Z',
  array['debrief_freshness_failed','email_sync_ping_failed','monitor_state'],
  array['debrief_freshness_failed','email_sync_ping_failed','monitor_state'],'PRIMARY'
from ins;

-- 2) Sarah Franks attendee follow-up.
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
    'Sarah Franks — resolve MasterClass room, schedule, and Facebook access follow-up',
    'Sarah followed up asking whether her hotel can be changed to single occupancy, for the tentative event schedule, and for confirmation of Facebook-group access. The event is imminent.',
    'TODAY',93,'ORANGE','CHATGPT_PREP',
    'Verify current Rosen/AgentEdge room state, current event schedule, and Facebook access; prepare a grounded reply for approval.',
    'VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0ce7272e7e0520'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','attendee_message','message:1a0ce7272e7e0520','2026-09-23T18:26:30Z',
  array['room_change_requested','schedule_requested','facebook_access_requested','followup_exists'],
  array['room_change_requested','schedule_requested','facebook_access_requested','followup_exists'],'PRIMARY'
from ins;

-- 3) Maysa hotel confirmation request.
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
    'Maysa — provide current Rosen hotel confirmation for international travel',
    'Maysa requested a hotel confirmation because she is traveling from Brazil and may need it for immigration. Current hotel confirmation details must be verified before sending.',
    'TODAY',91,'ORANGE','CHATGPT_PREP',
    'Retrieve the current Rosen hotel confirmation from the authoritative hotel/AgentEdge record and prepare the confirmation response for approval.',
    'VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0cedebb816e3cf'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','attendee_message','message:1a0cedebb816e3cf','2026-09-23T15:24:53Z',
  array['hotel_confirmation_requested','international_travel_context'],
  array['hotel_confirmation_requested','international_travel_context'],'PRIMARY'
from ins;

-- 4) Final Rosen rooming corrections are waiting on confirmation.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='The Conscious Creator'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:masterclass-events-operations'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,waiting_on,waiting_since,follow_up_at,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'WAITING',
    'Rosen rooming corrections — confirm final application',
    'Nicci sent corrections for Scott Burke and Nicci/Tim plus a parking request. Rosen subsequently answered the separate Kha early-room question, but that reply did not confirm the rooming corrections.',
    'WAITING',90,'ORANGE','WAITING',
    'Rosen Centre / Jennifer Velez','2026-09-24T17:06:07Z','2026-09-28T14:00:00Z',
    'If Rosen has not confirmed the rooming corrections by the follow-up trigger, request confirmation before arrival.',
    'PARTIALLY_VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a0d461ba7dd3454'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','sent_message','message:1a0d461ba7dd3454','2026-09-24T17:06:07Z',
  array['rooming_corrections_sent','parking_request_sent','kha_early_room_question_sent'],
  array['rooming_corrections_sent','parking_request_sent','kha_early_room_question_sent'],'PRIMARY'
from ins;

insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select o.user_id,o.id,'gmail','hotel_reply','message:1a0d50ebafc52819','2026-09-24T20:15:02Z',
  array['kha_early_room_answered','rooming_corrections_not_confirmed_in_this_reply'],
  array['kha_early_room_answered'],'SUPPORTING'
from public.obligations o
join public.obligation_sources s
  on s.obligation_id=o.id and s.source_ref='message:1a0d461ba7dd3454'
where not exists (
  select 1 from public.obligation_sources x
  where x.user_id=o.user_id and x.source_system='gmail' and x.source_ref='message:1a0d50ebafc52819'
);

-- 5) Vietnam supplier deadline / traveler requirements.
with ctx as (
  select p.user_id,b.id business_id,pr.id project_id
  from public.profiles p
  join public.businesses b on b.user_id=p.user_id and b.name='Travel GHR'
  join public.projects pr on pr.user_id=p.user_id and pr.source_ref='phase2:vietnam-fam'
), ins as (
  insert into public.obligations (
    user_id,project_id,business_id,type,title,description,state,priority,risk_level,
    execution_owner,due_at,due_kind,next_action,verification_state
  )
  select user_id,project_id,business_id,
    'DEADLINE',
    'Vietnam FAM — verify final balance and Good to Go before October 2',
    'G Adventures states the final balance is due October 2 and provides Good to Go links for both travelers. The source gives a date but no clock time; the stored due_at is normalized to end-of-day America/Chicago for deterministic prioritization only.',
    'THIS_WEEK',95,'ORANGE','NICCI',
    '2026-10-03T04:59:59Z','HARD',
    'Refresh the current G Adventures supplier record before any payment; verify whether the final balance and both Good to Go forms are still outstanding, then act only on verified current state.',
    'VERIFIED'
  from ctx
  where not exists (
    select 1 from public.obligation_sources s
    where s.user_id=ctx.user_id and s.source_system='gmail'
      and s.source_ref='message:1a058f8dfe47fcbc'
  )
  returning id,user_id
)
insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select user_id,id,'gmail','supplier_message','message:1a058f8dfe47fcbc','2026-08-31T17:58:01Z',
  array['final_balance_due_date','good_to_go_required','booking_reference'],
  array['final_balance_due_date','good_to_go_required','booking_reference'],'PRIMARY'
from ins;

insert into public.obligation_sources (
  user_id,obligation_id,source_system,source_type,source_ref,source_timestamp,
  claim_scope,authoritative_claims,evidence_role
)
select o.user_id,o.id,'gmail','supplier_message','message:1a08c7eb28a0aa27','2026-09-10T18:04:50Z',
  array['vietnam_fam_active','whatsapp_group_available'],
  array['vietnam_fam_active','whatsapp_group_available'],'SUPPORTING'
from public.obligations o
join public.obligation_sources s
  on s.obligation_id=o.id and s.source_ref='message:1a058f8dfe47fcbc'
where not exists (
  select 1 from public.obligation_sources x
  where x.user_id=o.user_id and x.source_system='gmail' and x.source_ref='message:1a08c7eb28a0aa27'
);

-- Creation events for newly seeded obligations.
insert into public.obligation_events (
  user_id,obligation_id,event_type,actor_type,actor_ref,new_value,reason,source_ref
)
select o.user_id,o.id,'CREATED','CHATGPT','final-current-state-reconciliation',
  jsonb_build_object('state',o.state,'verification_state',o.verification_state,'risk_level',o.risk_level,'execution_owner',o.execution_owner),
  'Controlled current-state reconciliation from bounded source verification.',
  s.source_system||':'||s.source_ref
from public.obligations o
join lateral (
  select s.* from public.obligation_sources s
  where s.obligation_id=o.id and s.user_id=o.user_id
  order by case when s.evidence_role='PRIMARY' then 0 else 1 end,s.created_at
  limit 1
) s on true
where s.source_ref in (
  'message:1a0d952241358fd4',
  'message:1a0ce7272e7e0520',
  'message:1a0cedebb816e3cf',
  'message:1a0d461ba7dd3454',
  'message:1a058f8dfe47fcbc'
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
