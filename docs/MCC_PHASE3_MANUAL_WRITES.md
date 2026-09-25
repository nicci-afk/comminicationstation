# MCC Phase 3 — Safe Manual Writes

Status: PREPARED ON FEATURE BRANCH — NOT DEPLOYED / NOT APPLIED TO PRODUCTION

## Goal
Move the executive surface from read-only preview into safe daily-use state changes without enabling autonomous writes.

This phase implements the smallest write surface needed for Focus mode and daily executive use:
- Mark done
- Block with a required reason
- Need help
- inspect state-change history
- undo the latest manual UI state change

App-native unstructured capture is intentionally deferred to the next subphase after these transitions prove safe.

## Safety model

### Browser write scope
The authenticated browser may update only these columns on Nicci-owned obligation rows:
- state
- execution_owner
- blocked_reason
- completed_at

The browser still cannot:
- insert or delete obligations
- edit project/business ownership
- edit priority, risk, due dates, verification, freshness, or provenance
- insert/edit/delete obligation events
- insert/edit/delete obligation sources
- send external communications
- modify bookings
- move money
- enable automation

### RLS
The existing SELECT ownership policy remains.

A new UPDATE policy requires both:
- USING ((select auth.uid()) = user_id)
- WITH CHECK ((select auth.uid()) = user_id)

This means UPDATE first requires visibility of the owned row and the row must remain owned by the same authenticated user.

### Manual-action semantic gate
The audit trigger rejects unsupported authenticated browser mutations.

Supported manual transitions are only:
1. mark an item DONE with completed_at present
2. mark an item BLOCKED with a nonblank blocker reason
3. change execution owner to CHATGPT_PREP for "Need help"
4. restore the exact old values from the most recent MCC manual event for Undo

Arbitrary browser transitions such as CANCELLED, state rewrites, or owner reassignment are rejected even though the individual columns are writable.

### Audit history
A private SECURITY DEFINER trigger function writes the audit event because obligation_events remains browser read-only.

The function:
- lives in a non-exposed private schema
- has EXECUTE revoked from public/anon/authenticated
- derives tenant identity from auth.uid()
- verifies ownership for authenticated changes
- records old/new state, owner, blocker, completion timestamp, actor, reason, and source
- logs the UI actor as NICCI / mcc-executive-ui
- logs controlled backend/admin changes as SYSTEM

Every supported browser change and every undo is recorded in the same database transaction as the obligation update.

## UX
Focus mode and normal executive cards expose:
- Mark done
- Block
- Need help
- Show evidence & history

After a state change, an Undo banner remains available even if the item disappears from the active deterministic view.

For CONFLICT and DISCREPANCY items, Mark done is disabled until the authoritative-source issue is resolved.

## Failure behavior
- A failed write is not shown as complete.
- A blocked item requires a reason.
- A failed undo preserves the current state.
- If history cannot load, auditability is shown as unavailable rather than silently assumed.
- The Today/Executive queries are refetched after each action.

## Rollout
1. Branch-only implementation
2. Static + TypeScript/build validation
3. Review exact SQL / RLS / grants / trigger semantics
4. Run Supabase advisors
5. Generate the final migration using the Supabase CLI rather than inventing a migration filename
6. Validate migration locally/preview where possible
7. Explicit RED approval for production DB migration
8. Explicit RED approval for production frontend deployment
9. Post-deploy verification of RLS, action semantics, audit events, undo, routes, artifact commit, and runtime logs
10. Only after stability: app-native quick capture

## Out of scope for this phase
- automatic external sends
- booking changes
- payment/financial actions
- autonomous background state changes
- historical backlog import
- broad obligation CRUD
- app-native freeform capture
