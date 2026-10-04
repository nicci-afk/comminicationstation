import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,A,B,M,N,O,H,MODEL,DECISION } from './cost-fixture.mjs';
const f=await fixture();
const count=async table=>(await f.q(`select count(*)::int n from ${table}`))[0].n;
await test('exact triage reservation migration, local PostgreSQL engine',async t=>{
  const scenario=async(name,fn)=>t.test(name,async()=>{await f.reset(); await fn();});
  await scenario('verified bounded policy reserves full input ceiling plus output ceiling',async()=>{
    const r=await f.reserve();assert.equal(r.status,'reserved');assert.equal(r.reserved_usd,0.003);assert.equal(r.model,MODEL);
  });
  await scenario('missing policy blocks without creating an attempt',async()=>{
    await f.q('delete from public.app_config');assert.match((await f.reserve()).reason,/missing/);assert.equal(await count('mcc_cost_internal.triage_tasks'),0);
  });
  for(const [key,value] of [['status','draft'],['input_usd_per_million',-1],['input_usd_per_million','1'],
    ['output_usd_per_million',null],['max_billable_input_tokens',0],['max_billable_input_tokens','1000'],['max_output_tokens','400'],['max_billable_input_tokens',1.5],
    ['max_billable_input_tokens',999999999999],['max_output_tokens',401],['currency','EUR'],['model','claude-haiku-4-5'],
    ['verified_at','infinity'],['valid_until','infinity'],['valid_until','broken'],['valid_until','2000-01-01T00:00:00Z'],
    ['verified_at','2999-01-01T00:00:00Z'],['source_url',''],['reviewed_by','']]) {
    await scenario(`malformed/unverified policy ${key}=${value} is denied`,async()=>{
      await f.setPolicy(f.policy({[key]:value}));assert.equal((await f.reserve()).status,'blocked');assert.equal(await count('mcc_cost_internal.triage_tasks'),0);
    });
  }
  await scenario('missing caps are fail closed',async()=>{await f.q('delete from public.spend_caps');assert.match((await f.reserve()).reason,/caps/);});
  await scenario('negative and NaN caps fail closed',async()=>{
    for(const cap of ['-1','NaN']) {await f.q('update public.spend_caps set monthly_cap_usd=$1',[cap]);assert.match((await f.reserve()).reason,/invalid spend/);}
  });
  await scenario('foreign message is denied even to trusted service caller',async()=>{assert.match((await f.reserve({message:O})).reason,/ownership/);});
  await scenario('stale message source and missing source fail closed',async()=>{
    const s=await f.source();await f.q("update public.messages set snippet='changed' where id=$1",[M]);assert.match((await f.reserve({context:s})).reason,/source/);
    assert.equal((await f.call('reserve_triage_cost_v1',[A,M,H,null])).status,'blocked');
  });
  await scenario('fresh tenant-scoped business context excludes another tenant',async()=>{
    await f.q('insert into public.businesses values($1,$2,$3)',[N,B,'Foreign']);assert.deepEqual((await f.source()).businesses,[]);
  });
  await scenario('second task cannot consume held monthly budget',async()=>{
    await f.q('update public.spend_caps set monthly_cap_usd=.005 where user_id=$1',[A]);
    assert.equal((await f.reserve()).status,'reserved');assert.match((await f.reserve({message:N})).reason,/monthly cap/);
  });
  await scenario('existing ledger spend participates in monthly admission',async()=>{
    await f.q(`insert into public.ai_spend_ledger(user_id,provider,model,purpose,cost_usd) values($1,'fixture','fixture','draft',.999)`,[A]);
    assert.match((await f.reserve()).reason,/monthly cap/);
  });
  await scenario('historical paid record prevents blind paid migration replay',async()=>{
    await f.q(`insert into public.ai_spend_ledger(user_id,provider,model,purpose,cost_usd,ref_type,ref_id)
      values($1,'fixture','fixture','triage',.001,'message',$2)`,[A,M]);
    assert.match((await f.reserve()).reason,/legacy paid task/);assert.equal(await count('mcc_cost_internal.triage_tasks'),0);
  });
  await scenario('invalid historical ledger cost blocks instead of crediting budget',async()=>{
    await f.q(`insert into public.ai_spend_ledger(user_id,provider,model,purpose,cost_usd) values($1,'fixture','fixture','draft',-1)`,[A]);
    assert.match((await f.reserve()).reason,/ledger/);
  });
  await scenario('held daily call slot prevents concurrent new task',async()=>{
    await f.q('update public.spend_caps set triage_daily_call_cap=1 where user_id=$1',[A]);await f.reserve();assert.match((await f.reserve({message:N})).reason,/daily cap/);
  });
  await scenario('same tenant and message never get a second token',async()=>{
    await f.reserve();const r=await f.reserve();assert.match(r.reason,/existing reserved/);assert.equal(r.token,undefined);assert.equal(await count('mcc_cost_internal.triage_tasks'),1);
  });
  await scenario('changed request/version for task is conflict',async()=>{await f.reserve();assert.match((await f.reserve({hash:'b'.repeat(64)})).reason,/conflict/);});
  await scenario('unknown outcome keeps funds and daily slot across rollover',async()=>{
    await f.q('update public.spend_caps set monthly_cap_usd=.005 where user_id=$1',[A]);const r=await f.reserve();
    await f.call('mark_triage_unknown_v1',[A,M,H,r.token]);await f.q("update mcc_cost_internal.triage_tasks set created_at='2000-01-01'");
    assert.match((await f.reserve()).reason,/unknown/);assert.match((await f.reserve({message:N})).reason,/monthly cap/);
  });
  await scenario('settlement atomically replaces hold with exactly one ledger record',async()=>{
    const r=await f.reserve();assert.equal((await f.settle(r.token)).status,'ready');assert.equal((await f.settle(r.token)).status,'ready');
    assert.equal(await count('public.ai_spend_ledger'),1);assert.equal(Number((await f.q('select cost_usd from public.ai_spend_ledger'))[0].cost_usd),0.0002);
    assert.equal((await f.reserve()).status,'ready');
  });
  await scenario('settlement replay cannot mutate billed outcome',async()=>{const r=await f.reserve();await f.settle(r.token);await assert.rejects(f.settle(r.token,{tokensOut:21}),/conflict/);assert.equal(await count('public.ai_spend_ledger'),1);});
  await scenario('foreign tenant and wrong attempt token cannot settle',async()=>{
    const r=await f.reserve();await assert.rejects(f.settle(r.token,{user:B}),/identity/);await assert.rejects(f.settle(B),/identity/);assert.equal(await count('public.ai_spend_ledger'),0);
  });
  await scenario('unexpected model and absent usage remain held as unknown',async()=>{
    const r=await f.reserve();assert.equal((await f.settle(r.token,{model:'different'})).status,'blocked');assert.match((await f.reserve()).reason,/unknown/);assert.equal(await count('public.ai_spend_ledger'),0);
  });
  await scenario('malformed output still records observed billed usage and never retries',async()=>{
    const r=await f.reserve();assert.equal((await f.settle(r.token,{decision:null})).status,'invalid');assert.equal(await count('public.ai_spend_ledger'),1);assert.match((await f.reserve()).reason,/invalid/);
  });
  await scenario('unexpected bound overrun records full usage and blocks all new triage for tenant',async()=>{
    const r=await f.reserve();assert.equal((await f.settle(r.token,{tokensIn:1001})).status,'overrun');assert.match((await f.reserve({message:N})).reason,/bound/);assert.equal((await f.reserve({user:B,message:O})).status,'reserved');
  });
  await scenario('output token limit breach is overrun even if total cost stays below hold',async()=>{
    const r=await f.reserve();assert.equal((await f.settle(r.token,{tokensIn:0,tokensOut:401})).status,'overrun');
  });
  await scenario('application runs once and repeated ACK retry cannot duplicate mutations',async()=>{
    const r=await f.reserve();await f.settle(r.token);assert.equal((await f.apply()).newly_applied,true);assert.equal((await f.apply()).newly_applied,false);assert.equal((await f.reserve()).status,'applied');assert.equal(await count('public.application_events'),1);
  });
  await scenario('downstream failure preserves settled spend and cached task result',async()=>{
    const r=await f.reserve();await f.settle(r.token,{decision:{...DECISION,reason:'fail application'}});await assert.rejects(f.apply(),/application failed/);
    assert.equal(await count('public.ai_spend_ledger'),1);assert.equal((await f.reserve()).status,'ready');
  });
  await scenario('changed source is not silently applied from a previous task result',async()=>{
    const r=await f.reserve();await f.settle(r.token);await f.q("update public.messages set snippet='new information' where id=$1",[M]);
    await assert.rejects(f.apply(),/source context changed/);assert.equal(await count('public.application_events'),0);assert.equal(await count('public.ai_spend_ledger'),1);
  });
  await scenario('tenant business ownership is rechecked before application',async()=>{
    await f.q('insert into public.businesses values($1,$2,$3)',[N,B,'Foreign']);const r=await f.reserve();await f.settle(r.token,{decision:{...DECISION,business_id:N}});await assert.rejects(f.apply(),/ownership/);
  });
  for(const role of ['anon','authenticated']) await scenario(`${role} cannot call any new public RPC`,async()=>{
    for(const [name,args] of [['reserve_triage_cost_v1',[A,M,H,await f.source()]],['mark_triage_unknown_v1',[A,M,H,B]],
      ['settle_triage_cost_v1',[A,M,H,B,MODEL,1,1,DECISION]],['apply_budgeted_triage_v1',[A,M,H]]]) {
      await assert.rejects(f.call(name,args,role),/permission denied/);
    }
  });
  await scenario('private table RLS enabled and table access denied to all application roles',async()=>{
    assert.equal((await f.q("select relrowsecurity from pg_class where oid='mcc_cost_internal.triage_tasks'::regclass"))[0].relrowsecurity,true);
    for(const role of ['anon','authenticated','service_role']) await assert.rejects(f.db.transaction(async tx=>{
      await tx.exec(`set local role ${role}`);await tx.query('select * from mcc_cost_internal.triage_tasks');
    }),/permission denied/);
  });
});
await f.db.close();
