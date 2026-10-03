#!/usr/bin/env bash
# Disposable, local-only actual-runtime gate. No link, deploy, remote DB or
# production credentials. Preserve exact source plus test-wrapper manifest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="${MCC_SYNC_RUNTIME_EVIDENCE:-$ROOT/test-results/mcc-sync-runtime}"
mkdir -p "$EVIDENCE"
EVIDENCE="$(cd "$EVIDENCE" && pwd)"
for tool in node deno supabase docker; do
  command -v "$tool" >/dev/null || { echo "BLOCKED: required runtime tool missing: $tool" >&2; exit 2; }
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node 24 required' >&2; exit 2; }
[[ "$(supabase --version)" == 2.75.0 ]] || { echo 'Supabase CLI 2.75.0 required' >&2; exit 2; }
docker info >"$EVIDENCE/docker-info.log" 2>&1
{ node --version; deno --version; supabase --version; docker version; } >"$EVIDENCE/tool-versions.log" 2>&1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcc-sync-runtime.XXXXXX")"
LOCAL="$WORK/local"
mkdir -p "$LOCAL"
PROJECT="mcc-sync-runtime-${RANDOM}-$$"
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
  if (!name.endsWith('.log')) continue;
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
if [[ $# == 0 ]]; then node --experimental-vm-modules "$ROOT/scripts/materialize_mcc_sync_release.mjs" "$BUNDLES"; fi
BUNDLES="$(cd "$BUNDLES" && pwd)"
# Dependency/typecheck comparison for both complete bundles is run by the
# preceding unchanged containment runner. This fixture adds real Gmail-path
# PostgREST/CAS/queue tests; it does not replace that release-wide gate.
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
node "$ROOT/tests/mcc_sync_runtime.test.mjs" --prepare "$BUNDLES" "$LOCAL" "$EVIDENCE"
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
export MCC_SYNC_RUNTIME_DB_CONTAINER="supabase_db_$PROJECT"
docker exec -i "$MCC_SYNC_RUNTIME_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/tests/fixtures/mcc_sync_runtime.sql" >"$EVIDENCE/schema.log" 2>&1
export MCC_SYNC_RUNTIME_WORKER_SECRET="mcc-local-fixture-$PROJECT"
printf 'WORKER_SECRET=%s\n' "$MCC_SYNC_RUNTIME_WORKER_SECRET" >"$WORK/functions.env"
(cd "$LOCAL" && exec supabase functions serve --env-file "$WORK/functions.env" --no-verify-jwt) >"$EVIDENCE/functions-serve.log" 2>&1 &
SERVE_PID=$!
export MCC_SYNC_RUNTIME_STATUS="$WORK/status.json" MCC_SYNC_RUNTIME_EVIDENCE="$EVIDENCE"
# Bounded boot wait requires the test wrapper, not merely a live proxy.
node --input-type=module <<'NODE'
import fs from 'node:fs';
const status = JSON.parse(fs.readFileSync(process.env.MCC_SYNC_RUNTIME_STATUS, 'utf8'));
const root = status.API_URL ?? status.api_url;
const u = new URL(root);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol !== 'http:') throw Error('Non-local status URL');
for (const name of ['sync-runtime']) {
  const end = Date.now() + 120_000;
  let detail = '';
  while (Date.now() < end) {
    try {
      const response = await fetch(`${root}/functions/v1/${name}/__runtime_boot`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.status === 404 && response.headers.has('x-mcc-sync-runtime')) { detail = ''; break; }
      detail = `${response.status}: ${(await response.text()).slice(0, 500)}`;
    } catch (error) { detail = String(error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (detail) throw Error(`${name} boot failed: ${detail}`);
}
NODE
node --test "$ROOT/tests/mcc_sync_runtime.test.mjs" 2>&1 | tee "$EVIDENCE/runtime-tests.tap"
echo 'PASS: isolated Gmail worker, real PostgREST/queue/lock/checkpoint and provider-ID replay tests.'
echo 'Synthetic provider/ingestion business fixtures only; no production/Gmail/model request or deployment performed.'
