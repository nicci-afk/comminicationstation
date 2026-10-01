import assert from "node:assert/strict";
import { focusEligible, selectFocus, dailyItems } from "../apps/web/src/lib/mccWorkflow.ts";
import type { MccTodayItem } from "../apps/web/src/lib/types.ts";
const base = { obligation_id: "1", section: "NEXT", execution_owner: "NICCI", state: "TODAY", verification_state: "VERIFIED", next_action: "Call supplier", has_open_dependency: false, is_stale: false, critical_attention: false } as MccTodayItem;
assert.equal(selectFocus([base]), base);
for (const override of [
  {state:"BLOCKED"}, {state:"WAITING"}, {state:"SOMEDAY"}, {state:"DONE"}, {state:"CANCELLED"},
  {has_open_dependency:true}, {is_stale:true}, {verification_state:"CONFLICT"}, {verification_state:"UNVERIFIED"},
  {execution_owner:"CHATGPT_PREP"}, {execution_owner:"OTHER"}, {next_action:" "}, {section:"SAFE_TO_DEFER"}
]) assert.equal(focusEligible({...base,...override} as MccTodayItem),false,JSON.stringify(override));
const conflict={...base,verification_state:"CONFLICT",section:"NEEDS_YOU_NOW"} as MccTodayItem;
assert.equal(selectFocus([conflict,base]),base);
assert.equal(selectFocus([]),null);
const rows=Array.from({length:12},(_,i)=>({...base,obligation_id:String(i)}));
assert.equal(dailyItems(rows).length,5);
rows[11].critical_attention=true;
assert.equal(dailyItems(rows).length,6);
assert.equal(dailyItems(rows,true).length,12);
console.log("PASS: Focus eligibility and daily visibility (21 assertions)");
