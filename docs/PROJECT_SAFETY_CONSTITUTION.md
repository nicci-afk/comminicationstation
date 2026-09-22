# Master Command Center — Project Safety Constitution

Status: MANDATORY

## Governing principles
1. Accuracy over speed.
2. UNKNOWN is never treated as DONE, PAID, BOOKED, SENT, CONFIRMED, CANCELLED, or SAFE.
3. Current authoritative sources override memory, chat history, inferred state, and stale cached data.
4. Fail closed: uncertainty blocks consequential action.
5. Read-only is the default operating mode until a write is explicitly authorized.
6. Deterministic code/rules come before AI reasoning wherever practical.
7. Every consequential change must be attributable, reviewable, and reversible where technically possible.
8. No silent failure and no silent fallback to stale data.
9. Minimize blast radius: make the smallest change that can solve the verified problem.
10. Minimize token/credit spend without sacrificing correctness.

## Absolute prohibitions
Without explicit current approval from Nicci, never:
- send external email/SMS/WhatsApp/client communication
- charge, refund, transfer, or otherwise move money
- create, cancel, modify, or confirm a travel booking
- publish public content
- delete canonical records
- weaken RLS/authentication/authorization/tenant isolation
- expose service-role credentials or secrets to browser/client code
- create a paid infrastructure resource
- perform destructive schema changes
- bulk import historical inbox/queue records into active executive state
- infer completion from silence, age, absence, or inactivity

## Approval classes
GREEN: read-only queries, diagnostics, classification, summaries, deterministic calculations, tests, local/preview builds, internal drafts.
YELLOW: prepare client-facing drafts, proposed source-system updates, proposed booking changes, proposed financial communications, proposed production data updates.
RED: external sends, money movement, booking changes, production database writes/migrations, production deploys, public publishing, destructive actions, permission/security changes, canonical-record deletion.

Approval is scoped to the exact described action/change set. Materially different targets, commands, files, rows, resources, or side effects require renewed approval.

## Seven production gates
A. Verify exact target: repository, branch/commit, project/database/environment.
B. Verify exact change set and expected blast radius.
C. Run read-only preflight: schema, row counts, dependencies, freshness, conflicts, security impact, recovery feasibility.
D. Validate in local/free isolation where possible.
E. Obtain explicit approval for the exact RED action.
F. Execute the smallest atomic/idempotent change possible.
G. Immediately verify intended result, actual impact, security/RLS, duplicates/orphans, logs, audit history, and UI/runtime behavior.

If verification cannot prove success, status is NEEDS VERIFICATION, never DONE.

## Stop conditions
Stop before further writes if:
- authoritative sources disagree
- target environment cannot be proven
- affected count exceeds expectation
- schema differs from reviewed assumptions
- rollback/recovery is unclear for a destructive operation
- validation fails
- new critical security finding appears
- auth/tenant behavior changes unexpectedly
- the same operation fails three times
- cost exceeds approved scope
- proceeding would require guessing

## Data integrity
- Every executive obligation requires provenance.
- Material state changes require audit history with actor, timestamp, old/new state, reason, and source when available.
- Stable identifiers are preferred for dedupe.
- Semantic similarity may suggest merges, but must not silently merge high-risk records.
- Waiting items require a named dependency and practical follow-up trigger/date.
- DONE requires affirmative evidence appropriate to the obligation.
- Financial/booking state must be refreshed from authoritative systems before consequential use.
- Historical records remain searchable but do not automatically become active work.

## AI safety
AI must not manufacture completion, payment/booking status, deadlines, client intent, source-system state, quoted pricing/availability, provenance, or IDs.
Use AI for interpretation, extraction, drafting, reconciliation, and planning.
Use code/database queries for exact IDs, counts, states, deadline math, dependencies, permissions, and routing.

## Automation
- New automations begin in observe/draft mode.
- No automatic external sends, financial actions, or booking modifications by default.
- Automated writes must be idempotent/deduplicated and emit audit history.
- Write-capable automations require a practical kill switch.
- Failure states must be visible.
- Never silently fall back to memory or guessed state.

## Security
- Least privilege everywhere.
- Never expose service-role keys or secrets in browser bundles, logs, prompts, screenshots, or commits.
- Do not broaden OAuth scopes without explicit approval.
- RLS must remain enabled for user-owned executive tables.
- Tenant identity comes from authenticated context, never an untrusted payload.
- Run security review/advisors after schema/auth changes.

## Deployment safety
- GitHub is canonical for code/schema history.
- Work on dedicated branches.
- Preview/local validation precedes production.
- Production deploy requires explicit approval.
- READY alone does not equal verified success; check artifact/commit, key routes, auth, logs, and critical flows.
- Do not mix uncommitted local changes into production.

## Database safety
- Verify columns/constraints before writing SQL.
- Prefer idempotent migrations/seeds and transactions.
- Do not rewrite/squash deployed migration history.
- DDL goes through GitHub migrations.
- Data fixes identify exact IDs/source refs and expected counts.
- Destructive changes require a documented recovery path and separate approval.
- A read-only query failure never justifies an immediate write workaround.

## Cost controls
- No paid resource creation without explicit cost approval.
- Reuse existing infrastructure unless a verified gap exists.
- Prefer local/free validation.
- Cache unchanged AI work where possible.
- Stop retry loops after three failures.

## Incident protocol
If a production issue is suspected:
1. stop related writes/automation
2. preserve logs/evidence
3. define blast radius and last known-good state
4. classify state as VERIFIED / UNKNOWN / CONFLICT
5. avoid broad cleanup
6. prepare the smallest recovery
7. obtain explicit approval for consequential recovery
8. verify recovery and document it

## Safe completion
A consequential task is VERIFIED COMPLETE only when:
- the requested outcome is verified from the correct source
- expected side effects are checked
- no unresolved critical discrepancy remains
- audit/provenance is preserved
- required smoke tests pass
