# Production Change Checklist

## Change identity
- [ ] Exact requested outcome documented
- [ ] Exact target system/project/environment verified
- [ ] Exact branch/commit/artifact or SQL/change set identified
- [ ] Expected blast radius documented
- [ ] No paid resource creation unless explicitly approved with cost

## Source and correctness
- [ ] Authoritative source identified for each consequential fact
- [ ] Volatile facts refreshed
- [ ] Conflicts resolved or action blocked
- [ ] No completion/payment/booking/send state inferred from silence
- [ ] Stable IDs/source refs verified

## Security
- [ ] RLS/auth/tenant isolation impact reviewed
- [ ] No secret/service-role exposure
- [ ] OAuth/permissions not broadened unexpectedly
- [ ] Security advisor/checks reviewed when relevant

## Validation
- [ ] Local/free validation used where possible
- [ ] Deterministic tests passed
- [ ] Build/type checks passed
- [ ] Regression tests passed
- [ ] Idempotency/dedupe behavior checked
- [ ] Rollback/recovery path known

## Approval
- [ ] Action class identified: GREEN / YELLOW / RED
- [ ] RED action has explicit current approval
- [ ] Approval scope exactly matches the pending operation

## Execution
- [ ] Smallest possible operation
- [ ] Transaction/atomic method used where practical
- [ ] No unrelated cleanup
- [ ] Unexpected output stops further writes

## Post-change verification
- [ ] Intended change verified from source/runtime
- [ ] Actual affected count matches expectation
- [ ] Duplicate/orphan checks pass
- [ ] Audit/history exists
- [ ] Runtime logs checked
- [ ] Critical UI/routes smoke-tested
- [ ] Security/RLS remains valid
- [ ] Any uncertainty labeled NEEDS VERIFICATION

## Final status
Choose exactly one:
- VERIFIED COMPLETE
- PARTIALLY VERIFIED
- NEEDS VERIFICATION
- CONFLICT / BLOCKED
- ROLLED BACK
