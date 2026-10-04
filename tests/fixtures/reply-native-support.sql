-- Validation-only support. No cron migration, external secrets, or HTTP tasks.
select pgmq.create('sync_jobs');select pgmq.create('triage_jobs');select pgmq.create('pipeline_jobs');select pgmq.create('digest_jobs');
create or replace function public.poke_worker(p_queue text) returns void language plpgsql as $$ begin return; end $$;
create or replace function public.enqueue_and_poke(p_queue text,p_msg jsonb) returns bigint language plpgsql security definer set search_path='' as $$ begin return pgmq.send(p_queue,p_msg);end $$;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
insert into public.allowed_emails(email) values('reply-owner@example.invalid'),('reply-other@example.invalid');

grant execute on function public.ingest_email_message(uuid,jsonb),public.ingest_twilio_message(uuid,jsonb) to service_role;
