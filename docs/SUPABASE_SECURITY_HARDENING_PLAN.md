# Supabase Security Hardening Plan

Status: PREPARED — NOT APPLIED TO PRODUCTION

## Scope
This plan addresses pre-existing Supabase Database Advisor warnings discovered during the MCC Safety Layer preflight.

It is intentionally separate from:
- the MCC Safety Layer migration
- extension relocation
- password-plan upgrades
- unrelated schema cleanup

## Verified findings

### SECURITY DEFINER functions
Eight `public` functions are owned by `postgres` and currently executable by `anon` and `authenticated` through inherited/default EXECUTE privileges.

#### Trigger-only functions
These are attached to database triggers and do not need direct RPC exposure:
- `auto_expense_split()`
- `handle_new_user()`
- `log_queue_transition()`

Proposed hardening:
- revoke EXECUTE from PUBLIC, anon, authenticated
- preserve service-role/postgres execution
- do not alter SECURITY DEFINER semantics in this pass

#### Signed-in user RPCs
These are used by the current web app and contain authenticated-user ownership checks:
- `backlog_sweep_sender(text, boolean)`
- `recategorize_queue_item(uuid, text, uuid)`
- `set_user_secret(text, text)`
- `split_queue_item_for_businesses(uuid, uuid[], text, text, uuid[])`
- `get_jobs_health()`

Proposed hardening:
- revoke EXECUTE from PUBLIC and anon
- explicitly grant EXECUTE to authenticated
- explicitly preserve service_role
- do not broaden any data-table policy

### RLS-enabled tables with no policies
Advisor reports:
- `allowed_emails`
- `app_config`
- `jobs_dead`
- `oauth_states`
- `webhook_events`

Read-only inspection verified that generic table privileges exist for anon/authenticated, but RLS is enabled and no policies exist. Therefore ordinary Data API access is fail-closed.

Proposed action for this phase:
- do not add permissive policies merely to silence the advisor
- leave these tables unchanged until each intended access model is separately reviewed

### Extensions in public
Advisor reports `citext` and `pg_net` in `public`.

Proposed action:
- defer
- extension moves require dependency analysis and their own tested migration

### Leaked password protection
Supabase reports leaked-password protection disabled.
Current Supabase documentation states this feature is available on Pro plan and above.

Proposed action:
- do not purchase/upgrade automatically
- record as a security enhancement option only

## Exact permission hardening intent

The hardening draft in `scripts/supabase_security_hardening_draft.sql` is PREP ONLY.
It must not be run in production without a new RED-action approval.

Expected production impact if later approved:
- 8 functions lose anonymous/public RPC execution
- 5 signed-in RPCs remain explicitly executable by authenticated users
- 3 trigger functions remain operational as triggers but are no longer directly callable by browser roles
- no rows modified
- no tables dropped
- no RLS policies added/removed
- no secrets changed
- no extensions moved
- no external communication
- no booking or financial actions

## Pre-production validation requirements
1. Local migration/test environment passes.
2. Current browser RPC call sites are verified for the five signed-in RPCs.
3. Trigger definitions for the three trigger-only functions are verified.
4. Permission assertions pass before and after the draft migration in isolation.
5. Full MCC deterministic suite passes.
6. Supabase security advisor is rerun in the isolated/test environment where supported.
7. Exact production change receipt is prepared.
8. Nicci explicitly approves the exact production hardening change.

## Post-change verification if later approved
- all 8 functions: anon EXECUTE = false
- trigger-only functions: authenticated EXECUTE = false
- five user RPCs: authenticated EXECUTE = true
- service_role execution retained
- trigger count/names unchanged
- web app signed-in RPC flows smoke-tested
- signup trigger behavior verified
- queue transition trigger behavior verified
- expense split trigger behavior verified
- advisor warnings rechecked
- no unexpected runtime errors
