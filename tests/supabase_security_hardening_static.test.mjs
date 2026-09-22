import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root=process.cwd();
const sql=fs.readFileSync(path.join(root,"scripts/supabase_security_hardening_draft.sql"),"utf8");
const plan=fs.readFileSync(path.join(root,"docs/SUPABASE_SECURITY_HARDENING_PLAN.md"),"utf8");

const triggerOnly=[
  "auto_expense_split()",
  "handle_new_user()",
  "log_queue_transition()",
];

const userRpcs=[
  "backlog_sweep_sender(text, boolean)",
  "get_jobs_health()",
  "recategorize_queue_item(uuid, text, uuid)",
  "set_user_secret(text, text)",
  "split_queue_item_for_businesses(uuid, uuid[], text, text, uuid[])",
];

for (const fn of triggerOnly) {
  assert.ok(sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), "missing trigger revoke for "+fn);
  assert.ok(!sql.includes(`grant execute on function public.${fn} to authenticated;`), "trigger function must not be granted to authenticated: "+fn);
}

for (const fn of userRpcs) {
  assert.ok(sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`), "missing rpc revoke for "+fn);
  assert.ok(sql.includes(`grant execute on function public.${fn} to authenticated;`), "missing authenticated grant for "+fn);
}

assert.ok(sql.includes("begin;") && sql.includes("commit;"), "hardening draft must be transactional");
assert.ok(sql.includes("Expected trigger trg_auto_expense_split is missing"), "missing trigger fail-closed assertion");
assert.ok(plan.includes("PREPARED — NOT APPLIED TO PRODUCTION"), "plan must clearly state non-production status");
assert.ok(plan.includes("do not add permissive policies merely to silence the advisor"), "RLS fail-closed decision missing");

console.log("PASS: Supabase security hardening draft is narrowly scoped and fail-closed");
