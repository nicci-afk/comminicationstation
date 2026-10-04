-- Synthetic domain tables and ingest body for mutation-boundary tests.
-- This deliberately does not reproduce canonical ingest business rules.
create table public.gmail_accounts (
 id uuid primary key,user_id uuid not null,status text not null default 'active',
 last_history_id bigint,sync_locked_at timestamptz,last_sync_at timestamptz,last_error text,
 watch_expiration timestamptz,backfill_done boolean not null default true,
 refresh_token_secret_id uuid,has_send_scope boolean not null default false
);
create table public.threads (
 id uuid primary key default gen_random_uuid(),gmail_account_id uuid references public.gmail_accounts,
 provider_thread_id text not null,subject text,unique(gmail_account_id,provider_thread_id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(),gmail_account_id uuid references public.gmail_accounts,
 thread_id uuid not null references public.threads,provider_message_id text not null,
 payload jsonb,unique(gmail_account_id,provider_message_id)
);
create table public.queue_items (
 id uuid primary key default gen_random_uuid(),thread_id uuid not null references public.threads,
 state text not null default 'needs_attention',last_inbound_message_id uuid references public.messages,
 agentedge_relayed_at timestamptz
);
create table public.domain_effects (id bigint generated always as identity,kind text,account_id uuid);

-- Same first mutation as the exact fetched canonical function: thread upsert.
-- This is also copied under a legacy name to exercise already-loaded old code.
create function public.ingest_email_message(p_gmail_account_id uuid,p jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t uuid;m uuid;
begin
 perform 1 from public.gmail_accounts where id=p_gmail_account_id;
 insert into public.threads(gmail_account_id,provider_thread_id,subject)
 values(p_gmail_account_id,p->>'thread_provider_id',p->>'subject')
 on conflict(gmail_account_id,provider_thread_id) do update set subject=excluded.subject returning id into t;
 insert into public.domain_effects(kind,account_id) values('after_thread_boundary',p_gmail_account_id);
 insert into public.messages(gmail_account_id,thread_id,provider_message_id,payload)
 values(p_gmail_account_id,t,p->>'provider_message_id',p)
 on conflict(gmail_account_id,provider_message_id) do nothing returning id into m;
 if m is null then return jsonb_build_object('status','duplicate');end if;
 insert into public.queue_items(thread_id,last_inbound_message_id) values(t,m);
 return jsonb_build_object('status','ok','message_id',m);
end;
$$;
revoke all on function public.ingest_email_message(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ingest_email_message(uuid,jsonb) to service_role;
grant select,insert,update,delete on public.gmail_accounts,public.threads,public.messages,public.queue_items to service_role;
-- Real production is service-role only here too. The wrapper preserves intake.
create function public.enqueue_and_poke(p_queue text,p_msg jsonb) returns bigint
language plpgsql security definer set search_path=public as $$
declare id bigint;
begin id:=pgmq.send(p_queue,p_msg);return id;end;
$$;
revoke all on function public.enqueue_and_poke(text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_and_poke(text,jsonb) to service_role;
