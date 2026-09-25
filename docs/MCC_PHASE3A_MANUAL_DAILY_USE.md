# MCC Phase 3A — Manual Daily Use

Status: PREPARED — NOT DEPLOYED

This phase implements the next approved build-sequence step: **manual writes**.

## User outcomes

Nicci can:
- mark an obligation Done in one step
- move an obligation to Waiting with a named dependency and optional follow-up
- mark an obligation Blocked with a reason
- ask ChatGPT for help by assigning preparation ownership
- inspect material state-change history
- undo the most recent reversible manual action

## Safety architecture

Browser clients still receive **no direct UPDATE/INSERT grants** on MCC canonical tables.

Flow:
1. signed-in browser calls the existing authenticated Edge Function API
2. API resolves the real user from the JWT
3. service-side route calls one service-role-only database RPC
4. RPC verifies obligation ownership
5. obligation mutation and audit-event insert occur in one PostgreSQL transaction
6. UI invalidates and re-reads deterministic MCC views

The RPC is SECURITY DEFINER because the browser remains read-only. It is explicitly revoked from PUBLIC/anon/authenticated and executable only by service_role. It uses a fixed search_path and verifies user/obligation ownership.

## Supported manual actions
- DONE
- BLOCKED
- WAITING
- NEED_HELP
- UNDO_LAST

No action in this phase:
- sends communication
- changes a booking
- moves money
- changes automation kill switches
- deletes a canonical record
- changes source evidence

## Deployment gate

Production requires separate approval for:
1. applying the reviewed SQL
2. deploying the API route
3. deploying the frontend

Post-deploy verification must prove:
- direct browser writes remain denied
- authenticated API action affects only the caller's own obligation
- every successful action creates exactly one event
- undo restores the prior snapshot
- Trust Center safety controls remain fail-closed
