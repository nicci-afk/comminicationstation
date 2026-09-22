// Drains sync_jobs: incremental history sync (push/poll), initial backfill
// (recent → Backlog Bankruptcy phases), watch renewal, and full resync after
// a historyId expires. Serialized per account via an optimistic lock.

import { SupabaseClient } from "@supabase/supabase-js";
import { enqueue, getConfig, handleOptions, Job, runWorker } from "./_shared/util.ts";
import {
  accessTokenForAccount,
  buildIngestPayload,
  gmailJson,
  gmailPost,
  GmailAccountRow,
  GmailMessageLite,
  metadataQuery,
} from "./_shared/gmail.ts";

const PAGE_BUDGET_MS = 90_000;
const BACKLOG_CAP = 1500;

async function lockAccount(db: SupabaseClient, id: string): Promise<GmailAccountRow | null> {
  const { data } = await db
    .from("gmail_accounts")
    .update({ sync_locked_at: new Date().toISOString() })
    .eq("id", id)
    .or(`sync_locked_at.is.null,sync_locked_at.lt.${new Date(Date.now() - 180_000).toISOString()}`)
    .select()
    .maybeSingle();
  return (data as GmailAccountRow) ?? null;
}

async function unlockAccount(db: SupabaseClient, id: string, patch: Record<string, unknown> = {}) {
  await db.from("gmail_accounts").update({ sync_locked_at: null, ...patch }).eq("id", id);
}

async function ingestMessageById(
  db: SupabaseClient,
  account: GmailAccountRow,
  token: string,
  messageId: string,
  backlog = false,
): Promise<void> {
  let msg: GmailMessageLite;
  try {
    msg = (await gmailJson(
      token,
      `/users/me/messages/${messageId}?format=metadata&${metadataQuery()}`,
    )) as unknown as GmailMessageLite;
  } catch (e) {
    if ((e as Error & { status?: number }).status === 404) return; // deleted since
    throw e;
  }
  const payload = buildIngestPayload(msg, { backlog });
  if (!payload) return; // draft
  const { data, error } = await db.rpc("ingest_email_message", {
    p_gmail_account_id: account.id,
    p: payload,
  });
  if (error) throw new Error(`ingest: ${error.message}`);
  const result = data as { status: string; needs_model_triage?: boolean; message_id?: string };
  if (result.status === "ok" && result.needs_model_triage && result.message_id) {
    await enqueue(db, "triage_jobs", { message_id: result.message_id });
  }
}

async function suppressForProviderMessage(
  db: SupabaseClient,
  account: GmailAccountRow,
  providerMessageId: string,
) {
  const { data: msg } = await db
    .from("messages")
    .select("thread_id")
    .eq("gmail_account_id", account.id)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (!msg) return;
  await db
    .from("queue_items")
    .update({ state: "suppressed" })
    .eq("thread_id", msg.thread_id)
    .in("state", ["new", "needs_attention", "fyi", "backlog", "snoozed"]);
}

async function renewWatch(db: SupabaseClient, account: GmailAccountRow, token: string) {
  const topic = (await getConfig(db, "pubsub_topic"))?.value as string | undefined;
  if (!topic) return; // not configured yet — polling carries the load
  const res = await gmailPost(token, "/users/me/watch", { topicName: topic });
  const patch: Record<string, unknown> = {
    watch_expiration: new Date(Number(res.expiration)).toISOString(),
  };
  if (!account.last_history_id && res.historyId) {
    patch.last_history_id = Number(res.historyId);
  }
  await db.from("gmail_accounts").update(patch).eq("id", account.id);
}

async function incrementalSync(db: SupabaseClient, account: GmailAccountRow, token: string) {
  if (!account.last_history_id) {
    // No baseline yet: establish one from the profile, then rely on backfill.
    const profile = await gmailJson(token, "/users/me/profile");
    await db
      .from("gmail_accounts")
      .update({ last_history_id: Number(profile.historyId) })
      .eq("id", account.id);
    return;
  }

  const start = Date.now();
  let pageToken: string | undefined;
  let newest = account.last_history_id;
  const seen = new Set<string>();

  do {
    let history: Record<string, unknown>;
    try {
      const params = new URLSearchParams({
        startHistoryId: String(account.last_history_id),
        maxResults: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);
      history = await gmailJson(token, `/users/me/history?${params}`);
    } catch (e) {
      if ((e as Error & { status?: number }).status === 404) {
        // historyId expired (outage longer than Gmail's retention) — recover.
        await enqueue(db, "sync_jobs", { kind: "full_resync", gmail_account_id: account.id });
        return;
      }
      throw e;
    }

    const records = (history.history as Record<string, unknown>[]) ?? [];
    for (const rec of records) {
      const recId = Number(rec.id ?? 0);
      if (recId > newest) newest = recId;
      for (const added of (rec.messagesAdded as { message: GmailMessageLite }[]) ?? []) {
        const m = added.message;
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        if ((m.labelIds ?? []).includes("DRAFT")) continue;
        await ingestMessageById(db, account, token, m.id);
      }
      for (const la of (rec.labelsAdded as { message: GmailMessageLite; labelIds: string[] }[]) ?? []) {
        const labels = la.labelIds ?? [];
        if (labels.includes("SPAM") || labels.includes("TRASH")) {
          await suppressForProviderMessage(db, account, la.message.id);
        }
      }
    }
    if (Number(history.historyId ?? 0) > newest) newest = Number(history.historyId);
    pageToken = history.nextPageToken as string | undefined;
  } while (pageToken && Date.now() - start < PAGE_BUDGET_MS);

  await db
    .from("gmail_accounts")
    .update({ last_history_id: newest, last_sync_at: new Date().toISOString(), last_error: null })
    .eq("id", account.id);

  if (pageToken) {
    // Ran out of budget mid-stream; continue in a fresh job.
    await enqueue(db, "sync_jobs", { kind: "incremental", gmail_account_id: account.id });
  }
}

async function backfill(
  db: SupabaseClient,
  account: GmailAccountRow,
  token: string,
  job: Record<string, unknown>,
) {
  const phase = (job.phase as string) ?? "recent";
  const pageToken = job.page_token as string | undefined;
  const imported = Number(job.imported ?? 0);

  if (phase === "recent" && !pageToken && !account.last_history_id) {
    // Baseline BEFORE listing so nothing falls between backfill and live sync.
    const profile = await gmailJson(token, "/users/me/profile");
    await db
      .from("gmail_accounts")
      .update({ last_history_id: Number(profile.historyId) })
      .eq("id", account.id);
  }

  const q = phase === "recent"
    ? "newer_than:30d -in:chat -in:draft -in:spam -in:trash"
    : "in:inbox is:unread older_than:30d";

  const params = new URLSearchParams({ q, maxResults: "40" });
  if (pageToken) params.set("pageToken", pageToken);
  const list = await gmailJson(token, `/users/me/messages?${params}`);
  const ids = ((list.messages as { id: string }[]) ?? []).map((m) => m.id);

  for (const id of ids) {
    await ingestMessageById(db, account, token, id, phase === "backlog");
  }

  const nextToken = list.nextPageToken as string | undefined;
  const total = imported + ids.length;
  const capped = phase === "backlog" && total >= BACKLOG_CAP;

  if (nextToken && !capped) {
    await enqueue(db, "sync_jobs", {
      kind: "backfill",
      gmail_account_id: account.id,
      phase,
      page_token: nextToken,
      imported: total,
    });
  } else if (phase === "recent") {
    await enqueue(db, "sync_jobs", {
      kind: "backfill",
      gmail_account_id: account.id,
      phase: "backlog",
      imported: 0,
    });
  } else {
    await db.from("gmail_accounts").update({ backfill_done: true }).eq("id", account.id);
  }
}

async function deepBackfill(
  db: SupabaseClient,
  account: GmailAccountRow,
  token: string,
  job: Record<string, unknown>,
) {
  const pageToken = job.page_token as string | undefined;
  const imported = Number(job.imported ?? 0);

  const params = new URLSearchParams({
    q: "newer_than:180d -in:chat -in:draft -in:spam -in:trash",
    maxResults: "40",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const list = await gmailJson(token, `/users/me/messages?${params}`);
  const ids = ((list.messages as { id: string }[]) ?? []).map((m) => m.id);

  for (const id of ids) {
    await ingestMessageById(db, account, token, id, true);
  }

  const nextToken = list.nextPageToken as string | undefined;
  const total = imported + ids.length;

  if (nextToken) {
    await enqueue(db, "sync_jobs", {
      kind: "deep_backfill",
      gmail_account_id: account.id,
      page_token: nextToken,
      imported: total,
    });
  } else {
    await db.from("gmail_accounts")
      .update({ last_sync_at: new Date().toISOString(), last_error: null })
      .eq("id", account.id);
  }
}

async function fullResync(db: SupabaseClient, account: GmailAccountRow, token: string) {
  // Catch up on the window we may have missed, then reset the baseline.
  const params = new URLSearchParams({ q: "newer_than:7d -in:chat -in:draft", maxResults: "100" });
  const list = await gmailJson(token, `/users/me/messages?${params}`);
  for (const m of ((list.messages as { id: string }[]) ?? [])) {
    await ingestMessageById(db, account, token, m.id);
  }
  const profile = await gmailJson(token, "/users/me/profile");
  await db
    .from("gmail_accounts")
    .update({
      last_history_id: Number(profile.historyId),
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", account.id);
  await renewWatch(db, account, token);
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "sync_jobs", 150, 110_000, async (db, job: Job) => {
    const msg = job.message;
    const accountId = msg.gmail_account_id as string;
    const account = await lockAccount(db, accountId);
    if (!account) return; // locked by a concurrent run; poll sweep will retry
    try {
      if (account.status !== "active") return;
      const token = await accessTokenForAccount(db, account);
      const kind = msg.kind as string;
      if (kind === "incremental") await incrementalSync(db, account, token);
      else if (kind === "backfill") await backfill(db, account, token, msg);
      else if (kind === "deep_backfill") await deepBackfill(db, account, token, msg);
      else if (kind === "renew_watch") await renewWatch(db, account, token);
      else if (kind === "full_resync") await fullResync(db, account, token);
      await unlockAccount(db, accountId);
    } catch (e) {
      const message = (e as Error).message;
      const revoked = /invalid_grant/i.test(message);
      await unlockAccount(db, accountId, {
        last_error: message.slice(0, 500),
        ...(revoked ? { status: "error" } : {}),
      });
      if (!revoked) throw e; // redeliver via visibility timeout
    }
  });
}
