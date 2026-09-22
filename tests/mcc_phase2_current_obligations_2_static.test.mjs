import fs from "node:fs";
import assert from "node:assert/strict";

const sql=fs.readFileSync("scripts/mcc_phase2_current_obligations_2.sql","utf8");
const plan=fs.readFileSync("docs/MCC_PHASE2_CURRENT_OBLIGATIONS_2.md","utf8");

assert.ok(plan.includes("NOT APPLIED TO PRODUCTION"));
assert.ok(sql.includes("PREP ONLY"));
assert.ok(sql.includes("Tahiti — resolve Oct 23 tattoo appointment details"));
assert.ok(sql.includes("MasterClass — verify Rosen Master Account authorization completion"));
assert.ok(sql.includes("Rosen check — verify clearing status"));
assert.ok(sql.includes("Angie Cain — add Victoria Redwine to MasterClass room"));
assert.ok(sql.includes("'PROMISE'"));
assert.ok(sql.includes("'WAITING'"));
assert.ok(sql.includes("PARTIALLY_VERIFIED"));
assert.ok(sql.includes("Would leave an obligation without provenance"));
assert.ok(sql.includes("Would create duplicate stable source refs"));
assert.ok(!sql.includes("send_email"));
assert.ok(!sql.includes("charge"));
console.log("PASS: Phase 2 current-obligation seed remains conservative and approval-gated");
