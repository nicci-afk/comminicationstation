# Project state — resume-from-here notes

_Last updated: 2026-07-21 (end of initial build session — backend deployed and verified)._

## What exists and where

| Piece | Status | Location |
|---|---|---|
| Repo / branch | active | `nicci-afk/comminicationstation`, branch `claude/message-command-center-0x3qgm` |
| Supabase project | LIVE, migrations 0001–0006 applied | `bgpjpomqrnwsdmrofudb` (us-east-2), org "AgentEdge" (billing container only — zero connection to the AgentEdge app) |
| Database | 27 tables, RLS on all, 5 deny-all service tables, pgmq queues (sync/triage/pipeline/digest), 6 pg_cron jobs | `supabase/migrations/` |
| Backend | two routed edge functions: `api` (user+webhook routes) and `workers` (queue drainers), verify_jwt=false with per-route auth in code | `…/functions/v1/api/<route>` and `…/functions/v1/workers/<worker>` |
| Frontend | LIVE on Vercel (project `message-command-center`), incl. magic-link login | https://message-command-center-iota.vercel.app |
| Pipeline contracts | zod schemas + code QC gates; fixture tests 25/25 | `supabase/functions/api/_shared/schemas/`, `tests/qc-gates.test.ts` (specs: `docs/skills/`) |

## Machine config already seeded (app_config table)

`worker_base_url`, `workers_base_url`, `anon_key`, `worker_secret_vault_id`,
`bootstrap_secret_vault_id`, `pubsub_audience`, `app_url`. Secrets live in
Vault; read one via SQL:
`select public.vault_read_secret((public.get_app_config('bootstrap_secret_vault_id')->>'id')::uuid);`
The bootstrap secret was ROTATED at the end of the build session (the original
transited chat logs); the current value exists only in Vault.

## Key design decisions (do not re-litigate)

- Mixed Workspace/@gmail.com → one household external OAuth app, production
  mode, unverified (click-through warning). Runbook: `docs/runbooks/google-cloud-setup.md`.
- Pipeline is **manual-trigger only** (user decision). Drift → flags re-analysis, never auto-runs.
- SMS/WhatsApp fully built but numbers NOT provisioned (user will prep clients first).
- Stage models: sonar-pro / gpt-5.1 / claude-opus-4-8 (config key `pipeline_models`); triage+drafts claude-haiku-4-5.
- Tier 0 rules → Tier 1 capped Haiku → Tier 2 manual pipeline; spend ledger + caps enforced at enqueue and per stage.
- Husband (tim@GHRcontracting.com) deliberately NOT created — not even
  allowlisted — until Nicci says so. Only nicci@travelghr.com exists.

## Verification — all run against the LIVE deployed system

- RLS: 0 public tables without RLS; the 5 policy-less tables are intentional deny-all service tables. Allowlist trigger rejects non-allowlisted signup.
- Real Rosen Hotels Gmail thread: inbound → needs_attention via domain rule (zero AI); her real reply → responded/awaiting_reply with evidence (`resolved_by_message_id`, rfc822 id, timestamp in `queue_item_events`); next inbound reopened the item.
- Real Holland America forward to a colleague did NOT mark the item responded (recipient-overlap check; `forward_observed_not_reply` recorded).
- Real Tahiti Tourisme promo → bulk-suppressed to fyi, zero AI.
- Unruled sender → `needs_model_triage` → enqueue_and_poke → pg_net → live worker claimed/acked within seconds (poke chain proven end-to-end).
- Timers: overdue escalation (+15/escalated/reason), snooze return, follow-up nudge (awaiting_reply → needs_attention), backlog routing.
- Isolation: two real JWT logins each saw only their own data; direct REST cross-tenant reads/writes returned empty; anon returned empty.
- Cost ceiling: 200-message synthetic bulk burst → 200 fyi, 0 ai_spend_ledger rows, 0 triage jobs.
- QC gates: `tests/qc-gates.test.ts` — 25/25 against the exact deployed schema+QC code (red-zone blueprint block, evidence_refs requirement, drift mirroring, pressure/bounded language, interaction_update_v1, confidence_rules_v1 embedded verbatim).
- Pipeline live run: PENDING her API keys (Perplexity/OpenAI/Anthropic in Settings → API keys), then "Analyze contact" on a real sender + reuse check.
- All verification test data was deleted afterwards (test user removed entirely; her scenario threads/messages/items removed; queues purged). Kept: her account, 4 businesses + default bucket, the rosenhotels.com rule.

## Known minor issues

- `workers` routes return HTTP 500 instead of 403 on unauthenticated manual calls (HttpError caught by the router's generic handler). Auth is still enforced; cosmetic only.
- Magic-link login requires two one-time Supabase dashboard steps before it works: Auth → URL Configuration → Site URL = the Vercel URL, and custom SMTP (her Resend account) for deliverability.

## Her setup steps (user-facing, after handoff)

1. Log in at https://message-command-center-iota.vercel.app (credentials delivered at handoff; change password after first login)
2. Google Cloud runbook (~20 min, `docs/runbooks/google-cloud-setup.md`) → paste client ID/secret in Settings → connect inboxes (~20 accounts supported, one at a time)
3. Paste Perplexity/OpenAI/Anthropic keys in Settings → API keys → live pipeline verification can then run
4. Later: Twilio go-live runbook when clients are prepped; husband's account only when she asks
