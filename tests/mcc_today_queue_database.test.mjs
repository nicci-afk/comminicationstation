import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
const user = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const item = '00000000-0000-4000-8000-000000000003', thread = '00000000-0000-4000-8000-000000000004';
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create table profiles(user_id uuid primary key); create table threads(id uuid primary key); create table contacts(id uuid primary key); create table businesses(id uuid primary key); create table messages(id uuid primary key);
 insert into profiles values('${user}'),('${other}'); insert into threads values('${thread}'); insert into messages values('00000000-0000-4000-8000-000000000006'),('00000000-0000-4000-8000-000000000007');`);
// Exercise the canonical table, RLS policies and state-transition audit trigger.
const source = fs.readFileSync('supabase/migrations/0003_queue_pipeline.sql', 'utf8');
await db.exec(source.slice(source.indexOf('create table public.queue_items ('), source.indexOf('-- ---------------------------------------------------------------- pipeline')));
// Include the deployed canonical hotfix, rather than testing only the superseded trigger.
const hotfix = fs.readFileSync('supabase/migrations/0006_hotfixes.sql', 'utf8');
await db.exec(hotfix.slice(hotfix.indexOf('create or replace function public.log_queue_transition()')));
await db.exec(fs.readFileSync('supabase/migrations/0023_mcc_v2_phase1.sql', 'utf8'));
await db.exec(`insert into obligations(user_id,type,title,state,due_at,due_kind) values('${user}','PROMISE','Complete the requested work','TODAY','2030-02-03T12:00:00Z','HARD');`);
const obligationBefore = (await db.query('select * from obligations')).rows[0];
await db.exec(`grant usage on schema public,auth to authenticated; grant select,update on queue_items to authenticated; grant select on queue_item_events to authenticated;
 insert into queue_items(id,user_id,thread_id,state,channel,category) values('${item}','${user}','${thread}','needs_attention','email','needs_reply');
 set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
const row = async () => (await db.query('select *, updated_at::text as version from queue_items where id=$1', [item])).rows[0];
const before = await row();
const save = async (expected, state, snooze = null, followup = null) => db.query(`update queue_items set state=$1,snoozed_until=$2,follow_up_at=$3 where id=$4 and state=$5 and updated_at=$6::timestamptz and snoozed_until is not distinct from $7::timestamptz and follow_up_at is not distinct from $8::timestamptz and last_inbound_message_id is not distinct from $9::uuid and message_count=$10 returning *,updated_at::text as version`, [state,snooze,followup,item,expected.state,expected.version,expected.snoozed_until,expected.follow_up_at,expected.last_inbound_message_id,expected.message_count]);
let result = await save(before, 'responded'); assert.equal(result.rows.length, 1); const saved = result.rows[0]; assert.equal(saved.state, 'awaiting_reply'); assert.ok(saved.follow_up_at);
assert.equal((await save(before, 'responded')).rows.length, 0, 'repeat click cannot match the old state/version');
result = await save(saved, before.state, before.snoozed_until, before.follow_up_at); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].follow_up_at, null);
let events = (await db.query('select from_state,to_state,actor from queue_item_events order by id')).rows;
assert.deepEqual(events, [{ from_state: 'needs_attention', to_state: 'awaiting_reply', actor: 'user' }, { from_state: 'awaiting_reply', to_state: 'needs_attention', actor: 'user' }]);
// Same-state ingestion (0008) changes the inbound ID/count/preview but the
// canonical trigger does not advance updated_at. Compare inbound identity too.
const priorInbound = await row();
await db.query("update queue_items set last_inbound_message_id='00000000-0000-4000-8000-000000000006',message_count=message_count+1,preview='New unseen inbound' where id=$1", [item]);
assert.equal((await row()).version, priorInbound.version);
for (const state of ['responded','dismissed','snoozed']) assert.equal((await save(priorInbound,state)).rows.length,0,'unseen inbound must block '+state);
const snoozed = (await save(await row(), 'snoozed', '2026-10-03T12:00:00Z')).rows[0];
await db.query("update queue_items set snoozed_until='2026-10-04T12:00:00Z' where id=$1", [item]);
assert.equal((await save(snoozed, 'needs_attention')).rows.length, 0, 'same-state changes to fields being restored must block Undo');
const beforeNewInbound = await row();
await db.query("update queue_items set last_inbound_message_id='00000000-0000-4000-8000-000000000007',message_count=message_count+1,preview='New inbound after snooze' where id=$1", [item]);
assert.equal((await row()).version,beforeNewInbound.version);
assert.equal((await save(beforeNewInbound,'needs_attention')).rows.length,0,'unseen inbound must also block Undo');
// User-specified dates are preserved independently from reply/completion status.
const explicit = '2030-01-02T15:30:00Z';
const beforeExplicit = await row();
const scheduled = (await save(beforeExplicit, 'awaiting_reply', null, explicit)).rows[0];
assert.equal(new Date(scheduled.follow_up_at).toISOString(), '2030-01-02T15:30:00.000Z');
assert.equal(scheduled.resolved_at, null, 'recording a check-in is not resolution');
assert.equal((await save(beforeExplicit, 'awaiting_reply', null, explicit)).rows.length, 0, 'retry cannot mutate an already-changed row');
assert.equal((await save(beforeExplicit, 'dismissed')).rows.length, 0, 'stale manual dismissal cannot remove the recorded follow-up');
// A new inbound reopens attention while preserving the recorded check-in.
await db.query("update queue_items set state='needs_attention',last_inbound_message_id='00000000-0000-4000-8000-000000000006',message_count=message_count+1 where id=$1", [item]);
assert.equal((await save(scheduled, 'needs_attention')).rows.length, 0, 'stale Undo cannot erase a newer inbound');
const repliedAgain = (await save(await row(), 'responded', null, explicit)).rows[0];
assert.equal(repliedAgain.state, 'awaiting_reply');
assert.equal(new Date(repliedAgain.follow_up_at).toISOString(), '2030-01-02T15:30:00.000Z', 'canonical four-day fallback must not override an explicit check-in');
const dismissed = (await save(repliedAgain, 'dismissed', null, explicit)).rows[0];
assert.equal(dismissed.state, 'dismissed', 'an explicit manual dismissal is not reopened or relabeled as unresolved');
assert.deepEqual((await db.query('select * from obligations')).rows[0], obligationBefore, 'queue follow-up and response leave the canonical executive promise and deadline unchanged');
await db.exec(`select set_config('request.jwt.claim.sub','${other}',false);`);
assert.equal((await db.query('select * from queue_items')).rows.length, 0);
assert.equal((await save(snoozed, 'needs_attention')).rows.length, 0, 'cross-tenant updates return no row');
await db.close();
console.log('PASS: canonical queue schema/trigger, confirmed conditional writes, repeat/conflicting Undo and same-state unseen-inbound guards, follow-up restoration, audit and tenant isolation');
