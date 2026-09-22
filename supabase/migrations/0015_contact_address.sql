-- Add address field to contacts, update ingest_agentedge_contacts RPC to handle it.

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS address text;

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
        notes        = CASE WHEN coalesce(_contact->>'notes', '') <> '' THEN _contact->>'notes' ELSE notes END,
        address      = CASE WHEN coalesce(_contact->>'address', '') <> '' THEN _contact->>'address' ELSE address END
      WHERE id = _contact_id AND user_id = p_user_id;
      _updated := _updated + 1;
    ELSE
      INSERT INTO public.contacts (user_id, display_name, kind, birthday, notes, address)
      VALUES (
        p_user_id,
        coalesce(nullif(_contact->>'display_name', ''), 'Unknown'),
        'human',
        nullif(_contact->>'birthday', '')::date,
        coalesce(_contact->>'notes', ''),
        nullif(_contact->>'address', '')
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
