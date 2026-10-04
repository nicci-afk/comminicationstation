// Actual Queue + hooks + Supabase client; all requests intercepted locally.
import { JSDOM } from 'jsdom';
import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/queue?view=awaiting' });
for (const key of ['window', 'document', 'HTMLElement', 'MutationObserver']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const make = n => ({ id: `follow-up-${String(n).padStart(4, '0')}`, state: 'awaiting_reply', title: `Open request ${n}`, channel: 'email', category: 'needs_reply', priority: 100, sender_name: 'Fixture sender', sender_identifier: 'fixture@example.test', preview: 'Local fixture only', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', follow_up_at: '2030-01-02T15:30:00Z', business_id: null });
let rows = [], failRead = false, missingCount = false, partialPage = false, holdRead = null, reads = [];
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'bgpjpomqrnwsdmrofudb.supabase.co');
  assert.notEqual(init.method, 'PATCH', 'Queue status view must remain read-only');
  if (url.pathname.endsWith('/businesses')) return json([{ id: 'business-1', name: 'Fixture business', color: '#555555' }]);
  assert.ok(url.pathname.endsWith('/queue_items'), `Unexpected request blocked: ${url.pathname}`);
  reads.push(url);
  if (holdRead) await holdRead;
  if (failRead) return json({ message: 'Fixture read failure' }, 400);
  assert.match(new Headers(init.headers).get('prefer'), /count=exact/);
  const states = url.searchParams.get('state').slice(4, -1).split(',');
  assert.equal(url.searchParams.get('order'), (states[0] === 'awaiting_reply' ? 'follow_up_at.asc.nullslast,' : '') + 'priority.desc,created_at.desc,id.asc');
  const active = rows.filter(r => states.includes(r.state) && (!url.searchParams.has('business_id') || `eq.${r.business_id}` === url.searchParams.get('business_id')));
  const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'));
  assert.equal(limit, 200);
  if (offset && offset >= active.length) return json({ code: 'PGRST103', message: 'Requested range not satisfiable' }, 416, { 'content-range': `*/${active.length}` });
  const data = active.slice(offset, offset + (partialPage ? 1 : limit));
  return json(data, 200, missingCount ? {} : { 'content-range': `${offset}-${offset + data.length - 1}/${active.length}` });
};
const bundle = await build({ stdin: { contents: `
export {supabase} from './apps/web/src/lib/supabase.ts';
import React from 'react';
import {QueryClient,QueryClientProvider} from './apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import {MemoryRouter,useNavigate} from './apps/web/node_modules/react-router-dom/dist/index.mjs';
import Queue from './apps/web/src/pages/Queue.tsx';
export const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
function View(){const nav=useNavigate();return <><button onClick={()=>nav(-1)}>Fixture Back</button><button onClick={()=>nav(1)}>Fixture Forward</button><Queue/></>}
export default function Fixture(){return <QueryClientProvider client={client}><MemoryRouter initialEntries={['/queue?view=awaiting']}><View/></MemoryRouter></QueryClientProvider>}
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);` }, plugins: [{ name: 'one-react', setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, a => ({ path: process.cwd() + '/node_modules/react/' + (a.path === 'react' ? 'index.js' : a.path.slice(6) + '.js'), external: true })); } }] });
fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/queue-followup-fixture.mjs', bundle.outputFiles[0].text);
const { default: Fixture, client, supabase } = await import('../test-results/queue-followup-fixture.mjs');
const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
function reset(data = []) { cleanup(); client.clear(); rows = data; failRead = missingCount = partialPage = false; holdRead = null; reads = []; }
const mount = () => render(React.createElement(Fixture));
const refresh = () => React.act(async () => { await client.invalidateQueries({ queryKey: ['queue'] }); });
reset(); failRead = true; mount(); await screen.findByText(/Queue unavailable/); assert.equal(screen.queryByText('No items in this view at the last check.'), null);
reset(); mount(); await screen.findByText('No items in this view at the last check.'); failRead = true; await refresh(); await screen.findByText(/Queue refresh failed/); assert.equal(screen.queryByText('No items in this view at the last check.'), null);
reset([make(1), make(2)]); missingCount = true; mount(); await screen.findByText(/Queue unavailable/);
reset([make(1), make(2)]); partialPage = true; mount(); await screen.findByText(/Queue unavailable/);
reset(Array.from({ length: 401 }, (_, i) => make(i + 1))); mount(); await screen.findByText('Showing 1–200 of 401');
assert.equal(screen.queryByRole('button', { name: 'Done', exact: true }), null);
assert.ok(screen.getByText('Reply status and request completion are separate. A reply does not complete an Executive obligation.'));
assert.equal(screen.getAllByRole('link').length, 200);
fireEvent.click(screen.getByRole('button', { name: 'Next page' })); await screen.findByText('Showing 201–400 of 401'); assert.equal(screen.queryByText('Open request 1'), null);
fireEvent.click(screen.getByRole('button', { name: 'Next page' })); await screen.findByText('Showing 401–401 of 401'); assert.ok(screen.getByRole('button', { name: 'Next page' }).disabled);
rows = rows.slice(0, 199); await refresh(); await screen.findByText('Showing 1–199 of 199'); assert.equal(reads.at(-1).searchParams.get('offset'), '0');
rows.push({ ...make(600), state: 'responded', business_id: 'business-1' }, { ...make(601), state: 'dismissed' });
fireEvent.click(screen.getByRole('button', { name: 'Replied / dismissed' })); await screen.findByText('Showing 1–2 of 2'); assert.ok(screen.getByText('Open request 600')); assert.ok(screen.getByText('Open request 601')); assert.ok(screen.getByText('Reply recorded')); assert.ok(screen.getByText('Dismissed from queue'));
fireEvent.click(screen.getByRole('button', { name: 'Fixture Back' })); await screen.findByText('Showing 1–199 of 199'); assert.equal(screen.queryByText('Open request 600'), null);
fireEvent.click(screen.getByRole('button', { name: 'Fixture Forward' })); await screen.findByText('Showing 1–2 of 2');
fireEvent.change(screen.getByRole('combobox'), { target: { value: 'business-1' } }); await screen.findByText('Showing 1–1 of 1'); assert.equal(screen.queryByText('Open request 601'), null);
// A failed first read of a page never fabricates a clear state or traps navigation.
reset(Array.from({ length: 201 }, (_, i) => make(i + 1))); mount(); await screen.findByText('Showing 1–200 of 201'); failRead = true;
fireEvent.click(screen.getByRole('button', { name: 'Next page' })); await screen.findByText(/Queue unavailable/); assert.equal(screen.queryByText('No items in this view at the last check.'), null); assert.ok(!screen.getByRole('button', { name: 'Previous page' }).disabled);
failRead = false; fireEvent.click(screen.getByRole('button', { name: 'Previous page' })); await screen.findByText('Showing 1–200 of 201');
// Due and undated records are visible without claiming an invented check-in date.
reset([{ ...make(1), follow_up_at: null }, { ...make(2), follow_up_at: '2020-01-02T15:30:00Z' }]); mount();
await screen.findByText(/No follow-up date recorded/); assert.ok(screen.getByText(/Follow-up due: 2020-01-02 15:30 UTC/));
cleanup(); client.clear(); supabase.auth.stopAutoRefresh(); await supabase.removeAllChannels(); dom.window.close();
console.log('PASS: read-only follow-up list, exact 401-row pagination, shrink recovery, error/empty integrity, due/undated labels, business filter, Back/Forward and explicit dismissal history');
process.exit(0);
