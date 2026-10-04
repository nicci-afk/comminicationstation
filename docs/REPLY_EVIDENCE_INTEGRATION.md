# Evidence-backed replies: local integrated candidate

## Status

This candidate connects the deterministic checker to actual proposed SQL persistence, the ItemDetail review screen, and Gmail/SMS/WhatsApp send handlers. It is **local only**, not deployed or protecting current production sends. Sending in this candidate is disabled unless the server environment explicitly sets `MCC_REPLY_DISPATCH_ENABLED=true`; synthetic tests enable that switch only against stub providers. No production migration, deploy, live provider send, live Gmail body fetch, or application model call was performed.

Source baseline: `nicci-afk/comminicationstation` main `aaa2735a64732e0976c5abfa7f25f17b5599de95`. Combined utility compatibility uses the cutover-owned `_shared/util.ts` from draft PR 18 head `019098c85561c234dc3c49f0e16f0fb42c3b7ec6`. That utility is not modified or included in this reply patch. Existing caller tagging is inherited through `serviceClient()`; no incoming headers or tenant IDs select the caller identity.

## What is connected

- Five new reply tables: scope/revision state, source evidence, immutable checks and review receipts, approvals, immutable dispatch intents
- Additive draft revision/context/claim fields, with compare-and-swap saves and approval invalidation
- Server-only SECURITY INVOKER RPCs; no authenticated/anonymous reads or writes on new tables and no browser RPC execution. UI reads are authenticated API projections
- Complete scoped source reads with user/contact/business/thread/account matching, explicit read/size limits, message-content invalidation, and exact source hashes/excerpts. The adapter currently supports human-reviewed stored message assertions; obligation-source and external authoritative-system adapters are not implemented, and it does not invent source-system verification
- Current-source checking, full-reply/source review, exact approval, durable one-use reservation and final pre-provider state check
- Every manual or generated reply goes through the same gate. The old client `USER_CONFIRMED` literal is not accepted as approval
- Exact final body, subject, recipients, sending account, channel and threading headers are frozen before approval and loaded server-side for dispatch. Request-body replacement text is ignored
- One dispatch per draft revision and one dispatch per approval. Pending/unknown delivery in a context blocks new approvals; it cannot be bypassed with a new approval or edited draft
- Known send success is recorded before ingestion. Ingestion failure is distinct from delivery failure. Timeout/malformed responses are UNKNOWN; no automatic provider retry exists. Repeated sends return durable status. Cancel cannot falsely claim an in-progress send stopped
- UI blocks unsupported claims, displays dated source evidence, invalidates review on edits, suppresses stale responses, and preserves status lookup after a lost send response, and rejects a generated draft belonging to another queue item. Source links reveal the local source without throwing away the draft

## Missing source bodies and first-release limits

A read-only aggregate readiness check on 2026-10-03 found 32,801 of 32,811 stored messages lacked full body text, consistent with the existing metadata-only sync design. All 12,295 open items in the queried state set had client/business scope. No message contents were read for this check.

The UI therefore offers an explicit per-thread “load missing source bodies” action through the existing Gmail body-read route, limited to 20 per click. It makes no model calls and does not bulk-fetch the inbox. Missing, empty, oversized, cross-client/account, or over-limit source sets still block approval. The existing body-read route was narrowly tightened to require POST, verify the Gmail account owner before credential access, encode the provider ID, and report cache-write failure instead of implying source readiness.

The completeness flag describes the available stored plain-text source set, not every external fact, attachment, supplier state or private agreement. Message parsing and human claim mapping can be wrong. Regex detection is English-focused and incomplete. Human review must assess the actual assertion, currency/timezone/conditions, authority and transaction scope; identical wording is not proof. Financial, booking, availability or price facts requiring current authoritative systems must remain unresolved when that evidence is unavailable. No claim of absolute factual accuracy is made.

The initial implementation conservatively allows at most 200 same-scope source messages and 250 KB serialized source metadata/text; individual source text over 30 KB is unavailable to the checker. Evidence validity is explicitly reviewed, capped at 24 hours; a check/approval expires within 60 seconds or earlier source expiry. These are fail-closed limits, not guarantees that an external fact remains current.

## Database change and security scope

The proposed DDL is `scripts/mcc_reply_evidence_integration.sql`. It is not a numbered migration and has not been applied outside disposable PGlite tests. The Supabase CLI is unavailable in this environment; create the canonical migration with the CLI in the authorized integration environment after review. Do not run this proposal twice or apply it to production as an ad hoc script.

Existing source/draft RLS and provider scopes are not relaxed. New tables deny all browser access; server functions explicitly reject foreign ownership, scope changes, missing revisions, stale evidence, and invalid approval bindings. Internal source hooks lock thread before context; they do not alter generation-fence/queue/receipt/control functions. Source bodies and evidence are never sent to a model. Source body loading is a distinct authenticated user action.

The database state comparison and lock protocol closes check-to-reservation changes inside the database. No database transaction remains open during provider HTTP. A fact that changes after the final send decision cannot recall an external send; Gmail/Twilio and PostgreSQL cannot be atomically committed together. Native lock/race proof and actual PostgREST/Deno behavior remain release gates.

## Validation commands

- `npm run test:reply-evidence`: deterministic checker tests; actual proposed SQL in PGlite; actual review/send handlers with mocked authentication/provider boundaries; integrated React DOM review flows; source-body ownership/cache cases; strict TypeScript against the actual SDK declarations; native test syntax check; frontend build
- `npm run test:phase3b`: existing project aggregate regressions and frontend build. Its three literal-approval assertions were replaced with persisted-gate assertions rather than deleted
- Prepared but unrun here: `REPLY_TEST_DATABASE_URL=postgresql://.../mcc_reply_test_<id> node --import tsx tests/reply-native-concurrency.test.mjs`. It refuses non-loopback hosts and non-test database names and expects a fresh disposable cluster

The native suite explicitly inspects `pg_locks`/`pg_stat_activity` to prove source-write/reservation ordering and two-session one-use behavior. It uses the actual proposal against a minimal verified-column fixture; it does not replace complete canonical Supabase-schema/Edge tests.

A real browser visual check could not be completed: agent-browser could not create its default socket directory, and the available cloud browser rejected the loopback preview URL. These restrictions were not bypassed. Six integrated React DOM scenarios passed, but no rendered desktop/mobile screenshot or visual pass is claimed.

## Required validation-only native CI scope

1. Apply the exact proposal to an empty disposable PostgreSQL database and run the prepared concurrent-session suite; preserve logs and source hashes
2. Run the combined canonical Supabase fixture with the cutover caller tags, existing ingestion RPCs and this message invalidation trigger; prove no inverse lock ordering or ingestion regression
3. Exercise new RPCs through actual PostgREST with authenticated/anon/service roles, exact timestamp/JSON behavior, actor binding and error/zero-row handling
4. Add the three new API files to deployment materialization; run native Deno API checks and the actual Edge review plus both send routes with synthetic provider endpoints and blocked nonlocal egress
5. Run browser review/edit/revert/navigation/repeated-send/source-loading cases against the isolated app, including mobile layout and interrupted responses

No production credentials, database writes, provider sends, new OAuth scope or paid resource belongs in this CI work. A green cutover PR alone does not validate this reply integration.

## Release boundary

Before release, review the exact migration, privileges, trigger lock order and complete API bundle. Migration must precede code selecting the new draft fields. Keep the new sending switch off while checking API/UI compatibility; enabling it is a separate consequential change. Preserve the cutover's tagged-API-before-fence rollout order. Publishing, merging, applying DDL, deploying and enabling sending each need their appropriate authorization; none occurred in this task.

Rollback should first disable the server-owned sending switch. Preserve all evidence/approval/dispatch audit records and reconcile UNKNOWN outcomes. Do not roll back to the old literal-approval bypass or delete dispatch records as a recovery shortcut.

## Native CI follow-on

See `REPLY_NATIVE_VALIDATION.md` for the prepared validation-only native Auth/PostgREST/Edge/Chromium matrix and exact API materializer. Native execution remains pending until an exact-commit CI receipt is recorded. The follow-on adds one post-lock reservation replay correction; the earlier patch remains preserved.

## Receipt-backed outbound source scope

Canonical Gmail ingestion leaves outbound contact IDs empty. Such messages qualify only with an existing SENT reply-dispatch receipt binding the exact provider message ID, user, thread, business/client, sending account, sender and sole recipient. Stored extra CC/BCC, aliases or foreign account/client links deny scope. Hashes/invalidation include direction, addresses and headers. This adds no table or privilege. The source origin is visible as your prior outbound message, never supplier confirmation; it remains human-reviewed evidence.

Historical sent messages without that trustworthy receipt stay excluded because old metadata cannot prove a complete BCC envelope. Their presence keeps complete-context approval blocked, even after bodies load. The UI explains that limitation; it does not silently omit them and claim full review. Legacy thread support needs a separate trustworthy envelope/source adapter.
