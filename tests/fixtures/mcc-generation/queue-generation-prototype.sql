-- LOCAL PROTOTYPE ONLY. This is not a deployable migration.
-- A strict legacy account/ingest/suppression write fence is still required.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';

create schema mcc_sync_internal;
revoke all on schema mcc_sync_internal from public, anon, authenticated, service_role;

create table mcc_sync_internal.control (
  singleton boolean primary key default true check (singleton),
  generation text not null check (generation <> ''),
  enabled boolean not null default false,
  legacy_claim_cutoff timestamptz not null,
  activated_at timestamptz
);
create table mcc_sync_internal.claims (
  msg_id bigint primary key,
  generation text not null,
  claim_token uuid not null,
  read_ct integer not null,
  attempt integer not null check (attempt > 0),
  claimed_at timestamptz not null
);
alter table mcc_sync_internal.control enable row level security;
alter table mcc_sync_internal.claims enable row level security;
revoke all on all tables in schema mcc_sync_internal from public, anon, authenticated, service_role;

-- Held until transaction completion, so a pause cannot commit while a
-- permitted queue mutation is still uncommitted. No caller-supplied tenant.
create function mcc_sync_internal.require_generation(p_generation text)
returns void language plpgsql security definer set search_path = '' as $$
declare v mcc_sync_internal.control%rowtype;
begin
  select * into v from mcc_sync_internal.control where singleton for share;
  if not found or not v.enabled or p_generation is distinct from v.generation then
    raise exception 'sync generation is paused or obsolete' using errcode = '55000';
  end if;
end;
$$;

create function mcc_sync_internal.guard_queue_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform mcc_sync_internal.require_generation(
    nullif(current_setting('app.mcc_sync_generation', true), '')
  );
  return null; -- statement trigger; never filters a row silently
end;
$$;
create function mcc_sync_internal.guard_dead_letter()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.queue = 'sync_jobs' then
    perform mcc_sync_internal.require_generation(
      nullif(current_setting('app.mcc_sync_generation', true), '')
    );
  end if;
  return new;
end;
$$;

-- Serialize installation with old claims/deletions and old dead-letter INSERTs.
-- The operator must fail on lock timeout rather than cancel other sessions.
-- Once these locks are held, every successful legacy claim committed earlier.
lock table public.jobs_dead in share row exclusive mode;
lock table pgmq.q_sync_jobs in access exclusive mode;
insert into mcc_sync_internal.control(singleton,generation,legacy_claim_cutoff)
values (true, 'gmail-sync-checkpoints-g1', clock_timestamp());

-- Queue-table guards also cover a pre-existing/cached legacy function body
-- that reaches pgmq.read/delete after this transaction commits.
create trigger mcc_sync_queue_generation
before update or delete on pgmq.q_sync_jobs for each statement
execute function mcc_sync_internal.guard_queue_mutation();
create trigger mcc_sync_dead_letter_generation
before insert on public.jobs_dead for each row
execute function mcc_sync_internal.guard_dead_letter();

-- Same signature and unchanged ACL/owner. Every other queue is untouched.
create or replace function public.claim_jobs(p_queue text, p_n integer, p_vt integer)
returns table(msg_id bigint, read_ct integer, message jsonb)
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_queue = 'sync_jobs' then return; end if;
  return query select m.msg_id, m.read_ct, m.message from pgmq.read(p_queue,p_vt,p_n) m;
end;
$$;

-- Separate RPC rather than an overload: no ambiguous PostgREST dispatch and
-- no fallback when the migration is absent. Only this generation can claim.
create function public.claim_sync_jobs_v1(p_generation text, p_n integer, p_vt integer)
returns table(msg_id bigint, read_ct integer, message jsonb, claim_token uuid, attempt integer)
language plpgsql security definer set search_path = '' as $$
declare
  v mcc_sync_internal.control%rowtype;
  m record;
  c mcc_sync_internal.claims%rowtype;
begin
  if p_n is null or p_n not between 1 and 3 or p_vt is distinct from 150 then
    raise exception 'invalid sync claim bounds' using errcode='22023';
  end if;
  select * into v from mcc_sync_internal.control where singleton for share;
  if not found then raise exception 'sync generation control missing' using errcode='55000'; end if;
  if p_generation is distinct from v.generation or not v.enabled then return; end if;
  perform set_config('app.mcc_sync_generation', p_generation, true);
  for m in select * from pgmq.read('sync_jobs',p_vt,p_n) loop
    insert into mcc_sync_internal.claims as old
      (msg_id,generation,claim_token,read_ct,attempt,claimed_at)
    values (m.msg_id,p_generation,gen_random_uuid(),m.read_ct,1,clock_timestamp())
    on conflict on constraint claims_pkey do update set
      generation=excluded.generation,
      claim_token=excluded.claim_token,
      read_ct=excluded.read_ct,
      attempt=case when old.generation=excluded.generation then old.attempt+1 else 1 end,
      claimed_at=excluded.claimed_at
    returning * into c;
    msg_id := m.msg_id; read_ct := m.read_ct; message := m.message;
    claim_token := c.claim_token; attempt := c.attempt;
    return next;
  end loop;
end;
$$;

-- Token + read count fence against a lease redelivery, even in the same
-- generation. The payload for dead letters is loaded from durable storage.
create function public.finish_sync_job_v1(
  p_generation text, p_msg_id bigint, p_claim_token uuid, p_error text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare q pgmq.q_sync_jobs%rowtype; c mcc_sync_internal.claims%rowtype;
begin
  perform mcc_sync_internal.require_generation(p_generation);
  -- Queue row before receipt: same lock order as claim_sync_jobs_v1.
  select * into q from pgmq.q_sync_jobs where msg_id=p_msg_id for update;
  if not found then raise exception 'sync job no longer owned' using errcode='55000'; end if;
  select * into c from mcc_sync_internal.claims where msg_id=p_msg_id for update;
  if not found or c.generation is distinct from p_generation
      or c.claim_token is distinct from p_claim_token or c.read_ct <> q.read_ct then
    raise exception 'sync job claim changed' using errcode='55000';
  end if;
  perform set_config('app.mcc_sync_generation', p_generation, true);
  if p_error is not null then
    if c.attempt <= 4 then raise exception 'sync retry limit not reached' using errcode='55000'; end if;
    insert into public.jobs_dead(queue,msg_id,message,error)
    values ('sync_jobs',q.msg_id,q.message,left(p_error,2000));
  end if;
  perform pgmq.delete('sync_jobs',p_msg_id);
  delete from mcc_sync_internal.claims where msg_id=p_msg_id;
end;
$$;

revoke all on all functions in schema mcc_sync_internal from public, anon, authenticated, service_role;
revoke all on function public.claim_sync_jobs_v1(text,integer,integer) from public, anon, authenticated;
revoke all on function public.finish_sync_job_v1(text,bigint,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_sync_jobs_v1(text,integer,integer) to service_role;
grant execute on function public.finish_sync_job_v1(text,bigint,uuid,text) to service_role;
commit;

-- There is deliberately NO activation statement here. Local tests activate
-- synthetic state only. Production remains paused unless an independently
-- reviewed activation operation verifies the drain and late-write fences.
