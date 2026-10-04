# Queue follow-up preservation

Local review candidate based on `e4159499072b7e3ee0e73e69d6eb9776dbe76f72`.
No production migration, function deploy, or external send is included.

## Verified failure and scope

Canonical migration `0006_hotfixes.sql` replaces `log_queue_transition`: a
`responded` transition for `needs_reply`, `urgent`, or `scheduling` becomes
`awaiting_reply`. It preserves an existing `follow_up_at`; otherwise it uses the
existing four-day policy. `useItemAction` previously compared the returned state
literally with `responded`, falsely treating this successful write as unconfirmed.
The existing database test loaded only the superseded `0003` trigger, and the DOM
fixture also omitted the state normalization. Both now exercise the canonical
behavior.

The Queue screen also grouped `responded` and `dismissed` under "Done" and silently
limited the displayed list to 200 records. A queue response is not affirmative
evidence that an executive obligation is completed. This patch labels the states
accurately and makes every matching queue page reachable. It does not clear or
reinterpret legitimate manual dismissal or executive completion.

## Behavior

- Only the canonical `responded` → `awaiting_reply` normalization is accepted, and
  only with the recognized category and a valid stored follow-up timestamp. Other
  state/date mismatches remain unconfirmed. Confirmation still requires exactly
  one returned owned row.
- Today offers **Set follow-up date**. The input starts blank and explicitly uses
  UTC. It rejects past, malformed, and calendar-invalid dates. The typed date is
  the user's next check-in, not a client deadline. Saving moves the queue record
  to `awaiting_reply` with that exact timestamp; it does not set `resolved_at`,
  send a message, infer a response, or change an executive obligation.
- The form saves against its captured item/version/inbound-message/count/date
  snapshot. A newer inbound, competing dismissal, or changed follow-up prevents
  a stale save or Undo. A double click cannot handle the next item. Cancel and
  selecting another card discard the pending form without a write.
- Saved receipts say the follow-up remains open and show the stored UTC date.
  The existing four-day rule is disclosed, not changed into a client deadline.
- Queue offers **Open follow-ups** and **Replied / dismissed**, shows due or
  missing recorded dates, and uses exact-count, stable pagination. Follow-ups are
  date-first, with undated rows last but reachable. A missing/truncated count,
  read error, stale snapshot, or pending fetch does not claim the list is empty.
- Back/Forward restores the selected Queue view/page. A vanished final page is
  recovered by a fresh first-page read, following the existing Today behavior.

## Existing semantics deliberately preserved

- No new DDL, table, field, RPC, service, model call, cron, reminder, or grant.
- Existing `queue_item_events` records the state transition. As before, it does
  not separately retain the exact follow-up date as event evidence. The current
  value remains on `queue_items`; this feature does not expose same-state date
  editing that would bypass the existing transition audit.
- Existing SLA sweep consumes a due follow-up timestamp when reopening
  `needs_attention`; this patch does not change that sweep or claim it ran.
- Executive obligation state/deadline/completion stays in the canonical
  obligations model. A database test verifies it is unchanged by response,
  explicit scheduling, and manual dismissal.
- Historical backlog is not imported, cleared, muted, or promoted. Its separate
  existing screen and behavior are outside this change.
- Send routes, provider outcomes, `ItemDetail`, reply approval controls, and the
  generation-fenced runtime are untouched.

## Validation

`bash scripts/validate_mcc_phase3b_local.sh` includes the new deterministic helper
and Queue DOM tests alongside all existing Phase 3B, Today, database, static,
TypeScript, and production-build checks. Relevant coverage includes:

- Canonical trigger normalization and preservation of an explicit future date
- Legitimate dismissal, stale dismissal, repeated saves, and conflict-safe Undo
- New inbound with unchanged state/updated_at but changed ID/message count
- Explicit UTC date validation; cancel, duplicate click, failed write and retry
- Original target retention; selecting another card cancels the form
- 401-row follow-up and Today lists, stable pagination, shrinking-page recovery
- Failed/missing/truncated reads, stale data, business filters and Back/Forward
- Canonical executive promise/deadline preservation and two-tenant RLS

`CHROMIUM_PATH=/usr/bin/chromium node tests/mcc_today_queue_browser.test.mjs`
contains desktop/mobile follow-up, normalized reply, cancel/Undo, duplicate save,
and unseen-inbound scenarios using local intercepted API traffic only. This
browser test is **not verified in this executor**: Chromium launch is prohibited
by its socket policy, and the supported cloud browser rejects loopback access.
Run it in permitted CI before publication/merge. No screenshots or visual-pass
claim is supplied.

## Integration and release gates

All modified original files have been matched against main's exact Git blob
hashes. This is a frontend/test-only patch. It needs no PR19 DDL or send-route
change. Integrate it on the reviewed source, rerun the aggregate tests and the
browser suite, and verify the deployed queue trigger still matches the documented
normalization before any separately authorized frontend release. Provider-ingestion
concurrency is a separate concern; these UI CAS tests do not claim to fix it.
