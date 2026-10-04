import { JSDOM } from 'jsdom';
import { build } from '../apps/web/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost:4173/today' });
for (const key of ['window', 'document', 'HTMLElement', 'MutationObserver']) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const make = (n) => ({ id: `item-${String(n).padStart(4, '0')}`, state: 'needs_attention', title: `Queue action ${n}`, channel: 'email', category: 'needs_reply', priority: 100, sender_name: 'Fixture sender', sender_identifier: 'fixture@example.test', preview: 'Fixture only', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', snoozed_until: null, follow_up_at: null, last_inbound_message_id: null, message_count: 1, priority_reasons: [], business_id: null });
let rows = [], failRead = false, failWrite = false, missingCount = false, partialPage = false, failFirstPage = false, noRow = false, holdRead = null, holdWrite = null, writes = [], reads = [], serial = 0;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'bgpjpomqrnwsdmrofudb.supabase.co');
  if (url.pathname.endsWith('/businesses')) return json([]);
  assert.ok(url.pathname.endsWith('/queue_items'), `Unexpected request blocked: ${url.pathname}`);
  if (init.method === 'PATCH') {
    const patch = JSON.parse(init.body); writes.push({ url, patch });
    if (holdWrite) await holdWrite;
    if (failWrite) return json({ message: 'Test save failure' }, 503);
    const row = rows.find(r => r.id === url.searchParams.get('id')?.slice(3));
    const matches = row && ['state', 'updated_at', 'snoozed_until', 'follow_up_at', 'last_inbound_message_id', 'message_count'].every(k => url.searchParams.get(k) === (row[k] === null ? 'is.null' : `eq.${row[k]}`));
    if (noRow || !matches) return json({ message: 'No matching row', code: 'PGRST116' }, 406);
    Object.assign(row, patch, { updated_at: `2026-10-02T12:00:${String(++serial).padStart(2, '0')}Z` });
    if (row.state === 'responded' && ['needs_reply','urgent','scheduling'].includes(row.category)) {
      row.state = 'awaiting_reply';
      row.follow_up_at ??= '2026-10-06T12:00:00Z';
    }
    return json(row);
  }
  reads.push(url);
  if (holdRead) await holdRead;
  if (failRead) return json({ message: 'Test read failure' }, 503);
  assert.equal(url.searchParams.get('state'), 'eq.needs_attention');
  assert.equal(url.searchParams.get('order'), 'priority.desc,created_at.desc,id.asc');
  assert.match(new Headers(init.headers).get('prefer'), /count=exact/);
  const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit'));
  assert.equal(limit, 200);
  const active = rows.filter(r => r.state === 'needs_attention');
  if (offset > 0 && offset >= active.length) return json({ code: 'PGRST103', message: 'Requested range not satisfiable', details: `An offset of ${offset} was requested, but there are only ${active.length} rows.` }, 416, { 'content-range': `*/${active.length}` });
  if (offset === 0 && failFirstPage) return json({ message: 'First page unavailable' }, 400);
  const data = active.slice(offset, offset + (partialPage ? 1 : limit));
  return json(data, 200, missingCount ? {} : { 'content-range': `${offset}-${offset + data.length - 1}/${active.length}` });
};
const result = await build({ stdin: { contents: `
 export {supabase} from './apps/web/src/lib/supabase.ts';
 import React from 'react';
 import { QueryClient, QueryClientProvider } from './apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
 import { MemoryRouter, Routes, Route, useNavigate, useParams } from './apps/web/node_modules/react-router-dom/dist/index.mjs';
 import Today from './apps/web/src/pages/Today.tsx';
 export const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false,gcTime:0}}});
 function Detail(){const nav=useNavigate(); const {id}=useParams();return <div>Detail: {id}<button onClick={()=>nav(-1)}>Back to Today</button></div>}
 export default function Fixture(){return <QueryClientProvider client={client}><MemoryRouter initialEntries={['/today']}><Routes><Route path='/today' element={<Today/>}/><Route path='/item/:id' element={<Detail/>}/></Routes></MemoryRouter></QueryClientProvider>}
 `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'esm', banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` }, jsx: 'automatic', plugins: [{ name: 'one-react', setup(b) { b.onResolve({ filter: /^react(\/.*)?$/ }, a => ({ path: process.cwd() + '/node_modules/react/' + (a.path === 'react' ? 'index.js' : a.path.slice(6) + '.js'), external: true })); } }] });
fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync('test-results/today-fixture.mjs', result.outputFiles[0].text);
const { default: Fixture, client, supabase } = await import('../test-results/today-fixture.mjs');
const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, configure } = await import('@testing-library/react');
configure({ asyncUtilTimeout: 12000 });
function reset(data = []) { cleanup(); client.clear(); rows = data; failRead = failWrite = missingCount = partialPage = failFirstPage = noRow = false; holdRead = holdWrite = null; writes = []; reads = []; }
const mount = () => render(React.createElement(Fixture));
const fresh = () => screen.findByRole('heading', { name: /^Today: / });
const assertCount = n => assert.ok(screen.getByText(`${n} handled this visit`));
async function refresh() { await React.act(async () => { await client.invalidateQueries({ queryKey: ['queue-page'] }); }); }

// Cold errors and offline/loading never become a fabricated empty success.
reset(); failRead = true; mount(); await screen.findByText(/Queue unavailable/); assert.equal(screen.queryByText('Queue clear'), null); assertCount(0);
reset(); let release; holdRead = new Promise(r => release = r); mount(); await screen.findByText('Loading queue…'); assert.equal(screen.queryByText('Queue clear'), null); await React.act(async () => { holdRead = null; release(); }); await screen.findByText('Queue clear');
// Missing totals and unexpectedly truncated pages fail closed.
reset(); missingCount = true; mount(); await screen.findByText(/Queue unavailable/); assert.equal(screen.queryByText('Queue clear'), null);
reset([make(1), make(2)]); partialPage = true; mount(); await screen.findByText(/Queue unavailable/); assert.equal(screen.queryByText('Queue clear'), null);
// Cached empty and nonempty responses are visibly unconfirmed after a failed refresh.
reset(); mount(); await screen.findByText('Queue clear'); failRead = true; await refresh(); await screen.findByText(/Queue refresh failed/); assert.equal(screen.queryByText('Queue clear'), null);
reset([make(1)]); mount(); await fresh(); failRead = true; await refresh(); assert.ok(screen.getByText('Queue action 1')); assert.ok(screen.getByRole('button', { name: 'Responded', exact: true }).disabled); assert.equal(screen.queryByRole('heading', { name: /^Today: / }), null);
// Older cache is labeled while a refresh is pending; mutation cannot run.
reset([make(1)]); client.setQueryData(['queue-page', 'today', 0], { items: rows, total: 1, page: 0 }, { updatedAt: Date.now() - 120_000 }); holdRead = new Promise(r => release = r); mount(); await screen.findByText(/Refreshing queue/); fireEvent.keyDown(document.body, { key: 'r' }); assert.equal(writes.length, 0); await React.act(async () => { holdRead = null; release(); }); await fresh();
// More than 200 rows: exact total, stable tie-break ordering, nonoverlapping pages.
reset(Array.from({ length: 401 }, (_, i) => make(i + 1))); mount(); await screen.findByRole('heading', { name: 'Today: 401 need attention' }); assert.ok(screen.getByText('Showing 1–200 of 401 items needing attention')); assert.equal(screen.getAllByRole('link').length, 200);
fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText('Showing 201–400 of 401 items needing attention'); assert.equal(screen.queryByText('Queue action 1'), null); assert.ok(screen.getByText('Queue action 201'));
fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText('Showing 401–401 of 401 items needing attention'); assert.ok(screen.getByRole('button', { name: 'Next page', exact: true }).disabled);
// Last-page shrink after a confirmed action re-reads the preceding page, never Queue clear.
fireEvent.click(screen.getByRole('button', { name: 'Dismiss', exact: true })); await screen.findByText('1 handled this visit'); await screen.findByText('Showing 1–200 of 400 items needing attention'); assert.equal(reads.at(-1).searchParams.get('offset'), '0'); assert.equal(screen.queryByText('Queue clear'), null);
// A recovered page must not remain a fresh alias when that page becomes valid again.
rows.push(make(402), make(403)); fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' })); await screen.findByRole('heading', { name: 'Today: 402 need attention' }); fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText('Showing 201–400 of 402 items needing attention'); fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText('Showing 401–402 of 402 items needing attention');
// A first read of another page can fail without trapping read-only navigation.
reset(Array.from({ length: 201 }, (_, i) => make(i + 1))); mount(); await fresh(); failRead = true; fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText(/Queue unavailable/); assert.ok(!screen.getByRole('button', { name: 'Previous page' }).disabled); failRead = false; fireEvent.click(screen.getByRole('button', { name: 'Previous page' })); await fresh(); assert.ok(screen.getByText('Showing 1–200 of 201 items needing attention'));
// A vanished final page recovers only through a successful fresh first-page read.
reset(Array.from({ length: 201 }, (_, i) => make(i + 1))); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Next page', exact: true })); await screen.findByText('Showing 201–201 of 201 items needing attention'); rows = []; failFirstPage = true; await refresh(); await screen.findByText(/Queue refresh failed/); assert.equal(screen.queryByText('Queue clear'), null); assert.ok(!screen.getByRole('button', { name: 'Previous page' }).disabled); failFirstPage = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' })); await screen.findByText('Queue clear'); assert.equal(reads.at(-1).searchParams.get('offset'), '0');
// Inbound content can change without a state/version change. Never act on unseen data.
reset([make(1)]); mount(); await fresh(); rows[0] = { ...rows[0], last_inbound_message_id: 'new-inbound', message_count: 2, preview: 'New unseen message' }; fireEvent.click(screen.getByRole('button', { name: 'Responded', exact: true })); await screen.findByText(/Change unconfirmed/); assertCount(0); assert.equal(rows[0].state, 'needs_attention'); assert.equal(writes[0].url.searchParams.get('last_inbound_message_id'), 'is.null'); assert.equal(writes[0].url.searchParams.get('message_count'), 'eq.1');
// Failure, zero affected rows and rapid clicks never count as completed.
reset([make(1), make(2)]); mount(); await fresh(); failWrite = true; fireEvent.click(screen.getByRole('button', { name: 'Responded', exact: true })); await screen.findByText(/Change unconfirmed/); assertCount(0); assert.equal(rows[0].state, 'needs_attention'); assert.equal(screen.queryByText(/Saved:/), null);
failWrite = false; noRow = true; fireEvent.click(screen.getByRole('button', { name: 'Dismiss', exact: true })); await waitFor(() => assert.equal(writes.length, 2)); await waitFor(() => assert.ok(!screen.queryByText('Saving change…'))); assertCount(0);
noRow = false; holdWrite = new Promise(r => release = r); const respond = screen.getByRole('button', { name: 'Responded', exact: true }); fireEvent.click(respond); fireEvent.click(respond); fireEvent.keyDown(document.body, { key: 'r' }); fireEvent.keyDown(document.body, { key: 'r', repeat: true }); await waitFor(() => assert.equal(writes.length, 3)); assertCount(0);
await React.act(async () => { holdWrite = null; release(); }); await screen.findByText('1 handled this visit'); assert.ok(screen.getByText(/Saved: Queue action 1/)); assert.equal(rows[0].state, 'awaiting_reply'); fireEvent.click(screen.getByRole('button', { name: 'Responded', exact: true }), { detail: 2 }); assert.equal(writes.length, 3, 'second click must not affect the newly revealed item');
// Undo restores the fields this action affected, including the trigger-created follow-up.
fireEvent.click(screen.getByRole('button', { name: 'Undo last change' })); await screen.findByText('Last change undone.'); assertCount(0); assert.equal(rows[0].state, 'needs_attention'); assert.equal(rows[0].follow_up_at, null);
// A newer transition blocks Undo without erasing its receipt or counting success.
fireEvent.click(screen.getByRole('button', { name: 'Snooze 4h' })); await screen.findByText('1 handled this visit'); rows[0].updated_at = '2026-10-02T16:00:00Z'; fireEvent.click(screen.getByRole('button', { name: 'Undo last change' })); await screen.findByText(/Undo unconfirmed/); assertCount(1); assert.equal(rows[0].state, 'snoozed'); assert.ok(screen.getByRole('button', { name: 'Undo last change' }));
// Confirmed save plus failed refetch remains a saved receipt, with a stale queue warning.
reset([make(1)]); mount(); await fresh(); failRead = true; fireEvent.click(screen.getByRole('button', { name: 'Dismiss', exact: true })); await screen.findByText('1 handled this visit'); await screen.findByText(/Queue refresh failed/); assert.equal(screen.queryByText('Queue clear'), null); assert.ok(screen.getByRole('button', { name: 'Dismiss', exact: true }).disabled);
// Keyboard ignores controls/repeats; the clamped current card never duplicates in Up next.
reset([make(1), make(2)]); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Next item' })); rows = [rows[1]]; await refresh(); assert.equal(screen.getAllByText('Queue action 2').length, 1); fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss', exact: true }), { key: 'r' }); fireEvent.keyDown(document.body, { key: 'r', repeat: true }); assert.equal(writes.length, 0);
fireEvent.click(screen.getByRole('button', { name: 'Open & reply' })); await screen.findByText('Detail: item-0002'); fireEvent.keyDown(document.body, { key: 'd' }); assert.equal(writes.length, 0); fireEvent.click(screen.getByRole('button', { name: 'Back to Today' })); await fresh(); assertCount(0); assert.equal(screen.getAllByText('Queue action 2').length, 1);
// Explicit follow-ups use only the date typed, and never create request completion.
reset([make(1)]); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Set follow-up date' }));
assert.equal(screen.getByLabelText('Follow-up date and time (UTC)').value, '', 'no invented default');
assert.ok(screen.getByRole('button', { name: 'Save follow-up' }).disabled);
fireEvent.keyDown(document.body, { key: 'r' }); assert.equal(writes.length, 0, 'shortcuts cannot dismiss an open date form');
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2030-01-02T15:30' } });
fireEvent.click(screen.getByRole('button', { name: 'Cancel follow-up' })); assert.equal(writes.length, 0); assert.equal(screen.queryByLabelText('Follow-up date and time (UTC)'), null);
fireEvent.click(screen.getByRole('button', { name: 'Set follow-up date' }));
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2020-01-02T15:30' } });
fireEvent.click(screen.getByRole('button', { name: 'Save follow-up' })); await screen.findByText('Choose an exact future follow-up date and time in UTC.'); assert.equal(writes.length, 0);
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2030-01-02T15:30' } });
holdWrite = new Promise(r => release = r); const saveFollowUp = screen.getByRole('button', { name: 'Save follow-up' }); fireEvent.click(saveFollowUp); fireEvent.click(saveFollowUp);
await waitFor(() => assert.equal(writes.length, 1)); assertCount(0); assert.ok(screen.getByRole('button', { name: 'Cancel follow-up' }).disabled);
await React.act(async () => { holdWrite = null; release(); }); await screen.findByText('1 handled this visit');
assert.equal(rows[0].state, 'awaiting_reply'); assert.equal(rows[0].follow_up_at, '2030-01-02T15:30:00.000Z'); assert.equal(rows[0].resolved_at, undefined);
assert.ok(screen.getByText(/follow-up remains open/)); assert.ok(screen.getByRole('link', { name: 'View scheduled follow-ups' }));
assert.equal(screen.queryByLabelText('Follow-up date and time (UTC)'), null);
fireEvent.click(screen.getByRole('button', { name: 'Undo last change' })); await screen.findByText('Last change undone.'); assert.equal(rows[0].follow_up_at, null); assert.equal(rows[0].state, 'needs_attention');
// Changing the selected card cancels the pending form rather than applying its date to another request.
reset([make(1), make(2)]); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Set follow-up date' }));
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2030-01-02T15:30' } });
assert.ok(screen.getByRole('button', { name: 'Dismiss', exact: true }).disabled);
fireEvent.click(screen.getByRole('button', { name: 'Next item' })); assert.equal(screen.queryByLabelText('Follow-up date and time (UTC)'), null); assert.equal(writes.length, 0);
// A new inbound while a date is being chosen cannot be hidden by the old form.
reset([make(1)]); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Set follow-up date' }));
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2030-01-02T15:30' } });
rows[0] = { ...rows[0], last_inbound_message_id: 'newer-message', message_count: 2 };
fireEvent.click(screen.getByRole('button', { name: 'Save follow-up' })); await screen.findByText(/Change unconfirmed/); assertCount(0); assert.equal(rows[0].state, 'needs_attention'); assert.equal(rows[0].follow_up_at, null);
// A server failure leaves the date editable; an explicit retry reuses the same date.
reset([make(1)]); mount(); await fresh(); fireEvent.click(screen.getByRole('button', { name: 'Set follow-up date' }));
fireEvent.change(screen.getByLabelText('Follow-up date and time (UTC)'), { target: { value: '2030-01-02T15:30' } }); failWrite = true;
fireEvent.click(screen.getByRole('button', { name: 'Save follow-up' })); await screen.findByText(/Change unconfirmed/); assertCount(0); assert.equal(screen.getByLabelText('Follow-up date and time (UTC)').value, '2030-01-02T15:30');
failWrite = false; fireEvent.click(screen.getByRole('button', { name: 'Save follow-up' })); await screen.findByText('1 handled this visit'); assert.equal(writes.length, 2); assert.equal(rows[0].follow_up_at, '2030-01-02T15:30:00.000Z');
cleanup(); client.clear(); supabase.auth.stopAutoRefresh(); await supabase.removeAllChannels(); dom.window.close();
console.log('PASS: Today loading/error/empty/stale/partial states; exact 401-row pagination, wire-faithful 416 shrink/recovery, unseen inbound CAS; confirmed writes, duplicate-click guards, conflict-safe Undo, stale-after-save, navigation and keyboard regression');
process.exit(0);
