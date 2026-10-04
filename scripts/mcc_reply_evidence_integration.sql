-- LOCAL REVIEW PROPOSAL ONLY. Not a numbered/deployed migration.
-- Supabase CLI is unavailable here; create the canonical migration with the CLI after review.
begin;
create table public.reply_context_state (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(user_id),
 queue_item_id uuid not null references public.queue_items(id), thread_id uuid not null references public.threads(id),
 contact_id uuid not null references public.contacts(id), business_id uuid not null references public.businesses(id),
 evidence_revision bigint not null default 1, updated_at timestamptz not null default now(),
 unique(queue_item_id,user_id), unique(id,user_id)
);
alter table public.reply_drafts add column revision bigint not null default 1;
alter table public.reply_drafts add column updated_at timestamptz not null default now();
alter table public.reply_drafts add column reply_context_id uuid;
alter table public.reply_drafts add column reply_claims jsonb not null default '[]';
alter table public.reply_drafts add constraint reply_drafts_owner_unique unique(id,user_id);
alter table public.reply_drafts add constraint reply_drafts_context_owner foreign key(reply_context_id,user_id) references public.reply_context_state(id,user_id);
create table public.reply_fact_evidence (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, context_id uuid not null,
 message_id uuid not null references public.messages(id), kind text not null check(kind in('price','date','commitment')),
 fact_key text not null check(length(fact_key) between 1 and 300), value text not null check(length(value) between 1 and 1000),
 source_hash text not null, source_date timestamptz not null, excerpt text not null,
 verified_by uuid not null, verified_at timestamptz not null default now(), valid_until timestamptz not null,
 revoked boolean not null default false, supersedes uuid[] not null default '{}',
 check(verified_by=user_id), check(valid_until>verified_at), unique(id,user_id),
 foreign key(context_id,user_id) references public.reply_context_state(id,user_id)
);
create table public.reply_checks (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, draft_id uuid not null,
 draft_revision bigint not null, context_id uuid not null, evidence_revision bigint not null,
 state_snapshot jsonb not null, result jsonb not null, expires_at timestamptz not null,
 created_at timestamptz not null default now(), coverage_reviewed_at timestamptz,
 unique(id,user_id), foreign key(draft_id,user_id) references public.reply_drafts(id,user_id),
 foreign key(context_id,user_id) references public.reply_context_state(id,user_id)
);
create table public.reply_approvals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, check_id uuid not null,
 approved_at timestamptz not null default now(), expires_at timestamptz not null,
 consumed_at timestamptz, revoked_at timestamptz, unique(id,user_id),
 foreign key(check_id,user_id) references public.reply_checks(id,user_id)
);
create table public.reply_dispatches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, approval_id uuid not null unique,
 check_id uuid not null, payload jsonb not null,
 status text not null default 'RESERVED' check(status in('RESERVED','SENDING','SENT','FAILED','UNKNOWN','CANCELLED')),
 provider_id text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 ingestion_pending boolean not null default false,
 foreign key(approval_id,user_id) references public.reply_approvals(id,user_id),
 foreign key(check_id,user_id) references public.reply_checks(id,user_id)
);
create unique index reply_one_dispatch_per_draft_revision on public.reply_dispatches((payload->>'id'),(payload->>'revision'));
create index reply_context_thread on public.reply_context_state(thread_id,user_id);
create index reply_evidence_context on public.reply_fact_evidence(context_id,user_id,fact_key);
create index reply_evidence_message on public.reply_fact_evidence(message_id,user_id);
create index reply_checks_draft on public.reply_checks(draft_id,user_id,created_at desc);

-- All new browser writes are denied. Internal tables are available through projected API reads only.
do $$ declare t text; begin
 foreach t in array array['reply_context_state','reply_fact_evidence','reply_checks','reply_approvals','reply_dispatches'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update on public.%I to service_role',t);
 end loop;
end $$;

-- Source writes lock thread first, then context; no queue/receipt/control locks are introduced.
-- SECURITY INVOKER: no new privilege escalation. Existing service-role ingestion can update contexts.
create function public.mcc_reply_invalidate_source() returns trigger language plpgsql security invoker set search_path='' as $$
declare tid uuid; begin
 if TG_TABLE_NAME='messages' then
  for tid in select distinct t from unnest(array[case when TG_OP<>'INSERT' then OLD.thread_id end,case when TG_OP<>'DELETE' then NEW.thread_id end]) t where t is not null order by t loop
   perform 1 from public.threads where id=tid for update;
   update public.reply_context_state set evidence_revision=evidence_revision+1,updated_at=clock_timestamp() where thread_id=tid;
  end loop;
 else
  -- queue_items is also browser-writable under its existing owner policy. Do not add privileges
  -- to that write path; exact live scope/recipient comparison in snapshot RPC handles its changes.
  raise exception 'unsupported reply invalidation source';
 end if;
 return case when TG_OP='DELETE' then OLD else NEW end;
end $$;
create trigger mcc_reply_messages_invalidate before insert or update of body_text,contact_id,thread_id,gmail_account_id,twilio_number_id,provider,provider_message_id,channel,sent_at,from_identifier,to_identifiers,cc_identifiers,headers,direction,subject,rfc822_message_id,references_ids or delete on public.messages
 for each row execute function public.mcc_reply_invalidate_source();

create function public.mcc_reply_evidence_change() returns trigger language plpgsql security invoker set search_path='' as $$
declare c public.reply_context_state; begin
 select * into c from public.reply_context_state where id=case when TG_OP='DELETE' then OLD.context_id else NEW.context_id end;
 if not found then raise exception 'reply evidence context missing'; end if;
 perform 1 from public.threads where id=c.thread_id and user_id=c.user_id for update;
 if TG_OP='DELETE' then raise exception 'reply evidence deletion is not supported'; end if;
 if TG_OP='UPDATE' and (to_jsonb(NEW)-'revoked' is distinct from to_jsonb(OLD)-'revoked' or OLD.revoked or not NEW.revoked) then raise exception 'reply evidence content is immutable'; end if;
 if NEW.user_id<>c.user_id then raise exception 'reply evidence source scope mismatch'; end if;
 -- The same source projection defines eligibility for both snapshots and inserts.
 -- Revocation must remain possible after a source is moved or invalidated.
 if TG_OP='INSERT' and not exists(select 1 from jsonb_array_elements(public.mcc_reply_state(c.user_id,
   (select id from public.reply_drafts where reply_context_id=c.id and user_id=c.user_id order by updated_at desc,id limit 1))->'sources') source
   where source->>'id'=NEW.message_id::text and source->>'contactId'=c.contact_id::text)
 then raise exception 'reply evidence source scope mismatch'; end if;
 update public.reply_context_state set evidence_revision=evidence_revision+1,updated_at=clock_timestamp() where id=c.id;
 return NEW;
end $$;
create trigger mcc_reply_evidence_changed before insert or update or delete on public.reply_fact_evidence for each row execute function public.mcc_reply_evidence_change();
revoke all on function public.mcc_reply_evidence_change() from public,anon,authenticated;
grant execute on function public.mcc_reply_evidence_change() to service_role;

-- Lock and load one complete server-owned state. Nothing from the browser can declare authority.
create function public.mcc_reply_state(p_actor uuid,p_draft uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.reply_drafts; c public.reply_context_state; q public.queue_items; t public.threads;
 a record; n record; inbound record; msgs jsonb; ev jsonb; envelope jsonb; transport jsonb; complete boolean;
begin
 select * into d from public.reply_drafts where id=p_draft and user_id=p_actor;
 if not found or d.reply_context_id is null then raise exception 'reply draft not found'; end if;
 select * into t from public.threads where id=(select thread_id from public.reply_context_state where id=d.reply_context_id and user_id=p_actor) and user_id=p_actor for update;
 if not found then raise exception 'reply thread not found'; end if;
 select * into c from public.reply_context_state where id=d.reply_context_id and user_id=p_actor for update;
 select * into d from public.reply_drafts where id=p_draft and user_id=p_actor for update;
 select * into q from public.queue_items where id=c.queue_item_id and user_id=p_actor for share;
 if not found or q.thread_id<>c.thread_id or q.contact_id is distinct from c.contact_id or q.business_id is distinct from c.business_id
  or q.channel<>t.channel or not exists(select 1 from public.contacts where id=c.contact_id and user_id=p_actor)
  or not exists(select 1 from public.businesses where id=c.business_id and user_id=p_actor) then raise exception 'reply scope changed or unresolved'; end if;
 select * into inbound from public.messages where thread_id=t.id and user_id=p_actor and direction='inbound' order by sent_at desc,id desc limit 1;
 if not found then raise exception 'reply inbound source missing'; end if;
 if coalesce(inbound.rfc822_message_id,'') ~ '[\r\n]' or exists(select 1 from unnest(inbound.references_ids) r where r ~ '[\r\n]') or q.sender_identifier ~ '[\r\n]' or q.title ~ '[\r\n]' or coalesce(inbound.subject,'') ~ '[\r\n]' then raise exception 'invalid reply headers'; end if;
 if t.channel='email' then
  select * into a from public.gmail_accounts where id=t.gmail_account_id and user_id=p_actor;
  if not found or not a.has_send_scope or a.status<>'active' or a.email_address::text ~ '[\r\n]' then raise exception 'reply account not sendable'; end if;
  if lower(q.sender_identifier)<>lower(inbound.from_identifier) or q.sender_identifier !~ '^[^[:space:]<>@,;]+@[^[:space:]<>@,;]+\.[^[:space:]<>@,;]+$' then raise exception 'reply recipient mismatch'; end if;
  transport=jsonb_build_object('from',a.email_address::text,'to',q.sender_identifier,'subject','Re: '||regexp_replace(coalesce(nullif(inbound.subject,''),nullif(q.title,''),'(no subject)'),'^(Re:\s*)+','','i'),
   'providerThreadId',t.provider_thread_id,'inReplyTo',inbound.rfc822_message_id,'references',to_jsonb(inbound.references_ids));
 else
  select * into n from public.twilio_numbers where id=t.twilio_number_id and user_id=p_actor;
  if not found or n.status<>'active' then raise exception 'reply number not active'; end if;
  if q.sender_identifier !~ '^\+[1-9][0-9]{6,14}$' or split_part(t.provider_thread_id,':',2)<>q.sender_identifier then raise exception 'reply recipient mismatch'; end if;
  transport=jsonb_build_object('from',n.phone_e164,'to',q.sender_identifier,'lastInboundAt',inbound.sent_at);
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'contactId',c.contact_id,'direction',m.direction,'bodyMissing',m.body_text is null,'text',case when length(m.body_text) between 1 and 30000 then m.body_text else null end,'sentAt',m.sent_at,
  'hash',encode(sha256(convert_to(jsonb_build_array(m.id,m.thread_id,m.contact_id,m.gmail_account_id,m.twilio_number_id,m.provider,m.provider_message_id,m.channel,m.body_text,m.sent_at,m.from_identifier,m.to_identifiers,m.cc_identifiers,m.headers,m.direction)::text,'UTF8')),'hex')) order by m.sent_at,m.id),'[]') into msgs
 from (select * from public.messages where thread_id=t.id and user_id=p_actor and channel=t.channel and ((t.channel='email' and gmail_account_id=t.gmail_account_id) or (t.channel in('sms','whatsapp') and twilio_number_id=t.twilio_number_id))
  and ((contact_id=c.contact_id and not (channel='email' and direction='outbound')) or (
   channel='email' and direction='outbound' and provider='gmail' and (contact_id is null or contact_id=c.contact_id)
   and lower(from_identifier)=lower(transport->>'from') and to_identifiers=array[lower(q.sender_identifier)] and cardinality(cc_identifiers)=0
   and (headers='{}'::jsonb or jsonb_typeof(headers)='array')
   and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(headers)='array' then headers else '[]'::jsonb end) h where lower(h->>'name')='bcc' and btrim(coalesce(h->>'value',''))<>'')
   -- Old Gmail metadata does not prove a complete BCC envelope. Only our own
   -- immutable successful single-recipient dispatch proves this null-contact binding.
   and exists(select 1 from public.reply_dispatches receipt where receipt.user_id=p_actor and receipt.status='SENT'
    and receipt.provider_id=messages.provider_message_id and receipt.payload->>'channel'='email'
    and receipt.payload->>'threadId'=t.id::text and receipt.payload->>'fromAccountId'=t.gmail_account_id::text
    and receipt.payload->'scope'->>'clientId'=c.contact_id::text and receipt.payload->'scope'->>'businessId'=c.business_id::text
    and receipt.payload->'recipients'=jsonb_build_array(q.sender_identifier)
    and lower(receipt.payload->'transport'->>'from')=lower(transport->>'from') and receipt.payload->'transport'->>'to'=q.sender_identifier
    and not (receipt.payload ?| array['cc','bcc']) and not ((receipt.payload->'transport') ?| array['cc','bcc']))
  )) order by sent_at,id limit 201) m;
 complete=jsonb_array_length(msgs)<=200 and length(msgs::text)<=250000 and not exists(select 1 from public.messages scoped where scoped.thread_id=t.id and scoped.user_id=p_actor and not exists(select 1 from jsonb_array_elements(msgs) included where included->>'id'=scoped.id::text)) and not exists(select 1 from jsonb_array_elements(msgs) m where m->>'text' is null);
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'scope',jsonb_build_object('userId',p_actor,'clientId',c.contact_id,'businessId',c.business_id,'contextId',c.id),
  'kind',e.kind,'factKey',e.fact_key,'value',e.value,'source',jsonb_build_object('id',e.message_id,'revision',e.source_hash,'locator','/item/'||q.id||'?message='||e.message_id,'occurredAt',e.source_date,'excerpt',e.excerpt,'direction',(select direction from public.messages where id=e.message_id and user_id=p_actor)),
  'verification',jsonb_build_object('basis','human_reviewed','verifiedBy',e.verified_by,'verifiedAt',e.verified_at),
  'validUntil',e.valid_until,'revoked',e.revoked or not exists(select 1 from jsonb_array_elements(msgs) m where m->>'id'=e.message_id::text and m->>'hash'=e.source_hash and m->>'contactId'=c.contact_id::text),'supersedes',to_jsonb(e.supersedes)) order by e.id),'[]') into ev
 from public.reply_fact_evidence e where e.context_id=c.id and e.user_id=p_actor;
 envelope=jsonb_build_object('id',d.id,'revision',d.revision,'scope',jsonb_build_object('userId',p_actor,'clientId',c.contact_id,'businessId',c.business_id,'contextId',c.id),
  'queueItemId',q.id,'threadId',t.id,'channel',t.channel,'fromAccountId',coalesce(t.gmail_account_id,t.twilio_number_id),
  'recipients',jsonb_build_array(q.sender_identifier),'subject',coalesce(transport->>'subject',''),'text',d.draft_text,'updatedAt',d.updated_at,'transport',transport);
 return jsonb_build_object('draft',envelope,'claims',d.reply_claims,'evidence',ev,'sources',msgs,'evidenceRead',jsonb_build_object('complete',complete,'revision',c.evidence_revision::text,'unresolvedOutboundCount',(select count(*) from public.messages outbound where outbound.user_id=p_actor and outbound.thread_id=t.id and outbound.channel='email' and outbound.direction='outbound' and not exists(select 1 from jsonb_array_elements(msgs) included where included->>'id'=outbound.id::text))));
end $$;

create function public.mcc_reply_command(p_actor uuid,p_operation text,p_input jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare q public.queue_items; d public.reply_drafts; c public.reply_context_state; ck public.reply_checks; ap public.reply_approvals; ds public.reply_dispatches;
 st jsonb; item jsonb; src jsonb; eid uuid; did uuid; prior uuid; v_exp timestamptz; v_now timestamptz; ids uuid[]; txt text;
begin
 if p_actor is null or jsonb_typeof(p_input)<>'object' then raise exception 'invalid reply request'; end if;
 if p_operation='SAVE' then
  select * into q from public.queue_items where id=(p_input->>'queue_item_id')::uuid and user_id=p_actor;
  if not found or q.contact_id is null or q.business_id is null then raise exception 'reply scope unresolved'; end if;
  perform 1 from public.threads where id=q.thread_id and user_id=p_actor for update;
  if not found or not exists(select 1 from public.contacts where id=q.contact_id and user_id=p_actor) or not exists(select 1 from public.businesses where id=q.business_id and user_id=p_actor) then raise exception 'reply scope invalid'; end if;
  txt=btrim(p_input->>'text');
  if txt is null or length(txt) not between 1 and 20000 or jsonb_typeof(p_input->'claims')<>'array' or jsonb_array_length(p_input->'claims')>64 then raise exception 'invalid reply text or claims'; end if;
  insert into public.reply_context_state(user_id,queue_item_id,thread_id,contact_id,business_id) values(p_actor,q.id,q.thread_id,q.contact_id,q.business_id) on conflict(queue_item_id,user_id) do nothing;
  select * into c from public.reply_context_state where queue_item_id=q.id and user_id=p_actor for update;
  if c.thread_id<>q.thread_id or c.contact_id<>q.contact_id or c.business_id<>q.business_id then raise exception 'reply scope changed'; end if;
  did=(p_input->>'draft_id')::uuid;
  select * into d from public.reply_drafts where id=did and user_id=p_actor for update;
  if found then
   if d.queue_item_id<>q.id or d.revision is distinct from (p_input->>'revision')::bigint then raise exception 'reply draft revision changed'; end if;
   update public.reply_drafts set draft_text=txt,reply_claims=p_input->'claims',revision=revision+1,updated_at=clock_timestamp(),reply_context_id=c.id where id=d.id returning * into d;
   update public.reply_approvals set revoked_at=clock_timestamp() where user_id=p_actor and check_id in(select id from public.reply_checks where draft_id=d.id) and revoked_at is null and consumed_at is null;
  else
   if p_input->>'revision' is distinct from '0' then raise exception 'reply draft not found'; end if;
   insert into public.reply_drafts(id,user_id,queue_item_id,draft_text,confidence,reply_context_id,reply_claims) values(did,p_actor,q.id,txt,'yellow',c.id,p_input->'claims') returning * into d;
  end if;
  return public.mcc_reply_state(p_actor,d.id);
 elsif p_operation in('SNAPSHOT','EVIDENCE','REVOKE','CHECK') then
  did=(p_input->>'draft_id')::uuid; st=public.mcc_reply_state(p_actor,did);
  if p_operation='SNAPSHOT' then return st; end if;
  select * into d from public.reply_drafts where id=did and user_id=p_actor;
  if d.revision is distinct from (p_input->>'revision')::bigint then raise exception 'reply draft revision changed'; end if;
  select * into c from public.reply_context_state where id=d.reply_context_id and user_id=p_actor;
  if p_operation='REVOKE' then
   update public.reply_fact_evidence set revoked=true where id=(p_input->>'evidence_id')::uuid and context_id=c.id and user_id=p_actor and not revoked;
   if not found then raise exception 'reply evidence not found'; end if;
   return public.mcc_reply_state(p_actor,did);
  end if;
  if p_operation='EVIDENCE' then
   if p_input->>'value'='UNREVIEWED' then raise exception 'source value requires review'; end if;
   if p_input->>'reviewed' is distinct from 'true' then raise exception 'explicit source review required'; end if;
   select x into src from jsonb_array_elements(st->'sources') x where x->>'id'=p_input->>'message_id';
   if src is null or src->>'text' is null or src->>'contactId' is distinct from c.contact_id::text or src->>'hash' is distinct from p_input->>'source_hash' then raise exception 'source missing, foreign, or changed'; end if;
   txt=substring(src->>'text' from (p_input->>'start')::integer+1 for (p_input->>'end')::integer-(p_input->>'start')::integer);
   if (p_input->>'start')::integer<0 or length(txt)=0 or txt<>p_input->>'excerpt' or length(txt)>4000 then raise exception 'source excerpt mismatch'; end if;
   v_now=clock_timestamp();v_exp=(p_input->>'valid_until')::timestamptz;
   if (src->>'sentAt')::timestamptz>v_now or v_exp<=v_now or v_exp>v_now+interval '24 hours' then raise exception 'invalid source validity'; end if;
   ids=array(select value::uuid from jsonb_array_elements_text(coalesce(p_input->'supersedes','[]')));
   foreach prior in array ids loop
    if not exists(select 1 from public.reply_fact_evidence where id=prior and user_id=p_actor and context_id=c.id and fact_key=p_input->>'fact_key' and kind=p_input->>'kind' and source_date<(src->>'sentAt')::timestamptz and not revoked) then raise exception 'invalid source supersession'; end if;
   end loop;
   insert into public.reply_fact_evidence(user_id,context_id,message_id,kind,fact_key,value,source_hash,source_date,excerpt,verified_by,verified_at,valid_until,supersedes)
    values(p_actor,c.id,(src->>'id')::uuid,p_input->>'kind',p_input->>'fact_key',p_input->>'value',src->>'hash',(src->>'sentAt')::timestamptz,txt,p_actor,v_now,v_exp,ids) returning id into eid;
   return jsonb_build_object('evidence_id',eid,'state',public.mcc_reply_state(p_actor,did));
  end if;
  if st is distinct from p_input->'state' then raise exception 'reply state changed'; end if;
  if p_input->'result'->>'snapshotKey' is null or p_input->'result'->>'reviewKey' is null or p_input->'result'->>'status' not in('BLOCKED','SOURCE_SUPPORTED_REQUIRES_REVIEW') then raise exception 'invalid trusted check'; end if;
  v_exp=clock_timestamp()+interval '60 seconds';
  for item in select citation from jsonb_array_elements(p_input->'result'->'claims') claim cross join lateral jsonb_array_elements(claim->'citations') citation loop
   if (item->>'validUntil')::timestamptz<v_exp then v_exp=(item->>'validUntil')::timestamptz; end if;
  end loop;
  insert into public.reply_checks(user_id,draft_id,draft_revision,context_id,evidence_revision,state_snapshot,result,expires_at)
   values(p_actor,d.id,d.revision,c.id,c.evidence_revision,st,p_input->'result',v_exp) returning * into ck;
  return jsonb_build_object('check_id',ck.id,'check',ck.result,'state',st,'expires_at',ck.expires_at);
 elsif p_operation in('APPROVE','RESERVE','BEGIN','STATUS','FINISH','CANCEL') then
  if p_operation in('BEGIN','STATUS','FINISH','CANCEL') then
   select * into ds from public.reply_dispatches where user_id=p_actor and (id=(p_input->>'dispatch_id')::uuid or (p_operation='STATUS' and approval_id=(p_input->>'approval_id')::uuid));
   if not found then if p_operation='STATUS' then return jsonb_build_object('status','UNCONFIRMED'); end if;raise exception 'reply dispatch not found'; end if;
   if p_operation='STATUS' then return (to_jsonb(ds)-'payload')||case when ds.status='SENDING' and ds.updated_at<clock_timestamp()-interval '60 seconds' then jsonb_build_object('status','UNKNOWN') else '{}'::jsonb end; end if;
   if p_operation='CANCEL' then update public.reply_dispatches set status='CANCELLED',updated_at=clock_timestamp() where id=ds.id and status='RESERVED';select * into ds from public.reply_dispatches where id=ds.id;return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',true);end if;
   select * into ck from public.reply_checks where id=ds.check_id and user_id=p_actor;
  elsif p_operation='RESERVE' then
   select * into ap from public.reply_approvals where id=(p_input->>'approval_id')::uuid and user_id=p_actor;
   if not found then raise exception 'reply approval not found'; end if;
   select * into ds from public.reply_dispatches where approval_id=ap.id and user_id=p_actor;
   if found then return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',true); end if;
   select * into ck from public.reply_checks where id=ap.check_id and user_id=p_actor;
  else
   select * into ck from public.reply_checks where id=(p_input->>'check_id')::uuid and user_id=p_actor;
  end if;
  if ck.id is null then raise exception 'reply check not found'; end if;
  -- FINISH must remain possible after new source intake invalidates the reviewed snapshot.
  if p_operation='FINISH' then
   select * into ds from public.reply_dispatches where id=ds.id and user_id=p_actor for update;
   if ds.status='SENT' and p_input->>'status'='SENT' and ds.provider_id is distinct from p_input->>'provider_id' then raise exception 'reply provider identity changed'; end if;
   if ds.status='SENT' and p_input->>'status'='SENT' and ds.provider_id=p_input->>'provider_id' and p_input->>'ingestion_pending'='false' then update public.reply_dispatches set ingestion_pending=false where id=ds.id returning * into ds;end if;
   if ds.status<>'SENDING' then return to_jsonb(ds)-'payload'; end if;
   if p_input->>'status' not in('SENT','FAILED','UNKNOWN') or (p_input->>'status'='SENT' and coalesce(length(p_input->>'provider_id'),0)=0) then raise exception 'invalid dispatch outcome'; end if;
   update public.reply_dispatches set status=p_input->>'status',provider_id=p_input->>'provider_id',updated_at=clock_timestamp(),ingestion_pending=coalesce((p_input->>'ingestion_pending')::boolean,false) where id=ds.id returning * into ds;
   return to_jsonb(ds)-'payload';
  end if;
  st=public.mcc_reply_state(p_actor,ck.draft_id);v_now=clock_timestamp();
  -- A concurrent reservation may have committed while this transaction waited
  -- for the thread/context lock. Return that durable outcome before checking
  -- unresolved-context or freshness gates; never create a second intent.
  if p_operation='RESERVE' then
   select * into ds from public.reply_dispatches where approval_id=ap.id and user_id=p_actor;
   if found then return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',true); end if;
  end if;
  if ck.expires_at<=v_now or ck.state_snapshot is distinct from st or ck.result->>'status'<>'SOURCE_SUPPORTED_REQUIRES_REVIEW' then raise exception 'reply check expired or state changed'; end if;
  if p_operation in('APPROVE','RESERVE','BEGIN') and exists(select 1 from public.reply_dispatches x join public.reply_checks k on k.id=x.check_id and k.user_id=x.user_id where k.context_id=ck.context_id and x.user_id=p_actor and x.status in('RESERVED','SENDING','UNKNOWN') and (p_operation<>'BEGIN' or x.id<>ds.id)) then raise exception 'reply previous dispatch is pending or outcome unresolved'; end if;
  if p_operation='APPROVE' then
   if p_input->>'coverage_reviewed' is distinct from 'true' or p_input->>'snapshot_key' is distinct from ck.result->>'snapshotKey' or p_input->>'review_key' is distinct from ck.result->>'reviewKey' then raise exception 'exact reply review required'; end if;
   update public.reply_checks set coverage_reviewed_at=v_now where id=ck.id;
   update public.reply_approvals set revoked_at=v_now where check_id=ck.id and consumed_at is null and revoked_at is null;
   insert into public.reply_approvals(user_id,check_id,approved_at,expires_at) values(p_actor,ck.id,v_now,ck.expires_at) returning * into ap;
   return jsonb_build_object('approval_id',ap.id,'expires_at',ap.expires_at);
  elsif p_operation='RESERVE' then
   select * into ap from public.reply_approvals where id=ap.id and user_id=p_actor for update;
   select * into ds from public.reply_dispatches where approval_id=ap.id and user_id=p_actor;
   if found then return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',true); end if;
   if ap.revoked_at is not null or ap.consumed_at is not null or ap.expires_at<=v_now or ck.coverage_reviewed_at is null then raise exception 'reply approval no longer valid'; end if;
   if st->'draft'->>'channel' is distinct from p_input->>'channel' then raise exception 'reply channel mismatch'; end if;
   update public.reply_approvals set consumed_at=v_now where id=ap.id;
   insert into public.reply_dispatches(user_id,approval_id,check_id,payload) values(p_actor,ap.id,ck.id,st->'draft') returning * into ds;
   return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',false);
  else
   select * into ds from public.reply_dispatches where id=ds.id and user_id=p_actor for update;
   if ds.status<>'RESERVED' then return jsonb_build_object('dispatch_id',ds.id,'status',ds.status,'existing',true); end if;
   if ds.payload->>'channel' is distinct from p_input->>'channel' then raise exception 'reply channel mismatch'; end if;
   update public.reply_dispatches set status='SENDING',updated_at=v_now where id=ds.id;
   return jsonb_build_object('dispatch_id',ds.id,'status','SENDING','existing',false,'payload',ds.payload);
  end if;
 else raise exception 'unsupported reply operation'; end if;
end $$;
revoke all on function public.mcc_reply_state(uuid,uuid) from public,anon,authenticated;
revoke all on function public.mcc_reply_command(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.mcc_reply_invalidate_source() from public,anon,authenticated;
grant execute on function public.mcc_reply_state(uuid,uuid),public.mcc_reply_command(uuid,text,jsonb),public.mcc_reply_invalidate_source() to service_role;
commit;
