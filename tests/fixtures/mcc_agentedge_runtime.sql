-- Synthetic disposable database only. This file is never a production migration.
-- Deliberately permits NULL control booleans to test fail-closed decoding;
-- production uses NOT NULL booleans. RPCs and RLS below are test fixtures,
-- not a claim of full production migration/schema regression coverage.
create table public.mcc_safety_controls (
  user_id uuid primary key,
  emergency_stop boolean,
  automation_database_writes_enabled boolean
);
alter table public.mcc_safety_controls enable row level security;
create policy own_controls on public.mcc_safety_controls for select to authenticated using (user_id = auth.uid());
grant select on public.mcc_safety_controls to authenticated;
grant all on public.mcc_safety_controls to service_role;

create table public.runtime_events (id bigint generated always as identity primary key, event text not null, payload jsonb);
create table public.runtime_jobs (msg_id bigint primary key, read_ct int not null default 0, message jsonb not null, claimed boolean not null default false, acked boolean not null default false);
create table public.messages (id uuid primary key, user_id uuid not null, thread_id uuid, from_name text, from_identifier text, to_identifiers jsonb, subject text, snippet text, body_text text, headers jsonb, channel text, sent_at timestamptz);
create table public.businesses (id uuid primary key, user_id uuid, name text);
create table public.queue_items (id uuid primary key, user_id uuid, thread_id uuid, category text, state text, title text, preview text, priority int, sender_name text, sender_identifier text, created_at timestamptz default now(), agentedge_relayed_at timestamptz);
create table public.agentedge_sync_log (id bigint generated always as identity primary key, user_id uuid, direction text, ae_table text, ae_id text, cc_queue_item_id uuid, category text, status text, notes text);
grant all on public.runtime_events, public.runtime_jobs, public.messages, public.businesses, public.queue_items, public.agentedge_sync_log to service_role;
grant usage, select on all sequences in schema public to service_role;

create function public.get_user_secret(p_user uuid, p_kind text) returns text language plpgsql as $$
begin
  insert into public.runtime_events(event,payload) values ('get_user_secret',jsonb_build_object('user',p_user,'kind',p_kind));
  -- No real secret exists in this fixture. The ordinary triage SDK receives a
  -- deliberately invalid fake key; its complete response is intercepted.
  if p_kind = 'anthropic_api_key' then return 'local-fixture-not-a-real-api-key'; end if;
  raise exception 'Unexpected secret read: %', p_kind;
end $$;
create function public.check_spend(p_user uuid, p_purpose text, p_estimated_usd numeric) returns jsonb language plpgsql as $$
begin
  insert into public.runtime_events(event,payload) values ('check_spend',jsonb_build_object('purpose',p_purpose));
  return '{"allowed":true,"reason":"local fixture"}'::jsonb;
end $$;
create function public.claim_jobs(p_queue text, p_n int, p_vt int) returns jsonb language plpgsql as $$
declare jobs jsonb;
begin
  with picked as (select msg_id from public.runtime_jobs where not claimed and not acked order by msg_id limit p_n for update skip locked),
  claimed_rows as (update public.runtime_jobs j set claimed = true, read_ct = read_ct + 1 from picked p where j.msg_id = p.msg_id returning j.*)
  select coalesce(jsonb_agg(jsonb_build_object('msg_id',msg_id,'read_ct',read_ct,'message',message)), '[]'::jsonb) into jobs from claimed_rows;
  insert into public.runtime_events(event,payload) values ('claim_jobs',jsonb_build_object('queue',p_queue));
  return jobs;
end $$;
create function public.apply_model_triage(p_message_id uuid, p jsonb) returns void language plpgsql as $$
begin
  insert into public.runtime_events(event,payload) values ('apply_model_triage',jsonb_build_object('message_id',p_message_id,'decision',p));
  update public.queue_items set category = p->>'category', priority = (p->>'priority')::int where thread_id = (select thread_id from public.messages where id = p_message_id);
end $$;
create function public.record_spend(p_user uuid, p_provider text, p_model text, p_purpose text, p_tokens_in int, p_tokens_out int, p_cost numeric, p_ref_type text, p_ref uuid) returns void language plpgsql as $$
begin insert into public.runtime_events(event,payload) values ('record_spend',jsonb_build_object('purpose',p_purpose,'tokens_in',p_tokens_in,'tokens_out',p_tokens_out,'cost',p_cost,'ref',p_ref)); end $$;
create function public.ack_job(p_queue text, p_msg_id bigint) returns void language plpgsql as $$
begin
  update public.runtime_jobs set acked = true where msg_id = p_msg_id;
  insert into public.runtime_events(event,payload) values ('ack_job',jsonb_build_object('queue',p_queue,'msg_id',p_msg_id));
end $$;
create function public.dead_letter_job(p_queue text,p_msg_id bigint,p_message jsonb,p_error text) returns void language plpgsql as $$
begin insert into public.runtime_events(event,payload) values ('dead_letter_job',jsonb_build_object('error',p_error)); end $$;
grant execute on all functions in schema public to service_role;
notify pgrst, 'reload schema';
