import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const reconcile=fs.readFileSync(new URL('../supabase/migrations/0022_live_schema_reconciliation.sql',import.meta.url),'utf8');
const phase1=fs.readFileSync(new URL('../supabase/migrations/0023_mcc_v2_phase1.sql',import.meta.url),'utf8');

function classify(o,now=new Date('2026-09-21T19:00:00Z')){
  if(['DONE','CANCELLED'].includes(o.state)) return null;
  const due=o.dueAt?new Date(o.dueAt):null;
  const follow=o.followUpAt?new Date(o.followUpAt):null;
  const ms24=86400000;
  const overdue=!!due&&due<now;
  const hard24=o.dueKind==='HARD'&&!!due&&due>=now&&due<=new Date(now.getTime()+ms24);
  const followDue=!!follow&&follow<=now;
  if(o.state==='WAITING'||o.executionOwner==='WAITING') return 'WAITING_ON_OTHERS';
  if(o.state==='BLOCKED'||o.hasOpenDependency) return 'BLOCKED';
  if(o.riskLevel==='RED'||overdue||hard24||(followDue&&o.executionOwner==='NICCI')||o.verificationState==='CONFLICT') return 'NEEDS_YOU_NOW';
  if(['NOW','TODAY'].includes(o.state)) return 'NEEDS_YOU_NOW';
  if(['CHATGPT','CHATGPT_PREP'].includes(o.executionOwner)) return 'CHATGPT_CAN_HANDLE';
  if(o.executionOwner==='NICCI') return 'NEXT';
  return 'SAFE_TO_DEFER';
}
const terminalValid=o=>o.state==='DONE'?!!o.completedAt&&!o.cancelledAt:o.state==='CANCELLED'?!!o.cancelledAt&&!o.completedAt:!o.completedAt&&!o.cancelledAt;
const waitingValid=o=>o.state!=='WAITING'||(typeof o.waitingOn==='string'&&o.waitingOn.trim().length>0);
const duePairValid=o=>(!o.dueAt&&!o.dueKind)||(!!o.dueAt&&!!o.dueKind);
function dedupe({stableId=false,hash=false,personProjectDue=false}) {
  if(stableId||hash) return 'AUTO_DEDUPE';
  if(personProjectDue) return 'CANDIDATE_MATCH';
  return 'NO_MATCH';
}

test('reconciliation is limited to verified current-behavior drift',()=>{
  assert.match(reconcile,/queue_items_active_thread/i);
  assert.match(reconcile,/recategorize_queue_item/i);
  assert.doesNotMatch(reconcile,/create\s+table/i);
  assert.doesNotMatch(reconcile,/alter\s+table/i);
});
test('reconciliation matches live split-clone predicate',()=>{
  assert.match(reconcile,/is_split_clone\s*=\s*false/i);
  assert.match(reconcile,/drop index if exists public\.queue_items_active_thread/i);
});
test('reconciliation matches live variable-sender exclusions',()=>{
  for(const x of ['amazon','walmart','samsclub']) assert.match(reconcile,new RegExp(`not like '%${x}%'`,'i'));
});
test('Phase 1 creates exactly the five MCC state tables',()=>{
  for(const t of ['projects','obligations','obligation_sources','obligation_dependencies','obligation_events'])
    assert.match(phase1,new RegExp(`create table public\\.${t}\\b`,'i'));
});
test('Phase 1 does not import/alter historical queue',()=>{
  assert.doesNotMatch(phase1,/insert\s+into\s+public\.obligations[\s\S]*select[\s\S]*public\.queue_items/i);
  assert.doesNotMatch(phase1,/alter\s+table\s+public\.queue_items/i);
});
test('terminal state semantics reject inconsistent timestamps',()=>{
  assert.equal(terminalValid({state:'DONE',completedAt:'x',cancelledAt:null}),true);
  assert.equal(terminalValid({state:'DONE',completedAt:null,cancelledAt:null}),false);
  assert.equal(terminalValid({state:'DONE',completedAt:'x',cancelledAt:'y'}),false);
  assert.equal(terminalValid({state:'CANCELLED',completedAt:null,cancelledAt:'x'}),true);
  assert.equal(terminalValid({state:'UPCOMING',completedAt:'x',cancelledAt:null}),false);
});
test('WAITING requires nonblank trimmed waiting_on',()=>{
  for(const x of [null,'','   ']) assert.equal(waitingValid({state:'WAITING',waitingOn:x}),false);
  assert.equal(waitingValid({state:'WAITING',waitingOn:'Lois'}),true);
});
test('due_at and due_kind are paired',()=>{
  assert.equal(duePairValid({dueAt:null,dueKind:null}),true);
  assert.equal(duePairValid({dueAt:'2026-09-22',dueKind:'HARD'}),true);
  assert.equal(duePairValid({dueAt:'2026-09-22',dueKind:null}),false);
});
test('actual hard deadline makes UPCOMING actionable now',()=>{
  assert.equal(classify({state:'UPCOMING',executionOwner:'NICCI',riskLevel:'GREEN',verificationState:'VERIFIED',dueKind:'HARD',dueAt:'2026-09-22T02:00:00Z'}),'NEEDS_YOU_NOW');
});
test('unresolved dependency remains BLOCKED despite urgency',()=>{
  assert.equal(classify({state:'UPCOMING',executionOwner:'NICCI',riskLevel:'GREEN',verificationState:'VERIFIED',dueKind:'HARD',dueAt:'2026-09-22T02:00:00Z',hasOpenDependency:true}),'BLOCKED');
});
test('dedupe is exact-only and fuzzy key is candidate-only',()=>{
  assert.equal(dedupe({stableId:true}),'AUTO_DEDUPE');
  assert.equal(dedupe({hash:true}),'AUTO_DEDUPE');
  assert.equal(dedupe({personProjectDue:true}),'CANDIDATE_MATCH');
});
test('claim-scoped authority replaces blanket authority',()=>{
  assert.match(phase1,/claim_scope text\[\]/i);
  assert.match(phase1,/authoritative_claims <@ claim_scope/i);
  assert.doesNotMatch(phase1,/is_authoritative\s+boolean/i);
});
test('project health provenance is explicit',()=>{
  assert.match(phase1,/health_method text not null/i);
  assert.match(phase1,/health_reason text not null/i);
  assert.match(phase1,/projects_derived_health_provenance/i);
});
test('RLS and application read-only privileges are explicit',()=>{
  for(const t of ['projects','obligations','obligation_sources','obligation_dependencies','obligation_events'])
    assert.match(phase1,new RegExp(`alter table public\\.${t} enable row level security`,'i'));
  assert.match(phase1,/grant select on table[\s\S]*to authenticated/i);
  assert.doesNotMatch(phase1,/grant\s+(insert|update|delete|all)[\s\S]*to authenticated/i);
});
test('mcc_today is security_invoker with explicit access control',()=>{
  assert.match(phase1,/create view public\.mcc_today\s+with \(security_invoker=true\)/i);
  assert.match(phase1,/revoke all on public\.mcc_today from public,anon,authenticated/i);
  assert.match(phase1,/grant select on public\.mcc_today to authenticated/i);
});
