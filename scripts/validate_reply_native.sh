#!/usr/bin/env bash
# Validation only: a disposable Supabase project, synthetic providers, no production credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARIANT="${1:-main}"
[[ "$VARIANT" == main || "$VARIANT" == cutover ]] || exit 2
CUTOVER="${2:-}"
if [[ "$VARIANT" == cutover ]]; then
  [[ "$(git -C "$CUTOVER" rev-parse HEAD)" == 019098c85561c234dc3c49f0e16f0fb42c3b7ec6 ]] || { echo 'Wrong PR18 compatibility baseline' >&2; exit 2; }
  CUTOVER="$(cd "$CUTOVER" && pwd)"
fi
EVIDENCE="$ROOT/test-results/reply-native-$VARIANT"
mkdir -p "$EVIDENCE"
for tool in node deno supabase docker; do command -v "$tool" >/dev/null || exit 2; done
[[ "$(supabase --version)" == 2.75.0 ]] || exit 2
WORK="$(mktemp -d /tmp/mcc-reply-native.XXXXXX)"
LOCAL="$WORK/local";mkdir -p "$LOCAL"
PROJECT="mcc-reply-${RANDOM}-$$";SERVE_PID='';STARTED=0
cleanup() {
  local code=$?;trap - EXIT INT TERM
  if [[ -n "$SERVE_PID" ]]; then kill "$SERVE_PID" 2>/dev/null || true;wait "$SERVE_PID" 2>/dev/null || true;fi
  if [[ "$STARTED" == 1 ]]; then
    docker logs "supabase_edge_runtime_$PROJECT" >"$EVIDENCE/edge-container.log" 2>&1 || true
    (cd "$LOCAL" && supabase stop --no-backup) >"$EVIDENCE/cleanup.log" 2>&1 || true
  fi
  node "$ROOT/scripts/redact_reply_evidence.mjs" "$EVIDENCE"
  rm -rf "$WORK";exit "$code"
}
trap cleanup EXIT;trap 'exit 130' INT TERM
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_PROJECT_REF DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_ANON_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
export NO_COLOR=1
{ node --version;deno --version;supabase --version;docker version; } >"$EVIDENCE/tool-versions.log" 2>&1
(cd "$LOCAL" && supabase init) >"$EVIDENCE/init.log" 2>&1
node --input-type=module - "$LOCAL/supabase/config.toml" "$PROJECT" <<'NODE'
import fs from 'node:fs';const [p,id]=process.argv.slice(2);let s=fs.readFileSync(p,'utf8').replace(/^project_id\s*=.*$/m,`project_id = "${id}"`);fs.writeFileSync(p,s);
NODE
if [[ "$VARIANT" == cutover ]]; then
  node --experimental-vm-modules "$ROOT/scripts/materialize_reply_api.mjs" "$WORK/bundle" "$CUTOVER" >"$EVIDENCE/api-materialization.json"
else
  node --experimental-vm-modules "$ROOT/scripts/materialize_reply_api.mjs" "$WORK/bundle" >"$EVIDENCE/api-materialization.json"
fi
node "$ROOT/scripts/prepare_reply_native.mjs" "$LOCAL" "$EVIDENCE" "$VARIANT" "$CUTOVER"
STARTED=1
(cd "$LOCAL" && supabase start -x realtime,storage-api,imgproxy,postgres-meta,studio,logflare,vector,supavisor) >"$EVIDENCE/start.log" 2>&1
(cd "$LOCAL" && supabase status -o json) >"$WORK/status.json" 2>"$EVIDENCE/status.log"
export REPLY_DB_CONTAINER="supabase_db_$PROJECT" REPLY_STATUS="$WORK/status.json" REPLY_EVIDENCE="$EVIDENCE" REPLY_VARIANT="$VARIANT" REPLY_BROWSER_AUTH="$WORK/browser-auth.json"
for migration in 0001_core.sql 0002_channels_contacts_messages.sql 0003_queue_pipeline.sql 0004_rpcs.sql 0006_hotfixes.sql 0007_security_hardening.sql 0008_categorization_update.sql 0016_gmail_send_scope.sql; do
  docker exec -i "$REPLY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/supabase/migrations/$migration" >>"$EVIDENCE/schema.log" 2>&1
done
for source in tests/fixtures/reply-canonical-ingest.sql tests/fixtures/reply-native-support.sql supabase/migrations/20261004040537_reply_evidence_approval_dispatch_v1.sql; do
  docker exec -i "$REPLY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$ROOT/$source" >>"$EVIDENCE/schema.log" 2>&1
done
if [[ "$VARIANT" == cutover ]]; then
  docker exec -i "$REPLY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$CUTOVER/supabase/migrations/20261003231928_gmail_generation_mutation_fence_v1.sql" >>"$EVIDENCE/schema.log" 2>&1
fi
docker exec "$REPLY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "notify pgrst,'reload schema';" >>"$EVIDENCE/schema.log"
docker ps --format '{{.Names}} {{.Image}}' | grep -F "$PROJECT" >"$EVIDENCE/runtime-containers.log"
printf 'MCC_REPLY_DISPATCH_ENABLED=true\n' >"$WORK/functions.env"
(cd "$LOCAL" && exec supabase functions serve --env-file "$WORK/functions.env" --no-verify-jwt) >"$EVIDENCE/functions.log" 2>&1 &
SERVE_PID=$!
cd "$ROOT"
node --import tsx --test tests/reply-native.test.mjs 2>&1 | tee "$EVIDENCE/native-tests.tap"
node tests/reply-browser.test.mjs 2>&1 | tee "$EVIDENCE/browser-tests.log"
node tests/reply-item-detail-browser.test.mjs 2>&1 | tee "$EVIDENCE/item-detail-browser-tests.log"
echo 'PASS: native reply validation and Chromium evidence; synthetic providers only.'
