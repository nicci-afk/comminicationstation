import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
export const A='00000000-0000-4000-8000-000000000001';
export const B='00000000-0000-4000-8000-000000000002';
export const M='00000000-0000-4000-8000-000000000011';
export const N='00000000-0000-4000-8000-000000000012';
export const O='00000000-0000-4000-8000-000000000013';
export const H='a'.repeat(64), MODEL='claude-haiku-4-5-20251001';
export const DECISION={business_id:null,category:'fyi',needs_reply:false,contact_kind:'human',priority:25,reason:'Synthetic fixture'};
export const file=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
export async function fixture() {
  const db=new PGlite();
  const q=async(sql,p=[]) => (await db.query(sql,p)).rows;
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.profiles(user_id uuid primary key);
    create table public.messages(id uuid primary key,user_id uuid not null,from_name text,
      from_identifier text,to_identifiers jsonb,subject text,snippet text,headers jsonb,channel text);
    create table public.businesses(id uuid primary key,user_id uuid,name text);
    create table public.app_config(key text primary key,value jsonb not null);
    create table public.application_events(message_id uuid,decision jsonb);
    create function public.apply_model_triage(p_message_id uuid,p jsonb) returns void language plpgsql as $$
    begin
      if p->>'reason'='fail application' then raise exception 'application failed'; end if;
      insert into public.application_events values(p_message_id,p);
    end;$$;`);
  // Actual baseline caps and ledger definitions/constraints (only tenancy stubbed).
  const core=file('../supabase/migrations/0001_core.sql');
  await db.exec(core.slice(core.indexOf('create table public.spend_caps ('),core.indexOf('-- Household-level configuration')));
  // Deliberately broad global installer defaults must not leak into new objects.
  await db.exec('alter default privileges grant all on tables to anon,authenticated,service_role; alter default privileges grant all on functions to anon,authenticated,service_role;');
  await db.exec(file('../supabase/migrations/20261004030453_triage_cost_reservations_v1.sql'));
  const policy=(overrides={})=>({status:'verified',kind:'anthropic_standard_messages_v1',currency:'USD',
    version:'synthetic-test-only',reviewed_by:'fixture',source_url:'https://example.invalid/synthetic',model:MODEL,
    input_usd_per_million:1,output_usd_per_million:5,max_billable_input_tokens:1000,max_output_tokens:400,
    verified_at:new Date(Date.now()-60000).toISOString(),valid_until:new Date(Date.now()+3600000).toISOString(),...overrides});
  const setPolicy=async p=>q(`insert into public.app_config values('mcc_triage_cost_policy_v1',$1)
    on conflict(key) do update set value=excluded.value`,[p]);
  const source=async(user=A,message=M)=>(await q('select mcc_cost_internal.triage_source_v1($1,$2) as source',[user,message]))[0].source;
  const call=async(name,args,role='service_role')=>db.transaction(async tx=>{
    await tx.exec(`set local role ${role}`);
    const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');
    return (await tx.query(`select public.${name}(${placeholders}) as result`,args)).rows[0].result;
  });
  const reserve=async({user=A,message=M,hash=H,context,role}={})=>call('reserve_triage_cost_v1',[user,message,hash,context??await source(user,message)],role);
  const settle=async(token,{user=A,message=M,hash=H,model=MODEL,tokensIn=100,tokensOut=20,decision=DECISION}={})=>
    call('settle_triage_cost_v1',[user,message,hash,token,model,tokensIn,tokensOut,decision]);
  const apply=async({user=A,message=M,hash=H}={})=>call('apply_budgeted_triage_v1',[user,message,hash]);
  const reset=async()=>{
    await db.exec(`truncate public.application_events,mcc_cost_internal.triage_tasks,public.ai_spend_ledger,
      public.spend_caps,public.messages,public.businesses,public.app_config,public.profiles cascade;`);
    await q('insert into public.profiles values($1),($2)',[A,B]);
    await q('insert into public.spend_caps(user_id,monthly_cap_usd,triage_daily_call_cap) values($1,1,10),($2,1,10)',[A,B]);
    await q(`insert into public.messages values($1,$4,'Fixture','sender@example.invalid','[]','Subject','Snippet','{}','email'),
      ($2,$4,'Fixture','sender@example.invalid','[]','Subject','Snippet','{}','email'),
      ($3,$5,'Fixture','sender@example.invalid','[]','Subject','Snippet','{}','email')`,[M,N,O,A,B]);
    await setPolicy(policy());
  };
  await reset();
  return {db,q,policy,setPolicy,source,call,reserve,settle,apply,reset};
}
