// Send an SMS/WhatsApp reply from inside the app (the number lives in the
// cloud, so this IS the reply surface for these channels). Marks the queue
// item responded synchronously via the ingest RPC. WhatsApp 24h-window aware.

import {
  getUserSecret,
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const body = await req.json();
    const threadId = body.thread_id as string;
    const text = String(body.body ?? "").trim();
    if (!text) throw new HttpError(400, "empty message");

    const { data: thread } = await db
      .from("threads")
      .select("id,user_id,channel,twilio_number_id,provider_thread_id")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread || thread.user_id !== userId) throw new HttpError(404, "thread not found");
    if (!thread.twilio_number_id) throw new HttpError(400, "not an SMS/WhatsApp thread");

    const { data: num } = await db
      .from("twilio_numbers")
      .select("id,phone_e164,status")
      .eq("id", thread.twilio_number_id)
      .single();
    if (num!.status !== "active") throw new HttpError(400, "number is not active");

    const counterparty = (thread.provider_thread_id as string).split(":").slice(1).join(":");

    if (thread.channel === "whatsapp") {
      // Free-form sends only inside the 24h customer-service window.
      const { data: lastInbound } = await db
        .from("messages")
        .select("sent_at")
        .eq("thread_id", threadId)
        .eq("direction", "inbound")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const cutoff = Date.now() - 24 * 3600 * 1000;
      if (!lastInbound || new Date(lastInbound.sent_at).getTime() < cutoff) {
        throw new HttpError(400,
          "WhatsApp 24-hour window is closed — free-form replies are only allowed within 24h of their last message; use an approved template (coming with WhatsApp go-live)");
      }
    }

    const sid = await getUserSecret(db, userId, "twilio_account_sid");
    const token = await getUserSecret(db, userId, "twilio_auth_token");
    if (!sid || !token) throw new HttpError(400, "add your Twilio credentials in Settings first");

    const prefix = thread.channel === "whatsapp" ? "whatsapp:" : "";
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: prefix + num!.phone_e164,
          To: prefix + counterparty,
          Body: text,
        }),
      },
    );
    if (!res.ok) {
      throw new HttpError(502, `Twilio send failed: ${(await res.text()).slice(0, 300)}`);
    }
    const sent = await res.json();

    const { error } = await db.rpc("ingest_twilio_message", {
      p_twilio_number_id: num!.id,
      p: {
        provider_message_id: sent.sid,
        direction: "outbound",
        channel: thread.channel,
        counterparty_e164: counterparty,
        body: text,
        sent_at: new Date().toISOString(),
      },
    });
    if (error) throw new Error(error.message);

    return json({ ok: true, sid: sent.sid });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
