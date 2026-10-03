import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
  assert(bundles && local && evidence, '--prepare needs bundle root, local project, evidence dir');
  fs.mkdirSync(evidence, { recursive: true });
  const wrapper = fs.readFileSync(path.join(HERE, 'fixtures/mcc_agentedge_runtime_wrapper.ts'), 'utf8');
  const records = {};
  for (const name of ['api', 'workers']) {
    const source = path.join(bundles, 'candidate', name);
    const dest = path.join(local, 'supabase/functions', name);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(source, path.join(dest, 'bundle'), { recursive: true });
    const prefix = name === 'api' ? './bundle/api' : './bundle';
    fs.writeFileSync(path.join(dest, 'index.ts'), wrapper.replace('__BUNDLE_ENTRY__', `${prefix}/index.ts`).replace('__POLICY_ENTRY__', `${prefix}/_shared/agentedge-safety.ts`).replace('__UTIL_ENTRY__', `${prefix}/_shared/util.ts`));
    fs.copyFileSync(path.join(source, name === 'api' ? 'api/deno.json' : 'deno.json'), path.join(dest, 'deno.json'));
    assert.deepEqual(tree(source), tree(path.join(dest, 'bundle')), 'Wrapped modules differ from exact candidate');
    records[name] = { exactBundle: tree(source), wrapper: { path: `supabase/functions/${name}/index.ts`, sha256: hash(fs.readFileSync(path.join(dest, 'index.ts'))) } };
    fs.appendFileSync(path.join(local, 'supabase/config.toml'), `\n[functions.${name}]\nverify_jwt = false\nentrypoint = "./functions/${name}/index.ts"\nimport_map = "./functions/${name}/deno.json"\n`);
  }
  fs.writeFileSync(path.join(evidence, 'runtime-wrapper-manifest.json'), JSON.stringify(records, null, 2));
} else if (process.argv[2] === '--compare-checks') {
  const [evidence] = process.argv.slice(3);
  function diagnostics(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '');
    return [...text.matchAll(/^(TS\d+) \[ERROR\]: ([^\n]*)([\s\S]*?)(?=^TS\d+ \[ERROR\]:|^Found \d+ errors?|^error:|$(?![\s\S]))/gm)].map(match => {
      const location = match[3].match(/(?:at |--> )([^\n]+\.tsx?):\d+:\d+/)?.[1] ?? 'unknown';
      const relative = location.replace(/^.*\/(?:baseline|candidate)\//, '');
      // Keep message details and the highlighted source context so a different
      // error with the same TS code/first line cannot hide behind a baseline
      // failure. Only absolute roots and source line positions are normalized.
      const detail = match[3].replace(/(?:file:\/\/)?[^\s]*\/(?:baseline|candidate)\//g, '<bundle>/')
        .replace(/(\.tsx?):\d+:\d+/g, '$1:<line>:<column>').trim();
      return `${match[1]} ${match[2]} @ ${relative}\n${detail}`;
    });
  }
  const result = {};
  const dependencies = {};
  for (const name of ['api', 'workers']) {
    const resolved = stage => {
      const graph = JSON.parse(fs.readFileSync(path.join(evidence, `${stage}-${name}-dependencies.json`), 'utf8'));
      const packages = Object.entries(graph.npmPackages ?? {}).map(([id, pkg]) => ({ id, name: pkg.name, version: pkg.version })).sort((a, b) => a.id.localeCompare(b.id));
      assert(packages.length > 0 && packages.some(pkg => pkg.name === '@supabase/supabase-js'), `No resolved npm versions in ${stage} ${name} Deno graph`);
      return packages;
    };
    dependencies[name] = { baseline: resolved('baseline'), candidate: resolved('candidate') };
    const baseline = diagnostics(path.join(evidence, `baseline-${name}-check.log`));
    const candidate = diagnostics(path.join(evidence, `candidate-${name}-check.log`));
    const baselineStatus = Number(fs.readFileSync(path.join(evidence, `baseline-${name}-check.exit`), 'utf8'));
    const candidateStatus = Number(fs.readFileSync(path.join(evidence, `candidate-${name}-check.exit`), 'utf8'));
    assert(baselineStatus === 0 || baseline.length, `Baseline ${name} check failed without recognized TypeScript diagnostics; inspect log`);
    assert(candidateStatus === 0 || candidate.length, `Candidate ${name} check failed without recognized TypeScript diagnostics; inspect log`);
    const remaining = [...baseline];
    const introduced = candidate.filter(diagnostic => { const i = remaining.indexOf(diagnostic); if (i < 0) return true; remaining.splice(i, 1); return false; });
    result[name] = { baselineStatus, candidateStatus, preExisting: baseline, candidate, introduced, resolved: remaining };
  }
  fs.writeFileSync(path.join(evidence, 'typecheck-comparison.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(evidence, 'resolved-npm-comparison.json'), JSON.stringify(dependencies, null, 2));
  for (const [name, info] of Object.entries(dependencies)) assert.deepEqual(info.candidate, info.baseline, `${name} floating npm dependency resolution differs between baseline and candidate`);
  for (const [name, info] of Object.entries(result)) {
    console.log(`${name}: ${info.preExisting.length} baseline diagnostics; ${info.introduced.length} new candidate diagnostics`);
    assert.equal(info.introduced.length, 0, `New ${name} diagnostics: ${info.introduced.join('\n')}`);
  }
} else {
  const statusPath = process.env.MCC_RUNTIME_STATUS;
  assert(statusPath, 'Run scripts/validate_mcc_agentedge_runtime.sh; this test does not skip when runtime prerequisites are missing');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const api = status.API_URL ?? status.api_url;
  const serviceKey = status.SERVICE_ROLE_KEY ?? status.service_role_key;
  const workerSecret = process.env.MCC_RUNTIME_WORKER_SECRET;
  const container = process.env.MCC_RUNTIME_DB_CONTAINER;
  const evidence = process.env.MCC_RUNTIME_EVIDENCE;
  assert(api && serviceKey && workerSecret && container && evidence, 'Incomplete local runtime test configuration');
  const origin = new URL(api);
  assert(['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol === 'http:', 'Local-only runtime URL required');
  assert(/^supabase_db_mcc-agentedge-guard-[a-z0-9-]+$/.test(container), 'Unexpected DB container; refusing SQL');
  const USER = '0c6cabc6-72cc-4a2b-98bb-13fbc4991129';
  const OTHER = '11111111-1111-4111-8111-111111111111';
  const MISSING = '22222222-2222-4222-8222-222222222222';
  const MESSAGE = '33333333-3333-4333-8333-333333333333';
  const THREAD = '44444444-4444-4444-8444-444444444444';
  const QUEUE = '55555555-5555-4555-8555-555555555555';
  const audit = [];
  const sql = statement => {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, encoding: 'utf8' });
    assert.equal(result.status, 0, `Local SQL failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  async function localFetch(route, options = {}) {
    const url = new URL(route, api);
    assert.equal(url.origin, origin.origin);
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  }
  async function rest(route, options = {}) {
    const response = await localFetch(`/rest/v1/${route}`, { ...options, headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', ...options.headers } });
    assert(response.ok, `Local REST failed ${response.status}: ${await response.clone().text()}`);
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }
  async function edge(name, route, options = {}) {
    const response = await localFetch(`/functions/v1/${name}/${route}`, { method: 'POST', ...options });
    const encoded = response.headers.get('x-mcc-runtime-events');
    assert(encoded, `${name} did not boot test wrapper: ${response.status} ${await response.clone().text()}`);
    const events = JSON.parse(Buffer.from(encoded, 'base64').toString());
    const body = await response.json();
    const entry = { name, route, status: response.status, body, events, runtime: response.headers.get('x-mcc-runtime-version') };
    audit.push(entry);
    fs.writeFileSync(path.join(evidence, 'edge-runtime-observations.json'), JSON.stringify(audit, null, 2));
    assert.equal(events.filter(e => ['blocked_egress', 'blocked_extraction'].includes(e.kind)).length, 0, 'Forbidden downstream request attempted');
    return entry;
  }
  const headers = { 'x-worker-secret': workerSecret, 'content-type': 'application/json' };
  const controls = (user, stop, writes) => rest('mcc_safety_controls?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: user, emergency_stop: stop, automation_database_writes_enabled: writes }) });
  const policy = (name, userId) => edge(name, '__guard_test_policy', { headers, body: JSON.stringify({ userId }) });
  const noDownstream = row => {
    assert.equal(row.events.filter(e => e.secretKind === 'agentedge_service_key').length, 0);
    assert.equal(row.events.filter(e => e.kind === 'synthetic_triage').length, 0);
  };

  test('exact API and workers bundles boot with real dependencies, local auth and local PostgREST', { timeout: 240_000 }, async t => {
    let historicalUser, userToken;
    await t.test('synthetic local GoTrue user authenticates', async () => {
      const email = 'runtime-fixture@example.invalid';
      const password = `local-fixture-${crypto.randomUUID()}`;
      const created = await localFetch('/auth/v1/admin/users', { method: 'POST', headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
      assert(created.ok, `Local auth create failed ${created.status}: ${await created.clone().text()}`);
      historicalUser = (await created.json()).id;
      assert.match(historicalUser, /^[a-f0-9-]{36}$/);
      const signedIn = await localFetch('/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: serviceKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert(signedIn.ok, `Local sign-in failed: ${signedIn.status}`);
      userToken = (await signedIn.json()).access_token;
      assert(userToken);
    });
    await t.test('both full entrypoints boot and reject unauthenticated calls before guard reads', async () => {
      for (const [name, route, expected] of [['api', 'agentedge-relay', 500], ['api', 'agentedge-historical-import', 401], ['workers', 'triage-worker', 500]]) {
        const result = await edge(name, route);
        // Existing api/workers routers map uncaught worker HttpError to 500.
        // Preserve and document that baseline behavior, rather than invent 403.
        assert.equal(result.status, expected);
        assert(!result.events.some(e => e.path?.includes('mcc_safety_controls')));
        assert(!result.events.some(e => e.path?.includes('claim_jobs')));
        noDownstream(result);
      }
    });
    await t.test('real supabase-js helper: allowed, stopped, disabled, missing, null and database error', async () => {
      for (const name of ['api', 'workers']) {
        await controls(USER, false, true);
        assert.deepEqual((await policy(name, USER)).body, { allowed: true });
        for (const [stop, writes, reason] of [[true, true, 'emergency_stop'], [false, false, 'automation_database_writes_disabled'], [null, true, 'emergency_stop'], [false, null, 'automation_database_writes_disabled']]) {
          await controls(USER, stop, writes);
          assert.deepEqual((await policy(name, USER)).body, { allowed: false, status: 'paused', reason });
        }
        await controls(OTHER, false, true);
        assert.equal((await policy(name, MISSING)).body.reason, 'safety_controls_missing');
        assert.equal((await policy(name, 'not-a-uuid')).body.reason, 'safety_controls_unavailable');
      }
    });
    await t.test('RLS hides other-tenant control rows from the authenticated local user', async () => {
      await controls(historicalUser, true, false);
      const response = await localFetch('/rest/v1/mcc_safety_controls?select=user_id', { headers: { apikey: serviceKey, authorization: `Bearer ${userToken}` } });
      assert(response.ok);
      assert.deepEqual(await response.json(), [{ user_id: historicalUser }]);
    });
    await t.test('authenticated relay and historical import pause without trusting payload tenant IDs', async () => {
      await controls(USER, true, false);
      await controls(historicalUser, true, false);
      for (const [route, auth] of [['agentedge-relay', headers], ['agentedge-historical-import', { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' }]]) {
        const result = await edge('api', route, { headers: auth, body: JSON.stringify({ user_id: OTHER }) });
        assert.equal(result.status, 409);
        assert.equal(result.body.ok, false);
        assert.equal(result.body.status, 'paused');
        assert.equal(result.body.reason, 'emergency_stop');
        if (route === 'agentedge-relay') assert.equal(result.body.relayed, 0);
        noDownstream(result);
        const reads = result.events.filter(e => e.path === '/rest/v1/mcc_safety_controls');
        assert.equal(reads.length, 1);
        assert(reads[0].query.includes(route === 'agentedge-relay' ? USER : historicalUser));
      }
    });
    for (const mode of ['stopped', 'unreadable']) await t.test(`real triage wrapper preserves apply/meter/ack while guard is ${mode}`, async () => {
      await controls(USER, true, false);
      sql(`truncate public.runtime_events, public.runtime_jobs, public.messages, public.queue_items, public.agentedge_sync_log restart identity;
        insert into public.messages(id,user_id,thread_id,subject,snippet,channel) values ('${MESSAGE}','${USER}','${THREAD}','LOCAL RUNTIME TRIAGE FIXTURE','Synthetic test data','email');
        insert into public.queue_items(id,user_id,thread_id,state) values ('${QUEUE}','${USER}','${THREAD}','backlog');
        insert into public.runtime_jobs(msg_id,message) values (1,'{"message_id":"${MESSAGE}","user_id":"${OTHER}"}');`);
      if (mode === 'unreadable') sql('revoke select on public.mcc_safety_controls from public, anon, authenticated, service_role;');
      try {
        const result = await edge('workers', 'triage-worker', { headers });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { ok: true, processed: 1 });
        assert.equal(result.events.filter(e => e.kind === 'synthetic_triage').length, 1, 'Only ordinary triage model call is allowed');
        assert.equal(result.events.filter(e => e.secretKind === 'agentedge_service_key').length, 0);
        const pauses = result.events.filter(e => e.kind === 'pause_log');
        assert.equal(pauses.length, 1);
        assert.equal(pauses[0].reason, mode === 'stopped' ? 'emergency_stop' : 'safety_controls_unavailable');
        const recorded = await rest('runtime_events?order=id&select=event,payload');
        assert.deepEqual(recorded.map(e => e.event), ['claim_jobs', 'get_user_secret', 'check_spend', 'apply_model_triage', 'record_spend', 'ack_job', 'claim_jobs']);
        const spend = recorded.find(e => e.event === 'record_spend').payload;
        assert.equal(spend.purpose, 'triage');
        assert.equal(spend.tokens_in, 10);
        assert.equal(spend.tokens_out, 5);
        assert.equal(spend.cost, 0.000035);
        assert.deepEqual(await rest('runtime_jobs?select=acked'), [{ acked: true }]);
        assert.deepEqual(await rest('queue_items?select=category,state,agentedge_relayed_at'), [{ category: 'booking', state: 'backlog', agentedge_relayed_at: null }]);
        assert.deepEqual(await rest('agentedge_sync_log?select=*'), []);
      } finally {
        if (mode === 'unreadable') sql('grant select on public.mcc_safety_controls to service_role, authenticated;');
      }
    });
  });
}
