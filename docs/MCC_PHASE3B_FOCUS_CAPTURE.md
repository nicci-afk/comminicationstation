# MCC Phase 3B — Focus, fast capture and daily workflow

Status: RELEASED AND VERIFIED. Nicci approved the release in chat on 2026-10-01.

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

Final pre-release validation passed at commit `409c878a46282c991fa73a55e7cb86bfa4db4e15`, GitHub Actions run `36856395194`:
- Full legacy safety/schema/seed/manual-write regression suite.
- Phase 3B logic, API, DOM and PostgreSQL suite.
- Isolated real Supabase Auth/PostgREST/Edge API and Chromium desktop/mobile workflow.
- Done/advance/Undo, inline Blocked, Need help, capture/review persistence after refresh, denial of direct writes/RPC calls, and two-account cache/RLS isolation.
- Desktop and mobile screenshots inspected; mobile horizontal-overflow assertion passed; no browser page errors.
- The earlier local browser restriction was resolved by running the check in CI. Two test-harness setup issues were corrected before the final successful run; application code did not change.

Production backend verification after explicit approval:
- Reviewed capture/review/manual-undo SQL applied.
- New functions executable only by service_role, not anon/authenticated.
- Transactional production capture/retry/review/Done/undo test passed and was rolled back.
- Original counts preserved: 14 obligations, 15 events. Browser INSERT/UPDATE still denied.
- API deployed as ACTIVE version 22; all 33 deployed files match the reviewed bundle.
- New capture route rejects unauthenticated POST with HTTP 401.
- No new MCC security-advisor findings. Pre-existing non-MCC advisor findings remain outside this release.

Still not exercised: a signed-in production browser write with Nicci's real session. Authenticated full flow was validated on the isolated stack; no live client obligation was modified for testing.

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

Approval received on 2026-10-01 at 06:18 America/Chicago. Approved production database functions and API were updated after validation. Frontend release completed at commit `37754b86f6ce910fe06903624d55cea03745ed1c`. No existing client obligation, external send, financial action or booking was modified.

## Recovery

Revert frontend and API to the baseline release. If candidate SQL must be withdrawn, revoke candidate capture RPC EXECUTE from service_role and restore the prior manual RPC from `scripts/mcc_phase3_manual_writes.sql` under separate approved change. Do not delete captured canonical records, source evidence, or events. Review captures remain retrievable for recovery.

## Deferred scope

Screenshot/document capture, server-side speech transcription, automatic classification/project routing, semantic merge suggestions, natural-language command execution, integrations and scheduled briefs are not implemented in this candidate. Typed capture with review is the conservative no-AI first increment.

## Approval follow-through

Initial candidate CI (run 36854241458) passed both the full legacy safety/database suite and the Phase 3B suite. An additional validation-only job now exercises an isolated local Supabase stack, real Edge runtime and authenticated desktop/mobile Chromium. It uses two synthetic accounts, never production credentials/data, and never provisions paid infrastructure. Approval remains recorded while this final gate runs.

## Frontend release controller

`.github/workflows/mcc-phase3b-production.yml` publishes only the frontend after merge. It requires the validated commit to be an ancestor, refuses application/schema-source drift, confirms successful validation for that exact candidate, targets the established Vercel team/project, and deploys GitHub source by exact release SHA. It does not apply SQL or modify obligations, automation switches, bookings or money.

## Final production release — 2026-10-01

- PR #11 merged after all three required validation jobs passed in run `36857745730`.
- Exact frontend release commit: `37754b86f6ce910fe06903624d55cea03745ed1c`.
- Vercel production: `dpl_G4Ju1NMyeA6VMyGWkEmmusxNpjb2`, READY; canonical alias https://message-command-center-iota.vercel.app.
- Live `/executive` and `/trust`: HTTP 200. Served `/assets/index-1QZfnLLy.js` includes Focus Mode, capture endpoint and review; SHA256 `d86fdcb33dd6090331afee6c950cca60f52e26df5d0a5a6005619fbb2fc7e87a`.
- API version 22, reviewed service-only SQL, transactional production test rolled back. Existing counts: 14 obligations, 15 events; all automation switches false, emergency stop true.
- Production change receipt: `779d1c0f-3ffd-4d1d-99c0-69892a925b5e`.
- Signed-in production writes were not exercised. Authenticated capture/review/action/undo and tenant isolation passed on the isolated real Supabase stack with desktop/mobile Chromium.

Start daily use: open Executive, choose Focus mode, act on one item with Done/Blocked/Need help; use Fast capture for an unstructured note and review it into an explicit next action.
