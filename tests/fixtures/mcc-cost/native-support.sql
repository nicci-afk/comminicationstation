-- Disposable validation fixture only. Never apply to a linked/remote database.
select pgmq.create('sync_jobs');
select pgmq.create('triage_jobs');
select pgmq.create('pipeline_jobs');
select pgmq.create('digest_jobs');
create or replace function public.poke_worker(p_queue text) returns void language plpgsql as $$ begin return; end $$;
create or replace function public.get_user_secret(p_user uuid,p_kind text) returns text
language plpgsql security definer set search_path='' as $$ begin
 if p_user not in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') or p_kind <> 'anthropic_api_key' then
  raise exception 'Non-fixture secret request';
 end if;
 return 'mcc-synthetic-anthropic-key';
end $$;
revoke all on function public.get_user_secret(uuid,text) from public,anon,authenticated;
grant execute on function public.get_user_secret(uuid,text) to service_role;
-- Canary verifies the untouched containments reject before any AgentEdge secret.
create table public.mcc_safety_controls(user_id uuid primary key,emergency_stop boolean not null,
 automation_database_writes_enabled boolean not null);
alter table public.mcc_safety_controls enable row level security;
revoke all on public.mcc_safety_controls from public,anon,authenticated;
grant select on public.mcc_safety_controls to service_role;
