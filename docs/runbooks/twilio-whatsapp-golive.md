# Texting & WhatsApp go-live — when your clients are ready

Everything is already built and deployed: inbound webhooks, the conversation
view, in-app sending, WhatsApp's 24-hour-window handling, and the number-buying
flow in Settings. What's deferred is only the part you asked to defer: creating
the actual numbers. Start this ~2–3 weeks before you want texting live, because
carrier registration takes days-to-weeks.

## The model (agreed up front)
- Each of you gets your own dedicated business number, hosted at Twilio, used
  for BOTH SMS and WhatsApp.
- Clients text/WhatsApp that number. Texts to your personal iPhone numbers
  cannot appear here — that's the local-relay dependency this rebuild removed.
- You reply from inside the app (the number lives in the cloud, so the app is
  its inbox and outbox). Replies mark the item responded instantly.

## Steps

1. **Twilio account** (each of you, or one account with subaccounts — simplest:
   one account each): https://www.twilio.com → sign up → upgrade from trial
   (trial numbers can only text verified numbers).
2. App → **Settings → API keys** → paste your **Twilio Account SID** and
   **Auth Token** (Console → Account Info).
3. App → **Settings → Connections → Text & WhatsApp** → enter your preferred
   area code → **Search numbers** → **Buy**. The app configures the inbound
   webhook automatically. (~$1.15/mo per number.)
4. **A2P 10DLC registration** (required by US carriers for ALL application
   texting, even conversational): Twilio Console → **Messaging → Regulatory
   Compliance → A2P 10DLC**. Register as **Sole Proprietor** (no EIN needed;
   $4 one-time brand fee + $1.50/mo campaign fee + a short review wait) or as
   your LLC with EIN if you have one (higher throughput). Attach your purchased
   number to the campaign. Until approval, outbound texts may be filtered.
5. **Send yourself a test text** to the new number — it should appear in the
   queue as needs-attention within seconds. Reply from the app; confirm it
   arrives on your phone.

## WhatsApp (after SMS works)

6. Twilio Console → **Messaging → Senders → WhatsApp senders → New sender**.
   Sign in with Facebook and create/connect your **Meta Business portfolio**
   (Meta may ask for business verification — days to ~2 weeks).
7. Choose your Twilio number as the WhatsApp sender, set the display name
   (e.g. "Travel GHR"). Meta reviews the name.
8. Once approved, tell Claude (or edit the DB) to set `wa_enabled = true` on
   your number row — WhatsApp messages then flow through the same webhook and
   thread view automatically.
9. **The 24-hour window rule** (Meta's, not ours): you can send free-form
   WhatsApp replies only within 24h of the client's last message. Outside it,
   the composer will block and tell you why. If you end up needing outside-window
   outreach, create message templates in Twilio Console (Meta approves each) —
   template sending can be added to the composer at that point.

## Costs at your volume (approx)
- Number: ~$1.15/mo · A2P campaign: $1.50/mo
- SMS: ~$0.008/message · WhatsApp: ~$0.005 Twilio fee + Meta per-message rate
  (inbound-triggered service conversations are free from Meta)

## Client migration tip
Announce the new number ("save this number — it's the best way to reach me"),
set an auto-reply/voicemail hint on your personal line for business texts, and
give it a couple of weeks of overlap before relying on it fully.
