# MCC v2 Phase 1.5 — implementation checkpoint

## Purpose

Phase 1.5 hardens the system before real executive data is seeded or automation is enabled.

## Implemented on branch mcc-v2/phase1-5

- Explicit runtime policy constants:
  - executive UI = READ_ONLY_PREVIEW
  - external communication = MANUAL_SEND_ONLY
  - automation = PREPARE_ONLY
  - truth behavior = FAIL_CLOSED
- Parallel Executive route. Existing Message Command Center Today/Queue remain unchanged.
- Executive cards display:
  - verification state
  - freshness
  - deterministic Why now reasons
  - execution owner
  - project context
  - expandable obligation-source provenance
- Focus mode uses the same deterministic mcc_today ranking and excludes waiting/blocked/defer sections.
- Empty Executive state explicitly says no MCC obligations have been seeded; it does not claim that all work is complete.
- Client draft prompt:
  - preserves UNKNOWN
  - forbids unsupported consequential facts
  - returns verification_needed
  - optimizes toward a clear, low-pressure next step
- Draft UI marks generated copy as DRAFT ONLY and surfaces facts to verify before sending.
- Gmail and Twilio send endpoints now require the explicit value USER_CONFIRMED.
- Only the manual send controls currently provide USER_CONFIRMED.

## Deliberately not implemented yet

- No production deployment.
- No production schema change.
- No seed data.
- No MCC write UI.
- No automation activation.
- No automatic external sends.
- No source-health tables yet.
- No approval-center persistence yet.
- No AI cache table yet.
- No historical queue import.

## Local acceptance gate

Run:

```bash
bash scripts/validate_mcc_v2_phase1_5_local.sh
```

The gate passes only when:
1. Phase 1.5 static safety checks pass.
2. The existing clean Phase 1 database validation still passes.
3. TypeScript compilation and Vite production build pass.

Do not deploy Phase 1.5 until this gate passes.
