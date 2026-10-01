import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const { createClient } = createRequire(new URL('../apps/web/package.json', import.meta.url))('@supabase/supabase-js');
const cfg=JSON.parse(fs.readFileSync(process.env.MCC_LOCAL_STATUS,'utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(cfg.API_URL)) throw new Error('Refusing nonlocal database');
const admin=createClient(cfg.API_URL,cfg.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const password='Local-fixture-only-8uW2!';
const users=[];
for (const suffix of ['a','b']) {
 const {data,error}=await admin.auth.admin.createUser({email:`mcc-browser-${suffix}@example.invalid`,password,email_confirm:true});
 assert.equal(error,null); users.push(data.user);
}
const own=users[0].id, other=users[1].id;
const a='30000000-0000-4000-8000-000000000001',b='30000000-0000-4000-8000-000000000002';
let res=await admin.from('obligations').insert([
 {id:a,user_id:own,type:'ACTION',title:'First browser action',state:'TODAY',next_action:'Verify itinerary with supplier',verification_state:'VERIFIED',priority:80},
 {id:b,user_id:own,type:'ACTION',title:'Second browser action',state:'TODAY',next_action:'Prepare internal notes',verification_state:'VERIFIED',priority:40},
 {id:'30000000-0000-4000-8000-000000000003',priority:0,user_id:other,type:'ACTION',title:'Other account private action',state:'TODAY',next_action:'Other task',verification_state:'VERIFIED'}
]);assert.equal(res.error,null);
res=await admin.from('obligation_sources').insert([a,b].map((id)=>({user_id:own,obligation_id:id,source_system:'LOCAL_TEST',source_ref:id,evidence_role:'PRIMARY',claim_scope:['executive_state'],authoritative_claims:['executive_state']})));assert.equal(res.error,null);
const base=cfg.API_URL+'/functions/v1/api/';
for(let i=0;i<45;i++) {try {const r=await fetch(base+'mcc-fast-capture',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(r.status===401)break;if(i===44)throw new Error('Edge API auth did not become ready: '+r.status);}catch(e){if(i===44)throw e;}await new Promise(r=>setTimeout(r,1000));}
const client=createClient(cfg.API_URL,cfg.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const login=await client.auth.signInWithPassword({email:users[0].email,password}); assert.equal(login.error,null);
assert.equal((await client.from('obligations').select('id').eq('user_id',other)).data.length,0);
assert.ok((await client.from('obligations').update({title:'Forbidden browser write'}).eq('id',a)).error);
assert.ok((await client.rpc('mcc_fast_capture',{p_user_id:own,p_request_id:crypto.randomUUID(),p_note:'Forbidden RPC'})).error);
assert.ok((await client.rpc('mcc_review_capture',{p_user_id:own,p_obligation_id:a,p_next_action:'Forbidden review'})).error);
const token=login.data.session.access_token;
const invoke=(route,payload)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(payload)});
const malicious=await invoke('mcc-obligation-action',{obligation_id:(await admin.from('obligations').select('id').eq('user_id',other).single()).data.id,action:'DONE'});
assert.equal(malicious.status,404);
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900}});
const errors=[];const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(u.hostname))await route.continue();else throw new Error('Unexpected outbound network: '+u.hostname);});
await page.goto('http://127.0.0.1:4173/executive');
await page.getByPlaceholder('Email',{exact:true}).fill(users[0].email);await page.getByPlaceholder('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.getByText('First browser action',{exact:true}).waitFor();
await page.getByRole('button',{name:'Focus mode',exact:true}).click();assert.equal(await page.locator('article').count(),1);
await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByText('Second browser action',{exact:true}).waitFor();
assert.equal((await admin.from('obligations').select('state').eq('id',a).single()).data.state,'DONE');
assert.equal((await admin.from('obligation_events').select('id',{count:'exact'}).eq('obligation_id',a).eq('event_type','MANUAL_DONE')).count,1);
await page.getByRole('button',{name:'Undo last change',exact:true}).click();await page.getByText('First browser action',{exact:true}).waitFor();
await page.getByRole('button',{name:'Blocked',exact:true}).click();await page.getByLabel('What is blocking this?').fill('Waiting for supplier information');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Second browser action',{exact:true}).waitFor();
await page.getByRole('button',{name:'Need help',exact:true}).click();await page.getByText(/No eligible action for you right now/).waitFor();
assert.equal((await admin.from('obligations').select('execution_owner').eq('id',b).single()).data.execution_owner,'CHATGPT_PREP');
await page.getByLabel("What's on your mind?").fill('Lois tomorrow — keep this raw note');await page.getByRole('button',{name:'Capture',exact:true}).click();await page.getByText('Captured. Review when ready.',{exact:true}).waitFor();
await page.getByRole('button',{name:'Review captures (1)',exact:true}).click();await page.getByText('Lois tomorrow — keep this raw note',{exact:true}).waitFor();
await page.getByLabel('Confirm one next action').fill('Confirm Moorea transfer details');await page.getByRole('button',{name:"Add to today's actions",exact:true}).click();await page.getByRole('heading',{name:'Confirm Moorea transfer details',exact:true}).waitFor();
const captured=(await admin.from('obligations').select('*').eq('description','Lois tomorrow — keep this raw note').single()).data;
assert.equal(captured.due_at,null);assert.equal(captured.verification_state,'PARTIALLY_VERIFIED');
assert.equal((await admin.from('obligation_events').select('id',{count:'exact'}).eq('obligation_id',captured.id)).count,2);
await page.reload();await page.getByRole('heading',{name:'Confirm Moorea transfer details',exact:true}).waitFor();
fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/phase3b-desktop.png',fullPage:true});
await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/phase3b-mobile.png',fullPage:true});
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile horizontal overflow');
await page.getByRole('button',{name:'Focus mode',exact:true}).click();assert.equal(await page.locator('article').count(),1);
await page.screenshot({path:'test-results/phase3b-mobile-focus.png',fullPage:true});
await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'Sign out',exact:true}).click();
await page.getByPlaceholder('Email',{exact:true}).fill(users[1].email);await page.getByPlaceholder('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.getByText('Other account private action',{exact:true}).waitFor();assert.equal(await page.getByText('Confirm Moorea transfer details',{exact:true}).count(),0);
assert.equal(await page.getByRole('button',{name:'Review captures (0)',exact:true}).count(),1);
assert.deepEqual(errors,[]);
await context.close();await browser.close();client.auth.stopAutoRefresh();admin.auth.stopAutoRefresh();
console.log('PASS: isolated authenticated Supabase → Edge API → database → desktop/mobile browser, audit, refresh and two-user isolation');
