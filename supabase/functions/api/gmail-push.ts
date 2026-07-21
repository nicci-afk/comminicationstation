// Pub/Sub push endpoint for Gmail watch notifications.
// Auth: verify_jwt=false at the platform; replaced by Pub/Sub OIDC token
// verification. The handler is deliberately thin: verify, record, enqueue, 204.
// It NEVER processes history here, and an emailAddress we don't know is a
// no-op — anyone can point their own gmail watch at a topic name they guess.

import { enqueue, getConfig, serviceClient } from "./_shared/util.ts";

async function verifyOidc(req: Request, expectedAudience: string | null): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) return false;
  const info = await res.json();
  if (info.iss !== "https://accounts.google.com" && info.iss !== "accounts.google.com") {
    return false;
  }
  if (info.email_verified !== "true" && info.email_verified !== true) return false;
  if (!String(info.email ?? "").endsWith(".gserviceaccount.com")) return false;
  if (expectedAudience && info.aud !== expectedAudience) return false;
  return true;
}

export default async function handler(req: Request): Promise<Response> {
  const db = serviceClient();
  try {
    const audCfg = await getConfig(db, "pubsub_audience");
    const expectedAud = (audCfg?.value as string) ?? null;
    if (!(await verifyOidc(req, expectedAud))) {
      return new Response("forbidden", { status: 403 });
    }

    const body = await req.json();
    const messageId = body?.message?.messageId ?? crypto.randomUUID();
    const dataB64 = body?.message?.data ?? "";
    const decoded = JSON.parse(atob(dataB64));
    const emailAddress = String(decoded.emailAddress ?? "").toLowerCase();

    const { error: dupErr } = await db.from("webhook_events").insert({
      provider: "pubsub",
      dedupe_key: `pubsub:${messageId}`,
      payload: { emailAddress, historyId: decoded.historyId },
      status: "received",
    });
    if (dupErr) {
      // duplicate delivery (unique violation) — already handled
      return new Response(null, { status: 204 });
    }

    const { data: account } = await db
      .from("gmail_accounts")
      .select("id,status")
      .eq("email_address", emailAddress)
      .maybeSingle();

    if (account && account.status === "active") {
      await enqueue(db, "sync_jobs", {
        kind: "incremental",
        gmail_account_id: account.id,
        source: "push",
      });
      await db
        .from("webhook_events")
        .update({ status: "processed" })
        .eq("dedupe_key", `pubsub:${messageId}`);
    } else {
      await db
        .from("webhook_events")
        .update({ status: "ignored", error: "unknown or inactive emailAddress" })
        .eq("dedupe_key", `pubsub:${messageId}`);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    console.error("gmail-push error:", e);
    // 204 anyway: Pub/Sub retries aggressively and the poll sweep is the net.
    return new Response(null, { status: 204 });
  }
}
