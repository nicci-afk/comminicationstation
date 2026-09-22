import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const app = read("apps/web/src/App.tsx");
const executive = read("apps/web/src/pages/Executive.tsx");
const item = read("apps/web/src/pages/ItemDetail.tsx");
const policy = read("apps/web/src/lib/mccPolicy.ts");
const prompts = read("supabase/functions/api/_shared/prompts.ts");
const draft = read("supabase/functions/api/draft-reply.ts");
const gmail = read("supabase/functions/api/gmail-send.ts");
const twilio = read("supabase/functions/api/twilio-send.ts");
const hooks = read("apps/web/src/lib/hooks.ts");

const checks = [
  ["Executive route is parallel, not a Today replacement", app.includes('path="/executive"') && app.includes('path="/today"')],
  ["Executive UI is read-only preview", policy.includes('executiveUiMode: "READ_ONLY_PREVIEW"')],
  ["External communication policy is manual-send-only", policy.includes('externalCommunication: "MANUAL_SEND_ONLY"')],
  ["Executive empty state does not claim work is complete", executive.includes("No MCC obligations have been seeded yet") && executive.includes("different from “everything is done.”")],
  ["Executive view surfaces verification", executive.includes("verification_state") && executive.includes("Show evidence")],
  ["Executive view surfaces deterministic why-now reasons", executive.includes("Why now") && executive.includes("priority_reasons")],
  ["Executive view includes Focus mode", executive.includes("Focus mode") && executive.includes("WAITING_ON_OTHERS")],
  ["MCC hooks are read-only queries", hooks.includes('.from("mcc_today")') && hooks.includes('.from("obligation_sources")') && !hooks.includes('.from("obligations").insert')],
  ["Draft prompt preserves unknowns", prompts.includes("Absence of evidence is UNKNOWN")],
  ["Draft prompt forbids consequential fabrication", prompts.includes("Never invent or assume pricing, dates, availability")],
  ["Draft response exposes verification requirements", draft.includes("verification_needed") && draft.includes('approval_state: "DRAFT_ONLY"')],
  ["Draft UI labels output as draft-only", item.includes("Draft only · review before sending")],
  ["Draft UI surfaces verification-before-send list", item.includes("Verify before sending")],
  ["Gmail send requires explicit manual approval", gmail.includes('approval !== "USER_CONFIRMED"')],
  ["Twilio send requires explicit manual approval", twilio.includes('body.approval !== "USER_CONFIRMED"')],
  ["Manual UI is the code path that supplies approval", (item.match(/approval: "USER_CONFIRMED"/g) ?? []).length === 2],
];

let passed = 0;
for (const [name, ok] of checks) {
  if (!ok) {
    console.error(`FAIL: ${name}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${name}`);
    passed += 1;
  }
}

console.log(`${passed}/${checks.length} Phase 1.5 static checks passed`);
if (passed !== checks.length) process.exit(1);
