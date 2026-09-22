-- MCC v2 Phase 2 seed preflight
-- READ-ONLY. This script intentionally contains no INSERT/UPDATE/DELETE/DDL.
-- It is safe to run against local or production as a verification query.

-- 1) Executive baseline counts.
select
  (select count(*) from public.projects) as projects,
  (select count(*) from public.obligations) as obligations,
  (select count(*) from public.obligation_sources) as obligation_sources,
  (select count(*) from public.obligation_dependencies) as obligation_dependencies,
  (select count(*) from public.obligation_events) as obligation_events;

-- 2) Detect obligations missing provenance.
select o.id, o.title
from public.obligations o
left join public.obligation_sources s
  on s.obligation_id = o.id and s.user_id = o.user_id
where s.id is null;

-- 3) Detect duplicate stable source references.
select user_id, source_system, source_ref, count(*) as duplicate_count
from public.obligation_sources
group by user_id, source_system, source_ref
having count(*) > 1;

-- 4) Detect invalid terminal-state timestamps.
select id, title, state, completed_at, cancelled_at
from public.obligations
where (state = 'DONE' and completed_at is null)
   or (state <> 'DONE' and completed_at is not null)
   or (state = 'CANCELLED' and cancelled_at is null)
   or (state <> 'CANCELLED' and cancelled_at is not null);

-- 5) Confirm historical queue records are not implicitly linked as executive work.
-- A queue_item source is allowed only when explicitly selected/verified.
select count(*) as queue_linked_obligations
from public.obligation_sources
where source_system = 'message_command_center'
  and source_type = 'queue_item';

-- Expected before the first approved seed:
-- projects=0, obligations=0, obligation_sources=0,
-- obligation_dependencies=0, obligation_events=0,
-- and all anomaly queries return zero rows/counts.
