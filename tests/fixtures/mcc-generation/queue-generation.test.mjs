import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const GEN='gmail-sync-checkpoints-g1';
const FULL=process.env.MCC_FULL_FENCE==='1';
const db=new PGlite();
const query=(s,p=[])=>db.query(s,p).then(r=>r.rows);
const service=async(s,p=[])=>{
  await db.exec('set role service_role');
  try{return await query(s,p);}finally{await db.exec('reset role');}
};
const claim=(gen=GEN)=>service('select * from public.claim_sync_jobs_v1($1,3,150)',[gen]);
const finish=(j,error=null,gen=GEN)=>service('select public.finish_sync_job_v1($1,$2,$3,$4)',[gen,j.msg_id,j.claim_token,error]);
const enqueue=async(q='sync_jobs',m={kind:'incremental',gmail_account_id:'00000000-0000-4000-8000-000000000001',history_cursor:{start_history_id:'100'}})=>query('select * from pgmq.send($1,$2::jsonb)',[q,JSON.stringify(m)]);
const active=()=>db.exec('update mcc_sync_internal.control set enabled=true,activated_at=clock_timestamp() where singleton');
const paused=()=>db.exec('update mcc_sync_internal.control set enabled=false where singleton');
const reset=async()=>{
  await db.exec(`truncate pgmq.q_sync_jobs,pgmq.q_triage_jobs,pgmq.q_pipeline_jobs,pgmq.q_digest_jobs,public.jobs_dead,mcc_sync_internal.claims restart identity;
    update mcc_sync_internal.control set generation='${GEN}',enabled=false,activated_at=null where singleton;`);
};
const expire=()=>db.exec(`begin; select set_config('app.mcc_sync_generation','${GEN}',true);
  update pgmq.q_sync_jobs set vt=clock_timestamp()-interval '1 second';commit;`);

await test('local SQL generation queue prototype (PGlite; not multi-session/PostgREST)',async t=>{
  try{
    await db.exec(fs.readFileSync(new URL('./bootstrap.sql',import.meta.url),'utf8'));
    if(FULL) await db.exec(fs.readFileSync(new URL('./fixture-domain.sql',import.meta.url),'utf8'));
    const live=JSON.parse(fs.readFileSync(new URL('./live-schema.json',import.meta.url)));
    for(const [name,replacement] of [['claim_jobs','legacy_claim_body'],['ack_job','legacy_ack_body'],['dead_letter_job','legacy_dead_letter_body']]){
      const f=live.functions.find(f=>f.name===`public.${name}`);
      await db.exec(f.definition.replace(`public.${name}(`,`public.${replacement}(`)+';');
    }
    const metadata=()=>query("select oid,proowner,proacl::text,prosecdef,proconfig from pg_proc where oid='public.claim_jobs(text,int,int)'::regprocedure");
    const before=await metadata();
    await db.exec(fs.readFileSync(new URL(FULL?'./generation-fence-candidate.sql':'./queue-generation-prototype.sql',import.meta.url),'utf8'));
    await t.test('replaces only legacy sync claim behavior and preserves identity/ACL',async()=>assert.deepEqual(await metadata(),before));
    await t.test('control starts durably paused',async()=>assert.equal((await query('select enabled from mcc_sync_internal.control'))[0].enabled,false));
    await t.test('paused intake persists exact JSON while legacy and new claims do not consume visibility or attempts',async()=>{
      await reset();await enqueue();const before=await query('select * from pgmq.q_sync_jobs');
      assert.deepEqual(await service("select * from public.claim_jobs('sync_jobs',3,150)"),[]);
      assert.deepEqual(await claim(),[]);assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),before);
      assert.deepEqual(await query('select * from mcc_sync_internal.claims'),[]);
    });
    await t.test('a pre-existing legacy claim function body is blocked at the queue statement',async()=>{
      await reset();await enqueue();const before=await query('select * from pgmq.q_sync_jobs');
      await assert.rejects(service("select * from public.legacy_claim_body('sync_jobs',3,150)"),/paused or obsolete/);
      assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),before);
    });
    await t.test('all three unrelated queue claim/ack/dead-letter paths work unchanged while sync is paused',async()=>{
      await reset();for(const q of ['triage_jobs','pipeline_jobs','digest_jobs']){
        await enqueue(q);const [j]=await service('select * from public.claim_jobs($1,3,150)',[q]);assert.equal(j.read_ct,1);
        await service('select public.ack_job($1,$2)',[q,j.msg_id]);assert.equal((await query(`select count(*)::int n from pgmq.q_${q}`))[0].n,0);
        await enqueue(q);const [d]=await service('select * from public.claim_jobs($1,3,150)',[q]);
        await service('select public.dead_letter_job($1,$2,$3,$4)',[q,d.msg_id,JSON.stringify(d.message),'fixture']);
      }assert.equal((await query('select count(*)::int n from public.jobs_dead'))[0].n,3);
    });
    await t.test('old sync claims remain empty after new generation activation',async()=>{
      await reset();await active();await enqueue();assert.deepEqual(await service("select * from public.claim_jobs('sync_jobs',3,150)"),[]);
      assert.equal((await query('select read_ct from pgmq.q_sync_jobs'))[0].read_ct,0);
    });
    await t.test('wrong/null generation returns empty without queue mutation',async()=>{
      await reset();await active();await enqueue();const before=await query('select * from pgmq.q_sync_jobs');
      assert.deepEqual(await claim('obsolete'),[]);assert.deepEqual(await claim(null),[]);assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),before);
    });
    await t.test('new generation claims exact durable payload with receipt token and one visibility increment',async()=>{
      await reset();await active();await enqueue();const [j]=await claim();assert.equal(j.read_ct,1);assert.equal(j.attempt,1);assert.match(j.claim_token,/^[0-9a-f-]{36}$/);
      assert.deepEqual(j.message.history_cursor,{start_history_id:'100'});assert.equal((await query('select count(*)::int n from mcc_sync_internal.claims'))[0].n,1);
      assert.deepEqual(await claim(),[]);await finish(j);assert.equal((await query('select count(*)::int n from pgmq.q_sync_jobs'))[0].n,0);
      assert.deepEqual(await query('select * from mcc_sync_internal.claims'),[]);
    });
    await t.test('legacy already-claimed ACK and dead-letter cannot drop a job after fence installation',async()=>{
      await reset();await active();await enqueue();const [j]=await claim();const before=await query('select * from pgmq.q_sync_jobs');
      for(const fn of ['ack_job','legacy_ack_body'])await assert.rejects(service(`select public.${fn}('sync_jobs',$1)`,[j.msg_id]),/paused or obsolete/);
      for(const fn of ['dead_letter_job','legacy_dead_letter_body'])await assert.rejects(service(`select public.${fn}('sync_jobs',$1,$2,'old')`,[j.msg_id,JSON.stringify(j.message)]),/paused or obsolete/);
      assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),before);assert.deepEqual(await query('select * from public.jobs_dead'),[]);
    });
    await t.test('legacy dead-letter with no matching queue row still cannot create a false dead-letter record',async()=>{
      await reset();await active();await assert.rejects(service("select public.legacy_dead_letter_body('sync_jobs',99,'{}','old')"),/paused or obsolete/);
      assert.deepEqual(await query('select * from public.jobs_dead'),[]);
    });
    await t.test('pause after claim rejects finishing and preserves durable job and receipt',async()=>{
      await reset();await active();await enqueue();const [j]=await claim();await paused();
      const before=await query('select * from pgmq.q_sync_jobs');await assert.rejects(finish(j),/paused or obsolete/);
      assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),before);assert.equal((await query('select count(*)::int n from mcc_sync_internal.claims'))[0].n,1);
    });
    await t.test('a stale same-generation token cannot ACK the redelivered job',async()=>{
      await reset();await active();await enqueue();const [a]=await claim();await expire();const [b]=await claim();
      assert.notEqual(a.claim_token,b.claim_token);assert.equal(b.attempt,2);assert.equal(b.read_ct,2);
      await assert.rejects(finish(a),/claim changed/);assert.equal((await query('select count(*)::int n from pgmq.q_sync_jobs'))[0].n,1);await finish(b);
    });
    await t.test('retired generation cannot ACK a current job',async()=>{
      await reset();await active();await enqueue();const [j]=await claim();await db.exec("update mcc_sync_internal.control set generation='next-generation' where singleton");
      await assert.rejects(finish(j),/paused or obsolete/);assert.equal((await query('select count(*)::int n from pgmq.q_sync_jobs'))[0].n,1);
    });
    await t.test('existing pgmq retry history is preserved but not charged as new-generation attempts',async()=>{
      await reset();await active();await enqueue();await db.exec(`begin;select set_config('app.mcc_sync_generation','${GEN}',true);update pgmq.q_sync_jobs set read_ct=4;commit`);
      const [j]=await claim();assert.equal(j.read_ct,5);assert.equal(j.attempt,1);await finish(j);
    });
    await t.test('new receipt epoch resets only the generation-local attempt count',async()=>{
      await reset();await active();await enqueue();await claim();await expire();
      await db.exec("update mcc_sync_internal.control set generation='next-generation' where singleton");
      const [j]=await claim('next-generation');assert.equal(j.read_ct,2);assert.equal(j.attempt,1);
    });
    await t.test('dead-letter requires more than four actual generation attempts and keeps stored payload',async()=>{
      await reset();await active();await enqueue();let [j]=await claim();await assert.rejects(finish(j,'bad'),/retry limit not reached/);
      for(let i=0;i<4;i++){await expire();[j]=await claim();}assert.equal(j.attempt,5);await finish(j,'max attempts');
      const [d]=await query('select * from public.jobs_dead');assert.deepEqual(d.message,j.message);assert.equal(d.queue,'sync_jobs');
      assert.deepEqual(await query('select * from pgmq.q_sync_jobs'),[]);
    });
    await t.test('bounds reject null, oversized batch and altered visibility without reading jobs',async()=>{
      await reset();await active();await enqueue();for(const args of [[GEN,4,150],[GEN,0,150],[GEN,null,150],[GEN,3,1],[GEN,3,null]]){
        await assert.rejects(service('select * from public.claim_sync_jobs_v1($1,$2,$3)',args),/invalid sync claim bounds/);
      }assert.equal((await query('select read_ct from pgmq.q_sync_jobs'))[0].read_ct,0);
    });
    await t.test('missing control fails closed',async()=>{
      await reset();const [saved]=await query('select * from mcc_sync_internal.control');await db.exec('delete from mcc_sync_internal.control');
      await assert.rejects(claim(),/control missing/);await query('insert into mcc_sync_internal.control(singleton,generation,enabled,legacy_claim_cutoff) values(true,$1,false,$2)',[GEN,saved.legacy_claim_cutoff]);
    });
    await t.test('anon/authenticated cannot call new RPCs or read private state; service cannot operate controls',async()=>{
      for(const role of ['anon','authenticated','service_role']){
        await db.exec(`set role ${role}`);
        try{
          await assert.rejects(query('select * from mcc_sync_internal.control'),/permission denied/);
          if(role!=='service_role'){
            await assert.rejects(query('select * from public.claim_sync_jobs_v1($1,3,150)',[GEN]),/permission denied/);
            await assert.rejects(query("select public.finish_sync_job_v1($1,1,'00000000-0000-4000-8000-000000000001',null)",[GEN]),/permission denied/);
          }
        }finally{await db.exec('reset role');}
      }
    });
    await t.test('failures within finalization roll back queue and receipt changes atomically',async()=>{
      await reset();await active();await enqueue();const [j]=await claim();
      await db.exec("create function public.fail_receipt_delete() returns trigger language plpgsql as $$begin raise exception 'injected receipt failure';end$$;create trigger fail_receipt_delete before delete on mcc_sync_internal.claims for each statement execute function public.fail_receipt_delete()");
      await assert.rejects(finish(j),/injected receipt failure/);assert.equal((await query('select count(*)::int n from pgmq.q_sync_jobs'))[0].n,1);assert.equal((await query('select count(*)::int n from mcc_sync_internal.claims'))[0].n,1);
      await db.exec('drop trigger fail_receipt_delete on mcc_sync_internal.claims');await finish(j);
    });
    await t.test('transaction-local generation marker does not leak into a later legacy request',async()=>{
      await reset();await active();await enqueue();await claim();assert.notEqual((await query("select current_setting('app.mcc_sync_generation',true) v"))[0].v,GEN);
      await assert.rejects(service("select public.ack_job('sync_jobs',1)"),/paused or obsolete/);
    });
  }finally{await db.close();}
});
