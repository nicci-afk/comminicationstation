# MCC → AgentEdge fail-closed containment

This release only contains legacy automatic AgentEdge writes while their safer handoff is built and validated. It does not enable those writes or repair historical records.

## Policy and behavior

`agentedgeWritePolicy` reads the authenticated tenant's existing `mcc_safety_controls` row on every eligible invocation. Writes are permitted only for explicit boolean `emergency_stop=false` and `automation_database_writes_enabled=true`. Missing, malformed, foreign, null, nonboolean, unreadable, or error responses deny.

The check runs before AgentEdge/extraction secrets, extraction model calls, and AgentEdge requests in `maybePushToAgentedge`, `agentedge-relay`, and `agentedge-historical-import`. Authentication stays first. A stopped API call returns 409 with `ok:false` and `status:paused`; a stopped worker handoff emits a structured pause log and returns normally. It does not mark a queue item relayed or log a successful push/approval. Ordinary triage, metering, and job acknowledgement continue.

The check is deterministic and uncached. It adds one primary-key control-row read per eligible invocation, no model call, and prevents downstream extraction spend while stopped. A call already past its check cannot be cancelled by a later flag change.

## Exact deployed baseline

Reviewed October 2, 2026. Source base `37754b86f6ce910fe06903624d55cea03745ed1c` contains the same backend source as PR12 head `384145cf5942f6d41ceda8617da0544ec5105156`. PR12's separate frontend work is not part of this release.

- API version 22, 33 original files, deployed bundle SHA256 `755f136e244b641c24d4d35cb214b76218bcea0eb88def6528b08e9c8f3e24b4`
- Workers version 16, 17 original files, deployed bundle SHA256 `0ce0a3650fe60886ab6b648c54f6d66d38fd7b646c29253904f85d35548f4801`
- Both existing auth settings and import maps are unchanged

All original API files match source; one workers file differs from source: `_shared/prompts.ts`. Its deployed bytes are preserved as the source-only fixture `tests/fixtures/mcc-agentedge/workers-v16-prompts.ts`. Do not rebuild workers blindly from the ordinary shared repository prompt. The release manifest records every baseline Git blob/SHA256 and candidate SHA256, plus the exact settings and file list.

## Reproducible validation

Run:

```sh
node --experimental-vm-modules --test tests/agentedge-safety.test.mjs tests/mcc_agentedge_materializer.test.mjs
bash scripts/validate_mcc_agentedge_runtime.sh
```

The first command runs actual-source mocked regressions and exact-source materialization tests. The second requires Deno, Supabase CLI and Docker, materializes both complete baseline/candidate function bundles, records dependency resolution and type-check differences, and tests the candidate in a throwaway local environment. It needs no production credentials. The runtime fixture rejects nonlocal provider traffic; permitted triage responses are synthetic. Test evidence distinguishes pre-existing baseline diagnostics from candidate failures. See the exact-head CI run before treating runtime validation as passed.

`scripts/materialize_mcc_agentedge_release.mjs <output-directory>` (with `node --experimental-vm-modules`) creates reviewable payload JSON and source trees locally. It reads the pinned Git baseline and checked-in working files, refuses unexpected byte changes or missing imports, and performs no deployment or network calls. Source-only payloads contain no production database rows or secret values.

## Release and recovery gates

- Obtain independent review and passing exact-head preflight; follow the project production checklist and explicit approval scope
- Freshly compare deployed versions and all source bytes with the manifest baseline. Reconcile any drift before release
- Release only the reviewed complete bundles; retrieve and compare all deployed files and unchanged auth/import settings afterward
- A separately approved pause must target only cron job 7 (`agentedge-relay-15min`) and only its active flag. This validation workflow never changes cron or production
- Verify stopped responses, auth rejection, no new AgentEdge writes/relay timestamps/approval successes, and continuing intake/triage/backlog processing. Account for in-flight predeployment invocations
- Keep containment on during failures. Restoring an old unguarded bundle reintroduces unsafe writes and requires an explicit recovery decision

Unsafe inferred booking status, zero-price/today-date defaults, legacy destination mapping, allowed-path record scoping and idempotency remain behind the disabled guard. These tests are not permission to re-enable them. A safe candidate/provenance/approval redesign remains separate work. No production merge, deploy, database/configuration write, cron change, or external communication is performed by these tests.
