import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { materialize } from "../scripts/materialize_mcc_agentedge_release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("exact deployed baseline/candidate payloads materialize without unrelated edits", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-materializer-"));
  try {
    const result = materialize(out);
    assert.equal(result["baseline/api"].files, 33); assert.equal(result["candidate/api"].files, 34);
    assert.equal(result["baseline/workers"].files, 17); assert.equal(result["candidate/workers"].files, 18);
    assert.equal(fs.readFileSync(path.join(out, "candidate/workers/_shared/prompts.ts"), "utf8"), fs.readFileSync(path.join(root, "tests/fixtures/mcc-agentedge/workers-v16-prompts.ts"), "utf8"));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("a changed candidate byte refuses to create a reviewable release", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-materializer-negative-"));
  try {
    assert.throws(() => materialize(out, { readWorking: relative => fs.readFileSync(path.join(root, relative), "utf8") + (relative.endsWith("agentedge-safety.ts") ? "\n// unexpected drift" : "") }), /candidate content drift/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
