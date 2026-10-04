import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const GEN='gmail-sync-checkpoints-g1';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const API={'x-mcc-caller':'api-gmail-fence-v1'};
const file=n=>fs.readFileSync(new URL(n,import.meta.url),'utf8');
const db=new PGlite();
const q=(sql,p=[])=>db.query(sql,p).then(r=>r.rows);
const request=(headers,sql,p=[],role='service_role')=>db.transaction(async tx=>{
  await tx.exec(`set local role ${role}`);
  await tx.query("select set_config('request.headers',$1,true)",[typeof headers==='string'?headers:JSON.stringify(headers)]);
  return (await tx.query(sql,p)).rows;
});
const enqueue=(a=A,h=API)=>request(h,"select public.enqueue_and_poke('sync_jobs',$1::jsonb)",[JSON.stringify({kind:'incremental',gmail_account_id:a})]);
const claim=()=>request({},'select * from public.claim_sync_jobs_v1($1,1,150)',[GEN]);
const headers=j=>({'x-mcc-caller':'gmail-sync-v1','x-mcc-sync-generation':GEN,'x-mcc-sync-job':String(j.msg_id),'x-mcc-sync-token':j.claim_token});
const payload=(id='m1')=>({provider_message_id:id,thread_provider_id:'t-'+id,subject:'Synthetic',direction:'inbound'});
const ingest=(h={},a=A,p=payload(),fn='ingest_email_message')=>request(h,`select public.${fn}($1,$2::jsonb) result`,[a,JSON.stringify(p)]);
const count=table=>q(`select count(*)::int n from ${table}`).then(x=>x[0].n);
const reset=async()=>{
  await db.exec(`truncate public.queue_items,public.messages,public.threads,public.gmail_accounts,public.domain_effects,
    pgmq.q_sync_jobs,pgmq.q_triage_jobs,pgmq.q_pipeline_jobs,pgmq.q_digest_jobs,public.jobs_dead,mcc_sync_internal.claims restart identity;
    update mcc_sync_internal.control set generation='${GEN}',enabled=true where singleton;`);
  await q('insert into public.gmail_accounts(id,user_id,last_history_id) values($1,$1,100),($2,$2,200)',[A,B]);
};
const owned=async()=>{await enqueue();const[j]=await claim();return {j,h:headers(j)};};
const accountWrite=(h,a=A)=>request(h,'update public.gmail_accounts set last_history_id=999 where id=$1',[a]);
const finish=j=>request({},'select public.finish_sync_job_v1($1,$2,$3,null)',[GEN,j.msg_id,j.claim_token]);
const expiry=()=>db.exec(`begin;select set_config('app.mcc_sync_generation','${GEN}',true);update pgmq.q_sync_jobs set vt=clock_timestamp()-interval '1 second';commit;`);

await test('database mutation fence, local PostgreSQL engine with synthetic domain fixture',async t=>{
  try{
    await db.exec(file('./bootstrap.sql'));await db.exec(file('./fixture-domain.sql'));
    const [old]=await q("select pg_get_functiondef('public.ingest_email_message(uuid,jsonb)'::regprocedure) body");
    await db.exec(old.body.replace('public.ingest_email_message(','public.legacy_ingest_body(')+';');
    await db.exec(file('./generation-fence-candidate.sql'));

    await t.test('all v17 account update forms are rejected after activation',async()=>{
      await reset();for(const patch of ["sync_locked_at=clock_timestamp()","sync_locked_at=null","last_history_id=999","last_error='old failure',status='error'","last_sync_at=clock_timestamp()","watch_expiration=clock_timestamp()","backfill_done=false"]){
        await assert.rejects(request({},`update public.gmail_accounts set ${patch} where id=$1`,[A]),/legacy, paused or obsolete/);
      }assert.equal((await q('select last_history_id::text h from public.gmail_accounts where id=$1',[A]))[0].h,'100');
    });
    await t.test('legacy ingest is denied at the first mutation, with every domain effect rolled back',async()=>{
      await reset();await assert.rejects(ingest(),/legacy, paused or obsolete/);
      for(const table of ['threads','messages','queue_items','domain_effects'])assert.equal(await count('public.'+table),0);
    });
    await t.test('already-loaded old ingest body is still caught by the table boundary',async()=>{
      await reset();await assert.rejects(ingest({},A,payload(),'legacy_ingest_body'),/legacy, paused or obsolete/);
      assert.equal(await count('public.domain_effects'),0);
    });
    await t.test('legacy duplicate ingest cannot modify the thread before returning duplicate',async()=>{
      await reset();await ingest(API);const before=await q('select * from public.threads');
      await assert.rejects(ingest({},A,{...payload(),subject:'old overwrite'}),/legacy, paused or obsolete/);
      assert.deepEqual(await q('select * from public.threads'),before);
    });
    await t.test('tagged API reconnect/account writes continue while sync is paused',async()=>{
      await reset();await db.exec('update mcc_sync_internal.control set enabled=false where singleton');
      await request(API,"update public.gmail_accounts set status='active',last_error=null,has_send_scope=false,refresh_token_secret_id=$2 where id=$1",[A,B]);
      assert.equal((await q('select refresh_token_secret_id from public.gmail_accounts where id=$1',[A]))[0].refresh_token_secret_id,B);
    });
    await t.test('tagged API outbound ingestion continues while sync is paused',async()=>{
      await reset();await db.exec('update mcc_sync_internal.control set enabled=false where singleton');
      const[r]=await ingest(API,A,{...payload(),direction:'outbound'});assert.equal(r.result.status,'ok');assert.equal(await count('public.messages'),1);
    });
    await t.test('tagged API spam suppression continues while legacy suppression fails',async()=>{
      await reset();await ingest(API);const before=await q('select * from public.queue_items');
      await assert.rejects(request({},"update public.queue_items set state='suppressed'"),/legacy, paused or obsolete/);
      assert.deepEqual(await q('select * from public.queue_items'),before);
      await request(API,"update public.queue_items set state='suppressed'");assert.equal((await q('select state from public.queue_items'))[0].state,'suppressed');
    });
    await t.test('both sync and triage legacy enqueue paths reject late requests atomically',async()=>{
      await reset();await ingest(API);const[m]=await q('select id from public.messages');
      for(const queue of ['sync_jobs','triage_jobs'])await assert.rejects(request({},'select public.enqueue_and_poke($1,$2::jsonb)',[queue,JSON.stringify({gmail_account_id:A,message_id:m.id})]),/legacy, paused or obsolete/);
      assert.equal(await count('pgmq.q_sync_jobs'),0);assert.equal(await count('pgmq.q_triage_jobs'),0);
    });
    await t.test('non-Gmail triage intake stays available to existing callers',async()=>{
      await reset();const[t]=await q("insert into public.threads(gmail_account_id,provider_thread_id) values(null,'sms') returning id");
      const[m]=await q("insert into public.messages(gmail_account_id,thread_id,provider_message_id,payload) values(null,$1,'sms-message','{}') returning id",[t.id]);
      await request({},"select public.enqueue_and_poke('triage_jobs',$1::jsonb)",[JSON.stringify({message_id:m.id})]);
      assert.equal(await count('pgmq.q_triage_jobs'),1);
      const {h}=await owned();await assert.rejects(request(h,"select public.enqueue_and_poke('triage_jobs',$1::jsonb)",[JSON.stringify({message_id:m.id})]),/account mismatch/);
    });
    await t.test('tagged API and trusted SQL cron can retain intake during pause',async()=>{
      await reset();await db.exec('update mcc_sync_internal.control set enabled=false where singleton');await enqueue();
      await q("select public.enqueue_and_poke('sync_jobs',$1::jsonb)",[JSON.stringify({kind:'incremental',gmail_account_id:B})]);
      assert.equal(await count('pgmq.q_sync_jobs'),2);assert.deepEqual(await claim(),[]);
    });
    await t.test('valid job-scoped sync context can mutate only its durable account',async()=>{
      await reset();const {h}=await owned();await accountWrite(h);
      await assert.rejects(accountWrite(h,B),/account mismatch/);
      assert.equal((await q('select last_history_id::text h from public.gmail_accounts where id=$1',[B]))[0].h,'200');
    });
    await t.test('sync cannot reassign a Gmail account to another tenant',async()=>{
      await reset();const {h}=await owned();await assert.rejects(request(h,'update public.gmail_accounts set user_id=$2 where id=$1',[A,B]),/cannot reassign/);
      assert.equal((await q('select user_id from public.gmail_accounts where id=$1',[A]))[0].user_id,A);
    });
    await t.test('valid sync ingestion succeeds; wrong-account ingestion commits nothing',async()=>{
      await reset();const {h}=await owned();await ingest(h);
      await assert.rejects(ingest(h,B,payload('m2')),/account mismatch/);
      assert.equal(await count('public.messages'),1);assert.equal(await count('public.domain_effects'),1);
    });
    await t.test('sync suppression is bound to the actual thread account',async()=>{
      await reset();await ingest(API,A,payload('a'));await ingest(API,B,payload('b'));const {h}=await owned();
      const [ta]=await q('select id from public.threads where gmail_account_id=$1',[A]);const[tb]=await q('select id from public.threads where gmail_account_id=$1',[B]);
      await request(h,"update public.queue_items set state='suppressed' where thread_id=$1",[ta.id]);
      await assert.rejects(request(h,"update public.queue_items set state='suppressed' where thread_id=$1",[tb.id]),/account mismatch/);
    });
    await t.test('sync continuations and triage enqueue are account-bound',async()=>{
      await reset();await ingest(API,A,payload('a'));await ingest(API,B,payload('b'));const {h}=await owned();await enqueue(A,h);await assert.rejects(enqueue(B,h),/account mismatch/);
      for(const [a,allowed] of [[A,true],[B,false]]){
        const[m]=await q('select id from public.messages where gmail_account_id=$1',[a]);
        const promise=request(h,"select public.enqueue_and_poke('triage_jobs',$1::jsonb)",[JSON.stringify({message_id:m.id})]);
        if(allowed)await promise;else await assert.rejects(promise,/account mismatch/);
      }assert.equal(await count('pgmq.q_triage_jobs'),1);
    });
    await t.test('pause rejects all job-scoped mutations and leaves durable jobs intact',async()=>{
      await reset();const{h}=await owned();await db.exec('update mcc_sync_internal.control set enabled=false where singleton');
      await assert.rejects(accountWrite(h),/legacy, paused or obsolete/);await assert.rejects(ingest(h),/legacy, paused or obsolete/);await assert.rejects(enqueue(A,h),/legacy, paused or obsolete/);
      assert.equal(await count('pgmq.q_sync_jobs'),1);assert.equal(await count('public.messages'),0);
    });
    await t.test('same-generation redelivery fences a delayed account or ingest mutation',async()=>{
      await reset();const{h}=await owned();await expiry();const[newJob]=await claim();
      await assert.rejects(accountWrite(h),/claim changed/);await assert.rejects(ingest(h),/claim changed/);await accountWrite(headers(newJob));
    });
    await t.test('finish removes the receipt, so a later write with the old token is rejected',async()=>{
      await reset();const{j,h}=await owned();await finish(j);await assert.rejects(accountWrite(h),/claim changed/);assert.equal(await count('pgmq.q_sync_jobs'),0);
    });
    await t.test('malformed/missing/retired generation and ownership markers fail closed',async()=>{
      await reset();const{h}=await owned();for(const bad of [{},{...h,'x-mcc-sync-generation':'old'},{...h,'x-mcc-sync-token':'bad'},{...h,'x-mcc-sync-job':'0'},{...h,'x-mcc-sync-job':'9223372036854775808'},{...h,'x-mcc-sync-token':B}]){
        await assert.rejects(accountWrite(bad));
      }await assert.rejects(accountWrite('{broken-json'));
      assert.equal((await q('select last_history_id::text h from public.gmail_accounts where id=$1',[A]))[0].h,'100');
    });
    await t.test('API marker with job headers cannot accidentally bypass the sync gate',async()=>{
      await reset();const{h}=await owned();await assert.rejects(accountWrite({...h,...API}),/legacy, paused or obsolete/);
    });
    await t.test('forged caller headers do not grant anon/authenticated RPC or table permissions',async()=>{
      await reset();for(const role of ['anon','authenticated']){
        await assert.rejects(request(API,'update public.gmail_accounts set last_history_id=999 where id=$1',[A],role),/permission denied/);
        await assert.rejects(request(API,'select public.ingest_email_message($1,$2::jsonb)',[A,JSON.stringify(payload())],role),/permission denied/);
      }
    });
    await t.test('ordinary triage transitions and AgentEdge timestamp writes remain unchanged',async()=>{
      await reset();await ingest(API);await request({},"update public.queue_items set state='fyi'");
      await request({},'update public.queue_items set agentedge_relayed_at=clock_timestamp()');
      assert.equal((await q('select state,agentedge_relayed_at is not null marked from public.queue_items'))[0].marked,true);
    });
    await t.test('non-Gmail thread and suppression paths are untouched',async()=>{
      await reset();const[t]=await request({},"insert into public.threads(gmail_account_id,provider_thread_id) values(null,'sms') returning id");
      await q('insert into public.queue_items(thread_id) values($1)',[t.id]);await request({},"update public.queue_items set state='suppressed'");
    });
    await t.test('transaction rollback undoes every mutation after an allowed boundary',async()=>{
      await reset();const{h}=await owned();await assert.rejects(request(h,"with ignored as (select public.ingest_email_message($1,$2::jsonb)) select (select result from (select 1/0 result) x) from ignored",[A,JSON.stringify(payload())]),/division by zero/);
      assert.equal(await count('public.messages'),0);assert.equal(await count('public.threads'),0);
    });
    await t.test('control/receipt row locks and first-write coverage are explicit in reviewed source',async()=>{
      const sql=file('./generation-fence-candidate.sql');assert.match(sql,/where msg_id=id_text::bigint[\s\S]*?for share/);
      assert.match(sql,/lock table public.gmail_accounts, public.threads, public.queue_items,[\s\S]*?in access exclusive mode/);
      const live=JSON.parse(file('./live-schema.json')).functions.find(f=>f.name==='public.ingest_email_message').definition;
      assert.equal(live.match(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.\w+/i)[0],'INSERT INTO public.threads');
      assert(sql.indexOf('lock table public.gmail_accounts')<sql.indexOf("values (true, 'gmail-sync-checkpoints-g1', clock_timestamp())"));
    });
  }finally{await db.close();}
});
