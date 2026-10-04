// Disposable CI wrapper only. Application modules below are copied byte-for-byte.
import { AsyncLocalStorage } from "node:async_hooks";
const realFetch = globalThis.fetch.bind(globalThis);
const context = new AsyncLocalStorage<{mode:string;events:Record<string,unknown>[]} >();
const local = new URL(Deno.env.get("SUPABASE_URL")!);
if (!['kong','127.0.0.1','localhost','host.docker.internal'].includes(local.hostname) || local.protocol !== 'http:') throw Error('Local fixture backend required');
Deno.env.set('MCC_REPLY_DISPATCH_ENABLED', '__ENABLED__');
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const u = new URL(request.url), c = context.getStore();
  if (!c) throw Error('HTTP outside fixture request');
  const respond = (value:unknown,status=200) => new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json'}});
  if (u.origin === local.origin && /^\/(rest|auth)\/v1\//.test(u.pathname)) {
    c.events.push({kind:'local',path:u.pathname,caller:request.headers.get('x-mcc-caller')});
    if (u.pathname === '/rest/v1/rpc/get_app_config') {
      const b = await request.clone().json();
      if(b.p_key==='google_client_id') return respond({value:'fixture-client'});
      if(b.p_key==='google_client_secret_vault_id') return respond({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
      throw Error('Unexpected fixture config');
    }
    if (u.pathname === '/rest/v1/rpc/vault_read_secret' || u.pathname === '/rest/v1/rpc/get_user_secret') return respond('SYNTHETIC_NOT_A_CREDENTIAL');
    if (c.mode === 'ingest-fails' && u.pathname.startsWith('/rest/v1/rpc/ingest_')) return respond({message:'synthetic ingestion failure'},500);
    return realFetch(request, {...init,redirect:'error'});
  }
  if (u.origin === 'https://oauth2.googleapis.com' && u.pathname === '/token') {
    c.events.push({kind:'synthetic-oauth'});return respond({access_token:'SYNTHETIC_NOT_A_CREDENTIAL',expires_in:3600});
  }
  if (u.origin === 'https://gmail.googleapis.com' && u.pathname === '/gmail/v1/users/me/messages/send') {
    const body=await request.json();c.events.push({kind:'synthetic-send',channel:'email',body});
    if(c.mode==='timeout') throw Error('synthetic uncertain provider outcome');
    if(c.mode==='malformed') return respond({});
    return respond({id:'fixture-email-'+crypto.randomUUID(),threadId:body.threadId});
  }
  if (u.origin === 'https://gmail.googleapis.com' && u.pathname.startsWith('/gmail/v1/users/me/messages/')) {
    const sent=c.events.find(e=>e.kind==='synthetic-send')?.body as {raw:string;threadId:string}|undefined;
    const id=decodeURIComponent(u.pathname.split('/').at(-1)!);
    if(!sent) throw Error('Unexpected Gmail body/metadata fetch');
    const raw=atob(sent.raw.replace(/-/g,'+').replace(/_/g,'/'));
    const headers=raw.split('\r\n\r\n')[0].split('\r\n').map(s=>({name:s.slice(0,s.indexOf(':')),value:s.slice(s.indexOf(':')+1).trim()}));
    return respond({id,threadId:sent.threadId,labelIds:['SENT'],internalDate:String(Date.now()),snippet:'Synthetic reply',payload:{headers}});
  }
  if (u.origin === 'https://api.twilio.com' && /^\/2010-04-01\/Accounts\/SYNTHETIC_NOT_A_CREDENTIAL\/Messages.json$/.test(u.pathname)) {
    c.events.push({kind:'synthetic-send',channel:'phone',body:await request.text()});
    if(c.mode==='timeout') throw Error('synthetic uncertain provider outcome');
    return respond(c.mode==='malformed'?{}:{sid:'fixture-sms-'+crypto.randomUUID()});
  }
  c.events.push({kind:'blocked-egress',origin:u.origin,path:u.pathname});
  throw Error('Non-local HTTP blocked by reply fixture');
};
const [{default:review},{default:gmail},{default:twilio}] = await Promise.all([
  import('./app/reply-review.ts'),import('./app/gmail-send.ts'),import('./app/twilio-send.ts')
]);
const routes:Record<string,(r:Request)=>Promise<Response>>={'reply-review':review,'gmail-send':gmail,'twilio-send':twilio};
Deno.serve(async req=>{
  const handler=routes[new URL(req.url).pathname.split('/').at(-1)!];
  if(!handler)return new Response('fixture ready',{status:404,headers:{'x-mcc-reply-runtime':'true'}});
  const mode=req.headers.get('x-fixture-mode')??'ok';
  if(!['ok','timeout','malformed','ingest-fails'].includes(mode))return new Response('invalid fixture mode',{status:400});
  return context.run({mode,events:[]},async()=>{
    const response=await handler(req);if(req.method==='OPTIONS')return response;
    const data=await response.json();
    return new Response(JSON.stringify({...data,__fixture_events:context.getStore()!.events}),{status:response.status,headers:{...Object.fromEntries(response.headers),'x-mcc-reply-runtime':'true'}});
  });
});
