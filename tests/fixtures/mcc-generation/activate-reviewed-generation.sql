-- LOCAL REVIEW TEMPLATE ONLY. Requires separately approved execution.
-- psql variables observed_cutoff and approved_reason must be supplied from the
-- successful fresh preflight, never guessed. Native concurrency/PostgREST CI,
-- exact API+workers read-back, and maintenance gates are external prerequisites.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
select set_config('app.mcc_expected_cutoff', :'observed_cutoff', true);
select set_config('app.mcc_change_reason', :'approved_reason', true);
do $$
declare v mcc_sync_internal.control%rowtype;
begin
  select * into strict v from mcc_sync_internal.control where singleton for update;
  if v.generation <> 'gmail-sync-checkpoints-g1' or v.enabled
     or v.legacy_claim_cutoff <> current_setting('app.mcc_expected_cutoff')::timestamptz
     or clock_timestamp() < v.legacy_claim_cutoff + interval '400 seconds'
     or nullif(current_setting('app.mcc_change_reason'),'') is null then
    raise exception 'activation preconditions do not match';
  end if;
  update mcc_sync_internal.control set enabled=true,activated_at=clock_timestamp()
  where singleton and generation=v.generation and not enabled;
  if not found then raise exception 'activation changed no row';end if;
end;
$$;
select singleton,generation,enabled,legacy_claim_cutoff,activated_at from mcc_sync_internal.control;
commit;
-- No cron poke, enqueue, credential change, or automatic restoration.
