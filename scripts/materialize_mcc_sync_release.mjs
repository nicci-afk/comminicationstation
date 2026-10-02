// Validation-only exact-source factory for the checkpoint release. No network,
// deployment, secrets, database access, or edits to the historical guard release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'f913bd8c208cce1fd4c42a3f14a5141d89d55ea0';
const PROJECT = 'bgpjpomqrnwsdmrofudb';
const REPOSITORY = 'nicci-afk/comminicationstation';
const MANIFEST_PIN = '7a6a81d7aaaf85325115ca2471620eb5de143d75159227c7fc072dc8cd31f4a7';
const NAMES = {
  "api": [
    "api/_shared/agentedge-safety.ts",
    "api/_shared/gmail.ts",
    "api/_shared/llm.ts",
    "api/_shared/prompts.ts",
    "api/_shared/schemas/comm.ts",
    "api/_shared/schemas/confidence.ts",
    "api/_shared/util.ts",
    "api/admin-config.ts",
    "api/agentedge-historical-import.ts",
    "api/agentedge-import-strategies.ts",
    "api/agentedge-relay.ts",
    "api/agentedge-sync.ts",
    "api/bootstrap.ts",
    "api/contact-link.ts",
    "api/contact-merge.ts",
    "api/contacts-google-sync.ts",
    "api/contacts-vcf-import.ts",
    "api/deno.json",
    "api/draft-reply.ts",
    "api/gmail-deep-backfill.ts",
    "api/gmail-get-body.ts",
    "api/gmail-oauth-callback.ts",
    "api/gmail-oauth-start.ts",
    "api/gmail-push.ts",
    "api/gmail-send.ts",
    "api/index.ts",
    "api/interaction-update.ts",
    "api/mcc-fast-capture.ts",
    "api/mcc-obligation-action.ts",
    "api/pipeline-start.ts",
    "api/spam-block.ts",
    "api/twilio-inbound.ts",
    "api/twilio-provision.ts",
    "api/twilio-send.ts"
  ],
  "workers": [
    "_shared/agentedge-push.ts",
    "_shared/agentedge-safety.ts",
    "_shared/gmail.ts",
    "_shared/llm.ts",
    "_shared/prompts.ts",
    "_shared/schemas/comm.ts",
    "_shared/schemas/confidence.ts",
    "_shared/schemas/packets.ts",
    "_shared/schemas/perplexity.ts",
    "_shared/schemas/persona.ts",
    "_shared/schemas/qc.ts",
    "_shared/util.ts",
    "deno.json",
    "digest-worker.ts",
    "gmail-sync-worker.ts",
    "index.ts",
    "pipeline-worker.ts",
    "triage-worker.ts"
  ]
};
const CHANGES = { api: [], workers: ['gmail-sync-worker.ts'] };
const SETTINGS = {
  api: { baseline_version: 23, entrypoint_path: 'api/index.ts', import_map_path: 'api/deno.json', verify_jwt: false,
    baseline_bundle_sha256: '6ffcc7bd8cb33edfa09459f174bfedf24f4e76b0418d783228f0512360a5c2e9' },
  workers: { baseline_version: 17, entrypoint_path: 'index.ts', import_map_path: 'deno.json', verify_jwt: false,
    baseline_bundle_sha256: '35e27bb0385cca1611b4c728dee4e105aece891c43b79b7bfde6a33c290a8551' },
};
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

export function materialize(out, options = {}) {
  const manifest = options.manifest ?? JSON.parse(read('tests/fixtures/mcc-sync/release-manifest.json'));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.project_id, PROJECT);
  assert.equal(manifest.source_base_commit, BASE);
  assert.equal(manifest.release_scope, 'gmail_incremental_checkpoint_loss_prevention');
  assert.deepEqual(Object.keys(manifest.functions).sort(), ['api', 'workers']);
  assert.deepEqual(manifest.expected_changed_files, CHANGES);
  // The manifest alone cannot expand a release. Updating any reviewed hash or
  // mapping also requires an explicit source-pin change in this gate.
  assert.equal(sha256(JSON.stringify(manifest)), MANIFEST_PIN, 'reviewed manifest drift');
  const readWorking = options.readWorking ?? read;
  const readBaseline = options.readBaseline ?? (relative => execFileSync('git', ['show', `${BASE}:${relative}`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  const plans = [];
  for (const slug of ['api', 'workers']) {
    const spec = manifest.functions[slug];
    for (const [key, value] of Object.entries(SETTINGS[slug])) assert.equal(spec[key], value, `${slug} ${key}`);
    assert.deepEqual(spec.files.map(x => x.name).sort(), NAMES[slug], `missing/duplicate/unknown ${slug} inventory`);
    const names = new Set();
    const files = { baseline: [], candidate: [] }, changed = [];
    for (const entry of spec.files) {
      assert(!names.has(entry.name), 'duplicate file'); names.add(entry.name);
      assert(!path.isAbsolute(entry.name) && !entry.name.split('/').some(x => ['', '.', '..'].includes(x)), 'unsafe filename');
      const baseline = entry.baseline_fixture ? readWorking(entry.baseline_fixture) : readBaseline(entry.repository_path);
      const candidate = readWorking(entry.candidate_fixture ?? entry.repository_path);
      assert.equal(sha256(baseline), entry.baseline_sha256, `baseline content drift: ${slug}/${entry.name}`);
      assert.equal(blob(baseline), entry.baseline_git_blob, `baseline Git blob drift: ${slug}/${entry.name}`);
      assert.equal(sha256(candidate), entry.candidate_sha256, `candidate content drift: ${slug}/${entry.name}`);
      files.baseline.push({ name: entry.name, content: baseline });
      files.candidate.push({ name: entry.name, content: candidate });
      if (baseline !== candidate) changed.push(entry.name);
    }
    assert.deepEqual(changed.sort(), CHANGES[slug], `unreviewed ${slug} runtime change`);
    for (const flavor of ['baseline', 'candidate']) {
      const byName = new Map(files[flavor].map(f => [f.name, f.content]));
      const aliases = JSON.parse(byName.get(spec.import_map_path)).imports;
      const visited = new Set();
      function visit(name) {
        if (visited.has(name)) return;
        assert(byName.has(name), `missing ${flavor} import: ${slug}/${name}`);
        visited.add(name);
        const code = stripTypeScriptTypes(byName.get(name), { mode: 'strip' });
        assert(!/\bimport\s*\(/.test(code), 'dynamic imports require explicit closure review');
        const imports = new vm.SourceTextModule(code).dependencySpecifiers;
        for (const specifier of imports) {
          if (specifier.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)));
          else assert(aliases[specifier], `unreviewed external import: ${specifier}`);
        }
      }
      visit(spec.entrypoint_path);
      const payload = { project_id: PROJECT, name: slug, entrypoint_path: spec.entrypoint_path,
        import_map_path: spec.import_map_path, verify_jwt: spec.verify_jwt, files: files[flavor] };
      plans.push({ slug, flavor, payload, closure: [...visited].sort() });
    }
    for (const file of [spec.entrypoint_path, spec.import_map_path]) {
      assert.equal(files.baseline.find(x => x.name === file).content, files.candidate.find(x => x.name === file).content, `${slug} entrypoint/import map changed`);
    }
  }
  // Never leave a partly validated payload, stale source file, or old artifact
  // in the output folder after a failed check.
  assert(!fs.existsSync(out) || fs.readdirSync(out).length === 0, 'output directory must be absent or empty');
  fs.mkdirSync(out, { recursive: true });
  const results = {};
  for (const { slug, flavor, payload, closure } of plans) {
    for (const file of payload.files) {
      const dest = path.join(out, flavor, slug, file.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, file.content);
    }
    const filename = path.join(out, flavor, `${slug}-payload.json`);
    fs.writeFileSync(filename, JSON.stringify(payload, null, 2) + '\n');
    results[`${flavor}/${slug}`] = { files: payload.files.length, payload_sha256: sha256(fs.readFileSync(filename)), closure };
  }
  fs.writeFileSync(path.join(out, 'materialization.json'), JSON.stringify({ source_base_commit: BASE, manifest_sha256: MANIFEST_PIN, results }, null, 2) + '\n');
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 3, 'Usage: node --experimental-vm-modules scripts/materialize_mcc_sync_release.mjs <empty-output-directory>');
  console.log(JSON.stringify(materialize(path.resolve(process.argv[2])), null, 2));
}
