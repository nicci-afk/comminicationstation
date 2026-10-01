import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.profiles(user_id uuid primary key); create table public.businesses(id uuid primary key);
insert into profiles values ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');`);
// Actual repo schema and view, not a rewritten model of the new code.
await db.exec(fs.readFileSync('supabase/migrations/0023_mcc_v2_phase1.sql','utf8'));
await db.exec(fs.readFileSync('scripts/mcc_phase3_manual_writes.sql','utf8'));
await db.exec(fs.readFileSync('scripts/mcc_phase3b_fast_capture.sql','utf8'));
const user='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002', request='00000000-0000-4000-8000-000000000003';
async function capture(who=user,note='Call Lois tomorrow',id=request) { return (await db.query('select mcc_fast_capture($1,$2,$3) as result',[who,id,note])).rows[0].result; }
async function review(id, who=user, action='Confirm itinerary', project=null) { return db.query('select mcc_review_capture($1,$2,$3,$4)',[who,id,action,project]); }
async function count(table) {return Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);}
const created=await capture(); assert.equal(created.idempotent,false);
const row=(await db.query('select * from obligations where id=$1',[created.obligation_id])).rows[0];
assert.equal(row.description,'Call Lois tomorrow'); assert.equal(row.state,'BLOCKED'); assert.equal(row.due_at,null); assert.equal(row.project_id,null); assert.equal(row.verification_state,'UNVERIFIED');
assert.equal(await count('obligations'),1); assert.equal(await count('obligation_sources'),1); assert.equal(await count('obligation_events'),1);
assert.equal((await capture()).obligation_id,created.obligation_id); assert.equal(await count('obligation_events'),1);
await assert.rejects(capture(user,'Changed note'),/different note/);
await assert.rejects(capture(user,'  ','00000000-0000-4000-8000-000000000005'),/characters/);
await assert.rejects(capture(user,'x'.repeat(10001)),/characters/);
await assert.rejects(review(created.obligation_id,other),/not found/);
await assert.rejects(review(created.obligation_id,user,'x',request),/owned project/);
assert.equal(await count('obligation_events'),1);
await review(created.obligation_id);
const reviewed=(await db.query('select * from obligations where id=$1',[created.obligation_id])).rows[0];
assert.equal(reviewed.state,'TODAY'); assert.equal(reviewed.verification_state,'PARTIALLY_VERIFIED'); assert.equal(reviewed.description,row.description); assert.equal(await count('obligation_events'),2);
await assert.rejects(review(created.obligation_id),/no longer/);
const action=kind=>db.query('select mcc_apply_manual_action($1,$2,$3)',[user,created.obligation_id,kind]);
await action('DONE'); assert.equal(await count('obligation_events'),3);
await action('DONE'); assert.equal(await count('obligation_events'),3);
await action('UNDO_LAST'); assert.equal((await db.query('select state from obligations where id=$1',[created.obligation_id])).rows[0].state,'TODAY');
await action('UNDO_LAST'); const undone=(await db.query('select * from obligations where id=$1',[created.obligation_id])).rows[0]; assert.equal(undone.state,'BLOCKED'); assert.equal(undone.title,row.title); assert.equal(undone.verification_state,'UNVERIFIED');
const isolated=await capture(other); assert.notEqual(isolated.obligation_id,created.obligation_id);
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
assert.equal(await count('obligations'),1);
await assert.rejects(capture(),/permission denied/);
await assert.rejects(db.exec(`insert into obligations(user_id,type,title) values('${user}','ACTION','evil')`),/permission denied/);
await assert.rejects(db.exec(`update obligations set title='evil'`),/permission denied/);
await assert.rejects(review(created.obligation_id),/permission denied/);
await db.exec('reset role');
await review(created.obligation_id);
await db.query("insert into obligation_events(user_id,obligation_id,event_type,actor_type) values($1,$2,'SOURCE_UPDATED','SYSTEM')",[user,created.obligation_id]);
await assert.rejects(action('UNDO_LAST'),/newer change/);
// Atomicity: force audit failure; neither obligation nor source may survive.
await db.exec("create function reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$; create trigger fail_audit before insert on obligation_events for each row execute function reject_audit();");
const before=await count('obligations'); await assert.rejects(capture(user,'Another note','00000000-0000-4000-8000-000000000004'),/audit unavailable/); assert.equal(await count('obligations'),before);
await db.close();
console.log('PASS: isolated PostgreSQL capture, review, retries, audit rollback, undo and tenant isolation');
