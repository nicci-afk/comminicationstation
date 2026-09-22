# Something broke while I'm traveling — fix-from-anywhere guide

Nothing in this system depends on a machine in your house. Every fix below is
a browser tab.

## First: the built-in health panel
App → **Settings → System health**. Healthy = all queues near 0, oldest age
small, dead-letters 0, cron rows recent. This works from any phone/laptop.

## The dashboards (bookmark these)
| What | Where |
|---|---|
| App | your Vercel URL (see README) |
| Database, logs, queues | https://supabase.com/dashboard/project/bgpjpomqrnwsdmrofudb |
| Backend function logs | Supabase dashboard → Edge Functions → `api` → Logs |
| Frontend hosting | https://vercel.com (project `message-command-center`) |
| Gmail push plumbing | https://console.cloud.google.com → Pub/Sub |
| Texting | https://console.twilio.com → Monitor → Logs → Messaging |

## Symptom → fix

**New email isn't showing up**
1. Settings → Connections: is the account row green/active? If it shows an
   error like `invalid_grant`, Google revoked the token — click "Connect a
   Gmail account" and reconnect that inbox. Two minutes, done.
2. If it says "polling" instead of "push ✓", mail still arrives within 15 min;
   fix Pub/Sub later (runbook google-cloud-setup.md Part C).
3. Supabase → Edge Functions → api → Logs: look for red lines mentioning
   `gmail`. The message usually says exactly what's wrong.

**Queue items pile up / System health shows a big queue**
- Supabase dashboard → SQL editor → run `select public.poke_nonempty_queues();`
  — kicks the workers immediately. They also self-heal every minute via cron.

**"Analyze contact" fails**
- The error shown in the app is specific: missing API key → Settings → API
  keys; spend cap → Settings → Spend (raise the cap in the `spend_caps` table
  via Supabase → Table editor if you truly want to); `qc_failed` → the vendor
  output didn't pass the quality gates — just run it again, or add more
  identifiers (company, LinkedIn URL) so identity resolution is stronger.

**Texts stopped**
- Twilio Console → Monitor → Logs → Messaging: undelivered inbound means a
  webhook problem (check the number's SMS webhook URL ends in
  `/functions/v1/api/twilio-inbound`); undelivered outbound usually means A2P
  registration lapsed or balance is empty.

**The app itself won't load**
- Vercel → project → latest deployment status; "Visit" the previous deployment
  if a bad deploy ever happens (there's an instant rollback button).
- The data layer is separate: even if the app UI is down, nothing is lost —
  ingestion keeps running on Supabase.

**I'm locked out / forgot password**
- Supabase dashboard → Authentication → Users → your user → "Send password
  recovery" (or set a new password right there).

## Billing surfaces (so nothing surprises you)
Supabase $10/mo (project) · Vercel free tier · Google Cloud $0 (Pub/Sub free
tier at this volume) · Twilio per-use when live · AI usage on your own keys,
capped by the app's spend limits.
