import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { materialize,sha256 } from '../scripts/materialize_mcc_cost_release.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/mcc-cost/release-manifest.json')));
const local=process.env.MCC_COST_BASELINE_DIR;
const defaults=local?{readBaseline:p=>fs.readFileSync(path.join(local,p),'utf8')}:{};
const readWorking=p=>fs.readFileSync(path.join(root,p),'utf8');
function run(options={},error) {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcc-cost-materializer-')),out=path.join(temp,'bundle');
 try {
  if(error){assert.throws(()=>materialize(out,{...defaults,...options}),error);assert(!fs.existsSync(out));return;}
  return {out,result:materialize(out,{...defaults,...options}),close:()=>fs.rmSync(temp,{recursive:true,force:true})};
 }catch(e){fs.rmSync(temp,{recursive:true,force:true});throw e;}finally{if(error)fs.rmSync(temp,{recursive:true,force:true});}
}
test('exact API24/workers18 preserved with only three worker-file changes',()=>{
 const f=run();try{
  assert.equal(f.result['baseline/api'].files,34);assert.equal(f.result['candidate/api'].files,34);
  assert.equal(f.result['baseline/workers'].files,19);assert.equal(f.result['candidate/workers'].files,21);
  for(const [slug,spec] of Object.entries(manifest.functions)){
   const changed=[];for(const e of spec.files){const c=fs.readFileSync(path.join(f.out,'candidate',slug,e.name));assert.equal(sha256(c),e.candidate_sha256);
    if(e.added||!c.equals(fs.readFileSync(path.join(f.out,'baseline',slug,e.name))))changed.push(e.name);}
   assert.deepEqual(changed.sort(),manifest.expected_changed_files[slug]);
  }
  assert.equal(sha256(fs.readFileSync(path.join(f.out,'candidate/workers/_shared/prompts.ts'))),'23cb2e3a9318407960133951b1b23c7e1c5ca3b8f40f1c82c0882fde94b757a3');
 }finally{f.close();}
});
for(const [name,mutate] of [
 ['extra allowed delta',m=>m.expected_changed_files.workers.push('index.ts')],['missing inventory',m=>m.functions.workers.files.pop()],
 ['foreign tenant project',m=>m.project_id='foreign'],['changed auth',m=>m.functions.workers.verify_jwt=true],
 ['different base',m=>m.source_base_commit='0'.repeat(40)],['altered price SQL hash',m=>m.database_sources.at(-1).sha256='0'.repeat(64)],
 ['missing SQL source',m=>m.database_sources.pop()],['new metadata',m=>m.unknown=true],
 ['changed path',m=>m.functions.workers.files[0].repository_path='other.ts'],['altered prompt',m=>m.functions.workers.files.find(e=>e.name==='_shared/prompts.ts').candidate_sha256='0'.repeat(64)]
])test('manifest cannot admit '+name,()=>{const m=structuredClone(manifest);mutate(m);run({manifest:m},/./);});
for(const p of ['supabase/functions/workers/triage-cost.ts','supabase/functions/workers/triage-provider.ts','supabase/functions/workers/triage-worker.ts',
 'supabase/functions/workers/gmail-sync-worker.ts','supabase/functions/api/_shared/util.ts','supabase/functions/api/gmail-send.ts',
 'tests/fixtures/mcc-agentedge/workers-v16-prompts.ts','supabase/migrations/20261004030453_triage_cost_reservations_v1.sql',
 'supabase/migrations/20261003231928_gmail_generation_mutation_fence_v1.sql'])test('source drift is refused: '+p,()=>run({readWorking:x=>readWorking(x)+(x===p?'\n-- drift\n':'')},/drift/));
test('existing output cannot mix stale bytes',()=>{const f=run();try{assert.throws(()=>materialize(f.out,defaults),/output directory/);}finally{f.close();}});
