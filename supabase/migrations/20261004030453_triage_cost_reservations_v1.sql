-- Local review candidate only. No policy, price, cap, or enablement is seeded.
-- Reuses spend_caps and ai_spend_ledger. Scope: participating triage calls only.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';

create schema mcc_cost_internal;
revoke all on schema mcc_cost_internal from public, anon, authenticated, service_role;
-- Schema-local defaults are defensive; explicit object revokes below also remove
-- any global default grants inherited from the project's installer role.
alter default privileges in schema mcc_cost_internal revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema mcc_cost_internal revoke all on sequences from public,anon,authenticated,service_role;
alter default privileges in schema mcc_cost_internal revoke all on functions from public,anon,authenticated,service_role;
create table mcc_cost_internal.triage_tasks (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  message_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  attempt_token uuid not null default gen_random_uuid(),
  state text not null check (state in ('reserved','unknown','ready','invalid','overrun','applied')),
  policy jsonb not null,
  source_snapshot jsonb not null,
  reserved_usd numeric not null check (reserved_usd >= 0 and reserved_usd < 'Infinity'::numeric),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  applied_at timestamptz,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric,
  decision jsonb,
  ledger_id bigint unique references public.ai_spend_ledger(id),
  primary key(user_id, message_id)
);
alter table mcc_cost_internal.triage_tasks enable row level security;
revoke all on mcc_cost_internal.triage_tasks from public, anon, authenticated, service_role;
create index triage_tasks_unsettled_user on mcc_cost_internal.triage_tasks(user_id)
  where state in ('reserved','unknown','overrun');

-- Fresh canonical tenant-scoped context is compared exactly, never cached by age.
create function mcc_cost_internal.triage_source_v1(p_user uuid, p_message uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('message',jsonb_build_object(
    'from_name',m.from_name,'from_email',m.from_identifier,'to',m.to_identifiers,
    'subject',m.subject,'snippet',m.snippet,'headers',m.headers,'channel',m.channel),
    'businesses',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.id)
      from public.businesses b where b.user_id=p_user),'[]'::jsonb))
  from public.messages m where m.id=p_message and m.user_id=p_user;
$$;
revoke all on function mcc_cost_internal.triage_source_v1(uuid,uuid) from public,anon,authenticated,service_role;

-- Every transition takes the same per-user caps-row lock first. This serializes
-- participating reservations and settlement, including concurrent queue deliveries.
create function public.reserve_triage_cost_v1(p_user uuid, p_message uuid, p_request_hash text, p_source jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.spend_caps%rowtype;
  t mcc_cost_internal.triage_tasks%rowtype;
  p jsonb;
  v_in numeric;
  v_out numeric;
  v_input_limit integer;
  v_verified timestamptz;
  v_until timestamptz;
  v_bound numeric;
  v_spent numeric;
  v_held numeric;
  v_calls bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_user is null or p_message is null or p_request_hash is null or
      p_request_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status','blocked','reason','invalid task identity');
  end if;
  if not exists (select 1 from public.messages where id=p_message and user_id=p_user) then
    return jsonb_build_object('status','blocked','reason','message ownership unverified');
  end if;
  select * into c from public.spend_caps where user_id=p_user for update;
  if not found then
    return jsonb_build_object('status','blocked','reason','no spend caps row');
  end if;
  if p_source is null or p_source is distinct from mcc_cost_internal.triage_source_v1(p_user,p_message) then
    return jsonb_build_object('status','blocked','reason','source context changed or unverified');
  end if;
  select * into t from mcc_cost_internal.triage_tasks where user_id=p_user and message_id=p_message;
  if found then
    if t.request_hash <> p_request_hash or t.source_snapshot is distinct from p_source then
      return jsonb_build_object('status','blocked','reason','task input/version conflict');
    end if;
    if t.state in ('ready','applied') then return jsonb_build_object('status',t.state); end if;
    return jsonb_build_object('status','blocked','reason','existing '||t.state||' attempt requires review');
  end if;
  if exists (select 1 from public.ai_spend_ledger where user_id=p_user and purpose='triage'
      and ref_type='message' and ref_id=p_message) then
    return jsonb_build_object('status','blocked','reason','legacy paid task requires review');
  end if;
  if not (c.monthly_cap_usd >= 0 and c.monthly_cap_usd < 'Infinity'::numeric and
      c.triage_daily_call_cap >= 0) then
    return jsonb_build_object('status','blocked','reason','invalid spend caps');
  end if;
  if exists (select 1 from mcc_cost_internal.triage_tasks where user_id=p_user and state='overrun') then
    return jsonb_build_object('status','blocked','reason','pricing bound exceeded; review required');
  end if;
  v_now := clock_timestamp();
  select value into p from public.app_config where key='mcc_triage_cost_policy_v1';
  -- An operator must separately verify the exact model's maximum billable input,
  -- standard on-demand rates, and lack of other billable features. No estimate or
  -- model-default price is accepted. Input reservation is deliberately pessimistic.
  begin
    if jsonb_typeof(p) is distinct from 'object' or p->>'status' is distinct from 'verified' or
        p->>'kind' is distinct from 'anthropic_standard_messages_v1' or
        p->>'currency' is distinct from 'USD' or
        coalesce(p->>'version','')='' or coalesce(p->>'reviewed_by','')='' or
        coalesce(p->>'source_url','') !~ '^https://' or
        coalesce(p->>'model','') !~ '^claude-haiku-4-5-[0-9]{8}$' or
        jsonb_typeof(p->'input_usd_per_million') is distinct from 'number' or
        jsonb_typeof(p->'output_usd_per_million') is distinct from 'number' or
        jsonb_typeof(p->'max_billable_input_tokens') is distinct from 'number' or
        jsonb_typeof(p->'max_output_tokens') is distinct from 'number' or
        coalesce(p->>'max_billable_input_tokens','') !~ '^[1-9][0-9]*$' or
        p->>'max_output_tokens' is distinct from '400' then
      return jsonb_build_object('status','blocked','reason','verified price policy missing or invalid');
    end if;
    v_in := (p->>'input_usd_per_million')::numeric;
    v_out := (p->>'output_usd_per_million')::numeric;
    v_input_limit := (p->>'max_billable_input_tokens')::integer;
    v_verified := (p->>'verified_at')::timestamptz;
    v_until := (p->>'valid_until')::timestamptz;
    if v_verified is null or v_until is null or not isfinite(v_verified) or not isfinite(v_until) or
        v_verified > v_now or v_until <= v_now or v_until <= v_verified or
        not (v_in >= 0 and v_in < 'Infinity'::numeric and v_out >= 0 and v_out < 'Infinity'::numeric) then
      return jsonb_build_object('status','blocked','reason','price policy expired or invalid');
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
    return jsonb_build_object('status','blocked','reason','price policy malformed');
  end;
  v_bound := (v_input_limit * v_in + 400 * v_out) / 1000000;
  -- Month/day boundaries are explicitly UTC, matching the existing hosted ledger.
  -- Old unknown/reserved attempts continue consuming budget across month rollover.
  select coalesce(sum(cost_usd),0) into v_spent from public.ai_spend_ledger
    where user_id=p_user and occurred_at >= date_trunc('month',v_now at time zone 'UTC') at time zone 'UTC';
  if exists (select 1 from public.ai_spend_ledger where user_id=p_user and
      (cost_usd < 0 or cost_usd >= 'Infinity'::numeric)) then
    return jsonb_build_object('status','blocked','reason','ledger contains unverified costs');
  end if;
  select coalesce(sum(reserved_usd),0) into v_held from mcc_cost_internal.triage_tasks
    where user_id=p_user and state in ('reserved','unknown');
  if v_spent + v_held + v_bound > c.monthly_cap_usd then
    return jsonb_build_object('status','blocked','reason','monthly cap includes spent and reserved amounts');
  end if;
  select count(*) into v_calls from public.ai_spend_ledger where user_id=p_user and purpose='triage'
    and occurred_at >= date_trunc('day',v_now at time zone 'UTC') at time zone 'UTC';
  v_calls := v_calls + (select count(*) from mcc_cost_internal.triage_tasks
    where user_id=p_user and state in ('reserved','unknown'));
  if v_calls >= c.triage_daily_call_cap then
    return jsonb_build_object('status','blocked','reason','triage daily cap includes unresolved attempts');
  end if;
  insert into mcc_cost_internal.triage_tasks(user_id,message_id,request_hash,state,policy,source_snapshot,reserved_usd)
    values(p_user,p_message,p_request_hash,'reserved',p,p_source,v_bound) returning * into t;
  return jsonb_build_object('status','reserved','token',t.attempt_token,'model',p->>'model',
    'valid_until',v_until,'reserved_usd',v_bound);
end;
$$;

create function public.mark_triage_unknown_v1(p_user uuid, p_message uuid, p_request_hash text, p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.spend_caps where user_id=p_user for update;
  update mcc_cost_internal.triage_tasks set state='unknown'
    where user_id=p_user and message_id=p_message and request_hash=p_request_hash
      and attempt_token=p_token and state in ('reserved','unknown');
  if not found then raise exception 'triage unknown identity/state mismatch'; end if;
  return jsonb_build_object('status','unknown');
end;
$$;

create function public.settle_triage_cost_v1(
  p_user uuid, p_message uuid, p_request_hash text, p_token uuid, p_model text,
  p_tokens_in integer, p_tokens_out integer, p_decision jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t mcc_cost_internal.triage_tasks%rowtype;
  v_cost numeric;
  v_ledger bigint;
  v_state text;
begin
  perform 1 from public.spend_caps where user_id=p_user for update;
  select * into t from mcc_cost_internal.triage_tasks where user_id=p_user and message_id=p_message for update;
  if not found or p_request_hash is distinct from t.request_hash or p_token is distinct from t.attempt_token then
    raise exception 'triage settlement identity mismatch';
  end if;
  if t.ledger_id is not null then
    if p_model is distinct from t.policy->>'model' or p_tokens_in is distinct from t.tokens_in or
        p_tokens_out is distinct from t.tokens_out or p_decision is distinct from t.decision then
      raise exception 'triage settlement conflict';
    end if;
    return jsonb_build_object('status',t.state,'reason',t.state);
  end if;
  if t.state not in ('reserved','unknown') then raise exception 'triage settlement state mismatch'; end if;
  if p_model is distinct from t.policy->>'model' or p_tokens_in is null or p_tokens_out is null or
      p_tokens_in < 0 or p_tokens_out < 0 then
    update mcc_cost_internal.triage_tasks set state='unknown' where user_id=p_user and message_id=p_message;
    return jsonb_build_object('status','blocked','reason','provider model or usage unverified');
  end if;
  v_cost := (p_tokens_in * (t.policy->>'input_usd_per_million')::numeric +
    p_tokens_out * (t.policy->>'output_usd_per_million')::numeric) / 1000000;
  v_state := case when v_cost > t.reserved_usd or p_tokens_in > (t.policy->>'max_billable_input_tokens')::integer or
    p_tokens_out > 400 then 'overrun'
    when jsonb_typeof(p_decision) is distinct from 'object' then 'invalid' else 'ready' end;
  insert into public.ai_spend_ledger(user_id,provider,model,purpose,tokens_in,tokens_out,cost_usd,ref_type,ref_id)
    values(p_user,'anthropic',p_model,'triage',p_tokens_in,p_tokens_out,v_cost,'message',p_message)
    returning id into v_ledger;
  update mcc_cost_internal.triage_tasks set state=v_state,settled_at=clock_timestamp(),
    tokens_in=p_tokens_in,tokens_out=p_tokens_out,cost_usd=v_cost,decision=p_decision,ledger_id=v_ledger
    where user_id=p_user and message_id=p_message;
  return jsonb_build_object('status',v_state,'reason',v_state);
end;
$$;

-- Application is a separate atomic transaction so a downstream validation error
-- cannot erase a successfully recorded paid outcome. Retrying it never calls AI.
create function public.apply_budgeted_triage_v1(p_user uuid, p_message uuid, p_request_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t mcc_cost_internal.triage_tasks%rowtype;
begin
  perform 1 from public.spend_caps where user_id=p_user for update;
  select * into t from mcc_cost_internal.triage_tasks where user_id=p_user and message_id=p_message for update;
  if not found or p_request_hash is distinct from t.request_hash then raise exception 'triage apply identity mismatch'; end if;
  if t.state='applied' then return jsonb_build_object('status','applied','newly_applied',false); end if;
  if t.state <> 'ready' then raise exception 'triage result not ready'; end if;
  if not exists (select 1 from public.messages where id=p_message and user_id=p_user) then
    raise exception 'triage message ownership changed';
  end if;
  if t.decision->>'business_id' is not null and not exists (
    select 1 from public.businesses where id=(t.decision->>'business_id')::uuid and user_id=p_user
  ) then raise exception 'triage business ownership changed'; end if;
  if t.source_snapshot is distinct from mcc_cost_internal.triage_source_v1(p_user,p_message) then
    raise exception 'triage source context changed';
  end if;
  perform public.apply_model_triage(p_message,t.decision);
  update mcc_cost_internal.triage_tasks set state='applied',applied_at=clock_timestamp()
    where user_id=p_user and message_id=p_message;
  return jsonb_build_object('status','applied','newly_applied',true,'category',t.decision->>'category');
end;
$$;

revoke all on function public.reserve_triage_cost_v1(uuid,uuid,text,jsonb),
  public.mark_triage_unknown_v1(uuid,uuid,text,uuid),
  public.settle_triage_cost_v1(uuid,uuid,text,uuid,text,integer,integer,jsonb),
  public.apply_budgeted_triage_v1(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reserve_triage_cost_v1(uuid,uuid,text,jsonb),
  public.mark_triage_unknown_v1(uuid,uuid,text,uuid),
  public.settle_triage_cost_v1(uuid,uuid,text,uuid,text,integer,integer,jsonb),
  public.apply_budgeted_triage_v1(uuid,uuid,text) to service_role;
commit;
