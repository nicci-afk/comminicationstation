# MCC Incident & Recovery Playbook

## Trigger
Use for suspected wrong production data, unexpected deployment behavior, duplicates, security/permission anomalies, failed automation with side effects, incorrect external sends, booking/financial discrepancies, or source-of-truth conflicts.

## Immediate response
1. STOP related writes and automation.
2. Preserve evidence.
3. Capture timestamp, environment, deployment/commit, operation, affected IDs, logs, and symptoms.
4. Read authoritative state without changing it.
5. Define blast radius before recovery.

## Severity
- SEV-1: security breach, money movement, booking/cancellation, mass external send, cross-tenant exposure, destructive data loss.
- SEV-2: wrong production state affecting decisions/workflow, repeated automation failures, important client/travel conflict.
- SEV-3: UI/read-only defect or isolated non-consequential metadata issue.

## Recovery rules
- Prefer known-good rollback/reversal.
- Never broad DELETE/UPDATE as first response.
- Identify exact primary keys/source refs before data repair.
- Financial/booking recovery requires authoritative-source verification and explicit approval.
- External correction messages remain drafts until explicitly approved.
- Preserve before/after state and recovery reason.

## Closure
Close only when scope is verified, recovery is verified, root cause is known or recorded unknown, preventive guardrail/test is added where practical, and no unresolved high-risk discrepancy remains.
