// Send a reply email via the Gmail API on behalf of the authenticated user.
// Uses the gmail_account linked to the thread, requires has_send_scope=true.
// The sent message is ingested via ingest_email_message so that outbound
// responded-detection runs exactly as it does for replies sent from Gmail
// directly — the same audit trail, the same evidence record.
//
// Auth: user JWT (verify_jwt=true on the parent router)

import {
  accessTokenForAccount,
  buildIngestPayload,
  gmailJson,
  gmailPost,
  metadataQuery,
} from "./_shared/gmail.ts";
import {
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";

function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  body: string;
}): string {
  // Normalise Re: prefix — no double "Re: Re:"
  const subject = opts.subject
    ? `Re: ${opts.subject.replace(/^(Re:\s*)+/i, "")}`
    : "Re: (no subject)";
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
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { queue_item_id, body } = await req.json();
    if (!queue_item_id || !body?.trim()) {
      throw new HttpError(400, "queue_item_id and body are required");
    }

    // Fetch the queue item (user-scoped)
    const { data: item, error: itemErr } = await db
      .from("queue_items")
      .select("id, thread_id, sender_identifier, title, channel")
      .eq("id", queue_item_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!item) throw new HttpError(404, "queue item not found");
    if (item.channel !== "email") {
      throw new HttpError(400, "only email items can be replied to via Gmail");
    }

    // Get the thread to find which Gmail account received the original message
    const { data: thread, error: threadErr } = await db
      .from("threads")
      .select("id, gmail_account_id, provider_thread_id")
      .eq("id", item.thread_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (threadErr) throw new Error(threadErr.message);
    if (!thread?.gmail_account_id) {
      throw new HttpError(400, "no Gmail account linked to this thread");
    }

    // Fetch the Gmail account and check that send scope was granted
    const { data: account, error: acctErr } = await db
      .from("gmail_accounts")
      .select("id, user_id, email_address, status, refresh_token_secret_id, last_history_id, watch_expiration, backfill_done, has_send_scope")
      .eq("id", thread.gmail_account_id)
      .maybeSingle();
    if (acctErr) throw new Error(acctErr.message);
    if (!account) throw new HttpError(404, "Gmail account not found");
    if (!account.has_send_scope) {
      throw new HttpError(
        403,
        "This Gmail account was connected before send support was added. " +
          "Go to Settings → Connections and click Reconnect Gmail to grant send access.",
      );
    }

    // Get the most recent inbound message for threading headers
    const { data: lastInbound } = await db
      .from("messages")
      .select("rfc822_message_id, references_ids, subject, from_identifier")
      .eq("thread_id", item.thread_id)
      .eq("direction", "inbound")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const inReplyTo = lastInbound?.rfc822_message_id ?? null;
    const references = (lastInbound?.references_ids as string[]) ?? [];
    const subjectBase = (lastInbound?.subject || item.title || "") as string;
    const to = item.sender_identifier as string;

    // Build the MIME email and send it
    const accessToken = await accessTokenForAccount(db, account);
    const mime = buildMime({
      from: account.email_address,
      to,
      subject: subjectBase,
      inReplyTo,
      references,
      body: body.trim(),
    });

    const sentMsg = (await gmailPost(accessToken, "/users/me/messages/send", {
      raw: toBase64url(mime),
      threadId: thread.provider_thread_id,
    })) as { id: string; threadId: string };

    // Fetch the sent message with metadata headers so we can ingest it properly
    const fullMsg = await gmailJson(
      accessToken,
      `/users/me/messages/${sentMsg.id}?format=metadata&${metadataQuery()}`,
    );

    // Ingest via the standard RPC — this runs outbound responded-detection and
    // writes the queue_item_events audit record with evidence, exactly as a
    // reply sent from Gmail directly would.
    const payload = buildIngestPayload(fullMsg as Parameters<typeof buildIngestPayload>[0]);
    if (payload) {
      const { error: ingestErr } = await db.rpc("ingest_email_message", {
        p_gmail_account_id: account.id,
        p: payload,
      });
      if (ingestErr) {
        // Non-fatal: message was sent; log the ingest failure but don't fail
        // the response (client already has a sent confirmation).
        console.error("ingest after send failed:", ingestErr.message);
      }
    }

    return json({ ok: true, message_id: sentMsg.id });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
