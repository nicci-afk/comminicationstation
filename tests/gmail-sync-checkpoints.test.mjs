import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = fs.existsSync(path.join(ROOT, 'candidate/workers/gmail-sync-worker.ts'));
const measured = [];
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const initial = { kind: 'incremental', gmail_account_id: ACCOUNT };
const message = id => ({ id, threadId: `thread-${id}`, internalDate: '1790966400000', labelIds: ['INBOX'], payload: { headers: [
  { name: 'From', value: 'sender@example.invalid' }, { name: 'To', value: 'owner@example.invalid' },
  { name: 'Subject', value: 'Synthetic sync fixture' },
] } });
const record = (id, ids, extras = {}) => ({ id: String(id), messagesAdded: ids.map(id => ({ message: { id } })), ...extras });
const page = (records, nextPageToken, historyId = '1000') => ({ history: records, historyId, ...(nextPageToken ? { nextPageToken } : {}) });
const ok = data => ({ data, error: null });
const fail = message => ({ data: null, error: { message } });

// Execute the exact worker, Gmail parsing/OAuth helpers, and queue auth/ack
// wrapper in a VM. Only PostgREST/RPC, time, and HTTP boundaries are simulated.
// No production endpoints, sockets, installed dependencies, or real secrets.
async function fixture(options = {}, variant = 'candidate') {
  const opt = { pages: { first: page([record('101', ['a'])]) }, ...options };
  const state = {
    now: Date.parse('2026-10-02T19:00:00Z'),
    account: { id: ACCOUNT, user_id: 'fixture-owner', email_address: 'owner@example.invalid', status: 'active',
      refresh_token_secret_id: 'fixture-refresh', last_history_id: '100', sync_locked_at: null,
      last_sync_at: null, last_error: null, backfill_done: true, ...opt.account },
    messages: new Map(), queueItems: new Map(), enqueued: [], trace: [], logs: [], acks: [], claims: [],
  };
  for (const id of opt.existing ?? []) {
    state.messages.set(id, { id: `db-${id}`, thread_id: `thread-${id}` });
    state.queueItems.set(`thread-${id}`, { thread_id: `thread-${id}`, state: 'needs_attention', last_inbound_message_id: `db-${id}` });
  }
  if (opt.measure) measured.push({ name: opt.measure, state });
  const hook = async (event) => opt.hook?.(event, state);
  const same = (a, b) => a == null || b == null ? a == b : String(a) === String(b);
  const db = {
    from(table) {
      const q = { table, kind: 'query', operation: 'select', filters: [] };
      const execute = async () => {
        state.trace.push(structuredClone(q));
        const injected = await hook({ phase: 'before', ...q });
        if (injected) return injected;
        let result;
        if (table === 'gmail_accounts') {
          let matches = q.filters.every(([op, col, val]) => {
            if (op === 'eq' || op === 'is') return same(state.account[col], val);
            if (op === 'lt') return state.account[col] != null && Date.parse(state.account[col]) < Date.parse(val);
            if (op === 'or') return state.account.sync_locked_at == null || Date.parse(state.account.sync_locked_at) < state.now - 180_000;
            throw new Error(`Unmocked account filter: ${op}`);
          });
          if (!matches) result = ok(null);
          else {
            if (q.operation === 'update') Object.assign(state.account, q.payload);
            result = ok(structuredClone(state.account));
          }
        } else if (table === 'messages') {
          assert(q.filters.some(([op, col, val]) => op === 'eq' && col === 'gmail_account_id' && val === ACCOUNT));
          const id = q.filters.find(x => x[1] === 'provider_message_id')?.[2];
          result = ok(state.messages.get(id) ?? null);
        } else if (table === 'queue_items') {
          const thread = q.filters.find(x => x[1] === 'thread_id')?.[2];
          const item = state.queueItems.get(thread);
          const allowed = q.filters.find(x => x[0] === 'in' && x[1] === 'state')?.[2];
          if (item && allowed.includes(item.state) && q.filters.every(([op, col, value]) => op !== 'eq' || same(item[col], value))) Object.assign(item, q.payload);
          result = ok(null);
        } else throw new Error(`Unmocked table: ${table}`);
        const after = await hook({ phase: 'after', ...q });
        return after ?? result;
      };
      let proxy;
      proxy = new Proxy({}, { get(_target, name) {
        if (name === 'then') return (resolve, reject) => execute().then(resolve, reject);
        if (name === 'maybeSingle' || name === 'single') return execute;
        return (...args) => {
          if (name === 'update') { q.operation = name; q.payload = args[0]; }
          else if (name === 'select') q.columns = args[0];
          else q.filters.push([name, ...args]);
          return proxy;
        };
      } });
      return proxy;
    },
    async rpc(name, args) {
      const call = { kind: 'rpc', name, args: structuredClone(args) };
      state.trace.push(call);
      const before = await hook({ phase: 'before', ...call });
      if (before) return before;
      let result;
      if (name === 'claim_jobs') result = ok(state.claims.splice(0, 3));
      else if (name === 'ack_job') { state.acks.push(args.p_msg_id); result = ok(null); }
      else if (name === 'vault_read_secret') result = ok('synthetic-fixture-value');
      else if (name === 'get_app_config') result = ok(args.p_key === 'google_client_id' ? { value: 'fixture-client' } : { id: 'fixture-id' });
      else if (name === 'ingest_email_message') {
        assert.equal(args.p_gmail_account_id, ACCOUNT);
        const id = args.p.provider_message_id;
        if (state.messages.has(id)) result = ok({ status: 'duplicate' });
        else {
          const thread = args.p.thread_provider_id;
          state.messages.set(id, { id: `db-${id}`, thread_id: thread, payload: structuredClone(args.p) });
          state.queueItems.set(thread, { thread_id: thread, state: 'needs_attention', last_inbound_message_id: `db-${id}` });
          result = ok({ status: 'ok', message_id: `db-${id}`, needs_model_triage: !!opt.triage });
        }
      } else if (name === 'enqueue_and_poke') {
        state.enqueued.push({ queue: args.p_queue, message: structuredClone(args.p_msg) }); result = ok(1);
      } else if (name === 'dead_letter_job') { result = ok(null); }
      else throw new Error(`Unmocked RPC: ${name}`);
      const after = await hook({ phase: 'after', ...call });
      return after ?? result;
    },
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const context = vm.createContext({
    Request, Response, URL, URLSearchParams, TextEncoder, crypto: webcrypto, Date: FakeDate,
    Deno: { env: { get: name => ({ SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only', WORKER_SECRET: 'fixture-worker' })[name] } },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [level, (...args) => state.logs.push({ level, args: args.map(x => String(x)) })])),
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const event = { kind: 'fetch', path: u.pathname, search: u.search, method: init.method ?? 'GET' };
      state.trace.push(event);
      const before = await hook({ phase: 'before', ...event });
      if (before instanceof Response) return before;
      let value;
      if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') value = { access_token: 'fixture-access' };
      else if (u.hostname === 'gmail.googleapis.com' && u.pathname === '/gmail/v1/users/me/history') {
        const key = u.searchParams.get('pageToken') ?? 'first';
        value = typeof opt.pages === 'function' ? await opt.pages(u, state) : opt.pages[key];
        assert.ok(value, `Unexpected history page ${key}`);
      } else if (u.hostname === 'gmail.googleapis.com' && u.pathname.startsWith('/gmail/v1/users/me/messages/')) {
        const id = u.pathname.split('/').at(-1);
        value = opt.messages?.[id] ?? message(id);
      } else throw new Error(`Unexpected network request: ${u.origin}${u.pathname}`);
      const after = await hook({ phase: 'after', ...event });
      if (after instanceof Response) return after;
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
  });
  const modules = new Map();
  const supabase = new vm.SyntheticModule(['createClient', 'SupabaseClient'], function () {
    this.setExport('createClient', () => db); this.setExport('SupabaseClient', class {});
  }, { context });
  modules.set('@supabase/supabase-js', supabase);
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    // Node's syntax-only stripper retains legacy non-type imports. Supply
    // inert interface exports for the unchanged deployed TypeScript modules.
    const typeExports = file.endsWith('/_shared/gmail.ts') ? '\nexport const GmailAccountRow = null, GmailMessageLite = null;' :
      file.endsWith('/_shared/util.ts') ? '\nexport const Job = null;' : '';
    const sourceFile = !BUNDLED && !fs.existsSync(file) && file.includes('/workers/_shared/')
      ? file.replace('/workers/_shared/', '/api/_shared/') : file;
    const source = fs.readFileSync(sourceFile, 'utf8') + typeExports;
    const m = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: 'strip' }), { context, identifier: file });
    modules.set(file, m); return m;
  }
  const workerFile = BUNDLED ? path.join(ROOT, variant, 'workers/gmail-sync-worker.ts') :
    variant === 'baseline' ? path.join(ROOT, 'tests/fixtures/mcc-sync/workers-v17-gmail-sync-worker.ts') :
    path.join(ROOT, 'supabase/functions/workers/gmail-sync-worker.ts');
  const worker = load(workerFile);
  await worker.link((specifier, parent) => {
    const directory = !BUNDLED && parent.identifier.endsWith('/fixtures/mcc-sync/workers-v17-gmail-sync-worker.ts')
      ? path.join(ROOT, 'supabase/functions/workers') : path.dirname(parent.identifier);
    return load(specifier.startsWith('.') ? path.resolve(directory, specifier) : specifier);
  });
  await worker.evaluate();
  let jobId = 0;
  async function run(job = initial, readCt = 1) {
    const id = ++jobId, before = state.enqueued.length;
    state.claims.push({ msg_id: id, read_ct: readCt, message: structuredClone(job) });
    const response = await worker.namespace.default(new Request('https://fixture.invalid/gmail-sync-worker', {
      method: 'POST', headers: { 'x-worker-secret': 'fixture-worker' },
    }));
    assert.equal(response.status, 200);
    return { id, acked: state.acks.includes(id), enqueued: state.enqueued.slice(before) };
  }
  const count = (kind, name) => state.trace.filter(x => x.kind === kind && (name == null || x.name === name || x.path === name)).length;
  return { state, opt, run, count };
}

const syncContinuation = run => {
  const jobs = run.enqueued.filter(x => x.queue === 'sync_jobs');
  assert.equal(jobs.length, 1);
  return jobs[0].message;
};
const ids = f => [...f.state.messages.keys()].sort();
const checkpoints = f => f.state.trace.filter(x => x.kind === 'query' && x.payload?.last_history_id !== undefined);

// Prove the harness catches the deployed data-loss bug, not just the fix.
test('deployed baseline loses the second page on time-budget cutoff', async () => {
  const f = await fixture({ pages: u => u.searchParams.get('startHistoryId') === '1000'
    ? page([]) : page([record('101', ['a'])], 'page-2'),
    hook(e, s) { if (e.phase === 'after' && e.name === 'ingest_email_message') s.now += 90_001; },
  }, 'baseline');
  const first = await f.run();
  assert.equal(String(f.state.account.last_history_id), '1000');
  const continuation = syncContinuation(first);
  assert.equal(continuation.history_cursor, undefined);
  await f.run(continuation);
  assert.deepEqual(ids(f), ['a']);
});

test('multi-page interruption after committed write resumes next page without advancing checkpoint', async () => {
  const f = await fixture({ measure: 'two pages, time cutoff after first commit', pages: { first: page([record('101', ['a'])], 'page-2'), 'page-2': page([record('102', ['b'])]) },
    triage: true, hook(e, s) { if (e.phase === 'after' && e.name === 'ingest_email_message') s.now += 90_001; },
  });
  const first = await f.run();
  assert.equal(first.acked, true);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.state.account.last_sync_at, null);
  const continuation = syncContinuation(first);
  assert.deepEqual(continuation.history_cursor, { start_history_id: '100', page_token: 'page-2', token_restarts: 0 });
  assert.equal((await f.run(continuation)).acked, true);
  assert.deepEqual(ids(f), ['a', 'b']);
  assert.equal(f.state.account.last_history_id, '1000');
  assert.equal(checkpoints(f).length, 1);
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 2);
  assert.equal(f.count('rpc', 'ingest_email_message'), 2);
  assert.equal(f.state.enqueued.filter(x => x.queue === 'triage_jobs').length, 2);
});

test('cutoff before first message write resumes same page with zero skipped operations', async () => {
  let delay = true;
  const f = await fixture({ hook(e, s) {
    if (delay && e.phase === 'after' && e.path === '/gmail/v1/users/me/history') { delay = false; s.now += 90_001; }
  } });
  const first = await f.run();
  assert.deepEqual(ids(f), []);
  const job = syncContinuation(first);
  assert.equal(job.history_cursor.next_operation, 0);
  assert.equal(job.history_cursor.page_digest.length, 64);
  assert.equal((await f.run(job)).acked, true);
  assert.deepEqual(ids(f), ['a']);
});

test('mid-page resumes in constant space and does not refetch already committed message metadata', async () => {
  const f = await fixture({ measure: 'one page, cutoff after each of three messages', pages: { first: page([record('101', ['a', 'b', 'c'])]) }, hook(e, s) {
    if (e.phase === 'after' && e.name === 'ingest_email_message') s.now += 90_001;
  } });
  let result = await f.run();
  for (let i = 0; i < 2; i++) {
    const job = syncContinuation(result);
    assert.ok(JSON.stringify(job).length < 350);
    assert.equal(job.history_cursor.next_operation, i + 1);
    assert.equal(f.state.account.last_history_id, '100');
    result = await f.run(job);
  }
  assert.deepEqual(ids(f), ['a', 'b', 'c']);
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 3);
  assert.equal(f.count('rpc', 'ingest_email_message'), 3);
  assert.equal(f.state.account.last_history_id, '1000');
});

test('duplicate/reordered records and operation order preserve cursor fingerprint and unique IDs', async () => {
  let requests = 0;
  const f = await fixture({ measure: 'reordered duplicate records, cutoff after each message', pages: () => ++requests === 1
    ? page([record('102', ['c']), record('101', ['b', 'a', 'a']), record('101', ['a'])])
    : page([record('101', ['a']), record('101', ['a', 'b']), record('102', ['c'])]),
    hook(e, s) { if (e.phase === 'after' && e.name === 'ingest_email_message') s.now += 90_001; },
  });
  let result = await f.run();
  for (let i = 0; i < 2; i++) result = await f.run(syncContinuation(result));
  assert.deepEqual(ids(f), ['a', 'b', 'c']);
  assert.equal(f.count('rpc', 'ingest_email_message'), 3);
  assert.equal(f.state.account.last_history_id, '1000');
});

test('changed page invalidates saved offset and safely replays through provider-ID dedupe', async () => {
  let requests = 0, delayed = false;
  const f = await fixture({ measure: 'changed page contents invalidate offset', pages: () => ++requests === 1 ? page([record('101', ['b', 'c'])]) : page([record('101', ['a', 'b', 'c'])]),
    hook(e, s) { if (!delayed && e.phase === 'after' && e.name === 'ingest_email_message') { delayed = true; s.now += 90_001; } },
  });
  const first = await f.run();
  await f.run(syncContinuation(first));
  assert.deepEqual(ids(f), ['a', 'b', 'c']);
  assert.equal(f.count('rpc', 'ingest_email_message'), 4);
  assert.equal(f.state.account.last_history_id, '1000');
});

for (const phase of ['before', 'after']) test(`ingest database failure ${phase} commit retries without missing or duplicate IDs`, async () => {
  let failed = false;
  const f = await fixture({ pages: { first: page([record('101', ['a', 'b'])]) }, hook(e) {
    if (!failed && e.phase === phase && e.name === 'ingest_email_message') { failed = true; return fail('fixture ingest failure'); }
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(checkpoints(f).length, 0);
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.deepEqual(ids(f), ['a', 'b']);
  assert.equal(f.state.account.last_history_id, '1000');
});

for (const phase of ['before', 'after']) test(`checkpoint database failure ${phase} commit is safe on queue redelivery`, async () => {
  let failed = false;
  const f = await fixture({ pages: u => u.searchParams.get('startHistoryId') === '1000' ? page([]) : page([record('101', ['a'])]), hook(e) {
    if (!failed && e.phase === phase && e.table === 'gmail_accounts' && e.payload?.last_history_id) { failed = true; return fail('fixture checkpoint failure'); }
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.last_history_id, phase === 'before' ? '100' : '1000');
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.deepEqual(ids(f), ['a']);
});

for (const phase of ['before', 'after']) test(`continuation enqueue failure ${phase} commit keeps source checkpoint and tolerates duplicate jobs`, async () => {
  let failed = false, delayed = false;
  const f = await fixture({ pages: u => u.searchParams.get('startHistoryId') === '1000' ? page([])
    : u.searchParams.get('pageToken') ? page([record('102', ['b'])]) : page([record('101', ['a'])], 'next'),
    hook(e, s) {
      if (!delayed && e.phase === 'after' && e.name === 'ingest_email_message') { delayed = true; s.now += 90_001; }
      if (!failed && e.phase === phase && e.name === 'enqueue_and_poke') { failed = true; return fail('fixture enqueue failure'); }
    },
  });
  const first = await f.run();
  assert.equal(first.acked, false);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal((await f.run(initial, 2)).acked, true);
  for (const job of first.enqueued) await f.run(job.message);
  assert.deepEqual(ids(f), ['a', 'b']);
  assert.equal(f.state.account.last_history_id, '1000');
});

test('stale continuation uses newer durable checkpoint rather than its old page token', async () => {
  const f = await fixture({ account: { last_history_id: '500' }, pages: u => {
    assert.equal(u.searchParams.get('startHistoryId'), '500');
    assert.equal(u.searchParams.get('pageToken'), null);
    return page([record('501', ['new'])], undefined, '600');
  } });
  await f.run({ ...initial, history_cursor: { start_history_id: '100', page_token: 'obsolete', page_digest: 'obsolete', next_operation: 999 } });
  assert.deepEqual(ids(f), ['new']);
  assert.equal(f.state.account.last_history_id, '600');
});

for (const status of [400, 404]) test(`expired page token ${status} restarts baseline once without a profile reset`, async () => {
  const f = await fixture({ pages: u => u.searchParams.get('pageToken') ? new Response('expired pagination hint', { status }) : page([record('101', ['a'])]) });
  const first = await f.run({ ...initial, history_cursor: { start_history_id: '100', page_token: 'expired' } });
  assert.equal(f.state.account.last_history_id, '100');
  const job = syncContinuation(first);
  assert.deepEqual(job.history_cursor, { start_history_id: '100', token_restarts: 1 });
  await f.run(job);
  assert.deepEqual(ids(f), ['a']);
  assert.equal(f.state.account.last_history_id, '1000');
});

test('expired history stops visibly without fetching/replaying messages or advancing checkpoint', async () => {
  const f = await fixture({ pages: () => new Response('History expired', { status: 404 }) });
  assert.equal((await f.run()).acked, true);
  assert.equal(f.state.account.status, 'error');
  assert.match(f.state.account.last_error, /coverage is incomplete.*Approved full reconciliation/);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.state.account.last_sync_at, null);
  assert.equal(f.state.enqueued.length, 0);
  assert.deepEqual(ids(f), []);
  assert.equal(f.state.account.sync_locked_at, null);
});

test('legacy full_resync jobs cannot execute the unsafe seven-day/one-page reset', async () => {
  const f = await fixture();
  await f.run({ ...initial, kind: 'full_resync' });
  assert.equal(f.state.account.status, 'error');
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.count('fetch'), 1, 'only fixture OAuth refresh, no Gmail replay/profile reset');
});

test('revoked OAuth marks account errored and unlocks without a cursor change', async () => {
  const f = await fixture({ hook(e) {
    if (e.phase === 'before' && e.path === '/token') return new Response('{"error":"invalid_grant"}', { status: 400 });
  } });
  assert.equal((await f.run()).acked, true);
  assert.equal(f.state.account.status, 'error');
  assert.match(f.state.account.last_error, /invalid_grant/);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.state.account.sync_locked_at, null);
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 0);
});

test('Gmail 401 keeps checkpoint unchanged and job retryable', async () => {
  const f = await fixture({ pages: () => new Response('Unauthorized', { status: 401 }) });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.state.account.status, 'active');
  assert.match(f.state.account.last_error, /401/);
});

test('lock read failure is not acknowledged as successful work', async () => {
  const f = await fixture({ hook(e) {
    if (e.phase === 'before' && e.table === 'gmail_accounts' && e.payload?.sync_locked_at) return fail('fixture lock failure');
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.count('fetch'), 0);
});

const lockAttempts = f => f.state.trace.filter(e => e.table === 'gmail_accounts' && e.payload?.sync_locked_at);
test('unlocked account is acquired by one atomic IS NULL update', async () => {
  const f = await fixture();
  assert.equal((await f.run()).acked, true);
  assert.equal(lockAttempts(f).length, 1);
  assert.deepEqual(lockAttempts(f)[0].filters, [['eq', 'id', ACCOUNT], ['is', 'sync_locked_at', null]]);
});

test('expired account is acquired by a second atomic LT update', async () => {
  const f = await fixture({ account: { sync_locked_at: '2026-10-02T18:56:59.000Z' } });
  assert.equal((await f.run()).acked, true);
  const attempts = lockAttempts(f);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].filters, [['eq', 'id', ACCOUNT], ['is', 'sync_locked_at', null]]);
  assert.deepEqual(attempts[1].filters, [['eq', 'id', ACCOUNT], ['lt', 'sync_locked_at', '2026-10-02T18:57:00.000Z']]);
  assert.equal(attempts[0].payload.sync_locked_at, attempts[1].payload.sync_locked_at);
  assert.equal(f.state.account.sync_locked_at, null);
  assert.deepEqual(ids(f), ['a']);
});

test('failed expired-lock attempt stays retryable without provider work', async () => {
  const prior = '2026-10-02T18:56:59.000Z';
  const f = await fixture({ account: { sync_locked_at: prior }, hook(e) {
    if (e.phase === 'before' && e.table === 'gmail_accounts' && e.filters.some(([op]) => op === 'lt')) return fail('expired lock failure');
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(lockAttempts(f).length, 2);
  assert.equal(f.state.account.sync_locked_at, prior);
  assert.equal(f.count('fetch'), 0);
});

test('replacement acquired between lock attempts cannot be stolen', async () => {
  const replacement = '2026-10-02T19:00:00.001Z';
  const f = await fixture({ account: { sync_locked_at: '2026-10-02T18:56:59.000Z' }, hook(e, s) {
    if (e.phase === 'after' && e.table === 'gmail_accounts' && e.filters.some(([op, col]) => op === 'is' && col === 'sync_locked_at')) s.account.sync_locked_at = replacement;
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(lockAttempts(f).length, 2);
  assert.equal(f.state.account.sync_locked_at, replacement);
  assert.equal(f.count('fetch'), 0);
});

test('uncertain committed lock response prevents fallback or provider work', async () => {
  const f = await fixture({ hook(e) {
    if (e.phase === 'after' && e.table === 'gmail_accounts' && e.payload?.sync_locked_at) return fail('connection lost after lock commit');
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(lockAttempts(f).length, 1);
  assert.equal(f.state.account.sync_locked_at, '2026-10-02T19:00:00.000Z');
  assert.equal(f.count('fetch'), 0);
});

test('contended lock preserves continuation job instead of discarding it', async () => {
  const f = await fixture({ account: { sync_locked_at: '2026-10-02T19:00:00.000Z' } });
  const job = { ...initial, history_cursor: { start_history_id: '100', page_token: 'next' } };
  assert.equal((await f.run(job)).acked, false);
  assert.equal(f.count('fetch'), 0);
  assert.equal(f.state.account.sync_locked_at, '2026-10-02T19:00:00.000Z');
  assert.equal(lockAttempts(f).length, 2);
});

test('lost lock fences checkpoint and unlock writes even after message commit', async () => {
  const replacement = '2026-10-02T19:03:01.000Z';
  const f = await fixture({ hook(e, s) {
    if (e.phase === 'after' && e.name === 'ingest_email_message') s.account.sync_locked_at = replacement;
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.state.account.sync_locked_at, replacement);
  assert.deepEqual(ids(f), ['a']);
});

test('inactive account always releases the acquired lock', async () => {
  const f = await fixture({ account: { status: 'disconnected' } });
  assert.equal((await f.run()).acked, true);
  assert.equal(f.state.account.sync_locked_at, null);
  assert.equal(f.count('fetch'), 0);
});

for (const table of ['messages', 'queue_items']) test(`${table} suppression error prevents cursor advance and retries`, async () => {
  let failed = false;
  const f = await fixture({ existing: ['a'], pages: { first: page([record('101', [], { labelsAdded: [{ message: { id: 'a' }, labelIds: ['TRASH'] }] })]) }, hook(e) {
    if (!failed && e.phase === 'before' && e.table === table) { failed = true; return fail('fixture suppression failure'); }
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.equal(f.state.queueItems.get('thread-a').state, 'suppressed');
});

test('deleted messages and current drafts are skipped without invented stored IDs', async () => {
  const f = await fixture({ pages: { first: page([record('101', ['deleted', 'draft', 'real'])]) }, messages: {
    deleted: new Response('Deleted', { status: 404 }), draft: { ...message('draft'), labelIds: ['DRAFT'] },
  } });
  assert.equal((await f.run()).acked, true);
  assert.deepEqual(ids(f), ['real']);
  assert.equal(f.state.account.last_history_id, '1000');
});

test('duplicate SPAM/TRASH operations remain idempotent and generic messages are not double processed', async () => {
  const r = record('101', ['a', 'a'], { messages: [{ id: 'generic-only' }], labelsAdded: [
    { message: { id: 'a' }, labelIds: ['SPAM'] }, { message: { id: 'a' }, labelIds: ['TRASH'] },
  ] });
  const f = await fixture({ pages: { first: page([r, r]) } });
  assert.equal((await f.run()).acked, true);
  assert.deepEqual(ids(f), ['a']);
  assert.equal(f.count('rpc', 'ingest_email_message'), 1);
  assert.equal(f.state.queueItems.get('thread-a').state, 'suppressed');
  assert.equal(f.state.trace.filter(x => x.table === 'queue_items').length, 1);
});

test('empty intermediate page follows nextPageToken before saving mailbox head', async () => {
  const f = await fixture({ pages: { first: page([], 'next'), next: page([record('101', ['a'])]) } });
  assert.equal((await f.run()).acked, true);
  assert.deepEqual(ids(f), ['a']);
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 2);
  assert.equal(checkpoints(f).length, 1);
});

test('decimal history IDs stay exact above JavaScript safe integer range', async () => {
  const f = await fixture({ account: { last_history_id: '9007199254740993' }, pages: u => {
    assert.equal(u.searchParams.get('startHistoryId'), '9007199254740993');
    return page([record('9007199254740994', ['a'])], undefined, '9007199254740995');
  } });
  assert.equal((await f.run()).acked, true);
  assert.equal(f.state.account.last_history_id, '9007199254740995');
});

test('already-rounded numeric DB cursor fails closed rather than guessing', async () => {
  const f = await fixture({ account: { last_history_id: 9007199254740992 } });
  assert.equal((await f.run()).acked, false);
  assert.match(f.state.account.last_error, /Unsafe numeric/);
  assert.equal(checkpoints(f).length, 0);
});

for (const bad of [page([], undefined, '99'), { history: [{ messagesAdded: [{ message: { id: 'a' } }] }], historyId: '1000' }, { history: [], nextPageToken: 7, historyId: '1000' }]) {
  test('malformed/regressing provider response cannot silently commit a checkpoint', async () => {
    const f = await fixture({ pages: { first: bad } });
    assert.equal((await f.run()).acked, false);
    assert.equal(f.state.account.last_history_id, '100');
  });
}

test('containment guard and all unrelated deployed source bytes remain unchanged', () => {
  if (!BUNDLED) {
    for (const [file, hash] of [
      ['api/_shared/agentedge-safety.ts', '3cf5d97a2ae57c724a81ef527dc9b3e937bc589c82ea5642b2fd1acfd612aa74'],
      ['api/_shared/agentedge-push.ts', 'f5cfa21190ed3a712668490e87e76393209f067be02a1b187b377ddba0f1bae0'],
    ]) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'supabase/functions', file))).digest('hex'), hash);
    return;
  }
  function files(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
      ? files(path.join(dir, e.name), path.join(prefix, e.name)) : [path.join(prefix, e.name)]);
  }
  for (const bundle of ['api', 'workers']) {
    const before = path.join(ROOT, 'baseline', bundle), after = path.join(ROOT, 'candidate', bundle);
    assert.deepEqual(files(before).sort(), files(after).sort());
    for (const file of files(before)) if (!(bundle === 'workers' && file === 'gmail-sync-worker.ts')) {
      assert.deepEqual(fs.readFileSync(path.join(before, file)), fs.readFileSync(path.join(after, file)), `${bundle}/${file}`);
    }
  }
});

test('old trash replay cannot suppress a newer inbound episode in the same thread', async () => {
  let failed = false;
  const f = await fixture({ pages: { first: page([
    record('101', ['old']), record('102', [], { labelsAdded: [{ message: { id: 'old' }, labelIds: ['TRASH'] }] }), record('103', ['new']),
  ]) }, messages: { old: { ...message('old'), threadId: 'shared-thread' }, new: { ...message('new'), threadId: 'shared-thread' } }, hook(e) {
    if (!failed && e.phase === 'before' && e.payload?.last_history_id) { failed = true; return fail('checkpoint interrupted'); }
  } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.queueItems.get('shared-thread').last_inbound_message_id, 'db-new');
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.equal(f.state.queueItems.get('shared-thread').state, 'needs_attention');
  assert.deepEqual(ids(f), ['new', 'old']);
});

test('uninitialized incremental stays retryable and does not disable initial backfill', async () => {
  const f = await fixture({ account: { last_history_id: null, backfill_done: false } });
  assert.equal((await f.run()).acked, false);
  assert.equal(f.state.account.status, 'active');
  assert.equal(f.state.account.last_history_id, null);
  assert.equal(f.state.account.sync_locked_at, null);
  assert.match(f.state.account.last_error, /initial backfill/);
});

test('repeated invalid page token permits only one restart and then stays on bounded queue retry', async () => {
  const f = await fixture({ pages: u => u.searchParams.get('pageToken')
    ? new Response('Invalid token', { status: 400 }) : page([record('101', ['a'])], 'always-invalid') });
  const first = await f.run();
  const retry = syncContinuation(first);
  assert.equal(retry.history_cursor.token_restarts, 1);
  const second = await f.run(retry);
  assert.equal(second.acked, false);
  assert.equal(second.enqueued.length, 0);
  assert.match(f.state.account.last_error, /rejected again/);
  assert.equal(f.state.account.last_history_id, '100');
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 4);
  assert.equal((await f.run(retry, 5)).acked, false);
  assert.equal(f.count('rpc', 'dead_letter_job'), 1);
  assert.equal(f.count('fetch', '/gmail/v1/users/me/history'), 4, 'dead-letter policy prevents new HTTP attempts');
});

for (const mode of ['backfill', 'renew_watch']) {
  for (const fault of ['database', 'lost-lock']) test(`${mode} baseline creation uses exact ID and lock/null checkpoint fencing: ${fault}`, async () => {
    const f = await fixture({ account: { last_history_id: null, backfill_done: false }, hook(e, s) {
      if (e.phase === 'before' && e.path === '/gmail/v1/users/me/profile') {
        if (fault === 'lost-lock') s.account.sync_locked_at = '2026-10-02T19:03:01.000Z';
        return new Response(JSON.stringify({ historyId: '9007199254740993' }));
      }
      if (e.phase === 'before' && e.name === 'get_app_config' && e.args.p_key === 'pubsub_topic') return ok({ value: 'fixture-topic' });
      if (e.phase === 'before' && e.path === '/gmail/v1/users/me/watch') {
        if (fault === 'lost-lock') s.account.sync_locked_at = '2026-10-02T19:03:01.000Z';
        return new Response(JSON.stringify({ historyId: '9007199254740993', expiration: '1791066400000' }));
      }
      if (fault === 'database' && e.phase === 'before' && e.payload?.last_history_id) return fail('fixture baseline write failure');
    } });
    assert.equal((await f.run({ ...initial, kind: mode })).acked, false);
    assert.equal(f.state.account.last_history_id, null);
    const write = checkpoints(f)[0];
    assert.equal(write.payload.last_history_id, '9007199254740993');
    assert(write.filters.some(([op, col, val]) => op === 'is' && col === 'last_history_id' && val === null));
    assert(write.filters.some(([op, col]) => op === 'eq' && col === 'sync_locked_at'));
    if (fault === 'lost-lock') assert.equal(f.state.account.sync_locked_at, '2026-10-02T19:03:01.000Z');
  });
}

test('ack failure after successful continuation leaves safely replayable original and continuation jobs', async () => {
  let failed = false, delayed = false;
  const f = await fixture({ pages: u => u.searchParams.get('startHistoryId') === '1000' ? page([])
    : u.searchParams.get('pageToken') ? page([record('102', ['b'])]) : page([record('101', ['a'])], 'next'), hook(e, s) {
    if (!delayed && e.phase === 'after' && e.name === 'ingest_email_message') { delayed = true; s.now += 90_001; }
    if (!failed && e.phase === 'before' && e.name === 'ack_job') { failed = true; return fail('ack failed'); }
  } });
  const first = await f.run();
  assert.equal(first.acked, false);
  const continuation = syncContinuation(first);
  assert.equal((await f.run(continuation)).acked, true);
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.deepEqual(ids(f), ['a', 'b']);
});

test('known pre-existing limitation: ingest/triage enqueue are not an atomic outbox', async () => {
  let failed = false;
  const f = await fixture({ triage: true, hook(e) {
    if (!failed && e.phase === 'before' && e.name === 'enqueue_and_poke' && e.args.p_queue === 'triage_jobs') {
      failed = true; return fail('triage enqueue failed after message commit');
    }
  } });
  assert.equal((await f.run()).acked, false);
  assert.deepEqual(ids(f), ['a'], 'message is durable');
  assert.equal((await f.run(initial, 2)).acked, true);
  assert.equal(f.state.enqueued.filter(x => x.queue === 'triage_jobs').length, 0, 'characterization: separate existing gap, not fixed here');
});

// These are actual fixture operation counts, not production/cost estimates.
after(() => {
  const evidence = process.env.MCC_SYNC_EVIDENCE_DIR;
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'measured-call-counts.json'), JSON.stringify(measured.map(({ name, state }) => ({
    name,
    gmail_history_gets: state.trace.filter(x => x.path === '/gmail/v1/users/me/history').length,
    gmail_message_gets: state.trace.filter(x => x.path?.startsWith('/gmail/v1/users/me/messages/')).length,
    oauth_refreshes: state.trace.filter(x => x.path === '/token').length,
    ingest_rpc_calls: state.trace.filter(x => x.name === 'ingest_email_message').length,
    unique_stored_message_ids: [...state.messages.keys()].sort(),
    simulated_triage_enqueues: state.enqueued.filter(x => x.queue === 'triage_jobs').length,
    sync_continuations: state.enqueued.filter(x => x.queue === 'sync_jobs').length,
    largest_continuation_bytes: Math.max(0, ...state.enqueued.filter(x => x.queue === 'sync_jobs').map(x => Buffer.byteLength(JSON.stringify(x.message)))),
    checkpoint_write_attempts: state.trace.filter(x => x.payload?.last_history_id !== undefined).length,
    final_checkpoint: state.account.last_history_id,
    actual_network_or_model_calls: 0,
  })), null, 2) + '\n');
});
