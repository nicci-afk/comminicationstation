/** UNRUN HERE: needs a disposable native PostgreSQL cluster; never production. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';
import {checkReply} from '../supabase/functions/api/_shared/reply-evidence.ts';
const url=process.env.REPLY_TEST_DATABASE_URL;
if(!url)throw Error('Set REPLY_TEST_DATABASE_URL for a fresh disposable local test database');
const parsed=new URL(url);
assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname),'Only loopback test PostgreSQL is allowed');
assert.match(parsed.pathname,/^\/mcc_reply_test_[a-z0-9_]+$/,'Use a fresh mcc_reply_test_ database');
const psql=process.env.PSQL_BIN||'psql';let serial=0;
function session(name){const child=spawn(psql,['-X','-q','-A','-t','-v','ON_ERROR_STOP=1',url],{env:{...process.env,PGAPPNAME:name},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve(out.trim()):reject(Error(err.trim()||'psql failed')));});return {child,done,out:()=>out};}
async function exec(sql,name='reply-exec-'+serial++){const s=session(name);s.child.stdin.end('set statement_timeout=10000;\n'+sql+'\n');return s.done;}
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const i={user:'00000000-0000-4000-8000-000000000001',other:'00000000-0000-4000-8000-000000000002',business:'00000000-0000-4000-8000-000000000003',contact:'00000000-0000-4000-8000-000000000004',account:'00000000-0000-4000-8000-000000000005',thread:'00000000-0000-4000-8000-000000000006',item:'00000000-0000-4000-8000-000000000007',message:'00000000-0000-4000-8000-000000000008',draft:'00000000-0000-4000-8000-000000000009'};
const cmdSQL=(op,args)=>`select public.mcc_reply_command('${i.user}',${quote(op)},${quote(JSON.stringify(args))}::jsonb);`;
async function command(op,args){return JSON.parse(await exec('set role service_role;'+cmdSQL(op,args)));}
async function approved(){const state=await command('SNAPSHOT',{draft_id:i.draft}),now=new Date().toISOString();const result=await checkReply({...state,evidenceRead:{...state.evidenceRead,readAt:now}},now);assert.equal(result.status,'SOURCE_SUPPORTED_REQUIRES_REVIEW');const c=await command('CHECK',{draft_id:i.draft,revision:state.draft.revision,state,result});return command('APPROVE',{check_id:c.check_id,review_key:c.check.reviewKey,snapshot_key:c.check.snapshotKey,coverage_reviewed:true});}
async function waitFor(predicate,label){const until=Date.now()+7000;while(Date.now()<until){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout waiting for '+label);}
async function held(sql,name){const s=session(name);s.child.stdin.write('set statement_timeout=10000;begin;set role service_role;'+sql+"select 'HELD';\n");await waitFor(()=>s.out().includes('HELD'),name);return s;}
async function lockWait(name){await waitFor(async()=>Number(await exec(`select count(*) from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name=${quote(name)} and a.wait_event_type='Lock' and not l.granted;`))>0,'observed pg_locks wait for '+name);}
// Installation refuses to overwrite an existing schema. A fresh disposable cluster is required.
assert.equal(await exec("select count(*) from pg_tables where schemaname='public';"),'0');
await exec(fs.readFileSync('tests/fixtures/reply-domain.sql','utf8'));
await exec(`insert into profiles values('${i.user}'),('${i.other}');insert into businesses values('${i.business}','${i.user}');insert into contacts values('${i.contact}','${i.user}');insert into gmail_accounts values('${i.account}','${i.user}','owner@example.invalid','active',true,null);insert into threads values('${i.thread}','${i.user}','email','${i.account}',null,'thread');insert into queue_items values('${i.item}','${i.user}','${i.thread}','${i.contact}','${i.business}','email','client@example.invalid','Quote');insert into messages(id,user_id,thread_id,contact_id,direction,channel,from_identifier,body_text,sent_at,subject) values('${i.message}','${i.user}','${i.thread}','${i.contact}','inbound','email','client@example.invalid','Source',clock_timestamp()-interval '1 hour','Quote');update messages set gmail_account_id='${i.account}';`);
await exec(fs.readFileSync('scripts/mcc_reply_evidence_integration.sql','utf8'));
const save={queue_item_id:i.item,draft_id:i.draft,revision:0,text:'Thank you.',claims:[]};await command('SAVE',save);
const a=await approved();
const writer=await held("update messages set body_text='New source' where id='"+i.message+"';",'reply-source-writer');
const blocked=exec('set role service_role;'+cmdSQL('RESERVE',{approval_id:a.approval_id,channel:'email'}),'reply-reserver').then(value=>({value}),error=>({error}));
await lockWait('reply-reserver');writer.child.stdin.end('commit;\n');await writer.done;assert.match((await blocked).error?.message??'',/state changed/);
console.log('PASS: source mutation lock blocks reservation; committed source change rejects old approval');
const a2=await approved();
const reservation=await held(cmdSQL('RESERVE',{approval_id:a2.approval_id,channel:'email'}),'reply-held-reservation');
const update=exec("set role service_role;update messages set body_text='Later source' where id='"+i.message+"';",'reply-blocked-source');
await lockWait('reply-blocked-source');reservation.child.stdin.end('commit;\n');await reservation.done;await update;
const dispatch=JSON.parse(reservation.out().split('\n').find(line=>line.startsWith('{')));
await assert.rejects(command('BEGIN',{dispatch_id:dispatch.dispatch_id,channel:'email'}),/state changed/);
await command('CANCEL',{dispatch_id:dispatch.dispatch_id});
console.log('PASS: reservation lock orders before source mutation; changed source blocks final begin');
await command('SAVE',{...save,revision:1});const a3=await approved();
const results=await Promise.all([command('RESERVE',{approval_id:a3.approval_id,channel:'email'}),command('RESERVE',{approval_id:a3.approval_id,channel:'email'})]);
assert.equal(new Set(results.map(r=>r.dispatch_id)).size,1);assert.equal(results.filter(r=>!r.existing).length,1);
console.log('PASS: two native sessions reserve one durable dispatch');
await assert.rejects(exec('set role authenticated;select * from public.reply_approvals;'),/permission denied/);
await assert.rejects(exec('set role authenticated;'+cmdSQL('SNAPSHOT',{draft_id:i.draft})),/permission denied/);
console.log('PASS: native table and RPC privilege denials');
console.log(await exec('select version();'));
