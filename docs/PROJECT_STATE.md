# Project state — resume-from-here notes

_Last updated: 2026-07-21 (initial build session)._

## What exists and where

| Piece | Status | Location |
|---|---|---|
| Repo / branch | active | `nicci-afk/comminicationstation`, branch `claude/message-command-center-0x3qgm` |
| Supabase project | LIVE, migrations applied | `bgpjpomqrnwsdmrofudb` (us-east-2), org "AgentEdge" (billing container only — zero connection to the AgentEdge app) |
| Database | 27 tables, RLS on all, 5 deny-all service tables, pgmq queues (sync/triage/pipeline/digest), 6 pg_cron jobs | `supabase/migrations/0001–0005` |
| Backend | two routed edge functions: `api` (user+webhook routes) and `workers` (queue drainers), verify_jwt=false with per-route auth in code | `supabase/functions/api/` → `https://bgpjpomqrnwsdmrofudb.supabase.co/functions/v1/api/<route>` |
| Frontend | LIVE on Vercel (project `message-command-center`) | https://message-command-center-iota.vercel.app |
| Pipeline contracts | zod schemas + code QC gates for the three skills | `supabase/functions/api/_shared/schemas/` (specs: `docs/skills/`) |

## Machine config already seeded (app_config table)

`worker_base_url`, `anon_key`, `worker_secret_vault_id`, `bootstrap_secret_vault_id`,
`pubsub_audience`, `app_url`. Secrets live in Vault; read one via SQL:
`select public.vault_read_secret((public.get_app_config('bootstrap_secret_vault_id')->>'id')::uuid);`

## Key design decisions (do not re-litigate)

- Mixed Workspace/@gmail.com → one household external OAuth app, production
  mode, unverified (click-through warning). Runbook: `docs/runbooks/google-cloud-setup.md`.
- Pipeline is **manual-trigger only** (user decision). Drift → flags re-analysis, never auto-runs.
- SMS/WhatsApp fully built but numbers NOT provisioned (user will prep clients first).
- Stage models: sonar-pro / gpt-5.1 / claude-opus-4-8 (config key `pipeline_models`); triage+drafts claude-haiku-4-5.
- Tier 0 rules → Tier 1 capped Haiku → Tier 2 manual pipeline; spend ledger + caps enforced at enqueue and per stage.

## Remaining work checklist

- [ ] Edge function `api` deployed (was in flight when this file was written — check `list_edge_functions`; redeploy from `supabase/functions/api/` if absent)
- [ ] Bootstrap users via `/api/bootstrap` (x-bootstrap-secret header): allow_email + create_user for nicci@travelghr.com, husband, and a temporary test user for isolation checks
- [ ] Verification scenarios (real data already identified from her Gmail):
  - Rosen Hotels thread `19f71a46f33a491c`: inbound TTurner@rosenhotels.com 2026-07-17 → her reply `19f85264566d6bdd` 07-21 14:48Z (→ responded w/ evidence) → new inbound `19f857a8e33f8a8a` 16:20Z (→ reopens)
  - Holland America thread `19f71a5f98a50d1d`: inbound no_reply@hollandamerica.com (bulk) → her SENT **forward** `19f735292a6e649d` to melanie@nessertravel.com must NOT mark responded
  - Promo `19f85d92d46926fc` (specialist@tahititourisme.com) → bulk-suppressed to fyi, zero AI
  - Pipeline: schema+QC live-run pending her API keys (Settings → API keys), then "Analyze contact"; reuse test = second message, pipeline_runs count unchanged
  - Isolation: cross-user reads via both users' JWTs must return empty
  - Cost ceiling: synthetic burst → ledger shows zero tier-2 spend
- [ ] Post-verify: remove test user (bootstrap delete_user), push final commits

## Her setup steps (user-facing, after handoff)

1. Log in at the Vercel URL (credentials delivered at handoff), change password via Supabase recovery if desired
2. Google Cloud runbook (~20 min) → paste client ID/secret in Settings → connect inboxes
3. Paste Perplexity/OpenAI/Anthropic keys in Settings → API keys
4. Later: Twilio go-live runbook when clients are prepped
