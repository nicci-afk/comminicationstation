#!/usr/bin/env bash
# Disposable, local-only actual-runtime gate. No link, deploy, remote DB or
# production credentials. Preserve exact source plus test-wrapper manifest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="${MCC_COST_EVIDENCE:-$ROOT/test-results/mcc-cost-native}"
mkdir -p "$EVIDENCE"
EVIDENCE="$(cd "$EVIDENCE" && pwd)"
for tool in node deno supabase docker; do
  command -v "$tool" >/dev/null || { echo "BLOCKED: required runtime tool missing: $tool" >&2; exit 2; }
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node 24 required' >&2; exit 2; }
[[ "$(supabase --version)" == 2.75.0 ]] || { echo 'Supabase CLI 2.75.0 required' >&2; exit 2; }
docker info >"$EVIDENCE/docker-info.log" 2>&1
{ node --version; deno --version; supabase --version; docker version; } >"$EVIDENCE/tool-versions.log" 2>&1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcc-cost-native.XXXXXX")"
LOCAL="$WORK/local"
mkdir -p "$LOCAL"
PROJECT="mcc-cost-${RANDOM}-$$"
SERVE_PID=''
STARTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVE_PID" ]]; then kill "$SERVE_PID" 2>/dev/null || true; wait "$SERVE_PID" 2>/dev/null || true; fi
  if [[ "$STARTED" == 1 ]]; then
    docker logs "supabase_edge_runtime_$PROJECT" >"$EVIDENCE/edge-container.log" 2>&1 || true
    (cd "$LOCAL" && supabase stop --no-backup) >>"$EVIDENCE/cleanup.log" 2>&1 || true
  fi
  # CLI local startup summaries may print disposable API keys. They are not
  # production credentials, but must not be uploaded in the evidence artifact.
  node --input-type=module - "$EVIDENCE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
for (const name of fs.readdirSync(root)) {
  if (!/\.(log|tap)$/.test(name)) continue;
  const file = path.join(root, name);
  let value = fs.readFileSync(file, 'utf8').replace(/\u001b\[[0-9;]*m/g, '');
  value = value.replace(/^.*(?:anon key|service_role key|Secret key|Publishable key|JWT secret|S3 Access Key|S3 Secret Key).*$/gmi, '[local credential summary redacted]');
  value = value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[local JWT redacted]');
  value = value.replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[local key redacted]');
  value = value.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1[redacted]@');
  fs.writeFileSync(file, value);
}
NODE
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Do not leak connected production credentials into any CLI or child process.
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_PROJECT_REF DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
BUNDLES="${1:-$WORK/bundles}"
if [[ $# == 0 ]]; then node --experimental-vm-modules "$ROOT/scripts/materialize_mcc_cost_release.mjs" "$BUNDLES"; fi
BUNDLES="$(cd "$BUNDLES" && pwd)"
# Full exact API24/workers18 versus cost candidate graphs and no-new diagnostics.
# No source rewriting, changed prompt variants or historical manifest weakening.
export DENO_DIR="$WORK/deno-cache"
for stage in baseline candidate; do
 for function in api workers; do
  base="$BUNDLES/$stage/$function"; [[ "$function" == api ]] && base="$base/api"
  deno cache --no-lock --config "$base/deno.json" "$base/index.ts" >"$EVIDENCE/$stage-$function-cache.log" 2>&1
  deno info --no-lock --json --config "$base/deno.json" "$base/index.ts" >"$EVIDENCE/$stage-$function-dependencies.json" 2>"$EVIDENCE/$stage-$function-info.log"
  code=0; deno check --no-lock --config "$base/deno.json" "$base/index.ts" >"$EVIDENCE/$stage-$function-check.log" 2>&1 || code=$?
  printf '%s\n' "$code" >"$EVIDENCE/$stage-$function-check.exit"
 done
done
node "$ROOT/tests/mcc_agentedge_runtime.test.mjs" --compare-checks "$EVIDENCE"
node --input-type=module - "$EVIDENCE" <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
for (const stage of ['baseline','candidate']) {
 const graph=JSON.parse(fs.readFileSync(`${process.argv[2]}/${stage}-workers-dependencies.json`));
 assert(Object.values(graph.npmPackages).some(p=>p.name==='@anthropic-ai/sdk'&&p.version==='0.131.0'), 'Native SDK must match reviewed no-retry proof');
}
NODE
export NO_COLOR=1
(cd "$LOCAL" && supabase init) >"$EVIDENCE/init.log" 2>&1
node --input-type=module - "$LOCAL/supabase/config.toml" "$PROJECT" <<'NODE'
import fs from 'node:fs';
const [file, project] = process.argv.slice(2);
let text = fs.readFileSync(file, 'utf8').replace(/^project_id\s*=.*$/m, `project_id = "${project}"`);
// Local auth fixture uses no real email transport.
text = text.replace(/\[auth.email\]([\s\S]*?)(?=\n\[|$)/, (section) => section.replace(/^enable_confirmations\s*=.*$/m, 'enable_confirmations = false'));
fs.writeFileSync(file, text);
NODE
node "$ROOT/scripts/prepare_mcc_cost_native.mjs" "$BUNDLES" "$LOCAL" "$EVIDENCE"
# All names are CLI 2.75.0 local containers. Auth, Kong, PostgREST, DB and
# Edge runtime remain enabled. Supabase owns the throwaway project's network.
STARTED=1
(cd "$LOCAL" && supabase start -x realtime,storage-api,imgproxy,postgres-meta,studio,logflare,vector,supavisor) >"$EVIDENCE/start.log" 2>&1
(cd "$LOCAL" && supabase status -o json) >"$WORK/status.json" 2>"$EVIDENCE/status.log"
# Non-sensitive observed image/version evidence; never inspect container env.
docker ps --format '{{.Names}} {{.Image}}' | grep -F -- "$PROJECT" >"$EVIDENCE/runtime-containers.log"
REST_CONTAINER="$(awk '$2 ~ /postgrest/ {print $1}' "$EVIDENCE/runtime-containers.log")"
[[ -n "$REST_CONTAINER" && "$REST_CONTAINER" != *$'\n'* ]] || { echo 'Expected one disposable PostgREST container' >&2; exit 2; }
docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' "$REST_CONTAINER" >"$EVIDENCE/postgrest-image.log"
docker exec "$REST_CONTAINER" postgrest --version >"$EVIDENCE/postgrest-version.log" 2>&1
export MCC_COST_DB_CONTAINER="supabase_db_$PROJECT"
# Explicit canonical schema subset; deliberately excludes cron/poke migrations.
for migration in 0001_core.sql 0002_channels_contacts_messages.sql 0003_queue_pipeline.sql 0004_rpcs.sql 0006_hotfixes.sql 0007_security_hardening.sql 0008_categorization_update.sql 0016_gmail_send_scope.sql; do
 docker exec -i "$MCC_COST_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/supabase/migrations/$migration" >>"$EVIDENCE/schema.log" 2>&1
done
for fixture in native-support.sql; do
 docker exec -i "$MCC_COST_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/tests/fixtures/mcc-cost/$fixture" >>"$EVIDENCE/schema.log" 2>&1
done
for migration in 20261003231928_gmail_generation_mutation_fence_v1.sql 20261004030453_triage_cost_reservations_v1.sql; do
 docker exec -i "$MCC_COST_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/supabase/migrations/$migration" >>"$EVIDENCE/schema.log" 2>&1
done
export MCC_COST_WORKER_SECRET="mcc-local-fixture-$PROJECT"
printf 'WORKER_SECRET=%s\n' "$MCC_COST_WORKER_SECRET" >"$WORK/functions.env"
(cd "$LOCAL" && exec supabase functions serve --env-file "$WORK/functions.env" --no-verify-jwt) >"$EVIDENCE/functions-serve.log" 2>&1 &
SERVE_PID=$!
export MCC_COST_STATUS="$WORK/status.json" MCC_COST_EVIDENCE="$EVIDENCE"
# Bounded boot wait requires the test wrapper, not merely a live proxy.
node --input-type=module <<'NODE'
import fs from 'node:fs';
const status = JSON.parse(fs.readFileSync(process.env.MCC_COST_STATUS, 'utf8'));
const root = status.API_URL ?? status.api_url;
const u = new URL(root);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol !== 'http:') throw Error('Non-local status URL');
for (const name of ['cost-runtime']) {
  const end = Date.now() + 120_000;
  let detail = '';
  while (Date.now() < end) {
    try {
      const response = await fetch(`${root}/functions/v1/${name}/__runtime_boot`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.status === 404 && response.headers.has('x-mcc-cost-runtime')) { detail = ''; break; }
      detail = `${response.status}: ${(await response.text()).slice(0, 500)}`;
    } catch (error) { detail = String(error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (detail) throw Error(`${name} boot failed: ${detail}`);
}
NODE
export MCC_COST_WORKER_SECRET="$MCC_COST_WORKER_SECRET" MCC_COST_STATUS="$MCC_COST_STATUS" MCC_COST_EVIDENCE="$EVIDENCE"
node --test "$ROOT/tests/mcc_cost_native.test.mjs" 2>&1 | tee "$EVIDENCE/runtime-tests.tap"
echo 'PASS: native cost reservations, effective ACLs, actual PostgREST, canonical triage and exact Edge bundle.'
echo 'Synthetic billing policy/model transport only; no production, deployment, or real provider request.'
