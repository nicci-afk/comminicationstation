// This test loads the real pinned SDK but intercepts every HTTP request locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require=createRequire(import.meta.url);
const sdkRoot=process.env.MCC_COST_SDK_ROOT;
assert(sdkRoot,'MCC_COST_SDK_ROOT must point to installed @anthropic-ai/sdk@0.131.0');
const Anthropic=require(sdkRoot).default;
assert.equal(require(path.join(sdkRoot,'package.json')).version,'0.131.0');
const root=path.resolve(new URL('../supabase/functions/workers',import.meta.url).pathname);
const context=vm.createContext({console,Number,Object,Array,Error,JSON});const cache=new Map();
async function load(id) {
  if(cache.has(id))return cache.get(id);
  if(id==='@anthropic-ai/sdk') {const m=new vm.SyntheticModule(['default'],function(){this.setExport('default',Anthropic);},{context,identifier:id});cache.set(id,m);return m;}
  const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(id,'utf8')),{context,identifier:id});cache.set(id,m);
  await m.link((s,p)=>load(s.startsWith('.')?path.resolve(path.dirname(p.identifier),s):s));return m;
}
const m=await load(path.join(root,'triage-provider.ts'));await m.evaluate();
const MODEL='claude-haiku-4-5-20251001';
const args={apiKey:'synthetic-not-a-credential',model:MODEL,system:'fixture',user:'fixture'};
const originalFetch=globalThis.fetch;let requests=[];let status=200;
globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.anthropic.com/v1/messages');
  requests.push({body:JSON.parse(init.body),headers:new Headers(init.headers)});
  const body=status===200?{id:'synthetic',type:'message',role:'assistant',model:MODEL,stop_reason:'end_turn',stop_sequence:null,
    content:[{type:'text',text:'{"category":"fyi"}'}],usage:{input_tokens:10,output_tokens:5}}:
    {type:'error',error:{type:'overloaded_error',message:'Synthetic test error'}};
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
};
try {
  await test('pinned real SDK serializes only intended standard-tier request',async()=>{
    const result=await m.namespace.callTriageOnce(args);assert.equal(result.tokensIn,10);assert.equal(requests.length,1);
    assert.equal(requests[0].body.service_tier,'standard_only');assert.equal(requests[0].body.max_tokens,400);
    assert.deepEqual(Object.keys(requests[0].body).sort(),['max_tokens','messages','model','service_tier','system']);
    assert.equal(requests[0].headers.get('anthropic-version'),'2023-06-01');
  });
  await test('pinned real SDK does not retry an HTTP 500',async()=>{
    requests=[];status=500;await assert.rejects(m.namespace.callTriageOnce(args));assert.equal(requests.length,1);
  });
} finally { globalThis.fetch=originalFetch; }
