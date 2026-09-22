# Production Change Receipt — MCC Safety Layer

Status: PENDING APPROVAL
Change key: mcc-safety-layer-2026-09-22
Action class: RED
Target system: Supabase + Vercel
Target environment: Production
Prepared against branch: mcc-v2/phase2-seeding
Prepared branch head before this receipt: 981e42cd82aa30e80b375befcb66d8accd628c62

## Requested outcome
Install the fail-closed MCC Safety Layer and deploy the read-only Trust Center without enabling any consequential automation.

## Exact production scope

### Supabase
Apply only:
- `supabase/migrations/0024_mcc_safety_layer.sql`

Expected database impact:
- create table `public.mcc_safety_controls`
- create table `public.production_change_receipts`
- enable RLS on both tables
- create ownership-scoped SELECT policies
- grant browser roles SELECT only
- create read-only view `public.mcc_integrity_status`
- create one fail-closed safety-control row for each existing MCC profile via idempotent insert

Expected initial safety state:
- emergency_stop = TRUE
- automation_database_writes_enabled = FALSE
- automation_external_sends_enabled = FALSE
- automation_booking_changes_enabled = FALSE
- automation_financial_actions_enabled = FALSE

No existing obligation, project, source, dependency, event, message, booking, financial, or client records are modified by migration 0024.

### Application
Release the Trust Center code already on this branch:
- `/trust` route
- read-only integrity status
- read-only production change receipt display
- no browser mutation path for safety controls

## Explicit exclusions
This approval does NOT include:
- `scripts/supabase_security_hardening_draft.sql`
- any SECURITY DEFINER permission changes
- extension relocation
- leaked-password plan/subscription changes
- external sends
- bookings
- money movement
- historical queue imports
- enabling any automation write switch
- deleting or modifying existing executive obligations

## Preflight state
- Phase 2 seed integrity verified: 2 projects, 5 obligations, 6 sources, 5 CREATED events, 0 orphan obligations, 0 duplicate stable source refs.
- Safety migration is additive and fail-closed.
- Browser access for new safety tables is SELECT-only.
- Trust Center is read-only by design.
- Existing Supabase security warnings were assessed separately and are excluded from this change.

## Recovery plan
If application deployment misbehaves:
- restore the previously verified Vercel production deployment/alias.

If migration 0024 itself causes an issue:
- stop further writes/actions.
- preserve logs and current database state.
- because the migration is additive, recovery would be a separately reviewed rollback removing only the newly created safety-layer objects after dependency verification.
- do NOT drop or alter the new objects automatically without a separate RED recovery approval.

## Post-change verification
Immediately after execution verify:
1. migration objects exist exactly once
2. RLS is enabled on both new tables
3. authenticated has SELECT but no INSERT/UPDATE/DELETE on safety tables
4. the single current profile has exactly one safety-control row
5. all four automation action switches are FALSE
6. emergency_stop is TRUE
7. `mcc_integrity_status` returns the current user's state only
8. `/trust`, `/executive`, and `/today` return successfully
9. production runtime errors are checked
10. existing five seeded obligations remain unchanged
11. no external communication, booking, or financial action occurred

## Final status options
After execution, set one:
- VERIFIED COMPLETE
- PARTIALLY VERIFIED
- NEEDS VERIFICATION
- CONFLICT / BLOCKED
- ROLLED BACK

No production action is authorized merely by this receipt existing. Nicci's explicit approval is required after the final deterministic validation passes.
