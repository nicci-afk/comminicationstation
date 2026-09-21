# MCC v2 Phase 1 — repository rebuild vs live production drift audit

Audit date: 2026-09-21

Source branch audited: `mcc-v2/phase1`, created from `claude/message-command-center-0x3qgm` at `146491db3279136299951ec5639e1554d52d90f9`.

Live references were read-only:
- Vercel project: `message-command-center`
- Supabase project: `bgpjpomqrnwsdmrofudb`

## Summary

The repository is the canonical Message Command Center source lineage. Most apparent migration drift is historical-ledger drift: live hotfixes were subsequently folded into existing numbered repository migration files. Two differences affect a clean rebuild's current behavior and therefore require reconciliation before MCC v2 is layered on top.

### Repository behind live schema/current behavior

1. `queue_items_active_thread` predicate.
   - Repo `0003_queue_pipeline.sql`: active-thread unique index does not exclude expense split clones.
   - Live: predicate includes `is_split_clone = false`.
   - Live migration ledger records `fix_active_thread_index_exclude_split_clones`.
   - Reconciliation required.

2. `recategorize_queue_item(uuid,text,uuid)`.
   - Repo `0009_recategorize_rpc.sql`: any nonblank email sender can produce a learned `from_email` rule.
   - Live: excludes variable sender addresses containing `amazon`, `walmart`, or `samsclub`.
   - Live migration ledger records `skip_auto_rule_for_variable_senders`.
   - Reconciliation required.

### Repository ahead of deployed frontend

The current Vercel production deployment was created 2026-08-04 17:53:04 UTC. The source branch contains a later frontend commit `4ece0be71d929501a6df1a2b3092180061a0b967` (2026-08-04 21:27:19 UTC) adding mobile responsive navigation/layout changes. The live production bundle does not contain the `safe-area-pb`/mobile bottom-navigation markers from that commit. No Vercel deployment was performed as part of this work.

### Migration-history-only differences

These live ledger entries do not require reconciliation SQL because their final behavior is already represented in the repository:

- `fix_array_appends` — folded into the patched `0004_rpcs.sql`; the repository commit that captured live hotfixes explicitly records the text-array fixes and VIP coalesce change.
- `fix_get_jobs_health` — final `oldest_msg_age_sec` behavior is already present in `0004_rpcs.sql`.
- `poke_worker_split_function` + `responded_to_awaiting_reply` — consolidated into `0006_hotfixes.sql`.
- `increase_poke_worker_timeout` + `fix_poke_worker_add_auth_header_and_30s_timeout` — consolidated into `0019_poke_worker_timeout.sql`.
- Live migration names do not always equal repository filenames (`core_tenancy` vs `0001_core.sql`, etc.); filename/name differences alone are not schema drift.

### Object audit conclusions

- Tables/columns: no additional current live table/column drift found beyond the index behavior noted above. Live contains the expected 29 public application tables represented by migrations through 0018.
- Constraints: current primary keys, foreign keys, CHECKs and uniques correspond to repository definitions and subsequent numbered alterations.
- Indexes: one verified rebuild difference: `queue_items_active_thread` predicate.
- RLS policies: no current policy-definition drift requiring reconciliation was identified.
- Grants: live table grants largely reflect Supabase platform/default grants plus repository function revokes/grants. No reconciliation grant change is needed to match current behavior. Existing broad function EXECUTE findings are a separate security-hardening concern, not drift to change in this reconciliation.
- Triggers: current application triggers correspond to repository definitions (`on_auth_user_created`, `profiles_touch`, queue transition audit, expense split trigger, etc.); no additional reconciliation required.
- Functions: one verified current behavior difference: `recategorize_queue_item` variable-sender exclusions. `get_jobs_health`, `poke_worker`, array-append fixes and other early hotfix functions already match the repository's final definitions.
- Extensions: repo requires `pgcrypto`, `citext`, `pg_cron`, `pg_net`, and `pgmq`; all are present live. Extension schema placement/version is Supabase-platform managed and is not being changed by reconciliation.

## Minimum reconciliation

`0022_live_schema_reconciliation.sql` changes only the two verified rebuild drifts above. It is idempotent and is intended to be a semantic no-op if ever evaluated against a database already matching live production.

MCC v2 Phase 1 is then placed in `0023_mcc_v2_phase1.sql` without modifying historical Message Command Center tables or importing the historical queue.

## Local validation limitation in this execution environment

The available runtime does not include Docker, PostgreSQL/`psql`, or Supabase CLI, and outbound package installation is unavailable. Therefore a real local PostgreSQL/Supabase replay could not be executed in this session. Deterministic Node/static tests were executed locally; the PostgreSQL integration suite is committed ready to run unchanged once the repo is opened in a normal local Supabase environment.
