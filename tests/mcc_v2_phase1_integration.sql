-- MCC v2 Phase 1 LOCAL PostgreSQL/Supabase integration suite.
-- Run only after a clean local rebuild through 0023. Never run against production.
begin;

-- Baseline reconciliation.
do $$
declare d text;
begin
  select indexdef into d from pg_indexes
   where schemaname='public' and indexname='queue_items_active_thread';
  if d is null or position('is_split_clone = false' in lower(d))=0 then
    raise exception 'active-thread index not reconciled';
  end if;

  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='recategorize_queue_item'
    and pg_get_function_identity_arguments(p.oid)='p_queue_item_id uuid, p_category text, p_business_id uuid';
  if position('%amazon%' in lower(d))=0
     or position('%walmart%' in lower(d))=0
     or position('%samsclub%' in lower(d))=0 then
    raise exception 'variable-sender reconciliation missing';
  end if;
end $$;

-- Objects, RLS, view mode, permissions.
do $$
declare nbad integer; opts text[];
begin
  if to_regclass('public.projects') is null
    or to_regclass('public.obligations') is null
    or to_regclass('public.obligation_sources') is null
    or to_regclass('public.obligation_dependencies') is null
    or to_regclass('public.obligation_events') is null
    or to_regclass('public.mcc_today') is null then
    raise exception 'MCC Phase 1 object missing';
  end if;

  select c.reloptions into opts from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='mcc_today';
  if opts is null or not ('security_invoker=true'=any(opts)) then
    raise exception 'mcc_today is not security_invoker';
  end if;

  select count(*) into nbad from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public'
     and c.relname in ('projects','obligations','obligation_sources','obligation_dependencies','obligation_events')
     and not c.relrowsecurity;
  if nbad<>0 then raise exception 'RLS missing on % MCC table(s)',nbad; end if;

  select count(*) into nbad from pg_policies
   where schemaname='public'
     and tablename in ('projects','obligations','obligation_sources','obligation_dependencies','obligation_events')
     and cmd<>'SELECT';
  if nbad<>0 then raise exception 'unexpected write RLS policy'; end if;

  if not has_table_privilege('authenticated','public.mcc_today','SELECT') then
    raise exception 'authenticated lacks mcc_today SELECT';
  end if;
  if has_table_privilege('anon','public.mcc_today','SELECT') then
    raise exception 'anon unexpectedly has mcc_today SELECT';
  end if;
end $$;

-- Local-only fixture users. Existing signup trigger creates profiles/default businesses.
insert into public.allowed_emails(email,note) values
 ('mcc-phase1-a@example.invalid','local integration test'),
 ('mcc-phase1-b@example.invalid','local integration test')
on conflict(email) do nothing;

insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
values
 ('10000000-0000-0000-0000-000000000001','mcc-phase1-a@example.invalid','{}','{}',now(),now()),
 ('10000000-0000-0000-0000-000000000002','mcc-phase1-b@example.invalid','{}','{}',now(),now())
on conflict(id) do nothing;

insert into public.projects(id,user_id,title,health,health_method,health_reason)
values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','A project','ON_TRACK','MANUAL','fixture'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','B project','ON_TRACK','MANUAL','fixture');

-- Constraint helpers: each inner statement must fail with CHECK violation.
do $$ begin
 begin
  insert into public.projects(user_id,title,health_method,health_reason,health_rule_version)
  values('10000000-0000-0000-0000-000000000001','bad manual','MANUAL','fixture','v1');
  raise exception 'manual health accepted hidden rule';
 exception when check_violation then null; end;
 begin
  insert into public.projects(user_id,title,health_method,health_reason)
  values('10000000-0000-0000-0000-000000000001','bad derived','DERIVED','fixture');
  raise exception 'derived health accepted without rule version';
 exception when check_violation then null; end;
 begin
  insert into public.obligations(user_id,project_id,type,title,state)
  values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','bad done','DONE');
  raise exception 'DONE accepted without completed_at';
 exception when check_violation then null; end;
 begin
  insert into public.obligations(user_id,project_id,type,title,state,completed_at)
  values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','bad cancel','CANCELLED',now());
  raise exception 'CANCELLED accepted completed_at';
 exception when check_violation then null; end;
 begin
  insert into public.obligations(user_id,project_id,type,title,state,waiting_on)
  values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','WAITING','blank wait','WAITING','   ');
  raise exception 'WAITING accepted blank waiting_on';
 exception when check_violation then null; end;
 begin
  insert into public.obligations(user_id,project_id,type,title,state,due_at)
  values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','DEADLINE','unpaired date','UPCOMING',now());
  raise exception 'due_at accepted without due_kind';
 exception when check_violation then null; end;
end $$;

insert into public.obligations(id,user_id,project_id,type,title,state,execution_owner,verification_state)
values
 ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','source fixture','UPCOMING','NICCI','VERIFIED');

do $$ begin
 begin
  insert into public.obligation_sources(user_id,obligation_id,source_system,source_ref,claim_scope,authoritative_claims)
  values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','TEST','x',
         array['booking.dates'],array['booking.payment']);
  raise exception 'authority accepted outside claim scope';
 exception when check_violation then null; end;
 begin
  insert into public.obligation_dependencies(user_id,obligation_id,depends_on_obligation_id)
  values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
  raise exception 'self-dependency accepted';
 exception when check_violation then null; end;
end $$;

-- Today: timestamp urgency overrides UPCOMING.
insert into public.obligations(
 id,user_id,project_id,type,title,state,risk_level,execution_owner,due_at,due_kind,verification_state
) values(
 '30000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001',
 '20000000-0000-0000-0000-000000000001','DEADLINE','imminent','UPCOMING','GREEN','NICCI',
 now()+interval '8 hours','HARD','VERIFIED'
);
do $$
declare s text;
begin
 select section into s from public.mcc_today where obligation_id='30000000-0000-0000-0000-000000000010';
 if s<>'NEEDS_YOU_NOW' then raise exception 'hard deadline classified %',s; end if;
end $$;

-- Dependency blocking wins over urgency, while critical_attention remains visible.
insert into public.obligations(id,user_id,project_id,type,title,state,execution_owner,verification_state)
values
 ('30000000-0000-0000-0000-000000000020','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','blocker','UPCOMING','NICCI','VERIFIED'),
 ('30000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','DEADLINE','blocked urgent','UPCOMING','NICCI','VERIFIED');
update public.obligations set due_at=now()+interval '2 hours',due_kind='HARD'
 where id='30000000-0000-0000-0000-000000000021';
insert into public.obligation_dependencies(user_id,obligation_id,depends_on_obligation_id)
values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000021','30000000-0000-0000-0000-000000000020');
do $$
declare s text; c boolean;
begin
 select section,critical_attention into s,c from public.mcc_today
  where obligation_id='30000000-0000-0000-0000-000000000021';
 if s<>'BLOCKED' or not c then raise exception 'blocked urgent classified % / %',s,c; end if;
end $$;

-- Deterministic recursive query detects a would-be dependency cycle before future writes.
insert into public.obligations(id,user_id,project_id,type,title,state,execution_owner,verification_state)
values
 ('30000000-0000-0000-0000-000000000030','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','cycle A','UPCOMING','NICCI','VERIFIED'),
 ('30000000-0000-0000-0000-000000000031','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ACTION','cycle B','UPCOMING','NICCI','VERIFIED');
insert into public.obligation_dependencies(user_id,obligation_id,depends_on_obligation_id)
values('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000030','30000000-0000-0000-0000-000000000031');
do $$
declare found_cycle boolean;
begin
 with recursive reach(id) as (
   select depends_on_obligation_id from public.obligation_dependencies
    where obligation_id='30000000-0000-0000-0000-000000000030'
   union
   select d.depends_on_obligation_id from public.obligation_dependencies d join reach r on d.obligation_id=r.id
 )
 select exists(select 1 from reach where id='30000000-0000-0000-0000-000000000030') into found_cycle;
 if found_cycle then raise exception 'fixture unexpectedly already cyclic'; end if;
 -- Future insertion B -> A would create a cycle because A already reaches B.
 with recursive reach(id) as (
   select depends_on_obligation_id from public.obligation_dependencies
    where obligation_id='30000000-0000-0000-0000-000000000030'
   union
   select d.depends_on_obligation_id from public.obligation_dependencies d join reach r on d.obligation_id=r.id
 )
 select exists(select 1 from reach where id='30000000-0000-0000-0000-000000000031') into found_cycle;
 if not found_cycle then raise exception 'cycle preflight failed to detect A reaches B'; end if;
end $$;

-- RLS and security_invoker isolation.
insert into public.obligations(id,user_id,project_id,type,title,state,execution_owner,verification_state)
values('30000000-0000-0000-0000-000000000099','10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000002','ACTION','B private','UPCOMING','NICCI','VERIFIED');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
do $$
declare n integer;
begin
 select count(*) into n from public.obligations where user_id='10000000-0000-0000-0000-000000000002';
 if n<>0 then raise exception 'base-table RLS leak'; end if;
 select count(*) into n from public.mcc_today where user_id='10000000-0000-0000-0000-000000000002';
 if n<>0 then raise exception 'mcc_today RLS leak'; end if;
 begin
  insert into public.obligations(user_id,type,title)
  values('10000000-0000-0000-0000-000000000001','ACTION','should fail');
  raise exception 'authenticated write unexpectedly succeeded';
 exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Regression: MCC objects never reference the historical message queue.
do $$
declare n integer;
begin
 select count(*) into n
 from pg_constraint c
 join pg_class child on child.oid=c.conrelid
 join pg_class parent on parent.oid=c.confrelid
 join pg_namespace ns on ns.oid=child.relnamespace
 where ns.nspname='public'
   and child.relname in ('projects','obligations','obligation_sources','obligation_dependencies','obligation_events')
   and parent.relname='queue_items';
 if n<>0 then raise exception 'MCC references historical queue_items'; end if;
end $$;

rollback;
