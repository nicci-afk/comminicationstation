// Local-only browser fixture: actual Today, hooks and Supabase client; all
// database traffic is intercepted. No real session, writes or services used.
import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
const dir = 'test-results/today-browser'; fs.mkdirSync(dir, { recursive: true });
await build({ stdin: { contents: `
 import React from 'react'; import {createRoot} from './apps/web/node_modules/react-dom/client.js';
 import {QueryClient,QueryClientProvider} from './apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
 import {BrowserRouter,Routes,Route,Link} from './apps/web/node_modules/react-router-dom/dist/index.mjs';
 import Today from './apps/web/src/pages/Today.tsx';
 import Queue from './apps/web/src/pages/Queue.tsx';
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter><Routes><Route path='/today' element={<Today/>}/><Route path='/queue' element={<Queue/>}/><Route path='/item/:id' element={<div><h1>Fixture detail</h1><Link to='/today'>Back to Today</Link></div>}/></Routes></BrowserRouter></QueryClientProvider>);
 `, resolveDir: process.cwd(), loader: 'tsx' }, outfile: `${dir}/fixture.js`, bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'local-config', setup(b) {
   b.onResolve({ filter: /^\.\/config$/ }, () => ({ path: 'local-config', namespace: 'fixture' }));
   b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const SUPABASE_URL="http://127.0.0.1:4177"; export const SUPABASE_ANON_KEY="local-fixture"; export const API_BASE=SUPABASE_URL;' }));
 } }] });
const css = fs.readdirSync('apps/web/dist/assets').find(f => f.endsWith('.css'));
fs.copyFileSync(`apps/web/dist/assets/${css}`, `${dir}/style.css`);
fs.writeFileSync(`${dir}/index.html`, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
const server = http.createServer((req, res) => { const file = req.url === '/fixture.js' ? 'fixture.js' : req.url === '/style.css' ? 'style.css' : 'index.html'; res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(`${dir}/${file}`)); });
await new Promise(r => server.listen(4177, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
let readFailure = false, saveFailure = false, writes = 0, version = 0;
let rows = Array.from({ length: 201 }, (_, i) => ({ id: `item-${i + 1}`, title: `Fixture queue action ${i + 1}`, preview: 'Fixture only. This is not a real message.', channel: 'email', category: 'possible_supplier', priority: 100, sender_name: 'Long example sender name for mobile readability', sender_identifier: 'fixture@example.test', state: 'needs_attention', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', snoozed_until: null, follow_up_at: null, last_inbound_message_id: null, message_count: 1, priority_reasons: ['Explicit fixture reason'], business_id: 'business' }));
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
 const req = route.request(), url = new URL(req.url()); assert.equal(url.hostname, '127.0.0.1', 'External request blocked');
 const fulfill = (body, status = 200, extra = {}) => route.fulfill({ status, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
 if (url.pathname === '/rest/v1/businesses') return fulfill([{ id: 'business', name: 'Business name', color: '#4f46e5' }]);
 if (url.pathname === '/rest/v1/queue_items') {
  if (req.method() === 'PATCH') {
   writes++; if (saveFailure) return fulfill({ message: 'Fixture save failure' }, 400);
   const row = rows.find(r => `eq.${r.id}` === url.searchParams.get('id')); const patch = req.postDataJSON();
   if (!row || !['state', 'updated_at', 'snoozed_until', 'follow_up_at', 'last_inbound_message_id', 'message_count'].every(k => url.searchParams.get(k) === (row[k] === null ? 'is.null' : `eq.${row[k]}`))) return fulfill({ message: 'Conflict' }, 406);
   Object.assign(row, patch, { updated_at: `2026-10-02T12:00:${String(++version).padStart(2, '0')}Z` }); if (row.state === 'responded' && ['needs_reply','urgent','scheduling'].includes(row.category)) { row.state = 'awaiting_reply'; row.follow_up_at ??= '2026-10-06T12:00:00Z'; } return fulfill(row);
  }
  if (readFailure) return fulfill({ message: 'Fixture queue failure' }, 400);
  const stateFilter = url.searchParams.get('state');
  const states = stateFilter.startsWith('eq.') ? [stateFilter.slice(3)] : stateFilter.slice(4, -1).split(',');
  const active = rows.filter(r => states.includes(r.state)); const offset = Number(url.searchParams.get('offset') || 0); const list = active.slice(offset, offset + Number(url.searchParams.get('limit')));
  if (offset > 0 && offset >= active.length) return fulfill({ code: 'PGRST103', message: 'Requested range not satisfiable' }, 416, { 'content-range': `*/${active.length}` });
  return fulfill(list, 200, { 'content-range': `${offset}-${offset + list.length - 1}/${active.length}` });
 }
 return route.continue();
});
try {
 await page.goto('http://127.0.0.1:4177/today'); await page.getByRole('heading', { name: 'Today: 201 need attention' }).waitFor();
 await page.screenshot({ path: 'test-results/phase3b-today-mobile-ready.png' });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile queue horizontal overflow');
 saveFailure = true; await page.getByRole('button', { name: 'Responded', exact: true }).click(); await page.getByText(/Change unconfirmed/).waitFor(); assert.equal(await page.getByText('0 handled this visit').count(), 1);
 saveFailure = false; await page.getByRole('button', { name: 'Snooze 4h', exact: true }).dblclick(); await page.getByText('1 handled this visit').waitFor(); assert.equal(writes, 2);
 await page.getByRole('button', { name: 'Undo last change' }).click(); await page.getByText('Last change undone.').waitFor();
 readFailure = true; await page.getByRole('button', { name: 'Refresh queue' }).click(); await page.getByText(/Queue refresh failed/).waitFor(); assert.equal(await page.getByText('Queue clear', { exact: true }).count(), 0);
 await page.screenshot({ path: 'test-results/phase3b-today-mobile-stale.png' }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile stale horizontal overflow');
 readFailure = false; await page.getByRole('button', { name: 'Refresh queue' }).click(); await page.getByRole('heading', { name: 'Today: 201 need attention' }).waitFor();
 await page.getByRole('button', { name: 'Next page', exact: true }).click(); await page.getByText('Showing 201–201 of 201 items needing attention').waitFor();
 await page.getByRole('button', { name: 'Open & reply' }).click(); await page.getByRole('heading', { name: 'Fixture detail' }).waitFor(); await page.goBack(); await page.getByRole('heading', { name: 'Today: 201 need attention' }).waitFor();
 await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: 'test-results/phase3b-today-desktop-ready.png' }); assert.deepEqual(errors, []);
 // Canonical reply normalization keeps the request open and reachable by its stored date.
 rows = [{ ...rows[0], state: 'needs_attention', category: 'needs_reply', follow_up_at: '2030-01-02T15:30:00Z' }];
 await page.goto('http://127.0.0.1:4177/today'); await page.getByRole('heading', { name: 'Today: 1 needs attention' }).waitFor();
 await page.getByRole('button', { name: 'Responded', exact: true }).click(); await page.getByText('1 handled this visit').waitFor();
 assert.equal(rows[0].state, 'awaiting_reply'); assert.equal(rows[0].follow_up_at, '2030-01-02T15:30:00Z');
 await page.getByText(/follow-up remains open/).waitFor(); await page.getByRole('link', { name: 'View scheduled follow-ups' }).click();
 await page.getByText('Showing 1–1 of 1').waitFor(); await page.getByText(/Follow-up scheduled: 2030-01-02 15:30 UTC/).waitFor();
 assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).count(), 0);
 await page.screenshot({ path: 'test-results/followup-desktop-list.png', fullPage: true });
 // Reopening Today, canceling a form and Back cannot submit a pending date.
 rows[0] = { ...rows[0], state: 'needs_attention', follow_up_at: null };
 await page.goto('http://127.0.0.1:4177/today'); await page.getByRole('heading', { name: 'Today: 1 needs attention' }).waitFor();
 await page.setViewportSize({ width: 390, height: 844 });
 await page.getByRole('button', { name: 'Set follow-up date' }).click();
 assert.equal(await page.getByLabel('Follow-up date and time (UTC)').inputValue(), '');
 await page.getByLabel('Follow-up date and time (UTC)').fill('2030-02-03T16:45');
 await page.screenshot({ path: 'test-results/followup-mobile-form.png', fullPage: true });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile follow-up form horizontal overflow');
 const beforeCancel = writes; await page.getByRole('button', { name: 'Cancel follow-up' }).click(); assert.equal(writes, beforeCancel);
 await page.getByRole('button', { name: 'Set follow-up date' }).click(); await page.getByLabel('Follow-up date and time (UTC)').fill('2030-02-03T16:45');
 await page.getByRole('button', { name: 'Save follow-up' }).dblclick(); await page.getByText('1 handled this visit').waitFor();
 assert.equal(writes, beforeCancel + 1); assert.equal(rows[0].state, 'awaiting_reply'); assert.equal(rows[0].follow_up_at, '2030-02-03T16:45:00.000Z');
 await page.getByRole('button', { name: 'Undo last change' }).click(); await page.getByText('Last change undone.').waitFor(); assert.equal(rows[0].follow_up_at, null);
 await page.getByRole('button', { name: 'Set follow-up date' }).click(); await page.getByLabel('Follow-up date and time (UTC)').fill('2030-02-03T16:45');
 rows[0] = { ...rows[0], last_inbound_message_id: 'new-unseen-message', message_count: 2 };
 await page.getByRole('button', { name: 'Save follow-up' }).click(); await page.getByText(/Change unconfirmed/).waitFor();
 assert.equal(rows[0].state, 'needs_attention'); assert.equal(rows[0].follow_up_at, null);
 await page.getByRole('button', { name: 'Cancel follow-up' }).click(); await page.getByRole('button', { name: 'Open & reply' }).click();
 await page.getByRole('heading', { name: 'Fixture detail' }).waitFor(); await page.goBack(); await page.getByRole('heading', { name: 'Today: 1 needs attention' }).waitFor();
 assert.equal(await page.getByLabel('Follow-up date and time (UTC)').count(), 0);
 assert.deepEqual(errors, []);
 console.log('PASS: isolated Chromium desktop/mobile, 201-row pagination, failed write, double click, Undo, stale refresh, Back navigation; normalized reply stays open; explicit UTC follow-up, cancel, duplicate save and unseen-inbound conflict; no overflow or uncaught errors');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
