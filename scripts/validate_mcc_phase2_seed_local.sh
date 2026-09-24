#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mcc-phase2-seed.XXXXXX")"
STACK_STARTED=0
APPROVED_0025_BLOB="13fb34db9a3afa0fd62148584a806b7e91d6d0d1"

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
command -v git >/dev/null 2>&1 || fail "git is required."

ACTUAL_BLOB="$(git -C "$ROOT" hash-object supabase/migrations/0025_mcc_phase2_current_obligations_2.sql)"
[[ "$ACTUAL_BLOB" == "$APPROVED_0025_BLOB" ]] || fail "0025 migration no longer matches the approved blob."

printf '\n[1/7] Initializing isolated Supabase project through migration 0023\n'
(
  cd "$TMP"
  supabase init
)
mkdir -p "$TMP/supabase/migrations"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$migration")"
  prefix="${name%%_*}"
  if (( 10#$prefix <= 23 )); then
    cp "$migration" "$TMP/supabase/migrations/"
  fi
done

printf '\n[2/7] Starting isolated local stack\n'
(
  cd "$TMP"
  supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,supavisor
)
STACK_STARTED=1

printf '\n[3/7] Rebuilding base schema through 0023\n'
(
  cd "$TMP"
  supabase db reset --local --no-seed
)

DB_CONTAINER="$(
  docker ps --format '{{.ID}} {{.Ports}} {{.Names}}' |
  awk '/127\.0\.0\.1:54322->5432\/tcp|0\.0\.0\.0:54322->5432\/tcp|:::54322->5432\/tcp/ {print $1; exit}'
)"
[[ -n "$DB_CONTAINER" ]] || DB_CONTAINER="$(docker ps --format '{{.ID}} {{.Names}}' | awk '$2 ~ /^supabase_db_/ {print $1; exit}')"
[[ -n "$DB_CONTAINER" ]] || fail "Could not identify local Supabase Postgres container."

PSQL=(docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres)

printf '\n[4/7] Creating one-profile production-shaped fixture\n'
"${PSQL[@]}" <<'SQL'
insert into public.allowed_emails(email,note)
values ('mcc-phase2@example.invalid','local phase2 seed validation')
on conflict(email) do nothing;

insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at)
values (
  '10000000-0000-0000-0000-000000000001',
  'mcc-phase2@example.invalid',
  '{}','{}',now(),now()
);

insert into public.businesses(user_id,name,color,is_default)
values
 ('10000000-0000-0000-0000-000000000001','Travel GHR','#64748b',false),
 ('10000000-0000-0000-0000-000000000001','The Conscious Creator','#64748b',false);
SQL

printf '\n[5/7] Applying safety layer and approved initial five-obligation seed\n'
"${PSQL[@]}" < "$ROOT/supabase/migrations/0024_mcc_safety_layer.sql"
"${PSQL[@]}" < "$ROOT/scripts/mcc_phase2_proposed_initial_seed.sql"

"${PSQL[@]}" <<'SQL'
do $$
declare
  p integer;
  o integer;
  s integer;
  e integer;
begin
  select count(*) into p from public.projects;
  select count(*) into o from public.obligations;
  select count(*) into s from public.obligation_sources;
  select count(*) into e from public.obligation_events;

  if p <> 2 or o <> 5 or s <> 6 or e <> 5 then
    raise exception 'Unexpected initial seed baseline projects=% obligations=% sources=% events=%', p,o,s,e;
  end if;
end $$;
SQL

printf '\n[6/7] Applying unchanged approved 0025 migration in isolation\n'
"${PSQL[@]}" < "$ROOT/supabase/migrations/0025_mcc_phase2_current_obligations_2.sql"

printf '\n[7/7] Verifying exact expected impact and fail-closed safety\n'
"${PSQL[@]}" <<'SQL'
do $$
declare
  p integer;
  o integer;
  s integer;
  e integer;
  missing_refs integer;
  missing_original integer;
  no_provenance integer;
  duplicate_refs integer;
  tahiti integer;
  unsafe_controls integer;
begin
  select count(*) into p from public.projects;
  select count(*) into o from public.obligations;
  select count(*) into s from public.obligation_sources;
  select count(*) into e from public.obligation_events;

  if p <> 3 or o <> 9 or s <> 11 or e <> 9 then
    raise exception 'Unexpected final counts projects=% obligations=% sources=% events=%', p,o,s,e;
  end if;

  select count(*) into tahiti
  from public.projects
  where source_system='mcc_project_seed' and source_ref='phase2:tahiti-fam';
  if tahiti <> 1 then raise exception 'Tahiti project count is %', tahiti; end if;

  select count(*) into missing_refs
  from (values
    ('gmail','message:1a0c4ed6415b2928'),
    ('gmail','thread:1a0b58398c97189b'),
    ('gmail','message:1a0c5e56da415d9b'),
    ('gmail','message:1a0673ecfd73ba95')
  ) v(source_system,source_ref)
  where not exists (
    select 1 from public.obligation_sources s
    where s.source_system=v.source_system and s.source_ref=v.source_ref
  );
  if missing_refs <> 0 then raise exception 'Missing % approved stable source refs', missing_refs; end if;

  select count(*) into missing_original
  from (values
    ('gmail','thread:1a0bbb1fd30f4ef1'),
    ('gmail','thread:1a0727583159f2aa'),
    ('google_calendar','event:6ktqgfr11qti42fffda2euou6g'),
    ('gmail','message:1a068a0f7cbe18a5'),
    ('gmail','thread:1a032ef06e29cde9')
  ) v(source_system,source_ref)
  where not exists (
    select 1 from public.obligation_sources s
    where s.source_system=v.source_system and s.source_ref=v.source_ref
  );
  if missing_original <> 0 then raise exception 'Missing % original five obligation refs', missing_original; end if;

  select count(*) into no_provenance
  from public.obligations o
  left join public.obligation_sources s
    on s.obligation_id=o.id and s.user_id=o.user_id
  where s.id is null;
  if no_provenance <> 0 then raise exception '% obligations lack provenance', no_provenance; end if;

  select count(*) into duplicate_refs
  from (
    select user_id,source_system,source_ref
    from public.obligation_sources
    group by user_id,source_system,source_ref
    having count(*) > 1
  ) d;
  if duplicate_refs <> 0 then raise exception '% duplicate stable source refs', duplicate_refs; end if;

  select count(*) into unsafe_controls
  from public.mcc_safety_controls
  where emergency_stop is not true
     or automation_database_writes_enabled is not false
     or automation_external_sends_enabled is not false
     or automation_booking_changes_enabled is not false
     or automation_financial_actions_enabled is not false;
  if unsafe_controls <> 0 then raise exception 'Safety controls are not fail-closed'; end if;
end $$;
SQL

printf '\nPASS: Phase 2 seed integration validation completed.\n'
printf 'Approved 0025 blob preserved: %s\n' "$APPROVED_0025_BLOB"
printf 'Expected impact verified: 2/5/6/5 -> 3/9/11/9.\n'
printf 'Production was not contacted or modified by this runner.\n'
