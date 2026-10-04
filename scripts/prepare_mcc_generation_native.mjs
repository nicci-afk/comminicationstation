// Validation-only: retain the exact bundle wrapper, identify the actual schema
// and migration used by the native concurrency runner (not its protocol adapter).
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const [bundles,local,evidence]=process.argv.slice(2);assert(bundles&&local&&evidence);
execFileSync(process.execPath,[path.join(root,'tests/mcc_generation_checkpoints.test.mjs'),'--prepare',bundles,local,evidence],{stdio:'inherit'});
const manifestPath=path.join(evidence,'sync-runtime-wrapper-manifest.json');
const m=JSON.parse(fs.readFileSync(manifestPath));delete m.sql;
const paths=['0001_core.sql','0002_channels_contacts_messages.sql','0003_queue_pipeline.sql','0004_rpcs.sql','0006_hotfixes.sql','0007_security_hardening.sql','0008_categorization_update.sql','0016_gmail_send_scope.sql','20261003231928_gmail_generation_mutation_fence_v1.sql'].map(n=>'supabase/migrations/'+n);
paths.push(...['canonical-ingest.sql','native-support.sql','activate-reviewed-generation.sql','pause-reviewed-generation.sql'].map(n=>'tests/fixtures/mcc-generation/'+n));
m.databaseSources=paths.map(p=>({path:p,sha256:createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')}));
m.limitations=['Synthetic Google HTTP; no live provider/model requests','Canonical retained ingest definition and repository schema subset; fresh production schema drift remains unverified','Actual installed pgmq extension; deterministic interleavings do not prove every possible execution schedule','Fixture-only advisory gate inserted before first statement in a copy of canonical ingest; canonical function itself is unchanged'];
fs.writeFileSync(manifestPath,JSON.stringify(m,null,2)+'\n');
