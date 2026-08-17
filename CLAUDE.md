# Message Command Center — Claude Code Rules

## Token & Time Budget Rules (mandatory)

### Hard stop at 3 failed attempts
If the same operation fails 3 times in a row (deploy, migration, API call, test),
**stop and report** before attempt 4. Write out:
- What has been tried
- What error was returned each time
- What is unknown / what information is missing
- An explicit question to the user before proceeding

Do NOT loop silently. Looping without user acknowledgement after 3 failures is
the primary source of wasted tokens and time.

### Diagnose before acting
Before making any fix, state in one sentence what the root cause is and how the fix
addresses it. If you cannot state the root cause confidently, run one targeted
diagnostic first — not a fix.

### Supabase Edge Function deploys — bundle completeness check (mandatory)
The `deploy_edge_function` MCP tool does NOT read from the filesystem. Every file
imported by the function must be explicitly included in the `files` array or the
deploy silently omits it and the function crashes at import time with a misleading error.

**Before every deploy:**
1. Read `index.ts` (the entrypoint).
2. Trace every import — including imports inside imported files — to build the
   complete file list.
3. Confirm every file in that list is present in the `files` array.
4. Only then call `deploy_edge_function`.

This check is not optional. The 3-hour session on 2026-08-17 was caused entirely
by skipping it — the bundle was missing 8 of 17 files across multiple deploy attempts.

### Schema changes — check columns before writing SQL
Before any UPDATE/INSERT that references a column name, verify the column exists:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = '<table>' ORDER BY ordinal_position;
```
Do not assume column names from memory or schema files.

---

## Pipeline status — quick reference for any new thread

Run this in Supabase SQL editor (project `bgpjpomqrnwsdmrofudb`) to check the
25 MasterClass October contacts pipeline:

```sql
-- Status summary
SELECT status, count(*) FROM pipeline_runs GROUP BY status ORDER BY status;

-- Recent errors (last 24h)
SELECT id, status, error, created_at
FROM pipeline_runs
WHERE error IS NOT NULL
ORDER BY created_at DESC
LIMIT 20;

-- Jobs waiting in queue
SELECT count(*) AS pending FROM pgmq.q_pipeline_jobs;
```

Target state: all 25 MasterClass October contacts show `complete`.
If any show `error` or `qc_failed`, read the `error` column for the root cause
before attempting any fix.

---

## AI spend discipline

- Never trigger pipeline runs (stages 1–3) programmatically without explicit user instruction.
- Tier-2 pipeline (Perplexity → OpenAI → Claude) is **manual-trigger only**.
- Before re-running failed pipeline jobs in bulk, confirm count and estimated cost with the user.
- Do not re-deploy Edge Functions unless there is a confirmed code change to ship.

---

## Project identifiers (for new threads)

| Item | Value |
|---|---|
| Supabase project | `bgpjpomqrnwsdmrofudb` |
| Edge Function | `workers` (id `f74d9ee7-4a1c-4d54-b1ff-450e9ca19034`) |
| Active branch | `claude/message-command-center-0x3qgm` |
| Workers version (as of 2026-08-17) | v13 |
| Queue | `pipeline_jobs` |

Security constraints that must never be relaxed without explicit user permission:
- `gmail.readonly` scope only — never add write Gmail scopes
- Tim (tim@GHRcontracting.com) must NOT be allowlisted until Nicci says so
- Bootstrap secret was rotated on 2026-08-17; old value must never be used
- Service-role code never takes tenant ID from a payload
