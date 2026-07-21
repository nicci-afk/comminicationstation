-- 0004: security-definer RPCs. Tenant derivation for all ingestion lives HERE
-- and only here: service-role code never accepts a user_id from a payload —
-- it hands an authenticated routing key (gmail_account_id / twilio_number_id)
-- to these functions, which resolve the owning tenant from the mapping row.

-- ------------------------------------------------------------ vault helpers

create or replace function public.vault_upsert_secret(p_name text, p_value text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
  return v_id;
end;
$$;
revoke all on function public.vault_upsert_secret(text, text) from public, anon, authenticated;

create or replace function public.vault_read_secret(p_id uuid)
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_id;
$$;
revoke all on function public.vault_read_secret(uuid) from public, anon, authenticated;

-- Users store their own integration keys; value goes straight to Vault.
create or replace function public.set_user_secret(p_kind text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_kind not in ('perplexity_api_key','openai_api_key','anthropic_api_key',
                    'twilio_account_sid','twilio_auth_token') then
    raise exception 'unknown secret kind %', p_kind;
  end if;
  if length(trim(p_value)) < 8 then
    raise exception 'secret value too short';
  end if;
  v_id := public.vault_upsert_secret('user:' || v_user || ':' || p_kind, trim(p_value));
  insert into public.user_secrets (user_id, kind, vault_secret_id)
  values (v_user, p_kind, v_id)
  on conflict (user_id, kind)
  do update set vault_secret_id = excluded.vault_secret_id, updated_at = now();
end;
$$;

create or replace function public.get_user_secret(p_user uuid, p_kind text)
returns text
language sql
security definer
set search_path = public
as $$
  select public.vault_read_secret(s.vault_secret_id)
  from public.user_secrets s
  where s.user_id = p_user and s.kind = p_kind;
$$;
revoke all on function public.get_user_secret(uuid, text) from public, anon, authenticated;

create or replace function public.get_app_config(p_key text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select value from public.app_config where key = p_key;
$$;
revoke all on function public.get_app_config(text) from public, anon, authenticated;

create or replace function public.set_app_config(p_key text, p_value jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.app_config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
revoke all on function public.set_app_config(text, jsonb) from public, anon, authenticated;

-- --------------------------------------------------------- jobs + poking

-- Enqueue a job and immediately poke its worker over pg_net so latency is
-- seconds, not cron-interval. The minutely sweep is the reliability backstop.
create or replace function public.enqueue_and_poke(p_queue text, p_msg jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg_id bigint;
begin
  v_msg_id := pgmq.send(p_queue, p_msg);
  perform public.poke_worker(p_queue);
  return v_msg_id;
end;
$$;
revoke all on function public.enqueue_and_poke(text, jsonb) from public, anon, authenticated;

create or replace function public.poke_worker(p_queue text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := public.get_app_config('worker_base_url') ->> 'url';
  v_anon text := public.get_app_config('anon_key') ->> 'key';
  v_secret_id uuid := (public.get_app_config('worker_secret_vault_id') ->> 'id')::uuid;
  v_secret text;
  v_fn text;
begin
  if v_base is null or v_anon is null or v_secret_id is null then
    return; -- not configured yet; cron sweep will drain
  end if;
  v_secret := public.vault_read_secret(v_secret_id);
  v_fn := case p_queue
    when 'sync_jobs' then 'gmail-sync-worker'
    when 'triage_jobs' then 'triage-worker'
    when 'pipeline_jobs' then 'pipeline-worker'
    when 'digest_jobs' then 'digest-worker'
    else null
  end;
  if v_fn is null then
    return;
  end if;
  perform net.http_post(
    url := v_base || '/' || v_fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'x-worker-secret', v_secret
    ),
    body := jsonb_build_object('queue', p_queue),
    timeout_milliseconds := 5000
  );
end;
$$;
revoke all on function public.poke_worker(text) from public, anon, authenticated;

create or replace function public.poke_nonempty_queues()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
begin
  foreach q in array array['sync_jobs','triage_jobs','pipeline_jobs','digest_jobs'] loop
    if (select queue_length from pgmq.metrics(q)) > 0 then
      perform public.poke_worker(q);
    end if;
  end loop;
end;
$$;
revoke all on function public.poke_nonempty_queues() from public, anon, authenticated;

-- ------------------------------------------------------------ spend guard

create or replace function public.check_spend(p_user uuid, p_purpose text, p_estimated_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caps public.spend_caps%rowtype;
  v_month_total numeric;
  v_pipeline_total numeric;
  v_triage_today int;
begin
  select * into v_caps from public.spend_caps where user_id = p_user;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no spend caps row');
  end if;

  select coalesce(sum(cost_usd), 0) into v_month_total
  from public.ai_spend_ledger
  where user_id = p_user and occurred_at >= date_trunc('month', now());

  if v_month_total + p_estimated_usd > v_caps.monthly_cap_usd then
    return jsonb_build_object('allowed', false, 'reason',
      format('monthly cap $%s reached (spent $%s)', v_caps.monthly_cap_usd, round(v_month_total, 2)));
  end if;

  if p_purpose like 'pipeline%' then
    select coalesce(sum(cost_usd), 0) into v_pipeline_total
    from public.ai_spend_ledger
    where user_id = p_user and purpose like 'pipeline%'
      and occurred_at >= date_trunc('month', now());
    if v_pipeline_total + p_estimated_usd > v_caps.pipeline_monthly_cap_usd then
      return jsonb_build_object('allowed', false, 'reason',
        format('pipeline monthly cap $%s reached', v_caps.pipeline_monthly_cap_usd));
    end if;
  end if;

  if p_purpose = 'triage' then
    select count(*) into v_triage_today
    from public.ai_spend_ledger
    where user_id = p_user and purpose = 'triage' and occurred_at >= date_trunc('day', now());
    if v_triage_today >= v_caps.triage_daily_call_cap then
      return jsonb_build_object('allowed', false, 'reason', 'triage daily call cap reached');
    end if;
  end if;

  return jsonb_build_object('allowed', true, 'reason', '');
end;
$$;
revoke all on function public.check_spend(uuid, text, numeric) from public, anon, authenticated;

create or replace function public.record_spend(
  p_user uuid, p_provider text, p_model text, p_purpose text,
  p_tokens_in int, p_tokens_out int, p_cost numeric, p_ref_type text, p_ref uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ai_spend_ledger
    (user_id, provider, model, purpose, tokens_in, tokens_out, cost_usd, ref_type, ref_id)
  values (p_user, p_provider, p_model, p_purpose, p_tokens_in, p_tokens_out, p_cost, p_ref_type, p_ref);
  if p_purpose like 'pipeline%' and p_ref_type = 'pipeline_run' then
    update public.pipeline_runs set total_cost_usd = total_cost_usd + p_cost where id = p_ref;
  end if;
end;
$$;
revoke all on function public.record_spend(uuid, text, text, text, int, int, numeric, text, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ email ingest

-- p payload (built by the sync worker from the Gmail API message):
-- {
--   provider_message_id, thread_provider_id, rfc822_message_id, in_reply_to,
--   references_ids[], direction ('inbound'|'outbound'), from_name,
--   from_identifier, to_identifiers[], cc_identifiers[], subject, snippet,
--   sent_at, labels[], is_unread, headers{}, body_text?,
--   bulk: { is_bulk, reasons[], suggested_category }, backlog: bool
-- }
create or replace function public.ingest_email_message(p_gmail_account_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct public.gmail_accounts%rowtype;
  v_user uuid;
  v_thread_id uuid;
  v_message_id uuid;
  v_contact_id uuid;
  v_contact_kind text;
  v_is_vip boolean := false;
  v_sent_at timestamptz := (p ->> 'sent_at')::timestamptz;
  v_direction text := p ->> 'direction';
  v_from text := lower(coalesce(p ->> 'from_identifier', ''));
  v_is_bulk boolean := coalesce((p -> 'bulk' ->> 'is_bulk')::boolean, false);
  v_backlog boolean := coalesce((p ->> 'backlog')::boolean, false);
  -- triage outputs
  v_rule record;
  v_cache public.sender_triage_cache%rowtype;
  v_business uuid;
  v_category text;
  v_action text;
  v_priority int := 50;
  v_reasons text[] := '{}';
  v_state text;
  v_needs_model boolean := false;
  v_item_id uuid;
  v_existing public.queue_items%rowtype;
  v_direct boolean;
  v_default_business uuid;
  v_rules_decided boolean := false;
begin
  select * into v_acct from public.gmail_accounts where id = p_gmail_account_id;
  if not found then
    raise exception 'unknown gmail account %', p_gmail_account_id;
  end if;
  v_user := v_acct.user_id;

  -- thread upsert
  insert into public.threads (user_id, channel, gmail_account_id, provider_thread_id, subject, last_message_at)
  values (v_user, 'email', p_gmail_account_id, p ->> 'thread_provider_id',
          coalesce(p ->> 'subject', ''), v_sent_at)
  on conflict (gmail_account_id, provider_thread_id) where gmail_account_id is not null
  do update set last_message_at = greatest(threads.last_message_at, excluded.last_message_at),
                subject = case when threads.subject = '' then excluded.subject else threads.subject end
  returning id into v_thread_id;

  -- contact upsert (inbound sender only)
  if v_direction = 'inbound' and v_from <> '' then
    select c.id, c.kind, c.is_vip into v_contact_id, v_contact_kind, v_is_vip
    from public.contact_channels ch
    join public.contacts c on c.id = ch.contact_id
    where ch.user_id = v_user and ch.channel_type = 'email' and ch.canonical_value = v_from;
    if v_contact_id is null then
      insert into public.contacts (user_id, display_name, kind)
      values (v_user, coalesce(nullif(p ->> 'from_name', ''), v_from),
              case when v_is_bulk then 'automated' else 'unknown' end)
      returning id, kind into v_contact_id, v_contact_kind;
      insert into public.contact_channels (user_id, contact_id, channel_type, raw_value, canonical_value)
      values (v_user, v_contact_id, 'email', coalesce(p ->> 'from_identifier', ''), v_from)
      on conflict do nothing;
    else
      update public.contacts set last_seen_at = now() where id = v_contact_id;
    end if;
  end if;

  -- message insert (dedupe on provider id)
  insert into public.messages (
    user_id, thread_id, contact_id, direction, channel, provider, gmail_account_id,
    provider_message_id, rfc822_message_id, in_reply_to, references_ids,
    from_name, from_identifier, to_identifiers, cc_identifiers,
    subject, snippet, body_text, sent_at, labels, is_unread, headers
  ) values (
    v_user, v_thread_id, v_contact_id, v_direction, 'email', 'gmail', p_gmail_account_id,
    p ->> 'provider_message_id', p ->> 'rfc822_message_id', p ->> 'in_reply_to',
    coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'references_ids') x), '{}'),
    coalesce(p ->> 'from_name', ''), v_from,
    coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'to_identifiers') x), '{}'),
    coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'cc_identifiers') x), '{}'),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'snippet', ''), p ->> 'body_text',
    v_sent_at,
    coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'labels') x), '{}'),
    coalesce((p ->> 'is_unread')::boolean, false),
    coalesce(p -> 'headers', '{}'::jsonb)
  )
  on conflict (gmail_account_id, provider_message_id) where gmail_account_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- ============================================ outbound: responded detection
  if v_direction = 'outbound' then
    perform set_config('app.transition_reason', 'reply_observed', true);
    for v_existing in
      select qi.* from public.queue_items qi
      join public.messages li on li.id = qi.last_inbound_message_id
      where qi.user_id = v_user
        and qi.state in ('new', 'needs_attention', 'snoozed', 'backlog', 'fyi')
        and li.sent_at < v_sent_at
        and (
          qi.thread_id = v_thread_id
          or (li.rfc822_message_id is not null and li.rfc822_message_id = p ->> 'in_reply_to')
          or (li.rfc822_message_id is not null
              and li.rfc822_message_id = any (coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'references_ids') x), '{}')))
        )
    loop
      -- recipient-overlap check: a reply goes TO the original sender.
      -- Forwards (no overlap) must NOT resolve the item.
      if exists (
        select 1 from public.messages li
        where li.id = v_existing.last_inbound_message_id
          and li.from_identifier = any (
            coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'to_identifiers') x), '{}')
            || coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'cc_identifiers') x), '{}')
          )
      ) then
        perform set_config('app.transition_evidence',
          jsonb_build_object('resolved_by_message_id', v_message_id,
                             'rfc822_message_id', p ->> 'rfc822_message_id',
                             'sent_at', p ->> 'sent_at')::text, true);
        update public.queue_items
        set state = 'responded',
            resolved_by_message_id = v_message_id,
            resolved_at = v_sent_at
        where id = v_existing.id;
      else
        insert into public.queue_item_events
          (user_id, queue_item_id, from_state, to_state, actor, reason, evidence)
        values (v_user, v_existing.id, v_existing.state, v_existing.state, 'system',
                'forward_observed_not_reply',
                jsonb_build_object('message_id', v_message_id));
      end if;
    end loop;
    return jsonb_build_object('status', 'ok', 'message_id', v_message_id, 'direction', 'outbound');
  end if;

  -- ============================================ inbound: deterministic triage
  select id into v_default_business from public.businesses
  where user_id = v_user and is_default limit 1;

  -- rule matching, most-specific wins for business/category/action
  for v_rule in
    select r.*,
      case r.rule_type
        when 'from_email' then 1 when 'to_email' then 2
        when 'from_domain' then 3 when 'subject_contains' then 4 end as specificity
    from public.triage_rules r
    where r.user_id = v_user and r.enabled
      and (
        (r.rule_type = 'from_email' and lower(r.pattern) = v_from)
        or (r.rule_type = 'from_domain' and v_from like '%@' || lower(r.pattern))
        or (r.rule_type = 'to_email' and lower(r.pattern) = any (
              coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'to_identifiers') x), '{}')))
        or (r.rule_type = 'subject_contains' and position(lower(r.pattern) in lower(coalesce(p ->> 'subject', ''))) > 0)
      )
    order by specificity
  loop
    v_business := coalesce(v_business, v_rule.business_id);
    v_category := coalesce(v_category, v_rule.category);
    v_action := coalesce(v_action, v_rule.action);
    v_priority := v_priority + v_rule.priority_delta;
    if v_rule.priority_delta <> 0 then
      v_reasons := v_reasons || format('rule %s:%s (%s)', v_rule.rule_type, v_rule.pattern, v_rule.priority_delta);
    end if;
    if v_rule.mark_vip then v_is_vip := true; end if;
    v_rules_decided := true;
  end loop;

  -- sender cache (never overrides an explicit rule)
  select * into v_cache from public.sender_triage_cache
  where user_id = v_user and sender_key = v_from;
  if found then
    v_business := coalesce(v_business, v_cache.business_id);
    v_category := coalesce(v_category, v_cache.category);
    if v_cache.contact_kind is not null and v_contact_kind = 'unknown' then
      update public.contacts set kind = v_cache.contact_kind where id = v_contact_id;
      v_contact_kind := v_cache.contact_kind;
    end if;
  end if;

  -- single-business contacts inherit that business
  if v_business is null and v_contact_id is not null then
    select min(business_id::text)::uuid into v_business
    from public.contact_business_links
    where contact_id = v_contact_id
    having count(distinct business_id) = 1;
  end if;

  v_direct := lower(v_acct.email_address::text) = any (
    coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p -> 'to_identifiers') x), '{}'));

  -- category default
  if v_category is null then
    if v_is_bulk then
      v_category := coalesce(nullif(p -> 'bulk' ->> 'suggested_category', ''), 'newsletter');
    elsif v_direct and coalesce(v_contact_kind, 'unknown') in ('human', 'unknown') then
      v_category := 'needs_reply';
    else
      v_category := 'other';
    end if;
  end if;

  -- state decision
  if v_backlog then
    v_state := 'backlog';
  elsif v_action = 'suppress' then
    v_state := 'suppressed';
  elsif v_action = 'fyi' or v_is_bulk then
    v_state := 'fyi';
  elsif v_action = 'needs_attention' then
    v_state := 'needs_attention';
  elsif v_category in ('needs_reply', 'urgent', 'scheduling') then
    v_state := 'needs_attention';
  else
    v_state := 'fyi';
  end if;

  -- priority scoring (base 50, clamped 0..100, reasons recorded for trust UX)
  if v_is_vip then v_priority := v_priority + 25; v_reasons := v_reasons || 'VIP contact'; end if;
  if v_direct then v_priority := v_priority + 10; v_reasons := v_reasons || 'addressed directly to you'; end if;
  v_priority := v_priority + case v_category
    when 'urgent' then 20 when 'needs_reply' then 10 when 'scheduling' then 8
    when 'promotion' then -25 when 'newsletter' then -25 when 'notification' then -15
    when 'receipt' then -10 when 'expense' then -5 else 0 end;
  if v_category in ('urgent','needs_reply','scheduling') then
    v_reasons := v_reasons || ('category: ' || v_category);
  end if;
  if v_business is not null then
    v_priority := v_priority + coalesce((select priority_weight from public.businesses where id = v_business), 0);
  end if;
  v_priority := greatest(0, least(100, v_priority));

  -- does this need the cheap model pass? Only non-bulk attention items whose
  -- business/category rules+cache could not decide.
  v_needs_model := (not v_is_bulk)
    and v_state = 'needs_attention'
    and not v_backlog
    and (v_business is null or coalesce(v_contact_kind, 'unknown') = 'unknown')
    and not v_rules_decided
    and v_cache.id is null;

  -- queue item: reuse the live episode for this thread or open a new one
  select * into v_existing from public.queue_items
  where thread_id = v_thread_id
    and state in ('new','needs_attention','snoozed','awaiting_reply','backlog','fyi')
  limit 1;

  if found then
    perform set_config('app.transition_reason', 'new_inbound_message', true);
    update public.queue_items
    set message_count = message_count + 1,
        last_inbound_message_id = v_message_id,
        preview = coalesce(nullif(p ->> 'snippet', ''), preview),
        title = case when title = '' then coalesce(p ->> 'subject', '') else title end,
        priority = greatest(priority, v_priority),
        is_vip = is_vip or v_is_vip,
        state = case
          when state in ('awaiting_reply', 'snoozed') then 'needs_attention'
          else state end,
        snoozed_until = case when state = 'snoozed' then null else snoozed_until end,
        waiting_since = case when state in ('awaiting_reply','snoozed') then now() else waiting_since end
    where id = v_existing.id
    returning id into v_item_id;
  else
    insert into public.queue_items (
      user_id, thread_id, contact_id, business_id, state, category, priority,
      priority_reasons, channel, title, preview, sender_name, sender_identifier,
      is_vip, last_inbound_message_id, sla_due_at
    ) values (
      v_user, v_thread_id, v_contact_id, coalesce(v_business, v_default_business),
      v_state, v_category, v_priority, v_reasons, 'email',
      coalesce(p ->> 'subject', ''), coalesce(p ->> 'snippet', ''),
      coalesce(p ->> 'from_name', ''), v_from, v_is_vip, v_message_id,
      case when v_state = 'needs_attention'
           then now() + case when v_priority >= 75 then interval '1 day' else interval '2 days' end
           end
    ) returning id into v_item_id;
  end if;

  -- cache the decision for this sender (rules-decided only; user wins always)
  if v_rules_decided and v_business is not null then
    insert into public.sender_triage_cache
      (user_id, sender_key, business_id, category, needs_reply, contact_kind, decided_by)
    values (v_user, v_from, v_business, v_category, v_state = 'needs_attention',
            coalesce(v_contact_kind, 'unknown'), 'rules')
    on conflict (user_id, sender_key) do update
    set business_id = excluded.business_id, category = excluded.category,
        needs_reply = excluded.needs_reply, updated_at = now()
    where sender_triage_cache.decided_by <> 'user';
  end if;

  return jsonb_build_object(
    'status', 'ok', 'message_id', v_message_id, 'queue_item_id', v_item_id,
    'state', v_state, 'needs_model_triage', v_needs_model,
    'contact_id', v_contact_id
  );
end;
$$;
revoke all on function public.ingest_email_message(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ sms/wa ingest

-- p: { provider_message_id, direction, channel ('sms'|'whatsapp'),
--      counterparty_e164, counterparty_name?, body, sent_at }
create or replace function public.ingest_twilio_message(p_twilio_number_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num public.twilio_numbers%rowtype;
  v_user uuid;
  v_channel text := coalesce(p ->> 'channel', 'sms');
  v_phone text := p ->> 'counterparty_e164';
  v_thread_key text;
  v_thread_id uuid;
  v_message_id uuid;
  v_contact_id uuid;
  v_is_vip boolean := false;
  v_item_id uuid;
  v_existing public.queue_items%rowtype;
  v_sent_at timestamptz := coalesce((p ->> 'sent_at')::timestamptz, now());
  v_default_business uuid;
  v_business uuid;
  v_cache public.sender_triage_cache%rowtype;
begin
  select * into v_num from public.twilio_numbers where id = p_twilio_number_id;
  if not found then
    raise exception 'unknown twilio number %', p_twilio_number_id;
  end if;
  v_user := v_num.user_id;
  v_thread_key := v_channel || ':' || v_phone;

  insert into public.threads (user_id, channel, twilio_number_id, provider_thread_id, subject, last_message_at)
  values (v_user, v_channel, p_twilio_number_id, v_thread_key,
          coalesce(p ->> 'counterparty_name', v_phone), v_sent_at)
  on conflict (twilio_number_id, provider_thread_id) where twilio_number_id is not null
  do update set last_message_at = greatest(threads.last_message_at, excluded.last_message_at)
  returning id into v_thread_id;

  -- contact by phone
  select c.id, c.is_vip into v_contact_id, v_is_vip
  from public.contact_channels ch join public.contacts c on c.id = ch.contact_id
  where ch.user_id = v_user and ch.channel_type = 'phone' and ch.canonical_value = v_phone;
  if v_contact_id is null then
    insert into public.contacts (user_id, display_name, kind)
    values (v_user, coalesce(nullif(p ->> 'counterparty_name', ''), v_phone), 'human')
    returning id into v_contact_id;
    insert into public.contact_channels (user_id, contact_id, channel_type, raw_value, canonical_value)
    values (v_user, v_contact_id, 'phone', v_phone, v_phone)
    on conflict do nothing;
  else
    update public.contacts set last_seen_at = now() where id = v_contact_id;
  end if;

  insert into public.messages (
    user_id, thread_id, contact_id, direction, channel, provider, twilio_number_id,
    provider_message_id, from_name, from_identifier, to_identifiers,
    subject, snippet, body_text, sent_at
  ) values (
    v_user, v_thread_id, v_contact_id, p ->> 'direction', v_channel, 'twilio', p_twilio_number_id,
    p ->> 'provider_message_id',
    coalesce(p ->> 'counterparty_name', ''),
    case when p ->> 'direction' = 'inbound' then v_phone else v_num.phone_e164 end,
    case when p ->> 'direction' = 'inbound' then array[v_num.phone_e164] else array[v_phone] end,
    '', left(coalesce(p ->> 'body', ''), 140), p ->> 'body', v_sent_at
  )
  on conflict (provider, provider_message_id) where provider = 'twilio'
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select * into v_existing from public.queue_items
  where thread_id = v_thread_id
    and state in ('new','needs_attention','snoozed','awaiting_reply','backlog','fyi')
  limit 1;

  if p ->> 'direction' = 'outbound' then
    -- sent through the app => the episode is answered, synchronously
    if v_existing.id is not null then
      perform set_config('app.transition_reason', 'reply_sent_via_app', true);
      perform set_config('app.transition_evidence',
        jsonb_build_object('resolved_by_message_id', v_message_id)::text, true);
      update public.queue_items
      set state = 'responded', resolved_by_message_id = v_message_id, resolved_at = v_sent_at
      where id = v_existing.id;
    end if;
    return jsonb_build_object('status', 'ok', 'message_id', v_message_id);
  end if;

  -- inbound: texts to a personal business line are needs_attention by default
  select id into v_default_business from public.businesses where user_id = v_user and is_default limit 1;
  select * into v_cache from public.sender_triage_cache where user_id = v_user and sender_key = v_phone;
  v_business := coalesce(v_cache.business_id, v_default_business);

  if v_existing.id is not null then
    perform set_config('app.transition_reason', 'new_inbound_message', true);
    update public.queue_items
    set message_count = message_count + 1,
        last_inbound_message_id = v_message_id,
        preview = left(coalesce(p ->> 'body', ''), 140),
        state = case when state in ('awaiting_reply','snoozed') then 'needs_attention' else state end,
        waiting_since = case when state in ('awaiting_reply','snoozed') then now() else waiting_since end
    where id = v_existing.id
    returning id into v_item_id;
  else
    insert into public.queue_items (
      user_id, thread_id, contact_id, business_id, state, category, priority,
      priority_reasons, channel, title, preview, sender_name, sender_identifier,
      is_vip, last_inbound_message_id, sla_due_at
    ) values (
      v_user, v_thread_id, v_contact_id, v_business, 'needs_attention', 'needs_reply',
      greatest(0, least(100, 65 + case when v_is_vip then 25 else 0 end)),
      array['direct message to your business number'],
      v_channel, coalesce(nullif(p ->> 'counterparty_name', ''), v_phone),
      left(coalesce(p ->> 'body', ''), 140),
      coalesce(p ->> 'counterparty_name', ''), v_phone, v_is_vip, v_message_id,
      now() + interval '12 hours'
    ) returning id into v_item_id;
  end if;

  return jsonb_build_object('status', 'ok', 'message_id', v_message_id,
                            'queue_item_id', v_item_id, 'contact_id', v_contact_id);
end;
$$;
revoke all on function public.ingest_twilio_message(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------- model triage application

create or replace function public.apply_model_triage(p_message_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.messages%rowtype;
  v_item public.queue_items%rowtype;
begin
  select * into v_msg from public.messages where id = p_message_id;
  if not found then return; end if;

  if (p ->> 'contact_kind') is not null and v_msg.contact_id is not null then
    update public.contacts set kind = p ->> 'contact_kind'
    where id = v_msg.contact_id and kind = 'unknown';
  end if;

  select * into v_item from public.queue_items
  where last_inbound_message_id = p_message_id
    and state in ('new','needs_attention','fyi','backlog');
  if found then
    perform set_config('app.transition_reason', 'model_triage', true);
    update public.queue_items
    set business_id = coalesce((p ->> 'business_id')::uuid, business_id),
        category = coalesce(p ->> 'category', category),
        priority = coalesce((p ->> 'priority')::int, priority),
        priority_reasons = priority_reasons || coalesce(p ->> 'reason', 'model triage'),
        state = case
          when state in ('new','needs_attention','fyi')
            and (p ->> 'needs_reply')::boolean is false
            and category not in ('urgent') then 'fyi'
          when state in ('new','fyi') and (p ->> 'needs_reply')::boolean then 'needs_attention'
          else state end,
        sla_due_at = case
          when (p ->> 'needs_reply')::boolean and sla_due_at is null
          then now() + interval '2 days' else sla_due_at end
    where id = v_item.id;
  end if;

  -- cache for future messages from this sender (model never overrides user)
  insert into public.sender_triage_cache
    (user_id, sender_key, business_id, category, needs_reply, contact_kind, decided_by)
  values (v_msg.user_id, v_msg.from_identifier, (p ->> 'business_id')::uuid,
          p ->> 'category', (p ->> 'needs_reply')::boolean,
          coalesce(p ->> 'contact_kind', 'unknown'), 'model')
  on conflict (user_id, sender_key) do update
  set business_id = excluded.business_id, category = excluded.category,
      needs_reply = excluded.needs_reply, contact_kind = excluded.contact_kind,
      decided_by = 'model', updated_at = now()
  where sender_triage_cache.decided_by <> 'user';
end;
$$;
revoke all on function public.apply_model_triage(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ sweeps

create or replace function public.run_sla_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.transition_reason', 'snooze_elapsed', true);
  update public.queue_items set state = 'needs_attention', snoozed_until = null
  where state = 'snoozed' and snoozed_until <= now();

  perform set_config('app.transition_reason', 'follow_up_due_nudge', true);
  update public.queue_items
  set state = 'needs_attention',
      priority_reasons = priority_reasons || 'no reply received — consider a nudge',
      follow_up_at = null,
      waiting_since = now()
  where state = 'awaiting_reply' and follow_up_at <= now();

  update public.queue_items
  set escalated = true,
      priority = least(100, priority + 15),
      priority_reasons = priority_reasons || 'overdue: past its response window'
  where state = 'needs_attention' and not escalated and sla_due_at <= now();
end;
$$;
revoke all on function public.run_sla_sweep() from public, anon, authenticated;

create or replace function public.gmail_poll_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select id from public.gmail_accounts where status = 'active' loop
    perform public.enqueue_and_poke('sync_jobs',
      jsonb_build_object('kind', 'incremental', 'gmail_account_id', r.id, 'source', 'poll_sweep'));
  end loop;
end;
$$;
revoke all on function public.gmail_poll_sweep() from public, anon, authenticated;

create or replace function public.gmail_watch_renewal_sweep()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select id from public.gmail_accounts
    where status = 'active'
      and (watch_expiration is null or watch_expiration < now() + interval '36 hours')
  loop
    perform public.enqueue_and_poke('sync_jobs',
      jsonb_build_object('kind', 'renew_watch', 'gmail_account_id', r.id));
  end loop;
end;
$$;
revoke all on function public.gmail_watch_renewal_sweep() from public, anon, authenticated;

create or replace function public.enqueue_due_digests()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select p.user_id from public.profiles p
    where p.digest_enabled
      and extract(hour from (now() at time zone p.timezone)) = p.digest_hour
      and not exists (
        select 1 from public.digest_log d
        where d.user_id = p.user_id
          and d.sent_on = (now() at time zone p.timezone)::date
      )
  loop
    perform public.enqueue_and_poke('digest_jobs', jsonb_build_object('user_id', r.user_id));
  end loop;
end;
$$;
revoke all on function public.enqueue_due_digests() from public, anon, authenticated;

-- ------------------------------------------------- user-callable utilities

-- Backlog Bankruptcy batch action: clear (and optionally mute) everything in
-- the backlog from one sender, teaching a rule at the same time.
create or replace function public.backlog_sweep_sender(p_sender text, p_mute boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count int;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  perform set_config('app.transition_reason',
    case when p_mute then 'backlog_sweep_mute' else 'backlog_sweep_dismiss' end, true);
  update public.queue_items
  set state = 'dismissed', resolved_at = now()
  where user_id = v_user and state = 'backlog' and sender_identifier = lower(p_sender);
  get diagnostics v_count = row_count;
  if p_mute then
    insert into public.triage_rules (user_id, rule_type, pattern, action, source)
    values (v_user, 'from_email', lower(p_sender), 'suppress', 'learned')
    on conflict (user_id, rule_type, pattern) do update set action = 'suppress', enabled = true;
  end if;
  return v_count;
end;
$$;

-- Jobs health for the Settings panel: queue depths, dead letters, cron runs.
-- Operational metadata only — no tenant data.
create or replace function public.get_jobs_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queues jsonb := '[]'::jsonb;
  q text;
  m record;
  v_cron jsonb;
  v_dead int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  foreach q in array array['sync_jobs','triage_jobs','pipeline_jobs','digest_jobs'] loop
    select * into m from pgmq.metrics(q);
    v_queues := v_queues || jsonb_build_object(
      'queue', q, 'length', m.queue_length,
      'oldest_msg_age_sec', coalesce(extract(epoch from m.oldest_msg_age)::int, 0));
  end loop;
  select count(*) into v_dead from public.jobs_dead where created_at > now() - interval '7 days';
  select coalesce(jsonb_agg(jsonb_build_object(
           'jobname', j.jobname, 'status', d.status, 'start_time', d.start_time)
           order by d.start_time desc), '[]'::jsonb)
  into v_cron
  from cron.job j
  join lateral (
    select * from cron.job_run_details d
    where d.jobid = j.jobid order by d.start_time desc limit 1
  ) d on true;
  return jsonb_build_object('queues', v_queues, 'dead_letters_7d', v_dead, 'cron', v_cron);
end;
$$;

-- RLS coverage assertion used in verification: no public table may lack RLS.
create or replace function public.assert_rls_coverage()
returns table (table_name text, issue text)
language sql
security definer
set search_path = public
as $$
  select c.relname::text, 'RLS disabled'
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
$$;
revoke all on function public.assert_rls_coverage() from public, anon, authenticated;

-- --------------------------------------------------- worker queue claim/ack

create or replace function public.claim_jobs(p_queue text, p_n int, p_vt int)
returns table (msg_id bigint, read_ct int, message jsonb)
language sql
security definer
set search_path = public
as $$
  select m.msg_id, m.read_ct, m.message
  from pgmq.read(p_queue, p_vt, p_n) m;
$$;
revoke all on function public.claim_jobs(text, int, int) from public, anon, authenticated;

create or replace function public.ack_job(p_queue text, p_msg_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  select pgmq.delete(p_queue, p_msg_id);
$$;
revoke all on function public.ack_job(text, bigint) from public, anon, authenticated;

-- Poison-message handling: after too many delivery attempts, park in jobs_dead.
create or replace function public.dead_letter_job(p_queue text, p_msg_id bigint, p_message jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.jobs_dead (queue, msg_id, message, error)
  values (p_queue, p_msg_id, p_message, p_error);
  perform pgmq.delete(p_queue, p_msg_id);
end;
$$;
revoke all on function public.dead_letter_job(text, bigint, jsonb, text) from public, anon, authenticated;

-- --------------------------------------------------------------- grants
-- REVOKE above strips PUBLIC, which would also lock out the service role.
-- Edge functions run as service_role and need these explicitly.

grant execute on function
  public.vault_upsert_secret(text, text),
  public.vault_read_secret(uuid),
  public.get_user_secret(uuid, text),
  public.get_app_config(text),
  public.set_app_config(text, jsonb),
  public.enqueue_and_poke(text, jsonb),
  public.poke_worker(text),
  public.poke_nonempty_queues(),
  public.check_spend(uuid, text, numeric),
  public.record_spend(uuid, text, text, text, int, int, numeric, text, uuid),
  public.ingest_email_message(uuid, jsonb),
  public.ingest_twilio_message(uuid, jsonb),
  public.apply_model_triage(uuid, jsonb),
  public.run_sla_sweep(),
  public.gmail_poll_sweep(),
  public.gmail_watch_renewal_sweep(),
  public.enqueue_due_digests(),
  public.assert_rls_coverage(),
  public.claim_jobs(text, int, int),
  public.ack_job(text, bigint),
  public.dead_letter_job(text, bigint, jsonb, text)
to service_role;
