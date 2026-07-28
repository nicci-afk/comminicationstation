-- Expense split enhancements:
--   1. expense_type + property_ids + is_split_clone on queue_items
--   2. split_business_ids + expense_type on triage_rules
--   3. properties table (GHR Real Estate etc.)
--   4. split_queue_item_for_businesses SECURITY DEFINER RPC (fixes RLS hole)
--   5. auto_expense_split trigger — future inbound items auto-split on match

-- ── queue_items additions ──────────────────────────────────────────────────
ALTER TABLE public.queue_items
  ADD COLUMN IF NOT EXISTS expense_type    text,
  ADD COLUMN IF NOT EXISTS property_ids    uuid[],
  ADD COLUMN IF NOT EXISTS is_split_clone  boolean NOT NULL DEFAULT false;

-- ── triage_rules additions ─────────────────────────────────────────────────
ALTER TABLE public.triage_rules
  ADD COLUMN IF NOT EXISTS split_business_ids uuid[],
  ADD COLUMN IF NOT EXISTS expense_type       text;

-- ── properties table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.properties (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  business_id uuid        NOT NULL REFERENCES public.businesses(id)    ON DELETE CASCADE,
  name        text        NOT NULL,
  address     text,
  active      boolean     NOT NULL DEFAULT true,
  sort_order  int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id, name)
);
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY properties_all ON public.properties
  FOR ALL USING (user_id = (SELECT auth.uid()));

-- ── split_queue_item_for_businesses (replaces broken direct INSERT) ─────────
-- SECURITY DEFINER so it can INSERT clone rows bypassing the no-INSERT RLS on
-- queue_items.  Verifies caller owns the item before touching anything.
CREATE OR REPLACE FUNCTION public.split_queue_item_for_businesses(
  p_queue_item_id  uuid,
  p_business_ids   uuid[],
  p_category       text,
  p_expense_type   text    DEFAULT NULL,
  p_property_ids   uuid[]  DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item        queue_items%ROWTYPE;
  v_user        uuid := auth.uid();
  v_biz         uuid;
  v_n           int;
  v_split_label text;
BEGIN
  IF p_business_ids IS NULL OR array_length(p_business_ids, 1) = 0 THEN
    RAISE EXCEPTION 'p_business_ids must not be empty';
  END IF;

  v_n           := array_length(p_business_ids, 1);
  v_split_label := '1/' || v_n || ' split';

  -- Verify caller owns this item
  SELECT * INTO v_item FROM public.queue_items
  WHERE id = p_queue_item_id AND user_id = v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue item not found or access denied';
  END IF;

  -- Update original → first business
  UPDATE public.queue_items SET
    category     = p_category,
    business_id  = p_business_ids[1],
    expense_type = p_expense_type,
    property_ids = p_property_ids,
    priority_reasons = CASE
      WHEN v_n > 1 THEN
        array_append(
          COALESCE(
            ARRAY(SELECT r FROM unnest(priority_reasons) r WHERE r NOT LIKE '1/%'),
            '{}'::text[]
          ),
          v_split_label
        )
      ELSE
        COALESCE(
          ARRAY(SELECT r FROM unnest(priority_reasons) r WHERE r NOT LIKE '1/%'),
          '{}'::text[]
        )
      END
  WHERE id = p_queue_item_id;

  -- Upsert triage rule for email senders only
  IF v_item.sender_identifier IS NOT NULL AND v_item.channel = 'email' THEN
    INSERT INTO public.triage_rules
      (user_id, rule_type, pattern, business_id, category, source, enabled,
       split_business_ids, expense_type)
    VALUES
      (v_user, 'from_email', lower(v_item.sender_identifier),
       p_business_ids[1], p_category, 'user', true,
       CASE WHEN v_n > 1 THEN p_business_ids ELSE NULL END,
       p_expense_type)
    ON CONFLICT (user_id, rule_type, pattern)
    DO UPDATE SET
      business_id        = EXCLUDED.business_id,
      category           = EXCLUDED.category,
      enabled            = true,
      split_business_ids = EXCLUDED.split_business_ids,
      expense_type       = EXCLUDED.expense_type;
  END IF;

  -- Insert clone items for businesses 2..N
  IF v_n > 1 THEN
    FOREACH v_biz IN ARRAY p_business_ids[2:] LOOP
      INSERT INTO public.queue_items (
        user_id, thread_id, contact_id, business_id, category,
        state, priority, channel, sender_name, sender_identifier,
        title, preview, priority_reasons,
        expense_type, property_ids, is_split_clone
      ) VALUES (
        v_user, v_item.thread_id, v_item.contact_id, v_biz, p_category,
        v_item.state, v_item.priority, v_item.channel,
        v_item.sender_name, v_item.sender_identifier,
        v_item.title, v_item.preview, ARRAY[v_split_label],
        p_expense_type, p_property_ids, true
      );
    END LOOP;
  END IF;
END;
$$;

-- ── auto_expense_split trigger ─────────────────────────────────────────────
-- Fires AFTER INSERT on queue_items.  When a matching split rule exists for
-- the sender, auto-creates the clone items so future expenses self-split.
CREATE OR REPLACE FUNCTION public.auto_expense_split()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule  triage_rules%ROWTYPE;
  v_biz   uuid;
  v_label text;
BEGIN
  -- Skip clones (prevents recursion), non-expense categories, and items
  -- without a sender identifier (can't match a from_email rule).
  IF NEW.is_split_clone THEN RETURN NEW; END IF;
  IF NEW.category NOT IN ('expense', 'receipt') THEN RETURN NEW; END IF;
  IF NEW.sender_identifier IS NULL THEN RETURN NEW; END IF;

  SELECT r.* INTO v_rule
  FROM public.triage_rules r
  WHERE r.user_id             = NEW.user_id
    AND r.enabled              = true
    AND r.rule_type            = 'from_email'
    AND lower(r.pattern)       = lower(NEW.sender_identifier)
    AND r.split_business_ids  IS NOT NULL
    AND array_length(r.split_business_ids, 1) > 1
  LIMIT 1;

  IF NOT FOUND THEN RETURN NEW; END IF;

  v_label := '1/' || array_length(v_rule.split_business_ids, 1) || ' auto-split';

  -- Stamp the just-inserted item with the split label + expense type
  UPDATE public.queue_items SET
    business_id      = v_rule.split_business_ids[1],
    expense_type     = COALESCE(NEW.expense_type, v_rule.expense_type),
    priority_reasons = COALESCE(NEW.priority_reasons, '{}') || ARRAY[v_label]
  WHERE id = NEW.id;

  -- Create clone rows for businesses 2..N
  FOREACH v_biz IN ARRAY v_rule.split_business_ids[2:] LOOP
    INSERT INTO public.queue_items (
      user_id, thread_id, contact_id, business_id, category,
      state, priority, channel, sender_name, sender_identifier,
      title, preview, priority_reasons, expense_type, is_split_clone
    ) VALUES (
      NEW.user_id, NEW.thread_id, NEW.contact_id, v_biz, NEW.category,
      NEW.state, NEW.priority, NEW.channel,
      NEW.sender_name, NEW.sender_identifier,
      NEW.title, NEW.preview, ARRAY[v_label],
      COALESCE(NEW.expense_type, v_rule.expense_type),
      true
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_expense_split ON public.queue_items;
CREATE TRIGGER trg_auto_expense_split
  AFTER INSERT ON public.queue_items
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_expense_split();
