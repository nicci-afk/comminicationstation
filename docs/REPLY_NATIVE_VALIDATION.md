# Reply native validation candidate

## Publication scope

This is a draft-only validation extension to the local reply integration. Main was rechecked at `aaa2735a64732e0976c5abfa7f25f17b5599de95`. PR18 remains separate at `019098c85561c234dc3c49f0e16f0fb42c3b7ec6`. The reply patch never changes the shared utility or a generation migration. No production workflow is changed.

The previous reviewed patch, SHA-256 `616bc51a8da3eada7d493aba1108757130b15d229ec5a5ddf4fe1d2c57bfb967`, is preserved. The only subsequent application change is a post-lock idempotent reservation lookup. A request that waited while the same approval was reserved now returns the committed intent before running the unresolved-context gate. It never creates another send permission. All other additions in this stage are validation, source materialization, or documentation.

## CI jobs

`.github/workflows/mcc-reply-validation.yml` has a local test job and two native/browser matrix jobs. Permissions are `contents: read`; checkout credentials are not persisted. It uses existing lockfiles, Node 24.14.1, Supabase CLI 2.75.0, Deno v2.9.0 and the existing pinned Playwright dependency. There are no deployment, migration-to-remote, new secret, or provider/model steps.

- `main`: current-main utility, reply candidate, canonical repository schema subset, retained email ingestion, actual local Supabase Auth/PostgREST/Edge
- `cutover`: the same candidate, exact PR18 utility blob `87c393bb797b5f36494ccad8f91d555782b0f646`, and the exact paused generation-fence migration from that pinned checkout

The historical checkpoint/containment job is pinned to the same original main as PR18's reviewed change. This preserves its old source pins instead of weakening them. Current reply sources have a separate 37-file API inventory, import-closure check and tamper tests. Main's unrelated workflow jobs remain unchanged.

## Isolation and source fidelity

`validate_reply_native.sh` creates a unique disposable `mcc-reply-*` local project, rejects wrong CLI versions, unsets production/model environment variables, loads only an explicit schema subset, and excludes cron/poke migrations. Its no-op worker poke and queue support are labeled fixtures. No user data or credentials are copied. Real local GoTrue user tokens are created only inside this temporary project and are not artifacts.

`prepare_reply_native.mjs` copies the eight exercised application modules byte-for-byte. The wrapper surrounds them with request-local HTTP interception: actual local Auth/REST calls pass through; only declared synthetic OAuth/Gmail/Twilio responses are returned; every other destination throws. The send-enabled wrapper receives the real CLI env-file flag. Because this Edge runtime prohibits environment mutation, the separate default-disabled fixture labels a narrow environment-read override that returns an absent flag. All other environment reads are unchanged. Both variants live only in the temporary functions directory. Supabase's network-facing router is not modified in production. The full router registration is checked by source/closure tests; the fixture invokes the exact three route handlers directly.

The API materializer separately checks all 37 payload files and import closure, preserves existing entrypoint/import-map/auth settings, and rejects unrelated content changes. It does not deploy. A later combined release still needs fresh production source preflight and its own reviewed manifest/approval.

## Native assertions

Actual database privileges and RLS; real Auth actor binding; old manual sentinel bypass; foreign user/source; missing evidence; exact source excerpt; contradictory evidence, explicit later supersession and revocation; exact immutable payload for email/SMS/WhatsApp; concurrent replay; default-off behavior; uncertain provider outcome; known-send ingestion failure; edit/revert/source invalidation.

Three independent PostgreSQL-session interleavings explicitly observe `pg_stat_activity`/`pg_blocking_pids`: source mutation before reservation, reservation before source mutation/final BEGIN, and concurrent reservation of one approval. These run with canonical schema and again with the cutover fence. Zero cron jobs and zero queued database HTTP are asserted.

Chromium runs the actual `ReplyReview` component against those native services with a local-only transport adapter and a minimal page shell. Scenarios cover price-to-evidence-to-send, edit/revert, SMS, default-off UI, lost response/status recovery, and foreign initial draft/back-forward. It records desktop/mobile screenshots, checks overflow and page errors, and blocks nonlocal browser requests. This is not a full ItemDetail/router end-to-end proof; the existing full-app browser job remains separate.

## Current verification status

Before draft publication: local 82-test suite, six DOM integration scenarios, four body-source scenarios, strict SDK TypeScript, frontend build, seven materializer/tamper tests, shell/JavaScript/YAML syntax and wrapper bundling pass. Native Supabase/Chromium execution is pending CI, not claimed as passed. Existing frontend bundle-size warning remains.

The pre-existing minimal-column native harness remains available but is not substituted for the new canonical native suite. External authoritative fact adapters, complete semantic claim detection, provider exactly-once delivery and absolute factual accuracy are outside this candidate. Default runtime sending remains off. Production security DDL, merge/deployment and live send activation are separate release gates.

## Follow-on validation corrections

The first native run installed both canonical schemas but stopped before application assertions because the fixture attempted unsupported `Deno.env.set`. The wrapper now uses the supported CLI env-file for enabled tests, with a labeled missing-flag read fixture for the disabled case. Browser bundles resolve React from the web package to avoid duplicate instances. A full ItemDetail native-browser test adds late generated-draft isolation, Back/navigation approval invalidation and manual SMS dispatch. Only generation is synthetic; the page, hooks, router, REST and review/send routes are real. The send callback now refreshes item and event queries as well as messages/queue. No approval assertions were removed.

The existing whole-app browser fixture also needed its copied `apps/web` directory to preserve repository depth for the shared checker import. Its disposable schema now includes the proposed reply DDL. Its assertions remain unchanged.

The source-loading extension exercises the real body route, native cache write, context revision and UI recheck. Provider message IDs must match; cache writes compare the original owner/account/provider identity and body state and must return the selected row. Provider identity is also included in source hashing/invalidation. Native fixtures cover wrong-ID and raced-ID responses without contacting Gmail. The full-page responded check targets the state badge so the matching history event does not create a strict-selector ambiguity.

## Receipt-backed lifecycle extension

The body-loading head `140c04f0ec2f6d303c88ef7fe9922fe14744ef4a` passed all seven CI jobs. The subsequent reviewed source-scope extension admits canonical null-contact outbound Gmail messages only with a matching immutable SENT dispatch receipt, and tests post-send/new-inbound continuity, wrong recipient, extra CC/BCC, unverified alias and account transfer. Direction is visible; human review cannot be promoted to supplier authority. Missing legacy receipt/envelope data remains a visible full-context blocker. The extension requires a fresh exact-head CI receipt.
