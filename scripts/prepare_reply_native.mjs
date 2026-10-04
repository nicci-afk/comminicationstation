import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const [local,evidence,variant='main',cutover]=process.argv.slice(2);
assert(local&&evidence&&['main','cutover'].includes(variant));
const files=['reply-review.ts','gmail-send.ts','twilio-send.ts','_shared/reply-review.ts','_shared/reply-evidence.ts','_shared/util.ts','_shared/gmail.ts'];
const digest=s=>createHash('sha256').update(s).digest('hex');
const manifest={variant,applicationFiles:[],wrapper:[],limitations:['Synthetic OAuth/Gmail/Twilio only; no live providers or models','Canonical repository schema subset, retained email ingest, and local Supabase Auth/PostgREST/Edge','Browser uses the exact ReplyReview component with a local-only transport adapter, not the entire ItemDetail page']};
const wrapper=fs.readFileSync(path.join(root,'tests/fixtures/reply-runtime-wrapper.ts'),'utf8');
for(const enabled of [true,false]) {
  const dir=path.join(local,'supabase/functions',enabled?'reply-runtime':'reply-disabled');fs.mkdirSync(path.join(dir,'app/_shared'),{recursive:true});
  fs.writeFileSync(path.join(dir,'index.ts'),wrapper.replace('__ENABLED__',String(enabled)));
  fs.writeFileSync(path.join(dir,'deno.json'),JSON.stringify({imports:{'@supabase/supabase-js':'npm:@supabase/supabase-js@2.110.8'}}));
  for(const file of files){let source=path.join(root,'supabase/functions/api',file);
    if(variant==='cutover'&&file==='_shared/util.ts') {assert(cutover);source=path.join(cutover,'supabase/functions/api/_shared/util.ts');const b=fs.readFileSync(source);assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`),b])).digest('hex'),'87c393bb797b5f36494ccad8f91d555782b0f646');}
    const bytes=fs.readFileSync(source);fs.writeFileSync(path.join(dir,'app',file),bytes);
    if(enabled)manifest.applicationFiles.push({path:'supabase/functions/api/'+file,sha256:digest(bytes),origin:variant==='cutover'&&file==='_shared/util.ts'?'PR18 019098c85561c234dc3c49f0e16f0fb42c3b7ec6':'candidate'});
  }
  manifest.wrapper.push({name:path.basename(dir),sha256:digest(fs.readFileSync(path.join(dir,'index.ts')))});
}
manifest.sql=['0001_core.sql','0002_channels_contacts_messages.sql','0003_queue_pipeline.sql','0004_rpcs.sql','0006_hotfixes.sql','0007_security_hardening.sql','0008_categorization_update.sql','0016_gmail_send_scope.sql'].map(n=>'supabase/migrations/'+n).concat(['scripts/mcc_reply_evidence_integration.sql','tests/fixtures/reply-canonical-ingest.sql','tests/fixtures/reply-native-support.sql']).map(p=>({path:p,sha256:digest(fs.readFileSync(path.join(root,p)))}));
if(variant==='cutover')manifest.cutoverSQL={path:'supabase/migrations/20261003231928_gmail_generation_mutation_fence_v1.sql',sha256:digest(fs.readFileSync(path.join(cutover,'supabase/migrations/20261003231928_gmail_generation_mutation_fence_v1.sql')))};
fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'runtime-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
