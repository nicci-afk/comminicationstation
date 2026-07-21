# Message Command Center

One prioritized queue for every message that needs attention across email
(Gmail), SMS, and WhatsApp — organized by business, with a stored, evidence-
bounded communication strategy per contact. Two fully isolated users. 100%
cloud: nothing depends on any local machine.

**Fully independent system.** Own repo, own Supabase project (database, auth,
API), own Vercel project. No code, data, or infrastructure shared with any
other app.

## Live infrastructure

| Piece | Where |
|---|---|
| App (frontend) | Vercel project `message-command-center` |
| Database / auth / workers | Supabase project `bgpjpomqrnwsdmrofudb` (us-east-2) |
| Backend API | `https://bgpjpomqrnwsdmrofudb.supabase.co/functions/v1/api/<route>` |

## Architecture in one page

```
Gmail ──users.watch──▶ Pub/Sub ──push──▶ /api/gmail-push ─┐        (15-min polling
Twilio SMS/WhatsApp ──webhook──▶ /api/twilio-inbound ─────┤         cron = safety net)
                                                          ▼
                                              pgmq job queues (Postgres)
                                                          │  pg_net "poke" → seconds
                                                          ▼
                    Edge worker: sync → ingest RPC (SECURITY DEFINER, derives
                    tenant from the gmail_account/twilio_number mapping row)
                                                          │
              ┌───────────────────────────────────────────┤
              ▼                                           ▼
   Tier 0 (free, every message):               Tier 1 (only when rules
   dedupe · threading · already-responded      can't decide): ONE Claude
   detection via Message-ID/References +       Haiku call, capped per day,
   recipient-overlap · bulk suppression ·      cached per sender
   rules · priority scoring
                                                          │
                                                          ▼
                                       queue_items (RLS: user_id = auth.uid())
                                                          │ realtime
                                                          ▼
                                            React SPA (Vercel, zero secrets)

   Tier 2 — MANUAL ONLY ("Analyze contact"): Perplexity research →
   ChatGPT persona strategy → Claude communication strategy. One pgmq job per
   stage; zod schema validation + code-enforced QC gates per the three skill
   specs in docs/skills/; result stored in contact_strategies and REUSED for
   every future message. Evolution between runs happens only via
   interaction_update_v1 packets; drift signals set a "re-analysis
   recommended" flag — nothing re-runs by itself.
```

## Repository layout

```
docs/skills/              the three pipeline skill specs (source of truth)
docs/runbooks/            Google Cloud setup, Twilio/WhatsApp go-live, troubleshooting
supabase/migrations/      full schema: RLS on every table, RPCs, queues, cron
supabase/functions/api/   single routed edge function (all 16 backend routes)
  _shared/schemas/        the skill contracts as zod + code-enforced QC gates
apps/web/                 Vite + React SPA (Tailwind, TanStack Query, supabase-js)
```

## Security model

- Every user-data table has RLS `user_id = auth.uid()`; signups are allowlist-
  only (two household accounts). Cross-tenant access is impossible at the
  database layer, not just the app layer.
- Service-role code never takes a tenant id from a payload — ingestion RPCs
  derive the owner from the routing row (which Gmail account / Twilio number
  received the message).
- Webhooks authenticate independently: Pub/Sub OIDC token, Twilio HMAC
  signature, OAuth state nonce. Raw webhook payloads land in a deny-all table.
- All secrets (OAuth refresh tokens, per-user API keys) live in Supabase Vault;
  the browser can only ever see "set / not set". The Vercel deployment contains
  zero secrets.

## AI cost design

Spend is engineered, not hoped for: bulk mail is suppressed by headers before
any model call; repeat senders hit a decision cache; backfill/backlog is
rules-only; Tier-1 triage is one Haiku call with a daily cap; the expensive
pipeline runs only on manual click, at most once concurrently per contact, and
its full output is stored and reused. Every call is metered in
`ai_spend_ledger` against per-user monthly caps (Settings → Spend).

## Local development

```
cd apps/web && npm install && npm run dev
```
Migrations live in `supabase/migrations/` (applied via Supabase MCP/CLI).
The edge function deploys from `supabase/functions/api/`.
```
