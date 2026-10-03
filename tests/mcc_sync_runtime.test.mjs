import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SHA = '554e54298b1044a6db6abc4191d7f576b7c8959c4e99d683013721a5b7e03614';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    assert(!entry.isSymbolicLink(), `Symlink forbidden in exact bundle: ${full}`);
    return entry.isDirectory() ? tree(full, base) : [{ path: path.relative(base, full), sha256: hash(fs.readFileSync(full)) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[2] === '--prepare') {
  const [bundles, local, evidence] = process.argv.slice(3);
  assert(bundles && local && evidence, '--prepare needs bundle root, local project, evidence directory');
  const source = path.join(bundles, 'candidate/workers');
  assert.equal(hash(fs.readFileSync(path.join(source, 'gmail-sync-worker.ts'))), WORKER_SHA, 'Not the approved exact sync candidate');
  const dest = path.join(local, 'supabase/functions/sync-runtime');
  assert(!fs.existsSync(dest), 'Refusing to merge with an existing runtime fixture');
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.cpSync(source, path.join(dest, 'bundle'), { recursive: true });
  const wrapper = fs.readFileSync(path.join(HERE, 'fixtures/mcc_sync_runtime_wrapper.ts'), 'utf8').replace('__BUNDLE_ENTRY__', './bundle/index.ts');
  fs.writeFileSync(path.join(dest, 'index.ts'), wrapper);
  fs.copyFileSync(path.join(source, 'deno.json'), path.join(dest, 'deno.json'));
  assert.deepEqual(tree(source), tree(path.join(dest, 'bundle')), 'Runtime changed exact candidate modules');
  fs.appendFileSync(path.join(local, 'supabase/config.toml'), '\n[functions.sync-runtime]\nverify_jwt = false\nentrypoint = "./functions/sync-runtime/index.ts"\nimport_map = "./functions/sync-runtime/deno.json"\n');
  fs.writeFileSync(path.join(evidence, 'sync-runtime-wrapper-manifest.json'), JSON.stringify({
    exactBundle: tree(source), wrapper: { path: 'supabase/functions/sync-runtime/index.ts', sha256: hash(wrapper) },
    sql: { path: 'tests/fixtures/mcc_sync_runtime.sql', sha256: hash(fs.readFileSync(path.join(HERE, 'fixtures/mcc_sync_runtime.sql'))) },
    limitations: ['Synthetic Google HTTP only; no live Gmail/OAuth/model calls', 'SQL ingest and queue RPCs are deliberately simplified fixtures, not canonical business-logic or pgmq coverage', 'Fake clock and deterministic SQL race injection; no proof of all concurrency interleavings'],
  }, null, 2));
} else if (process.argv[2] === '--self-test') {
  const wrapper = fs.readFileSync(path.join(HERE, 'fixtures/mcc_sync_runtime_wrapper.ts'), 'utf8');
  const js = stripTypeScriptTypes(wrapper, { mode: 'strip' });
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: js, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal((wrapper.match(/__BUNDLE_ENTRY__/g) ?? []).length, 1);
  assert(wrapper.includes('nativeFetch(new Request(request, { redirect: "error" }))'));
  assert(wrapper.includes('blocks all non-local, non-synthetic egress'));
  const sql = fs.readFileSync(path.join(HERE, 'fixtures/mcc_sync_runtime.sql'), 'utf8');
  assert(sql.includes('unique(gmail_account_id,provider_message_id)'));
  assert(sql.includes("set_config('response.status','503',true)"));
  assert(!/\bsecurity\s+definer\b/i.test(sql.replace(/--[^\n]*/g, '')));
  assert(sql.includes('enable row level security'));
  console.log('PASS: wrapper TypeScript stripping/JavaScript syntax and local fixture structural checks (not Deno typecheck or SQL execution)');
} else {
  const statusFile = process.env.MCC_SYNC_RUNTIME_STATUS;
  assert(statusFile, 'Use validate_mcc_sync_runtime.sh; absent runtime prerequisites fail instead of skipping');
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  const api = status.API_URL ?? status.api_url;
  const key = status.SERVICE_ROLE_KEY ?? status.service_role_key;
  const anon = status.ANON_KEY ?? status.anon_key;
  const secret = process.env.MCC_SYNC_RUNTIME_WORKER_SECRET;
  const container = process.env.MCC_SYNC_RUNTIME_DB_CONTAINER;
  const evidence = process.env.MCC_SYNC_RUNTIME_EVIDENCE;
  assert(api && key && anon && secret && container && evidence, 'Incomplete disposable runtime configuration');
  const origin = new URL(api);
  assert(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname), 'Local Supabase URL required');
  assert(/^supabase_db_mcc-sync-runtime-[a-z0-9-]+$/.test(container), 'Refusing SQL outside disposable sync-runtime container');
  assert(secret.startsWith('mcc-local-fixture-'), 'Only local fixture worker secret accepted');
  fs.mkdirSync(evidence, { recursive: true });
  const ACCOUNT = '00000000-0000-4000-8000-000000000001';
  const USER = '00000000-0000-4000-8000-000000000002';
  const OTHER = '00000000-0000-4000-8000-000000000003';
  const SECRET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const BASE_TIME = '2026-10-02T19:00:00.123Z';
  const initial = { kind: 'incremental', gmail_account_id: ACCOUNT };
  const audit = [];
  let label = '';
  function sql(statement) {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, encoding: 'utf8' });
    assert.equal(result.status, 0, `Disposable SQL failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  async function localFetch(route, options = {}) {
    const url = new URL(route, api);
    assert.equal(url.origin, origin.origin);
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  }
  const authHeaders = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function rest(route, options = {}) {
    const response = await localFetch(`/rest/v1/${route}`, { ...options, headers: { ...authHeaders, ...options.headers } });
    assert(response.ok, `Local REST ${route} failed: ${response.status} ${await response.clone().text()}`);
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }
  const setting = (name, value) => rest('runtime_settings?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ key: name, value }) });
  const clear = () => rest('runtime_settings?key=not.is.null', { method: 'DELETE' });
  const account = async () => (await rest(`gmail_accounts?id=eq.${ACCOUNT}&select=*`))[0];
  const ids = async () => (await rest('messages?select=provider_message_id&order=provider_message_id')).map(row => row.provider_message_id);
  const jobs = () => rest('runtime_jobs?order=msg_id');
  const events = () => rest('runtime_events?order=id');
  const record = (id, messageIds, extra = {}) => ({ id: String(id), messagesAdded: messageIds.map(id => ({ message: { id } })), ...extra });
  const page = (history, nextPageToken, head = '1000') => ({ body: { history, historyId: head, ...(nextPageToken ? { nextPageToken } : {}) } });
  const ordinary = () => ({ pages: { first: page([record(101, ['a'])]) } });
  const multi = () => ({ pages: { first: page([record(101, ['a'])], 'second'), second: page([record(102, ['b'])]) } });
  async function reset(name, patch = {}) {
    label = name;
    sql('begin; truncate public.runtime_settings, public.runtime_events, public.runtime_jobs, public.queue_items, public.messages, public.threads, public.gmail_accounts restart identity; commit;');
    await rest('gmail_accounts', { method: 'POST', body: JSON.stringify({ id: ACCOUNT, user_id: USER, email_address: 'owner@example.invalid', status: 'active', refresh_token_secret_id: SECRET_ID, last_history_id: '100', ...patch }) });
  }
  async function seed(message = initial, readCt = 0) {
    const rows = await rest('runtime_jobs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ message, ready: true, read_ct: readCt }) });
    return rows[0].msg_id;
  }
  async function promote(id) {
    assert(Number.isSafeInteger(id));
    await rest(`runtime_jobs?msg_id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ready: true, claimed: false }) });
  }
  async function invoke(scenario, authorized = true) {
    const response = await localFetch('/functions/v1/sync-runtime/gmail-sync-worker', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-worker-secret': secret } : {}) }, body: JSON.stringify({ scenario }) });
    assert.equal(response.headers.get('x-mcc-sync-runtime'), '1', `Sync wrapper failed to boot: ${response.status} ${await response.clone().text()}`);
    const result = { label, status: response.status, ...(await response.json()) };
    audit.push(result);
    fs.writeFileSync(path.join(evidence, 'sync-runtime-observations.json'), JSON.stringify(audit, null, 2));
    assert(!result.events.some(event => event.kind === 'blocked_egress'), 'Forbidden egress attempted');
    assert(result.runtime?.deno, 'Missing actual Deno runtime identity');
    return result;
  }
  async function run(scenario = ordinary(), message = initial) {
    const id = await seed(message);
    const result = await invoke(scenario);
    assert.equal(result.status, 200);
    return { id, ...result };
  }
  async function state(checkpoint, stored, processed, result) {
    assert.equal(String((await account()).last_history_id), String(checkpoint));
    assert.deepEqual(await ids(), stored);
    assert.deepEqual(result.application, { ok: true, processed });
  }
  const historyCalls = result => result.events.filter(e => e.kind === 'synthetic_gmail' && e.path === '/users/me/history');
  const checkpointWrites = result => result.events.filter(e => e.path === '/rest/v1/gmail_accounts' && e.patch?.last_history_id !== undefined);
  async function assertAck(id, expected) { assert.equal((await jobs()).find(j => j.msg_id === id)?.acked, expected); }
  async function continuation() {
    const pending = (await jobs()).filter(j => j.queue === 'sync_jobs' && !j.ready && !j.acked);
    assert.equal(pending.length, 1, 'Exactly one continuation expected');
    return pending[0];
  }

  test('exact candidate on real Supabase Edge/PostgREST, with synthetic Google only', { timeout: 360_000 }, async t => {
    await t.test('fixture schema shape and RLS are verified before writes', async () => {
      const columns = JSON.parse(sql("select json_agg(column_name order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='gmail_accounts'"));
      for (const name of ['id','user_id','status','last_history_id','sync_locked_at','last_sync_at','last_error']) assert(columns.includes(name));
      assert.equal(sql("select data_type from information_schema.columns where table_schema='public' and table_name='gmail_accounts' and column_name='last_history_id'"), 'bigint');
      assert.equal(sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('gmail_accounts','runtime_settings','runtime_events','runtime_jobs','threads','messages','queue_items') and c.relrowsecurity"), '7');
    });
    await t.test('auth denial occurs before queue/database access', async () => {
      await reset('auth denial');
      const result = await invoke(ordinary(), false);
      assert.equal(result.status, 500); // unchanged workers router maps thrown HttpError to 500
      assert.deepEqual(result.events, []);
      assert.deepEqual(await jobs(), []);
    });
    await t.test('local GoTrue JWT limits account visibility; anonymous fixture RPCs are denied', async () => {
      await reset('RLS smoke');
      const password = `local-only-${crypto.randomUUID()}`;
      const email = `sync-${crypto.randomUUID()}@example.invalid`;
      const created = await localFetch('/auth/v1/admin/users', { method: 'POST', headers: authHeaders, body: JSON.stringify({ email, password, email_confirm: true }) });
      assert(created.ok, `Local GoTrue user create: ${created.status}`);
      const userId = (await created.json()).id;
      const signedIn = await localFetch('/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert(signedIn.ok, `Local GoTrue sign-in: ${signedIn.status}`);
      const jwt = (await signedIn.json()).access_token;
      assert(jwt);
      await rest('gmail_accounts', { method: 'POST', body: JSON.stringify({ id: OTHER, user_id: userId, email_address: 'other@example.invalid', status: 'active' }) });
      const visible = await localFetch('/rest/v1/gmail_accounts?select=id', { headers: { apikey: anon, authorization: `Bearer ${jwt}` } });
      assert(visible.ok);
      assert.deepEqual(await visible.json(), [{ id: OTHER }]);
      const denied = await localFetch('/rest/v1/rpc/claim_jobs', { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_queue: 'sync_jobs', p_n: 3, p_vt: 150 }) });
      assert([401, 403].includes(denied.status), `Anonymous RPC unexpectedly available: ${denied.status}`);
    });
    await t.test('native REST lock representation agrees with persisted SQL and simple-filter controls', async () => {
      // Diagnostics only: execute the same synthetic CAS through native REST
      // and direct local SQL. Never alter or emulate a candidate response.
      const targetLock = BASE_TIME;
      const expiry = '2026-10-02T18:57:00.123Z';
      const expiredLock = '2026-10-02T18:56:59.123Z';
      const unexpiredLock = '2026-10-02T18:59:00.456Z';
      const diagnostics = { postgresVersion: sql('show server_version;'), postgrestVersion: null, serverHeader: null, cases: [] };
      const destination = path.join(evidence, 'lock-representation-diagnostics.json');
      const persist = () => fs.writeFileSync(destination, JSON.stringify(diagnostics, null, 2));
      const discovery = await localFetch('/rest/v1/', { headers: { ...authHeaders, accept: 'application/openapi+json' } });
      diagnostics.serverHeader = discovery.headers.get('server');
      diagnostics.versionDiscoveryStatus = discovery.status;
      if (discovery.ok) {
        const document = await discovery.json();
        // Keep only the server version; the OpenAPI schema is not evidence data.
        diagnostics.postgrestVersion = typeof document.info?.version === 'string' ? document.info.version : null;
      }
      persist();
      for (const [name, prior, filterKey, filterValue, expectedRows] of [
        ['or-null', null, 'or', `(sync_locked_at.is.null,sync_locked_at.lt.${expiry})`, 1],
        ['or-expired', expiredLock, 'or', `(sync_locked_at.is.null,sync_locked_at.lt.${expiry})`, 1],
        ['simple-is-null', null, 'sync_locked_at', 'is.null', 1],
        ['simple-lt-expiry', expiredLock, 'sync_locked_at', `lt.${expiry}`, 1],
        ['or-unexpired', unexpiredLock, 'or', `(sync_locked_at.is.null,sync_locked_at.lt.${expiry})`, 0],
        ['simple-is-null-unexpired', unexpiredLock, 'sync_locked_at', 'is.null', 0],
        ['simple-lt-unexpired', unexpiredLock, 'sync_locked_at', `lt.${expiry}`, 0],
      ]) {
        await reset(`native CAS diagnostic ${name}`, { sync_locked_at: prior });
        const query = new URLSearchParams({ id: `eq.${ACCOUNT}`, [filterKey]: filterValue, select: 'id,sync_locked_at' });
        const response = await localFetch(`/rest/v1/gmail_accounts?${query}`, {
          method: 'PATCH', headers: { ...authHeaders, accept: 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ sync_locked_at: targetLock }),
        });
        const raw = await response.text();
        let value;
        try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
        const returned = Array.isArray(value) ? value.map(row => ({ id: row.id, sync_locked_at: row.sync_locked_at })) : null;
        const snapshot = () => JSON.parse(sql(`select jsonb_build_object('id',id,'sync_locked_at',sync_locked_at) from public.gmail_accounts where id='${ACCOUNT}';`));
        const row = {
          name, prior, expectedRows, expectedPersistedLock: expectedRows ? targetLock : prior, requestedLock: targetLock, query: query.toString(), status: response.status,
          serverHeader: response.headers.get('server'), preferenceApplied: response.headers.get('preference-applied'),
          contentRange: response.headers.get('content-range'), returnedRowCount: returned?.length ?? null,
          returned, persistedAfterRest: snapshot(), errorCode: !response.ok && typeof value?.code === 'string' ? value.code : null,
        };
        diagnostics.cases.push(row);
        persist();
        // Direct SQL control uses the same local service role and trigger, but
        // does not pass through PostgREST's RETURNING projection planner.
        sql(`update public.gmail_accounts set sync_locked_at=${prior === null ? 'null' : `'${prior}'::timestamptz`} where id='${ACCOUNT}';`);
        const predicate = filterKey === 'or' ? `(sync_locked_at is null or sync_locked_at < '${expiry}'::timestamptz)` : filterValue === 'is.null' ? 'sync_locked_at is null' : `sync_locked_at < '${expiry}'::timestamptz`;
        const control = sql(`begin; set local role service_role; with changed as (update public.gmail_accounts set sync_locked_at='${targetLock}'::timestamptz where id='${ACCOUNT}' and ${predicate} returning id,sync_locked_at) select coalesce(jsonb_agg(to_jsonb(changed)),'[]'::jsonb) from changed; commit;`);
        row.sqlReturned = JSON.parse(control.split('\n').find(line => line.startsWith('[')));
        row.persistedAfterSql = snapshot();
        persist();
      }
      // Write every case before asserting, so a broken runtime leaves evidence
      // for both OR forms, simple controls and contention. Nothing is skipped.
      for (const row of diagnostics.cases) {
        assert.equal(row.sqlReturned.length, row.expectedRows, `${row.name}: SQL fixture CAS row count disagrees`);
        assert.equal(Date.parse(row.persistedAfterSql.sync_locked_at), Date.parse(row.expectedPersistedLock));
        assert.equal(row.status, 200, `${row.name}: native REST failed`);
        assert.equal(Date.parse(row.persistedAfterRest.sync_locked_at), Date.parse(row.expectedPersistedLock), `${row.name}: REST persisted incorrect lock`);
      }
      for (const row of diagnostics.cases.filter(row => row.name.startsWith('simple-'))) {
        assert.equal(row.returnedRowCount, row.expectedRows, `${row.name}: simple filter returned incorrect CAS row count`);
      }
      for (const row of diagnostics.cases) {
        assert.equal(row.returnedRowCount, row.expectedRows, `${row.name}: returned CAS representation disagrees; inspect lock-representation-diagnostics.json and PostgREST version`);
        if (row.expectedRows) assert.equal(Date.parse(row.returned[0].sync_locked_at), Date.parse(targetLock));
      }
    });
    await t.test('multipage sync ingests all pages before the single fenced checkpoint', async () => {
      await reset('multipage');
      const result = await run(multi());
      await state(1000, ['a', 'b'], 1, result);
      await assertAck(result.id, true);
      assert.equal(historyCalls(result).length, 2);
      assert(historyCalls(result).every(e => new URLSearchParams(e.query).get('startHistoryId') === '100'));
      assert.equal(checkpointWrites(result).length, 1);
      const q = new URLSearchParams(checkpointWrites(result)[0].query);
      assert.equal(q.get('last_history_id'), 'eq.100');
      assert.equal(Date.parse(q.get('sync_locked_at').slice(3)), Date.parse(BASE_TIME));
      assert.equal((await account()).sync_locked_at, null);
    });
    await t.test('page-boundary cutoff persists old checkpoint and resumes exact continuation', async () => {
      await reset('page-boundary cutoff');
      const first = await run({ ...multi(), advanceOnMetadata: 90_001 });
      await state(100, ['a'], 1, first);
      assert.equal(checkpointWrites(first).length, 0);
      const next = await continuation();
      assert.deepEqual(next.message.history_cursor, { start_history_id: '100', page_token: 'second', token_restarts: 0 });
      await promote(next.msg_id);
      const resumed = await invoke(multi());
      await state(1000, ['a', 'b'], 1, resumed);
      await assertAck(next.msg_id, true);
      assert.equal(new URLSearchParams(historyCalls(resumed)[0].query).get('pageToken'), 'second');
    });
    await t.test('mid-page cutoff uses digest/index, dedupes reordering, and completes without skips', async () => {
      await reset('mid-page cutoff');
      const scenario = { pages: { first: page([record(101, ['a', 'b', 'c'])]) }, advanceOnMetadata: 90_001 };
      const first = await run(scenario);
      await state(100, ['a'], 1, first);
      const next = await continuation();
      assert.equal(next.message.history_cursor.next_operation, 1);
      assert.match(next.message.history_cursor.page_digest, /^[a-f0-9]{64}$/);
      assert(JSON.stringify(next.message).length < 500);
      await promote(next.msg_id);
      const resumed = await invoke({ pages: { first: page([record(101, ['c', 'b', 'a', 'a'])]) } });
      await state(1000, ['a', 'b', 'c'], 1, resumed);
      assert.equal(resumed.events.filter(e => e.kind === 'synthetic_gmail' && e.path.startsWith('/users/me/messages/')).length, 2);
    });
    await t.test('cutoff before first operation retains index zero', async () => {
      await reset('cutoff before first operation');
      const scenario = ordinary();
      scenario.pages.first.advanceMs = 90_001;
      const result = await run(scenario);
      await state(100, [], 1, result);
      assert.equal((await continuation()).message.history_cursor.next_operation, 0);
    });
    await t.test('changed page invalidates digest and replay obeys provider-ID uniqueness', async () => {
      await reset('changed page');
      await run({ pages: { first: page([record(101, ['a', 'c'])]) }, advanceOnMetadata: 90_001 });
      const next = await continuation();
      await promote(next.msg_id);
      const result = await invoke({ pages: { first: page([record(101, ['a', 'b', 'c'])]) } });
      await state(1000, ['a', 'b', 'c'], 1, result);
      const ingests = (await events()).filter(e => e.event === 'ingest').map(e => e.payload);
      assert.equal(ingests.filter(e => e.provider_id === 'a').length, 2);
      assert(ingests.some(e => e.provider_id === 'a' && e.status === 'duplicate'));
      assert.equal(sql('select count(*) from (select gmail_account_id,provider_message_id from public.messages group by 1,2 having count(*)>1) s'), '0');
    });
    for (const mode of ['before', 'after']) await t.test(`ingest ${mode}-commit failure is real SQL and replay is lossless for storage`, async () => {
      await reset(`ingest ${mode}`);
      await setting('ingest_failure', mode);
      await setting('ingest_id', 'a');
      const failed = await run(ordinary());
      await state(100, mode === 'before' ? [] : ['a'], 0, failed);
      await assertAck(failed.id, false);
      const dbCall = failed.events.find(e => e.path === '/rest/v1/rpc/ingest_email_message');
      assert.equal(dbCall.status, mode === 'before' ? 400 : 503);
      const committed = (await events()).filter(e => e.event === 'committed_error');
      assert.equal(committed.length, mode === 'after' ? 1 : 0);
      assert.equal((await events()).filter(e => e.event === 'ingest').length, mode === 'after' ? 1 : 0, 'Raised SQL exception must roll back ingest and audit together');
      await clear(); await promote(failed.id);
      const retried = await invoke(ordinary());
      await state(1000, ['a'], 1, retried);
      await assertAck(failed.id, true);
    });
    for (const mode of ['before', 'after']) await t.test(`checkpoint ${mode}-commit failure never falsely acknowledges`, async () => {
      await reset(`checkpoint ${mode}`);
      await setting('checkpoint_failure', mode);
      const failed = await run();
      await state(mode === 'after' ? 1000 : 100, ['a'], 0, failed);
      await assertAck(failed.id, false);
      assert.equal(checkpointWrites(failed)[0].status, mode === 'after' ? 503 : 400);
      assert.equal((await account()).sync_locked_at, null);
      await clear(); await promote(failed.id);
      const scenario = mode === 'after' ? { pages: { first: page([], undefined, '1000') } } : ordinary();
      const retried = await invoke(scenario);
      await state(1000, ['a'], 1, retried);
      assert.equal(new URLSearchParams(historyCalls(retried)[0].query).get('startHistoryId'), mode === 'after' ? '1000' : '100');
    });
    for (const mode of ['before', 'after']) await t.test(`continuation enqueue ${mode}-commit failure retains durable start`, async () => {
      await reset(`enqueue ${mode}`);
      await setting('enqueue_sync_jobs', mode);
      const failed = await run({ ...multi(), advanceOnMetadata: 90_001 });
      await state(100, ['a'], 0, failed);
      await assertAck(failed.id, false);
      const queued = (await jobs()).filter(j => !j.ready);
      assert.equal(queued.length, mode === 'after' ? 1 : 0, 'Commit uncertainty must be checked against real queue rows');
      assert.equal(failed.events.find(e => e.path.endsWith('/enqueue_and_poke')).status, mode === 'after' ? 503 : 400);
      await clear(); await promote(failed.id);
      const replay = await invoke(multi());
      await state(1000, ['a', 'b'], 1, replay);
      if (queued.length) {
        await promote(queued[0].msg_id);
        const stale = await invoke({ pages: { first: page([], undefined, '1000') } });
        await state(1000, ['a', 'b'], 1, stale);
        assert.equal(new URLSearchParams(historyCalls(stale)[0].query).get('startHistoryId'), '1000');
        assert.equal(new URLSearchParams(historyCalls(stale)[0].query).get('pageToken'), null);
      }
    });
    for (const mode of ['before', 'after']) await t.test(`ack ${mode}-commit failure exposes actual ack state without undoing completed data`, async () => {
      await reset(`ack ${mode}`);
      await setting('ack_failure', mode);
      const result = await run();
      await state(1000, ['a'], 0, result);
      await assertAck(result.id, mode === 'after');
      assert.equal(result.events.find(e => e.path.endsWith('/ack_job')).status, mode === 'after' ? 503 : 400);
      if (mode === 'before') {
        await clear(); await promote(result.id);
        const replay = await invoke({ pages: { first: page([], undefined, '1000') } });
        await state(1000, ['a'], 1, replay);
      }
    });
    await t.test('pre-existing non-atomic triage outbox gap remains explicitly characterized', async () => {
      await reset('triage outbox limitation');
      await setting('needs_triage', true);
      await setting('enqueue_triage_jobs', 'before');
      const result = await run();
      await state(100, ['a'], 0, result);
      await clear(); await promote(result.id);
      const replay = await invoke(ordinary());
      await state(1000, ['a'], 1, replay);
      assert.equal((await jobs()).filter(j => j.queue === 'triage_jobs').length, 0, 'Known gap: duplicate ingest does not re-enqueue triage');
    });
    await t.test('replayed old suppression cannot hide a newer inbound episode', async () => {
      await reset('current inbound suppression');
      const message = id => ({ body: { id, threadId: 'shared-thread', labelIds: ['INBOX'], internalDate: '1790966400000' } });
      const first = await run({ pages: { first: page([record(101, ['old']), record(102, ['new'])]) }, messages: { old: message('old'), new: message('new') } });
      await state(1000, ['new', 'old'], 1, first);
      const oldEvent = { id: '1001', labelsAdded: [{ message: { id: 'old' }, labelIds: ['TRASH'] }] };
      await run({ pages: { first: page([oldEvent], undefined, '1100') } });
      assert.equal((await rest('queue_items?select=state'))[0].state, 'needs_attention');
      await run({ pages: { first: page([{ id: '1101', labelsAdded: [{ message: { id: 'new' }, labelIds: ['SPAM'] }] }], undefined, '1200') } });
      assert.equal((await rest('queue_items?select=state'))[0].state, 'suppressed');
    });
    for (const mode of ['before', 'after']) await t.test(`suppression ${mode}-commit error keeps the checkpoint retryable`, async () => {
      await reset(`suppression ${mode}`);
      await run();
      await setting('suppression_failure', mode);
      const scenario = { pages: { first: page([{ id: '1001', labelsAdded: [{ message: { id: 'a' }, labelIds: ['TRASH'] }] }], undefined, '1100') } };
      const failed = await run(scenario);
      await state(1000, ['a'], 0, failed);
      await assertAck(failed.id, false);
      assert.equal((await rest('queue_items?select=state'))[0].state, mode === 'after' ? 'suppressed' : 'needs_attention');
      await clear(); await promote(failed.id);
      await state(1100, ['a'], 1, await invoke(scenario));
    });
    await t.test('failed message lookup and lock acquisition leave jobs unacked', async () => {
      await reset('message lookup DB error');
      await run();
      // Column privilege denial is local-only and is restored immediately.
      sql('revoke select on public.messages from service_role;');
      let failed;
      try {
        failed = await run({ pages: { first: page([{ id: '1001', labelsAdded: [{ message: { id: 'a' }, labelIds: ['TRASH'] }] }], undefined, '1100') } });
        await assertAck(failed.id, false);
        assert.equal((await account()).last_history_id, 1000);
      } finally { sql('grant select on public.messages to service_role;'); }
      await reset('unavailable account lock');
      const locked = await run(ordinary(), { ...initial, gmail_account_id: OTHER });
      await assertAck(locked.id, false);
      assert.equal(historyCalls(locked).length, 0);
      await reset('lock write denied');
      sql('revoke update on public.gmail_accounts from service_role;');
      try {
        const result = await run();
        await assertAck(result.id, false);
        assert.equal(historyCalls(result).length, 0);
      } finally { sql('grant update on public.gmail_accounts to service_role;'); }
    });
    await t.test('timestamp CAS acquires expired lock but respects an unexpired one', async () => {
      await reset('unexpired lock', { sync_locked_at: BASE_TIME });
      const blocked = await run();
      await state(100, [], 0, blocked);
      await assertAck(blocked.id, false);
      assert.equal(Date.parse((await account()).sync_locked_at), Date.parse(BASE_TIME));
      await reset('expired lock', { sync_locked_at: '2026-10-02T18:56:59.123Z' });
      const allowed = await run();
      await state(1000, ['a'], 1, allowed);
      assert.equal((await account()).sync_locked_at, null);
    });
    await t.test('old worker cannot write checkpoint or release replacement timestamp lock', async () => {
      await reset('replacement timestamp lock');
      const replacement = '2026-10-02T19:03:01.456Z';
      await setting('replacement_lock', replacement);
      const result = await run();
      await state(100, ['a'], 0, result);
      await assertAck(result.id, false);
      assert.equal(Date.parse((await account()).sync_locked_at), Date.parse(replacement));
      const patches = result.events.filter(e => e.path === '/rest/v1/gmail_accounts' && e.method === 'PATCH');
      assert.equal(patches.length, 3); // lock, failed checkpoint, failed unlock
      assert(patches.slice(1).every(e => Date.parse(new URLSearchParams(e.query).get('sync_locked_at').slice(3)) === Date.parse(BASE_TIME)));
    });
    await t.test('checkpoint CAS rejects intervening checkpoint even with same lock', async () => {
      await reset('checkpoint race');
      await setting('checkpoint_race', '500');
      const result = await run();
      await state(500, ['a'], 0, result);
      await assertAck(result.id, false);
      assert.match((await account()).last_error, /lock\/checkpoint changed/);
      assert.equal((await account()).sync_locked_at, null);
    });
    await t.test('null checkpoint incremental job remains active and retryable', async () => {
      await reset('null incremental', { last_history_id: null });
      const result = await run();
      await state(null, [], 0, result);
      await assertAck(result.id, false);
      assert.equal((await account()).status, 'active');
      assert.equal(historyCalls(result).length, 0);
      assert.match((await account()).last_error, /initial backfill/);
    });
    for (const race of [false, true]) await t.test(`null baseline initialization uses IS NULL fencing${race ? ' under a race' : ''}`, async () => {
      await reset(`null baseline ${race}`, { last_history_id: null, backfill_done: false });
      if (race) await setting('baseline_race', '333');
      const result = await run({ profile: { body: { historyId: '200' } }, list: { body: { messages: [] } } }, { kind: 'backfill', gmail_account_id: ACCOUNT, phase: 'recent' });
      await state(race ? 333 : 200, [], race ? 0 : 1, result);
      await assertAck(result.id, !race);
      assert.equal(new URLSearchParams(checkpointWrites(result)[0].query).get('last_history_id'), 'is.null');
      assert.equal(result.events.filter(e => e.kind === 'synthetic_gmail' && e.path === '/users/me/messages').length, race ? 0 : 1);
      assert.equal((await account()).sync_locked_at, null);
    });
    await t.test('unexpected ingest status retains checkpoint although the real row committed', async () => {
      await reset('unexpected ingest status');
      await setting('unexpected_ingest', true);
      const result = await run();
      await state(100, ['a'], 0, result);
      await assertAck(result.id, false);
      assert.match((await account()).last_error, /unexpected result/);
      await clear(); await promote(result.id);
      await state(1000, ['a'], 1, await invoke(ordinary()));
    });
    await t.test('invalid mailbox head and first-page 400 stay retryable without invented progress', async () => {
      for (const [name, scenario] of [
        ['regressed mailbox head', { pages: { first: page([record(101, ['a'])], undefined, '99') } }],
        ['first-page 400', { pages: { first: { status: 400, body: { error: 'bad request' } } } }],
      ]) {
        await reset(name);
        const result = await run(scenario);
        assert.equal((await account()).last_history_id, 100);
        assert.equal((await account()).status, 'active');
        await assertAck(result.id, false);
        assert.equal(checkpointWrites(result).length, 0);
        assert.equal((await jobs()).length, 1);
      }
    });
    await t.test('expired history visibly stops without profile reset or automatic reconciliation', async () => {
      await reset('expired history');
      const result = await run({ pages: { first: { body: { error: 'history expired' }, status: 404 } } });
      await state(100, [], 1, result);
      await assertAck(result.id, true);
      assert.equal((await account()).status, 'error');
      assert.match((await account()).last_error, /coverage is incomplete/);
      assert(!result.events.some(e => e.path === '/users/me/profile'));
      assert.equal((await jobs()).length, 1);
    });
    await t.test('revoked OAuth visibly stops without Gmail or checkpoint activity', async () => {
      await reset('revoked OAuth');
      const result = await run({ oauthStatus: 400 });
      await state(100, [], 1, result);
      assert.equal((await account()).status, 'error');
      assert.match((await account()).last_error, /invalid_grant/);
      assert.equal(historyCalls(result).length, 0);
      assert.equal(checkpointWrites(result).length, 0);
    });
    await t.test('rejected pagination token gets one baseline replay, then normal bounded retry/dead-letter', async () => {
      await reset('bounded page token replay');
      const scenario = { pages: { bad: { body: { error: 'bad page token' }, status: 400 } } };
      const result = await run(scenario, { ...initial, history_cursor: { start_history_id: '100', page_token: 'bad' } });
      await state(100, [], 1, result);
      const next = await continuation();
      assert.deepEqual(next.message.history_cursor, { start_history_id: '100', token_restarts: 1 });
      await promote(next.msg_id);
      const replay = await invoke({ pages: { first: page([record(101, ['a'])], 'bad'), ...scenario.pages } });
      await state(100, ['a'], 0, replay);
      await assertAck(next.msg_id, false);
      assert.equal((await jobs()).filter(j => !j.ready).length, 0);
      for (let attempt = 3; attempt <= 6; attempt++) {
        await promote(next.msg_id);
        const retried = await invoke({ pages: { first: page([record(101, ['a'])], 'bad'), ...scenario.pages } });
        assert.equal(retried.application.processed, 0);
        if ((await jobs()).find(j => j.msg_id === next.msg_id).dead_lettered) break;
      }
      assert.equal((await jobs()).find(j => j.msg_id === next.msg_id).dead_lettered, true);
      assert.equal((await account()).last_history_id, 100);
    });
    await t.test('native bigint serialization rejects unsafe numeric checkpoint without rounding forward', async () => {
      await reset('unsafe PostgreSQL bigint', { last_history_id: '9007199254740993' });
      const result = await run();
      assert.equal(result.application.processed, 0);
      await assertAck(result.id, false);
      assert.equal(sql(`select last_history_id::text from public.gmail_accounts where id='${ACCOUNT}'`), '9007199254740993');
      assert.match((await account()).last_error, /Unsafe numeric Gmail history ID/);
      assert.equal(historyCalls(result).length, 0);
    });
    await t.test('deleted/draft messages, duplicate generic history and legacy resync fail safely', async () => {
      await reset('deleted and draft');
      const result = await run({ pages: { first: page([record(101, ['deleted', 'draft', 'a'], { messages: [{ id: 'generic' }] })]) }, messages: { deleted: { body: { error: 'gone' }, status: 404 }, draft: { body: { id: 'draft', threadId: 'draft-thread', labelIds: ['DRAFT'] } } } });
      await state(1000, ['a'], 1, result);
      await reset('legacy resync');
      const legacy = await run({}, { kind: 'full_resync', gmail_account_id: ACCOUNT });
      await state(100, [], 1, legacy);
      assert.equal((await account()).status, 'error');
      assert(!legacy.events.some(e => e.kind === 'synthetic_gmail'));
    });
  });
}
