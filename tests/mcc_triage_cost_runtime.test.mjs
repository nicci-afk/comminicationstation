import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fixture,A,M,N,H,MODEL,DECISION } from './cost-fixture.mjs';
const root=path.resolve(new URL('../supabase/functions/workers',import.meta.url).pathname);
async function modules(stubs={}) {
  const context=vm.createContext({console,crypto:crypto.webcrypto,TextEncoder,Request,Response,Headers,URL,Date,
    fetch:()=>{throw new Error('External network forbidden in tests');}});
  const cache=new Map();
  const load=async id=>{
    if(cache.has(id))return cache.get(id);
    if(stubs[id]){
      const values=stubs[id];const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v] of Object.entries(values))this.setExport(k,v);},{context,identifier:id});cache.set(id,m);return m;
    }
    const source=fs.readFileSync(id,'utf8');
    const m=new vm.SourceTextModule(stripTypeScriptTypes(source),{context,identifier:id});cache.set(id,m);
    await m.link((specifier,mod)=>load(specifier.startsWith('.')?path.resolve(path.dirname(mod.identifier),specifier):specifier));return m;
  };
  const get=async name=>{const m=await load(path.join(root,name));if(m.status!=='evaluated')await m.evaluate();return m.namespace;};
  return {get};
}
const f=await fixture();
const signatures={reserve_triage_cost_v1:['p_user','p_message','p_request_hash','p_source'],
  mark_triage_unknown_v1:['p_user','p_message','p_request_hash','p_token'],
  settle_triage_cost_v1:['p_user','p_message','p_request_hash','p_token','p_model','p_tokens_in','p_tokens_out','p_decision'],
  apply_budgeted_triage_v1:['p_user','p_message','p_request_hash']};
let intercept=null;const requests=[];
const db={rpc:async(name,args)=>{
  requests.push({name,args});if(intercept){const r=await intercept(name,args);if(r)return r;}
  try{return {data:await f.call(name,signatures[name].map(key=>args[key])),error:null};}
  catch(e){return {data:null,error:{message:e.message}};}
}};
const loaded=await modules({[path.join(root,'triage-provider.ts')]:{callTriageOnce:()=>{throw new Error('No default model allowed');}}});
const runtime=await loaded.get('triage-cost.ts');
const makeArgs=async()=>({userId:A,messageId:M,apiKey:'synthetic-key',system:'Synthetic immutable prompt',
  user:runtime.canonicalJson((await f.source()).message),businesses:[]});
let paid=0;
const call=async()=>{paid++;return {tokensIn:100,tokensOut:20,model:MODEL,decision:DECISION};};
await test('actual triage orchestration with exact SQL and synthetic provider only',async t=>{
  const scenario=async(name,fn)=>t.test(name,async()=>{await f.reset();intercept=null;requests.length=0;paid=0;await fn();});
  await scenario('canonical input order has stable SHA-256; prompt/version changes differ',async()=>{
    assert.equal(runtime.canonicalJson({z:1,a:{y:2,x:3}}),runtime.canonicalJson({a:{x:3,y:2},z:1}));
    assert.equal((await runtime.triageRequestHash('system','input')).length,64);
    assert.notEqual(await runtime.triageRequestHash('system','input'),await runtime.triageRequestHash('system2','input'));
    assert.throws(()=>runtime.canonicalJson({a:undefined}),/not JSON/);
  });
  await scenario('full task reserves then calls once then settles then applies',async()=>{
    const r=await runtime.runBudgetedTriage(db,await makeArgs(),call);assert.equal(r.applied,true);assert.equal(paid,1);
    assert.deepEqual(requests.map(r=>r.name),['reserve_triage_cost_v1','settle_triage_cost_v1','apply_budgeted_triage_v1']);
  });
  await scenario('ACK retry does not call provider or reapply',async()=>{
    const args=await makeArgs();await runtime.runBudgetedTriage(db,args,call);assert.equal((await runtime.runBudgetedTriage(db,args,call)).applied,false);assert.equal(paid,1);
  });
  await scenario('parallel same-message queue deliveries issue only one paid attempt',async()=>{
    const args=await makeArgs();let release,start;
    const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{start=resolve;});
    const first=runtime.runBudgetedTriage(db,args,async()=>{paid++;start();await gate;return {tokensIn:100,tokensOut:20,model:MODEL,decision:DECISION};});
    await started;
    try { await assert.rejects(runtime.runBudgetedTriage(db,args,call),/existing reserved/); }
    finally { release(); }
    await first;assert.equal(paid,1);
    // PGlite serializes these RPC transactions; this is NOT native independent-session lock proof.
  });
  await scenario('missing policy visibly blocks without a provider call',async()=>{
    await f.q('delete from public.app_config');await assert.rejects(runtime.runBudgetedTriage(db,await makeArgs(),call),/blocked/);assert.equal(paid,0);
  });
  await scenario('budget exhausted is not treated as successful triage',async()=>{
    await f.q('update public.spend_caps set monthly_cap_usd=0');await assert.rejects(runtime.runBudgetedTriage(db,await makeArgs(),call),/monthly cap/);assert.equal(paid,0);
  });
  await scenario('reserve RPC error or malformed result never falls back to old check_spend',async()=>{
    for(const result of [{data:null,error:{message:'missing RPC'}},{data:{allowed:true},error:null},{data:[],error:null}]) {
      intercept=async()=>result;await assert.rejects(runtime.runBudgetedTriage(db,await makeArgs(),call),/triage cost/);
    }assert.equal(paid,0);
  });
  await scenario('lost reserve response holds the attempt and does not invoke provider on redelivery',async()=>{
    intercept=async(name,args)=>{if(name==='reserve_triage_cost_v1'){await f.call(name,signatures[name].map(k=>args[k]));return {data:null,error:{message:'timeout'}};}};
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,call));intercept=null;
    await assert.rejects(runtime.runBudgetedTriage(db,args,call),/existing reserved/);assert.equal(paid,0);
  });
  await scenario('timeout retains unknown attempt and never automatically calls provider again',async()=>{
    const args=await makeArgs();const timeout=async()=>{paid++;throw Error('synthetic timeout');};
    await assert.rejects(runtime.runBudgetedTriage(db,args,timeout),/outcome unknown/);await assert.rejects(runtime.runBudgetedTriage(db,args,call),/existing unknown/);assert.equal(paid,1);
  });
  await scenario('unknown-mark RPC failure still leaves original hold and blocks paid retries',async()=>{
    intercept=async name=>name==='mark_triage_unknown_v1'?{error:{message:'offline'},data:null}:null;
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,async()=>{paid++;throw Error();}),/unknown/);intercept=null;
    await assert.rejects(runtime.runBudgetedTriage(db,args,call),/existing reserved/);assert.equal(paid,1);
  });
  await scenario('lost settlement response recovers committed result without another paid attempt',async()=>{
    intercept=async(name,args)=>{if(name==='settle_triage_cost_v1'){await f.call(name,signatures[name].map(k=>args[k]));return {data:null,error:{message:'timeout'}};}};
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,call));intercept=null;
    assert.equal((await runtime.runBudgetedTriage(db,args,call)).applied,true);assert.equal(paid,1);
  });
  await scenario('settlement not committed remains held rather than counting unknown cost as zero',async()=>{
    intercept=async name=>name==='settle_triage_cost_v1'?{data:null,error:{message:'offline'}}:null;
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,call));intercept=null;
    await assert.rejects(runtime.runBudgetedTriage(db,args,call),/existing reserved/);assert.equal(paid,1);
  });
  await scenario('application failure keeps one charge and uses ready result on retry',async()=>{
    intercept=async name=>name==='apply_budgeted_triage_v1'?{data:null,error:{message:'offline'}}:null;
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,call));intercept=null;
    assert.equal((await runtime.runBudgetedTriage(db,args,call)).applied,true);assert.equal(paid,1);
  });
  await scenario('malformed/incomplete decision is billed but not applied or retried',async()=>{
    const args=await makeArgs();await assert.rejects(runtime.runBudgetedTriage(db,args,async()=>{paid++;return {tokensIn:100,tokensOut:20,model:MODEL,decision:{category:'fyi'}};}),/invalid/);
    await assert.rejects(runtime.runBudgetedTriage(db,args,call),/invalid/);assert.equal(paid,1);
    assert.equal((await f.q('select count(*)::int n from public.ai_spend_ledger'))[0].n,1);
    assert.equal((await f.q('select count(*)::int n from public.application_events'))[0].n,0);
  });
  await scenario('expired reservation does not start paid call',async()=>{
    intercept=async()=>({error:null,data:{status:'reserved',token:M,model:MODEL,valid_until:'2000-01-01'}});
    await assert.rejects(runtime.runBudgetedTriage(db,await makeArgs(),call),/expired/);assert.equal(paid,0);
  });
  await scenario('fresh context changes conflict rather than replaying stale output',async()=>{
    const args=await makeArgs();await runtime.runBudgetedTriage(db,args,call);await f.q("update public.messages set snippet='new' where id=$1",[M]);
    await assert.rejects(runtime.runBudgetedTriage(db,await makeArgs(),call),/conflict/);assert.equal(paid,1);
  });
});

await test('actual provider adapter with synthetic SDK constructor',async t=>{
  let response,clientOptions,body,attempts=0,throwError=false;
  class FakeAnthropic {
    constructor(options){clientOptions=options;this.messages={create:async args=>{attempts++;body=args;if(throwError)throw Error('fixture');return response;}};}
  }
  const m=await modules({'@anthropic-ai/sdk':{default:FakeAnthropic}});const p=await m.get('triage-provider.ts');
  const baseline=()=>({model:MODEL,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(DECISION)}],
    usage:{input_tokens:100,output_tokens:20,service_tier:'standard',cache_creation_input_tokens:0,cache_read_input_tokens:0,
      server_tool_use:{web_search_requests:0,web_fetch_requests:0}}});
  const invoke=()=>p.callTriageOnce({apiKey:'synthetic-key',model:MODEL,system:'synthetic',user:'synthetic'});
  await t.test('single attempt, fixed output, standard-only; no tools/cache/thinking',async()=>{
    response=baseline();const r=await invoke();assert.equal(r.tokensIn,100);assert.equal(clientOptions.maxRetries,0);assert.equal(clientOptions.timeout,45000);
    assert.equal(body.service_tier,'standard_only');assert.equal(body.max_tokens,400);assert.equal(body.tools,undefined);assert.equal(body.thinking,undefined);assert.equal(body.cache_control,undefined);
  });
  await t.test('provider exception is not retried by adapter',async()=>{throwError=true;attempts=0;await assert.rejects(invoke());assert.equal(attempts,1);throwError=false;});
  for(const [name,change] of [
    ['missing usage',r=>delete r.usage],['negative usage',r=>r.usage.input_tokens=-1],['fractional usage',r=>r.usage.output_tokens=1.5],
    ['new billing field',r=>r.usage.new_billable_tokens=1],['paid cache',r=>r.usage.cache_creation_input_tokens=10],
    ['tool usage',r=>r.usage.server_tool_use.web_search_requests=1],['priority tier',r=>r.usage.service_tier='priority']]) {
    await t.test(name+' fails closed',async()=>{response=baseline();change(response);await assert.rejects(invoke(),/usage/);});
  }
  await t.test('malformed text retains tokens with null decision',async()=>{response=baseline();response.content[0].text='not json';const r=await invoke();assert.equal(r.tokensIn,100);assert.equal(r.decision,null);});
  await t.test('truncated JSON retains tokens but is not actionable',async()=>{response=baseline();response.stop_reason='max_tokens';assert.equal((await invoke()).decision,null);});
});

await test('actual worker route retains safe inputs and integrates the new cost gate',async t=>{
  let current,queryError=null,contextError=null,key='synthetic',called=0,pushes=0,reads=[];
  const fakeDb={...db,from(table){reads.push(table);return {
    select(){return this;},eq(){return this;},order(){return Promise.resolve({data:[],error:contextError});},
    maybeSingle(){return Promise.resolve({data:current,error:queryError});},
  };}};
  const util={handleOptions:()=>null,getUserSecret:async()=>key,
    runWorker:async(_req,queue,vt,budget,handler)=>{
      assert.equal(queue,'triage_jobs');await handler(fakeDb,{message:{message_id:M},read_ct:1,msg_id:10});return new Response('{}');
    }};
  const m=await modules({[path.join(root,'_shared/util.ts')]:util,
    [path.join(root,'_shared/prompts.ts')]:{triageSystem:()=> 'Synthetic immutable prompt'},
    [path.join(root,'_shared/agentedge-push.ts')]:{maybePushToAgentedge:async()=>{pushes++;}},
    [path.join(root,'triage-provider.ts')]:{callTriageOnce:async()=>{called++;return {tokensIn:100,tokensOut:20,model:MODEL,decision:DECISION};}}});
  const worker=(await m.get('triage-worker.ts')).default;
  const run=()=>worker(new Request('https://fixture.invalid/triage-worker'));
  const scenario=async(name,fn)=>t.test(name,async()=>{
    await f.reset();intercept=null;queryError=null;contextError=null;key='synthetic';called=0;pushes=0;reads=[];
    current=(await f.q('select * from public.messages where id=$1',[M]))[0];await fn();
  });
  await scenario('route meters, applies once, then keeps contained push ordering',async()=>{
    await run();await run();assert.equal(called,1);assert.equal(pushes,1);assert(reads.includes('businesses'));
  });
  await scenario('failed source read cannot disappear as successful empty work',async()=>{
    queryError={message:'offline'};await assert.rejects(run(),/message read failed/);assert.equal(called,0);
  });
  await scenario('missing key retains pre-existing rules-only outcome without a model call',async()=>{
    key=null;await run();assert.equal(called,0);assert.equal(pushes,0);
  });
  await scenario('failed business context read blocks rather than using empty context',async()=>{
    contextError={message:'offline'};await assert.rejects(run(),/context unverified/);assert.equal(called,0);
  });
  await scenario('missing policy raises a visible error for existing retry/dead-letter path',async()=>{
    await f.q('delete from public.app_config');await assert.rejects(run(),/blocked/);assert.equal(called,0);assert.equal(pushes,0);
  });
});

await f.db.close();
