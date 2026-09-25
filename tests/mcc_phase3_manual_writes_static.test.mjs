import fs from "node:fs";
import assert from "node:assert/strict";

const sql = fs.readFileSync("scripts/mcc_phase3_manual_writes_draft.sql", "utf8");
const doc = fs.readFileSync("docs/MCC_PHASE3_MANUAL_WRITES.md", "utf8");
const executive = fs.readFileSync("apps/web/src/pages/Executive.tsx", "utf8");
const hooks = fs.readFileSync("apps/web/src/lib/hooks.ts", "utf8");
const policy = fs.readFileSync("apps/web/src/lib/mccPolicy.ts", "utf8");

assert.ok(doc.includes("NOT DEPLOYED / NOT APPLIED TO PRODUCTION"));
assert.ok(sql.includes("DRAFT ONLY"));
assert.ok(sql.includes("create schema if not exists private"));
assert.ok(sql.includes("security definer"));
assert.ok(sql.includes("revoke all on function private.mcc_audit_obligation_manual_update()"));
assert.ok(sql.includes("grant update (state,execution_owner,blocked_reason,completed_at,updated_at)"));
assert.ok(sql.includes("for update"));
assert.ok(sql.includes("using ((select auth.uid()) = user_id)"));
assert.ok(sql.includes("with check ((select auth.uid()) = user_id)"));
assert.ok(sql.includes("revoke insert, update, delete on public.obligation_events"));
assert.ok(!sql.includes("grant insert on public.obligation_events"));
assert.ok(!sql.includes("service_role"));
assert.ok(executive.includes("Mark done"));
assert.ok(executive.includes("Need help"));
assert.ok(executive.includes("Block"));
assert.ok(executive.includes("Undo"));
assert.ok(hooks.includes("useObligationAction"));
assert.ok(hooks.includes("useObligationEvents"));
assert.ok(policy.includes('executiveUiMode: "MANUAL_WRITES_PREVIEW"'));
console.log("PASS: MCC Phase 3 manual writes remain least-privilege, audited, and preview-only");
