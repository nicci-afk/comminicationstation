# Gmail incremental checkpoint candidate

Status: VALIDATION CANDIDATE, PARTIALLY VERIFIED. Draft source review does not authorize deployment.

## Exact scope

Prevents the incremental worker from saving Gmail's mailbox-wide history ID while unprocessed history pages remain. Only `supabase/functions/workers/gmail-sync-worker.ts` changes at runtime. No schema, OAuth scope, dependency, AI model, spend-limit, AgentEdge guard, or production-setting changes.

Baseline: canonical source `f913bd8c208cce1fd4c42a3f14a5141d89d55ea0` (containment PR13), deployed API v23 / workers v17. The worker's baseline SHA-256 is `acbe3f757abeb0bd0c7b42b20b90ebe8a8dcc767f60b30618ee75aa74a608cd3`; the candidate SHA-256 is `554e54298b1044a6db6abc4191d7f576b7c8959c4e99d683013721a5b7e03614`.

## Behavior

- Retain the durable starting checkpoint until every page and required message/suppression write succeeds
- Save a constant-size continuation: start history ID, current page token, SHA-256 of canonical page operations, next operation offset, and a bounded token-restart marker
- Canonicalize duplicate/reordered event records; use only specific Gmail event fields, not the duplicate generic `messages` field
- If page contents change, invalidate the saved offset and replay through the existing provider-ID uniqueness behavior
- If a DB response is failed or uncertain, leave the job retryable and avoid advancing its checkpoint
- Limit invalid-page-token recovery to one tokenless replay in a continuation chain, then use the existing bounded queue retry/dead-letter policy
- Fence every worker account update against the acquired lock; checkpoint updates also compare the prior durable checkpoint
- Keep null-baseline initialization retryable rather than disabling an account before its initial backfill can run
- Preserve exact decimal cursor strings; reject already-rounded unsafe numeric reads instead of guessing
- Suppress only the queue episode whose current inbound message matches the referenced provider message, so an old trash/spam event cannot hide a newer inbound episode on retry
- Stop expired-history and legacy `full_resync` jobs with visible incomplete-coverage error/status; never perform the former one-page, seven-day reset

An expired-history account requires a separately reviewed reconciliation plan before reactivation. This patch does not recover previously skipped messages or automatically replay historical mail.

## Verification

Run on Node 24:

```sh
node --experimental-vm-modules --test tests/gmail-sync-checkpoints.test.mjs
```

43 sync fixtures pass. These include one explicit reproduction of the old deployed loss and one characterization of the pre-existing triage-outbox gap. The real worker, Gmail parsing/OAuth helpers, and auth/queue wrapper execute; HTTP, PostgREST/RPC, clock, and unavailable TypeScript interface runtime exports are isolated fixtures. No real network, OAuth credentials, database, model, or payment calls occur.

Coverage includes page-boundary/mid-page cutoff, cutoff before a write, DB errors before and after commit, checkpoint errors, enqueue/ack errors, stale continuation/lock, initialization, duplicate/reordered/changed history, missing/deleted/current-draft messages, suppression errors, cursor expiry, revoked OAuth, exact bigint strings, malformed responses, and bounded invalid-token recovery.

112 pre-existing AgentEdge containment fixtures also pass against the complete candidate bundles. All 51 unrelated deployed bundle files are byte-identical. The same 43 sync tests also pass from repository-shaped paths.

Measured synthetic fixtures (not production estimates):

- Two pages with interruption after the first message: 2 history GETs, 2 metadata GETs, 2 ingest RPCs, 1 continuation, 1 final checkpoint write
- One page with interruption after each of three messages: 3 history GETs, 3 metadata GETs, 3 ingest RPCs, 2 continuations, 1 final checkpoint write
- Reordered/duplicate version of that page: the same counts, with 3 unique message IDs
- Changed page invalidating its offset: 2 history GETs, 4 metadata GETs, 4 ingest RPCs, 3 unique message IDs, 1 final checkpoint write

The largest continuation in these fixtures is 243 bytes; provider token length can vary. State field count does not grow with mailbox history. A changed page or uncertain write can repeat work, intentionally favoring completeness over guessed progress. There are no added model calls or claimed production savings.

## Known limits and release gates

1. Existing ingest-to-triage scheduling is not an atomic outbox. If message ingestion commits and optional triage enqueue fails, replay returns `duplicate` and can omit that triage job. The message remains stored, but full-system no-loss/exactly-once processing is NOT established. A separate atomic/idempotent DB design is required.
2. Actual Deno/Supabase Edge/PostgREST execution and fresh baseline-aware type checking are mandatory CI gates. They were not run in the source-preparation workspace, where Deno/Docker/Supabase CLI are absent; check the exact-head CI evidence before treating them as passed. Provider HTTP is synthetic and the local ingest SQL deliberately models uniqueness, not the canonical ingestion business rules. The earlier containment release already had baseline type errors; a passing no-new-diagnostics gate is not a clean full typecheck. No live Gmail behavior or production DB change is tested.
3. The original containment artifact is immutable. Its exact-source tests now run in a detached checkout of f913bd8. The new `materialize_mcc_sync_release.mjs` pins API23/workers17 and permits exactly one runtime delta, gmail-sync-worker.ts. Current-source containment tests, all source hashes/import closure/settings, and both actual-runtime suites remain required; neither an editable manifest nor a passing historical artifact test authorizes new runtime changes.
4. No production history reconstruction, historical-message replay, account reactivation, migration, merge, or deployment is authorized by this candidate. A release needs refreshed production/source baselines, exact approved artifacts, explicit approval, and verification that the stopped controls and paused relay remain in place.
5. Interrupted operations can still repeat safe reads or deterministic DB effects. This patch does not redesign the ingestion RPC's episode ordering, optional triage queue, general full-sync/backfill semantics, or queue-wide concurrency model.

## Authoritative references

- [Gmail users.history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list): page tokens, chronological noncontiguous history IDs, expired-ID 404 behavior, and storing the response mailbox history ID only after no next page remains
- [Gmail synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync): expired history needs full reconciliation, not a guessed recent window
- [Supabase returning modified rows](https://supabase.com/docs/reference/javascript/using-modifiers-select): `.select()` is required to observe affected rows after an update
- [Canonical ingestion RPC](https://github.com/nicci-afk/comminicationstation/blob/f913bd8c208cce1fd4c42a3f14a5141d89d55ea0/supabase/migrations/0008_categorization_update.sql): provider-message dedupe and the non-atomic triage scheduling boundary

## Versioned release preflight

```sh
bash scripts/validate_mcc_guard_snapshot.sh
node --experimental-vm-modules --test tests/agentedge-safety.test.mjs tests/gmail-sync-checkpoints.test.mjs tests/mcc_sync_materializer.test.mjs
node --experimental-vm-modules scripts/materialize_mcc_sync_release.mjs /tmp/mcc-checkpoint-bundles
bash scripts/validate_mcc_agentedge_runtime.sh /tmp/mcc-checkpoint-bundles
bash scripts/validate_mcc_sync_runtime.sh /tmp/mcc-checkpoint-bundles
```

Use a new, empty output directory. The first actual-runtime suite remains unchanged and checks complete dependency loading, old/new Deno diagnostics, auth/RLS, containment and triage continuity. The second runs Gmail sync in a separate disposable local Supabase project, with exact bundle bytes, real account/checkpoint/queue writes, synthetic provider responses, and blocked nonlocal egress. The workflow uploads both evidence directories as `mcc-checkpoint-runtime-evidence`. No linked project, production credential, live provider request, paid resource, or deployment is needed.

The candidate branch is stacked on PR13 at f913bd8; PR12 frontend changes are excluded. A branch outside the existing `mcc-v2/**` push trigger avoids duplicate push/PR workflow runs while retaining all existing PR checks.
