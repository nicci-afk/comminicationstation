-- Fix poke_worker: restore Authorization header (lost in earlier patch) and
-- increase timeout from 5000ms to 30000ms so the function has time to complete
-- vault reads (~13-21s) before pg_net disconnects.

CREATE OR REPLACE FUNCTION public.poke_worker(p_queue text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base      text := public.get_app_config('workers_base_url') ->> 'url';
  v_anon      text := public.get_app_config('anon_key') ->> 'key';
  v_secret_id uuid := (public.get_app_config('worker_secret_vault_id') ->> 'id')::uuid;
  v_secret    text;
  v_fn        text;
BEGIN
  IF v_base IS NULL OR v_anon IS NULL OR v_secret_id IS NULL THEN
    RETURN;
  END IF;
  v_secret := public.vault_read_secret(v_secret_id);
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
