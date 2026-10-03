-- LOCAL DISPOSABLE FIXTURE ONLY, not a production migration.
-- Actual PostgreSQL constraints, timestamptz CAS, bigint serialization, RLS and
-- PostgREST transactions are exercised. Queue scheduling and ingest business
-- rules are intentionally minimal; this is not full production-schema coverage.
-- The separately maintained AgentEdge fixture must use a different local DB.
begin;
create table public.gmail_accounts (
  id uuid primary key, user_id uuid not null, email_address text not null unique,
  status text not null default 'active', refresh_token_secret_id uuid,
  last_history_id bigint, watch_expiration timestamptz, backfill_done boolean not null default true,
  has_send_scope boolean not null default false, sync_locked_at timestamptz, last_sync_at timestamptz, last_error text
);
create table public.runtime_settings (key text primary key, value jsonb not null);
create table public.runtime_events (id bigint generated always as identity primary key, event text not null, payload jsonb);
create table public.runtime_jobs (
  msg_id bigint generated always as identity primary key, queue text not null default 'sync_jobs',
  read_ct int not null default 0, message jsonb not null, ready boolean not null default false,
  claimed boolean not null default false, acked boolean not null default false, dead_lettered boolean not null default false
);
create table public.threads (
  id uuid primary key default gen_random_uuid(), gmail_account_id uuid not null references public.gmail_accounts,
  provider_thread_id text not null, unique(gmail_account_id,provider_thread_id)
);
create table public.messages (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  gmail_account_id uuid not null references public.gmail_accounts, thread_id uuid not null references public.threads,
  provider_message_id text not null, payload jsonb not null,
  unique(gmail_account_id,provider_message_id)
);
create table public.queue_items (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, thread_id uuid not null unique references public.threads,
  state text not null default 'needs_attention', last_inbound_message_id uuid references public.messages
);
-- Keep every exposed table fail-closed. Only gmail_accounts has a user read
-- policy, used by the local auth smoke; fixture internals are service-only.
do $$ declare t text; begin
  foreach t in array array['gmail_accounts','runtime_settings','runtime_events','runtime_jobs','threads','messages','queue_items'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
create policy own_gmail_accounts on public.gmail_accounts for select to authenticated using (user_id = (select auth.uid()));
grant select on public.gmail_accounts to authenticated;
grant usage, select on all sequences in schema public to service_role;

create function public.runtime_setting(k text) returns jsonb language sql stable security invoker set search_path = '' as $$
  select value from public.runtime_settings where key=k
$$;
create function public.runtime_fault(k text, after_commit boolean) returns void language plpgsql security invoker set search_path = '' as $$
declare mode text := public.runtime_setting(k) #>> '{}';
begin
  if mode = 'before' and not after_commit then raise exception 'synthetic % precommit failure',k; end if;
  if mode = 'after' and after_commit then
    -- An HTTP error status does not roll back a successful SQL transaction.
    -- Native PostgREST returns the failed response; the persisted rows prove the
    -- worker cannot infer rollback from the client-side error alone.
    perform set_config('response.status','503',true);
    delete from public.runtime_settings where key=k;
    insert into public.runtime_events(event,payload) values ('committed_error',jsonb_build_object('boundary',k));
  end if;
end $$;
create function public.runtime_account_update() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.last_history_id is distinct from old.last_history_id then
    perform public.runtime_fault('checkpoint_failure',false);
    perform public.runtime_fault('checkpoint_failure',true);
  end if;
  insert into public.runtime_events(event,payload) values ('account_update',jsonb_build_object('old_history',old.last_history_id::text,'new_history',new.last_history_id::text,'old_lock',old.sync_locked_at,'new_lock',new.sync_locked_at));
  return new;
end $$;
create trigger runtime_account_audit before update on public.gmail_accounts for each row execute function public.runtime_account_update();
create function public.runtime_queue_update() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.state = 'suppressed' and old.state <> 'suppressed' then
    perform public.runtime_fault('suppression_failure',false);
    perform public.runtime_fault('suppression_failure',true);
    insert into public.runtime_events(event,payload) values ('suppressed',jsonb_build_object('message_id',new.last_inbound_message_id));
  end if;
  return new;
end $$;
create trigger runtime_queue_audit before update on public.queue_items for each row execute function public.runtime_queue_update();
create function public.get_app_config(p_key text) returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_key = 'google_client_id' then
    -- Race injection is a genuine SQL update in an earlier RPC transaction.
    if public.runtime_setting('baseline_race') is not null then
      update public.gmail_accounts set last_history_id = (public.runtime_setting('baseline_race') #>> '{}')::bigint
        where id = '00000000-0000-4000-8000-000000000001'::uuid;
      if not found then raise exception 'Missing baseline-race fixture account'; end if;
      delete from public.runtime_settings where key='baseline_race';
    end if;
    return '{"value":"mcc-fixture-client"}'::jsonb;
  end if;
  if p_key = 'google_client_secret_vault_id' then return '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'::jsonb; end if;
  if p_key = 'pubsub_topic' then return '{"value":"synthetic-local-topic"}'::jsonb; end if;
  raise exception 'Unexpected config: %',p_key;
end $$;
create function public.vault_read_secret(p_id uuid) returns text language plpgsql security invoker set search_path = '' as $$
begin
  if p_id not in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid) then raise exception 'Non-fixture vault request'; end if;
  return 'mcc-fixture-value';
end $$;
create function public.claim_jobs(p_queue text,p_n int,p_vt int) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare jobs jsonb;
begin
  if p_queue <> 'sync_jobs' then raise exception 'Unexpected queue: %',p_queue; end if;
  with picked as (select msg_id from public.runtime_jobs where queue=p_queue and ready and not claimed and not acked and not dead_lettered order by msg_id limit p_n for update skip locked),
  rows as (update public.runtime_jobs j set claimed=true,read_ct=read_ct+1 from picked p where j.msg_id=p.msg_id returning j.*)
  select coalesce(jsonb_agg(jsonb_build_object('msg_id',msg_id,'read_ct',read_ct,'message',message)),'[]'::jsonb) into jobs from rows;
  insert into public.runtime_events(event,payload) values ('claim_jobs',jsonb_build_object('jobs',jobs,'visibility_seconds',p_vt));
  return jobs;
end $$;
create function public.enqueue_and_poke(p_queue text,p_msg jsonb) returns bigint language plpgsql security invoker set search_path = '' as $$
declare result bigint;
begin
  if p_queue not in ('sync_jobs','triage_jobs') then raise exception 'Unexpected enqueue: %',p_queue; end if;
  perform public.runtime_fault('enqueue_'||p_queue,false);
  -- ready=false leaves the continuation for the next controlled invocation.
  insert into public.runtime_jobs(queue,message) values (p_queue,p_msg) returning msg_id into result;
  insert into public.runtime_events(event,payload) values ('enqueue',jsonb_build_object('queue',p_queue,'message',p_msg));
  perform public.runtime_fault('enqueue_'||p_queue,true);
  return result;
end $$;
create function public.ack_job(p_queue text,p_msg_id bigint) returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform public.runtime_fault('ack_failure',false);
  update public.runtime_jobs set acked=true where msg_id=p_msg_id and queue=p_queue;
  insert into public.runtime_events(event,payload) values ('ack_job',jsonb_build_object('msg_id',p_msg_id));
  perform public.runtime_fault('ack_failure',true);
end $$;
create function public.dead_letter_job(p_queue text,p_msg_id bigint,p_message jsonb,p_error text) returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.runtime_jobs set dead_lettered=true where msg_id=p_msg_id and queue=p_queue;
  insert into public.runtime_events(event,payload) values ('dead_letter_job',jsonb_build_object('msg_id',p_msg_id,'error',p_error));
end $$;
create function public.ingest_email_message(p_gmail_account_id uuid,p jsonb) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare acct public.gmail_accounts%rowtype; tid uuid; mid uuid; result jsonb;
begin
  select * into strict acct from public.gmail_accounts where id=p_gmail_account_id;
  if (public.runtime_setting('ingest_id') #>> '{}') is null or (public.runtime_setting('ingest_id') #>> '{}') = p->>'provider_message_id' then perform public.runtime_fault('ingest_failure',false); end if;
  insert into public.threads(gmail_account_id,provider_thread_id) values (acct.id,p->>'thread_provider_id') on conflict(gmail_account_id,provider_thread_id) do nothing;
  select id into strict tid from public.threads where gmail_account_id=acct.id and provider_thread_id=p->>'thread_provider_id';
  insert into public.messages(user_id,gmail_account_id,thread_id,provider_message_id,payload) values (acct.user_id,acct.id,tid,p->>'provider_message_id',p) on conflict(gmail_account_id,provider_message_id) do nothing returning id into mid;
  if mid is null then result := '{"status":"duplicate"}'::jsonb;
  else
    insert into public.queue_items(user_id,thread_id,last_inbound_message_id,state) values (acct.user_id,tid,mid,case when (p->>'backlog')::boolean then 'backlog' else 'needs_attention' end)
    on conflict(thread_id) do update set last_inbound_message_id=excluded.last_inbound_message_id,state=excluded.state;
    result := jsonb_build_object('status','ok','message_id',mid,'needs_model_triage',coalesce((public.runtime_setting('needs_triage') #>> '{}')::boolean,false));
  end if;
  insert into public.runtime_events(event,payload) values ('ingest',jsonb_build_object('provider_id',p->>'provider_message_id','status',result->>'status'));
  if public.runtime_setting('replacement_lock') is not null then
    update public.gmail_accounts set sync_locked_at=(public.runtime_setting('replacement_lock') #>> '{}')::timestamptz where id=acct.id;
    delete from public.runtime_settings where key='replacement_lock';
  end if;
  if public.runtime_setting('checkpoint_race') is not null then
    update public.gmail_accounts set last_history_id=(public.runtime_setting('checkpoint_race') #>> '{}')::bigint where id=acct.id;
    delete from public.runtime_settings where key='checkpoint_race';
  end if;
  if (public.runtime_setting('ingest_id') #>> '{}') is null or (public.runtime_setting('ingest_id') #>> '{}') = p->>'provider_message_id' then perform public.runtime_fault('ingest_failure',true); end if;
  if public.runtime_setting('unexpected_ingest') is not null then return '{"status":"unknown"}'::jsonb; end if;
  return result;
end $$;
-- Never add SECURITY DEFINER or broaden persistent privileges to make this pass.
-- Default PUBLIC EXECUTE is revoked for this explicit fixture function list.
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
    'runtime_setting','runtime_fault','runtime_account_update','runtime_queue_update','get_app_config','vault_read_secret','claim_jobs','enqueue_and_poke','ack_job','dead_letter_job','ingest_email_message'
  ) loop
    execute format('revoke all on function %s from public, anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
commit;
notify pgrst, 'reload schema';

-- Generation RPC protocol adapter ONLY. This runner preserves every checkpoint
-- failure assertion; the separate native runner exercises actual pgmq/fence SQL.
alter table public.runtime_jobs add column claim_token uuid;
create function public.claim_sync_jobs_v1(p_generation text,p_n int,p_vt int) returns jsonb language plpgsql security invoker set search_path='' as $$
declare jobs jsonb; result jsonb;begin
 if p_generation<>'gmail-sync-checkpoints-g1' then raise exception 'wrong generation';end if;
 jobs:=public.claim_jobs('sync_jobs',p_n,p_vt);
 update public.runtime_jobs set claim_token=gen_random_uuid() where msg_id in (select (j->>'msg_id')::bigint from jsonb_array_elements(jobs) j);
 select coalesce(jsonb_agg(j||jsonb_build_object('claim_token',r.claim_token,'attempt',r.read_ct)),'[]') into result from jsonb_array_elements(jobs) j join public.runtime_jobs r on r.msg_id=(j->>'msg_id')::bigint;return result;
end $$;
create function public.finish_sync_job_v1(p_generation text,p_msg_id bigint,p_claim_token uuid,p_error text default null) returns void language plpgsql security invoker set search_path='' as $$
declare j public.runtime_jobs%rowtype;begin
 select * into strict j from public.runtime_jobs where msg_id=p_msg_id for update;
 if p_generation<>'gmail-sync-checkpoints-g1' or j.claim_token is distinct from p_claim_token then raise exception 'ownership changed';end if;
 if p_error is null then perform public.ack_job('sync_jobs',p_msg_id);else perform public.dead_letter_job('sync_jobs',p_msg_id,j.message,p_error);end if;
end $$;
revoke all on function public.claim_sync_jobs_v1(text,int,int),public.finish_sync_job_v1(text,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_sync_jobs_v1(text,int,int),public.finish_sync_job_v1(text,bigint,uuid,text) to service_role;

notify pgrst, 'reload schema';
