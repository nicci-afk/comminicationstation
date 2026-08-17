-- Fix poke_worker: send vault secret as x-worker-secret when configured
-- (matches WORKER_SECRET Supabase function secret set via dashboard),
-- falling back to anon key only when no vault secret is configured
-- (matches requireWorkerAuth fast-path 2 / SUPABASE_ANON_KEY).
--
-- Migration 0020 changed to anon-key-only, breaking auth when WORKER_SECRET
-- is set as a Supabase function secret. The vault read here is a direct
-- Postgres call (no PostgREST round-trip) so it is fast and does not hang.

CREATE OR REPLACE FUNCTION public.poke_worker(p_queue text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base    text := public.get_app_config('workers_base_url') ->> 'url';
  v_anon    text := public.get_app_config('anon_key') ->> 'key';
  v_sec_id  uuid := (public.get_app_config('worker_secret_vault_id') ->> 'id')::uuid;
  v_secret  text;
  v_fn      text;
BEGIN
  IF v_base IS NULL OR v_anon IS NULL THEN
    RETURN;
  END IF;
  -- Prefer vault secret (matches WORKER_SECRET env var in Edge Function).
  -- Fall back to anon key when vault not configured.
  IF v_sec_id IS NOT NULL THEN
    v_secret := public.vault_read_secret(v_sec_id);
  END IF;
  IF v_secret IS NULL THEN
    v_secret := v_anon;
  END IF;
  v_fn := CASE p_queue
    WHEN 'sync_jobs'     THEN 'gmail-sync-worker'
    WHEN 'triage_jobs'   THEN 'triage-worker'
    WHEN 'pipeline_jobs' THEN 'pipeline-worker'
    WHEN 'digest_jobs'   THEN 'digest-worker'
    ELSE NULL
  END;
  IF v_fn IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url     := v_base || '/' || v_fn,
    headers := jsonb_build_object(
      'Content-Type',    'application/json',
      'Authorization',   'Bearer ' || v_anon,
      'x-worker-secret', v_secret
    ),
    body    := jsonb_build_object('queue', p_queue),
    timeout_milliseconds := 30000
  );
END;
$$;
