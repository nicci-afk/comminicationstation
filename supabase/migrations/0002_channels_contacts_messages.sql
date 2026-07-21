-- 0002: channel integrations (Gmail / Twilio), contacts, threads, messages,
-- raw webhook events.

-- ---------------------------------------------------------------- gmail

create table public.gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  email_address citext not null unique, -- global-unique: one mailbox belongs to one tenant
  status text not null default 'pending'
    check (status in ('pending', 'active', 'error', 'disconnected')),
  refresh_token_secret_id uuid,
  last_history_id bigint,
  watch_expiration timestamptz,
  backfill_done boolean not null default false,
  sync_locked_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.gmail_accounts enable row level security;
create policy gmail_accounts_select on public.gmail_accounts
  for select using (user_id = (select auth.uid()));
create policy gmail_accounts_delete on public.gmail_accounts
  for delete using (user_id = (select auth.uid()));
-- inserts/updates: service role (OAuth callback / sync workers) only.

-- OAuth CSRF states: deny-all, service role only.
create table public.oauth_states (
  state text primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  kind text not null default 'gmail',
  redirect_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table public.oauth_states enable row level security;

-- ---------------------------------------------------------------- twilio

create table public.twilio_numbers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  phone_e164 text not null unique,
  friendly_name text not null default '',
  sms_enabled boolean not null default true,
  wa_enabled boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'disabled')),
  created_at timestamptz not null default now()
);
alter table public.twilio_numbers enable row level security;
create policy twilio_numbers_select on public.twilio_numbers
  for select using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- contacts

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  display_name text not null default '',
  kind text not null default 'unknown'
    check (kind in ('human', 'automated', 'organization', 'unknown')),
  is_vip boolean not null default false,
  notes text not null default '',
  merged_into_contact_id uuid references public.contacts (id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index contacts_user_name on public.contacts (user_id, display_name);
create index contacts_user_seen on public.contacts (user_id, last_seen_at desc);
alter table public.contacts enable row level security;
create policy contacts_select on public.contacts
  for select using (user_id = (select auth.uid()));
create policy contacts_update on public.contacts
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.contact_channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel_type text not null check (channel_type in ('email', 'phone')),
  raw_value text not null,
  canonical_value text not null,
  created_at timestamptz not null default now(),
  unique (user_id, channel_type, canonical_value)
);
create index contact_channels_contact on public.contact_channels (contact_id);
alter table public.contact_channels enable row level security;
create policy contact_channels_select on public.contact_channels
  for select using (user_id = (select auth.uid()));

create table public.contact_business_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  relationship_context text not null default '',
  stakes_level text not null default 'medium'
    check (stakes_level in ('low', 'medium', 'high')),
  created_at timestamptz not null default now(),
  unique (contact_id, business_id)
);
alter table public.contact_business_links enable row level security;
create policy contact_business_links_all on public.contact_business_links
  for all using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- messaging

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  gmail_account_id uuid references public.gmail_accounts (id) on delete cascade,
  twilio_number_id uuid references public.twilio_numbers (id) on delete cascade,
  provider_thread_id text not null,
  subject text not null default '',
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index threads_gmail_unique on public.threads (gmail_account_id, provider_thread_id)
  where gmail_account_id is not null;
create unique index threads_twilio_unique on public.threads (twilio_number_id, provider_thread_id)
  where twilio_number_id is not null;
create index threads_user_recent on public.threads (user_id, last_message_at desc);
alter table public.threads enable row level security;
create policy threads_select on public.threads
  for select using (user_id = (select auth.uid()));

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  thread_id uuid not null references public.threads (id) on delete cascade,
  contact_id uuid references public.contacts (id),
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  provider text not null check (provider in ('gmail', 'twilio', 'manual')),
  gmail_account_id uuid references public.gmail_accounts (id) on delete cascade,
  twilio_number_id uuid references public.twilio_numbers (id) on delete cascade,
  provider_message_id text not null,
  rfc822_message_id text,
  in_reply_to text,
  references_ids text[] not null default '{}',
  from_name text not null default '',
  from_identifier text not null default '', -- canonical email or E.164 phone
  to_identifiers text[] not null default '{}',
  cc_identifiers text[] not null default '{}',
  subject text not null default '',
  snippet text not null default '',
  body_text text,
  sent_at timestamptz not null,
  labels text[] not null default '{}',
  is_unread boolean not null default false,
  headers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index messages_gmail_unique on public.messages (gmail_account_id, provider_message_id)
  where gmail_account_id is not null;
create unique index messages_twilio_unique on public.messages (provider, provider_message_id)
  where provider = 'twilio';
create index messages_thread on public.messages (thread_id, sent_at);
create index messages_user_rfc822 on public.messages (user_id, rfc822_message_id);
create index messages_user_in_reply_to on public.messages (user_id, in_reply_to);
create index messages_references_gin on public.messages using gin (references_ids);
alter table public.messages enable row level security;
create policy messages_select on public.messages
  for select using (user_id = (select auth.uid()));

-- Raw webhook payloads: deny-all. If tenant mapping ever fails, the raw
-- payload must not be readable by any user.
create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  dedupe_key text not null unique,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'error')),
  error text,
  created_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;
