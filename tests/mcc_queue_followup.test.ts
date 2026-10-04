import assert from 'node:assert/strict';
import { explicitFollowUpUtc, followUpLabel, queueActionConfirmed } from '../apps/web/src/lib/queueFollowUp';
import type { QueueItem } from '../apps/web/src/lib/types';
const item = { id: 'queue-1', state: 'awaiting_reply', category: 'needs_reply', follow_up_at: '2030-01-02T15:30:00Z', snoozed_until: null } as QueueItem;
for (const category of ['needs_reply', 'urgent', 'scheduling']) assert.ok(queueActionConfirmed(item.id, { state: 'responded' }, { ...item, category }));
assert.ok(queueActionConfirmed(item.id, { state: 'awaiting_reply', follow_up_at: '2030-01-02T15:30:00.000Z', snoozed_until: null }, item));
assert.ok(queueActionConfirmed(item.id, { state: 'dismissed' }, { ...item, state: 'dismissed' }), 'explicit dismissal remains valid');
assert.ok(queueActionConfirmed(item.id, { state: 'responded' }, { ...item, state: 'responded', category: 'other' }), 'nonconversational reply remains responded');
for (const saved of [null, { ...item, id: 'another-item' }, { ...item, category: 'other' }, { ...item, follow_up_at: null }, { ...item, follow_up_at: 'invalid' }, { ...item, state: 'dismissed' }]) {
  assert.equal(queueActionConfirmed(item.id, { state: 'responded' }, saved as QueueItem), false);
}
assert.equal(queueActionConfirmed(item.id, { state: 'responded', follow_up_at: '2031-01-01T00:00:00Z' }, item), false, 'a supplied date cannot be silently replaced');
assert.equal(queueActionConfirmed(item.id, { state: 'awaiting_reply', follow_up_at: null }, item), false);
assert.equal(queueActionConfirmed(item.id, { state: 'snoozed' }, item), false);
const now = Date.parse('2026-10-04T03:00:00Z');
assert.equal(explicitFollowUpUtc('2026-10-05T13:45', now), '2026-10-05T13:45:00.000Z');
assert.equal(explicitFollowUpUtc('2028-02-29T13:45', now), '2028-02-29T13:45:00.000Z');
for (const value of ['', 'tomorrow', '2026-10-04T03:00', '2026-01-01T12:00', '2027-02-29T12:00', '2026-11-31T12:00', '2026-13-01T12:00', '2026-10-05T24:00', '2026-10-05T13:60', '2026-10-05T13:45Z', '2026-10-05']) assert.equal(explicitFollowUpUtc(value, now), null, value);
assert.equal(followUpLabel(null), 'No follow-up date recorded');
assert.equal(followUpLabel('invalid'), 'No follow-up date recorded');
assert.match(followUpLabel('2030-01-02T15:30:00Z'), /^Follow-up scheduled: 2030-01-02 15:30 UTC$/);
assert.match(followUpLabel('2020-01-02T15:30:00Z'), /^Follow-up due: 2020-01-02 15:30 UTC$/);
console.log('PASS: strict canonical response normalization, explicit dismissal, exact future UTC dates, invalid-date rejection and stored follow-up labels');
