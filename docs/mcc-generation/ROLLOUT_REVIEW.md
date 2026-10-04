# Generation-fenced Gmail cutover: local review packet

## Status and intended result

Local implementation and deterministic testing are complete at the hashes in `candidate-scope-receipt.json`. This is **not production-ready**: native concurrency/PostgREST gates and fresh live database drift verification remain open. No GitHub publication, deployment, production SQL, queue/control change, credential change or real provider/model call was performed for this proposal.

Fresh 22:36 UTC metadata still matched main `aaa2735a64732e0976c5abfa7f25f17b5599de95`, API23 and workers17. The optional SQL drift query was canceled and not retried. Retained source definitions from 17:06 UTC are the design baseline; they must be refreshed before any release.

## Exact source scope

- API: 34 files, only `api/_shared/util.ts` changes. All API routes, authentication/tenant checks and the API prompt variant remain byte-identical
- Workers: 19 files, with the prior reviewed checkpoint worker switched to a new `sync-job-runtime.ts` wrapper, the shared utility tagged, and every other file preserved
- Shared utility creates server-owned caller markers. Normal API, generic worker and job-scoped Gmail clients are distinguished without forwarding inbound headers. These markers are not credentials or tenant authorization
- New Gmail claims use a separate versioned RPC with a durable generation and unique receipt token. A scoped client is created for each job. Claim batch size is one, reducing unstarted batch leftovers at the cost of additional small DB requests. Existing 150-second visibility, 110-second wrapper budget, checkpoint algorithm and mailbox timestamp lease remain
- All 52 pre-existing runtime files are enumerated in the payloads. API/worker import closures and distinct deployed prompt variants are verified. Existing JWT/import settings and AgentEdge controls are not changed

## Exact proposed database scope

- One private schema with RLS-enabled control, claim receipts and control-change audit tables
- One replacement of existing `claim_jobs`: same signature, owner and ACL, returning no sync jobs for all legacy callers while preserving triage/pipeline/digest behavior
- Two service-role-only versioned sync claim/finalization RPCs; private helper functions with fixed search paths and revoked PUBLIC/anon/authenticated/service execution
- New triggers on `gmail_accounts` UPDATE; Gmail-bearing `threads` INSERT/UPDATE; Gmail `queue_items` suppression; sync queue and Gmail-related triage queue INSERT; sync queue UPDATE/DELETE; sync dead-letter INSERT; and private control audit
- Queue payloads, account rows, cursors and unrelated controls/schedules are not rewritten during installation. Only the new private paused control row and its audit record are inserted

The mutation fence rejects untagged service-role legacy writes at actual table boundaries. Existing canonical ingest begins with the guarded Gmail thread upsert; the control/receipt share locks are held through transaction commit. Installation takes bounded exclusive table barriers before recording its cutoff, so an already-running unguarded transaction must finish first or installation aborts. Stale loaded function bodies are still checked at the table boundary. Private receipt tokens bind sync writes to the stored job's mailbox and prevent post-ACK or replaced-token writes.

API-tagged writes retain the API's existing tenant/authentication rules. Other user roles retain existing RLS; trusted SQL cron and non-Gmail triage intake continue. A caller marker is not a defense against a malicious administrator holding the service-role key, and it must never be exposed as a new authorization credential.

## Tests actually run

231 local test totals passed, with zero skips:

- 48 PostgreSQL-engine/PGlite queue + mutation-boundary totals
- 10 exact control-operation/audit totals
- 13 exact-source adapter tests using actual local Supabase JS 2.110.8 with intercepted HTTP
- 48 checkpoint regression cases, with only RPC-boundary adaptations and an explicit new-source allowlist; outcome assertions remain intact
- 112 unchanged containment regression cases against the new bundles

Targeted TypeScript 5.9.3 checking of the shared utility and new wrapper found zero baseline and zero candidate errors using real SDK declarations and a local Deno-env declaration. This is not a full Deno typecheck. Native Edge/PostgREST and multi-session tests are **not run**; see `NATIVE_VALIDATION_REQUIRED.md`.

## Eventual staged rollout, requiring separate approvals

1. Complete native isolated tests, source review, a CLI-generated canonical migration, exact manifest pins and combined CI on the final published head. Do not weaken historical containment manifests or replace failed assertions with skips
2. Refresh main/head, complete live API/workers source hashes, exact function/table/trigger definitions, roles/ACLs, clock precision, logged queue settings, account/queue state and existing safety/cron controls. Any drift blocks the release
3. Agree a short write-maintenance window: avoid reconnects, manual backfills, spam actions and outbound sends in MCC. Existing API23 code may ignore some DB-write failures; old outbound sends cannot be undone by a later DB fence. No user action should be retried solely because of a timeout
4. Deploy the exact tagged API bundle first and verify all 34 files/settings/auth/tenant behavior without sending email. Before the DB fence, this is only a caller marker change; old sync continues its existing behavior. No automatic API rollback is assumed
5. Apply the reviewed fence migration as one bounded transaction. Lock timeout is 3 seconds, statement timeout 10 seconds. On timeout, abort; do not terminate sessions or automatically loop. Verify exact SQL hashes, trigger presence, ACLs/RLS, paused singleton, audit record and unchanged account/queue payloads
6. Record the full-precision database cutoff from the committed fence state. Deploy the exact 19-file workers bundle while sync is paused, and verify its entire source/settings/import closure. Old instances permanently receive no sync claims; old already-issued writes, ACKs and dead letters are rejected by the database fence
7. Wait at least 400 seconds after the database cutoff, then verify no unexplained error/lease/queue state and exact API/worker bytes. The fence provides DB write ordering; the wait bounds ordinary old isolate activity and reduces provider-side overlap. It does not cancel already-transmitted provider requests or prove global deployment propagation
8. Activate only the exact observed generation/cutoff using the reviewed operation template and an explicit reason. The template requires a still-paused matching row and at least 400 seconds elapsed, locks the control row, and audits its change. External artifact/native-validation gates must already have passed
9. Observe natural work through a full poll cycle and its processing window: fresh results for previously active accounts, checkpoint behavior, queue retries/dead letters, released locks, logs and unchanged safety controls. Do not manually enqueue/model/replay work or move history cursors. Mark stopped/recovery accounts visibly; do not reactivate them

## Failure and recovery limits

- Before fence commit: a failed SQL transaction must leave no partial schema or gate. An uncertain outcome requires inspection, never reapplication by assumption
- After fence commit and before activation: keep sync paused while API intake remains durable. A crashed controller cannot auto-resume via a TTL. Notify the user if the maintenance window cannot finish and require an explicit recovery decision
- After activation: the reviewed pause operation stops new claims and guarded sync commits after already-authorized DB transactions finish. It preserves job data and is independently audited
- Never silently remove triggers, reopen legacy claims, discard continuations, rewrite retry counts/cursors, reactivate accounts, or change AgentEdge controls/cron as recovery
- API23 rollback after the fence would make its shared write paths fail. A workers17 rollback cannot claim sync jobs and restores known unsafe checkpoint behavior if the fence is also removed. Neither is a safe automatic rollback
- Prefer a reviewed forward fix that retains the fence. Any code rollback, fence removal, cursor repair or queued-work transformation needs its own exact approval and verification

## Cost and remaining correctness limits

Paused claim calls do not increment pgmq retries or change visibility. Intake and pokes continue: the observed 13 accounts add 13 poll jobs per 15-minute boundary, plus pushes and other existing intake. Extra native claims are one job per call. Edge/DB operations and a resumed backlog are not free or strictly bounded; normal existing triage budget controls remain. This introduces no new self-enqueue loop.

This closes the specifically audited v17 late-write paths by design; native verification is still required before relying on that property. It does not prove every future same-generation mailbox-lease interleaving, solve the existing non-atomic ingest-to-triage enqueue gap, recover historical skipped mail, or provide a complete exactly-once/no-loss guarantee. Some old provider requests may finish externally even though their later DB writes are rejected.
