#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcc-v2-phase1.XXXXXX")"
STACK_STARTED=0

cleanup() {
  if [[ "$STACK_STARTED" -eq 1 ]]; then
    (cd "$TMP" && supabase stop --no-backup >/dev/null 2>&1) || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker-compatible runtime is required."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running."
command -v supabase >/dev/null 2>&1 || fail "Supabase CLI is required."
command -v node >/dev/null 2>&1 || fail "Node.js is required for deterministic static tests."

[[ -f "$ROOT/supabase/migrations/0022_live_schema_reconciliation.sql" ]] || fail "0022 migration missing."
[[ -f "$ROOT/supabase/migrations/0023_mcc_v2_phase1.sql" ]] || fail "0023 migration missing."
[[ -f "$ROOT/tests/mcc_v2_phase1_integration.sql" ]] || fail "integration suite missing."
[[ -f "$ROOT/tests/mcc_v2_phase1_static.test.mjs" ]] || fail "static test suite missing."

printf '\n[1/6] Deterministic static tests\n'
(
  cd "$ROOT"
  node --test tests/mcc_v2_phase1_static.test.mjs
)

printf '\n[2/6] Initializing isolated temporary Supabase project\n'
(
  cd "$TMP"
  supabase init
)
mkdir -p "$TMP/supabase/migrations"
cp "$ROOT"/supabase/migrations/*.sql "$TMP/supabase/migrations/"

printf '\n[3/6] Starting local Supabase stack\n'
(
  cd "$TMP"
  supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor
)
STACK_STARTED=1

printf '\n[4/6] Clean local rebuild through migration 0023\n'
(
  cd "$TMP"
  supabase db reset --local --no-seed
)

printf '\n[5/6] Local database lint\n'
(
  cd "$TMP"
  supabase db lint --local --fail-on error
)

printf '\n[6/6] MCC PostgreSQL integration suite\n'
DB_CONTAINER="$(
  docker ps --format '{{.ID}} {{.Ports}} {{.Names}}' |
  awk '/127\.0\.0\.1:54322->5432\/tcp|0\.0\.0\.0:54322->5432\/tcp|:::54322->5432\/tcp/ {print $1; exit}'
)"
[[ -n "$DB_CONTAINER" ]] || DB_CONTAINER="$(docker ps --format '{{.ID}} {{.Names}}' | awk '$2 ~ /^supabase_db_/ {print $1; exit}')"
[[ -n "$DB_CONTAINER" ]] || fail "Could not identify local Supabase Postgres container."

docker exec -i "$DB_CONTAINER"   psql -v ON_ERROR_STOP=1 -U postgres -d postgres   < "$ROOT/tests/mcc_v2_phase1_integration.sql"

printf '\nPASS: MCC v2 Phase 1 local validation completed successfully.\n'
printf 'Validated migrations: 0001 through 0023\n'
printf 'Production was not contacted or modified by this runner.\n'
