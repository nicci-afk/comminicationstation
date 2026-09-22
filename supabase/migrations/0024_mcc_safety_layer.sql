-- 0024_mcc_safety_layer
-- Additive safety-control and observability layer for MCC v2.
-- Defaults are fail-closed. Browser access is read-only.
-- NOT applied to production by this commit.

begin;

create table public.mcc_safety_controls (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  automation_database_writes_enabled boolean not null default false,
  automation_external_sends_enabled boolean not null default false,
  automation_booking_changes_enabled boolean not null default false,
  automation_financial_actions_enabled boolean not null default false,
  emergency_stop boolean not null default true,
  emergency_stop_reason text not null default 'Safety layer initialized fail-closed',
  last_reviewed_at timestamptz,
  last_reviewed_by text,
  updated_at timestamptz not null default now()
);

create table public.production_change_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  change_key text not null check (length(btrim(change_key)) > 0),
  action_class text not null check (action_class in ('RED')),
  target_system text not null check (length(btrim(target_system)) > 0),
  target_environment text not null check (length(btrim(target_environment)) > 0),
  requested_outcome text not null check (length(btrim(requested_outcome)) > 0),
  exact_change_ref text not null check (length(btrim(exact_change_ref)) > 0),
  expected_impact jsonb not null default '{}'::jsonb,
  preflight_state text not null check (preflight_state in ('PENDING','PASSED','FAILED','BLOCKED')),
  approval_state text not null check (approval_state in ('NOT_REQUIRED','PENDING','APPROVED','REVOKED')),
  approved_at timestamptz,
  approved_by text,
  execution_state text not null check (execution_state in ('NOT_STARTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
  executed_at timestamptz,
  actual_impact jsonb,
  verification_state text not null check (verification_state in ('PENDING','VERIFIED','PARTIALLY_VERIFIED','FAILED','UNKNOWN','CONFLICT')),
  verified_at timestamptz,
  recovery_ref text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,change_key),
  constraint production_change_approval_consistency check (
    (approval_state='APPROVED' and approved_at is not null and approved_by is not null)
    or (approval_state<>'APPROVED')
  )
);

alter table public.mcc_safety_controls enable row level security;
alter table public.production_change_receipts enable row level security;

revoke all on table public.mcc_safety_controls, public.production_change_receipts
from public, anon, authenticated;

grant select on table public.mcc_safety_controls, public.production_change_receipts
to authenticated;

create policy mcc_safety_controls_select_own on public.mcc_safety_controls
  for select to authenticated using ((select auth.uid())=user_id);

create policy production_change_receipts_select_own on public.production_change_receipts
  for select to authenticated using ((select auth.uid())=user_id);

insert into public.mcc_safety_controls (user_id)
select p.user_id from public.profiles p
on conflict (user_id) do nothing;

create view public.mcc_integrity_status
with (security_invoker=true)
as
with mine as (
  select (select auth.uid()) as user_id
),
counts as (
  select
    m.user_id,
    (select count(*) from public.obligations o where o.user_id=m.user_id and o.state not in ('DONE','CANCELLED')) as active_obligations,
    (select count(*) from public.obligations o where o.user_id=m.user_id and o.verification_state='CONFLICT' and o.state not in ('DONE','CANCELLED')) as conflicts,
    (select count(*) from public.obligations o where o.user_id=m.user_id and (
       o.verification_state='STALE'
       or (o.freshness_expires_at is not null and o.freshness_expires_at <= now())
     ) and o.state not in ('DONE','CANCELLED')) as stale_items,
    (select count(*)
       from public.obligations o
       left join public.obligation_sources s on s.obligation_id=o.id and s.user_id=o.user_id
      where o.user_id=m.user_id and s.id is null) as obligations_without_sources,
    (select count(*) from (
       select s.source_system,s.source_ref
       from public.obligation_sources s
       where s.user_id=m.user_id
       group by s.source_system,s.source_ref
       having count(*) > 1
     ) d) as duplicate_source_refs,
    (select count(*) from public.obligations o
      where o.user_id=m.user_id
        and (
          (o.state='WAITING' and (o.waiting_on is null or length(btrim(o.waiting_on))=0))
          or (o.state='DONE' and o.completed_at is null)
          or (o.state='CANCELLED' and o.cancelled_at is null)
        )) as invalid_state_rows,
    (select max(e.created_at) from public.obligation_events e where e.user_id=m.user_id) as last_audit_event_at
  from mine m
)
select
  c.*,
  sc.emergency_stop,
  sc.emergency_stop_reason,
  sc.automation_database_writes_enabled,
  sc.automation_external_sends_enabled,
  sc.automation_booking_changes_enabled,
  sc.automation_financial_actions_enabled,
  sc.last_reviewed_at,
  case
    when sc.user_id is null then 'UNKNOWN'
    when c.obligations_without_sources > 0
      or c.duplicate_source_refs > 0
      or c.invalid_state_rows > 0 then 'FAILED'
    when c.conflicts > 0 or c.stale_items > 0 then 'NEEDS_ATTENTION'
    else 'HEALTHY'
  end as integrity_state
from counts c
left join public.mcc_safety_controls sc on sc.user_id=c.user_id;

revoke all on public.mcc_integrity_status from public,anon,authenticated;
grant select on public.mcc_integrity_status to authenticated;

comment on table public.mcc_safety_controls is
  'Fail-closed automation kill switches. Browser is select-only; writes require controlled backend/admin path.';
comment on table public.production_change_receipts is
  'Human-readable audit receipts for RED production actions. Browser is select-only.';
comment on view public.mcc_integrity_status is
  'Read-only deterministic integrity and safety summary for the MCC Trust Center.';

commit;
