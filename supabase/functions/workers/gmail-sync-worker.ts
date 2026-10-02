// Drains sync_jobs: incremental history sync (push/poll), initial backfill
// (recent → Backlog Bankruptcy phases), and watch renewal. Expired history
// stops with a visible recovery error; it must never fast-forward the cursor.
// Serialized per account via an optimistic lock.

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

type LockedAccount = GmailAccountRow & { sync_locked_at: string };

async function lockAccount(db: SupabaseClient, id: string): Promise<LockedAccount | null> {
  const { data, error } = await db
    .from("gmail_accounts")
    .update({ sync_locked_at: new Date().toISOString() })
    .eq("id", id)
    .or(`sync_locked_at.is.null,sync_locked_at.lt.${new Date(Date.now() - 180_000).toISOString()}`)
    .select()
    .maybeSingle();
  if (error) throw new Error(`lock gmail account: ${error.message}`);
  return (data as LockedAccount) ?? null;
}

// Fence writes by the exact lock acquired, not merely the account id. An old
// worker must not overwrite a newer checkpoint or release a replacement lock.
async function updateAccount(
  db: SupabaseClient,
  account: LockedAccount,
  patch: Record<string, unknown>,
  checkpoint = false,
) {
  let query = db.from("gmail_accounts").update(patch)
    .eq("id", account.id).eq("sync_locked_at", account.sync_locked_at);
  if (checkpoint) {
    query = account.last_history_id == null
      ? query.is("last_history_id", null)
      : query.eq("last_history_id", account.last_history_id);
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw new Error(`update gmail account: ${error.message}`);
  if (!data) throw new Error("Gmail sync lock/checkpoint changed; retry from durable state");
}

async function unlockAccount(
  db: SupabaseClient,
  account: LockedAccount,
  patch: Record<string, unknown> = {},
) {
  await updateAccount(db, account, { ...patch, sync_locked_at: null });
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
  const result = data as { status: string; needs_model_triage?: boolean; message_id?: string } | null;
  if (!result || !["ok", "duplicate"].includes(result.status)) {
    throw new Error("ingest: unexpected result; checkpoint unchanged");
  }
  if (result.status === "ok" && result.needs_model_triage && result.message_id) {
    await enqueue(db, "triage_jobs", { message_id: result.message_id });
  }
}

async function suppressForProviderMessage(
  db: SupabaseClient,
  account: GmailAccountRow,
  providerMessageId: string,
) {
  const { data: msg, error: readError } = await db
    .from("messages")
    .select("id,thread_id")
    .eq("gmail_account_id", account.id)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (readError) throw new Error(`find suppressed message: ${readError.message}`);
  if (!msg) return;
  const { error } = await db
    .from("queue_items")
    .update({ state: "suppressed" })
    .eq("thread_id", msg.thread_id)
    // An old event replay must not suppress a later inbound episode.
    .eq("last_inbound_message_id", msg.id)
    .in("state", ["new", "needs_attention", "fyi", "backlog", "snoozed"]);
  if (error) throw new Error(`suppress message: ${error.message}`);
}

async function renewWatch(db: SupabaseClient, account: LockedAccount, token: string) {
  const topic = (await getConfig(db, "pubsub_topic"))?.value as string | undefined;
  if (!topic) return; // not configured yet — polling carries the load
  const res = await gmailPost(token, "/users/me/watch", { topicName: topic });
  const patch: Record<string, unknown> = {
    watch_expiration: new Date(Number(res.expiration)).toISOString(),
  };
  if (!account.last_history_id && res.historyId) {
    patch.last_history_id = historyId(res.historyId);
  }
  await updateAccount(db, account, patch, patch.last_history_id !== undefined);
}

// Gmail history IDs are opaque decimal integers. Number() can silently round
// bigint cursors returned by Gmail; unsafe numeric database reads fail closed.
function historyId(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Unsafe numeric Gmail history ID; exact checkpoint recovery required");
  }
  const id = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new Error("Invalid Gmail history ID; checkpoint unchanged");
  }
  return id;
}

class HistoryRecoveryRequired extends Error {
  constructor() {
    super("Gmail history expired or missing: coverage is incomplete. Approved full reconciliation is required; checkpoint unchanged.");
  }
}

type HistoryOperation = { key: string; kind: "ingest" | "suppress"; messageId: string };
type HistoryCursor = {
  start_history_id: string;
  page_token?: string;
  page_digest?: string;
  next_operation?: number;
  token_restarts?: number;
};

// Stable operation keys make duplicate/reordered history deterministic. Only
// specific event fields are used: Gmail's generic `messages` repeats them.
function historyOperations(history: Record<string, unknown>, startId: string) {
  const records = (history.history ?? []) as Record<string, unknown>[];
  if (!Array.isArray(records)) throw new Error("Invalid Gmail history page");
  const operations = new Map<string, HistoryOperation>();
  for (const record of records) {
    const id = historyId(record.id);
    if (BigInt(id) <= BigInt(startId)) continue;
    const add = (kind: "ingest" | "suppress", messageId: string) => {
      if (typeof messageId !== "string" || !messageId) throw new Error("Invalid Gmail history message ID");
      const key = `${id.padStart(20, "0")}:${kind}:${messageId}`;
      operations.set(key, { key, kind, messageId });
    };
    for (const entry of (record.messagesAdded ?? []) as { message: GmailMessageLite }[]) {
      add("ingest", entry.message?.id);
    }
    for (const entry of (record.labelsAdded ?? []) as { message: GmailMessageLite; labelIds: string[] }[]) {
      if ((entry.labelIds ?? []).some(label => label === "SPAM" || label === "TRASH")) {
        add("suppress", entry.message?.id);
      }
    }
  }
  return [...operations.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

async function incrementalSync(
  db: SupabaseClient,
  account: LockedAccount,
  token: string,
  job: Record<string, unknown>,
) {
  if (!account.last_history_id) throw new Error("Gmail initial backfill has not established a history checkpoint; retry after initialization");
  const startId = historyId(account.last_history_id);
  const saved = job.history_cursor as HistoryCursor | undefined;
  // A completed intervening sync supersedes a stale continuation. Start fresh
  // from the DB checkpoint; never trust a job to move that checkpoint forward.
  const cursor = saved?.start_history_id === startId ? saved : undefined;
  const tokenRestarts = cursor?.token_restarts ?? 0;
  if (tokenRestarts !== 0 && tokenRestarts !== 1) throw new Error("Invalid Gmail token restart count");
  let pageToken = cursor?.page_token;
  if (pageToken !== undefined && (typeof pageToken !== "string" || !pageToken)) {
    throw new Error("Invalid Gmail history continuation token");
  }
  const start = Date.now();
  const seen = new Set<string>();
  let resume = cursor;

  for (;;) {
    let history: Record<string, unknown>;
    try {
      const params = new URLSearchParams({ startHistoryId: startId, maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      history = await gmailJson(token, `/users/me/history?${params}`);
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      // A rejected page token is only a pagination hint, never permission to
      // reset the durable history ID. One tokenless replay distinguishes it
      // from an expired start ID; a first-page 400 follows normal retry limits.
      if (pageToken && (status === 400 || status === 404)) {
        if (tokenRestarts >= 1) throw new Error("Gmail page token rejected again after baseline replay; checkpoint unchanged");
        await enqueue(db, "sync_jobs", {
          kind: "incremental", gmail_account_id: account.id,
          history_cursor: { start_history_id: startId, token_restarts: 1 },
        });
        return;
      }
      if (status === 404) throw new HistoryRecoveryRequired();
      throw e;
    }

    const operations = historyOperations(history, startId);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(JSON.stringify(operations)),
    )), byte => byte.toString(16).padStart(2, "0")).join("");
    // The cursor stays constant-size even for large histories. If the same
    // page's contents changed, replay it instead of skipping by a stale index.
    let index = resume?.page_digest === digest ? resume.next_operation ?? 0 : 0;
    if (!Number.isSafeInteger(index) || index < 0 || index > operations.length) {
      throw new Error("Invalid Gmail history continuation offset");
    }
    for (; index < operations.length; index++) {
      if (Date.now() - start >= PAGE_BUDGET_MS) {
        await enqueue(db, "sync_jobs", {
          kind: "incremental", gmail_account_id: account.id,
          history_cursor: { start_history_id: startId, page_token: pageToken, page_digest: digest, next_operation: index, token_restarts: tokenRestarts },
        });
        return;
      }
      const op = operations[index];
      if (op.kind === "ingest") {
        if (!seen.has(op.messageId)) {
          await ingestMessageById(db, account, token, op.messageId);
          seen.add(op.messageId); // only after all awaited writes succeed
        }
      } else {
        await suppressForProviderMessage(db, account, op.messageId);
      }
    }

    const nextToken = history.nextPageToken;
    if (nextToken !== undefined && (typeof nextToken !== "string" || !nextToken)) {
      throw new Error("Invalid Gmail next page token; checkpoint unchanged");
    }
    if (!nextToken) {
      // Gmail's response historyId is the MAILBOX head, not a completed-page
      // cursor. It is safe only after every page and write has completed.
      const newest = historyId(history.historyId);
      if (BigInt(newest) < BigInt(startId) || operations.some(op => BigInt(op.key.split(":")[0]) > BigInt(newest))) {
        throw new Error("Gmail history checkpoint regressed; checkpoint unchanged");
      }
      await updateAccount(db, account, {
        last_history_id: newest, last_sync_at: new Date().toISOString(), last_error: null,
      }, true);
      return;
    }
    if (nextToken === pageToken) throw new Error("Gmail repeated its page token; checkpoint unchanged");
    pageToken = nextToken;
    resume = undefined;
    if (Date.now() - start >= PAGE_BUDGET_MS) {
      await enqueue(db, "sync_jobs", {
        kind: "incremental", gmail_account_id: account.id,
        history_cursor: { start_history_id: startId, page_token: pageToken, token_restarts: tokenRestarts },
      });
      return;
    }
  }
}

async function backfill(
  db: SupabaseClient,
  account: LockedAccount,
  token: string,
  job: Record<string, unknown>,
) {
  const phase = (job.phase as string) ?? "recent";
  const pageToken = job.page_token as string | undefined;
  const imported = Number(job.imported ?? 0);

  if (phase === "recent" && !pageToken && !account.last_history_id) {
    // Baseline BEFORE listing so nothing falls between backfill and live sync.
    const profile = await gmailJson(token, "/users/me/profile");
    await updateAccount(db, account, { last_history_id: historyId(profile.historyId) }, true);
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
    await updateAccount(db, account, { backfill_done: true });
  }
}

async function deepBackfill(
  db: SupabaseClient,
  account: LockedAccount,
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
    await updateAccount(db, account, { last_sync_at: new Date().toISOString(), last_error: null });
  }
}

async function fullResync() {
  // The former one-page, seven-day replay silently missed older/more messages
  // before resetting to the current profile ID. Do not execute queued legacy
  // recovery jobs until a separately approved full reconciliation is available.
  throw new HistoryRecoveryRequired();
}

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  return await runWorker(req, "sync_jobs", 150, 110_000, async (db, job: Job) => {
    const msg = job.message;
    const accountId = msg.gmail_account_id as string;
    const account = await lockAccount(db, accountId);
    if (!account) throw new Error("Gmail account locked or unavailable; retry this job");
    let errorPatch: Record<string, unknown> = {};
    try {
      if (account.status !== "active") return;
      const token = await accessTokenForAccount(db, account);
      const kind = msg.kind as string;
      if (kind === "incremental") await incrementalSync(db, account, token, msg);
      else if (kind === "backfill") await backfill(db, account, token, msg);
      else if (kind === "deep_backfill") await deepBackfill(db, account, token, msg);
      else if (kind === "renew_watch") await renewWatch(db, account, token);
      else if (kind === "full_resync") await fullResync();
    } catch (e) {
      const message = (e as Error).message;
      const stopped = /invalid_grant/i.test(message) || e instanceof HistoryRecoveryRequired;
      errorPatch = {
        last_error: message.slice(0, 500),
        ...(stopped ? { status: "error" } : {}),
      };
      if (!stopped) throw e; // redeliver via visibility timeout
    } finally {
      await unlockAccount(db, account, errorPatch);
    }
  });
}
