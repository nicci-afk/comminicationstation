import { JSDOM } from 'jsdom';
import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost:4173/executive'});
for (const key of ['window','document','HTMLElement','MutationObserver']) globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const base={user_id:'fixture',section:'NEXT',section_order:2,section_rank:1,effective_priority:100,priority_reasons:['Manually marked TODAY'],critical_attention:false,type:'ACTION',state:'TODAY',risk_level:'GREEN',execution_owner:'NICCI',due_at:null,due_kind:null,waiting_on:null,waiting_since:null,follow_up_at:null,next_action:'Call supplier',verification_state:'VERIFIED',freshness_expires_at:null,project_id:null,project_title:null,has_open_dependency:false,is_stale:false};
let items=[{...base,obligation_id:'00000000-0000-4000-8000-000000000001',title:'First action'}, {...base,obligation_id:'00000000-0000-4000-8000-000000000002',title:'Second action',section_rank:2}];
let captures=[], calls=[], failCapture=true, failReview=true, capturedNote='';
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.hostname!=='bgpjpomqrnwsdmrofudb.supabase.co')throw new Error('Unexpected network blocked: '+url);
 let data=[]; let status=200;
 if(url.pathname.endsWith('/mcc_today'))data=items;
 else if(url.pathname.endsWith('/obligations'))data=captures;
 else if(url.pathname.endsWith('/mcc-obligation-action')) {
   const body=JSON.parse(init.body); calls.push(body);
   if(body.action==='UNDO_LAST' && body.obligation_id==='00000000-0000-4000-8000-000000000003') {
     captures=[{id:body.obligation_id,title:capturedNote,description:capturedNote}];
     items=items.filter(i=>i.obligation_id!==body.obligation_id);
   }
   else if(body.action==='UNDO_LAST')items=[{...base,obligation_id:body.obligation_id,title:'First action'},...items];
   else items=items.filter(i=>i.obligation_id!==body.obligation_id);
   data={ok:true,obligation_id:body.obligation_id};
 } else if(url.pathname.endsWith('/mcc-fast-capture')) {
   const body=JSON.parse(init.body); calls.push(body);
   if(failCapture){status=503; data={error:'Save unconfirmed. Retry.'};}
   else if(body.operation==='REVIEW' && failReview) {status=503;data={error:'Review unconfirmed. Retry.'};}
   else if(body.operation==='REVIEW') {
    captures=[];
    items=[...items,...Array.from({length:5},(_,i)=>({...base,section:'NEEDS_YOU_NOW',section_rank:i+1,obligation_id:'fixture-'+i,title:'Higher ranked '+i})),{...base,section:'NEEDS_YOU_NOW',section_rank:6,obligation_id:body.obligation_id,title:body.next_action,next_action:body.next_action}];
    data={ok:true,obligation_id:body.obligation_id};
   } else {capturedNote=body.note;captures=[{id:'00000000-0000-4000-8000-000000000003',title:body.note,description:body.note}];data={ok:true,obligation_id:captures[0].id};}
 }
 return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
};
const result=await build({stdin:{contents:`export {supabase} from './apps/web/src/lib/supabase.ts'; import React from 'react'; import { QueryClient, QueryClientProvider } from './apps/web/node_modules/@tanstack/react-query/build/modern/index.js'; import Executive from './apps/web/src/pages/Executive.tsx'; export const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false,gcTime:0}}}); export default function Fixture(){return <QueryClientProvider client={client}><Executive /></QueryClientProvider>}`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'one-react',setup(b){b.onResolve({filter:/^react(\/.*)?$/},a=>({path:'file://'+process.cwd()+'/node_modules/react/'+(a.path==='react'?'index.js':a.path.slice(6)+'.js'),external:true}));}}]});
const {default:Fixture,client,supabase}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const React=(await import('react')).default;
const {render,screen,fireEvent,waitFor,cleanup,within}=await import('@testing-library/react');
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
// Reproduce the production finding: a reviewed capture ranks below the daily cap.
fireEvent.change(screen.getByLabelText('Confirm one next action'),{target:{value:'Reviewed lower-ranked action'}});
fireEvent.click(screen.getByRole('button',{name:"Add to today's actions"}));
await screen.findByText('Review unconfirmed. Retry.');
assert.equal(screen.getByLabelText('Confirm one next action').value,'Reviewed lower-ranked action');
assert.equal(screen.queryByText(/Saved: Reviewed lower-ranked action/),null);
failReview=false;
fireEvent.click(screen.getByRole('button',{name:"Add to today's actions"}));
await screen.findByText(/Saved: Reviewed lower-ranked action/);
fireEvent.click(screen.getByRole('button',{name:'Show full view'}));
assert.equal(screen.queryByRole('heading',{name:'Reviewed lower-ranked action'}),null);
assert.ok(screen.getByText('3 of 6'));
fireEvent.click(screen.getByRole('button',{name:'View action'}));
const savedRegion=screen.getByRole('region',{name:'Saved action'});
assert.ok(within(savedRegion).getByRole('heading',{name:'Reviewed lower-ranked action'}));
assert.equal(screen.getAllByRole('heading',{name:'Reviewed lower-ranked action'}).length,1);
assert.ok(screen.getByRole('button',{name:'Show all active obligations'}));
fireEvent.click(screen.getByRole('button',{name:'Back to daily summary'}));
assert.equal(screen.queryByRole('heading',{name:'Reviewed lower-ranked action'}),null);
// A later ranking change must not double-count the revealed card inside its section.
await React.act(async()=>{
 const reviewed=items.find(item=>item.title==='Reviewed lower-ranked action');
 items=[...items.filter(item=>item.section==='NEXT'),{...reviewed,section_rank:1},...items.filter(item=>item.section==='NEEDS_YOU_NOW' && item!==reviewed)];
 await client.invalidateQueries({queryKey:['mcc-today']});
});
fireEvent.click(screen.getByRole('button',{name:'View action'}));
assert.equal(screen.getAllByRole('heading',{name:'Reviewed lower-ranked action'}).length,1);
assert.ok(screen.getByText('2 of 6'));
fireEvent.click(screen.getByRole('button',{name:'Back to daily summary'}));
assert.equal(screen.getAllByRole('heading',{name:'Reviewed lower-ranked action'}).length,1);
fireEvent.click(screen.getByRole('button',{name:'Focus mode'}));
assert.equal(screen.getAllByRole('article').length,1);
assert.ok(screen.getByRole('heading',{name:'Second action'}));
fireEvent.click(screen.getByRole('button',{name:'Undo last change'}));
await screen.findByRole('button',{name:'Review captures (1)'});
assert.ok(screen.getByText('Lois tomorrow — raw note'));
assert.equal(screen.queryByRole('button',{name:'View action'}),null);
cleanup(); client.clear(); supabase.auth.stopAutoRefresh(); await supabase.removeAllChannels(); dom.window.close();
console.log('PASS: actual React interactions — one Focus card, Done/next, persistent undo, inline Blocked, failed capture retains text, retry ID, review inbox, hidden action receipt/reveal and preserved Focus ranking');
// Supabase's browser session maintenance timers outlive the synthetic DOM.
// All assertions above have completed; terminate this isolated fixture process.
process.exit(0);
