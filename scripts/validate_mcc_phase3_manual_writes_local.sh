#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcc-phase3-manual.XXXXXX")"
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

printf '\n[1/5] Initializing isolated Supabase project through migration 0023\n'
(cd "$TMP" && supabase init)
mkdir -p "$TMP/supabase/migrations"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"
  prefix="${name%%_*}"
  if (( 10#$prefix <= 23 )); then
    cp "$migration" "$TMP/supabase/migrations/"
  fi
done

printf '\n[2/5] Starting isolated local stack\n'
(cd "$TMP" && supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor)
STACK_STARTED=1

printf '\n[3/5] Rebuilding base schema and applying safety/manual-write layer\n'
(cd "$TMP" && supabase db reset --local --no-seed)

DB_CONTAINER="$(
  docker ps --format '{{.ID}} {{.Ports}} {{.Names}}' |
  awk '/127\.0\.0\.1:54322->5432\/tcp|0\.0\.0\.0:54322->5432\/tcp|:::54322->5432\/tcp/ {print $1; exit}'
)"
[[ -n "$DB_CONTAINER" ]] || DB_CONTAINER="$(docker ps --format '{{.ID}} {{.Names}}' | awk '$2 ~ /^supabase_db_/ {print $1; exit}')"
[[ -n "$DB_CONTAINER" ]] || fail "Could not identify local Supabase Postgres container."
PSQL=(docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres)

"${PSQL[@]}" < "$ROOT/supabase/migrations/0024_mcc_safety_layer.sql"
"${PSQL[@]}" < "$ROOT/scripts/mcc_phase3_manual_writes.sql"

printf '\n[4/5] Database lint\n'
(cd "$TMP" && supabase db lint --local --fail-on error)

printf '\n[5/5] Manual-write integration suite\n'
"${PSQL[@]}" < "$ROOT/tests/mcc_phase3_manual_writes_integration.sql"

printf '\nPASS: MCC Phase 3A manual-write integration validation completed.\n'
printf 'Production was not contacted or modified by this runner.\n'
