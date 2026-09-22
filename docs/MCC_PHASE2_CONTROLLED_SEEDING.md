# MCC v2 Phase 2 — Controlled Seeding Plan

## Purpose
Populate the Executive layer with a small set of current obligations without importing historical Message Command Center noise.

## Go-live boundary
- Production Phase 1.5 ready timestamp: `2026-09-22T02:00:10.695Z`
- Historical queue records before this boundary remain searchable but are not automatically promoted into executive obligations.
- Carry-forward items require current-source verification or explicit human confirmation.

## Production baseline verified read-only
At Phase 2 start, the live Supabase project `bgpjpomqrnwsdmrofudb` contains:
- projects: 0
- obligations: 0
- obligation_sources: 0
- obligation_dependencies: 0
- obligation_events: 0

No production data was changed during this verification.

## Seeding rules
1. Never infer DONE from silence or absence.
2. No historical queue bulk import.
3. Stable source IDs are the preferred dedupe key.
4. A current source may verify that an obligation exists, but it does not prove completion state unless the source explicitly says so.
5. Financial, booking, and external-communication facts must be refreshed from their authoritative sources before consequential action.
6. Every seeded obligation must have at least one obligation_source row.
7. Every initial creation must emit an obligation_events audit row.
8. Items with conflicting or incomplete evidence enter PARTIALLY_VERIFIED, UNVERIFIED, CONFLICT, STALE, WAITING, or BLOCKED as appropriate.
9. No client-facing communication is sent automatically. Draft/manual approval only.

## Initial carry-forward verification pass

### Ready for controlled seed after explicit production-data approval
These have current evidence that the underlying work/trip/request exists. Exact state should remain conservative.

1. Amanda Setchell — NYC Christmas trip
   - Candidate type: ACTION
   - Proposed state: TODAY or THIS_WEEK based on deterministic priority at seed time
   - Verification: PARTIALLY_VERIFIED
   - Current evidence: Gmail thread `1a0bbb1fd30f4ef1`; incoming details dated 2026-09-21
   - Next action: prepare current NYC options/quote; do not send without approval

2. Paul Darr — 20th anniversary trip
   - Candidate type: ACTION
   - Proposed state: THIS_WEEK
   - Verification: PARTIALLY_VERIFIED
   - Current evidence: Gmail thread `1a0727583159f2aa`; meeting coordination through 2026-09-14
   - Caveat: current completion state is not proven by the email thread alone
   - Next action: verify latest quote/proposal state before client follow-up

3. Orlando flight-date review
   - Candidate type: DECISION
   - Proposed state: TODAY
   - Verification: CONFLICT
   - Current evidence: Google Calendar contains Orlando→STL flights on both 2026-10-07 and 2026-10-08
   - Next action: reconcile which return is intended before changing any booking

4. Sarah Harrison — October Cancun readiness/follow-up
   - Candidate type: ACTION
   - Proposed state: THIS_WEEK
   - Verification: PARTIALLY_VERIFIED
   - Current evidence: Funjet reservation email for 2026-10-22 plus Nicci's 2026-09-08 update
   - Caveat: the specific “transfers + Zach birthday” follow-up still requires current confirmation
   - Next action: verify remaining trip-readiness items against AgentEdge/supplier record before outreach

5. MasterClass Facebook groups/content
   - Candidate type: ACTION
   - Proposed state: THIS_WEEK
   - Verification: PARTIALLY_VERIFIED
   - Current evidence: Kha email thread confirms the preference for two separate Facebook groups
   - Next action: verify whether the classroom-look video has already been posted before creating a live action item

### Needs verification before seed
- Gwen Galen quote — no current Gmail evidence found in the initial bounded search
- GHR Real Estate website — current-state seed only; verify current project status
- SFO→STL flight for Oct 24 — no current booking confirmation found in the initial bounded Gmail search
- Vietnam air — current-state seed only; current itinerary/booking state needs authoritative verification
- Vietnam accommodations/transfers waiting on Lois — current-state seed only; Lois/invoice evidence not located in initial bounded Gmail search
- Dickmanor group recovery audit — current-state seed only; no current Gmail evidence found in initial bounded search
- Pack for Mo Roots — current-state seed only
- Pack for MasterClass — current-state seed only
- Pack for Tahiti — trip existence is current, but packing obligation remains a human carry-forward item
- Travel GHR AgentEdge audit — verify present audit state in the AgentEdge source system before seeding

## Phase 2 execution sequence
1. Maintain this work on branch `mcc-v2/phase2-seeding`.
2. Run read-only current-source verification for each carry-forward candidate.
3. Produce an idempotent seed transaction with stable source fingerprints.
4. Run seed preflight locally and verify duplicate/provenance guards.
5. Preview the populated Executive UI against local/test data.
6. Present the exact proposed production inserts to Nicci.
7. Only after explicit approval, insert the verified initial seed into production.
8. Immediately verify Today/Executive rendering, provenance, dedupe, RLS, and audit events.
9. Begin post-go-live intake with only new actionable records and explicitly confirmed carry-forwards.

## Explicit non-goals
- No automatic Gmail/queue historical migration
- No automated client sends
- No automatic booking or financial changes
- No guessed completion
- No paid Supabase branch/resource
