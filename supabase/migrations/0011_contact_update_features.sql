-- Contact update features:
--   1. Reply-To auto-discovery in ingest_email_message — silently adds a
--      sender's Reply-To address as an additional contact channel whenever it
--      differs from the From address (on conflict do nothing).
--   2. ingest_agentedge_contacts RPC — batch merge of AgentEdge CRM contacts
--      into the command center, callable only via service-role (edge function).

-- ── 1. Updated ingest_email_message (adds Reply-To discovery) ─────────────────

CREATE OR REPLACE FUNCTION public.ingest_email_message(p_gmail_account_id uuid, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
BEGIN
  SELECT * INTO v_acct FROM public.gmail_accounts WHERE id = p_gmail_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown gmail account %', p_gmail_account_id;
  END IF;
  v_user := v_acct.user_id;

  -- thread upsert
  INSERT INTO public.threads (user_id, channel, gmail_account_id, provider_thread_id, subject, last_message_at)
  VALUES (v_user, 'email', p_gmail_account_id, p ->> 'thread_provider_id',
          coalesce(p ->> 'subject', ''), v_sent_at)
  ON CONFLICT (gmail_account_id, provider_thread_id) WHERE gmail_account_id IS NOT NULL
  DO UPDATE SET last_message_at = greatest(threads.last_message_at, excluded.last_message_at),
               subject = CASE WHEN threads.subject = '' THEN excluded.subject ELSE threads.subject END
  RETURNING id INTO v_thread_id;

  -- contact upsert (inbound sender only)
  IF v_direction = 'inbound' AND v_from <> '' THEN
    SELECT c.id, c.kind, c.is_vip INTO v_contact_id, v_contact_kind, v_is_vip
    FROM public.contact_channels ch
    JOIN public.contacts c ON c.id = ch.contact_id
    WHERE ch.user_id = v_user AND ch.channel_type = 'email' AND ch.canonical_value = v_from;
    v_is_vip := coalesce(v_is_vip, false);
    IF v_contact_id IS NULL THEN
      INSERT INTO public.contacts (user_id, display_name, kind)
      VALUES (v_user, coalesce(nullif(p ->> 'from_name', ''), v_from),
              CASE WHEN v_is_bulk THEN 'automated' ELSE 'unknown' END)
      RETURNING id, kind INTO v_contact_id, v_contact_kind;
      INSERT INTO public.contact_channels (user_id, contact_id, channel_type, raw_value, canonical_value)
      VALUES (v_user, v_contact_id, 'email', coalesce(p ->> 'from_identifier', ''), v_from)
      ON CONFLICT DO NOTHING;
    ELSE
      UPDATE public.contacts SET last_seen_at = now() WHERE id = v_contact_id;
    END IF;

    -- Auto-discover Reply-To address as an additional email channel.
    -- Silently adds it if it differs from From; safe to re-run (on conflict do nothing).
    INSERT INTO public.contact_channels (user_id, contact_id, channel_type, raw_value, canonical_value)
    SELECT v_user, v_contact_id, 'email', rt.addr, rt.addr
    FROM (
      SELECT lower(trim(
        CASE WHEN (h->>'value') ~ '<[^>]+@[^>]+>'
             THEN substring(h->>'value' FROM '<([^>]+@[^>]+)>')
             ELSE trim(h->>'value') END
      )) AS addr
      FROM jsonb_array_elements(coalesce(p->'headers', '[]'::jsonb)) h
      WHERE lower(h->>'name') = 'reply-to'
      LIMIT 1
    ) rt
    WHERE rt.addr <> '' AND rt.addr <> v_from AND rt.addr LIKE '%@%'
    ON CONFLICT DO NOTHING;
  END IF;

  -- message insert (dedupe on provider id)
  INSERT INTO public.messages (
    user_id, thread_id, contact_id, direction, channel, provider, gmail_account_id,
    provider_message_id, rfc822_message_id, in_reply_to, references_ids,
    from_name, from_identifier, to_identifiers, cc_identifiers,
    subject, snippet, body_text, sent_at, labels, is_unread, headers
  ) VALUES (
    v_user, v_thread_id, v_contact_id, v_direction, 'email', 'gmail', p_gmail_account_id,
    p ->> 'provider_message_id', p ->> 'rfc822_message_id', p ->> 'in_reply_to',
    coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(p -> 'references_ids') x), '{}'),
    coalesce(p ->> 'from_name', ''), v_from,
    coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'to_identifiers') x), '{}'),
    coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'cc_identifiers') x), '{}'),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'snippet', ''), p ->> 'body_text',
    v_sent_at,
    coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(p -> 'labels') x), '{}'),
    coalesce((p ->> 'is_unread')::boolean, false),
    coalesce(p -> 'headers', '{}'::jsonb)
  )
  ON CONFLICT (gmail_account_id, provider_message_id) WHERE gmail_account_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  -- ============================================ outbound: responded detection
  IF v_direction = 'outbound' THEN
    PERFORM set_config('app.transition_reason', 'reply_observed', true);
    FOR v_existing IN
      SELECT qi.* FROM public.queue_items qi
      JOIN public.messages li ON li.id = qi.last_inbound_message_id
      WHERE qi.user_id = v_user
        AND qi.state IN ('new', 'needs_attention', 'snoozed', 'backlog', 'fyi')
        AND li.sent_at < v_sent_at
        AND (
          qi.thread_id = v_thread_id
          OR (li.rfc822_message_id IS NOT NULL AND li.rfc822_message_id = p ->> 'in_reply_to')
          OR (li.rfc822_message_id IS NOT NULL
              AND li.rfc822_message_id = ANY (
                coalesce((SELECT array_agg(x) FROM jsonb_array_elements_text(p -> 'references_ids') x), '{}')))
        )
    LOOP
      IF EXISTS (
        SELECT 1 FROM public.messages li
        WHERE li.id = v_existing.last_inbound_message_id
          AND li.from_identifier = ANY (
            coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'to_identifiers') x), '{}')
            || coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'cc_identifiers') x), '{}')
          )
      ) THEN
        PERFORM set_config('app.transition_evidence',
          jsonb_build_object('resolved_by_message_id', v_message_id,
                             'rfc822_message_id', p ->> 'rfc822_message_id',
                             'sent_at', p ->> 'sent_at')::text, true);
        UPDATE public.queue_items
        SET state = 'responded',
            resolved_by_message_id = v_message_id,
            resolved_at = v_sent_at
        WHERE id = v_existing.id;
      ELSE
        INSERT INTO public.queue_item_events
          (user_id, queue_item_id, from_state, to_state, actor, reason, evidence)
        VALUES (v_user, v_existing.id, v_existing.state, v_existing.state, 'system',
                'forward_observed_not_reply',
                jsonb_build_object('message_id', v_message_id));
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'ok', 'message_id', v_message_id, 'direction', 'outbound');
  END IF;

  -- ============================================ inbound: deterministic triage
  SELECT id INTO v_default_business FROM public.businesses
  WHERE user_id = v_user AND is_default LIMIT 1;

  -- rule matching, most-specific wins for business/category/action
  FOR v_rule IN
    SELECT r.*,
      CASE r.rule_type
        WHEN 'from_email' THEN 1 WHEN 'to_email' THEN 2
        WHEN 'from_domain' THEN 3 WHEN 'subject_contains' THEN 4 END AS specificity
    FROM public.triage_rules r
    WHERE r.user_id = v_user AND r.enabled
      AND (
        (r.rule_type = 'from_email' AND lower(r.pattern) = v_from)
        OR (r.rule_type = 'from_domain' AND v_from LIKE '%@' || lower(r.pattern))
        OR (r.rule_type = 'to_email' AND lower(r.pattern) = ANY (
              coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'to_identifiers') x), '{}')))
        OR (r.rule_type = 'subject_contains' AND position(lower(r.pattern) IN lower(coalesce(p ->> 'subject', ''))) > 0)
      )
    ORDER BY specificity
  LOOP
    v_business  := coalesce(v_business,  v_rule.business_id);
    v_category  := coalesce(v_category,  v_rule.category);
    v_action    := coalesce(v_action,    v_rule.action);
    v_priority  := v_priority + v_rule.priority_delta;
    IF v_rule.priority_delta <> 0 THEN
      v_reasons := v_reasons || format('rule %s:%s (%s)', v_rule.rule_type, v_rule.pattern, v_rule.priority_delta);
    END IF;
    IF v_rule.mark_vip THEN v_is_vip := true; END IF;
    v_rules_decided := true;
  END LOOP;

  -- sender cache (never overrides an explicit rule)
  SELECT * INTO v_cache FROM public.sender_triage_cache
  WHERE user_id = v_user AND sender_key = v_from;
  IF FOUND THEN
    v_business := coalesce(v_business, v_cache.business_id);
    v_category := coalesce(v_category, v_cache.category);
    IF v_cache.contact_kind IS NOT NULL AND v_contact_kind = 'unknown' THEN
      UPDATE public.contacts SET kind = v_cache.contact_kind WHERE id = v_contact_id;
      v_contact_kind := v_cache.contact_kind;
    END IF;
  END IF;

  -- single-business contacts inherit that business
  IF v_business IS NULL AND v_contact_id IS NOT NULL THEN
    SELECT min(business_id::text)::uuid INTO v_business
    FROM public.contact_business_links
    WHERE contact_id = v_contact_id
    HAVING count(DISTINCT business_id) = 1;
  END IF;

  v_direct := lower(v_acct.email_address::text) = ANY (
    coalesce((SELECT array_agg(lower(x)) FROM jsonb_array_elements_text(p -> 'to_identifiers') x), '{}'));

  -- category default
  IF v_category IS NULL THEN
    IF v_is_bulk THEN
      v_category := coalesce(nullif(p -> 'bulk' ->> 'suggested_category', ''), 'newsletter');
    ELSIF v_direct AND coalesce(v_contact_kind, 'unknown') IN ('human', 'unknown') THEN
      v_category := 'needs_reply';
    ELSE
      v_category := 'other';
    END IF;
  END IF;

  -- state decision
  IF v_backlog THEN
    v_state := 'backlog';
  ELSIF v_action = 'suppress' THEN
    v_state := 'suppressed';
  ELSIF v_action = 'fyi' OR v_is_bulk THEN
    v_state := 'fyi';
  ELSIF v_action = 'needs_attention' THEN
    v_state := 'needs_attention';
  ELSIF v_category IN (
    'needs_reply', 'urgent', 'scheduling',
    'booking', 'lead', 'agent_to_agent', 'lender', 'title'
  ) THEN
    v_state := 'needs_attention';
  ELSE
    v_state := 'fyi';
  END IF;

  -- priority scoring (base 50, clamped 0..100, reasons recorded for trust UX)
  IF v_is_vip THEN
    v_priority := v_priority + 25;
    v_reasons  := v_reasons || array['VIP contact'];
  END IF;
  IF v_contact_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.contacts WHERE id = v_contact_id AND active_client
  ) THEN
    v_priority := v_priority + 20;
    v_reasons  := v_reasons || array['active client'];
  END IF;
  IF v_direct THEN
    v_priority := v_priority + 10;
    v_reasons  := v_reasons || array['addressed directly to you'];
  END IF;
  v_priority := v_priority + CASE v_category
    WHEN 'urgent'            THEN  20
    WHEN 'needs_reply'       THEN  10
    WHEN 'booking'           THEN  15
    WHEN 'lead'              THEN  15
    WHEN 'lender'            THEN  12
    WHEN 'title'             THEN  12
    WHEN 'agent_to_agent'    THEN  10
    WHEN 'scheduling'        THEN   8
    WHEN 'bdm'               THEN   5
    WHEN 'possible_supplier' THEN   5
    WHEN 'promotion'         THEN -25
    WHEN 'newsletter'        THEN -25
    WHEN 'notification'      THEN -15
    WHEN 'receipt'           THEN -10
    WHEN 'expense'           THEN  -5
    ELSE 0 END;
  IF v_category NOT IN ('fyi', 'notification', 'newsletter', 'promotion', 'other') THEN
    v_reasons := v_reasons || ('category: ' || v_category);
  END IF;
  IF v_business IS NOT NULL THEN
    v_priority := v_priority + coalesce(
      (SELECT priority_weight FROM public.businesses WHERE id = v_business), 0);
  END IF;
  v_priority := greatest(0, least(100, v_priority));

  -- model triage needed? Only non-bulk attention items whose business/kind rules+cache could not decide.
  v_needs_model := (NOT v_is_bulk)
    AND v_state = 'needs_attention'
    AND NOT v_backlog
    AND (v_business IS NULL OR coalesce(v_contact_kind, 'unknown') = 'unknown')
    AND NOT v_rules_decided
    AND v_cache.id IS NULL;

  -- queue item: reuse the live episode for this thread or open a new one
  SELECT * INTO v_existing FROM public.queue_items
  WHERE thread_id = v_thread_id
    AND state IN ('new', 'needs_attention', 'snoozed', 'awaiting_reply', 'backlog', 'fyi')
  LIMIT 1;

  IF FOUND THEN
    PERFORM set_config('app.transition_reason', 'new_inbound_message', true);
    UPDATE public.queue_items
    SET message_count            = message_count + 1,
        last_inbound_message_id  = v_message_id,
        preview  = coalesce(nullif(p ->> 'snippet', ''), preview),
        title    = CASE WHEN title = '' THEN coalesce(p ->> 'subject', '') ELSE title END,
        priority = greatest(priority, v_priority),
        is_vip   = is_vip OR v_is_vip,
        state    = CASE
                     WHEN state IN ('awaiting_reply', 'snoozed') THEN 'needs_attention'
                     ELSE state END,
        snoozed_until = CASE WHEN state = 'snoozed' THEN NULL ELSE snoozed_until END,
        waiting_since = CASE WHEN state IN ('awaiting_reply', 'snoozed') THEN now() ELSE waiting_since END
    WHERE id = v_existing.id
    RETURNING id INTO v_item_id;
  ELSE
    INSERT INTO public.queue_items (
      user_id, thread_id, contact_id, business_id, state, category, priority,
      priority_reasons, channel, title, preview, sender_name, sender_identifier,
      is_vip, last_inbound_message_id, sla_due_at
    ) VALUES (
      v_user, v_thread_id, v_contact_id, coalesce(v_business, v_default_business),
      v_state, v_category, v_priority, v_reasons, 'email',
      coalesce(p ->> 'subject', ''), coalesce(p ->> 'snippet', ''),
      coalesce(p ->> 'from_name', ''), v_from, v_is_vip, v_message_id,
      CASE WHEN v_state = 'needs_attention'
           THEN now() + CASE WHEN v_priority >= 75 THEN INTERVAL '1 day' ELSE INTERVAL '2 days' END
           END
    ) RETURNING id INTO v_item_id;
  END IF;

  -- cache the decision for this sender (rules-decided only; user always wins)
  IF v_rules_decided AND v_business IS NOT NULL THEN
    INSERT INTO public.sender_triage_cache
      (user_id, sender_key, business_id, category, needs_reply, contact_kind, decided_by)
    VALUES (v_user, v_from, v_business, v_category, v_state = 'needs_attention',
            coalesce(v_contact_kind, 'unknown'), 'rules')
    ON CONFLICT (user_id, sender_key) DO UPDATE
    SET business_id  = excluded.business_id,
        category     = excluded.category,
        needs_reply  = excluded.needs_reply,
        updated_at   = now()
    WHERE sender_triage_cache.decided_by <> 'user';
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok', 'message_id', v_message_id, 'queue_item_id', v_item_id,
    'state', v_state, 'needs_model_triage', v_needs_model,
    'contact_id', v_contact_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_email_message(uuid, jsonb) FROM public, anon, authenticated;


-- ── 2. ingest_agentedge_contacts — batch merge RPC ────────────────────────────
-- Accepts a JSON array of AgentEdge CRM contacts and merges them into the
-- contacts / contact_channels tables for p_user_id. Match priority:
--   1. any email address in contact_channels → update that contact
--   2. exact display_name match (only when no emails) → update that contact
--   3. no match → insert new contact
-- Returns { inserted, updated, total }.
-- Callable only via service-role (REVOKE from public/anon/authenticated).

CREATE OR REPLACE FUNCTION public.ingest_agentedge_contacts(
  p_user_id uuid,
  p_contacts jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _contact jsonb;
  _contact_id uuid;
  _email text;
  _phone text;
  _emails jsonb;
  _phones jsonb;
  _canonical text;
  _inserted int := 0;
  _updated int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'user not found';
  END IF;

  FOR _contact IN SELECT * FROM jsonb_array_elements(p_contacts)
  LOOP
    _contact_id := NULL;
    _emails := coalesce(_contact->'emails', '[]'::jsonb);

    -- match by email first
    FOR _email IN SELECT jsonb_array_elements_text(_emails)
    LOOP
      SELECT cc.contact_id INTO _contact_id
      FROM public.contact_channels cc
      WHERE cc.user_id = p_user_id
        AND cc.channel_type = 'email'
        AND cc.canonical_value = lower(trim(_email))
      LIMIT 1;
      EXIT WHEN _contact_id IS NOT NULL;
    END LOOP;

    -- match by name if contact has no emails
    IF _contact_id IS NULL AND jsonb_array_length(_emails) = 0 THEN
      SELECT c.id INTO _contact_id
      FROM public.contacts c
      WHERE c.user_id = p_user_id
        AND lower(c.display_name) = lower((_contact->>'display_name')::text)
      LIMIT 1;
    END IF;

    IF _contact_id IS NOT NULL THEN
      UPDATE public.contacts SET
        display_name = CASE WHEN coalesce(_contact->>'display_name', '') <> '' THEN _contact->>'display_name' ELSE display_name END,
        birthday     = CASE WHEN (_contact->>'birthday') IS NOT NULL THEN (_contact->>'birthday')::date ELSE birthday END,
        notes        = CASE WHEN coalesce(_contact->>'notes', '') <> '' THEN _contact->>'notes' ELSE notes END
      WHERE id = _contact_id AND user_id = p_user_id;
      _updated := _updated + 1;
    ELSE
      INSERT INTO public.contacts (user_id, display_name, kind, birthday, notes)
      VALUES (
        p_user_id,
        coalesce(nullif(_contact->>'display_name', ''), 'Unknown'),
        'human',
        nullif(_contact->>'birthday', '')::date,
        coalesce(_contact->>'notes', '')
      )
      RETURNING id INTO _contact_id;
      _inserted := _inserted + 1;
    END IF;

    -- upsert email channels
    FOR _email IN SELECT jsonb_array_elements_text(_emails)
    LOOP
      INSERT INTO public.contact_channels (contact_id, user_id, channel_type, raw_value, canonical_value)
      VALUES (_contact_id, p_user_id, 'email', lower(trim(_email)), lower(trim(_email)))
      ON CONFLICT (user_id, channel_type, canonical_value) DO NOTHING;
    END LOOP;

    -- upsert phone channels
    _phones := coalesce(_contact->'phones', '[]'::jsonb);
    FOR _phone IN SELECT jsonb_array_elements_text(_phones)
    LOOP
      _canonical := regexp_replace(_phone, '[\s\-\(\)\.]', '', 'g');
      IF length(regexp_replace(_canonical, '[^0-9]', '', 'g')) > 3 THEN
        INSERT INTO public.contact_channels (contact_id, user_id, channel_type, raw_value, canonical_value)
        VALUES (_contact_id, p_user_id, 'phone', _phone, _canonical)
        ON CONFLICT (user_id, channel_type, canonical_value) DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('inserted', _inserted, 'updated', _updated, 'total', _inserted + _updated);
END;
$$;
REVOKE ALL ON FUNCTION public.ingest_agentedge_contacts(uuid, jsonb) FROM public, anon, authenticated;
