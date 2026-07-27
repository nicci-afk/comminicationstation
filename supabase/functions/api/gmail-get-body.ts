// Lazy message-body fetch: sync stores metadata + snippet only (keeps the hot
// path light); the full body is fetched on first open and cached on the row.

import {
  handleOptions,
  HttpError,
  json,
  requireUser,
  serviceClient,
} from "./_shared/util.ts";
import { accessTokenForAccount, gmailJson, GmailAccountRow } from "./_shared/gmail.ts";

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extractText(part: Part | undefined, prefer: string): string | null {
  if (!part) return null;
  if (part.mimeType === prefer && part.body?.data) return decodeB64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const found = extractText(p, prefer);
    if (found) return found;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);
    const { message_id } = await req.json();

    const { data: msg } = await db
      .from("messages")
      .select("id,user_id,gmail_account_id,provider_message_id,body_text,provider")
      .eq("id", message_id)
      .maybeSingle();
    if (!msg || msg.user_id !== userId) throw new HttpError(404, "message not found");
    if (msg.body_text) return json({ body: msg.body_text });
    if (msg.provider !== "gmail") return json({ body: "" });

    const { data: account } = await db
      .from("gmail_accounts")
      .select("*")
      .eq("id", msg.gmail_account_id)
      .single();
    const token = await accessTokenForAccount(db, account as GmailAccountRow);
    const full = await gmailJson(
      token,
      `/users/me/messages/${msg.provider_message_id}?format=full`,
    );
    const payload = full.payload as Part | undefined;
    let text = extractText(payload, "text/plain");
    if (!text) {
      const html = extractText(payload, "text/html");
      if (html) text = stripHtml(html);
    }
    text = (text ?? "").slice(0, 50_000);

    await db.from("messages").update({ body_text: text }).eq("id", msg.id);
    return json({ body: text });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
