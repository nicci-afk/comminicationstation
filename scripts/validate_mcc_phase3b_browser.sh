#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCC_TEST_DIR="$(mktemp -d /tmp/mcc-phase3b-browser.XXXXXX)"
cleanup() {
  MCC_EXIT_CODE=$?
  if [[ "$MCC_EXIT_CODE" -ne 0 ]]; then
    [[ ! -f "$MCC_TEST_DIR/edge.log" ]] || tail -60 "$MCC_TEST_DIR/edge.log"
    [[ ! -f "$MCC_TEST_DIR/web.log" ]] || tail -30 "$MCC_TEST_DIR/web.log"
  fi
  [[ -z "${WEB_PID:-}" ]] || kill "$WEB_PID" 2>/dev/null || true
  [[ -z "${EDGE_PID:-}" ]] || kill "$EDGE_PID" 2>/dev/null || true
  "$ROOT/node_modules/.bin/agent-browser" close >/dev/null 2>&1 || true
  (cd "$MCC_TEST_DIR" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$MCC_TEST_DIR"
}
trap cleanup EXIT
cd "$MCC_TEST_DIR"
supabase init >/dev/null
mkdir -p supabase/migrations supabase/functions
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"; prefix="${name%%_*}"
  if (( 10#$prefix <= 24 )); then cp "$migration" supabase/migrations/; fi
done
cp -R "$ROOT/supabase/functions/api" supabase/functions/
supabase start -x studio,imgproxy,storage-api,logflare,vector,supavisor
supabase db reset --local --no-seed
DB_CONTAINER="$(docker ps --format '{{.ID}} {{.Ports}}' | awk '/54322->5432/ {print $1; exit}')"
test -n "$DB_CONTAINER"
for sql in "$ROOT/scripts/mcc_phase3_manual_writes.sql" "$ROOT/scripts/mcc_phase3b_fast_capture.sql"; do
  docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$sql"
done
docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
insert into public.allowed_emails(email,note) values('mcc-browser-a@example.invalid','isolated browser fixture'),('mcc-browser-b@example.invalid','isolated browser fixture');
SQL
supabase db lint --local --fail-on error
supabase status -o json > "$MCC_TEST_DIR/local-status.json"
supabase functions serve api --no-verify-jwt > "$MCC_TEST_DIR/edge.log" 2>&1 &
EDGE_PID=$!
# Only this throwaway web copy receives local configuration. Candidate config is preserved.
mkdir -p "$MCC_TEST_DIR/web"
cp -R "$ROOT/apps/web/src" "$ROOT/apps/web/index.html" "$ROOT/apps/web/vite.config.ts" "$ROOT/apps/web/tsconfig.json" "$ROOT/apps/web/package.json" "$MCC_TEST_DIR/web/"
ln -s "$ROOT/apps/web/node_modules" "$MCC_TEST_DIR/web/node_modules"
node --input-type=module - "$MCC_TEST_DIR" <<'JS'
import fs from 'node:fs';
const dir=process.argv[2]; const config=JSON.parse(fs.readFileSync(dir+'/local-status.json','utf8'));
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(config.API_URL)) throw new Error('Refusing nonlocal backend');
fs.writeFileSync(dir+'/web/src/lib/config.ts',`export const SUPABASE_URL=${JSON.stringify(config.API_URL)};\nexport const SUPABASE_ANON_KEY=${JSON.stringify(config.ANON_KEY)};\nexport const API_BASE=SUPABASE_URL+'/functions/v1/api';\n`);
JS
cd "$MCC_TEST_DIR/web"
"$ROOT/apps/web/node_modules/.bin/vite" --host 127.0.0.1 --port 4173 > "$MCC_TEST_DIR/web.log" 2>&1 &
WEB_PID=$!
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4173 >/dev/null 2>&1 && break; sleep 1; done
# First verify the running dev server using agent-browser.
export AGENT_BROWSER_EXECUTABLE_PATH="$(cd "$ROOT" && node --input-type=module -e 'import { chromium } from "playwright"; console.log(chromium.executablePath())')"
"$ROOT/node_modules/.bin/agent-browser" open http://127.0.0.1:4173/executive
"$ROOT/node_modules/.bin/agent-browser" snapshot -i
"$ROOT/node_modules/.bin/agent-browser" eval 'document.body.innerText.trim().length>0 && !document.querySelector("vite-error-overlay")'
"$ROOT/node_modules/.bin/agent-browser" close
cd "$ROOT"
MCC_LOCAL_STATUS="$MCC_TEST_DIR/local-status.json" node tests/mcc_phase3b_browser.test.mjs

# Today reliability uses intercepted queue fixtures after the authenticated flow.
# Jobs do not share dist: produce CSS from this exact checkout for the fixture.
npm run build --prefix apps/web
node tests/mcc_today_queue_browser.test.mjs
