import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {materialize} from '../scripts/materialize_reply_api.mjs';
const manifest=JSON.parse(fs.readFileSync('tests/fixtures/reply-api-release-manifest.json','utf8'));
const options=()=>process.env.REPLY_LOCAL_BASELINE?{baseline:p=>fs.readFileSync(path.join(process.env.REPLY_LOCAL_BASELINE,p),'utf8')}:{ };
const run=(opts={})=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-manifest-'));try{return materialize(path.join(dir,'out'),{...options(),...opts});}finally{fs.rmSync(dir,{recursive:true,force:true});}};
test('complete 37-file API inventory includes all reply imports and preserved settings',()=>{const r=run();assert.equal(r.files,37);assert(r.closure.includes('api/_shared/reply-review.ts'));});
for(const key of ['verify_jwt','files','changed_files','source_base_commit','cutover_util_git_blob'])test('manifest tamper rejected: '+key,()=>{const m=structuredClone(manifest);m[key]=null;assert.throws(()=>run({manifest:m}),/manifest drift/);});
test('a one-byte API source change is rejected before output',()=>assert.throws(()=>run({read:p=>fs.readFileSync(p,'utf8')+'\n'}),/content drift/));

test('numbered release migration preserves reviewed SQL except bounded installation timeouts',()=>{
 const proposal=fs.readFileSync('scripts/mcc_reply_evidence_integration.sql','utf8');
 const expected='-- CLI-generated release migration; reviewed proposal plus transaction-local installation limits.\n'+proposal.slice(proposal.indexOf('begin;')).replace('begin;',"begin;\nset local lock_timeout='5s';\nset local statement_timeout='30s';");
 assert.equal(fs.readFileSync('supabase/migrations/20261004040537_reply_evidence_approval_dispatch_v1.sql','utf8'),expected);
});
