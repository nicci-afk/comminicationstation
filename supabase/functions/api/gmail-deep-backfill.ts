// POST {} — Enqueues a 6-month deep backfill for every active Gmail account.
// One-time catch-up on mail older than the initial 30-day window.
// All messages land in backlog state (rules-only triage, zero AI cost).
// Deduplication in ingest_email_message means already-imported messages are skipped.

import { enqueue, handleOptions, HttpError, json, requireUser, serviceClient } from "./_shared/util.ts";

export default async function handler(req: Request): Promise<Response> {
  const opt = handleOptions(req);
  if (opt) return opt;
  const db = serviceClient();
  try {
    const { userId } = await requireUser(req, db);

    const { data: accounts, error } = await db
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw new Error(error.message);
    if (!accounts?.length) throw new HttpError(400, "No active Gmail accounts found");

    for (const account of accounts) {
      await enqueue(db, "sync_jobs", {
        kind: "deep_backfill",
        gmail_account_id: account.id,
        imported: 0,
      });
    }

    return json({
      ok: true,
      accounts_queued: accounts.length,
      emails: (accounts as { id: string; email_address: string }[]).map((a) => a.email_address),
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message }, status);
  }
}
