// Build only committed apps/web files, exactly the frontend deployment boundary.
// No Supabase files, parent repository imports, credentials, provider calls or deploys.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'mcc-reply-standalone-'));
try {
 const entries=execFileSync('git',['ls-tree','-rz','HEAD:apps/web'],{cwd:root}).toString().split('\0').filter(Boolean);
 for(const entry of entries){const [info,name]=entry.split('\t'),[mode,kind,blob]=info.split(' ');assert.equal(mode,'100644');assert.equal(kind,'blob');assert(!path.isAbsolute(name)&&!name.split('/').some(x=>x==='..'||x==='node_modules'||x==='dist'));const target=path.join(out,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,execFileSync('git',['cat-file','blob',blob],{cwd:root}));}
 fs.symlinkSync(fs.realpathSync(path.join(root,'apps/web/node_modules')),path.join(out,'node_modules'),'dir');
 execFileSync('npm',['run','build'],{cwd:out,stdio:'inherit'});
 console.log(`PASS: standalone frontend build from ${entries.length} committed subtree files; no parent/backend source available`);
} finally {fs.rmSync(out,{recursive:true,force:true});}
