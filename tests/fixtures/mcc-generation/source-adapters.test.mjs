import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
const require=createRequire(import.meta.url);
const sdkRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../../../apps/web/node_modules/@supabase/supabase-js');
const {createClient:realCreateClient}=require(sdkRoot);
const sdkVersion=require(sdkRoot+'/package.json').version;
const ROOT=process.env.MCC_GENERATION_BUNDLES; assert(ROOT,'materialized generation bundles required');
const USER='00000000-0000-4000-8000-000000000001';
const TOKEN='00000000-0000-4000-8000-000000000003';
async function load(entry,{auth=true,foreign=false,queue=[],fetchOverride=null}={}){
  const requests=[],created=[];let claims=0;
  const localFetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url);const headers=new Headers(init.headers);const method=init.method??'GET';
    const body=init.body?JSON.parse(init.body):null;requests.push({path:url.pathname,params:Object.fromEntries(url.searchParams),method,headers:Object.fromEntries(headers),body});
    if(fetchOverride){const r=await fetchOverride(requests.at(-1));if(r)return r;}
    let data=[];
    if(url.pathname==='/auth/v1/user')return new Response(JSON.stringify(auth?{id:USER,email:'fixture@example.invalid'}:{message:'denied',code:'bad_jwt'}),{status:auth?200:401,headers:{'Content-Type':'application/json'}});
    if(url.pathname.endsWith('/rpc/claim_sync_jobs_v1')||url.pathname.endsWith('/rpc/claim_jobs'))data=claims++===0?queue:[];
    else if(url.pathname.endsWith('/rpc/finish_sync_job_v1')||url.pathname.endsWith('/rpc/ack_job'))data=null;
    else if(url.pathname==='/rest/v1/queue_items'){
      if(method==='GET'){
        assert.equal(url.searchParams.get('user_id'),'eq.'+USER);
        data=foreign?[]:[{id:'item',sender_identifier:'sender@example.invalid',sender_name:'Fixture',channel:'email',thread_id:'thread'}];
      }else{assert.equal(url.searchParams.get('user_id'),'eq.'+USER);data=[{id:'item'}];}
    }else if(url.pathname==='/rest/v1/gmail_accounts'){
      assert.equal(url.searchParams.get('user_id'),'eq.'+USER);data=foreign?[]:[{id:USER,email_address:'fixture@example.invalid'}];
    }else if(url.pathname==='/rest/v1/triage_rules')assert.equal(body.user_id,USER);
    else if(url.pathname==='/rest/v1/rpc/enqueue_and_poke')data=1;
    else if(url.pathname.startsWith('/rest/v1/'))data=[];
    else throw Error('unexpected endpoint '+url.pathname);
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const context=vm.createContext({Request,Response,URL,URLSearchParams,Headers,TextEncoder,TextDecoder,Date,
    atob,btoa,crypto:globalThis.crypto,console:{error(){}},
    Deno:{env:{get:k=>({SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-secret',WORKER_SECRET:'fixture-worker'})[k]}},
    fetch:async()=>{throw Error('provider network forbidden in adapter test');}});
  const sdk=new vm.SyntheticModule(['createClient','SupabaseClient'],function(){
    this.setExport('SupabaseClient',class{});
    this.setExport('createClient',(url,key,options)=>{
      created.push(structuredClone(options));return realCreateClient(url,key,{...options,global:{...options.global,fetch:localFetch}});
    });
  },{context});
  const modules=new Map([['@supabase/supabase-js',sdk]]);
  function module(file){
    if(modules.has(file))return modules.get(file);
    let source=fs.readFileSync(file,'utf8');
    if(file.endsWith('/_shared/gmail.ts'))source+='\nexport const GmailAccountRow=null,GmailMessageLite=null;';
    if(file.endsWith('/_shared/util.ts'))source+='\nexport const Job=null;';
    const m=new vm.SourceTextModule(stripTypeScriptTypes(source,{mode:'strip'}),{context,identifier:file});modules.set(file,m);return m;
  }
  const m=module(path.join(ROOT,entry));await m.link((s,p)=>module(s.startsWith('.')?path.resolve(path.dirname(p.identifier),s):s));await m.evaluate();
  return {ns:m.namespace,requests,created};
}
const userRequest=(body={},headers={})=>new Request('https://fixture.invalid/action',{method:'POST',headers:{authorization:'Bearer synthetic-user-token','Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test(`real Supabase JS ${sdkVersion} emits the API tag on REST/RPC requests without persistence`,async()=>{
  const f=await load('candidate/api/api/_shared/util.ts');const db=f.ns.serviceClient();await db.rpc('enqueue_and_poke',{p_queue:'sync_jobs',p_msg:{}});
  assert.equal(f.requests[0].headers['x-mcc-caller'],'api-gmail-fence-v1');assert.equal(f.created[0].auth.persistSession,false);
  assert(!Object.keys(f.requests[0].headers).some(k=>k.startsWith('x-mcc-sync-')));
});
test('shared utility code is identical across bundles while prompts retain their distinct hashes',()=>{
  assert.equal(fs.readFileSync(path.join(ROOT,'candidate/api/api/_shared/util.ts'),'utf8'),fs.readFileSync(path.join(ROOT,'candidate/workers/_shared/util.ts'),'utf8'));
  const digest=p=>require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT,'candidate',p))).digest('hex');
  const hashes={workers:{'_shared/prompts.ts':digest('workers/_shared/prompts.ts')},api:{'api/_shared/prompts.ts':digest('api/api/_shared/prompts.ts')}};
  assert.equal(hashes.workers['_shared/prompts.ts'],'23cb2e3a9318407960133951b1b23c7e1c5ca3b8f40f1c82c0882fde94b757a3');
  assert.notEqual(hashes.api['api/_shared/prompts.ts'],hashes.workers['_shared/prompts.ts']);
});
test('generic triage/pipeline/digest wrappers keep legacy queue RPCs and never impersonate API',async()=>{
  for(const name of ['triage_jobs','pipeline_jobs','digest_jobs']){
    const f=await load('candidate/workers/_shared/util.ts',{queue:[{msg_id:1,read_ct:1,message:{}}]});let handled=0;
    await f.ns.runWorker(new Request('https://fixture.invalid',{headers:{'x-worker-secret':'fixture-worker'}}),name,60,100000,async()=>{handled++;});
    assert.equal(handled,1);assert(f.requests.every(r=>r.headers['x-mcc-caller']==='other-worker-v1'));
    assert(f.requests.some(r=>r.path.endsWith('/rpc/claim_jobs')&&r.body.p_queue===name));assert(f.requests.some(r=>r.path.endsWith('/rpc/ack_job')));
  }
});
test('sync wrapper creates job-scoped headers on actual SDK traffic and claims one job at a time',async()=>{
  const j={msg_id:7,read_ct:5,attempt:1,claim_token:TOKEN,message:{gmail_account_id:USER}};
  const f=await load('candidate/workers/sync-job-runtime.ts',{queue:[j]});
  await f.ns.runSyncWorker(new Request('https://fixture.invalid',{headers:{'x-worker-secret':'fixture-worker','x-mcc-caller':'api-gmail-fence-v1'}}),async(db)=>{
    await db.rpc('ingest_email_message',{p_gmail_account_id:USER,p:{}});
  });
  const c=f.requests.find(r=>r.path.endsWith('/claim_sync_jobs_v1'));assert.equal(c.body.p_n,1);assert.equal(c.headers['x-mcc-caller'],'other-worker-v1');
  const w=f.requests.find(r=>r.path.endsWith('/ingest_email_message'));assert.equal(w.headers['x-mcc-caller'],'gmail-sync-v1');assert.equal(w.headers['x-mcc-sync-generation'],'gmail-sync-checkpoints-g1');assert.equal(w.headers['x-mcc-sync-job'],'7');assert.equal(w.headers['x-mcc-sync-token'],TOKEN);
  assert(f.requests.some(r=>r.path.endsWith('/finish_sync_job_v1')));assert(!f.requests.some(r=>r.path.endsWith('/ack_job')));
});
test('API ignores spoofed inbound caller/generation headers',async()=>{
  const f=await load('candidate/api/api/spam-block.ts');const res=await f.ns.default(userRequest({queue_item_id:'item'},{'x-mcc-caller':'gmail-sync-v1','x-mcc-sync-token':TOKEN}));
  assert.equal(res.status,200);assert(f.requests.every(r=>r.headers['x-mcc-caller']==='api-gmail-fence-v1'));assert(f.requests.every(r=>r.headers['x-mcc-sync-token']===undefined));
});
for(const route of ['spam-block','gmail-deep-backfill','gmail-send']){
  test(`${route} still rejects unauthenticated callers before any DB mutation`,async()=>{
    const f=await load(`candidate/api/api/${route}.ts`,{auth:false});const r=await f.ns.default(userRequest({queue_item_id:'item',body:'Synthetic',approval:'USER_CONFIRMED'}));
    assert.equal(r.status,401);assert(!f.requests.some(x=>x.path.startsWith('/rest/v1/')&&x.method!=='GET'));
  });
  test(`${route} preserves authenticated tenant filters and blocks foreign records`,async()=>{
    const f=await load(`candidate/api/api/${route}.ts`,{foreign:true});const r=await f.ns.default(userRequest({queue_item_id:'item',body:'Synthetic',approval:'USER_CONFIRMED'}));
    assert([400,404].includes(r.status));assert(!f.requests.some(x=>x.path.startsWith('/rest/v1/')&&x.method!=='GET'));
  });
}
test('Gmail sending still requires the original explicit send approval',async()=>{
  const f=await load('candidate/api/api/gmail-send.ts');const r=await f.ns.default(userRequest({queue_item_id:'item',body:'Synthetic'}));
  assert.equal(r.status,403);assert(!f.requests.some(x=>x.path.startsWith('/rest/v1/')));
});
test('API deep backfill keeps tenant-derived queue targets with the API marker',async()=>{
  const f=await load('candidate/api/api/gmail-deep-backfill.ts');const r=await f.ns.default(userRequest({gmail_account_id:TOKEN}));assert.equal(r.status,200);
  const enqueue=f.requests.find(x=>x.path.endsWith('/enqueue_and_poke'));assert.equal(enqueue.body.p_msg.gmail_account_id,USER);assert.equal(enqueue.headers['x-mcc-caller'],'api-gmail-fence-v1');
});
