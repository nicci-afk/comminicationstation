import { JSDOM } from 'jsdom';
import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost:4173/executive'});
for (const key of ['window','document','HTMLElement','MutationObserver']) globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const base={user_id:'fixture',section:'NEXT',section_order:2,section_rank:1,effective_priority:100,priority_reasons:['Manually marked TODAY'],critical_attention:false,type:'ACTION',state:'TODAY',risk_level:'GREEN',execution_owner:'NICCI',due_at:null,due_kind:null,waiting_on:null,waiting_since:null,follow_up_at:null,next_action:'Call supplier',verification_state:'VERIFIED',freshness_expires_at:null,project_id:null,project_title:null,has_open_dependency:false,is_stale:false};
let items=[{...base,obligation_id:'00000000-0000-4000-8000-000000000001',title:'First action'}, {...base,obligation_id:'00000000-0000-4000-8000-000000000002',title:'Second action',section_rank:2}];
let captures=[], calls=[], failCapture=true;
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.hostname!=='bgpjpomqrnwsdmrofudb.supabase.co')throw new Error('Unexpected network blocked: '+url);
 let data=[]; let status=200;
 if(url.pathname.endsWith('/mcc_today'))data=items;
 else if(url.pathname.endsWith('/obligations'))data=captures;
 else if(url.pathname.endsWith('/mcc-obligation-action')) {
   const body=JSON.parse(init.body); calls.push(body);
   if(body.action==='UNDO_LAST')items=[{...base,obligation_id:body.obligation_id,title:'First action'},...items];
   else items=items.filter(i=>i.obligation_id!==body.obligation_id);
   data={ok:true,obligation_id:body.obligation_id};
 } else if(url.pathname.endsWith('/mcc-fast-capture')) {
   const body=JSON.parse(init.body); calls.push(body);
   if(failCapture){status=503; data={error:'Save unconfirmed. Retry.'};}
   else {captures=[{id:'00000000-0000-4000-8000-000000000003',title:body.note,description:body.note}];data={ok:true,obligation_id:captures[0].id};}
 }
 return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
};
const result=await build({stdin:{contents:`export {supabase} from './apps/web/src/lib/supabase.ts'; import React from 'react'; import { QueryClient, QueryClientProvider } from './apps/web/node_modules/@tanstack/react-query/build/modern/index.js'; import Executive from './apps/web/src/pages/Executive.tsx'; export const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false,gcTime:0}}}); export default function Fixture(){return <QueryClientProvider client={client}><Executive /></QueryClientProvider>}`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'one-react',setup(b){b.onResolve({filter:/^react(\/.*)?$/},a=>({path:'file://'+process.cwd()+'/node_modules/react/'+(a.path==='react'?'index.js':a.path.slice(6)+'.js'),external:true}));}}]});
const {default:Fixture,client,supabase}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const React=(await import('react')).default;
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react');
render(React.createElement(Fixture));
await screen.findByText('First action');
fireEvent.click(screen.getByRole('button',{name:'Focus mode'}));
assert.equal(screen.getAllByRole('article').length,1);
assert.equal(screen.queryByText('Second action'),null);
fireEvent.click(screen.getByRole('button',{name:'Done',exact:true}));
await screen.findByText('Second action');
assert.equal(screen.getAllByRole('article').length,1);
assert.equal(calls[0].action,'DONE');
fireEvent.click(screen.getByRole('button',{name:'Undo last change'}));
await screen.findByText('First action');
fireEvent.click(screen.getByRole('button',{name:'Blocked',exact:true}));
fireEvent.change(screen.getByLabelText('What is blocking this?'),{target:{value:'Supplier response needed'}});
fireEvent.click(screen.getByRole('button',{name:'Save',exact:true}));
await screen.findByText('Second action');
assert.equal(calls.at(-1).reason,'Supplier response needed');
const textarea=screen.getByLabelText("What's on your mind?");
fireEvent.change(textarea,{target:{value:'Lois tomorrow — raw note'}});
fireEvent.click(screen.getByRole('button',{name:'Capture',exact:true}));
await screen.findByText('Save unconfirmed. Retry.');
assert.equal(textarea.value,'Lois tomorrow — raw note');
const failedId=calls.at(-1).request_id;
failCapture=false;
fireEvent.click(screen.getByRole('button',{name:'Capture',exact:true}));
await screen.findByText('Captured. Review when ready.');
assert.equal(calls.at(-1).request_id,failedId); assert.equal(textarea.value,'');
fireEvent.click(screen.getByRole('button',{name:/Review captures/}));
await screen.findByText('Lois tomorrow — raw note');
assert.ok(screen.getByText('Captured — needs clarification'));
cleanup(); client.clear(); supabase.auth.stopAutoRefresh(); await supabase.removeAllChannels(); dom.window.close();
console.log('PASS: actual React interactions — one Focus card, Done/next, persistent undo, inline Blocked, failed capture retains text, retry ID and review inbox');
// Supabase's browser session maintenance timers outlive the synthetic DOM.
// All assertions above have completed; terminate this isolated fixture process.
process.exit(0);
