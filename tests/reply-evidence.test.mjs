import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkReply, detectReplyRisks, prepareReplyApproval, reserveReplyDispatch } from '../supabase/functions/api/_shared/reply-evidence.ts';

const NOW = '2026-10-03T22:00:00Z';
const clone = structuredClone;
function fixture() {
  const scope = {userId:'user-a',clientId:'client-a',businessId:'business-a',contextId:'quote:Q123'};
  const text = 'The total is $1,250. We will deliver on October 20, 2026.';
  const quoteClaim = (id,kind,quote,factKey,value,evidenceIds) => ({id,kind,quote,start:text.indexOf(quote),end:text.indexOf(quote)+quote.length,factKey,value,evidenceIds});
  const claims = [
    quoteClaim('price','price','$1,250','quote:Q123:total','USD:125000',['e-price']),
    quoteClaim('date','date','October 20, 2026','quote:Q123:delivery-date','2026-10-20@America/New_York',['e-date']),
    quoteClaim('commitment','commitment','We will deliver','quote:Q123:delivery-commitment','seller:deliver',['e-commitment']),
  ];
  const evidence = claims.map(c=>({id:c.evidenceIds[0],scope:clone(scope),kind:c.kind,factKey:c.factKey,value:c.value,
    source:{id:'quote-Q123',revision:'3',locator:'https://example.invalid/quotes/Q123',occurredAt:'2026-10-03T20:00:00Z',excerpt:'Accepted quote Q123: USD 1250 total, delivery October 20, 2026.'},
    verification:{basis:'human_reviewed',verifiedBy:'user-a',verifiedAt:'2026-10-03T21:00:00Z'},
    validUntil:'2026-10-04T00:00:00Z',revoked:false,supersedes:[]}));
  return {draft:{id:'draft-1',revision:1,scope,queueItemId:'item-1',threadId:'thread-1',channel:'email',fromAccountId:'account-1',recipients:['client@example.invalid'],subject:'Quote Q123',text,updatedAt:'2026-10-03T21:30:00Z'},claims,evidence,
    evidenceRead:{complete:true,revision:'evidence-7',readAt:NOW}};
}
const codes = async (s, now=NOW) => (await checkReply(s,now)).issues.map(i=>i.code);
async function approval(s, overrides={}) {
  const check = await checkReply(s,NOW);
  return prepareReplyApproval({snapshot:s,actorId:'user-a',approvalId:'approval-1',now:NOW,
    coverageReview:{reviewKey:check.reviewKey,snapshotKey:check.snapshotKey,reviewedBy:'user-a',reviewedAt:NOW},...overrides});
}
// An adversarial-test adapter only. This Map is NOT a production persistence mechanism.
function storeFor(record, options={}) {
  const state={record:clone(record),used:false,consumes:0,requests:[]};
  return {state,
    async load(id,userId) { if(options.loadFailure) throw Error('storage down'); return state.record?.id === id && state.record.userId === userId ? clone(state.record) : null; },
    async consume(req) { if(options.consumeFailure) throw Error('storage down'); state.consumes++; state.requests.push(req);
      if(state.used || options.changedRevision) return null;
      state.used=true; return 'dispatch-1'; },
  };
}
async function reserve(s, store, overrides={}) { return reserveReplyDispatch({snapshot:s,actorId:'user-a',approvalId:'approval-1',now:NOW,store,...overrides}); }

test('reviewed same-context sources support claims with dates and links, never declare truth', async()=>{
  const r=await checkReply(fixture(),NOW);
  assert.equal(r.status,'SOURCE_SUPPORTED_REQUIRES_REVIEW');
  assert.deepEqual(r.issues,[]);
  assert.equal(r.claims.length,3);
  assert.equal(r.claims[0].citations[0].sourceDate,'2026-10-03T20:00:00Z');
  assert.equal(r.claims[0].citations[0].locator,'https://example.invalid/quotes/Q123');
  assert.match(r.disclaimer,/not a guarantee of truth/);
});
test('zero model calls, network, secret access, or provider sends in module',()=>{
  const code=fs.readFileSync(new URL('../supabase/functions/api/_shared/reply-evidence.ts',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\bfetch\s*\(|callAnthropic|callOpenAI|getUserSecret|serviceClient|console\./);
});
test('missing evidence and omitted citations block',async()=>{
  const s=fixture();s.evidence=[];
  assert.ok((await codes(s)).includes('UNSUPPORTED_CLAIM'));
  s.claims[0].evidenceIds=[];
  assert.ok((await codes(s)).includes('MISSING_EVIDENCE'));
});
for(const basis of ['model','text_match']) test(`${basis} with identical wording is not source authority`,async()=>{
  const s=fixture();s.evidence[0].verification.basis=basis;
  s.evidence[0].source.excerpt=s.draft.text;
  assert.ok((await codes(s)).includes('UNVERIFIED_EVIDENCE'));
  await assert.rejects(approval(s),/REPLY_NOT_APPROVABLE/);
});
test('uncited contradictory current source is not ignored',async()=>{
  const s=fixture(),e=clone(s.evidence[0]);e.id='e-conflict';e.value='USD:150000';s.evidence.push(e);
  assert.ok((await codes(s)).includes('CONFLICTING_EVIDENCE'));
});
test('newer timestamp alone does not resolve a contradiction',async()=>{
  const s=fixture(),e=clone(s.evidence[0]);e.id='e-new';e.value='USD:150000';e.source.occurredAt='2026-10-03T20:30:00Z';s.evidence.push(e);
  assert.ok((await codes(s)).includes('CONFLICTING_EVIDENCE'));
});
test('explicit valid supersession retires stale prior evidence, and requires the replacement citation',async()=>{
  const s=fixture(),e=clone(s.evidence[0]);e.id='e-new';e.source.revision='4';e.source.occurredAt='2026-10-03T21:15:00Z';e.verification.verifiedAt='2026-10-03T21:20:00Z';e.supersedes=['e-price'];s.evidence.push(e);
  s.evidence[0].validUntil='2026-10-03T21:30:00Z';
  assert.ok((await codes(s)).includes('SUPERSEDED_EVIDENCE'));
  s.claims[0].evidenceIds=['e-new'];
  assert.deepEqual(await codes(s),[]);
});
test('supersession cycles, other-fact supersession and nonexistent predecessors block',async()=>{
  for(const mutate of [
    s=>{s.evidence[0].supersedes=['e-price'];},
    s=>{s.evidence[0].supersedes=['e-date'];},
    s=>{s.evidence[0].supersedes=['not-found'];},
    s=>{s.evidence[0].supersedes=['e-date'];s.evidence[1].supersedes=['e-price'];},
  ]) { const s=fixture();mutate(s);assert.ok((await codes(s)).includes('INVALID_SUPERSESSION')); }
});
test('unverified replacement cannot suppress authoritative conflict',async()=>{
  const s=fixture(),e=clone(s.evidence[0]);e.id='bad';e.source.occurredAt='2026-10-03T21:15:00Z';e.verification.verifiedAt='2026-10-03T21:20:00Z';e.verification.basis='model';e.supersedes=['e-price'];s.evidence.push(e);
  assert.ok((await codes(s)).includes('INVALID_SUPERSESSION'));
});
for(const key of ['userId','clientId','businessId','contextId']) test(`foreign ${key} cannot support claims or leak source data`,async()=>{
  const s=fixture();s.evidence[0].scope[key]='foreign';s.evidence[0].source.excerpt='PRIVATE FOREIGN CONTENT';s.evidence[0].source.locator='https://foreign.invalid/private';
  const r=await checkReply(s,NOW);
  assert.ok(r.issues.some(i=>i.code==='FOREIGN_EVIDENCE'));
  assert.equal(r.claims[0].citations.length,0);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE FOREIGN CONTENT|foreign.invalid/);
});
test('expired evidence and exact expiration boundary block',async()=>{
  for(const validUntil of [NOW,'2026-10-03T21:59:59Z']) {const s=fixture();s.evidence[0].validUntil=validUntil;assert.ok((await codes(s)).includes('STALE_EVIDENCE'));}
});
test('missing, invalid or future metadata fails closed',async()=>{
  const mutations=[e=>e.validUntil='',e=>e.source.revision='',e=>e.source.locator='',e=>e.verification.verifiedBy='',e=>e.verification.verifiedAt='2026-10-04T00:00:00Z',e=>e.source.occurredAt='not-a-date',e=>e.source.occurredAt='2026-10-03T20:00:00'];
  for(const mutate of mutations){const s=fixture();mutate(s.evidence[0]);assert.ok((await codes(s)).includes('INVALID_EVIDENCE_METADATA'));}
});
test('revoked evidence cannot support or retire another record',async()=>{
  const s=fixture();s.evidence[0].revoked=true;assert.ok((await codes(s)).includes('REVOKED_EVIDENCE'));
});
test('duplicate evidence IDs block instead of last-wins selection',async()=>{
  const s=fixture();s.evidence.push(clone(s.evidence[0]));assert.ok((await codes(s)).includes('DUPLICATE_OR_INVALID_EVIDENCE_ID'));
});
test('mismatched fact keys and wrong claim kind cannot be cited',async()=>{
  const s=fixture();s.claims[0].evidenceIds=['e-date'];assert.ok((await codes(s)).includes('MISSING_OR_MISMATCHED_EVIDENCE'));
});
test('draft claims are exact spans; changed quote cannot retain evidence binding',async()=>{
  const s=fixture();s.claims[0].quote='$1,500';assert.ok((await codes(s)).includes('CLAIM_TEXT_CHANGED'));
});
test('all risk classes require matching explicit claim coverage',async()=>{
  for(const kind of ['price','date','commitment']) {const s=fixture();s.claims=s.claims.filter(c=>c.kind!==kind);assert.ok((await codes(s)).includes(`UNREVIEWED_${kind.toUpperCase()}`));}
});
test('basic common dates, currencies and commitments flagged without normalizing truth',()=>{
  const r=detectReplyRisks('Tomorrow we will pay USD 900, €40 and 100 dollars. The reservation is confirmed for 2026-11-20.');
  assert.ok(r.filter(x=>x.kind==='price').length===3);
  assert.ok(r.filter(x=>x.kind==='date').length===2);
  assert.ok(r.filter(x=>x.kind==='commitment').length===2);
});
test('complete fresh evidence read is mandatory even for zero detected risks',async()=>{
  const s=fixture();s.draft.text='Thank you.';s.claims=[];s.evidence=[];s.evidenceRead.complete=false;
  assert.ok((await codes(s)).includes('INCOMPLETE_EVIDENCE_READ'));
});
test('stale/future evidence reads and invalid clocks fail closed',async()=>{
  for(const readAt of ['2026-10-03T21:59:00Z','2026-10-03T22:00:01Z','invalid']) {const s=fixture();s.evidenceRead.readAt=readAt;assert.ok((await codes(s)).includes('STALE_EVIDENCE_READ'));}
  assert.ok((await codes(fixture(),'invalid')).includes('INVALID_CLOCK'));
});
test('fresh reread of unchanged evidence retains snapshot cache key; expiry is still checked',async()=>{
  const s=fixture(),a=await checkReply(s,NOW);s.evidenceRead.readAt='2026-10-03T22:00:30Z';
  assert.equal((await checkReply(s,'2026-10-03T22:00:30Z')).snapshotKey,a.snapshotKey);
  s.evidenceRead.readAt='2026-10-04T00:00:00Z';assert.ok((await codes(s,'2026-10-04T00:00:00Z')).includes('STALE_EVIDENCE'));
});
test('coverage review is required for semantic claims that heuristics may miss',async()=>{
  const s=fixture();s.draft.text='Delivery is assured.';s.claims=[];s.evidence=[];
  assert.deepEqual(detectReplyRisks(s.draft.text),[]); // documented limitation, never auto-approval
  await assert.rejects(approval(s,{coverageReview:{reviewKey:'',reviewedBy:'user-a',reviewedAt:NOW}}),/REPLY_NOT_APPROVABLE/);
});
test('wrong reviewer, stale review, edited review, and pre-draft review cannot approve',async()=>{
  const s=fixture(),r=await checkReply(s,NOW);
  for(const coverageReview of [
    {reviewKey:r.reviewKey,reviewedBy:'user-b',reviewedAt:NOW},
    {reviewKey:'old-key',reviewedBy:'user-a',reviewedAt:NOW},
    {reviewKey:r.reviewKey,reviewedBy:'user-a',reviewedAt:'2026-10-03T21:54:00Z'},
    {reviewKey:r.reviewKey,reviewedBy:'user-a',reviewedAt:'2026-10-03T21:00:00Z'},
  ]) await assert.rejects(approval(s,{coverageReview}),/REPLY_NOT_APPROVABLE/);
});
test('approval lifetime capped by evidence validity and five-minute policy',async()=>{
  const s=fixture();assert.equal((await approval(s)).expiresAt,'2026-10-03T22:05:00.000Z');
  s.evidence[0].validUntil='2026-10-03T22:00:10Z';assert.equal((await approval(s)).expiresAt,'2026-10-03T22:00:10.000Z');
});
test('valid persisted approval consumed once, replay denied',async()=>{
  const s=fixture(),store=storeFor(await approval(s));
  assert.equal((await reserve(s,store)).allowed,true);
  assert.equal((await reserve(s,store)).reason,'APPROVAL_USED_OR_STATE_CHANGED');
  assert.equal(store.state.requests[0].evidenceRevision,'evidence-7');
});
test('concurrent dispatch attempts reserve at most once with atomic adapter',async()=>{
  const s=fixture(),store=storeFor(await approval(s));
  const results=await Promise.all(Array.from({length:12},()=>reserve(s,store)));
  assert.equal(results.filter(r=>r.allowed).length,1);
});
for(const [name,mutate] of [
  ['draft text',s=>{s.draft.text+=' Thank you.';}],
  ['draft whitespace',s=>{s.draft.text+=' ';}],
  ['draft revision',s=>{s.draft.revision++;}],
  ['draft ID',s=>{s.draft.id='draft-2';}],
  ['recipient',s=>{s.draft.recipients=['other@example.invalid'];}],
  ['subject',s=>{s.draft.subject='different';}],
  ['thread',s=>{s.draft.threadId='thread-2';}],
  ['queue item',s=>{s.draft.queueItemId='item-2';}],
  ['account',s=>{s.draft.fromAccountId='account-2';}],
  ['channel',s=>{s.draft.channel='sms';}],
  ['evidence revision',s=>{s.evidenceRead.revision='evidence-8';}],
  ['source revision',s=>{s.evidence[0].source.revision='4';}],
  ['source content',s=>{s.evidence[0].source.excerpt+=' Additional conditions apply.';}],
  ['evidence source URL',s=>{s.evidence[0].source.locator='https://example.invalid/changed';}],
]) test(`editing ${name} invalidates exact prior approval`,async()=>{
  const s=fixture(),store=storeFor(await approval(s));mutate(s);
  assert.equal((await reserve(s,store)).allowed,false);assert.equal(store.state.consumes,0);
});
test('editing text and reverting still requires a new revision and approval',async()=>{
  const s=fixture(),store=storeFor(await approval(s));s.draft.revision+=2;
  assert.equal((await reserve(s,store)).allowed,false);
});
test('forged client USER_CONFIRMED literal or guessed approval ID cannot bypass stored lookup',async()=>{
  const s=fixture(),store=storeFor(null);
  assert.equal((await reserve(s,store,{approvalId:'USER_CONFIRMED'})).allowed,false);
  assert.equal((await reserve(s,store)).allowed,false);
});
test('foreign actor and stored record mismatches deny before consumption',async()=>{
  const s=fixture(),a=await approval(s);
  assert.equal((await reserve(s,storeFor(a),{actorId:'user-b'})).allowed,false);
  a.approvedBy='user-b';assert.equal((await reserve(s,storeFor(a))).allowed,false);
});
test('new conflicting evidence invalidates approval even before its five-minute expiry',async()=>{
  const s=fixture(),store=storeFor(await approval(s)),e=clone(s.evidence[0]);e.id='new';e.value='USD:130000';s.evidence.push(e);
  assert.equal((await reserve(s,store)).reason,'EVIDENCE_BLOCKED');assert.equal(store.state.consumes,0);
});
test('approval expires exactly at deadline; missing or excessive expiry rejects',async()=>{
  const s=fixture(),a=await approval(s);
  for(const expiresAt of [NOW,'invalid','2026-10-03T22:05:01Z']) {a.expiresAt=expiresAt;assert.equal((await reserve(s,storeFor(a))).allowed,false);}
});
test('atomic revision fence catches source update between check and dispatch reservation',async()=>{
  const s=fixture(),store=storeFor(await approval(s),{changedRevision:true});
  assert.equal((await reserve(s,store)).reason,'APPROVAL_USED_OR_STATE_CHANGED');
});
test('approval storage failure cannot enable sending',async()=>{
  const s=fixture(),a=await approval(s);
  for(const options of [{loadFailure:true},{consumeFailure:true}]) assert.equal((await reserve(s,storeFor(a,options))).reason,'APPROVAL_STORE_UNAVAILABLE');
});

test('unsafe source URLs do not become clickable citations',async()=>{
  for(const locator of ['javascript:alert(1)','data:text/html,test','http://insecure.invalid/','https://user:password@example.invalid/']) {
    const s=fixture();s.evidence[0].source.locator=locator;
    const r=await checkReply(s,NOW);
    assert.ok(r.issues.some(i=>i.code==='INVALID_EVIDENCE_METADATA'));
    assert.equal(r.claims[0].citations.length,0);
  }
});
test('caller mutation during async checking cannot change the checked dispatch payload',async()=>{
  const s=fixture(),store=storeFor(await approval(s));
  const pending=reserve(s,store);
  s.draft.text='MUTATED';s.draft.recipients=['attacker@example.invalid'];
  const r=await pending;
  assert.equal(r.allowed,true);assert.equal(r.dispatchId,'dispatch-1');
  assert.notEqual(store.state.requests[0].dispatchPayload.text,'MUTATED');
  assert.deepEqual(store.state.requests[0].dispatchPayload.recipients,['client@example.invalid']);
});
test('caller mutation during checking does not create mixed source and draft snapshots',async()=>{
  const s=fixture(),before=clone(s);const pending=checkReply(s,NOW);s.evidence[0].value='USD:9';s.draft.text='changed';
  assert.deepEqual(await pending,await checkReply(before,NOW));
});

test('human coverage review cannot approve sources that changed after review',async()=>{
  const s=fixture(),check=await checkReply(s,NOW);
  const coverageReview={reviewKey:check.reviewKey,snapshotKey:check.snapshotKey,reviewedBy:'user-a',reviewedAt:NOW};
  s.evidence[0].source.revision='changed-after-review';
  await assert.rejects(approval(s,{coverageReview}),/REPLY_NOT_APPROVABLE/);
});
test('a single broad claim cannot hide two detected prices',async()=>{
  const s=fixture();s.draft.text+=' Another charge is $9,999.';s.claims[0].start=0;s.claims[0].end=s.draft.text.length;s.claims[0].quote=s.draft.text;
  assert.ok((await codes(s)).includes('AMBIGUOUS_CLAIM_SPAN'));
});
