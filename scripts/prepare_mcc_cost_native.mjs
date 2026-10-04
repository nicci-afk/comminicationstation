import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root=path.resolve(new URL('..',import.meta.url).pathname);
const [bundles,local,evidence]=process.argv.slice(2);assert(bundles&&local&&evidence);
const sha=b=>createHash('sha256').update(b).digest('hex');
function tree(dir,base=dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
 const full=path.join(dir,e.name);assert(!e.isSymbolicLink(),'No links in native exact bundle');
 return e.isDirectory()?tree(full,base):[{path:path.relative(base,full),sha256:sha(fs.readFileSync(full))}];
}).sort((a,b)=>a.path.localeCompare(b.path));}
const source=path.join(bundles,'candidate/workers'),dest=path.join(local,'supabase/functions/cost-runtime');
fs.mkdirSync(dest,{recursive:true});fs.cpSync(source,path.join(dest,'bundle'),{recursive:true});
assert.deepEqual(tree(source),tree(path.join(dest,'bundle')));
const wrapper=fs.readFileSync(path.join(root,'tests/fixtures/mcc-cost/edge-wrapper.ts'));
fs.writeFileSync(path.join(dest,'index.ts'),wrapper);fs.copyFileSync(path.join(source,'deno.json'),path.join(dest,'deno.json'));
fs.appendFileSync(path.join(local,'supabase/config.toml'),'\n[functions.cost-runtime]\nverify_jwt = false\nentrypoint = "./functions/cost-runtime/index.ts"\nimport_map = "./functions/cost-runtime/deno.json"\n');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/mcc-cost/release-manifest.json')));
fs.writeFileSync(path.join(evidence,'cost-native-source-manifest.json'),JSON.stringify({
 exactWorkers:tree(source),wrapper_sha256:sha(wrapper),databaseSources:manifest.database_sources,
 nativeSupportSha256:sha(fs.readFileSync(path.join(root,'tests/fixtures/mcc-cost/native-support.sql'))),
 limitations:['Provider HTTP is synthetic; no real model calls','Independent native sessions are required; portable suites are not a substitute','Canonical baseline schema subset and candidate migration; live schema drift remains a release gate'],
},null,2)+'\n');
