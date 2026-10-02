// Local-only, exact-source release materializer. No network or deployment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sha256 = text => createHash("sha256").update(text).digest("hex");
const gitBlob = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");

export function materialize(out, options = {}) {
  const manifest = options.manifest ?? JSON.parse(read("tests/fixtures/mcc-agentedge/release-manifest.json"));
  const readWorking = options.readWorking ?? read;
  const readBaseline = options.readBaseline ?? (relative => execFileSync("git", ["show", `${manifest.source_base_commit}:${relative}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  const expectedChanges = {
    api: ["api/_shared/agentedge-safety.ts", "api/agentedge-historical-import.ts", "api/agentedge-relay.ts"],
    workers: ["_shared/agentedge-push.ts", "_shared/agentedge-safety.ts"],
  };
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.repository, "nicci-afk/comminicationstation");
  assert.match(manifest.source_base_commit, /^[0-9a-f]{40}$/);
  const result = {};
  for (const [slug, spec] of Object.entries(manifest.functions)) {
    assert.ok(expectedChanges[slug], `unreviewed function ${slug}`);
    const files = { baseline: [], candidate: [] };
    const changed = [];
    for (const entry of spec.files) {
      assert.ok(!path.isAbsolute(entry.name) && !entry.name.split("/").includes(".."), "unsafe bundle filename");
      const baseline = entry.baseline_sha256 === null ? null : entry.baseline_fixture ? readWorking(entry.baseline_fixture) : readBaseline(entry.repository_path);
      if (baseline !== null) {
        assert.equal(sha256(baseline), entry.baseline_sha256, `baseline content drift: ${slug}/${entry.name}`);
        assert.equal(gitBlob(baseline), entry.baseline_git_blob, `baseline Git blob drift: ${slug}/${entry.name}`);
        files.baseline.push({ name: entry.name, content: baseline });
      }
      const candidate = readWorking(entry.candidate_fixture ?? entry.repository_path);
      assert.equal(sha256(candidate), entry.candidate_sha256, `candidate content drift: ${slug}/${entry.name}`);
      files.candidate.push({ name: entry.name, content: candidate });
      if (candidate !== baseline) changed.push(entry.name);
    }
    assert.deepEqual(changed.sort(), expectedChanges[slug], `unexpected changed file set for ${slug}`);
    for (const flavor of ["baseline", "candidate"]) {
      const byName = new Map(files[flavor].map(f => [f.name, f.content]));
      assert.equal(byName.size, files[flavor].length, "duplicate filename");
      const aliases = JSON.parse(byName.get(spec.import_map_path)).imports;
      const visited = new Set();
      function visit(name) {
        if (visited.has(name)) return;
        assert.ok(byName.has(name), `missing ${flavor} dependency: ${slug}/${name}`);
        visited.add(name);
        const source = byName.get(name);
        const imports = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: "strip" })).dependencySpecifiers;
        for (const specifier of imports) {
          if (specifier.startsWith(".")) visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)));
          else assert.ok(aliases[specifier] || /^(https?:|npm:|jsr:|node:)/.test(specifier), `unresolved ${specifier}`);
        }
      }
      visit(spec.entrypoint_path);
      const payload = { project_id: manifest.project_id, name: slug, entrypoint_path: spec.entrypoint_path, import_map_path: spec.import_map_path, verify_jwt: spec.verify_jwt, files: files[flavor] };
      for (const file of payload.files) {
        const target = path.join(out, flavor, slug, file.name);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content);
      }
      const filename = path.join(out, flavor, `${slug}-payload.json`);
      fs.writeFileSync(filename, `${JSON.stringify(payload, null, 2)}\n`);
      result[`${flavor}/${slug}`] = { files: payload.files.length, payload_sha256: sha256(fs.readFileSync(filename)) };
    }
    assert.equal(files.candidate.find(f => f.name === spec.entrypoint_path).content, files.baseline.find(f => f.name === spec.entrypoint_path).content);
    assert.equal(files.candidate.find(f => f.name === spec.import_map_path).content, files.baseline.find(f => f.name === spec.import_map_path).content);
  }
  fs.writeFileSync(path.join(out, "materialization.json"), `${JSON.stringify({ source_base_commit: manifest.source_base_commit, results: result }, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], "Usage: node scripts/materialize_mcc_agentedge_release.mjs <output-directory>");
  console.log(JSON.stringify(materialize(path.resolve(process.argv[2])), null, 2));
}
