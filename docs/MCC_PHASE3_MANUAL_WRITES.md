# MCC Phase 3 — Safe Manual Writes

Status: PREPARED ON FEATURE BRANCH — NOT DEPLOYED / NOT APPLIED TO PRODUCTION

## Goal
Move the executive surface from read-only preview into safe daily-use state changes without enabling autonomous writes.

This phase implements the smallest write surface needed for Focus mode and daily executive use:
- Done
- Blocked (reason required)
- Need help
- inspect manual state-change history
- undo the latest manual state change

Capture of new obligations remains available through the conversational workflow for now. App-native unstructured capture is the next subphase after these state transitions prove safe.

## Safety model

### What is allowed
Authenticated Nicci-owned obligation rows may update only:
- state
- execution_owner
- blocked_reason
- completed_at
- updated_at

### What remains blocked
The browser still cannot:
- insert or delete obligations
- edit provenance
- insert/edit/delete obligation events directly
- change user_id, project_id, business_id, priority, risk, due dates, verification, freshness, or financial/booking source facts
- send external communications
- change bookings
- move money
- enable automation

### RLS
Existing SELECT ownership policy remains.
A new UPDATE policy requires both:
- USING ((select auth.uid()) = user_id)
- WITH CHECK ((select auth.uid()) = user_id)

### Audit history
A private trigger function records every permitted obligation update in obligation_events in the same transaction.
For authenticated browser changes:
- actor_type = NICCI
- actor_ref = mcc-executive-ui
- old/new values are preserved
- reason is deterministic from the action where possible

The trigger function lives in a non-exposed private schema and is not granted to anon/authenticated.

## UX
Focus mode exposes:
- Done
- Blocked
- Need help

Evidence/history lets Nicci inspect recent state changes and undo the latest manual UI change.

"Done" is intentionally one-step because the audit history preserves the prior state and provides undo.

## Rollout
1. Branch-only implementation
2. Static + build validation
3. Review exact SQL / RLS / grants
4. Supabase advisors
5. Preview deployment and authenticated smoke test
6. Explicit RED approval for production DB migration and production frontend deployment
7. Post-deploy verification
8. Only after stability: app-native quick capture
