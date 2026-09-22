# MCC v2 Phase 1.5 — hardening and executive UX guardrails

Status: implementation branch only. No production deployment.

## Non-negotiable invariants

1. External communication remains human-approved. AI may prepare drafts but must never call a send endpoint as a side effect of drafting, analysis, classification, monitoring, or automation.
2. UNKNOWN is not VERIFIED ABSENT. "Not found" must never silently become "does not exist."
3. Consequential facts must expose verification state, freshness, and source/provenance.
4. Conflicting or stale consequential facts fail closed: surface the conflict/staleness and do not recommend an irreversible action as ready.
5. Deterministic SQL/code owns deadlines, state, dependencies, exact identifiers, routing, freshness checks, and ordering. AI is reserved for ambiguity, extraction, drafting, and interpretation.
6. New automations begin in SHADOW or PREPARE_ONLY. External sends, financial actions, booking changes, publishing, and consequential production writes remain approval-gated.
7. No historical Message Command Center queue import into MCC v2.
8. Every future obligation mutation must be transactional with its obligation_event insertion.
9. AI outputs are proposals until validated. Model output must not directly establish domain truth.
10. Unchanged source content should not be re-analyzed once content-hash caching is available.

## Phase 1.5 implementation scope

- parallel read-only Executive preview backed only by mcc_today / obligation_sources
- explicit verification/freshness/provenance display
- visible deterministic "Why now?" reasons
- Focus view using the same deterministic ranking
- client drafting prompt hardened against unsupported factual claims
- draft UI surfaces facts that require verification before the user sends
- source-health / approval-center / automation-budget schema designed next, but not introduced by ad-hoc production SQL

## Communication policy

Draft generation and sending are separate operations.

Draft generation:
- may use approved communication strategy and actual conversation context
- must preserve uncertainty
- must not invent pricing, dates, availability, supplier policy, booking state, payment state, refunds, deadlines, or promises
- should optimize for the explicit communication objective and an appropriate next step
- should return verification_needed when factual support is insufficient

Sending:
- remains a separate authenticated user action
- is never called by draft generation
- is never executed by an automation in Phase 1.5
- future approval-center work must preserve an auditable approval boundary

## Cost policy

Level 0: SQL/code for deterministic state.
Level 1: low-cost extraction/classification/drafting where adequate.
Level 2: advanced reasoning only for ambiguity/conflict/high-risk analysis.

No second AI pass when deterministic validation can answer the question.
