-- MCC Phase 3A LOCAL integration suite.
-- Run only against an isolated local Supabase stack. Never production.
begin;

insert into public.allowed_emails(email,note) values
 ('mcc-phase3-a@example.invalid','local phase3 validation'),
 ('mcc-phase3-b@example.invalid','local phase3 validation')
on conflict(email) do nothing;

insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
values
 ('10000000-0000-0000-0000-000000000031','mcc-phase3-a@example.invalid','{}','{}',now(),now()),
 ('10000000-0000-0000-0000-000000000032','mcc-phase3-b@example.invalid','{}','{}',now(),now());

insert into public.projects(id,user_id,title,health,health_method,health_reason)
values
 ('20000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000031','Phase3 A','ON_TRACK','MANUAL','fixture'),
 ('20000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000032','Phase3 B','ON_TRACK','MANUAL','fixture');

insert into public.obligations(
 id,user_id,project_id,type,title,state,execution_owner,verification_state
) values
 ('30000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000031','20000000-0000-0000-0000-000000000031','ACTION','Phase3 A obligation','UPCOMING','NICCI','VERIFIED'),
 ('30000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000032','20000000-0000-0000-0000-000000000032','ACTION','Phase3 B obligation','UPCOMING','NICCI','VERIFIED');

insert into public.obligation_sources(user_id,obligation_id,source_system,source_ref,claim_scope,authoritative_claims,evidence_role)
values
 ('10000000-0000-0000-0000-000000000031','30000000-0000-0000-0000-000000000031','TEST','phase3:a',array['fixture'],array['fixture'],'PRIMARY'),
 ('10000000-0000-0000-0000-000000000032','30000000-0000-0000-0000-000000000032','TEST','phase3:b',array['fixture'],array['fixture'],'PRIMARY');

do $$
begin
  if has_function_privilege('authenticated','public.mcc_apply_manual_action(uuid,uuid,text,text,text,timestamptz)','EXECUTE') then
    raise exception 'authenticated unexpectedly has direct RPC execute';
  end if;
  if not has_function_privilege('service_role','public.mcc_apply_manual_action(uuid,uuid,text,text,text,timestamptz)','EXECUTE') then
    raise exception 'service_role lacks manual action RPC execute';
  end if;
  if has_table_privilege('authenticated','public.obligations','UPDATE')
     or has_table_privilege('authenticated','public.obligation_events','INSERT') then
    raise exception 'browser role unexpectedly has direct canonical write privilege';
  end if;
end $$;

-- DONE: state and event are written together.
select public.mcc_apply_manual_action(
 '10000000-0000-0000-0000-000000000031',
 '30000000-0000-0000-0000-000000000031',
 'DONE',null,null,null
);
do $$
declare st text; completed timestamptz; n integer;
begin
 select state,completed_at into st,completed from public.obligations where id='30000000-0000-0000-0000-000000000031';
 if st<>'DONE' or completed is null then raise exception 'DONE transition failed'; end if;
 select count(*) into n from public.obligation_events where obligation_id='30000000-0000-0000-0000-000000000031' and event_type='MANUAL_DONE';
 if n<>1 then raise exception 'DONE did not create exactly one audit event: %',n; end if;
end $$;

-- Repeating DONE is idempotent and does not add another event.
select public.mcc_apply_manual_action(
 '10000000-0000-0000-0000-000000000031',
 '30000000-0000-0000-0000-000000000031',
 'DONE',null,null,null
);
do $$
declare n integer;
begin
 select count(*) into n from public.obligation_events where obligation_id='30000000-0000-0000-0000-000000000031' and event_type='MANUAL_DONE';
 if n<>1 then raise exception 'idempotent DONE added event'; end if;
end $$;

-- UNDO restores the pre-DONE snapshot and records its own event.
select public.mcc_apply_manual_action(
 '10000000-0000-0000-0000-000000000031',
 '30000000-0000-0000-0000-000000000031',
 'UNDO_LAST','local undo test',null,null
);
do $$
declare st text; completed timestamptz; n integer;
begin
 select state,completed_at into st,completed from public.obligations where id='30000000-0000-0000-0000-000000000031';
 if st<>'UPCOMING' or completed is not null then raise exception 'UNDO did not restore prior state'; end if;
 select count(*) into n from public.obligation_events where obligation_id='30000000-0000-0000-0000-000000000031' and event_type='MANUAL_UNDO';
 if n<>1 then raise exception 'UNDO audit event missing'; end if;
end $$;

-- WAITING requires a named dependency and records follow-up.
select public.mcc_apply_manual_action(
 '10000000-0000-0000-0000-000000000031',
 '30000000-0000-0000-0000-000000000031',
 'WAITING',null,'Rosen Centre','2026-09-28T14:00:00Z'
);
do $$
declare st text; owner text; who text; fu timestamptz; n integer;
begin
 select state,execution_owner,waiting_on,follow_up_at into st,owner,who,fu
 from public.obligations where id='30000000-0000-0000-0000-000000000031';
 if st<>'WAITING' or owner<>'WAITING' or who<>'Rosen Centre' or fu is null then
   raise exception 'WAITING transition failed';
 end if;
 select count(*) into n from public.obligation_events where obligation_id='30000000-0000-0000-0000-000000000031' and event_type='MANUAL_WAITING';
 if n<>1 then raise exception 'WAITING event missing'; end if;
end $$;

-- Wrong user/obligation pairing fails closed.
do $$
begin
  begin
    perform public.mcc_apply_manual_action(
      '10000000-0000-0000-0000-000000000031',
      '30000000-0000-0000-0000-000000000032',
      'NEED_HELP',null,null,null
    );
    raise exception 'cross-user action unexpectedly succeeded';
  exception when others then
    if sqlerrm='cross-user action unexpectedly succeeded' then raise; end if;
  end;
end $$;

-- BLOCKED requires a reason.
do $$
begin
  begin
    perform public.mcc_apply_manual_action(
      '10000000-0000-0000-0000-000000000032',
      '30000000-0000-0000-0000-000000000032',
      'BLOCKED',null,null,null
    );
    raise exception 'BLOCKED accepted blank reason';
  exception when others then
    if sqlerrm='BLOCKED accepted blank reason' then raise; end if;
  end;
end $$;

-- NEED_HELP changes preparation ownership without changing state.
select public.mcc_apply_manual_action(
 '10000000-0000-0000-0000-000000000032',
 '30000000-0000-0000-0000-000000000032',
 'NEED_HELP','prepare next steps',null,null
);
do $$
declare st text; owner text; n integer;
begin
 select state,execution_owner into st,owner from public.obligations where id='30000000-0000-0000-0000-000000000032';
 if st<>'UPCOMING' or owner<>'CHATGPT_PREP' then raise exception 'NEED_HELP transition failed'; end if;
 select count(*) into n from public.obligation_events where obligation_id='30000000-0000-0000-0000-000000000032' and event_type='HELP_REQUESTED';
 if n<>1 then raise exception 'HELP_REQUESTED event missing'; end if;
end $$;

rollback;
