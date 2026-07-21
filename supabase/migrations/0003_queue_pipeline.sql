-- 0003: attention queue (state machine + audit), triage rules, sender cache,
-- pipeline runs/artifacts/strategies, interaction updates, digest log.

create table public.triage_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  rule_type text not null check (rule_type in
    ('from_email', 'from_domain', 'to_email', 'subject_contains')),
  pattern text not null,
  business_id uuid references public.businesses (id) on delete set null,
  category text check (category in (
    'needs_reply', 'fyi', 'promotion', 'expense', 'receipt', 'notification',
    'newsletter', 'scheduling', 'urgent', 'other'
  )),
  action text check (action in ('needs_attention', 'fyi', 'suppress')),
  priority_delta int not null default 0,
  mark_vip boolean not null default false,
  enabled boolean not null default true,
  source text not null default 'user' check (source in ('user', 'learned')),
  created_at timestamptz not null default now(),
  unique (user_id, rule_type, pattern)
);
alter table public.triage_rules enable row level security;
create policy triage_rules_all on public.triage_rules
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Cache of per-sender triage decisions so repeat senders never re-trigger a
-- model call. decided_by='user' entries (corrections) always win.
create table public.sender_triage_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  sender_key text not null, -- canonical email or E.164 phone
  business_id uuid references public.businesses (id) on delete set null,
  category text,
  needs_reply boolean,
  contact_kind text check (contact_kind in ('human', 'automated', 'organization', 'unknown')),
  decided_by text not null check (decided_by in ('rules', 'model', 'user')),
  updated_at timestamptz not null default now(),
  unique (user_id, sender_key)
);
alter table public.sender_triage_cache enable row level security;
create policy sender_cache_select on public.sender_triage_cache
  for select using (user_id = (select auth.uid()));
create policy sender_cache_update on public.sender_triage_cache
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and decided_by = 'user');

-- ---------------------------------------------------------------- queue

create table public.queue_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  contact_id uuid references public.contacts (id),
  business_id uuid references public.businesses (id) on delete set null,
  state text not null default 'new' check (state in (
    'new', 'needs_attention', 'fyi', 'suppressed', 'backlog',
    'snoozed', 'responded', 'dismissed', 'awaiting_reply'
  )),
  category text not null default 'other',
  priority int not null default 50,
  priority_reasons text[] not null default '{}',
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  title text not null default '',
  preview text not null default '',
  sender_name text not null default '',
  sender_identifier text not null default '',
  is_vip boolean not null default false,
  message_count int not null default 1,
  last_inbound_message_id uuid references public.messages (id),
  resolved_by_message_id uuid references public.messages (id),
  resolved_at timestamptz,
  snoozed_until timestamptz,
  sla_due_at timestamptz,
  waiting_since timestamptz not null default now(),
  follow_up_at timestamptz,
  escalated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live attention episode per thread.
create unique index queue_items_active_thread on public.queue_items (thread_id)
  where state in ('new', 'needs_attention', 'snoozed', 'awaiting_reply', 'backlog', 'fyi');
-- The hot query: today's list, stable order.
create index queue_items_hot on public.queue_items
  (user_id, priority desc, created_at desc)
  where state = 'needs_attention';
create index queue_items_user_state on public.queue_items (user_id, state, updated_at desc);
alter table public.queue_items enable row level security;
create policy queue_items_select on public.queue_items
  for select using (user_id = (select auth.uid()));
create policy queue_items_update on public.queue_items
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.queue_item_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  queue_item_id uuid not null references public.queue_items (id) on delete cascade,
  from_state text,
  to_state text not null,
  actor text not null check (actor in ('system', 'user')),
  reason text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index queue_item_events_item on public.queue_item_events (queue_item_id, created_at);
alter table public.queue_item_events enable row level security;
create policy queue_item_events_select on public.queue_item_events
  for select using (user_id = (select auth.uid()));

-- Audit every state transition regardless of who made it (user via RLS
-- update, or system via service role). auth.uid() present => user action.
create or replace function public.log_queue_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  if new.state is distinct from old.state then
    v_actor := case when auth.uid() is not null then 'user' else 'system' end;
    insert into public.queue_item_events
      (user_id, queue_item_id, from_state, to_state, actor, reason, evidence)
    values (
      new.user_id, new.id, old.state, new.state, v_actor,
      coalesce(current_setting('app.transition_reason', true), ''),
      coalesce(nullif(current_setting('app.transition_evidence', true), ''), '{}')::jsonb
    );
    new.updated_at := now();
    -- Follow-up loop: responding starts the awaiting-their-reply timer.
    if new.state = 'responded' and new.follow_up_at is null then
      new.follow_up_at := now() + interval '4 days';
    end if;
  end if;
  return new;
end;
$$;

create trigger queue_items_transition before update on public.queue_items
  for each row execute function public.log_queue_transition();

-- ---------------------------------------------------------------- pipeline

create table public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete set null,
  channel text not null default 'email',
  trigger_reason text not null default 'manual'
    check (trigger_reason in ('manual', 'drift', 're_analysis')),
  status text not null default 'queued' check (status in (
    'queued', 'stage1_running', 'stage1_done', 'stage2_running', 'stage2_done',
    'stage3_running', 'complete', 'qc_failed', 'error', 'cancelled'
  )),
  current_stage int not null default 1 check (current_stage between 1 and 3),
  analyze_request jsonb not null,
  error text,
  total_cost_usd numeric not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
-- Single-flight: one live run per contact, ever.
create unique index pipeline_runs_single_flight on public.pipeline_runs (contact_id)
  where status not in ('complete', 'qc_failed', 'error', 'cancelled');
create index pipeline_runs_user on public.pipeline_runs (user_id, created_at desc);
alter table public.pipeline_runs enable row level security;
create policy pipeline_runs_select on public.pipeline_runs
  for select using (user_id = (select auth.uid()));

-- Append-only stage artifacts: full input packet, full output, QC verdicts.
create table public.pipeline_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  run_id uuid not null references public.pipeline_runs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  stage int not null check (stage between 1 and 3),
  prompt_id text not null,
  input_schema_version text not null,
  output_schema_version text not null,
  input jsonb not null,
  output jsonb,
  provider text not null,
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric not null default 0,
  attempt int not null default 1,
  qc_passed boolean,
  qc_fail_reasons text[] not null default '{}',
  model_qc_status jsonb,
  allowed_zone text check (allowed_zone in ('green', 'yellow', 'red')),
  created_at timestamptz not null default now()
);
create index pipeline_artifacts_run on public.pipeline_artifacts (run_id, stage, attempt);
create index pipeline_artifacts_contact on public.pipeline_artifacts (contact_id, stage, created_at desc);
alter table public.pipeline_artifacts enable row level security;
create policy pipeline_artifacts_select on public.pipeline_artifacts
  for select using (user_id = (select auth.uid()));

-- The stored, reusable strategy per (contact, business, channel).
create table public.contact_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete set null,
  channel text not null default 'email',
  status text not null default 'active'
    check (status in ('active', 'stale', 'drift_flagged', 'superseded')),
  perplexity_artifact_id uuid references public.pipeline_artifacts (id),
  persona_artifact_id uuid references public.pipeline_artifacts (id),
  comm_artifact_id uuid references public.pipeline_artifacts (id),
  allowed_zone text not null default 'yellow'
    check (allowed_zone in ('green', 'yellow', 'red')),
  drift_status text not null default 'none'
    check (drift_status in ('none', 'possible', 'active', 'unresolved')),
  re_analysis_recommended boolean not null default false,
  re_analysis_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index contact_strategies_current on public.contact_strategies
  (contact_id, coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid), channel)
  where status <> 'superseded';
create index contact_strategies_user on public.contact_strategies (user_id, updated_at desc);
alter table public.contact_strategies enable row level security;
create policy contact_strategies_select on public.contact_strategies
  for select using (user_id = (select auth.uid()));

-- Append-only post_interaction_update_packet log (interaction_update_v1).
-- This is the ONLY mechanism that evolves a stored strategy between re-runs.
create table public.interaction_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  strategy_id uuid not null references public.contact_strategies (id) on delete cascade,
  queue_item_id uuid references public.queue_items (id) on delete set null,
  packet jsonb not null,
  authored_by text not null check (authored_by in ('user', 'model')),
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  constraint interaction_updates_packet_version
    check (packet ->> 'update_schema_version' = 'interaction_update_v1')
);
create index interaction_updates_strategy on public.interaction_updates (strategy_id, created_at desc);
alter table public.interaction_updates enable row level security;
create policy interaction_updates_select on public.interaction_updates
  for select using (user_id = (select auth.uid()));

create table public.reply_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  queue_item_id uuid not null references public.queue_items (id) on delete cascade,
  strategy_id uuid references public.contact_strategies (id) on delete set null,
  blueprint_name text not null default '',
  draft_text text not null,
  confidence text not null check (confidence in ('green', 'yellow')),
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);
create index reply_drafts_item on public.reply_drafts (queue_item_id, created_at desc);
alter table public.reply_drafts enable row level security;
create policy reply_drafts_select on public.reply_drafts
  for select using (user_id = (select auth.uid()));

create table public.digest_log (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  sent_on date not null,
  item_count int not null default 0,
  status text not null default 'sent' check (status in ('sent', 'skipped', 'error')),
  error text,
  created_at timestamptz not null default now(),
  primary key (user_id, sent_on)
);
alter table public.digest_log enable row level security;
create policy digest_log_select on public.digest_log
  for select using (user_id = (select auth.uid()));

-- Dead-letter record for poisoned jobs (worker moves them here).
create table public.jobs_dead (
  id bigint generated always as identity primary key,
  queue text not null,
  msg_id bigint not null,
  message jsonb not null,
  error text not null default '',
  created_at timestamptz not null default now()
);
alter table public.jobs_dead enable row level security;
-- deny-all: operational table, surfaced via get_jobs_health() only.
