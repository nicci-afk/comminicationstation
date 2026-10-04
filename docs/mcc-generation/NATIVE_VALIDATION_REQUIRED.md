# Native validation required before release approval

The existing PR17 native suite passed for the previous checkpoint candidate. It does **not** validate the new generation SQL, caller tags, receipts, triggers, or control operations.

The local review candidate is not ready for production until these tests run on disposable native PostgreSQL + actual pgmq + PostgREST + Supabase Edge, with synthetic provider responses and blocked nonlocal egress. No production project or credentials belong in the test environment.

## Required database transaction interleavings

Use independent sessions and inspect actual `pg_locks` / `pg_stat_activity` waits, rather than infer blocking from a sleep alone. Bound each session by a test statement timeout and always roll back/clean up its synthetic database.

1. Hold an allowed account/ingest/suppression/enqueue mutation transaction open. A control pause must wait for its control-row share lock. Verify the mutation commits before pause can return, then a new mutation is rejected
2. Hold a valid claim receipt's share lock inside a mutation transaction. Expire the queue visibility, attempt redelivery in a second session, and verify the new token cannot be returned until the old transaction finishes. After replacement, a delayed old-token mutation must fail without side effects
3. Race `finish_sync_job_v1` and a new claim against the same queue row. Exactly the current token may finish; no stale ACK/dead-letter may delete the replacement work
4. Start the legacy ingest body before fence installation and delay it before its first table mutation. Install the fence, then let the old body continue. The new thread trigger must reject it. Also test a legacy transaction already holding a target-table write lock: installation must wait or hit its bounded lock timeout, never partially install
5. Compile/cache a legacy `claim_jobs`, `ack_job`, and `dead_letter_job` body before installation. Execute it after installation and after activation. Table guards must catch it even if the wrapper body is stale; sync payload/read count/visibility and dead letters must remain unchanged on denial
6. Race pause with a queue claim and finish. Check a clear commit ordering, no receipt orphaning and no silent zero-row ownership success

## Required actual PostgREST behavior

- Confirm `current_setting('role',true)` is `service_role` inside each SECURITY DEFINER trigger/helper reached by a service-role request
- Confirm SDK 2.x global headers arrive in `request.headers` in the expected lowercase form, including job ID/token/generation, and transaction-local GUCs do not leak between pooled requests
- Exercise all RPC signatures without overloading ambiguity, RLS and function EXECUTE denial for anon/authenticated, safeupdate, null/empty/wrong markers, malformed IDs, and timestamp precision
- Test exact zero-row/exception behavior for paused and stale generation requests, atomic rollback of ingestion and dead-letter failures, visibility/claim receipts, and the 400-second activation predicate with full timestamp precision
- Exercise the actual deployed canonical ingest body and required schema/trigger dependencies in isolation. The local PGlite fixture tests only the mutation boundary, not full ingestion business rules
- Preserve all existing 37 Gmail / 8 containment native scenarios, including runtime source hashes, original prompt variants and no-new-Deno-diagnostics comparison

## Required API/worker compatibility

- Authenticated tenant-scoped reconnect, push intake, deep-backfill enqueue, outbound ingestion and spam suppression with the new API tag; no real email or OAuth token exchange
- Original unauthenticated and cross-tenant denials, explicit send approval, all stopped AgentEdge guards, and generic triage/pipeline/digest behavior
- Rollout skew: tagged API with old workers before the fence; installed paused fence with old and new workers; new generation active while old instances continue receiving invocations
- Every authenticated sync handler uses a newly constructed per-job client. No inbound header can choose its tag, generation or token, and no missing versioned RPC falls back to legacy APIs

## Actual local execution limit

Signed official Debian PostgreSQL 17.11 packages were downloaded and extracted into the local task directory only. No system packages or services were installed. Initdb succeeded, but starting the server failed twice with `Operation not permitted` when creating its private Unix socket, including the approved sandbox escalation. No TCP alternative or further retry was attempted. The server is not running.

PGlite tests and real-Supabase-SDK request interception passed locally; they do not provide these multi-session/native runtime proofs. Native CI publication or another suitable executor needs separately scoped authorization.
