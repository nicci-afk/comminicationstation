import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const migration = read("supabase/migrations/0024_mcc_safety_layer.sql");
const app = read("apps/web/src/App.tsx");
const hooks = read("apps/web/src/lib/hooks.ts");
const trust = read("apps/web/src/pages/TrustCenter.tsx");
const constitution = read("docs/PROJECT_SAFETY_CONSTITUTION.md");
const checklist = read("docs/PRODUCTION_CHANGE_CHECKLIST.md");

const checks = [
  ["Safety controls default fail-closed", migration.includes("emergency_stop boolean not null default true")],
  ["Automated database writes default off", migration.includes("automation_database_writes_enabled boolean not null default false")],
  ["External sends default off", migration.includes("automation_external_sends_enabled boolean not null default false")],
  ["Booking changes default off", migration.includes("automation_booking_changes_enabled boolean not null default false")],
  ["Financial actions default off", migration.includes("automation_financial_actions_enabled boolean not null default false")],
  ["Safety tables have RLS", migration.includes("alter table public.mcc_safety_controls enable row level security") && migration.includes("alter table public.production_change_receipts enable row level security")],
  ["Browser only receives SELECT on safety tables", migration.includes("grant select on table public.mcc_safety_controls, public.production_change_receipts") && !migration.includes("grant insert") && !migration.includes("grant update")],
  ["Integrity view detects missing provenance", migration.includes("obligations_without_sources")],
  ["Integrity view detects duplicate source refs", migration.includes("duplicate_source_refs")],
  ["Trust Center route exists", app.includes('path="/trust"')],
  ["Trust Center is read-only", trust.includes("intentionally read-only") && !trust.includes(".insert(") && !trust.includes(".update(")],
  ["Hooks only SELECT safety state", hooks.includes('.from("mcc_integrity_status")') && hooks.includes('.from("production_change_receipts")')],
  ["Constitution requires fail-closed behavior", constitution.includes("Fail closed") && constitution.includes("Read-only is the default")],
  ["Production checklist requires post-change verification", checklist.includes("Post-change verification")],
];

let passed=0;
for (const [name,ok] of checks) {
  assert.equal(ok,true,"FAIL: " + name);
  console.log("PASS: " + name);
  passed++;
}
console.log(passed + "/" + checks.length + " safety-layer static checks passed");
