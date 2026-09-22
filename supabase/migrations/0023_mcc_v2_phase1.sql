-- 0023_mcc_v2_phase1
-- Master Command Center v2 Phase 1.
-- Additive, application read-only, no historical queue import.
-- Repository sequence: 0022 reconciles clean-rebuild drift; this migration adds MCC v2.
-- NOT applied to production.

begin;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  title text not null check (length(btrim(title)) > 0),
  description text,
  state text not null default 'ACTIVE'
    check (state in ('ACTIVE','PAUSED','DONE','CANCELLED')),
  health text not null default 'ON_TRACK'
    check (health in ('ON_TRACK','NEEDS_ATTENTION','AT_RISK')),
  health_method text not null default 'MANUAL'
    check (health_method in ('MANUAL','DERIVED')),
  health_reason text not null check (length(btrim(health_reason)) > 0),
  health_rule_version text,
  health_source_system text,
  health_source_ref text,
  health_updated_at timestamptz not null default now(),
  priority integer not null default 0 check (priority between 0 and 100),
  next_milestone text,
  target_date timestamptz,
  source_system text,
  source_ref text,
  last_meaningful_change_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_derived_health_provenance check (
    health_method <> 'DERIVED'
    or (health_rule_version is not null and length(btrim(health_rule_version)) > 0)
  ),
  constraint projects_manual_health_no_hidden_rule check (
    health_method <> 'MANUAL' or health_rule_version is null
  ),
  constraint projects_health_source_pair check (
    (health_source_system is null and health_source_ref is null)
    or (health_source_system is not null and health_source_ref is not null)
  ),
  constraint projects_source_pair check (
    (source_system is null and source_ref is null)
    or (source_system is not null and source_ref is not null)
  ),
  unique (id,user_id)
);

create table public.obligations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  project_id uuid,
  business_id uuid references public.businesses(id) on delete set null,
  type text not null check (
    type in ('ACTION','WAITING','DEADLINE','DECISION','RISK','DISCREPANCY','PROMISE')
  ),
  title text not null check (length(btrim(title)) > 0),
  description text,
  state text not null default 'UPCOMING' check (
    state in ('NOW','TODAY','THIS_WEEK','UPCOMING','WAITING','BLOCKED','SOMEDAY','DONE','CANCELLED')
  ),
  priority integer not null default 0 check (priority between 0 and 100),
  risk_level text not null default 'GREEN'
    check (risk_level in ('RED','ORANGE','YELLOW','GREEN')),
  execution_owner text not null default 'NICCI'
    check (execution_owner in ('NICCI','CHATGPT','CHATGPT_PREP','OTHER','WAITING')),
  due_at timestamptz,
  due_kind text check (due_kind is null or due_kind in ('HARD','SOFT')),
  waiting_on text,
  waiting_since timestamptz,
  follow_up_at timestamptz,
  next_action text,
  verification_state text not null default 'UNVERIFIED' check (
    verification_state in ('VERIFIED','PARTIALLY_VERIFIED','UNVERIFIED','CONFLICT','STALE')
  ),
  freshness_expires_at timestamptz,
  blocked_reason text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint obligations_project_owner_fk
    foreign key (project_id,user_id)
    references public.projects(id,user_id)
    on delete set null (project_id),
  constraint obligations_due_kind_consistency check (
    (due_at is null and due_kind is null)
    or (due_at is not null and due_kind is not null)
  ),
  constraint obligations_waiting_requires_name check (
    state <> 'WAITING'
    or (waiting_on is not null and length(btrim(waiting_on)) > 0)
  ),
  constraint obligations_terminal_state_consistency check (
    (state='DONE' and completed_at is not null and cancelled_at is null)
    or
    (state='CANCELLED' and cancelled_at is not null and completed_at is null)
    or
    (state not in ('DONE','CANCELLED') and completed_at is null and cancelled_at is null)
  ),
  unique (id,user_id)
);

create table public.obligation_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  obligation_id uuid not null,
  source_system text not null check (length(btrim(source_system)) > 0),
  source_type text,
  source_ref text not null check (length(btrim(source_ref)) > 0),
  source_url text,
  source_timestamp timestamptz,
  content_hash text,
  claim_scope text[] not null default '{}',
  authoritative_claims text[] not null default '{}',
  evidence_role text not null default 'SUPPORTING'
    check (evidence_role in ('PRIMARY','SUPPORTING','CONTEXT')),
  created_at timestamptz not null default now(),
  constraint obligation_sources_owner_fk
    foreign key (obligation_id,user_id)
    references public.obligations(id,user_id)
    on delete cascade,
  constraint obligation_sources_authority_subset
    check (authoritative_claims <@ claim_scope),
  constraint obligation_sources_unique_link
    unique (obligation_id,source_system,source_ref)
);

create table public.obligation_dependencies (
  user_id uuid not null,
  obligation_id uuid not null,
  depends_on_obligation_id uuid not null,
  relationship text not null default 'BLOCKS'
    check (relationship='BLOCKS'),
  created_at timestamptz not null default now(),
  primary key (obligation_id,depends_on_obligation_id,relationship),
  constraint obligation_dependencies_owner_fk
    foreign key (obligation_id,user_id)
    references public.obligations(id,user_id)
    on delete cascade,
  constraint obligation_dependencies_dep_owner_fk
    foreign key (depends_on_obligation_id,user_id)
    references public.obligations(id,user_id)
    on delete cascade,
  constraint obligation_dependencies_no_self
    check (obligation_id <> depends_on_obligation_id)
);

create table public.obligation_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  obligation_id uuid not null,
  event_type text not null check (length(btrim(event_type)) > 0),
  actor_type text not null check (actor_type in ('NICCI','CHATGPT','SYSTEM','OTHER')),
  actor_ref text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  source_ref text,
  created_at timestamptz not null default now(),
  constraint obligation_events_owner_fk
    foreign key (obligation_id,user_id)
    references public.obligations(id,user_id)
    on delete cascade
);

create index projects_user_state_idx
  on public.projects(user_id,state,priority desc);
create index projects_active_health_idx
  on public.projects(user_id,health,priority desc) where state='ACTIVE';
create index projects_target_date_idx
  on public.projects(user_id,target_date)
  where state='ACTIVE' and target_date is not null;
create index projects_business_idx on public.projects(business_id);
create index projects_source_idx
  on public.projects(user_id,source_system,source_ref)
  where source_system is not null and source_ref is not null;
create index projects_health_freshness_idx
  on public.projects(user_id,health_updated_at) where state='ACTIVE';

create index obligations_user_state_idx
  on public.obligations(user_id,state,priority desc,updated_at desc);
create index obligations_active_priority_idx
  on public.obligations(user_id,risk_level,priority desc,due_at)
  where state not in ('DONE','CANCELLED');
create index obligations_due_idx
  on public.obligations(user_id,due_at,due_kind)
  where state not in ('DONE','CANCELLED') and due_at is not null;
create index obligations_hard_due_idx
  on public.obligations(user_id,due_at)
  where due_kind='HARD' and state not in ('DONE','CANCELLED');
create index obligations_follow_up_idx
  on public.obligations(user_id,follow_up_at)
  where state='WAITING' and follow_up_at is not null;
create index obligations_project_idx
  on public.obligations(project_id,user_id,state,priority desc);
create index obligations_business_idx
  on public.obligations(business_id,state);
create index obligations_execution_owner_idx
  on public.obligations(user_id,execution_owner,state)
  where state not in ('DONE','CANCELLED');
create index obligations_verification_idx
  on public.obligations(user_id,verification_state)
  where verification_state <> 'VERIFIED';
create index obligations_freshness_idx
  on public.obligations(user_id,freshness_expires_at)
  where freshness_expires_at is not null and state not in ('DONE','CANCELLED');

create index obligation_sources_user_idx
  on public.obligation_sources(user_id);
create index obligation_sources_obligation_owner_idx
  on public.obligation_sources(obligation_id,user_id);
create index obligation_sources_lookup_idx
  on public.obligation_sources(user_id,source_system,source_ref);
create index obligation_sources_content_hash_idx
  on public.obligation_sources(user_id,content_hash)
  where content_hash is not null;
create index obligation_sources_claim_scope_idx
  on public.obligation_sources using gin(claim_scope);
create index obligation_sources_authority_scope_idx
  on public.obligation_sources using gin(authoritative_claims);

create index obligation_dependencies_user_idx
  on public.obligation_dependencies(user_id);
create index obligation_dependencies_obligation_owner_idx
  on public.obligation_dependencies(obligation_id,user_id);
create index obligation_dependencies_depends_on_idx
  on public.obligation_dependencies(depends_on_obligation_id,user_id,obligation_id);

create index obligation_events_user_idx
  on public.obligation_events(user_id);
create index obligation_events_obligation_owner_idx
  on public.obligation_events(obligation_id,user_id);
create index obligation_events_obligation_time_idx
  on public.obligation_events(obligation_id,created_at desc);
create index obligation_events_type_time_idx
  on public.obligation_events(user_id,event_type,created_at desc);

alter table public.projects enable row level security;
alter table public.obligations enable row level security;
alter table public.obligation_sources enable row level security;
alter table public.obligation_dependencies enable row level security;
alter table public.obligation_events enable row level security;

revoke all on table
  public.projects,
  public.obligations,
  public.obligation_sources,
  public.obligation_dependencies,
  public.obligation_events
from public,anon,authenticated;

grant select on table
  public.projects,
  public.obligations,
  public.obligation_sources,
  public.obligation_dependencies,
  public.obligation_events
to authenticated;

create policy projects_select_own on public.projects
  for select to authenticated using ((select auth.uid())=user_id);
create policy obligations_select_own on public.obligations
  for select to authenticated using ((select auth.uid())=user_id);
create policy obligation_sources_select_own on public.obligation_sources
  for select to authenticated using ((select auth.uid())=user_id);
create policy obligation_dependencies_select_own on public.obligation_dependencies
  for select to authenticated using ((select auth.uid())=user_id);
create policy obligation_events_select_own on public.obligation_events
  for select to authenticated using ((select auth.uid())=user_id);

create view public.mcc_today
with (security_invoker=true)
as
with dependency_state as (
  select d.user_id,d.obligation_id,
         bool_or(blocker.state not in ('DONE','CANCELLED')) as has_open_dependency
  from public.obligation_dependencies d
  join public.obligations blocker
    on blocker.id=d.depends_on_obligation_id
   and blocker.user_id=d.user_id
  group by d.user_id,d.obligation_id
),
base as (
  select
    o.*,
    p.title as project_title,
    p.health as project_health,
    p.health_method as project_health_method,
    p.health_reason as project_health_reason,
    p.health_updated_at as project_health_updated_at,
    coalesce(ds.has_open_dependency,false) as has_open_dependency,
    (o.due_at is not null and o.due_at < now()) as is_overdue,
    (
      o.due_kind='HARD' and o.due_at is not null
      and o.due_at >= now()
      and o.due_at <= now()+interval '24 hours'
    ) as hard_due_within_24h,
    (
      o.due_at is not null and o.due_at >= now()
      and o.due_at <= now()+interval '24 hours'
    ) as due_within_24h,
    (
      o.due_at is not null and o.due_at > now()+interval '24 hours'
      and o.due_at <= now()+interval '3 days'
    ) as due_within_3d,
    (
      o.due_at is not null and o.due_at > now()+interval '3 days'
      and o.due_at <= now()+interval '7 days'
    ) as due_within_7d,
    (o.follow_up_at is not null and o.follow_up_at <= now()) as follow_up_due,
    (
      o.verification_state='STALE'
      or (o.freshness_expires_at is not null and o.freshness_expires_at <= now())
    ) as is_stale
  from public.obligations o
  left join public.projects p
    on p.id=o.project_id and p.user_id=o.user_id
  left join dependency_state ds
    on ds.user_id=o.user_id and ds.obligation_id=o.id
  where o.state not in ('DONE','CANCELLED')
),
scored as (
  select
    b.*,
    (
      b.risk_level='RED'
      or b.is_overdue
      or b.hard_due_within_24h
      or (b.follow_up_due and b.execution_owner='NICCI')
      or b.verification_state='CONFLICT'
    ) as critical_attention,
    b.priority
    + case b.risk_level
        when 'RED' then 1000 when 'ORANGE' then 500 when 'YELLOW' then 200 else 0
      end
    + case
        when b.due_kind='HARD' and b.is_overdue then 1200
        when b.hard_due_within_24h then 1000
        when b.due_kind='HARD' and b.due_within_3d then 500
        when b.due_kind='SOFT' and b.is_overdue then 600
        when b.due_kind='SOFT' and b.due_within_24h then 400
        when b.due_kind='SOFT' and b.due_within_3d then 250
        when b.due_kind='SOFT' and b.due_within_7d then 100
        else 0
      end
    + case when b.type='PROMISE' then 300 else 0 end
    + case when b.follow_up_due then 400 else 0 end
    + case b.verification_state
        when 'CONFLICT' then 700 when 'STALE' then 250 when 'UNVERIFIED' then 100 else 0
      end
    + case b.state
        when 'NOW' then 300 when 'TODAY' then 200 when 'THIS_WEEK' then 50 else 0
      end
    - case when b.has_open_dependency then 10000 else 0 end
      as effective_priority,
    array_remove(array[
      case when b.risk_level='RED' then 'RED risk' end,
      case when b.due_kind='HARD' and b.is_overdue then 'Hard deadline overdue' end,
      case when b.hard_due_within_24h then 'Hard deadline within 24 hours' end,
      case when b.due_kind='HARD' and b.due_within_3d then 'Hard deadline within 3 days' end,
      case when b.due_kind='SOFT' and b.is_overdue then 'Soft deadline overdue' end,
      case when b.follow_up_due then 'Follow-up due' end,
      case when b.type='PROMISE' then 'Outstanding promise' end,
      case when b.verification_state='CONFLICT' then 'Verification conflict' end,
      case when b.is_stale then 'Source/fact stale' end,
      case when b.has_open_dependency then 'Blocked by unresolved dependency' end,
      case when b.state='NOW' then 'Manually marked NOW' end,
      case when b.state='TODAY' then 'Manually marked TODAY' end
    ],null) as priority_reasons
  from base b
),
classified as (
  select
    s.*,
    case
      when s.state='WAITING' or s.execution_owner='WAITING'
        then 'WAITING_ON_OTHERS'
      when s.state='BLOCKED' or s.has_open_dependency
        then 'BLOCKED'
      when s.risk_level='RED'
        or s.is_overdue
        or s.hard_due_within_24h
        or (s.follow_up_due and s.execution_owner='NICCI')
        or s.verification_state='CONFLICT'
        then 'NEEDS_YOU_NOW'
      when s.state in ('NOW','TODAY')
        then 'NEEDS_YOU_NOW'
      when s.execution_owner in ('CHATGPT','CHATGPT_PREP')
        then 'CHATGPT_CAN_HANDLE'
      when s.execution_owner='NICCI'
        then 'NEXT'
      else 'SAFE_TO_DEFER'
    end as section
  from scored s
),
ranked as (
  select
    c.*,
    case c.section
      when 'NEEDS_YOU_NOW' then 1
      when 'NEXT' then 2
      when 'CHATGPT_CAN_HANDLE' then 3
      when 'WAITING_ON_OTHERS' then 4
      when 'BLOCKED' then 5
      else 6
    end as section_order,
    row_number() over (
      partition by c.user_id,c.section
      order by c.effective_priority desc,c.due_at asc nulls last,c.created_at asc,c.id asc
    ) as section_rank
  from classified c
)
select
  user_id,section,section_order,section_rank,effective_priority,priority_reasons,
  critical_attention,id as obligation_id,type,title,state,risk_level,execution_owner,
  due_at,due_kind,waiting_on,waiting_since,follow_up_at,next_action,verification_state,
  freshness_expires_at,project_id,project_title,project_health,project_health_method,
  project_health_reason,project_health_updated_at,business_id,is_overdue,
  hard_due_within_24h,due_within_24h,due_within_3d,due_within_7d,follow_up_due,
  is_stale,has_open_dependency,created_at,updated_at
from ranked;

revoke all on public.mcc_today from public,anon,authenticated;
grant select on public.mcc_today to authenticated;

commit;
