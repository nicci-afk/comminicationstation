// Independent native PostgreSQL sessions, actual PostgREST and exact Edge bundle.
// Every target is checked as disposable local-only before any fixture writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
const container=process.env.MCC_COST_DB_CONTAINER;
assert(/^supabase_db_mcc-cost-[a-z0-9-]+$/.test(container??''),'Disposable local cost DB required');
const status=JSON.parse(fs.readFileSync(process.env.MCC_COST_STATUS,'utf8'));
const url=status.API_URL??status.api_url,key=status.SERVICE_ROLE_KEY??status.service_role_key,anon=status.ANON_KEY??status.anon_key;
assert(new URL(url).protocol==='http:'&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
const evidence=process.env.MCC_COST_EVIDENCE;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const M='00000000-0000-4000-8000-000000000011',N='00000000-0000-4000-8000-000000000012',O='00000000-0000-4000-8000-000000000013';
const H='a'.repeat(64),MODEL='claude-haiku-4-5-20251001';
const decision={business_id:null,category:'fyi',needs_reply:false,contact_kind:'human',priority:25,reason:'Native fixture'};
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
function sql(input){const r=spawnSync('docker',['exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{input,encoding:'utf8',timeout:25000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const rows=s=>JSON.parse(sql(`select coalesce(json_agg(t),'[]') from (${s}) t`));
const source=(u=A,m=M)=>JSON.parse(sql(`select mcc_cost_internal.triage_source_v1('${u}','${m}')`));
const reserve=(m=M,u=A,h=H,s=source(u,m))=>`select public.reserve_triage_cost_v1('${u}','${m}','${h}',${quote(JSON.stringify(s))}::jsonb);`;
const settle=(token,m=M,out=20)=>`select public.settle_triage_cost_v1('${A}','${m}','${H}','${token}','${MODEL}',100,${out},${quote(JSON.stringify(decision))}::jsonb);`;
const apply=()=>`select public.apply_budgeted_triage_v1('${A}','${M}','${H}');`;
const svc=s=>'begin;set local role service_role;'+s+'commit;';
const sessions=[],observations=[];
class Session {
 constructor(){this.p=spawn('docker',['exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres']);this.buf='';this.err='';this.pending=null;this.n=0;this.closed=false;
  this.p.stdout.on('data',b=>{this.buf+=b;this.flush();});this.p.stderr.on('data',b=>this.err+=b);this.p.on('exit',code=>{this.closed=true;if(this.pending){this.pending.reject(Error(this.err||`psql exited ${code}`));this.pending=null;}});}
 flush(){const p=this.pending;if(!p)return;const i=this.buf.indexOf(p.mark+'\n');if(i<0)return;const result=this.buf.slice(0,i).trim();this.buf=this.buf.slice(i+p.mark.length+1);this.pending=null;p.resolve(result);}
 run(s){assert(!this.pending&&!this.closed);return new Promise((resolve,reject)=>{const mark=`__done_${++this.n}__`;this.pending={mark,resolve,reject};this.p.stdin.write(s+'\n\\echo '+mark+'\n');});}
 async init(){this.pid=Number(await this.run("set statement_timeout='12s';set lock_timeout='10s';select pg_backend_pid();"));sessions.push(this);return this;}
 close(){if(!this.closed)this.p.stdin.end('rollback;\n\\q\n');}
}
const session=()=>new Session().init();
async function blocked(waiter,holder){const end=Date.now()+5000;while(Date.now()<end){const r=rows(`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=${waiter.pid}`)[0];if(r?.wait_event_type==='Lock'&&r.blockers.includes(holder.pid)){observations.push(r);return;}await new Promise(r=>setTimeout(r,40));}throw Error('No proven caps/receipt lock wait');}
async function rest(p,{body,token=key,method='POST'}={}){const r=await fetch(url+'/rest/v1/'+p,{method,headers:{apikey:anon,authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:r.status,data};}
function authToken(){const jwtSecret=status.JWT_SECRET??status.jwt_secret;assert(jwtSecret,'Local synthetic JWT secret required');const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const raw=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role:'authenticated',sub:A,iss:'supabase',aud:'authenticated',exp:Math.floor(Date.now()/1000)+600});return raw+'.'+createHmac('sha256',jwtSecret).update(raw).digest('base64url');}
const body=(m=M,u=A)=>({p_user:u,p_message:m,p_request_hash:H,p_source:source(u,m)});
function reset(cap=1){sql(`truncate mcc_cost_internal.triage_tasks,public.ai_spend_ledger,public.sender_triage_cache,public.queue_item_events,
 public.queue_items,public.messages,public.threads,pgmq.q_triage_jobs,public.jobs_dead restart identity cascade;
 update public.spend_caps set monthly_cap_usd=${cap},triage_daily_call_cap=10;
 insert into public.threads(id,user_id,channel,provider_thread_id) values('${M}','${A}','email','fixture-m'),('${N}','${A}','email','fixture-n'),('${O}','${B}','email','fixture-o');
 insert into public.messages(id,user_id,thread_id,direction,channel,provider,provider_message_id,from_identifier,snippet,sent_at)
 values('${M}','${A}','${M}','inbound','email','manual','fixture-m','sender@example.invalid','Synthetic',now()),
 ('${N}','${A}','${N}','inbound','email','manual','fixture-n','other@example.invalid','Synthetic',now()),
 ('${O}','${B}','${O}','inbound','email','manual','fixture-o','foreign@example.invalid','Synthetic',now());
 insert into public.queue_items(user_id,thread_id,channel,last_inbound_message_id) values('${A}','${M}','email','${M}');
 insert into public.app_config(key,value) values('mcc_triage_cost_policy_v1',jsonb_build_object('status','verified','kind','anthropic_standard_messages_v1',
 'currency','USD','version','synthetic-native-only','reviewed_by','native-fixture','source_url','https://example.invalid/synthetic','model','${MODEL}',
 'input_usd_per_million',1,'output_usd_per_million',5,'max_billable_input_tokens',1000,'max_output_tokens',400,
 'verified_at',clock_timestamp()-interval '1 minute','valid_until',clock_timestamp()+interval '1 hour')) on conflict(key) do update set value=excluded.value;`);}
async function edge(mode='success',authenticated=true){const r=await fetch(url+'/functions/v1/cost-runtime/triage-worker',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{'x-worker-secret':process.env.MCC_COST_WORKER_SECRET}:{})},body:JSON.stringify({mode}),redirect:'error',signal:AbortSignal.timeout(30000)});return {status:r.status,data:await r.json()};}
await test('native cost reservation concurrency, ACLs, PostgREST and exact Edge',async t=>{try{
 sql(`insert into public.allowed_emails(email) values('cost-a@example.invalid'),('cost-b@example.invalid');
 insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values('${A}','cost-a@example.invalid','{}','{}'),('${B}','cost-b@example.invalid','{}','{}');
 insert into public.mcc_safety_controls values('${A}',true,false),('${B}',true,false);`);
 reset();sql("notify pgrst,'reload schema';");
 for(let i=0;i<50;i++){const r=await rest('rpc/reserve_triage_cost_v1',{body:{...body(),p_request_hash:null}});if(r.status===200){assert.equal(r.data.status,'blocked');break;}if(i===49||r.data?.code!=='PGRST202')throw Error(JSON.stringify(r));await new Promise(r=>setTimeout(r,100));}
 const run=async(name,fn)=>t.test(name,async()=>{reset();await fn();});
 await run('reserve against reserve proves caps-row serialization and no overspend',async()=>{
  reset(.005);const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());
  const pending=two.run(svc(reserve(N)));await blocked(two,one);assert.equal(sql('select count(*) from mcc_cost_internal.triage_tasks'),'0');
  await one.run('commit;');assert.match(JSON.parse(await pending).reason,/monthly cap/);assert.equal(sql('select count(*) from mcc_cost_internal.triage_tasks'),'1');one.close();two.close();
 });
 await run('rollback releases uncommitted hold without phantom cost',async()=>{
  reset(.005);const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());
  const pending=two.run(svc(reserve(N)));await blocked(two,one);await one.run('rollback;');assert.equal(JSON.parse(await pending).status,'reserved');assert.equal(sql(`select count(*) from mcc_cost_internal.triage_tasks where message_id='${M}'`),'0');one.close();two.close();
 });
 await run('same task cannot get a second token while first admission is uncommitted',async()=>{
  const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());const pending=two.run(svc(reserve()));await blocked(two,one);await one.run('commit;');const result=JSON.parse(await pending);assert.match(result.reason,/existing reserved/);assert.equal(result.token,undefined);one.close();two.close();
 });
 await run('lock timeout rolls back admission without a partial reservation',async()=>{
  const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());await two.run("set lock_timeout='2s';");
  const pending=two.run(svc(reserve(N))).then(()=>null,e=>e);await blocked(two,one);assert.match(String(await pending),/lock timeout/);
  await one.run('rollback;');assert.equal(sql('select count(*) from mcc_cost_internal.triage_tasks'),'0');one.close();two.close();
 });
 await run('another tenant does not share the budget lock',async()=>{
  const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());await two.run("set statement_timeout='2s';");
  assert.equal(JSON.parse(await two.run(svc(reserve(O,B)))).status,'reserved');await one.run('rollback;');one.close();two.close();
 });
 await run('settle versus reserve waits until ledger and released hold commit together',async()=>{
  reset(.004);const r=JSON.parse(sql(svc(reserve()))),one=await session(),two=await session();await one.run('begin;set local role service_role;'+settle(r.token));
  const pending=two.run(svc(reserve(N)));await blocked(two,one);assert.equal(sql('select count(*) from ai_spend_ledger'),'0');await one.run('commit;');assert.equal(JSON.parse(await pending).status,'reserved');assert.equal(sql('select count(*) from ai_spend_ledger'),'1');one.close();two.close();
 });
 await run('duplicate settlements block then return one immutable charge',async()=>{
  const r=JSON.parse(sql(svc(reserve()))),one=await session(),two=await session();await one.run('begin;set local role service_role;'+settle(r.token));const pending=two.run(svc(settle(r.token)));await blocked(two,one);await one.run('commit;');assert.equal(JSON.parse(await pending).status,'ready');assert.equal(sql('select count(*) from ai_spend_ledger'),'1');one.close();two.close();
 });
 await run('caps update and reservation have an observable commit order',async()=>{
  const one=await session(),two=await session();await one.run('begin;set local role service_role;'+reserve());
  const pending=two.run(`update public.spend_caps set monthly_cap_usd=0 where user_id='${A}';`);await blocked(two,one);await one.run('commit;');await pending;
  assert.match(JSON.parse(sql(svc(reserve(N)))).reason,/monthly cap/);one.close();two.close();
 });
 await run('duplicate application mutates canonical triage state only once',async()=>{
  const r=JSON.parse(sql(svc(reserve())));sql(svc(settle(r.token)));const one=await session(),two=await session();await one.run('begin;set local role service_role;'+apply());
  const pending=two.run(svc(apply()));await blocked(two,one);await one.run('commit;');assert.equal(JSON.parse(await pending).newly_applied,false);
  assert.equal(sql(`select cardinality(priority_reasons) from queue_items where last_inbound_message_id='${M}'`),'1');one.close();two.close();
 });
 await run('unknown holds remain counted beyond a month boundary and across policy expiry',async()=>{
  reset(.005);const r=JSON.parse(sql(svc(reserve())));sql(`select public.mark_triage_unknown_v1('${A}','${M}','${H}','${r.token}');update mcc_cost_internal.triage_tasks set created_at=now()-interval '2 months';`);
  assert.match(JSON.parse(sql(svc(reserve(N)))).reason,/monthly cap/);assert.match(JSON.parse(sql(svc(reserve()))).reason,/unknown/);
 });
 await run('current source changes and foreign message ownership fail closed through PostgREST',async()=>{
  const before=body();sql(`update public.messages set snippet='Changed source' where id='${M}'`);
  let r=await rest('rpc/reserve_triage_cost_v1',{body:before});assert.equal(r.status,200);assert.match(r.data.reason,/source/);
  r=await rest('rpc/reserve_triage_cost_v1',{body:{...body(),p_message:O}});assert.match(r.data.reason,/ownership/);
 });
 await run('effective schema/table/function ACLs deny all direct application-role mutation paths',async()=>{
  const table='mcc_cost_internal.triage_tasks';
  for(const role of ['anon','authenticated','service_role']){
   assert.equal(sql(`select has_schema_privilege('${role}','mcc_cost_internal','usage')`),'f');
   for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal(sql(`select has_table_privilege('${role}','${table}','${privilege}')`),'f',role+' '+privilege);
   assert.equal(sql(`select has_function_privilege('${role}','mcc_cost_internal.triage_source_v1(uuid,uuid)','execute')`),'f');
   for(const statement of [`select * from ${table}`,`delete from ${table}`,`truncate ${table}`,`update ${table} set state='unknown'`,`insert into ${table}(user_id) values('${A}')`]){
    const s=await session();await assert.rejects(s.run('begin;set local role '+role+';'+statement+';commit;'),/permission denied/);s.close();
   }
  }
  assert.equal(sql(`select relrowsecurity from pg_class where oid='${table}'::regclass`),'t');
  const signatures=['reserve_triage_cost_v1(uuid,uuid,text,jsonb)','mark_triage_unknown_v1(uuid,uuid,text,uuid)','settle_triage_cost_v1(uuid,uuid,text,uuid,text,integer,integer,jsonb)','apply_budgeted_triage_v1(uuid,uuid,text)'];
  for(const signature of signatures)for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','execute')`),role==='service_role'?'t':'f');
 });
 await run('anon and authenticated JWTs cannot invoke any new RPC through actual PostgREST',async()=>{
  const authenticated=authToken();const who=await rest('profiles?select=user_id&user_id=eq.'+A,{method:'GET',token:authenticated});
  assert.equal(who.status,200,JSON.stringify(who));assert.equal(who.data[0]?.user_id,A);
  for(const token of [anon,authenticated])for(const [name,args] of [
   ['reserve_triage_cost_v1',body()],['mark_triage_unknown_v1',{p_user:A,p_message:M,p_request_hash:H,p_token:B}],
   ['settle_triage_cost_v1',{p_user:A,p_message:M,p_request_hash:H,p_token:B,p_model:MODEL,p_tokens_in:1,p_tokens_out:1,p_decision:decision}],
   ['apply_budgeted_triage_v1',{p_user:A,p_message:M,p_request_hash:H}]]){
    const r=await rest('rpc/'+name,{token,body:args});assert([401,403].includes(r.status),JSON.stringify(r));
   }
 });
 await run('exact Edge bundle requires worker auth before data or provider access',async()=>{
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const r=await edge('success',false);assert.equal(r.status,500);assert.equal(r.data.events.length,0);assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'1');
 });
 await run('exact Edge executes one synthetic call, native settlement/application, and real queue ACK',async()=>{
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const r=await edge();assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.application.processed,1);
  assert.equal(r.data.events.filter(e=>e.kind==='synthetic_model').length,1);assert.equal(r.data.events.filter(e=>e.kind==='blocked_egress').length,0);
  assert.equal(sql('select count(*) from ai_spend_ledger'),'1');assert.equal(sql('select state from mcc_cost_internal.triage_tasks'),'applied');assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'0');
  assert.equal(sql(`select category from queue_items where last_inbound_message_id='${M}'`),'booking');
  assert(r.data.events.some(e=>e.path==='/rest/v1/mcc_safety_controls'));assert(!r.data.events.some(e=>e.path==='/rest/v1/rpc/record_spend'));
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const again=await edge();assert.equal(again.data.events.filter(e=>e.kind==='synthetic_model').length,0);assert.equal(sql('select count(*) from ai_spend_ledger'),'1');
 });
 await run('provider 500 is attempted once and never replayed on queue redelivery',async()=>{
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const r=await edge('error');assert.equal(r.data.events.filter(e=>e.kind==='synthetic_model').length,1);assert.equal(r.data.application.processed,0);
  assert.equal(sql('select state from mcc_cost_internal.triage_tasks'),'unknown');sql('update pgmq.q_triage_jobs set vt=clock_timestamp()-interval \'1 second\'');const again=await edge();assert.equal(again.data.events.filter(e=>e.kind==='synthetic_model').length,0);assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'1');
 });
 await run('unknown paid attempt eventually dead-letters durably without another provider call',async()=>{
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const first=await edge('error');assert.equal(first.data.events.filter(e=>e.kind==='synthetic_model').length,1);
  for(let i=0;i<4;i++){
   sql("update pgmq.q_triage_jobs set vt=clock_timestamp()-interval '1 second'");const next=await edge();assert.equal(next.data.events.filter(e=>e.kind==='synthetic_model').length,0);
  }
  assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'0');assert.equal(sql(`select count(*) from public.jobs_dead where queue='triage_jobs' and message->>'message_id'='${M}'`),'1');
  assert.equal(sql('select state from mcc_cost_internal.triage_tasks'),'unknown');
 });
 await run('malformed paid result records usage but leaves queue work unacknowledged',async()=>{
  sql(`select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const r=await edge('malformed');assert.equal(r.data.application.processed,0);assert.equal(sql('select count(*) from ai_spend_ledger'),'1');assert.equal(sql('select state from mcc_cost_internal.triage_tasks'),'invalid');assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'1');
 });
 await run('missing reviewed policy makes no model request and preserves work',async()=>{
  sql(`delete from app_config where key='mcc_triage_cost_policy_v1';select pgmq.send('triage_jobs','{"message_id":"${M}"}')`);const r=await edge();assert.equal(r.data.application.processed,0);assert.equal(r.data.events.filter(e=>e.kind==='synthetic_model').length,0);assert.equal(sql('select count(*) from pgmq.q_triage_jobs'),'1');
 });
 await t.test('Gmail fence and containment remain paused; no cron or database network calls',()=>{
  assert.equal(sql('select enabled from mcc_sync_internal.control'),'f');assert.equal(sql('select bool_and(emergency_stop and not automation_database_writes_enabled) from mcc_safety_controls'),'t');assert.equal(sql('select count(*) from cron.job'),'0');assert.equal(sql('select count(*) from net.http_request_queue'),'0');
 });
}finally{for(const s of sessions)s.close();fs.writeFileSync(path.join(evidence,'cost-native-lock-observations.json'),JSON.stringify(observations,null,2));}});
