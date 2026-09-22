-- Add relay tracking column to queue_items so each item is only forwarded once.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS agentedge_relayed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_queue_items_relay_pending
  ON queue_items (created_at)
  WHERE agentedge_relayed_at IS NULL
    AND category IN ('booking','bdm','possible_supplier','promotion')
    AND state <> 'backlog';

-- Schedule the relay worker every 15 minutes.
-- The worker reads the secret itself; we just pass the worker_secret header
-- which the pg_net call reads from app config at runtime.
SELECT cron.schedule(
  'agentedge-relay-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/api/agentedge-relay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.anon_key'),
      'x-worker-secret', (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = (
          SELECT value->>'id' FROM app_config WHERE key = 'worker_secret_vault_id'
        )
        LIMIT 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
  $$
);
