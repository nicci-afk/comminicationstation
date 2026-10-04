// Exact API inventory; no deployment. Historical releases stay immutable.
import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {stripTypeScriptTypes} from 'node:module';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pin='d6a6f05adece7aea689ab8b36721889eae5d8d05ffda6c4f57a386d8c08903dc';
export const digest=b=>createHash('sha256').update(b).digest('hex');
const blob=s=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
export function materialize(out,{manifest=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/reply-api-release-manifest.json'),'utf8')),read=p=>fs.readFileSync(path.join(root,p),'utf8'),baseline=p=>execFileSync('git',['show',`${manifest.source_base_commit}:${p}`],{cwd:root,encoding:'utf8'}),cutover=null}={}){
 assert.equal(digest(JSON.stringify(manifest)),pin,'reviewed manifest drift');assert.equal(manifest.files.length,37);
 const files=[],changes=[];
 for(const e of manifest.files){const source=read(e.repository_path);assert.equal(digest(source),e.candidate_sha256,'candidate content drift: '+e.name);const before=e.baseline_git_blob===null?null:baseline(e.repository_path);if(before!==null)assert.equal(blob(before),e.baseline_git_blob,'baseline Git blob drift');if(source!==before)changes.push(e.name);files.push({name:e.name,content:source});}
 assert.deepEqual(changes.sort(),manifest.changed_files);
 if(cutover){const f=files.find(e=>e.name==='api/_shared/util.ts'),value=fs.readFileSync(path.join(cutover,'supabase/functions/api/_shared/util.ts'),'utf8');assert.equal(blob(value),manifest.cutover_util_git_blob,'PR18 utility drift');f.content=value;}
 const byName=new Map(files.map(f=>[f.name,f.content])),aliases=JSON.parse(byName.get(manifest.import_map_path)).imports,visited=new Set();
 function visit(name){if(visited.has(name))return;assert(byName.has(name),'missing import '+name);visited.add(name);const code=stripTypeScriptTypes(byName.get(name),{mode:'strip'});assert(!/\bimport\s*\(/.test(code),'dynamic import needs review');for(const specifier of new vm.SourceTextModule(code).dependencySpecifiers){if(specifier.startsWith('.'))visit(path.posix.normalize(path.posix.join(path.posix.dirname(name),specifier)));else assert(aliases[specifier],'unknown external import '+specifier);}}
 visit(manifest.entrypoint_path);assert(visited.has('api/reply-review.ts'));
 assert(!fs.existsSync(out)||fs.readdirSync(out).length===0,'output must be empty');fs.mkdirSync(out,{recursive:true});
 const payload={project_id:manifest.project_id,name:'api',entrypoint_path:manifest.entrypoint_path,import_map_path:manifest.import_map_path,verify_jwt:manifest.verify_jwt,files};
 fs.writeFileSync(path.join(out,'api-payload.json'),JSON.stringify(payload,null,2)+'\n');const receipt={manifest_sha256:pin,variant:cutover?'PR18-compatible':'main',files:files.length,closure:[...visited].sort(),payload_sha256:digest(fs.readFileSync(path.join(out,'api-payload.json')))};fs.writeFileSync(path.join(out,'materialization.json'),JSON.stringify(receipt,null,2)+'\n');return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(materialize(path.resolve(process.argv[2]),{cutover:process.argv[3]||null}),null,2));
