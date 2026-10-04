import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const server=fs.readFileSync('supabase/functions/api/_shared/reply-evidence.ts'),frontend=fs.readFileSync('apps/web/src/lib/replyEvidence.ts');
const parity=(left,right)=>assert.deepEqual(left,right,'frontend pure checker drifted from canonical server source');
test('frontend pure checker is byte-identical to canonical server module',()=>parity(server,frontend));
test('one-byte frontend or server checker drift fails parity',()=>{assert.throws(()=>parity(Buffer.concat([server,Buffer.from(' ')]),frontend),/drifted/);assert.throws(()=>parity(server,Buffer.concat([frontend,Buffer.from(' ')])),/drifted/);});
test('ReplyReview imports the standalone frontend copy without parent repository dependencies',()=>{const source=fs.readFileSync('apps/web/src/components/ReplyReview.tsx','utf8');assert.match(source,/from "\.\.\/lib\/replyEvidence"/);assert(!source.includes('supabase/functions'));});
