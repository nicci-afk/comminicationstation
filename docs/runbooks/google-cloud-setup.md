# Google Cloud setup — one-time, ~20 minutes, browser only

This connects Gmail to the Command Center. Everything happens at
https://console.cloud.google.com from any browser, anywhere in the world.
You do this ONCE for the household — you and your husband share the same
OAuth client, and each of you connects your own inboxes afterward.

Until you finish Part C (Pub/Sub), mail still flows in via the built-in
15-minute polling safety net. Part C upgrades delivery to near-instant push.

---

## Part A — Create the project and enable the Gmail API (5 min)

1. Go to https://console.cloud.google.com and sign in with **nicci@travelghr.com**.
2. Top bar → project picker → **New Project**. Name: `command-center`. Create, then
   make sure it's selected in the picker.
3. Left menu → **APIs & Services → Library**. Search **Gmail API** → open it → **Enable**.

## Part B — OAuth consent + client (10 min)

4. **APIs & Services → OAuth consent screen** (Google may call this "Branding /
   Audience" in the new console):
   - User type: **External** → Create.
   - App name: `Command Center` · support email: your email · developer email: your email.
   - Scopes: you can skip adding scopes here (the app requests them at connect time).
   - **Audience → Publishing status: click "Publish app"** so it says **In production**.
     ⚠️ This step matters: in "Testing" mode Google kills the connection every 7 days.
   - You do NOT need to submit for verification. Because the app is unverified,
     Google shows a one-time warning screen when you connect ("Google hasn't
     verified this app") — click **Advanced → Go to Command Center (unsafe)**.
     That's expected for a private personal app and appears only at connect time.
5. **APIs & Services → Credentials → + Create credentials → OAuth client ID**:
   - Application type: **Web application**. Name: `command-center-web`.
   - Authorized redirect URIs → **Add URI**, paste EXACTLY:
     `https://bgpjpomqrnwsdmrofudb.supabase.co/functions/v1/api/gmail-oauth-callback`
   - Create. Copy the **Client ID** and **Client secret**.
6. Open the Command Center app → **Settings → Connections** → paste the Client ID
   and Client secret → Save each.
7. Still in Settings → **Connect a Gmail account** → pick your inbox → click through
   the unverified-app warning → allow read-only Gmail access. Repeat for every inbox
   you want in the queue. Your husband signs into the app with HIS account and
   connects his own inboxes the same way.

At this point mail flows (polling every 15 min) and the initial import runs:
the last 30 days go through normal triage, and your older unread pile lands in
the **Backlog** tab, not your daily queue.

## Part C — Pub/Sub push for instant delivery (5 min)

8. Console → search "Pub/Sub" → **Pub/Sub → Topics → Create topic**.
   Topic ID: `gmail-push`. Create.
9. On the topic page → **Permissions** (or "View permissions") → **Add principal**:
   - New principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher** → Save.
   (This lets Gmail publish "new mail" pings to your topic.)
10. **Pub/Sub → Subscriptions → Create subscription**:
    - Subscription ID: `gmail-push-sub` · select topic `gmail-push`.
    - Delivery type: **Push**.
    - Endpoint URL:
      `https://bgpjpomqrnwsdmrofudb.supabase.co/functions/v1/api/gmail-push`
    - ✅ **Enable authentication**: pick a service account (the default compute
      service account is fine — if the dropdown is empty, create one under
      IAM → Service Accounts named `pubsub-push` first).
      Audience: leave default (the endpoint URL).
    - **Expiration period: Never** ⚠️ (default is 31 days — set to Never or a
      quiet week could silently unsubscribe you).
    - Create.
11. Back in the app → **Settings → Connections** → "Pub/Sub topic" → paste the full
    topic name: `projects/command-center/topics/gmail-push`
    (replace `command-center` with your actual project ID if it differs — it's shown
    in the console project picker) → Save.

Within a day the watch renews automatically and Settings shows **push ✓** next to
each account. New mail then appears in the queue within seconds.

## What can go wrong

| Symptom | Fix |
|---|---|
| "Google did not return a refresh token" when connecting | Go to https://myaccount.google.com/permissions, remove "Command Center", reconnect. |
| Connection stops working after 7 days | The consent screen is still in "Testing" — publish it to production (step 4). |
| Settings shows "polling" not "push ✓" | Check step 9 (publisher permission) and step 11 (exact topic name). Polling still works meanwhile. |
| Warning screen looks scary | Expected for an unverified private app. Advanced → continue. Google may email you a "security alert" — that's the same event. |
