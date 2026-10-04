import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
export const ids={user:'00000000-0000-4000-8000-000000000001',other:'00000000-0000-4000-8000-000000000002',business:'00000000-0000-4000-8000-000000000003',contact:'00000000-0000-4000-8000-000000000004',account:'00000000-0000-4000-8000-000000000005',thread:'00000000-0000-4000-8000-000000000006',item:'00000000-0000-4000-8000-000000000007',message:'00000000-0000-4000-8000-000000000008',draft:'00000000-0000-4000-8000-000000000009'};
let shared;
export async function shutdown(){if(shared)await shared.close();shared=null;}
export async function fixture(){
 shared??=new PGlite();const raw=shared;await raw.exec('reset role;drop schema if exists public cascade;create schema public;drop schema if exists auth cascade;drop role if exists anon;drop role if exists authenticated;drop role if exists service_role;');
 const db={exec:raw.exec.bind(raw),query:raw.query.bind(raw),close:async()=>{}};await db.exec(fs.readFileSync('tests/fixtures/reply-domain.sql','utf8'));
 const i=ids;
 await db.exec(`insert into profiles values('${i.user}'),('${i.other}');insert into businesses values('${i.business}','${i.user}');insert into contacts values('${i.contact}','${i.user}');insert into gmail_accounts values('${i.account}','${i.user}','owner@example.invalid','active',true,null);insert into threads values('${i.thread}','${i.user}','email','${i.account}',null,'provider-thread');insert into queue_items values('${i.item}','${i.user}','${i.thread}','${i.contact}','${i.business}','email','client@example.invalid','Quote');insert into messages(id,user_id,thread_id,contact_id,direction,channel,from_identifier,body_text,sent_at,subject,rfc822_message_id) values('${i.message}','${i.user}','${i.thread}','${i.contact}','inbound','email','client@example.invalid','The price is $1250.',now()-interval '1 hour','Quote','<source@example.invalid>');update messages set gmail_account_id='${i.account}';`);
 await db.exec(fs.readFileSync('scripts/mcc_reply_evidence_integration.sql','utf8'));
 await db.exec('set role service_role');
 const command=async(op,input,actor=i.user)=>(await db.query('select public.mcc_reply_command($1,$2,$3::jsonb) as result',[actor,op,JSON.stringify(input)])).rows[0].result;
 return {db,command};
}
