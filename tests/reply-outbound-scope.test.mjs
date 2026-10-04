import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,ids,shutdown} from './reply-fixture.mjs';import {checkReply} from '../supabase/functions/api/_shared/reply-evidence.ts';
const out='00000000-0000-4000-8000-000000000010';
async function check(f){const state=await f.command('SNAPSHOT',{draft_id:ids.draft});const now=new Date().toISOString();return checkReply({...state,evidenceRead:{...state.evidenceRead,readAt:now}},now);}
async function setup(receipt=true){const f=await fixture();let s=await f.command('SAVE',{queue_item_id:ids.item,draft_id:ids.draft,revision:0,text:'Thank you.',claims:[]});
 if(receipt){const result=await check(f),c=await f.command('CHECK',{draft_id:ids.draft,revision:1,state:s,result}),a=await f.command('APPROVE',{check_id:c.check_id,review_key:result.reviewKey,snapshot_key:result.snapshotKey,coverage_reviewed:true}),r=await f.command('RESERVE',{approval_id:a.approval_id,channel:'email'});await f.command('BEGIN',{dispatch_id:r.dispatch_id,channel:'email'});await f.command('FINISH',{dispatch_id:r.dispatch_id,status:'SENT',provider_id:'sent-fixture'});}
 await f.db.exec(`insert into messages(id,user_id,thread_id,contact_id,direction,channel,gmail_account_id,provider,provider_message_id,from_identifier,to_identifiers,cc_identifiers,headers,body_text,sent_at,subject) values('${out}','${ids.user}','${ids.thread}',null,'outbound','email','${ids.account}','gmail','sent-fixture','owner@example.invalid',array['client@example.invalid'],'{}','[]','Thank you.',clock_timestamp()-interval '1 second','Re: Quote');`);
 return f;
}
test('receipt-backed own outbound is scoped and can be recorded only as human-reviewed outbound evidence',async()=>{const f=await setup();try{let s=await f.command('SNAPSHOT',{draft_id:ids.draft});assert.equal(s.evidenceRead.complete,true);const source=s.sources.find(m=>m.id===out);assert.equal(source.contactId,ids.contact);assert.equal(source.direction,'outbound');const e=await f.command('EVIDENCE',{draft_id:ids.draft,revision:1,message_id:out,source_hash:source.hash,kind:'commitment',fact_key:'acknowledgement',value:'acknowledged',start:0,end:10,excerpt:'Thank you.',valid_until:new Date(Date.now()+600000).toISOString(),reviewed:true});s=e.state;assert.equal(s.evidence[0].source.direction,'outbound');assert.equal(s.evidence[0].verification.basis,'human_reviewed');}finally{await f.db.close();}});
test('legacy outbound without a trusted receipt is excluded and full-context approval remains blocked',async()=>{const f=await setup(false);try{const s=await f.command('SNAPSHOT',{draft_id:ids.draft});assert.equal(s.sources.some(m=>m.id===out),false);assert.equal(s.evidenceRead.complete,false);assert.equal(s.evidenceRead.unresolvedOutboundCount,1);assert.equal((await check(f)).status,'BLOCKED');}finally{await f.db.close();}});
for(const [name,assignment] of [
 ['wrong recipient',"to_identifiers=array['foreign@example.invalid']"],
 ['multiple recipients',"to_identifiers=array['client@example.invalid','foreign@example.invalid']"],
 ['extra CC',"cc_identifiers=array['foreign@example.invalid']"],
 ['extra BCC',`headers='[{"name":"Bcc","value":"foreign@example.invalid"}]'`],
 ['unverifiable recipient metadata',`headers='{"Bcc":"foreign@example.invalid"}'`],
 ['unverified alias',"from_identifier='alias@example.invalid'"],
 ['foreign client linkage',`contact_id='${ids.other}'`],
 ['foreign sending account',`gmail_account_id='${ids.other}'`],
])test(`outbound ${name} is not scoped by sharing a thread`,async()=>{const f=await setup();try{const before=await f.command('SNAPSHOT',{draft_id:ids.draft});await f.db.exec(`update messages set ${assignment} where id='${out}'`);const after=await f.command('SNAPSHOT',{draft_id:ids.draft});assert.equal(after.sources.some(m=>m.id===out),false);assert.equal(after.evidenceRead.complete,false);assert(Number(after.evidenceRead.revision)>Number(before.evidenceRead.revision));}finally{await f.db.close();}});
test('sending-account ownership transfer rejects snapshot even with old receipt',async()=>{const f=await setup();try{await f.db.exec(`update gmail_accounts set user_id='${ids.other}' where id='${ids.account}'`);await assert.rejects(f.command('SNAPSHOT',{draft_id:ids.draft}),/account not sendable/);}finally{await f.db.close();}});
test.after(shutdown);
