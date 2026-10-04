# Triage cost-control slice: local review only

## Status and exact scope

Baseline: `nicci-afk/comminicationstation` main
`e4159499072b7e3ee0e73e69d6eb9776dbe76f72`. All 57 copied existing backend/source
files matched the canonical Git blob hashes. This is a separate local proposal;
no GitHub publication, production SQL, deployment, model call, queue mutation, or
price/cap change was performed.

Runtime changes are limited to `workers/triage-worker.ts` and two new sibling
modules, `triage-cost.ts` and `triage-provider.ts`. Shared utilities, original
prompts, other provider callers, Gmail generation fencing and reply controls are
unchanged. Existing worker authentication and the generic queue retry/dead-letter
path remain in force. No UI change is included. Validation-only workflow changes are listed below.

One CLI-generated additive migration introduces:

- Private `mcc_cost_internal` schema and RLS-enabled `triage_tasks` table
- One private canonical-source helper
- Four service-role-only RPCs: reserve, mark unknown, settle, apply once
- Per-task immutable request hash, tenant/message identity, source and pricing
  snapshots, single-attempt token, reservation, usage, ledger link and timestamps
- Primary/unique constraints and one partial unresolved-reservations index

No existing table, function, trigger, user cap, cron, queue, credential, RLS policy
or pricing configuration is rewritten. The new foreign keys reference existing
profiles and ledger rows. There is no enabled policy or production price seed.

## Verified gaps in the existing implementation

1. `check_spend` reads historic charges without reserving. Simultaneous calls can
   each pass against the same remaining budget.
2. Triage uses a fixed estimate rather than a proven maximum. The shared pricing
   helper has an approximate table and a fallback price for unknown models.
3. Triage records spend after applying classification and calling its contained
   AgentEdge path. Earlier failures can lead to paid re-generation on redelivery.
4. The generic Anthropic caller permits the SDK's automatic retries and parses
   model JSON before it returns usage. A malformed paid result can go unrecorded.
5. A sender cache exists, but it is not verified versioned task context. This
   proposal does not expand or claim to validate that historical cache.

## Proposed behavior

The worker loads fresh authoritative message and tenant business rows. Read
errors fail closed instead of becoming an empty message/context. Business order
and JSON key order are deterministic. The SHA-256 identity includes the exact
prompt, canonical message input, fixed 400-output-token limit and code protocol
version. SQL independently compares the submitted source snapshot with current
tenant-scoped database fields. A changed task input or prompt cannot authorize a
second paid attempt for the same tenant/message.

Every budget transition takes the user's existing `spend_caps` row lock first.
Admission sums current UTC-month ledger spend and all unresolved reservations,
including prior-month unknown attempts. Daily admission counts observed triage
charges and unresolved attempts. Existing caps are reused; none are chosen here.
Invalid caps, invalid ledger costs, prior legacy charges for the task, missing or
expired policy, conflicting task identity and exhausted limits all block.

Only a newly returned single-attempt token allows a provider call. The caller
uses one request, the exact reviewed dated Haiku model, standard-only service,
400 maximum output tokens, no tools/thinking/prompt caching, and zero SDK retries.
There is a 45-second transport timeout. A timeout is **not** proof of no billing.

Observed ordinary token usage is settled atomically into the existing ledger and
the task receipt using the reserved pricing snapshot. No caller-supplied dollar
cost is accepted. Model/usage mismatches stay unknown; unexpected billing
features stay held. Malformed/incomplete/truncated output is charged when usage
is known but is never applied or regenerated automatically. A bound violation
records observed usage and blocks new triage for that tenant pending review.

Application is a separate atomic operation using the already-settled task result.
It rechecks tenant ownership and current source context, then calls existing
`apply_model_triage` at most once. Application failure cannot erase billed usage.
Lost settlement responses recover a committed result on redelivery. Lost
reservation responses, uncommitted settlement and provider timeouts retain their
hold indefinitely. There is no TTL release, automatic refund, reset, replay or
reconciliation bypass.

Blocked jobs throw a sanitized visible error and follow the existing queue
retry/dead-letter behavior; deterministic classification and the message remain.
The paid request is not repeated during those queue retries. No new user-facing
status UI is implemented; operators must inspect existing logs/dead letters and
the private task receipt. The separately contained AgentEdge push runs only on a
newly applied task. It remains outside this pricing contract and must stay paused
unless separately reviewed. A crash after classification and before that push
will not automatically replay the push.

## Reviewed policy required before any enablement

`app_config.mcc_triage_cost_policy_v1` must be reviewed separately. Required fields:

- `status`: `verified`; `kind`: `anthropic_standard_messages_v1`; `currency`: `USD`
- Nonempty version, reviewer and authoritative HTTPS source URL
- Exact dated `claude-haiku-4-5-YYYYMMDD` model identifier
- Explicit numeric input/output USD per million token rates
- Explicit numeric maximum billable input token ceiling for every accepted
  request to that exact model, and `max_output_tokens` equal to the existing 400
- Finite past `verified_at` and finite future `valid_until`

The reservation is the full verified input-context ceiling times the reviewed
input rate plus the fixed output ceiling times the reviewed output rate. It does
not guess the prompt's token count or assume an average price. This is deliberately
conservative and can block a request whose likely actual cost is lower. Test
prices/caps are synthetic and must never be copied into production policy.

A reviewer must verify the accepted context maximum, service tier, all applicable
billing dimensions/account pricing and policy lifetime from authoritative current
sources. Missing evidence means leave the policy absent. These are model-token
charge controls, not an invoice reconciliation or guarantee about taxes, fees,
credits, external billing changes or provider behavior contrary to the verified
contract. Unknown billing dimensions must stay blocked for review.

## Local validation

Run the portable SQL/runtime suites from the repository root with existing
Node 24 and root dev dependencies:

    node --experimental-vm-modules --test tests/mcc_triage_cost_sql.test.mjs tests/mcc_triage_cost_runtime.test.mjs

The SQL fixture uses the exact baseline `spend_caps` and `ai_spend_ledger` schema
and the exact proposed migration inside PGlite. Message/business/application
fixtures are synthetic. The runtime suite executes actual TypeScript source with
an intercepted provider and actual candidate RPC bodies. It covers policy/cap
failures, tenant denial, old-charge dedupe, held funds, duplicate deliveries,
unknown/lost outcomes, one-time settlement/application, malformed results,
context changes and route integration. PGlite serializes transactions; this is
**not independent PostgreSQL-session concurrency proof**.

A separate test uses the real Anthropic SDK version observed in the approved
cutover's native CI (`0.131.0`), with all HTTP calls intercepted locally:

    MCC_COST_SDK_ROOT=/path/to/node_modules/@anthropic-ai/sdk node --experimental-vm-modules --test tests/mcc_triage_cost_sdk.test.mjs

It verifies the wire request and absence of HTTP-500 retries. No real provider
request is made. Targeted TypeScript checking uses actual Anthropic 0.131.0 and
Supabase JS 2.110.8 declarations. One pre-existing shared `llm.ts` content-union
error occurs identically in baseline and candidate; there are no new diagnostics
in the two new modules. This is not a clean full Deno or application typecheck.

## Mandatory rollout gates and remaining limits

1. Review and approve the local patch; recheck main, runtime source, schema,
   constraints, role privileges and cap/ledger validity. No live schema read was
   performed for this proposal. Existing sender-cache behavior is unchanged.
2. Run independent native PostgreSQL transaction races: simultaneous reserve,
   reserve versus settle/cap update, same-task double settlement/application,
   transaction rollback, unknown outcome and month/day boundary cases. Observe
   actual lock waits, not sleeps. Test through actual PostgREST with service-role,
   anon and authenticated callers. Run advisors and real Edge/import-graph checks.
3. Validate exact deployment-shaped worker sources and all import closure while
   preserving the distinct deployed prompt variant. The new cost-specific manifest
   includes these two new files and preserves all API24/workers18 bytes outside
   the three-file worker delta. Never deploy the source checkout directly or
   weaken historical manifests.
4. This slice serializes participating triage calls only. Draft, interaction,
   pipeline and separately contained AgentEdge callers still use legacy paths.
   Their admission decisions do not take this reservation lock and can overrun a
   shared total. A project-wide hard-cap claim requires migrating every paid
   caller or separately ensuring nonparticipating paths are quiescent. This patch
   does not disable those paths or claim total account-wide cost enforcement.
5. Obtain separate migration/deployment approval. Install additive SQL first,
   deploy exact worker bundle, drain prior triage isolates, inspect legacy queue
   and billed-task ambiguity, verify default-deny behavior, and only then consider
   a separately reviewed pricing policy. Old instances or unknown legacy paid
   attempts are a cutover risk; do not blindly replay old/dead-letter jobs.
6. Keep AgentEdge paused. Policy disable/removal blocks new calls but cannot
   revoke already admitted or dispatched calls. Source snapshots are checked at
   database statement visibility; no serializable lock across a remote model
   call is claimed. An unknown attempt needs authoritative billing evidence and
   an explicitly reviewed reconciliation procedure, which is intentionally not
   implemented here. Never delete a hold merely because it is old.
7. No automatic rollback to legacy workers after enablement: they can bypass
   the new admission gate. Leave policy disabled and investigate. Dropping the
   new schema would destroy outstanding budget evidence and is not a safe reset.

Relevant primary references: [Supabase function security](https://supabase.com/docs/guides/database/functions),
[Anthropic SDK retries](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript),
[Anthropic service tiers](https://platform.claude.com/docs/en/api/service-tiers).


## Validation-publication packet

The original Gmail-generation CI job is pinned to its approved exact main commit
`e4159499072b7e3ee0e73e69d6eb9776dbe76f72`; its scripts and assertions are unchanged.
A new `triage-cost` job checks the current candidate. Existing frontend and older
historical containment jobs remain unchanged. Workflow permissions stay
`contents: read`. No production secrets, deployment commands, hosted test data,
new paid resources or real model calls are used.

The new exact materializer verifies a hard-pinned inventory/manifest, baseline
Git blobs, every candidate file hash, native SQL source hashes, import closure,
original function settings and the distinct worker prompt variant. It refuses
extra/missing files, expanded deltas and nonempty output. The baseline is the
complete API24 (34 files) and workers18 (19 files); candidate API remains 34
identical files and candidate workers has 21 files. No Gmail, reply or pipeline
source is changed by this cost candidate.

Portable validation: 107 tests passed, zero skipped. This includes 21 materializer
scope/tamper tests and the two real-SDK intercepted-HTTP checks. The SQL fixture
intentionally grants broad global installer defaults before installing the new
migration; explicit object revokes still deny all direct application-role access.

The native runner provisions only a disposable local Supabase/Docker stack,
installs the original canonical schema subset and unchanged paused Gmail fence,
then the exact candidate cost migration. It uses the original `apply_model_triage`
and real pgmq/PostgREST. Independent psql sessions must exhibit observed
`pg_blocking_pids` lock waits for competing reservations, settlement, application,
cap updates and rollback. Tests inspect effective privileges, including
DELETE/TRUNCATE, and verify an authenticated JWT works on its own profile before
checking privileged-RPC denial. Exact Edge source must consume the real queue,
make only intercepted synthetic provider HTTP, settle/apply once and preserve
unknown/invalid work through retry/dead-letter behavior. AgentEdge and Gmail
controls stay paused in this fixture. Native SDK resolution must match the
reviewed 0.131.0 no-retry test. Complete baseline/candidate Deno graphs are checked
for no new diagnostics, reusing the unchanged comparison gate.

Native Docker, independent-session, PostgREST and Edge execution is pending CI;
Docker and Deno are not available in the preparation executor. Passing portable
checks, syntax checks and prepared source manifests does not satisfy those gates.
No native pass or production readiness is claimed before that CI terminates.
