import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { materialize, sha256 } from '../scripts/materialize_mcc_generation_release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/mcc-generation/release-manifest.json')));
const readWorking = relative => fs.readFileSync(path.join(root, relative), 'utf8');
// Optional local exact-byte fixture route; CI uses the actual pinned Git blobs.
// All SHA256/Git-blob/manifest pins remain enforced by the factory either way.
const localBaseline = process.env.MCC_SYNC_BASELINE_DIR;
const baselinePaths = new Map(Object.entries(manifest.functions).flatMap(([slug, spec]) =>
  spec.files.filter(x => !x.baseline_fixture).map(x => [x.repository_path, path.join(localBaseline ?? '', slug, x.name)])));
const defaults = localBaseline ? { readBaseline: relative => fs.readFileSync(baselinePaths.get(relative), 'utf8') } : {};
function run(options = {}, expectError) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-sync-materializer-'));
  const out = path.join(parent, 'bundles');
  try {
    if (expectError) {
      assert.throws(() => materialize(out, { ...defaults, ...options }), expectError);
      assert(!fs.existsSync(out), 'failed validation must not emit a partial bundle');
      return;
    }
    return { result: materialize(out, { ...defaults, ...options }), out, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
  } catch (e) { fs.rmSync(parent, { recursive: true, force: true }); throw e; }
  finally { if (expectError) fs.rmSync(parent, { recursive: true, force: true }); }
}

test('materializes exact API23/workers17 baseline with only the reviewed generation source delta', () => {
  const f = run();
  try {
    assert.equal(f.result['baseline/api'].files, 34); assert.equal(f.result['candidate/api'].files, 34);
    assert.equal(f.result['baseline/workers'].files, 18); assert.equal(f.result['candidate/workers'].files, 19);
    for (const [slug, spec] of Object.entries(manifest.functions)) {
      const changes = [];
      for (const entry of spec.files) {
        const b = entry.added ? null : fs.readFileSync(path.join(f.out, 'baseline', slug, entry.name));
        const c = fs.readFileSync(path.join(f.out, 'candidate', slug, entry.name));
        if (!entry.added) assert.equal(sha256(b), entry.baseline_sha256); assert.equal(sha256(c), entry.candidate_sha256);
        if (!b || !b.equals(c)) changes.push(entry.name);
      }
      assert.deepEqual(changes.sort(), manifest.expected_changed_files[slug]);
      const payload = JSON.parse(fs.readFileSync(path.join(f.out, 'candidate', `${slug}-payload.json`)));
      assert.equal(payload.project_id, 'bgpjpomqrnwsdmrofudb');
      assert.equal(payload.verify_jwt, false);
      assert(f.result[`candidate/${slug}`].closure.includes(slug === 'api' ? 'api/_shared/agentedge-safety.ts' : '_shared/agentedge-safety.ts'));
    }
    assert.equal(sha256(fs.readFileSync(path.join(f.out, 'candidate/workers/_shared/prompts.ts'))), '23cb2e3a9318407960133951b1b23c7e1c5ca3b8f40f1c82c0882fde94b757a3');
  } finally { f.cleanup(); }
});

for (const [label, mutate] of [
  ['project', m => { m.project_id = 'foreign-project'; }],
  ['repository', m => { m.repository = 'other/repo'; }],
  ['baseline', m => { m.source_base_commit = '0'.repeat(40); }],
  ['auth setting', m => { m.functions.workers.verify_jwt = true; }],
  ['entrypoint', m => { m.functions.workers.entrypoint_path = 'unreviewed.ts'; }],
  ['import map', m => { m.functions.api.import_map_path = 'deno.json'; }],
  ['extra allowed delta', m => { m.expected_changed_files.api = ['api/index.ts']; }],
  ['missing function', m => { delete m.functions.api; }],
  ['unknown function', m => { m.functions.extra = structuredClone(m.functions.workers); }],
  ['missing file', m => { m.functions.workers.files.pop(); }],
  ['duplicate file', m => { m.functions.workers.files.push(structuredClone(m.functions.workers.files[0])); }],
  ['unknown file', m => { m.functions.workers.files.push({ ...m.functions.workers.files[0], name: 'extra.ts' }); }],
  ['candidate hash', m => { m.functions.workers.files[0].candidate_sha256 = '0'.repeat(64); }],
  ['baseline hash', m => { m.functions.api.files[0].baseline_sha256 = '0'.repeat(64); }],
  ['Git blob', m => { m.functions.api.files[0].baseline_git_blob = '0'.repeat(40); }],
  ['repository source mapping', m => { m.functions.workers.files[0].repository_path = 'outside/source.ts'; }],
  ['fixture mapping', m => { m.functions.workers.files.find(x => x.name === '_shared/prompts.ts').candidate_fixture = 'other-fixture.ts'; }],
  ['unsafe path', m => { m.functions.workers.files[0].name = '../escape.ts'; }],
  ['unknown metadata', m => { m.unreviewed = true; }],
]) test(`manifest alone cannot change reviewed ${label}`, () => {
  const changed = structuredClone(manifest); mutate(changed);
  run({ manifest: changed }, /./);
});

for (const file of ['supabase/functions/workers/sync-job-runtime.ts', 'supabase/functions/api/_shared/util.ts', 'supabase/functions/workers/gmail-sync-worker.ts', 'supabase/functions/api/_shared/agentedge-safety.ts', 'supabase/functions/api/_shared/agentedge-push.ts', 'tests/fixtures/mcc-agentedge/workers-v16-prompts.ts', 'supabase/functions/workers/deno.json']) {
  test(`one changed candidate byte rejects ${file}`, () => run({ readWorking: relative => readWorking(relative) + (relative === file ? '\n// unreviewed byte\n' : '') }, /content drift/));
}

test('non-empty output is refused rather than mixing new and stale bundle files', () => {
  const f = run();
  try { assert.throws(() => materialize(f.out, defaults), /output directory must be absent or empty/); }
  finally { f.cleanup(); }
});

test('canonical migration equals tested SQL and is durably paused',()=>{
 const expected=readWorking('tests/fixtures/mcc-generation/generation-fence-candidate.sql');
 assert.equal(readWorking('supabase/migrations/20261003231928_gmail_generation_mutation_fence_v1.sql'),expected);
 assert(!/update[\s\S]*?control set enabled\s*=\s*true/i.test(expected));
});
