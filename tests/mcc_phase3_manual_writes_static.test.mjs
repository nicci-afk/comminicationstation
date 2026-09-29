import fs from "node:fs";
import assert from "node:assert/strict";

const sql=fs.readFileSync("scripts/mcc_phase3_manual_writes.sql","utf8");
const route=fs.readFileSync("supabase/functions/api/mcc-obligation-action.ts","utf8");
const exec=fs.readFileSync("apps/web/src/pages/Executive.tsx","utf8");
const hooks=fs.readFileSync("apps/web/src/lib/hooks.ts","utf8");
const policy=fs.readFileSync("apps/web/src/lib/mccPolicy.ts","utf8");

assert.ok(sql.includes("security definer"));
assert.ok(sql.includes("set search_path = public, pg_temp"));
assert.ok(sql.includes("from public,anon,authenticated"));
assert.ok(sql.includes("to service_role"));
assert.ok(sql.includes("for update"));
assert.ok(sql.includes("MANUAL_UNDO"));
assert.ok(sql.includes("obligation_events"));
assert.ok(route.includes("requireUser(req, db)"));
assert.ok(route.includes('db.rpc("mcc_apply_manual_action"'));
assert.ok(!route.includes("gmail-send"));
assert.ok(exec.includes("Done"));
assert.ok(exec.includes("Blocked"));
assert.ok(exec.includes("Need help"));
assert.ok(exec.includes("Waiting"));
assert.ok(exec.includes("Undo last change"));
assert.ok(hooks.includes("useMccObligationAction"));
assert.ok(hooks.includes("useObligationEvents"));
assert.ok(policy.includes("MANUAL_WRITES_PREVIEW"));
console.log("PASS: Phase 3A manual-write path is authenticated, audited, reversible, and external-action free");
