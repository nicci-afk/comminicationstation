-- 0001_core: extensions, tenancy, auth allowlist, businesses, spend controls.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgmq;

-- ---------------------------------------------------------------- tenancy

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email citext not null unique,
  display_name text not null default '',
  timezone text not null default 'America/Chicago',
  digest_hour int not null default 7 check (digest_hour between 0 and 23),
  digest_enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy profiles_select on public.profiles
  for select using (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Invite-only: signups are rejected unless the email is allowlisted.
create table public.allowed_emails (
  email citext primary key,
  note text,
  created_at timestamptz not null default now()
);
alter table public.allowed_emails enable row level security;
-- deny-all: no policies. Service role only.

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  name text not null,
  color text not null default '#6366f1',
  priority_weight int not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.businesses enable row level security;
create policy businesses_all on public.businesses
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.spend_caps (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  monthly_cap_usd numeric not null default 25,
  pipeline_monthly_cap_usd numeric not null default 15,
  triage_daily_call_cap int not null default 300,
  updated_at timestamptz not null default now()
);
alter table public.spend_caps enable row level security;
create policy spend_caps_select on public.spend_caps
  for select using (user_id = (select auth.uid()));
create policy spend_caps_update on public.spend_caps
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.ai_spend_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  occurred_at timestamptz not null default now(),
  provider text not null,
  model text not null,
  purpose text not null check (purpose in (
    'triage', 'pipeline_stage1', 'pipeline_stage2', 'pipeline_stage3',
    'draft', 'interaction_update'
  )),
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric not null default 0,
  ref_type text,
  ref_id uuid
);
create index ai_spend_ledger_user_time on public.ai_spend_ledger (user_id, occurred_at desc);
alter table public.ai_spend_ledger enable row level security;
create policy ai_spend_ledger_select on public.ai_spend_ledger
  for select using (user_id = (select auth.uid()));
-- inserts: service role only.

-- Household-level configuration (Google OAuth client, Pub/Sub topic, worker
-- URLs, Resend key reference). Deny-all RLS; accessed via service role and
-- SECURITY DEFINER helpers only.
create table public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

-- Per-user integration secrets: the row stores only a Vault pointer, never
-- the secret. Users can see WHICH integrations are configured, not the values.
create table public.user_secrets (
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  kind text not null check (kind in (
    'perplexity_api_key', 'openai_api_key', 'anthropic_api_key',
    'twilio_account_sid', 'twilio_auth_token'
  )),
  vault_secret_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.user_secrets enable row level security;
create policy user_secrets_select on public.user_secrets
  for select using (user_id = (select auth.uid()));
-- writes go through set_user_secret() / service role only.

-- ------------------------------------------------- signup gate + bootstrap

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.allowed_emails a where a.email = new.email) then
    raise exception 'signup not allowed for %', new.email
      using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));

  insert into public.businesses (user_id, name, color, is_default)
  values (new.id, 'Personal / Uncategorized', '#94a3b8', true);

  insert into public.spend_caps (user_id) values (new.id);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
