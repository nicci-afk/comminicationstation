// Gmail API + Google OAuth helpers, header parsing, and deterministic
// bulk-mail detection (Tier 0 — runs before any model ever sees a message).

import { SupabaseClient } from "@supabase/supabase-js";
import { getConfig, getUserSecret, readVaultSecret } from "./util.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1";

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export async function googleClientConfig(db: SupabaseClient): Promise<GoogleClientConfig> {
  const idCfg = await getConfig(db, "google_client_id");
  const secretCfg = await getConfig(db, "google_client_secret_vault_id");
  const clientId = idCfg?.value as string | undefined;
  const secretId = secretCfg?.id as string | undefined;
  if (!clientId || !secretId) {
    throw new Error("Google OAuth client not configured (Settings → Connections)");
  }
  const clientSecret = await readVaultSecret(db, secretId);
  if (!clientSecret) throw new Error("Google client secret missing from vault");
  return { clientId, clientSecret };
}

export async function exchangeCode(
  cfg: GoogleClientConfig,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  return await res.json();
}

export async function refreshAccessToken(
  cfg: GoogleClientConfig,
  refreshToken: string,
): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token as string;
}

export interface GmailAccountRow {
  id: string;
  user_id: string;
  email_address: string;
  status: string;
  refresh_token_secret_id: string | null;
  last_history_id: number | null;
  watch_expiration: string | null;
  backfill_done: boolean;
}

export async function accessTokenForAccount(
  db: SupabaseClient,
  account: GmailAccountRow,
): Promise<string> {
  if (!account.refresh_token_secret_id) {
    throw new Error(`gmail account ${account.email_address} has no stored refresh token`);
  }
  const refreshToken = await readVaultSecret(db, account.refresh_token_secret_id);
  if (!refreshToken) throw new Error("refresh token missing from vault");
  const cfg = await googleClientConfig(db);
  return await refreshAccessToken(cfg, refreshToken);
}

async function gmailGet(token: string, path: string): Promise<Response> {
  return await fetch(`${GMAIL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function gmailJson(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await gmailGet(token, path);
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`gmail ${path} → ${res.status}: ${body.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return await res.json();
}

export async function gmailPost(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GMAIL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`gmail POST ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json();
}

// ------------------------------------------------------------- parsing

export interface ParsedAddress {
  name: string;
  email: string;
}

export function parseAddressList(value: string | undefined): ParsedAddress[] {
  if (!value) return [];
  // Split on commas not inside quotes or angle brackets.
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === "<") depth++;
    if (ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !inQuote && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => {
      const m = p.match(/^\s*(?:"?([^"]*)"?\s*)?<([^>]+)>\s*$/);
      if (m) return { name: (m[1] ?? "").trim(), email: m[2].trim().toLowerCase() };
      const bare = p.trim().replace(/^<|>$/g, "");
      return { name: "", email: bare.toLowerCase() };
    })
    .filter((a) => a.email.includes("@"));
}

interface GmailHeader {
  name: string;
  value: string;
}

export function headerMap(headers: GmailHeader[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(/<[^>]+>/g) ?? []).map((s) => s.trim());
}

const NOREPLY_RE =
  /(^|[.\-_])(no-?reply|do-?not-?reply|notifications?|notify|updates?|newsletter|marketing|mailer|billing|receipts?|alerts?|support|info|hello|news|digest)([.\-_@]|$)/i;

const RECEIPT_SUBJECT_RE =
  /\b(receipt|invoice|order (confirmation|#)|payment (received|confirmation)|statement|your (order|booking|reservation))\b/i;

export interface BulkSignals {
  is_bulk: boolean;
  reasons: string[];
  suggested_category: string;
}

// Deterministic bulk/automated detection from headers — Tier 0, zero AI.
export function detectBulk(h: Record<string, string>, fromEmail: string, subject: string): BulkSignals {
  const reasons: string[] = [];
  if (h["list-unsubscribe"]) reasons.push("List-Unsubscribe header");
  if (h["list-id"]) reasons.push("List-Id header");
  if ((h["precedence"] ?? "").match(/bulk|list|junk/i)) reasons.push("Precedence bulk/list");
  if ((h["auto-submitted"] ?? "").length > 0 && h["auto-submitted"] !== "no") {
    reasons.push("Auto-Submitted");
  }
  if (h["x-mailchimp-id"] || h["x-campaign-id"] || h["x-sg-eid"] || h["x-mailgun-tag"]) {
    reasons.push("bulk-mailer fingerprint");
  }
  if (NOREPLY_RE.test(fromEmail.split("@")[0] ?? "")) reasons.push("automated sender address");

  let suggested = "newsletter";
  if (RECEIPT_SUBJECT_RE.test(subject)) suggested = "receipt";
  else if (h["list-unsubscribe"] && !h["list-id"]) suggested = "promotion";
  else if ((h["auto-submitted"] ?? "") !== "" && h["auto-submitted"] !== "no") suggested = "notification";
  else if (NOREPLY_RE.test(fromEmail.split("@")[0] ?? "") && !h["list-unsubscribe"]) {
    suggested = "notification";
  }

  return { is_bulk: reasons.length > 0, reasons, suggested_category: suggested };
}

export const METADATA_HEADERS = [
  "From", "To", "Cc", "Subject", "Message-ID", "In-Reply-To", "References",
  "Date", "Reply-To", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted",
  "X-Mailchimp-Id", "X-Campaign-Id", "X-SG-EID", "X-Mailgun-Tag",
];

export function metadataQuery(): string {
  return METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");
}

export interface GmailMessageLite {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

// Build the payload consumed by public.ingest_email_message().
export function buildIngestPayload(
  msg: GmailMessageLite,
  opts: { backlog?: boolean } = {},
): Record<string, unknown> | null {
  const labels = msg.labelIds ?? [];
  if (labels.includes("DRAFT")) return null;
  const h = headerMap(msg.payload?.headers ?? []);
  const from = parseAddressList(h["from"])[0] ?? { name: "", email: "" };
  const to = parseAddressList(h["to"]);
  const cc = parseAddressList(h["cc"]);
  const subject = h["subject"] ?? "";
  const direction = labels.includes("SENT") ? "outbound" : "inbound";
  const sentAtMs = Number(msg.internalDate ?? Date.now());
  return {
    provider_message_id: msg.id,
    thread_provider_id: msg.threadId,
    rfc822_message_id: h["message-id"] ?? null,
    in_reply_to: (h["in-reply-to"]?.match(/<[^>]+>/) ?? [null])[0],
    references_ids: parseReferences(h["references"]),
    direction,
    from_name: from.name,
    from_identifier: from.email,
    to_identifiers: to.map((a) => a.email),
    cc_identifiers: cc.map((a) => a.email),
    subject,
    snippet: msg.snippet ?? "",
    sent_at: new Date(sentAtMs).toISOString(),
    labels,
    is_unread: labels.includes("UNREAD"),
    headers: (
      [
        ["message-id", h["message-id"]],
        ["list-id", h["list-id"]],
        ["list-unsubscribe", h["list-unsubscribe"]],
        ["precedence", h["precedence"]],
        ["auto-submitted", h["auto-submitted"]],
        ["reply-to", h["reply-to"]],
      ] as [string, string | undefined][]
    ).filter((e): e is [string, string] => !!e[1]).map(([name, value]) => ({ name, value })),
    bulk: detectBulk(h, from.email, subject),
    backlog: opts.backlog ?? false,
  };
}
