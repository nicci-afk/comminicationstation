// Native PostgreSQL/Auth/PostgREST/Edge tests. No request can reach a live provider.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {boot,createUser,seed,save,approve,review,edge,rest,rpc,sql,quote,Session,blocked,locks,commandSQL,apiContext,anon} from './reply-native-helpers.mjs';
const evidence=process.env.REPLY_EVIDENCE,sessions=[];let owner,other;
const sendEvents=r=>r.data.__fixture_events.filter(e=>e.kind==='synthetic-send');
const newSession=async name=>{const s=await new Session(name).init();sessions.push(s);return s;};
await test('native reply trust boundary, dispatch, and interleavings',async t=>{try{
 await boot();owner=await createUser('reply-owner@example.invalid');other=await createUser('reply-other@example.invalid');
 fs.writeFileSync(process.env.REPLY_BROWSER_AUTH,JSON.stringify({owner,other}));
 await t.test('native RLS and ACLs deny all five internal tables and privileged RPC to anon/authenticated',async()=>{
  const tables=['reply_context_state','reply_fact_evidence','reply_checks','reply_approvals','reply_dispatches'];
  assert.equal(sql(`select bool_and(relrowsecurity) from pg_class where oid=any(array[${tables.map(x=>quote('public.'+x)+'::regclass').join(',')}]);`),'t');
  for(const token of [anon,owner.token,other.token]){
   for(const table of tables){const r=await rest('/rest/v1/'+table+'?select=*',{method:'GET',token});assert([401,403].includes(r.status),table+':'+r.status);}
   const r=await rest('/rest/v1/rpc/mcc_reply_command',{token,body:{p_actor:owner.id,p_operation:'SNAPSHOT',p_input:{draft_id:owner.id}}});assert([401,403].includes(r.status),JSON.stringify(r));
  }
  for(const role of ['anon','authenticated'])for(const table of tables)assert.equal(sql(`select has_table_privilege('${role}','public.${table}','select,insert,update,delete');`),'f');
 });
 await t.test('real Auth identity wins over actor fields; manual sentinel and foreign drafts cannot send',async()=>{
  const i=seed(owner.id);await save(i,owner.token);
  let r=await edge('reply-review',{operation:'SNAPSHOT',draft_id:i.draft,user_id:owner.id},other.token);assert.equal(r.status,409);
  r=await edge('reply-review',{operation:'SNAPSHOT',draft_id:i.draft},'invalid-token');assert.equal(r.status,401);
  for(const route of ['gmail-send','twilio-send']){r=await edge(route,{approval:'USER_CONFIRMED',body:'Bypass',channel:'sms'},owner.token);assert.equal(r.status,400);assert.equal(sendEvents(r).length,0);}
  const a=await approve(i,owner.token);r=await edge('gmail-send',{approval_id:a.approval_id,user_id:owner.id},other.token);assert.equal(r.status,409);assert.equal(sendEvents(r).length,0);
 });
 await t.test('missing evidence and forged passing result remain blocked in exact Edge handler',async()=>{
  const i=seed(owner.id);await save(i,owner.token,'It costs $9999.');
  const c=await review({operation:'CHECK',draft_id:i.draft,result:{status:'SOURCE_SUPPORTED_REQUIRES_REVIEW'},evidence:[{basis:'source_system'}]},owner.token);assert.equal(c.check.status,'BLOCKED');
  const r=await edge('reply-review',{operation:'APPROVE',check_id:c.check_id,snapshot_key:c.check.snapshotKey,review_key:c.check.reviewKey,coverage_reviewed:true},owner.token);assert.equal(r.status,409);
 });
 await t.test('explicit native body load verifies source identity, caches under CAS and invalidates context',async()=>{
  const i=seed(owner.id);sql(`update messages set body_text=null where id='${i.message}';`);const before=await save(i,owner.token);
  assert.equal(before.evidenceRead.complete,false);assert.equal((await review({operation:'CHECK',draft_id:i.draft},owner.token)).check.status,'BLOCKED');
  const denied=await edge('gmail-get-body',{message_id:i.message},other.token);assert.equal(denied.status,404);assert(!denied.data.__fixture_events.some(e=>e.kind==='synthetic-source-read'||e.kind==='synthetic-oauth'));
  const loaded=await edge('gmail-get-body',{message_id:i.message},owner.token);assert.equal(loaded.status,200,JSON.stringify(loaded));assert.equal(loaded.data.body,'The price is $1250.');assert.equal(loaded.data.__fixture_events.filter(e=>e.kind==='synthetic-source-read').length,1);
  const after=await review({operation:'SNAPSHOT',draft_id:i.draft},owner.token);assert.equal(after.evidenceRead.complete,true);assert(Number(after.evidenceRead.revision)>Number(before.evidenceRead.revision));await approve(i,owner.token);
 });
 for(const mode of ['source-mismatch','source-race'])await t.test(`native ${mode} cannot become cached evidence`,async()=>{
  const i=seed(owner.id);sql(`update messages set body_text=null where id='${i.message}';`);await save(i,owner.token);const r=await edge('gmail-get-body',{message_id:i.message},owner.token,mode);assert.equal(r.status,409,JSON.stringify(r));assert.equal(sql(`select body_text is null from messages where id='${i.message}';`),'t');assert.equal((await review({operation:'CHECK',draft_id:i.draft},owner.token)).check.status,'BLOCKED');
 });
 await t.test('current source excerpt, explicit review, and exact claim support a native price check',async()=>{
  const i=seed(owner.id);const quoteText='$1250';let state=await save(i,owner.token,'It costs $1250.',0,[{id:'p',kind:'price',start:9,end:14,quote:quoteText,factKey:'quote-price',value:'USD:125000',evidenceIds:[]}]);
  const source=state.sources[0];const e=await review({operation:'EVIDENCE',draft_id:i.draft,revision:1,message_id:source.id,source_hash:source.hash,kind:'price',fact_key:'quote-price',value:'USD:125000',start:source.text.indexOf(quoteText),end:source.text.indexOf(quoteText)+quoteText.length,excerpt:quoteText,valid_until:new Date(Date.now()+3600000).toISOString(),reviewed:true},owner.token);
  state=await save(i,owner.token,'It costs $1250.',1,[{id:'p',kind:'price',start:9,end:14,quote:quoteText,factKey:'quote-price',value:'USD:125000',evidenceIds:[e.evidence_id]}]);
  await approve(i,owner.token);assert.equal(state.draft.revision,2);
  const foreign=seed(other.id);const denied=await edge('reply-review',{operation:'EVIDENCE',draft_id:i.draft,revision:2,message_id:foreign.message,source_hash:source.hash,kind:'price',fact_key:'quote-price',value:'USD:125000',start:0,end:5,excerpt:'$1250',valid_until:new Date(Date.now()+3600000).toISOString(),reviewed:true},owner.token);assert.equal(denied.status,409);
 });
 await t.test('native conflicting evidence blocks; explicit later supersession resolves; revocation blocks again',async()=>{
  const i=seed(owner.id);let s=await save(i,owner.token,'It costs $1250.');
  const record=async(source,value,excerpt,supersedes=[])=>review({operation:'EVIDENCE',draft_id:i.draft,revision:s.draft.revision,message_id:source.id,source_hash:source.hash,kind:'price',fact_key:'native-price',value,start:source.text.indexOf(excerpt),end:source.text.indexOf(excerpt)+excerpt.length,excerpt,valid_until:new Date(Date.now()+3600000).toISOString(),reviewed:true,supersedes},owner.token);
  const first=await record(s.sources[0],'USD:125000','$1250');
  sql(`insert into messages(user_id,thread_id,contact_id,direction,channel,provider,gmail_account_id,provider_message_id,from_identifier,body_text,sent_at,subject) values('${owner.id}','${i.thread}','${i.contact}','inbound','email','gmail','${i.account}','later-${i.message}','${i.sender}','Updated price is $1500.',clock_timestamp()-interval '30 minutes','Quote');`);
  s=await review({operation:'SNAPSHOT',draft_id:i.draft},owner.token);const later=s.sources.find(x=>x.id!==i.message);
  const conflicting=await record(later,'USD:150000','$1500');
  s=await save(i,owner.token,'It costs $1250.',1,[{id:'p',kind:'price',start:9,end:14,quote:'$1250',factKey:'native-price',value:'USD:125000',evidenceIds:[first.evidence_id]}]);
  assert.equal((await review({operation:'CHECK',draft_id:i.draft},owner.token)).check.status,'BLOCKED');
  await review({operation:'REVOKE',draft_id:i.draft,revision:2,evidence_id:conflicting.evidence_id},owner.token);
  const replacement=await record(later,'USD:150000','$1500',[first.evidence_id]);
  s=await save(i,owner.token,'It costs $1500.',2,[{id:'p',kind:'price',start:9,end:14,quote:'$1500',factKey:'native-price',value:'USD:150000',evidenceIds:[replacement.evidence_id]}]);
  assert.equal((await review({operation:'CHECK',draft_id:i.draft},owner.token)).check.status,'SOURCE_SUPPORTED_REQUIRES_REVIEW');
  await review({operation:'REVOKE',draft_id:i.draft,revision:3,evidence_id:replacement.evidence_id},owner.token);
  assert.equal((await review({operation:'CHECK',draft_id:i.draft},owner.token)).check.status,'BLOCKED');
 });
 for(const channel of ['email','sms','whatsapp'])await t.test(`exact ${channel} Edge route freezes provider payload and concurrent replay sends once`,async()=>{
  const i=seed(owner.id,channel);await save(i,owner.token);const a=await approve(i,owner.token);const route=channel==='email'?'gmail-send':'twilio-send';
  const results=await Promise.all([edge(route,{approval_id:a.approval_id,channel,body:'FORGED BODY',to:'attacker@example.invalid'},owner.token),edge(route,{approval_id:a.approval_id,channel},owner.token)]);
  for(const r of results)assert.equal(r.status,200,JSON.stringify(r.data));
  const events=results.flatMap(sendEvents);assert.equal(events.length,1);const payload=channel==='email'?Buffer.from(events[0].body.raw,'base64url').toString():new URLSearchParams(events[0].body).get('Body');assert.match(payload,/Thank you\./);assert.doesNotMatch(payload,/FORGED/);
  const status=await review({operation:'STATUS',approval_id:a.approval_id},owner.token);assert.equal(status.status,'SENT');assert.equal(status.ingestion_pending,false,JSON.stringify(results));
  assert.equal(sql(`select count(*) from reply_dispatches where approval_id='${a.approval_id}';`),'1');
  assert.equal(sql(`select count(*) from messages where thread_id='${i.thread}' and direction='outbound';`),'1');
  if(channel==='email'&&process.env.REPLY_VARIANT==='cutover')assert(results.some(r=>r.data.__fixture_events.some(e=>e.path==='/rest/v1/rpc/ingest_email_message'&&e.caller==='api-gmail-fence-v1')));
  assert(results.every(r=>r.data.__fixture_events.every(e=>e.kind!=='blocked-egress')));
 });
 await t.test('default-off routes refuse dispatch before credentials and reservation',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);
  for(const route of ['gmail-send','twilio-send']){const r=await edge(route,{approval_id:a.approval_id,channel:'sms'},owner.token,'ok',true);assert.equal(r.status,503);assert.equal(sendEvents(r).length,0);assert(!r.data.__fixture_events.some(e=>e.path?.includes('secret')));}
  assert.equal(sql(`select count(*) from reply_dispatches where approval_id='${a.approval_id}';`),'0');
 });
 for(const mode of ['timeout','malformed'])await t.test(`${mode} provider outcome persists UNKNOWN and blocks all resend paths`,async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);const r=await edge('gmail-send',{approval_id:a.approval_id},owner.token,mode);assert.equal(r.data.status,'UNKNOWN');assert.equal(sendEvents(r).length,1);
  const replay=await edge('gmail-send',{approval_id:a.approval_id},owner.token);assert.equal(replay.data.status,'UNKNOWN');assert.equal(sendEvents(replay).length,0);
  await save(i,owner.token,'Changed after unknown.',1);const c=await review({operation:'CHECK',draft_id:i.draft},owner.token);const denied=await edge('reply-review',{operation:'APPROVE',check_id:c.check_id,snapshot_key:c.check.snapshotKey,review_key:c.check.reviewKey,coverage_reviewed:true},owner.token);assert.equal(denied.status,409);
  const next={...i,item:randomUUID(),draft:randomUUID()};sql(`update queue_items set state='responded' where id='${i.item}';insert into queue_items(id,user_id,thread_id,contact_id,business_id,channel,sender_identifier,title,last_inbound_message_id) values('${next.item}','${owner.id}','${i.thread}','${i.contact}','${i.business}','email','${i.sender}','New episode','${i.message}');`);
  await save(next,owner.token);const newer=await review({operation:'CHECK',draft_id:next.draft},owner.token);assert.equal(newer.check.status,'SOURCE_SUPPORTED_REQUIRES_REVIEW');const bypass=await edge('reply-review',{operation:'APPROVE',check_id:newer.check_id,snapshot_key:newer.check.snapshotKey,review_key:newer.check.reviewKey,coverage_reviewed:true},owner.token);assert.equal(bypass.status,409);assert.match(bypass.data.error,/pending or outcome unresolved/);
 });
 await t.test('known send plus failed ingestion stays SENT and is never repeated',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);const r=await edge('gmail-send',{approval_id:a.approval_id},owner.token,'ingest-fails');assert.equal(r.data.status,'SENT');assert.equal(r.data.ingestion_pending,true);assert.equal(sendEvents(r).length,1);assert.equal(sendEvents(await edge('gmail-send',{approval_id:a.approval_id},owner.token)).length,0);
 });
 await t.test('edited/reverted draft and changed source invalidate exact persisted approval',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);await save(i,owner.token,'Thank you!',1);await save(i,owner.token,'Thank you.',2);let r=await edge('gmail-send',{approval_id:a.approval_id},owner.token);assert.equal(r.status,409);assert.equal(sendEvents(r).length,0);
  const b=await approve(i,owner.token);sql(`update messages set body_text='Changed context' where id='${i.message}';`);r=await edge('gmail-send',{approval_id:b.approval_id},owner.token);assert.equal(r.status,409);assert.equal(sendEvents(r).length,0);
 });
 await t.test('post-send/new-inbound conversation uses only receipt-backed own outbound context',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token),sent=await edge('gmail-send',{approval_id:a.approval_id},owner.token);assert.equal(sent.data.status,'SENT');
  const outbound=JSON.parse(sql(`select row_to_json(x) from (select id,contact_id,provider_message_id from messages where thread_id='${i.thread}' and direction='outbound') x;`));assert.equal(outbound.contact_id,null);
  const loaded=await edge('gmail-get-body',{message_id:outbound.id},owner.token);assert.equal(loaded.status,200,JSON.stringify(loaded));assert.equal(loaded.data.body,'Thank you.');
  const next={...i,item:randomUUID(),draft:randomUUID(),message:randomUUID()};
  sql(`insert into messages(id,user_id,thread_id,contact_id,direction,channel,provider,gmail_account_id,provider_message_id,from_identifier,to_identifiers,body_text,sent_at,subject) values('${next.message}','${owner.id}','${i.thread}','${i.contact}','inbound','email','gmail','${i.account}','source-${next.message}','${i.sender}',array['${i.from}'],'Thank you for the update.',clock_timestamp(),'Next question');insert into queue_items(id,user_id,thread_id,contact_id,business_id,channel,sender_identifier,title,last_inbound_message_id) values('${next.item}','${owner.id}','${i.thread}','${i.contact}','${i.business}','email','${i.sender}','Next question','${next.message}');`);
  let state=await save(next,owner.token);assert.equal(state.evidenceRead.complete,true,JSON.stringify(state.evidenceRead));assert.equal(state.sources.find(m=>m.id===outbound.id).direction,'outbound');assert.equal(state.sources.find(m=>m.id===outbound.id).contactId,i.contact);await approve(next,owner.token);
  const original=sql(`select row_to_json(x) from (select from_identifier,to_identifiers,cc_identifiers,headers from messages where id='${outbound.id}') x;`);
  for(const assignment of ["to_identifiers=array['wrong@example.invalid']",`to_identifiers=array['${i.sender}','extra@example.invalid']`,"cc_identifiers=array['extra@example.invalid']",`headers='[{"name":"BCC","value":"extra@example.invalid"}]'`,"from_identifier='alias@example.invalid'"]){
   sql(`update messages set ${assignment} where id='${outbound.id}';`);state=await review({operation:'SNAPSHOT',draft_id:next.draft},owner.token);assert.equal(state.evidenceRead.complete,false);assert.equal(state.evidenceRead.unresolvedOutboundCount,1);assert(!state.sources.some(m=>m.id===outbound.id));
   sql(`update messages m set from_identifier=x.from_identifier,to_identifiers=x.to_identifiers,cc_identifiers=x.cc_identifiers,headers=x.headers from jsonb_populate_record(null::messages,${quote(original)}::jsonb) x where m.id='${outbound.id}';`);
  }
  sql(`update gmail_accounts set user_id='${other.id}' where id='${i.account}';`);const transferred=await edge('reply-review',{operation:'SNAPSHOT',draft_id:next.draft},owner.token);assert.equal(transferred.status,409);sql(`update gmail_accounts set user_id='${owner.id}' where id='${i.account}';`);
  sql(`insert into messages(user_id,thread_id,direction,channel,provider,gmail_account_id,provider_message_id,from_identifier,to_identifiers,body_text,sent_at) values('${owner.id}','${i.thread}','outbound','email','gmail','${i.account}','unverified-legacy','${i.from}',array['${i.sender}'],'Legacy outbound',clock_timestamp());`);
  state=await review({operation:'SNAPSHOT',draft_id:next.draft},owner.token);assert.equal(state.evidenceRead.complete,false);assert.equal(state.evidenceRead.unresolvedOutboundCount,1);assert.equal((await review({operation:'CHECK',draft_id:next.draft},owner.token)).check.status,'BLOCKED');
 });
 await t.test('source transaction precedes reservation, proven lock wait, stale approval cannot cross commit',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);const writer=await newSession('reply-writer'),reserver=await newSession('reply-reserver');
  await writer.run(`begin;${apiContext}update messages set body_text='Committed newer source' where id='${i.message}';`);
  const pending=reserver.run(`begin;${apiContext}${commandSQL(owner.id,'RESERVE',{approval_id:a.approval_id,channel:'email'})}commit;`).then(()=>null,e=>e);
  await blocked(reserver,writer);await writer.run('commit;');assert.match(String(await pending),/state changed/);writer.close();reserver.close();
  assert.equal(sql(`select count(*) from reply_dispatches where approval_id='${a.approval_id}';`),'0');
 });
 await t.test('reservation precedes source transaction, proven lock wait, final BEGIN rechecks',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);const reserve=await newSession('reply-reserve-held'),writer=await newSession('reply-source-held');
  const d=JSON.parse(await reserve.run(`begin;${apiContext}${commandSQL(owner.id,'RESERVE',{approval_id:a.approval_id,channel:'email'})}`));
  const pending=writer.run(`begin;${apiContext}update messages set body_text='Later committed source' where id='${i.message}';commit;`);await blocked(writer,reserve);await reserve.run('commit;');await pending;
  const begin=await rpc(owner.id,'BEGIN',{dispatch_id:d.dispatch_id,channel:'email'});assert.equal(begin.status,400);assert.match(begin.data.message,/state changed/);await rpc(owner.id,'CANCEL',{dispatch_id:d.dispatch_id});reserve.close();writer.close();
 });
 await t.test('two independent native transactions atomically consume one approval',async()=>{
  const i=seed(owner.id);await save(i,owner.token);const a=await approve(i,owner.token);const first=await newSession('reply-first-reserve'),second=await newSession('reply-second-reserve');
  const d=JSON.parse(await first.run(`begin;${apiContext}${commandSQL(owner.id,'RESERVE',{approval_id:a.approval_id,channel:'email'})}`));
  const pending=second.run(`begin;${apiContext}${commandSQL(owner.id,'RESERVE',{approval_id:a.approval_id,channel:'email'})}commit;`);await blocked(second,first);await first.run('commit;');const duplicate=JSON.parse(await pending);assert.equal(duplicate.dispatch_id,d.dispatch_id);assert.equal(duplicate.existing,true);first.close();second.close();
 });
 assert.equal(sql('select count(*) from cron.job;'),'0');assert.equal(sql('select count(*) from net.http_request_queue;'),'0');
 fs.writeFileSync(path.join(evidence,'native-versions.txt'),sql('select version();'));
 }finally{await Promise.all(sessions.map(s=>s.close()));fs.writeFileSync(path.join(evidence,'lock-observations.json'),JSON.stringify(locks,null,2)+'\n');}});
