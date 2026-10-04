-- LOCAL REVIEW TEMPLATE ONLY. Pauses claims and sync mutations; retains API
-- intake and queue data. A separately approved recovery decision is required.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
select set_config('app.mcc_change_reason', :'approved_reason', true);
do $$
begin
  if nullif(current_setting('app.mcc_change_reason'),'') is null then raise exception 'missing pause reason';end if;
  update mcc_sync_internal.control set enabled=false
  where singleton and generation='gmail-sync-checkpoints-g1' and enabled;
  if not found then raise exception 'pause target changed or already paused; inspect before retry';end if;
end;
$$;
select singleton,generation,enabled,legacy_claim_cutoff,activated_at from mcc_sync_internal.control;
commit;
