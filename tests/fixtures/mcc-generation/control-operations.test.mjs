import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const file=n=>fs.readFileSync(new URL(n,import.meta.url),'utf8');
const db=new PGlite();const q=(s,p=[])=>db.query(s,p).then(r=>r.rows);
function script(name,cutoff,reason){return file(name).split('\n').filter(l=>!l.startsWith('\\')).join('\n')
  .replaceAll(":'observed_cutoff'","'"+String(cutoff).replaceAll("'","''")+"'")
  .replaceAll(":'approved_reason'","'"+reason.replaceAll("'","''")+"'");}
async function run(sql){try{await db.exec(sql);}catch(e){await db.exec('rollback');throw e;}}
await test('exact control-operation templates and audit provenance (local only)',async t=>{
 try{
  await db.exec(file('./bootstrap.sql'));await db.exec(file('./fixture-domain.sql'));await db.exec(file('./generation-fence-candidate.sql'));
  // Preserve PostgreSQL microseconds. JavaScript Date would truncate them
  // and correctly fail the exact-cutoff CAS in the operator template.
  const row=()=>q('select *,legacy_claim_cutoff::text exact_cutoff from mcc_sync_internal.control').then(x=>({...x[0],legacy_claim_cutoff:x[0].exact_cutoff}));
  await t.test('installation records a paused state with reason and actor',async()=>{
   const[e]=await q('select * from mcc_sync_internal.control_events');assert.equal(e.reason,'install paused generation fence');assert(e.session_actor);assert.equal(e.old_state,null);assert.equal(e.new_state.enabled,false);
  });
  await t.test('400-second condition prevents immediate activation',async()=>{
   const v=await row();await assert.rejects(run(script('./activate-reviewed-generation.sql',v.legacy_claim_cutoff,'test premature')),/preconditions/);assert.equal((await row()).enabled,false);
  });
  await db.exec("update mcc_sync_internal.control set legacy_claim_cutoff=clock_timestamp()-interval '401 seconds' where singleton");
  await t.test('stale observed cutoff cannot activate',async()=>{
   await assert.rejects(run(script('./activate-reviewed-generation.sql','2000-01-01T00:00:00Z','test stale')),/preconditions/);assert.equal((await row()).enabled,false);
  });
  await t.test('empty reason prevents activation',async()=>{
   const v=await row();await assert.rejects(run(script('./activate-reviewed-generation.sql',v.legacy_claim_cutoff,'')),/preconditions/);
  });
  await t.test('matching aged cutoff activates exactly the expected singleton and records provenance',async()=>{
   const v=await row();await run(script('./activate-reviewed-generation.sql',v.legacy_claim_cutoff,'local verified activation'));assert.equal((await row()).enabled,true);
   const[e]=await q('select * from mcc_sync_internal.control_events order by id desc limit 1');assert.equal(e.reason,'local verified activation');assert.equal(e.old_state.enabled,false);assert.equal(e.new_state.enabled,true);
  });
  await t.test('repeat activation is rejected rather than silently re-authorizing',async()=>{
   const v=await row();await assert.rejects(run(script('./activate-reviewed-generation.sql',v.legacy_claim_cutoff,'repeat')),/preconditions/);
  });
  await t.test('pause atomically closes claims and logs before/after state',async()=>{
   await run(script('./pause-reviewed-generation.sql',null,'local explicit pause'));assert.equal((await row()).enabled,false);
   const[e]=await q('select * from mcc_sync_internal.control_events order by id desc limit 1');assert.equal(e.reason,'local explicit pause');assert.equal(e.old_state.enabled,true);assert.equal(e.new_state.enabled,false);
  });
  await t.test('repeat pause is a visible reconciliation condition',async()=>{
   await assert.rejects(run(script('./pause-reviewed-generation.sql',null,'repeat')),/target changed or already paused/);
  });
  await t.test('service-role worker cannot activate or read private change history',async()=>{
   await db.exec('set role service_role');try{
    await assert.rejects(q('update mcc_sync_internal.control set enabled=true where singleton'),/permission denied/);
    await assert.rejects(q('select * from mcc_sync_internal.control_events'),/permission denied/);
   }finally{await db.exec('reset role');}
  });
 }finally{await db.close();}
});
