import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';
let calls=[];
globalThis.__rpc = (name,args)=> {calls.push({name,args}); return Promise.resolve({data:{ok:true,obligation_id:'saved'},error:null});};
const result=await build({entryPoints:['supabase/functions/api/mcc-fast-capture.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'mock-auth',setup(b){b.onResolve({filter:/_shared\/util.ts$/},()=>({path:'mock-util',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
export class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
export const handleOptions = req => req.method==='OPTIONS' ? new Response(null,{status:204}) : null;
export const json = (value,status=200) => new Response(JSON.stringify(value),{status});
export const serviceClient = () => ({rpc:globalThis.__rpc});
export const requireUser = async req => {if(req.headers.get('authorization')!=='Bearer TEST')throw new HttpError(401,'unauthorized');return {userId:'resolved-jwt-user'};};` }));}}]});
const {default:handler}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const id='00000000-0000-4000-8000-000000000003';
const post=(body,auth=true)=>handler(new Request('https://local.test/capture',{method:'POST',headers:auth?{authorization:'Bearer TEST'}:{},body:JSON.stringify(body)}));
assert.equal((await post({operation:'CAPTURE',request_id:id,note:'raw note'},false)).status,401); assert.equal(calls.length,0);
for(const body of [null,{}, {operation:'CAPTURE',request_id:'bad',note:'x'},{operation:'CAPTURE',request_id:id,note:''},{operation:'CAPTURE',request_id:id,note:42},{operation:'CAPTURE',request_id:id,note:'x'.repeat(10001)},{operation:'REVIEW',obligation_id:id,next_action:'x',project_id:['bad']}])assert.equal((await post(body)).status,400);
assert.equal(calls.length,0);
assert.equal((await post({operation:'CAPTURE',request_id:id,note:'  raw note  ',user_id:'attacker'})).status,200);
assert.deepEqual(calls[0],{name:'mcc_fast_capture',args:{p_user_id:'resolved-jwt-user',p_request_id:id,p_note:'  raw note  '}});
assert.equal((await post({operation:'REVIEW',obligation_id:id,next_action:'Call supplier'})).status,200);
assert.equal(calls[1].args.p_user_id,'resolved-jwt-user');
assert.equal((await handler(new Request('https://local.test/capture'))).status,405);
console.log('PASS: actual API handler method, auth, input rejection and JWT-owned RPC dispatch');
