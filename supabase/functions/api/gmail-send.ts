// Send a reply email via the Gmail API on behalf of the authenticated user.
// Uses the gmail_account linked to the thread, requires has_send_scope=true.
// The sent message is ingested via ingest_email_message so that outbound
// responded-detection runs exactly as it does for replies sent from Gmail
// directly — the same audit trail, the same evidence record.
//
// Auth: user JWT (verify_jwt=true on the parent router)
import { accessTokenForAccount, buildIngestPayload, gmailJson, gmailPost, metadataQuery, } from "./_shared/gmail.ts";
import { handleOptions, HttpError, json, requireUser, serviceClient, } from "./_shared/util.ts";
import { beginReplyDispatch, finishReplyDispatch } from "./_shared/reply-review.ts";
function buildMime(opts: {
    from: string;
    to: string;
    subject: string;
    inReplyTo: string | null;
    references: string[];
    body: string;
}): string {
    // The final subject was normalized before review and is immutable here.
    const subject = opts.subject;
    const lines = [
        `From: ${opts.from}`,
        `To: ${opts.to}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
    ];
    if (opts.inReplyTo) {
        lines.push(`In-Reply-To: ${opts.inReplyTo}`);
        // Build References = prior refs + inReplyTo (de-duped, inReplyTo last)
        const refs = [
            ...opts.references.filter((r) => r !== opts.inReplyTo),
            opts.inReplyTo,
        ].join(" ");
        lines.push(`References: ${refs}`);
    }
    lines.push("", opts.body);
    return lines.join("\r\n");
}
function toBase64url(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
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
        const dispatch = await beginReplyDispatch(db, userId, await req.json(), "email");
        dispatchId = String(dispatch.dispatch_id);
        if (dispatch.existing)
            return json({ ok: false, dispatch_id: dispatchId, status: dispatch.status, existing: true });
        const payload = dispatch.payload!;
        const transport = payload.transport!;
        const { data: account, error } = await db.from("gmail_accounts")
            .select("id,user_id,email_address,status,refresh_token_secret_id,last_history_id,watch_expiration,backfill_done,has_send_scope")
            .eq("id", payload.fromAccountId).eq("user_id", userId).maybeSingle();
        if (error || !account || !account.has_send_scope || account.status !== "active" || account.email_address !== transport.from)
            throw new HttpError(409, "approved Gmail account changed");
        const accessToken = await accessTokenForAccount(db, account);
        const mime = buildMime({ from: transport.from, to: transport.to, subject: payload.subject, inReplyTo: transport.inReplyTo ?? null, references: transport.references ?? [], body: payload.text });
        providerStarted = true;
        const sent = await gmailPost(accessToken, "/users/me/messages/send", { raw: toBase64url(mime), threadId: transport.providerThreadId }) as {
            id?: string;
        };
        if (typeof sent.id !== "string" || !sent.id)
            throw new Error("provider response did not identify the sent message");
        sentId = sent.id;
        // Persist known send success before any fallible metadata/ingestion work.
        await finishReplyDispatch(db, userId, dispatchId, "SENT", sentId, true);
        let ingested = false;
        try {
            const fullMsg = await gmailJson(accessToken, `/users/me/messages/${encodeURIComponent(sentId)}?format=metadata&${metadataQuery()}`);
            if (fullMsg.id !== sentId || fullMsg.threadId !== transport.providerThreadId)
                throw new Error("sent metadata identity mismatch");
            const ingest = buildIngestPayload(fullMsg as unknown as Parameters<typeof buildIngestPayload>[0]);
            if (ingest) {
                const { error: ingestError } = await db.rpc("ingest_email_message", { p_gmail_account_id: account.id, p: ingest });
                ingested = !ingestError;
            }
        }
        catch { /* An ingestion failure cannot undo or retry a known external send. */ }
        const recorded = await finishReplyDispatch(db, userId, dispatchId, "SENT", sentId, !ingested);
        return json({ ok: true, status: "SENT", dispatch_id: dispatchId, message_id: sentId, audit_pending: !recorded, ingestion_pending: !ingested });
    }
    catch (e) {
        if (dispatchId && !sentId)
            await finishReplyDispatch(db, userId, dispatchId, providerStarted ? "UNKNOWN" : "FAILED");
        return json({ error: providerStarted ? "Delivery outcome is unknown. Do not resend; check the dispatch status." : (e as Error).message,
            ...(dispatchId ? { dispatch_id: dispatchId, status: sentId ? "SENT" : providerStarted ? "UNKNOWN" : "FAILED" } : {}) }, dispatchId ? 200 : e instanceof HttpError ? e.status : 502);
    }
}
