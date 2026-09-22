-- 0014: AgentEdge sync log — tracks every record pushed to or imported from AgentEdge.
create table public.agentedge_sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  direction text not null check (direction in ('imported', 'pushed', 'approved', 'gap')),
  ae_table text not null,
  ae_id text,
  cc_queue_item_id uuid references public.queue_items(id) on delete set null,
  category text,
  status text not null default 'ok',
  notes text,
  created_at timestamptz not null default now()
);
alter table public.agentedge_sync_log enable row level security;
create policy agentedge_sync_log_select on public.agentedge_sync_log
  for select using (user_id = (select auth.uid()));
create index agentedge_sync_log_user on public.agentedge_sync_log (user_id, created_at desc);
