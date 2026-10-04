// Native isolated PostgreSQL sessions + real PostgREST. Never contacts production.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const F=path.join(ROOT,'tests/fixtures/mcc-generation');
const GEN='gmail-sync-checkpoints-g1', A='00000000-0000-4000-8000-000000000001', U='00000000-0000-4000-8000-000000000002';
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const container=process.env.MCC_GENERATION_DB_CONTAINER;
assert(/^supabase_db_mcc-generation-[a-z0-9-]+$/.test(container??''),'disposable generation DB required');
const status=JSON.parse(fs.readFileSync(process.env.MCC_GENERATION_STATUS,'utf8'));
const url=status.API_URL??status.api_url, key=status.SERVICE_ROLE_KEY??status.service_role_key, anon=status.ANON_KEY??status.anon_key;
assert(new URL(url).protocol==='http:' && ['127.0.0.1','localhost'].includes(new URL(url).hostname));
const evidence=process.env.MCC_GENERATION_EVIDENCE;
const observations=[];
function sql(s){const r=spawnSync('docker',['exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input:s,encoding:'utf8',timeout:25_000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function rows(s){return JSON.parse(sql(`select coalesce(json_agg(t),'[]') from (${s}) t;`));}
class Session{
 constructor(){this.p=spawn('docker',['exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']);this.buf='';this.err='';this.n=0;this.pending=null;this.closed=false;this.p.stdout.on('data',b=>{this.buf+=b;this.flush();});this.p.stderr.on('data',b=>this.err+=b);this.p.on('exit',code=>{this.closed=true;if(this.pending){this.pending.reject(Error(this.err||`psql exited ${code}`));this.pending=null;}});}
 flush(){const p=this.pending;if(!p)return;const pos=this.buf.indexOf(p.mark+'\n');if(pos<0)return;const data=this.buf.slice(0,pos).trim();this.buf=this.buf.slice(pos+p.mark.length+1);this.pending=null;p.resolve(data);}
 run(s){assert(!this.pending,'one statement per session');assert(!this.closed);return new Promise((resolve,reject)=>{const mark=`__done_${++this.n}__`;this.pending={mark,resolve,reject};this.p.stdin.write(s+'\n\\echo '+mark+'\n');});}
 async init(){this.pid=Number(await this.run("set statement_timeout='15s';set lock_timeout='12s';select pg_backend_pid();"));return this;}
 close(){if(!this.closed){this.p.stdin.end('rollback;\n\\q\n');}}
}
const sessions=[];
async function session(){const s=await new Session().init();sessions.push(s);return s;}
async function blocked(waiter,holder){const deadline=Date.now()+5000;while(Date.now()<deadline){const r=rows(`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=${waiter.pid}`)[0];if(r?.wait_event_type==='Lock' && r.blockers.includes(holder.pid)){observations.push(r);return;}await new Promise(r=>setTimeout(r,40));}throw Error(`No proven lock wait ${waiter.pid} on ${holder.pid}`);}
const api={'x-mcc-caller':'api-gmail-fence-v1'};
const sync=j=>({'x-mcc-caller':'gmail-sync-v1','x-mcc-sync-generation':GEN,'x-mcc-sync-job':String(j.msg_id),'x-mcc-sync-token':j.claim_token});
const context=h=>`set local role service_role;select set_config('request.headers',${quote(JSON.stringify(h))},true);`;
const activate=()=>sql(`update mcc_sync_internal.control set enabled=true,activated_at=clock_timestamp() where singleton;`);
const pause=()=>sql('update mcc_sync_internal.control set enabled=false where singleton;');
const enqueue=(msg={kind:'incremental',gmail_account_id:A})=>Number(sql(`select pgmq.send('sync_jobs',${quote(JSON.stringify(msg))}::jsonb);`));
const claim=()=>rows(`select * from public.claim_sync_jobs_v1('${GEN}',1,150)`)[0];
const finish=j=>`select public.finish_sync_job_v1('${GEN}',${j.msg_id},'${j.claim_token}',null);`;
const expire=()=>sql(`begin;select set_config('app.mcc_sync_generation','${GEN}',true);update pgmq.q_sync_jobs set vt=clock_timestamp()-interval '1 second' where msg_id>0;commit;`);
const clean=()=>sql(`truncate pgmq.q_sync_jobs,pgmq.q_triage_jobs,pgmq.q_pipeline_jobs,pgmq.q_digest_jobs,public.jobs_dead,mcc_sync_internal.claims restart identity;update mcc_sync_internal.control set enabled=true where singleton;`);
async function rest(p,{method='POST',body,headers={},token=key}={}){const r=await fetch(url+'/rest/v1/'+p,{method,headers:{apikey:anon,authorization:'Bearer '+token,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20_000)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};}
const payload=id=>({provider_message_id:id,thread_provider_id:'thread-'+id,direction:'inbound',from_identifier:'sender@example.invalid',from_name:'Fixture',to_identifiers:['owner@example.invalid'],sent_at:'2026-10-01T00:00:00Z',subject:'Synthetic',snippet:'Synthetic',headers:[],labels:['INBOX'],bulk:{is_bulk:false}});
const ingest=(id,h=api)=>rest('rpc/ingest_email_message',{body:{p_gmail_account_id:A,p:payload(id)},headers:h});

await test('native generation fence commit ordering and real PostgREST',async t=>{try{
 sql(`insert into public.allowed_emails(email) values('owner@example.invalid') on conflict do nothing;
 insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values('${U}','owner@example.invalid','{}','{}');
 insert into public.gmail_accounts(id,user_id,email_address,status,last_history_id,backfill_done,refresh_token_secret_id) values('${A}','${U}','owner@example.invalid','active',100,true,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');`);
 const migration=fs.readFileSync(path.join(F,'generation-fence-candidate.sql'),'utf8');
 await t.test('existing legacy writer makes installation time out atomically without partial objects',async()=>{
  const old=await session();await old.run(`begin;${context({})}update public.gmail_accounts set last_error='old-transaction' where id='${A}';`);
  const install=await session();const result=install.run(migration);const caught=result.then(()=>null,e=>e);await blocked(install,old);
  const e=await caught;assert.match(String(e),/lock timeout/);assert.equal(sql("select to_regnamespace('mcc_sync_internal') is null"),'t');await old.run('rollback;');old.close();
 });
 const warmAck=await session(),warmDead=await session();
 await warmAck.run("begin;set local role service_role;select public.ack_job('sync_jobs',0);rollback;");
 await warmDead.run("begin;set local role service_role;select public.dead_letter_job('sync_jobs',0,'{}','warm fixture');rollback;");
 const gate=await session();await gate.run('select pg_advisory_lock(9473201);select pg_advisory_lock(9473202);');
 const late=await session(),cached=await session();
 const lateResult=late.run(`begin;${context({})}select public.generation_delayed_ingest('${A}',${quote(JSON.stringify(payload('late')))});commit;`).then(()=>null,e=>e);
 const cachedResult=cached.run(`begin;${context({})}select * from public.generation_cached_claim();commit;`).then(()=>null,e=>e);
 await blocked(late,gate);await blocked(cached,gate);
 sql(migration);
 await t.test('same-session cached legacy ACK and dead-letter bodies hit newly installed table guards',async()=>{
  for(const [session,statement] of [[warmAck,"select public.ack_job('sync_jobs',0);"],[warmDead,"select public.dead_letter_job('sync_jobs',0,'{}','late fixture');"]]) await assert.rejects(session.run('begin;set local role service_role;'+statement+'commit;'),/paused or obsolete/);
  assert.equal(sql('select count(*) from jobs_dead'),'0');
 });
 await t.test('already-started old ingest body and cached claim are rejected after the installation boundary',async()=>{
  await gate.run('select pg_advisory_unlock_all();');gate.close();assert.match(String(await lateResult),/legacy, paused or obsolete/);assert.match(String(await cachedResult),/paused or obsolete/);assert.equal(sql("select count(*) from public.messages where provider_message_id='late'"),'0');
 });
 sql("notify pgrst,'reload schema';");
 // Readiness retries only a missing schema cache, never an assertion failure.
 for(let i=0;i<50;i++){const r=await rest('rpc/claim_sync_jobs_v1',{body:{p_generation:GEN,p_n:1,p_vt:150}});if(r.status===200){assert.deepEqual(r.data,[]);break;}if(i===49||r.data?.code!=='PGRST202')throw Error(JSON.stringify(r));await new Promise(r=>setTimeout(r,100));}
 await t.test('paused claims preserve exact payload, visibility, read count and do not create receipts',async()=>{
  enqueue();const before=rows('select * from pgmq.q_sync_jobs');for(const rpc of ['claim_jobs','claim_sync_jobs_v1']){const r=await rest('rpc/'+rpc,{body:rpc==='claim_jobs'?{p_queue:'sync_jobs',p_n:3,p_vt:150}:{p_generation:GEN,p_n:1,p_vt:150}});assert.equal(r.status,200);assert.deepEqual(r.data,[]);}assert.deepEqual(rows('select * from pgmq.q_sync_jobs'),before);assert.equal(sql('select count(*) from mcc_sync_internal.claims'),'0');
 });
 await t.test('service_role survives SECURITY DEFINER, lowercase headers arrive and request GUC never leaks',async()=>{
  const r=await rest('rpc/generation_observe',{body:{},headers:{'X-MCC-Caller':'api-gmail-fence-v1'}});assert.equal(r.status,200);assert.equal(r.data.role,'service_role');assert.equal(r.data.effective,'postgres');assert.equal(r.data.headers['x-mcc-caller'],api['x-mcc-caller']);
  const write=await rest('gmail_accounts?id=eq.'+A,{method:'PATCH',body:{last_error:'api-paused'},headers:api});assert.equal(write.status,204,JSON.stringify(write));
  const o=rows('select value from public.generation_observations order by id desc limit 1')[0].value;assert.equal(o.role,'service_role');assert.equal(o.effective,'postgres');
  const legacy=await rest('gmail_accounts?id=eq.'+A,{method:'PATCH',body:{last_error:'forbidden'}});assert.equal(legacy.data.code,'55000');
  activate();const j=claim();assert(j);const after=await rest('rpc/generation_observe',{body:{}});assert.equal(after.data.generation,null);assert.equal(after.data.headers['x-mcc-caller'],undefined);
 });
 await t.test('canonical ingest new and duplicate both cross the thread guard and denial rolls back all effects',async()=>{
  const r=await ingest('canonical');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.status,'ok');const counts=rows('select (select count(*) from messages) messages,(select count(*) from contacts) contacts,(select sum(message_count) from queue_items) queue_count');
  assert.equal((await ingest('canonical')).data.status,'duplicate');
  for(const id of ['canonical','forbidden']){const denied=await ingest(id,{});assert.equal(denied.data.code,'55000',JSON.stringify(denied));}
  assert.deepEqual(rows('select (select count(*) from messages) messages,(select count(*) from contacts) contacts,(select sum(message_count) from queue_items) queue_count'),counts);
 });
 await t.test('valid per-job client is bound to its mailbox and stale/post-ACK writers fail',async()=>{
  clean();enqueue();const j=claim();let r=await rest('gmail_accounts?id=eq.'+A,{method:'PATCH',body:{last_error:'owned'},headers:sync(j)});assert.equal(r.status,204,JSON.stringify(r));
  r=await ingest('owned',sync(j));assert.equal(r.status,200,JSON.stringify(r));sql(finish(j));r=await ingest('post-ack',sync(j));assert.equal(r.data.code,'55000');
  const malformed=await rest('gmail_accounts?id=eq.'+A,{method:'PATCH',body:{last_error:'invalid'},headers:{...sync(j),'x-mcc-sync-job':'9999999999999999999'}});assert([400,500].includes(malformed.status));assert.equal(sql(`select last_error from gmail_accounts where id='${A}'`),'owned');
 });
 await t.test('a permitted write holds the control lock through commit and pause excludes every later write',async()=>{
  clean();enqueue();const j=claim();const writer=await session(),pauser=await session();await writer.run(`begin;${context(sync(j))}update public.gmail_accounts set last_error='before-pause' where id='${A}';`);
  const pending=pauser.run('update mcc_sync_internal.control set enabled=false where singleton;');await blocked(pauser,writer);assert.equal(sql('select enabled from mcc_sync_internal.control'),'t');await writer.run('commit;');await pending;assert.equal(sql(`select last_error from gmail_accounts where id='${A}'`),'before-pause');assert.equal((await ingest('after-pause',sync(j))).data.code,'55000');writer.close();pauser.close();
 });
 await t.test('reclaim waits for receipt SHARE lock; old token cannot write after replacement returns',async()=>{
  clean();enqueue();const j=claim();expire();const writer=await session(),reclaimer=await session();await writer.run(`begin;${context(sync(j))}update public.gmail_accounts set last_error='before-reclaim' where id='${A}';`);
  const pending=reclaimer.run(`select row_to_json(x) from public.claim_sync_jobs_v1('${GEN}',1,150) x;`);await blocked(reclaimer,writer);await writer.run('commit;');const replacement=JSON.parse(await pending);assert.notEqual(replacement.claim_token,j.claim_token);assert.equal(replacement.attempt,2);assert.equal((await ingest('stale',sync(j))).data.code,'55000');assert.equal((await ingest('replacement',sync(replacement))).status,200);sql(finish(replacement));writer.close();reclaimer.close();
 });
 await t.test('finish holds queue before receipt, so concurrent SKIP LOCKED claim cannot steal its row',async()=>{
  clean();enqueue();const j=claim();expire();const writer=await session(),finisher=await session(),reclaimer=await session();await writer.run(`begin;${context(sync(j))}update public.gmail_accounts set last_error='before-finish' where id='${A}';`);
  const pending=finisher.run(finish(j));await blocked(finisher,writer);assert.equal(await reclaimer.run(`select count(*) from public.claim_sync_jobs_v1('${GEN}',1,150);`),'0');await writer.run('commit;');await pending;assert.equal(sql('select count(*) from pgmq.q_sync_jobs'),'0');assert.equal(sql('select count(*) from mcc_sync_internal.claims'),'0');writer.close();finisher.close();reclaimer.close();
 });
 await t.test('reclaim winning before finish rejects stale ACK and dead letter without deleting replacement',async()=>{
  clean();enqueue();const old=claim();expire();const newer=claim();const before=rows('select * from pgmq.q_sync_jobs');for(const err of [null,'stale']){const r=await rest('rpc/finish_sync_job_v1',{body:{p_generation:GEN,p_msg_id:old.msg_id,p_claim_token:old.claim_token,p_error:err}});assert.equal(r.data.code,'55000');}assert.deepEqual(rows('select * from pgmq.q_sync_jobs'),before);assert.equal(sql('select count(*) from jobs_dead'),'0');sql(finish(newer));
 });
 await t.test('pause waits for an uncommitted claim and then blocks its finish without losing receipt or payload',async()=>{
  clean();enqueue();const claimant=await session(),pauser=await session();const j=JSON.parse(await claimant.run(`begin;select row_to_json(x) from public.claim_sync_jobs_v1('${GEN}',1,150) x;`));const pending=pauser.run('update mcc_sync_internal.control set enabled=false where singleton;');await blocked(pauser,claimant);await claimant.run('commit;');await pending;const r=await rest('rpc/finish_sync_job_v1',{body:{p_generation:GEN,p_msg_id:j.msg_id,p_claim_token:j.claim_token}});assert.equal(r.data.code,'55000');assert.equal(sql('select count(*) from mcc_sync_internal.claims'),'1');assert.equal(sql('select count(*) from pgmq.q_sync_jobs'),'1');claimant.close();pauser.close();
 });
 await t.test('lock timeout aborts a blocked finish atomically; exact owned job can retry',async()=>{
  clean();enqueue();const j=claim();const writer=await session(),finisher=await session();await writer.run(`begin;${context(sync(j))}update public.gmail_accounts set last_error='timeout-write' where id='${A}';`);await finisher.run("set lock_timeout='2s';");const result=finisher.run(finish(j)).then(()=>null,e=>e);await blocked(finisher,writer);assert.match(String(await result),/lock timeout/);assert.equal(sql('select count(*) from pgmq.q_sync_jobs'),'1');assert.equal(sql('select count(*) from mcc_sync_internal.claims'),'1');await writer.run('commit;');sql(finish(j));writer.close();
 });
 await t.test('legacy ACK/DLQ and cached claim are blocked even when active; all unrelated queues remain usable',async()=>{
  clean();const id=enqueue();const before=rows('select * from pgmq.q_sync_jobs');for(const [rpc,body] of [['ack_job',{p_queue:'sync_jobs',p_msg_id:id}],['dead_letter_job',{p_queue:'sync_jobs',p_msg_id:id,p_message:{forged:true},p_error:'old'}],['generation_cached_claim',{}]]){const r=await rest('rpc/'+rpc,{body});assert.equal(r.data.code,'55000',JSON.stringify(r));}assert.deepEqual(rows('select * from pgmq.q_sync_jobs'),before);assert.equal(sql('select count(*) from jobs_dead'),'0');
  pause();for(const q of ['triage_jobs','pipeline_jobs','digest_jobs']){sql(`select pgmq.send('${q}','{}');`);const r=await rest('rpc/claim_jobs',{body:{p_queue:q,p_n:1,p_vt:150}});assert.equal(r.status,200);assert.equal(r.data.length,1);assert.equal((await rest('rpc/ack_job',{body:{p_queue:q,p_msg_id:r.data[0].msg_id}})).status,204);assert.equal(sql(`select count(*) from pgmq.q_${q}`),'0');}
 });
 await t.test('new privileged RPCs and private schema deny anon/authenticated and retain RLS',async()=>{
  for(const rpc of ['claim_sync_jobs_v1','finish_sync_job_v1']){const body=rpc.startsWith('claim')?{p_generation:GEN,p_n:1,p_vt:150}:{p_generation:GEN,p_msg_id:1,p_claim_token:A};const r=await rest('rpc/'+rpc,{body,token:anon});assert([401,403].includes(r.status));}
  for(const role of ['anon','authenticated']){assert.equal(sql(`select has_function_privilege('${role}','public.claim_sync_jobs_v1(text,integer,integer)','execute') or has_schema_privilege('${role}','mcc_sync_internal','usage')`),'f');}
  assert.equal(sql("select bool_and(relrowsecurity) from pg_class where relnamespace='mcc_sync_internal'::regnamespace and relkind='r'"),'t');
 });
 await t.test('activation enforces exact cutoff precision, drain and pause provenance',async()=>{
  pause();const template=fs.readFileSync(path.join(F,'activate-reviewed-generation.sql'),'utf8');const psql=(cutoff)=>spawnSync('docker',['exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-v','observed_cutoff='+cutoff,'-v','approved_reason=isolated native proof','-U','postgres','-d','postgres'],{input:template,encoding:'utf8',timeout:15_000});
  sql("update mcc_sync_internal.control set legacy_claim_cutoff=clock_timestamp() where singleton;");assert.notEqual(psql(sql('select legacy_claim_cutoff::text from mcc_sync_internal.control')).status,0);sql("update mcc_sync_internal.control set legacy_claim_cutoff=clock_timestamp()-interval '401 seconds' where singleton;");const cutoff=sql('select legacy_claim_cutoff::text from mcc_sync_internal.control');assert.notEqual(psql('2000-01-01 00:00:00+00').status,0);const ok=psql(cutoff);assert.equal(ok.status,0,ok.stderr);assert.equal(sql("select reason from mcc_sync_internal.control_events order by id desc limit 1"),'isolated native proof');
 });
 await t.test('exact new Edge worker consumes real pgmq through native PostgREST with canonical ingest',async()=>{
  clean();sql(`update gmail_accounts set last_history_id=100,sync_locked_at=null,last_error=null where id='${A}';`);enqueue();const r=await fetch(url+'/functions/v1/sync-runtime/gmail-sync-worker',{method:'POST',headers:{'content-type':'application/json','x-worker-secret':process.env.MCC_GENERATION_WORKER_SECRET},body:JSON.stringify({scenario:{pages:{first:{body:{history:[{id:'101',messagesAdded:[{message:{id:'edge'}}]}],historyId:'110'}}}}}),redirect:'error',signal:AbortSignal.timeout(30_000)});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.application.processed,1,JSON.stringify(body));assert.equal(sql("select count(*) from messages where provider_message_id='edge'"),'1');assert.equal(sql(`select last_history_id::text from gmail_accounts where id='${A}'`),'110');assert.equal(sql('select count(*) from pgmq.q_sync_jobs'),'0');assert.equal(sql('select count(*) from mcc_sync_internal.claims'),'0');assert.equal(body.events.filter(e=>e.kind==='blocked_egress').length,0);assert(body.events.some(e=>e.path==='/rest/v1/rpc/claim_sync_jobs_v1'));assert(!body.events.some(e=>e.path==='/rest/v1/rpc/claim_jobs'));assert.equal(sql('select count(*) from cron.job'),'0');assert.equal(sql('select count(*) from net.http_request_queue'),'0');
 });
 }finally{for(const s of sessions)s.close();fs.writeFileSync(path.join(evidence,'native-lock-observations.json'),JSON.stringify(observations,null,2));}});
