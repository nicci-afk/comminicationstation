// Send an SMS/WhatsApp reply from inside the app (the number lives in the
// cloud, so this IS the reply surface for these channels). Marks the queue
// item responded synchronously via the ingest RPC. WhatsApp 24h-window aware.
import { getUserSecret, handleOptions, HttpError, json, requireUser, serviceClient, } from "./_shared/util.ts";
import { beginReplyDispatch, finishReplyDispatch } from "./_shared/reply-review.ts";
export default async function handler(req: Request): Promise<Response> {
    const opt = handleOptions(req);
    if (opt)
        return opt;
    if (req.method !== "POST")
        return json({ error: "POST required" }, 405);
    const db = serviceClient();
    let userId = "", dispatchId = "", providerStarted = false, sentId = "";
    try {
        ({ userId } = await requireUser(req, db));
        const body = await req.json();
        if (body?.channel !== "sms" && body?.channel !== "whatsapp")
            throw new HttpError(400, "SMS or WhatsApp channel required");
        const dispatch = await beginReplyDispatch(db, userId, body, body.channel);
        dispatchId = String(dispatch.dispatch_id);
        if (dispatch.existing)
            return json({ ok: false, dispatch_id: dispatchId, status: dispatch.status, existing: true });
        const payload = dispatch.payload!;
        const transport = payload.transport!;
        const { data: num, error } = await db.from("twilio_numbers").select("id,user_id,phone_e164,status").eq("id", payload.fromAccountId).eq("user_id", userId).maybeSingle();
        if (error || !num || num.status !== "active" || num.phone_e164 !== transport.from)
            throw new HttpError(409, "approved sending number changed");
        if (payload.channel === "whatsapp" && (!transport.lastInboundAt || Date.parse(transport.lastInboundAt) <= Date.now() - 24 * 3600 * 1000))
            throw new HttpError(409, "WhatsApp 24-hour window is closed");
        const sid = await getUserSecret(db, userId, "twilio_account_sid"), token = await getUserSecret(db, userId, "twilio_auth_token");
        if (!sid || !token)
            throw new HttpError(400, "Twilio credentials are unavailable");
        const prefix = payload.channel === "whatsapp" ? "whatsapp:" : "";
        providerStarted = true;
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: prefix + transport.from, To: prefix + transport.to, Body: payload.text }) });
        if (!res.ok)
            throw new Error("provider send request failed");
        const sent = await res.json();
        if (typeof sent.sid !== "string" || !sent.sid)
            throw new Error("provider response did not identify the sent message");
        sentId = sent.sid;
        await finishReplyDispatch(db, userId, dispatchId, "SENT", sentId, true);
        let ingested = false;
        try {
            const { error: ingestError } = await db.rpc("ingest_twilio_message", { p_twilio_number_id: num.id, p: { provider_message_id: sentId, direction: "outbound", channel: payload.channel, counterparty_e164: transport.to, body: payload.text, sent_at: new Date().toISOString() } });
            ingested = !ingestError;
        }
        catch { }
        const recorded = await finishReplyDispatch(db, userId, dispatchId, "SENT", sentId, !ingested);
        return json({ ok: true, status: "SENT", dispatch_id: dispatchId, sid: sentId, audit_pending: !recorded, ingestion_pending: !ingested });
    }
    catch (e) {
        if (dispatchId && !sentId)
            await finishReplyDispatch(db, userId, dispatchId, providerStarted ? "UNKNOWN" : "FAILED");
        return json({ error: providerStarted ? "Delivery outcome is unknown. Do not resend; check the dispatch status." : (e as Error).message, ...(dispatchId ? { dispatch_id: dispatchId, status: sentId ? "SENT" : providerStarted ? "UNKNOWN" : "FAILED" } : {}) }, dispatchId ? 200 : e instanceof HttpError ? e.status : 502);
    }
}
