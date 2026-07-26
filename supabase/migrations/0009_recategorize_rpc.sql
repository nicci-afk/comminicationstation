-- recategorize_queue_item: let the user override category + business for a
-- queue item and simultaneously upsert a from_email triage rule so future
-- messages from the same sender are pre-routed correctly.

CREATE OR REPLACE FUNCTION public.recategorize_queue_item(
  p_queue_item_id uuid,
  p_category      text,
  p_business_id   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item record;
BEGIN
  SELECT user_id, sender_identifier, channel
  INTO   v_item
  FROM   queue_items
  WHERE  id = p_queue_item_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue item not found';
  END IF;

  UPDATE queue_items
  SET    category   = p_category,
         business_id = p_business_id,
         updated_at  = now()
  WHERE  id = p_queue_item_id;

  -- Only create a from_email rule for email messages; SMS/WhatsApp identifiers
  -- are phone numbers which don't map to the from_email rule_type.
  IF v_item.channel = 'email'
     AND v_item.sender_identifier IS NOT NULL
     AND v_item.sender_identifier <> ''
  THEN
    INSERT INTO triage_rules
      (user_id, rule_type, pattern, business_id, category, source, enabled)
    VALUES
      (auth.uid(), 'from_email', lower(v_item.sender_identifier),
       p_business_id, p_category, 'user', true)
    ON CONFLICT (user_id, rule_type, pattern)
    DO UPDATE SET
      business_id = EXCLUDED.business_id,
      category    = EXCLUDED.category,
      enabled     = true;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recategorize_queue_item(uuid, text, uuid) TO authenticated;
