import fs from "node:fs";
import assert from "node:assert/strict";

const sql=fs.readFileSync("scripts/mcc_final_current_state_reconciliation.sql","utf8");
const doc=fs.readFileSync("docs/MCC_FINAL_CURRENT_STATE_RECONCILIATION.md","utf8");

assert.ok(doc.includes("NOT APPLIED TO PRODUCTION"));
assert.ok(sql.includes("PREP ONLY"));
assert.ok(sql.includes("AgentEdge — resolve failing debrief freshness and intermittent email-sync health checks"));
assert.ok(sql.includes("Sarah Franks — resolve MasterClass room, schedule, and Facebook access follow-up"));
assert.ok(sql.includes("Maysa — provide current Rosen hotel confirmation for international travel"));
assert.ok(sql.includes("Rosen rooming corrections — confirm final application"));
assert.ok(sql.includes("Vietnam FAM — verify final balance and Good to Go before October 2"));
assert.ok(sql.includes("state='DONE'"));
assert.ok(sql.includes("message:1a0cf345628d6dc8"));
assert.ok(sql.includes("Would leave an obligation without provenance"));
assert.ok(sql.includes("Would create duplicate stable source refs"));
assert.ok(!sql.includes("send_email"));
assert.ok(!sql.includes("charge("));
console.log("PASS: final current-state reconciliation remains source-backed and approval-gated");
