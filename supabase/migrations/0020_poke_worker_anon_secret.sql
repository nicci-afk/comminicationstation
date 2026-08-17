-- poke_worker: send the anon key as x-worker-secret instead of the vault
-- secret.  The Edge Function's requireWorkerAuth now checks
-- SUPABASE_ANON_KEY (auto-injected env var) as a fast path so no DB
-- round-trips are needed during auth — eliminating the 3-minute PostgREST
-- hang that prevented jobs from ever being claimed.
--
-- Security note: the anon key is semi-public (embedded in the frontend).
-- WORKER_SECRET (a dedicated Supabase function secret) takes precedence in
-- requireWorkerAuth whenever it is set.

CREATE OR REPLACE FUNCTION public.poke_worker(p_queue text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base  text := public.get_app_config('workers_base_url') ->> 'url';
  v_anon  text := public.get_app_config('anon_key') ->> 'key';
  v_fn    text;
BEGIN
  IF v_base IS NULL OR v_anon IS NULL THEN
    RETURN;
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
      'x-worker-secret', v_anon
    ),
    body    := jsonb_build_object('queue', p_queue),
    timeout_milliseconds := 30000
  );
END;
$$;
