# MCC v2 Phase 1 local validation

Run from the repository root on a Mac with Docker Desktop (or another Docker-compatible runtime), Supabase CLI, and Node installed:

```bash
bash scripts/validate_mcc_v2_phase1_local.sh
```

The runner is intentionally local-only. It:

1. runs the deterministic Node tests,
2. creates a temporary Supabase project,
3. copies this checkout's migration files into the temporary project,
4. starts a local Supabase stack,
5. runs a clean `supabase db reset --local --no-seed`,
6. runs `supabase db lint --local --fail-on error`,
7. runs `tests/mcc_v2_phase1_integration.sql` inside the local Postgres container,
8. stops and deletes the temporary local stack.

It does not call `supabase link`, `db push`, `--linked`, Vercel, or the production Supabase project.

Expected success footer:

```text
PASS: MCC v2 Phase 1 local validation completed successfully.
Validated migrations: 0001 through 0023
Production was not contacted or modified by this runner.
```

If the command fails, preserve the terminal output and do not deploy or apply migrations remotely.
