// Inbound SMS + WhatsApp webhook (one endpoint for both; Twilio prefixes
// WhatsApp addresses with "whatsapp:"). verify_jwt=false; auth is the
// X-Twilio-Signature HMAC validated against the owning user's auth token,
// which we can only find via the To-number mapping — unknown numbers are
// rejected before any signature work. Thin handler: validate, store, ingest.

import { getConfig, getUserSecret, serviceClient } from "./_shared/util.ts";

async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    headers: { "Content-Type": "text/xml" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const db = serviceClient();
  try {
    const form = await req.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = String(v);

    const rawTo = params["To"] ?? "";
    const rawFrom = params["From"] ?? "";
    const channel = rawFrom.startsWith("whatsapp:") ? "whatsapp" : "sms";
    const to = rawTo.replace(/^whatsapp:/, "");
    const from = rawFrom.replace(/^whatsapp:/, "");
    const sid = params["MessageSid"] ?? "";
    if (!to || !from || !sid) return twiml();

    const { data: num } = await db
      .from("twilio_numbers")
      .select("id,user_id,status")
      .eq("phone_e164", to)
      .maybeSingle();
    if (!num || num.status !== "active") return twiml(); // unknown To → no-op

    const authToken = await getUserSecret(db, num.user_id, "twilio_auth_token");
    if (!authToken) return twiml();

    const base = (await getConfig(db, "worker_base_url"))?.url as string | undefined;
    const publicUrl = `${base ?? new URL(req.url).origin + "/functions/v1"}/twilio-inbound`;
    const expected = await twilioSignature(authToken, publicUrl, params);
    const presented = req.headers.get("X-Twilio-Signature") ?? "";
    if (presented !== expected) {
      console.error("twilio signature mismatch");
      return new Response("forbidden", { status: 403 });
    }

    const { error: dupErr } = await db.from("webhook_events").insert({
      provider: "twilio",
      dedupe_key: `twilio:${sid}`,
      payload: { To: rawTo, From: rawFrom, Body: params["Body"] ?? "", channel },
      status: "received",
    });
    if (dupErr) return twiml(); // duplicate delivery

    const { error } = await db.rpc("ingest_twilio_message", {
      p_twilio_number_id: num.id,
      p: {
        provider_message_id: sid,
        direction: "inbound",
        channel,
        counterparty_e164: from,
        counterparty_name: params["ProfileName"] ?? "",
        body: params["Body"] ?? "",
        sent_at: new Date().toISOString(),
      },
    });
    if (error) {
      await db.from("webhook_events").update({ status: "error", error: error.message })
        .eq("dedupe_key", `twilio:${sid}`);
    } else {
      await db.from("webhook_events").update({ status: "processed" })
        .eq("dedupe_key", `twilio:${sid}`);
    }
    return twiml();
  } catch (e) {
    console.error("twilio-inbound error:", e);
    return twiml();
  }
}
