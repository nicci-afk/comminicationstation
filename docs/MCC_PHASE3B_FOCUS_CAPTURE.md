# MCC Phase 3B — Focus, fast capture and daily workflow

Status: IMPLEMENTED CANDIDATE — NOT DEPLOYED. Production approval pending.

## Verified continuation baseline

Read-only checks on 2026-10-01:
- Canonical repository: nicci-afk/comminicationstation.
- Main and existing phase3b branch: afc5354f16e11fe44ac3e8b75b98583f3effd532.
- Latest Vercel production deployment: dpl_Ev5GBsqaef4sP5ig3e6hJHE1ezW3, READY, same commit.
- Supabase: bgpjpomqrnwsdmrofudb; mcc_apply_manual_action exists, SECURITY DEFINER, authenticated EXECUTE denied.
- Authenticated direct obligation INSERT/UPDATE denied. 14 obligations, 15 events at baseline.
- Emergency stop true; all four automation switches false.
- Existing Phase 3A document's PREPARED status is stale relative to these live checks. Original file preserved.

## Candidate behavior

- Focus retains the database ranking but selects one NICCI-owned actionable item. Excludes terminal, waiting, blocked, SOMEDAY, unresolved dependencies, stale/conflicted/unverified records and missing next actions.
- Done requires one click. Done/Blocked/Need help remain the Focus actions. Inline blocker and waiting forms replace native pop-up prompts.
- Successful actions refresh database-backed views before showing the next eligible item. A receipt outside the card keeps Undo reachable after Done removes the item.
- Daily summary limits Next to five and other sections to three, preserving every critical exception. Expand reveals all active obligations.
- Waiting displays the named party and follow-up. Morning: review urgent exceptions and focus. During the day: capture fragments. Closeout: review waiting follow-ups and unresolved risks.
- Fast capture accepts typed text, pasted text, or device keyboard dictation. Capture preserves up to 10,000 characters verbatim. No AI calls, dates, project matches, monetary claims or supplier status inferred.
- New capture is BLOCKED / UNVERIFIED, labelled CAPTURED — NEEDS CLARIFICATION. ACTION is a provisional storage type, not automatic semantic classification.
- Review confirms one next action and optionally an owned active project. It becomes TODAY / PARTIALLY_VERIFIED for executive intent only. Financial/booking facts remain unverified. Original note and source retained.
- Capture retry ID is reused on failed/unconfirmed saves while the note is unchanged. Transaction lock handles simultaneous retries, rejects reuse with different content, and creates one obligation/source/event per request. Separate requests deliberately do not auto-merge semantic duplicates.
- Review and manual changes preserve old/new audit state. Undo supports review and refuses to overwrite a newer unreversed event.
- Account transitions clear query cache and remount the shell to avoid reusing another user's captures or executive UI state.

## Validation

Passed locally:
- TypeScript and Vite build.
- All existing repository static suites.
- Focus/daily workflow assertions.
- Actual API handler method/authentication/input/JWT ownership tests with mocked auth/RPC boundary.
- Actual React components and hooks in a local DOM with network fixtures: one Focus card, Done/advance, persistent Undo, inline blocker, failed capture retains note, retries use same ID, capture review inbox.
- Actual Phase 1 PostgreSQL schema/view plus Phase 3A and candidate SQL in isolated PGlite: preservation, retries, mismatch/length rejection, tenant isolation, browser write/RPC denial, owned-project validation, atomic audit failure rollback, review/Done undo, newer-event protection.

Not verified:
- Browser rendering, mobile layout, keyboard focus and live authenticated preview flow. agent-browser failed to bind its daemon socket; Chromium download did not yield a valid archive. DOM tests are not visual browser tests.
- Supabase Edge runtime/PostgREST transport on an isolated staging project. PGlite runs PostgreSQL semantics but not the hosted Supabase services.
- Live production writes. Deliberately not exercised.

## Reproduce

Node 24. Install root dev dependencies with `npm ci`, web dependencies with `npm ci --prefix apps/web`, then `npm run test:phase3b`.
Root packages are validation-only, not added to the web or Edge runtime. Existing production workflows remain unchanged. A validation-only Phase 3B CI job was added.

## Approval gate and exact release scope

Before asking for production approval:
1. CI passes at the exact candidate SHA.
2. Test isolated authenticated preview end to end, desktop and phone layouts, action errors and refresh.
3. Confirm cross-user isolation and security advisors on staging; confirm no direct browser write/EXECUTE grants.
4. Review candidate SQL, API and frontend changes as one release.

Only after explicit approval:
1. Apply reviewed `scripts/mcc_phase3b_fast_capture.sql` (two capture RPCs and extension of manual undo; no new tables or seed data).
2. Deploy API with mcc-fast-capture route.
3. Deploy frontend from the approved commit.
4. Verify live authenticated behavior and audit counts on an explicitly approved test obligation/capture.

No approval granted in this turn. No production schema/data/API/frontend changes, merges, workflow dispatches, sends, financial actions or booking changes were performed.

## Recovery

Revert frontend and API to the baseline release. If candidate SQL must be withdrawn, revoke candidate capture RPC EXECUTE from service_role and restore the prior manual RPC from `scripts/mcc_phase3_manual_writes.sql` under separate approved change. Do not delete captured canonical records, source evidence, or events. Review captures remain retrievable for recovery.

## Deferred scope

Screenshot/document capture, server-side speech transcription, automatic classification/project routing, semantic merge suggestions, natural-language command execution, integrations and scheduled briefs are not implemented in this candidate. Typed capture with review is the conservative no-AI first increment.
