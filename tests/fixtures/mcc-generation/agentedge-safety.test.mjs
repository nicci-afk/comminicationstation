import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = process.env.MCC_GENERATION_BUNDLES; assert(ROOT, "materialized generation bundles required");
const REPOSITORY = fs.existsSync(path.join(ROOT, "supabase/functions/api/index.ts"));
const sourcePath = relative => REPOSITORY
  ? path.join(ROOT, "supabase/functions", relative.replace(/^api\/api\//, "api/"))
  : path.join(ROOT, "candidate", relative);
const USER = "0c6cabc6-72cc-4a2b-98bb-13fbc4991129";
const OTHER = "11111111-1111-4111-8111-111111111111";
const allowedRow = (user = USER) => ({ user_id: user, emergency_stop: false, automation_database_writes_enabled: true });
const request = (headers = {}) => new Request("https://fixture.invalid/route", { method: "POST", headers });

// Real proposed modules and real auth/worker wrapper, isolated in a VM. Only
// database, LLM, console, and fetch boundaries are mocked. No real credentials,
// sockets, environment, production endpoints, or dependency installs are used.
async function fixture(options = {}) {
  const trace = [], calls = [], logs = [];
  const opt = { row: allowedRow(), category: "booking", ...options };
  let claims = 0;
  const db = {
    auth: { async getUser(token) {
      trace.push({ kind: "auth", token });
      return token === "fixture-user"
        ? { data: { user: { id: opt.userId ?? USER, email: "fixture@example.invalid" } }, error: null }
        : { data: { user: null }, error: { message: "fixture auth rejected" } };
    } },
    from(table) {
      const q = { kind: "query", table, filters: [], operation: "select" };
      let proxy;
      const execute = async () => {
        trace.push(q);
        if (table === "mcc_safety_controls") {
          if (opt.throwRead) throw new Error("private-database-error-canary");
          const row = typeof opt.row === "function" ? opt.row(q) : opt.row;
          return { data: row, error: opt.readError ? { message: "private-database-error-canary" } : null };
        }
        if (q.operation !== "select") return { data: null, error: null };
        if (table === "messages") return { data: { id: "message-1", user_id: USER, thread_id: "thread-1", subject: "Synthetic fixture", body_text: "Synthetic fixture", from_identifier: "source@example.invalid", channel: "email" }, error: null };
        if (table === "businesses") return { data: [], error: null };
        if (table === "queue_items") return { data: q.single ? { id: "queue-1" } : [{ id: "queue-1", category: opt.category, created_at: "2026-10-02T00:00:00Z" }], error: null };
        throw new Error(`Unexpected fixture table: ${table}`);
      };
      proxy = new Proxy({}, { get(_target, name) {
        if (name === "then") return (resolve, reject) => execute().then(resolve, reject);
        if (name === "maybeSingle") return () => { q.single = true; return execute(); };
        return (...args) => {
          if (["insert", "update", "delete", "upsert"].includes(name)) { q.operation = name; q.payload = args[0]; }
          else if (name === "select") q.columns = args[0];
          else q.filters.push([name, ...args]);
          return proxy;
        };
      } });
      return proxy;
    },
    async rpc(name, args) {
      trace.push({ kind: "rpc", name, args });
      if (name === "get_user_secret") return { data: opt.noSecrets ? null : "fixture-secret-never-real", error: null };
      if (name === "claim_jobs") return { data: claims++ === 0 ? [{ msg_id: 1, read_ct: 1, message: { message_id: "message-1", user_id: OTHER } }] : [], error: null };
      if (name === "check_spend") return { data: { allowed: true }, error: null };
      if (["apply_model_triage", "ack_job", "record_spend"].includes(name)) return { data: null, error: null };
      throw new Error(`Unexpected fixture RPC: ${name}`);
    },
  };
  const env = { SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-only", WORKER_SECRET: "fixture-worker", SUPABASE_ANON_KEY: "fixture-anon" };
  const context = vm.createContext({
    Request, Response, URL, setTimeout, clearTimeout,
    Deno: { env: { get: (name) => { trace.push({ kind: "env", name }); return env[name]; } } },
    console: Object.fromEntries(["info", "warn", "error", "log"].map(level => [level, (...args) => logs.push({ level, args })])),
    fetch: async (url, init = {}) => {
      trace.push({ kind: "fetch", url, method: init.method ?? "GET" });
      calls.push({ url, init });
      return new Response(JSON.stringify(init.method === "POST" ? [{ id: "fixture-created" }] : []), { status: 200 });
    },
  });
  const cache = new Map();
  function synthetic(id, exports) {
    const mod = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context, identifier: id });
    cache.set(id, mod); return mod;
  }
  synthetic("@supabase/supabase-js", { createClient: () => db, SupabaseClient: class {} });
  function getModule(filename) {
    if (cache.has(filename)) return cache.get(filename);
    if (filename.endsWith("/_shared/llm.ts")) return synthetic(filename, { callAnthropic: async (input) => {
      trace.push({ kind: "model", input });
      return { parsed: { category: opt.category }, provider: "fixture", model: "fixture", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    } });
    const mod = new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(filename, "utf8"), { mode: "strip" }), { context, identifier: filename });
    cache.set(filename, mod); return mod;
  }
  async function load(relative) {
    const mod = getModule(sourcePath(relative));
    if (mod.status === "unlinked") await mod.link((specifier, parent) => getModule(specifier.startsWith(".") ? path.resolve(path.dirname(parent.identifier), specifier) : specifier));
    if (mod.status === "linked") await mod.evaluate();
    return mod.namespace;
  }
  return { trace, calls, logs, db, opt, load };
}

const deniedCases = [
  ["emergency stop", { row: { ...allowedRow(), emergency_stop: true } }, "emergency_stop"],
  ["writes disabled", { row: { ...allowedRow(), automation_database_writes_enabled: false } }, "automation_database_writes_disabled"],
  ["both paused", { row: { ...allowedRow(), emergency_stop: true, automation_database_writes_enabled: false } }, "emergency_stop"],
  ["missing row", { row: null }, "safety_controls_missing"],
  ["null stop", { row: { ...allowedRow(), emergency_stop: null } }, "emergency_stop"],
  ["missing stop", { row: { user_id: USER, automation_database_writes_enabled: true } }, "emergency_stop"],
  ["null writes", { row: { ...allowedRow(), automation_database_writes_enabled: null } }, "automation_database_writes_disabled"],
  ["missing writes", { row: { user_id: USER, emergency_stop: false } }, "automation_database_writes_disabled"],
  ["string false stop", { row: { ...allowedRow(), emergency_stop: "false" } }, "emergency_stop"],
  ["string true writes", { row: { ...allowedRow(), automation_database_writes_enabled: "true" } }, "automation_database_writes_disabled"],
  ["numeric stop", { row: { ...allowedRow(), emergency_stop: 0 } }, "emergency_stop"],
  ["numeric writes", { row: { ...allowedRow(), automation_database_writes_enabled: 1 } }, "automation_database_writes_disabled"],
  ["read error even with allowed data", { readError: true }, "safety_controls_unavailable"],
  ["thrown read", { throwRead: true }, "safety_controls_unavailable"],
  ["foreign tenant returned", { row: allowedRow(OTHER) }, "safety_controls_invalid"],
  ["malformed row", { row: [] }, "safety_controls_invalid"],
];

function assertDeniedSideEffects(f) {
  assert.equal(f.calls.length, 0, "no AgentEdge requests");
  assert.equal(f.trace.filter(x => x.kind === "model").length, 0, "no extraction calls");
  assert.equal(f.trace.filter(x => x.kind === "rpc").length, 0, "no AgentEdge/extraction secret reads or mutation RPCs");
  assert.equal(f.trace.filter(x => x.kind === "query" && x.operation !== "select").length, 0, "no relay stamp or success/approval logs");
  const queries = f.trace.filter(x => x.kind === "query");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, "mcc_safety_controls");
  assert.deepEqual(queries[0].filters, [["eq", "user_id", USER]]);
  assert.equal(queries[0].columns, "user_id,emergency_stop,automation_database_writes_enabled");
  assert.ok(!JSON.stringify(f.logs).includes("private-database-error-canary"));
}

for (const [name, options, reason] of deniedCases) {
  for (const category of ["booking", "bdm", "possible_supplier", "promotion"]) test(`push ${category}: ${name} denies before side effects`, async () => {
    const f = await fixture(options);
    const mod = await f.load("workers/_shared/agentedge-push.ts");
    await mod.maybePushToAgentedge(f.db, USER, "message-1", category);
    assertDeniedSideEffects(f);
    const notice = JSON.parse(f.logs[0].args[0]);
    assert.equal(notice.status, "paused"); assert.equal(notice.reason, reason); assert.equal(notice.allowed, false);
    assert.equal(notice.event, "agentedge_write_paused");
  });
  for (const route of ["agentedge-relay", "agentedge-historical-import"]) test(`${route}: ${name} returns truthful paused response`, async () => {
    const f = await fixture(options);
    const mod = await f.load(`api/api/${route}.ts`);
    const response = await mod.default(request({ authorization: "Bearer fixture-user", "x-worker-secret": "fixture-worker" }));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.ok, false); assert.equal(body.status, "paused"); assert.equal(body.reason, reason);
    if (route === "agentedge-relay") assert.equal(body.relayed, 0);
    assert.equal(body.phase2, undefined);
    assertDeniedSideEffects(f);
  });
}

test("missing tenant fails closed without querying", async () => {
  const f = await fixture(); const mod = await f.load("api/api/_shared/agentedge-safety.ts");
  assert.equal((await mod.agentedgeWritePolicy(f.db, "")).allowed, false);
  assert.equal(f.trace.length, 0);
});

test("irrelevant category does no policy work", async () => {
  const f = await fixture(); const mod = await f.load("workers/_shared/agentedge-push.ts");
  await mod.maybePushToAgentedge(f.db, USER, "message-1", "personal");
  assert.equal(f.trace.filter(x => x.kind === "query").length, 0); assert.equal(f.calls.length, 0);
});

test("policy is not cached between calls", async () => {
  const f = await fixture(); const mod = await f.load("api/api/_shared/agentedge-safety.ts");
  assert.equal((await mod.agentedgeWritePolicy(f.db, USER)).allowed, true);
  f.opt.row = { ...allowedRow(), emergency_stop: true };
  assert.equal((await mod.agentedgeWritePolicy(f.db, USER)).allowed, false);
  assert.equal(f.trace.filter(x => x.kind === "query").length, 2);
});

test("tenant's own denied controls cannot be replaced by another tenant's allowed row", async () => {
  const rows = new Map([[USER, { ...allowedRow(), emergency_stop: true }], [OTHER, allowedRow(OTHER)]]);
  const f = await fixture({ row: q => rows.get(q.filters.find(x => x[0] === "eq" && x[1] === "user_id")[2]) });
  const mod = await f.load("api/api/_shared/agentedge-safety.ts");
  assert.equal((await mod.agentedgeWritePolicy(f.db, USER)).allowed, false);
  assert.equal((await mod.agentedgeWritePolicy(f.db, OTHER)).allowed, true);
});

for (const route of ["agentedge-relay", "agentedge-historical-import"]) test(`${route}: authentication precedes policy reads`, async () => {
  const f = await fixture(); const mod = await f.load(`api/api/${route}.ts`);
  if (route === "agentedge-relay") await assert.rejects(mod.default(request({ "x-worker-secret": "wrong" })), /bad worker secret/);
  else assert.equal((await mod.default(request({ authorization: "Bearer wrong" }))).status, 401);
  assert.equal(f.trace.filter(x => x.kind === "query" || x.kind === "rpc" || x.kind === "model").length, 0);
  assert.equal(f.calls.length, 0);
});

test("historical import derives tenant from authenticated user, ignoring payload", async () => {
  const f = await fixture({ userId: OTHER, row: null }); const mod = await f.load("api/api/agentedge-historical-import.ts");
  const req = new Request("https://fixture.invalid", { method: "POST", headers: { authorization: "Bearer fixture-user" }, body: JSON.stringify({ userId: USER }) });
  assert.equal((await mod.default(req)).status, 409);
  const auth = f.trace.findIndex(x => x.kind === "auth"); const read = f.trace.findIndex(x => x.kind === "query");
  assert.ok(auth < read); assert.deepEqual(f.trace[read].filters, [["eq", "user_id", OTHER]]);
});

for (const category of ["booking", "bdm", "possible_supplier", "promotion"]) test(`explicit permission reaches legacy ${category} push only after policy`, async () => {
  const f = await fixture({ category }); const mod = await f.load("workers/_shared/agentedge-push.ts");
  await mod.maybePushToAgentedge(f.db, USER, "message-1", category);
  assert.equal(f.calls.length, 1);
  const policy = f.trace.findIndex(x => x.kind === "query" && x.table === "mcc_safety_controls");
  const secret = f.trace.findIndex(x => x.kind === "rpc" && x.name === "get_user_secret");
  assert.ok(policy < secret);
  assert.equal(f.trace.filter(x => x.kind === "query" && x.table === "queue_items" && x.operation === "update").length, 1);
});

test("explicit permission reaches relay path", async () => {
  const f = await fixture(); const mod = await f.load("api/api/agentedge-relay.ts");
  const response = await mod.default(request({ "x-worker-secret": "fixture-worker" }));
  assert.equal(response.status, 200); assert.equal((await response.json()).relayed, 1); assert.equal(f.calls.length, 1);
});

test("explicit permission reaches historical reconciliation path", async () => {
  const f = await fixture(); const mod = await f.load("api/api/agentedge-historical-import.ts");
  const response = await mod.default(request({ authorization: "Bearer fixture-user" }));
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true); assert.equal(f.calls.length, 2);
});

for (const readOptions of [{ row: { ...allowedRow(), emergency_stop: true } }, { throwRead: true }]) test(`paused AgentEdge handoff preserves triage, metering and queue acknowledgement (${readOptions.throwRead ? "read failure" : "stop"})`, async () => {
  const f = await fixture(readOptions); const mod = await f.load("workers/triage-worker.ts");
  const response = await mod.default(request({ "x-worker-secret": "fixture-worker" }));
  assert.equal(response.status, 200); assert.equal((await response.json()).processed, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.trace.filter(x => x.kind === "model").length, 1, "ordinary triage remains enabled; no AgentEdge extraction");
  const names = f.trace.filter(x => x.kind === "rpc").map(x => x.name);
  assert.ok(names.includes("apply_model_triage")); assert.ok(names.includes("record_spend")); assert.ok(names.includes("ack_job"));
  assert.equal(f.trace.filter(x => x.kind === "rpc" && x.name === "get_user_secret" && x.args.p_kind === "agentedge_service_key").length, 0);
  assert.equal(f.trace.filter(x => x.kind === "query" && x.operation !== "select").length, 0);
  const policy = f.trace.find(x => x.kind === "query" && x.table === "mcc_safety_controls");
  assert.deepEqual(policy.filters, [["eq", "user_id", USER]], "tenant comes from persisted message, not job payload");
});

test("unauthenticated triage never claims jobs or reads controls", async () => {
  const f = await fixture(); const mod = await f.load("workers/triage-worker.ts");
  await assert.rejects(mod.default(request({ "x-worker-secret": "wrong" })), /bad worker secret/);
  assert.equal(f.trace.filter(x => x.kind === "rpc" || x.kind === "query" || x.kind === "model").length, 0);
  assert.equal(f.calls.length, 0);
});
