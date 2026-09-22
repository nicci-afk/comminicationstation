-- 0008: expanded categories, active_client contact flag, businesses + routing rules.
-- Also updates ingest_email_message and apply_model_triage to handle new categories.

-- ── 1. Expand category CHECK on triage_rules ────────────────────────────────
ALTER TABLE public.triage_rules
  DROP CONSTRAINT IF EXISTS triage_rules_category_check;

ALTER TABLE public.triage_rules
  ADD CONSTRAINT triage_rules_category_check CHECK (category IN (
    'needs_reply', 'fyi', 'promotion', 'expense', 'receipt', 'notification',
    'newsletter', 'scheduling', 'urgent', 'booking', 'bdm', 'possible_supplier',
    'lead', 'agent_to_agent', 'lender', 'title', 'other'
  ));

-- ── 2. active_client flag on contacts ───────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS active_client boolean NOT NULL DEFAULT false;

-- ── 3. Businesses + routing rules for the account owner ─────────────────────
DO $$
DECLARE
  v_user uuid;
  v_tid  uuid;   -- Travel GHR
  v_re1  uuid;   -- NicciG Real Estate
  v_re2  uuid;   -- GHR Real Estate LLC
BEGIN
  SELECT user_id INTO v_user
  FROM public.profiles WHERE email = 'nicci@travelghr.com';
  IF v_user IS NULL THEN RETURN; END IF;

  INSERT INTO public.businesses (user_id, name, color, priority_weight)
  VALUES (v_user, 'Travel GHR', '#0ea5e9', 5)
  ON CONFLICT (user_id, name) DO NOTHING;
  SELECT id INTO v_tid FROM public.businesses WHERE user_id = v_user AND name = 'Travel GHR';

  INSERT INTO public.businesses (user_id, name, color, priority_weight)
  VALUES (v_user, 'NicciG Real Estate', '#10b981', 5)
  ON CONFLICT (user_id, name) DO NOTHING;
  SELECT id INTO v_re1 FROM public.businesses WHERE user_id = v_user AND name = 'NicciG Real Estate';

  INSERT INTO public.businesses (user_id, name, color, priority_weight)
  VALUES (v_user, 'GHR Real Estate LLC', '#f59e0b', 5)
  ON CONFLICT (user_id, name) DO NOTHING;
  SELECT id INTO v_re2 FROM public.businesses WHERE user_id = v_user AND name = 'GHR Real Estate LLC';

  -- Travel GHR accounts: any email received at these addresses → Travel GHR
  INSERT INTO public.triage_rules (user_id, rule_type, pattern, business_id, source)
  VALUES
    (v_user, 'to_email', 'nicci@travelghr.com',     v_tid, 'user'),
    (v_user, 'to_email', 'suppliers@travelghr.com',  v_tid, 'user'),
    (v_user, 'to_email', 'info@travelghr.com',       v_tid, 'user'),
    (v_user, 'to_email', 'tim@travelghr.com',        v_tid, 'user')
  ON CONFLICT (user_id, rule_type, pattern)
  DO UPDATE SET business_id = excluded.business_id;

  -- NicciG Real Estate accounts
  INSERT INTO public.triage_rules (user_id, rule_type, pattern, business_id, source)
  VALUES
    (v_user, 'to_email', 'nicci@nccigrealestate.com', v_re1, 'user'),
    (v_user, 'to_email', 'niccigrealtor@gmail.com',   v_re1, 'user'),
    (v_user, 'to_email', 'soldbyniccig@gmail.com',    v_re1, 'user')
  ON CONFLICT (user_id, rule_type, pattern)
  DO UPDATE SET business_id = excluded.business_id;

  -- GHR Real Estate LLC account
  INSERT INTO public.triage_rules (user_id, rule_type, pattern, business_id, source)
  VALUES
    (v_user, 'to_email', 'nicci@ghrrealestatellc.com', v_re2, 'user')
  ON CONFLICT (user_id, rule_type, pattern)
  DO UPDATE SET business_id = excluded.business_id;
END $$;

-- ── 4. Updated ingest_email_message ─────────────────────────────────────────
-- Changes vs 0004: new category list in state/priority logic; active_client boost.

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
  -- active client: open transaction / active booking → extra urgency boost
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
    WHEN 'urgent'           THEN  20
    WHEN 'needs_reply'      THEN  10
    WHEN 'booking'          THEN  15
    WHEN 'lead'             THEN  15
    WHEN 'lender'           THEN  12
    WHEN 'title'            THEN  12
    WHEN 'agent_to_agent'   THEN  10
    WHEN 'scheduling'       THEN   8
    WHEN 'bdm'              THEN   5
    WHEN 'possible_supplier' THEN  5
    WHEN 'promotion'        THEN -25
    WHEN 'newsletter'       THEN -25
    WHEN 'notification'     THEN -15
    WHEN 'receipt'          THEN -10
    WHEN 'expense'          THEN  -5
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

-- ── 5. Updated apply_model_triage ───────────────────────────────────────────
-- Change: prevent downgrading active-transaction / booking / lead categories to fyi.

CREATE OR REPLACE FUNCTION public.apply_model_triage(p_message_id uuid, p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msg  public.messages%rowtype;
  v_item public.queue_items%rowtype;
BEGIN
  SELECT * INTO v_msg FROM public.messages WHERE id = p_message_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF (p ->> 'contact_kind') IS NOT NULL AND v_msg.contact_id IS NOT NULL THEN
    UPDATE public.contacts SET kind = p ->> 'contact_kind'
    WHERE id = v_msg.contact_id AND kind = 'unknown';
  END IF;

  SELECT * INTO v_item FROM public.queue_items
  WHERE last_inbound_message_id = p_message_id
    AND state IN ('new', 'needs_attention', 'fyi', 'backlog');
  IF FOUND THEN
    PERFORM set_config('app.transition_reason', 'model_triage', true);
    UPDATE public.queue_items
    SET business_id     = coalesce((p ->> 'business_id')::uuid, business_id),
        category        = coalesce(p ->> 'category', category),
        priority        = coalesce((p ->> 'priority')::int, priority),
        priority_reasons = priority_reasons || coalesce(p ->> 'reason', 'model triage'),
        state = CASE
          WHEN state IN ('new', 'needs_attention', 'fyi')
            AND (p ->> 'needs_reply')::boolean IS FALSE
            AND category NOT IN (
              'urgent', 'booking', 'lead', 'agent_to_agent', 'lender', 'title'
            ) THEN 'fyi'
          WHEN state IN ('new', 'fyi') AND (p ->> 'needs_reply')::boolean THEN 'needs_attention'
          ELSE state END,
        sla_due_at = CASE
          WHEN (p ->> 'needs_reply')::boolean AND sla_due_at IS NULL
          THEN now() + INTERVAL '2 days' ELSE sla_due_at END
    WHERE id = v_item.id;
  END IF;

  -- cache for future messages from this sender (model never overrides user)
  INSERT INTO public.sender_triage_cache
    (user_id, sender_key, business_id, category, needs_reply, contact_kind, decided_by)
  VALUES (v_msg.user_id, v_msg.from_identifier, (p ->> 'business_id')::uuid,
          p ->> 'category', (p ->> 'needs_reply')::boolean,
          coalesce(p ->> 'contact_kind', 'unknown'), 'model')
  ON CONFLICT (user_id, sender_key) DO UPDATE
  SET business_id  = excluded.business_id,
      category     = excluded.category,
      needs_reply  = excluded.needs_reply,
      contact_kind = excluded.contact_kind,
      decided_by   = 'model',
      updated_at   = now()
  WHERE sender_triage_cache.decided_by <> 'user';
END;
$$;
